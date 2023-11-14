---
external: false
draft: false
title: How The WebSocket Server Works
description: describing how the WebSocket server works and hints on parsing its frames
date: 2023-11-14
---

This post is largely inspired by my project [zig-ws](https://github.com/thegeeko/zig-ws), it's an interesting 
protocol and relatively easy to implement so let's see how it works on the server side.

### What Is The WebSocket Protocol
it's a protocol to provide a real-time 2-way connection over a persistent TCP connection it does that by using 
HTTP handshake and then using the TCP connection used for the handshake to send frames.

**Frames** are packages of data with some header that is needed for the protocol to operate.

### The Handshake

A normal GET request from a client with some requirements specified in [the](https://datatracker.ietf.org/doc/html/rfc6455#section-4.1) spec](https://datatracker.ietf.org/doc/html/rfc6455#section-4.1) I won't get into them because it's more client-related but you can always read the spec and you should.
and the server parses that header, performs some operations and returns a response based on some info on the request.

One of the requirements for the handshake request is to set the `Sec-WebSocket-Key` header with the base64 encoding 
of a random 16-byte value.

> The request MUST include a header field with the name
  `Sec-WebSocket-Key`, the value of this header field MUST be a
  nonce consisting of a randomly selected 16-byte value that has
  been base64-encoded.  The nonce
  MUST be selected randomly for each connection.

The server concat the header value with the magic string `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` and then SHA1 the result 
and then base64 encode the hashed value and sets the `Sec-WebSocket-Accept` header on the response with the encoded 
value there's more to the handshake but it's simple and you can always read [the spec](https://datatracker.ietf.org/doc/html/rfc6455#section-4.2).
After that, we can read directly from the TCP socket used for the handshake.

**Hint:** _{% mark %}  the spec is your best friend when implementing any kind of protocol. {% /mark %}_

### WebSocket Framing
The TCP protocol itself doesn't have the concept of framing(messages) meaning when you write N bytes to the network 
stream the other side might read it in N read calls on the network stream, you don't know if it's the end or not nor if 
it's one message or not or whatever the frame header tries to provide the needed info to read messages from a network 
stream.

#### Here How It Works

```
     0                   1                   2                   3
     0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
    +-+-+-+-+-------+-+-------------+-------------------------------+
    |F|R|R|R| opcode|M| Payload len |    Extended payload length    |
    |I|S|S|S|  (4)  |A|     (7)     |             (16/64)           |
    |N|V|V|V|       |S|             |   (if payload len==126/127)   |
    | |1|2|3|       |K|             |                               |
    +-+-+-+-+-------+-+-------------+ - - - - - - - - - - - - - - - +
    |     Extended payload length continued, if payload len == 127  |
    + - - - - - - - - - - - - - - - +-------------------------------+
    |                               |Masking-key, if MASK set to 1  |
    +-------------------------------+-------------------------------+
    | Masking-key (continued)       |          Payload Data         |
    +-------------------------------- - - - - - - - - - - - - - - - +
    :                     Payload Data continued ...                :
    + - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - +
    |                     Payload Data continued ...                |
    +---------------------------------------------------------------+
```

{% sub %} This diagram is taken from [the spec](https://datatracker.ietf.org/doc/html/rfc6455) which describes how the framing works. {% /sub %}

The server starts by reading 2 bytes(which is the minimum WebSocket frame size) the data on the 2 bytes(as shown on
the diagram) is:

- First Byte
  - bit 0 is the `FIN bit` used to represent if it's the final message fragment or not(will return to this later).
  - bit 1 to 3 are reserved for future use.
  - bit 4 to 7(last 4 bits) are the opcode of this message.

opcodes:
```
     |Opcode  | Meaning                             | Reference |
    -+--------+-------------------------------------+-----------|
     | 0      | Continuation Frame                  | RFC 6455  |
    -+--------+-------------------------------------+-----------|
     | 1      | Text Frame                          | RFC 6455  |
    -+--------+-------------------------------------+-----------|
     | 2      | Binary Frame                        | RFC 6455  |
    -+--------+-------------------------------------+-----------|
     | 8      | Connection Close Frame              | RFC 6455  |
    -+--------+-------------------------------------+-----------|
     | 9      | Ping Frame                          | RFC 6455  |
    -+--------+-------------------------------------+-----------|
     | 10     | Pong Frame                          | RFC 6455  |
    -+--------+-------------------------------------+-----------|
```

- Second Byte
  - bit 0 is the `Mask bit` used to indicate if the data(message payload) is masked(will return to this later).
  - bit 1 to 7 used for the message size(u8 value) with the values `126`, `127` being special values.

#### Message length

The last 7 bits of 2 bytes header contain the size if it's >= 125 if it's bigger than that and fits on 2 bytes(u16) the length value is set to 126
if it's longer than that and fits on 8 bytes(u64) the size value must be set to 127.

To summarize this the server reads 2 bytes and then looks at the last 7 bits if the value >= 125 then that's the length if it's 126 it reads the next 2
bytes after the header and that's the length of the header other than that it reads the next 8 bytes and that's the length.


**Hint:** _{% mark %}  the bytes are in the network byte order (big endian) you need to flip them if you're on little endian machine(you probably are).{% /mark %}_

**Hint:** _{% mark %} if the data is masked you need to read the masking key first (4 bytes).{% /mark %}_

#### Masking

The spec requires all the clients to mask the data(message payload) to see how you can consult [the spec](https://datatracker.ietf.org/doc/html/rfc6455#section-5.3), the server knows that it will always get masked data but you should support the unmasked data too just in case.

To unmask the data you need to first read the masking key if the mask bit on the header is set(have the value of 1) which is 4 bytes each byte 
represents a number(u8) and then follow This algorithm:

```cpp
// the masking key 4 u8 values
let i = 0;
for(byte : data) {
  byte = byte ^ mask_key[i % 4]; 
  i++;
}
```

**Hint:** _{% mark %} the mask key(4 bytes) comes before the extended length value.{% /mark %}_

#### Fragmentation

This feature allows the client to send a message in fragments which can be useful in the case that the message size is unknown at the send time, for 
example the client's message size depends on something outside of its control, so it can send the message in fragments of 8 bytes each meaning every 
time the client has 8 bytes it sends a fragment until it's done.

The way fragmentation works is first fragment the client must unset the `FIN bit` and set the opcode to the opcode of the whole message when it's 
assembled the next fragment client sends the same but it sets the opcode to 0(continuation), until it's done the last message it sends the `FIN bit` must be set(has the value of 1) and the opcode is 0.

**Hint:** _{% mark %} control frames can be received in the middle of a fragmented message._{% /mark %}_

### Control Frames

Control frames have special purposes, for example, the `Ping`` and `Pong` frames are used to see if the other side is alive(redundant imho).

The one we care the most about is the close frame which has the opcode 8 which indicates the end the end of the connection. It can have a 
payload(reason to close) or nothing if it has a body the first 2 bytes are used to represent a status code(u16) and the rest is just a message.

status codes:
```
     |Status Code | Meaning         | Contact       | Reference |
    -+------------+-----------------+---------------+-----------|
     | 1000       | Normal Closure  | hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1001       | Going Away      | hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1002       | Protocol error  | hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1003       | Unsupported Data| hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1004       | ---Reserved---- | hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1005       | No Status Rcvd  | hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1006       | Abnormal Closure| hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1007       | Invalid frame   | hybi@ietf.org | RFC 6455  |
     |            | payload data    |               |           |
    -+------------+-----------------+---------------+-----------|
     | 1008       | Policy Violation| hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1009       | Message Too Big | hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1010       | Mandatory Ext.  | hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
     | 1011       | Internal Server | hybi@ietf.org | RFC 6455  |
     |            | Error           |               |           |
    -+------------+-----------------+---------------+-----------|
     | 1015       | TLS handshake   | hybi@ietf.org | RFC 6455  |
    -+------------+-----------------+---------------+-----------|
```

### Conclusion

The WebSocket protocol is a nice protocol to implement with the spec being very clear and easy to follow. This blog post is a simple overview of 
what the server in WebSocket connection does if you want to implement it yourself you should read 
[the spec](https://datatracker.ietf.org/doc/html/rfc6455), and you can always check my Zig implementation [here](https://github.com/thegeeko/zig-ws).
