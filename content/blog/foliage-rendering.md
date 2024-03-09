---
external: false
draft: false
title: Vulkan Foliage rendering using GPU Instancing
description: Efficient foliage rendering using GPU instancing and making use of modern Vulkan features.
date: 2024-02-24
---

I was watching [acerola's video](https://www.youtube.com/watch?v=jw00MbIJcrk) on foliage rendering
and I liked the idea of rendering millions of grass blades, it was a good opportunity to play around
with GPU instancing and indirect draw.

### What I'll Be Using
The features and extensions set used in this abroach are:

- `VK_EXT_buffer_device_address`
  This extension allows for using pointers in GLSL
  and passing them in push constants or buffers, this extension along with `VK_EXT_descriptor_indexing`
  makes dealing with buffers and textures soo much easier and nicer IMHO.

- `multiDrawIndirect`
  This feature allows for multiple draw calls in indirect buffer
  make use of them to draw multiple LODs of the grass.

## How It Works
Basically, there's a compute pass that generates info about the grass blades stores them in a buffer, and does frustum culling 
and LOD selection and fill indirect commands, then a graphics pass to draw the blades.

### Compute Pass
our grass blade is defined by the following
```glsl
struct GrassBlade {
	// holds position(displacement from the center) of the blade
	// and a value determining how much it will bend
	vec4 pos_bend;
	// holds width and height multiplier
	// and pitch angle
	// and a term used for animation
	vec4 size_anim_pitch;
};
```

we want to generate all of this data we start by 

#### Position(displacement from the center)
It starts by generating random positions inside a rectangle area defined by center, width and height using
the following formula

```glsl
// Hash Functions for GPU Rendering, Jarzynski et al.
// http://www.jcgt.org/published/0009/03/02/
vec3 rand(uvec3 v) {
	v = v * 1664525u + 1013904223u;
	v.x += v.y * v.z;
	v.y += v.z * v.x;
	v.z += v.x * v.y;
	v ^= v >> 16u;
	v.x += v.y * v.z;
	v.y += v.z * v.x;
	v.z += v.x * v.y;
	return vec3(v) * (1.0 / float(0xffffffffu));
}

uvec2 i = gl_GlobalInvocationID.xy;
vec3 pos = pc.aria_center.xyz;

vec3 rand_val = rand(uvec3(i, 378294));
pos.x += (pc.aria.x / 2) - rand_val.x * pc.aria.x;
pos.z += (pc.aria.y / 2) - rand_val.y * pc.aria.y;
```

#### Height & Width
then it generates a uv coords for each grass blade to sample a texture by doing
```glsl
vec2 bottom_left_corner = pc.aria_center.xz - (pc.aria.xy / 2.0);
vec2 upper_right_corner = pc.aria_center.xz + (pc.aria.xy / 2.0);
vec2 uv = pos.xz / (upper_right_corner - bottom_left_corner);
```

after that using the uv coords, we can sample a simplex noise texture to have 
height multiplier or width multiplier we can also add some terms for user control
using simplex noise for height makes sense as the tall grass tends to stick together
in real life.

![simplex noise for hight](/images/folliage-simplex.png)

#### Bend Term
This is a term to define how bendable a grass blade is which will be used later as a multiplier in vertex shader
to do the animation.

#### Animation term
This is a term used by the animation formula to animate the grass it's the same for all of the vertices so 
calculating it here saves us time and allows us to not pass uvs to vertex shader which is 2 floats but for millions of blads
it will be 100s of megabytes. It's calculated by the following

```glsl
float wind(vec2 uv, float time, float base_freq, 
           float freq_scale, float strength) {
	float noise_factor = length(pcg2d(uvec2(uv * 104234.f)));
	
	// Time-varying frequency for windblown effect
	float freq = base_freq + sin(time) * freq_scale;
	
	vec2 uv_displaced = uv + strength;
	vec2 uv_scaled = uv_displaced * freq;
	
	float sin_term = uv_scaled.x + uv_scaled.y + noise_factor;
	return sin_term;
}
```
In the vertex shader this value will be used as a parameter for the sin function which will result 
in a kinda wind like wave, you can see for yourself here in [shader toy](https://www.shadertoy.com/view/MXXXWj)

It's called `sin_term` because I'll pass it to sin function later in the vertex shader.

#### Pitch
defines the angle of rotation around the UP axis, which is always `{0, 1, 0}` in our case the grass will always 
point upwards, so all we need is just an angle to construct a rotation matrix in the vertex shader. 
You can make this random or always face the camera or be controlled by the user whatever suits your needs.



#### Frustum culling
For the frustum culling, we start by generating a sphere around each blade the radius of the circle is determined by the max of height and width 
then we transform the sphere to camera space, at this point the distance from the camera is just the length of the point as in camera space the camera
is at `0, 0, 0` we use this to apply the cutoff distance and choose LOD.

```glsl
float radius = blade_height >= blade_width ? blade_height : blade_width;
vec4 center = vec4(pos, 1.0);
center.x += (blade_width / 2);
center.y += (blade_height / 2);

center = pc.per_frame.view * center;

// cut off distance
//We are in view space .. camera at 0, 0, 0;
float dist_from_cam = distance(center.xyz);
const float cutoff_dist = 800;
const float low_lod_dist = 200;

bool visible = (dist_from_cam < cutoff_dist);
bool low_lod = (dist_from_cam > low_lod_dist);
```

then the frustum culling we kinda doing the projection by hand and then check if the sphere is in range, I only do culling on the x and y axes as for the z
axis we already have a cutoff but adding that is also trivial. I learned this way of culling on [Arseny Kapoulkine's stream](https://youtu.be/NGGzk4Fi2iU?t=6962)
they explain it much better but basically, we extract the left or right plane(we need just one of them) and the top or bottom plane then on the GPU we calculate 
the dot product between the sphere center and planes while taking the abs of the x component of the center of the sphere to do the culling on both sides at 
same time utilizing its symmetry.

```glsl
// the dot product with x/z components of the x plain normal
visible = visible && 
	center.z * frustum[1] + abs(center.x) * frustum[0] < radius;
// the dot product with y/z components of the y plain normal
visible = visible && // 
	center.z * frustum[3] + abs(center.y) * frustum[2] < radius;
```

After that, we fill the blade info in the respective index in the blades data buffer

```glsl
uint buf_index = pc.blades_number.x * i.y + i.x;
pc.grass.data[buf_index].pos_bend.xyz = pos;
pc.grass.data[buf_index].pos_bend.w = bend_factor;
pc.grass.data[buf_index].anim_size.x = blade_width;
pc.grass.data[buf_index].anim_size.y = blade_height;
pc.grass.data[buf_index].anim_size.z = pitch;
pc.grass.data[buf_index].anim_size.w = sin_term;
```

#### Draw Command Buffers
After generating the data we can fill the command buffer, each thread will atomically increase the number
of instances in the [commands buffer](https://registry.khronos.org/vulkan/specs/1.3-extensions/man/html/VkDrawIndirectCommand.html)
this allows us to know to use the instance count as an index in another buffer to store the indices of the visible blades which allows us to access the values
using `gl_InstaceIndex` we can also copy the buffer and sort using prefix sum scan just like Acerola in his video but this is better memory-wise and probably
performance wise but I didn't measure performance. in summary, the vertex shader will use `gl_InstaceIndex` to index into a buffer that contains the indices of
the visible grass blades.

![diagram showing the buffers layout](/images/foliage-buffers.png)

The compute shader makes use of 2 indirect draw commands one for high LOD and other for low LOD we can add as many LOD levels as we want, and we check if it's low
LOD or high and then increase `gl_InstanceIndex` in the respective command buffer.

```glsl
// cmd_buf[0] is high LOD
// cmd_buf[1] is low LOD
bool low_lod = dist_from_cam > low_lod_dist;
if (visible) {
	uint cmd_index = uint(low_lod);
	uint index_in_visible = atomicAdd(
		pc.cmds.data[cmd_index].instance_count, 
		1
	);
}
```

after that, we use `index_in_visible` to index into the visible blades indices buffer and store the index of the current grass blade.
```glsl
// pc.visible is the buffer ref of the visible high LOD buffers
// pc.visible_low_lod is the buffer ref of the visible low LOD buffers
DrawIndices indices = low_lod ? pc.visible_low_lod : pc.visible;
indices.i[index_in_visible] = buf_index;
// buf_index is the index of the grass blade.
```

Now we have our indices data in a continuous buffer to index into using `gl_InstanceIndex` and `gl_DrawID` to determine which indices buffer to read from.
We are ready to draw the grass blades.

### Rendering

In the vertex shader we start by pulling the Blade data respective to the current instance.
```glsl
DrawIndices visible = gl_DrawID == 1 ? pc.visible_low_lod : pc.visible;
uint i_visible = visible.i[gl_InstanceIndex];
GrassBlade blade = pc.grass.data[i_visible];
```

After that, we construct a rotation matrix and apply the height and width multiplier.
```glsl
float sin_pitch = sin(blade.anim_size.z);
float cos_pitch = cos(blade.anim_size.z);
float height_multiplier = blade.anim_size.y;
float width_multiplier = blade.anim_size.x;
mat3 rotation = {
	{cos_pitch, 0, -sin_pitch},
	{0, 1, 0},
	{sin_pitch, 0, cos_pitch},
};

vec3 v_pos = rotation * 
	vec3(v.x * width_multiplier, v.y * height_multiplier, v.z);
```

Then we use the sin term to animate the grass blade using a sin function we scroll with time and the height of the vertex because naturally the tip of 
of the grass blade skew more than the base.

```glsl
float sin_term = blade.anim_size.w;
float bend = sin(sin_term + pc.time + (blade.pos_bend.w * pos.y));
pos.z += bend * pos.y;
```

here is how it looks

{% youtube url="https://www.youtube.com/embed/mDakjkrvH-0" label="Grass Animation" /%}

For the color, I opted for a simple gradient that goes brighter as it gets higher. I plan to improve this for example using normals for the grass also 
add some specular lighting as it could look really nice for example like Ghost of Tsushima's grass.

### Optimization

The simplest thing I thought of was just to reduce the amount of the work the vertex shader does since it will run millions of times a low hanging fruit was 
multiplying the projection and view matrix on the CPU and have it ready for the vertex shader, the next thing we can do is optimize the grass blade mesh
I've used [Mesh Optimizer](https://github.com/zeux/meshoptimizer) by Arseny Kapoulkine I used it and did multiple optimizations and the one who had the most 
impact was converting the grass blade from a triangle list to a triangle strip that reduced the number of vertex shader invocations drastically and almost cut 
the vertex shader work in half and the shape of the grass blade can be represented nicely as a strip.

#### very rough numbers

**Note:** _note I got the numbers using [Vulkan's timestamp queries](https://registry.khronos.org/vulkan/specs/1.3-extensions/html/vkspec.html#queries)_

On my RX5600XT using the [open source drivers(RADV)](https://docs.mesa3d.org/drivers/radv.html) on Linux in 1080p resleoution my GPU can process 
about 6'770'688 grass blade with all of them visible the compute shader takes about `4.7ms` 
and drawing it takes around `8ms` that's about it more than that it drop blew 60fps.
Increasing the area covered by the grass to 1000 by 1000 we can consider up to 19'066'880 grass blade with compute shader taking about `2.5ms` 
and drawing them takes about `6ms`.
![performance data](/images/folliage-stats.png)
