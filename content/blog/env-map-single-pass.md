---
external: false
draft: false
title: Implementing Skyboxes as Post Processing Pass(Screen Space)
description: describing how to render skyboxes without any buffers in screen space
date: 2024-02-06
---
This post describes how to render skyboxes with minimal memory bandwidth all we need
is the skybox texture to sample from, the inverse of projection and view matrices.
I will describe the process using Vulkan API as that's what I'm using.

### What Is A Post Processing Pass
It's a pass where we render a big triangle that covers the screen and we sample 
form a texture and apply various effects on our image.

### How Do We Do it
We make use of the GPU doing some work for us the GPU clips everything outside the normalized space
so if we managed to render a big triangle covering the whole screen what we get is a quad which is better than the traditional way of doing it with 2 triangles making a quad as we invoke 3 draw calls instead of 6.

Creating vertex buffers in Vulkan is a lot of boilerplate code and it's kind of annoying 
so storing the vertices in the vertex shader or generating them is a much better way.

#### The Pipeline Creation
this is what our input state could look like, empty without any vertex input

```cpp
VkPipelineVertexInputStateCreateInfo emptyInputState {
	.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO,
	.vertexAttributeDescriptionCount = 0,
	.pVertexAttributeDescriptions = nullptr,
	.vertexBindingDescriptionCount = 0,
	.pVertexBindingDescriptions = nullptr,
};
```

also, the vertices are in clockwise order so if you want to cull, cull the counterclockwise face.

#### Vertex Shader
Here is what our vertex shader could look like.

Note that here we do the inverse of the normal transformations
because we generate the vertices in the normalized space and we want it world space 
the inverse view is there because we want to reverse the camera rotation we are only multiplying by
the rotation part of the matrix when we convert it to `mat3` (discarding the last column and row).

```glsl
// code for push constants or uniform buffers
... 

layout (location = 0) out vec2 o_uv;
layout (location = 1) out vec3 o_view_dir;

void main() {
	o_uv = vec2((gl_VertexIndex << 1) & 2, (gl_VertexIndex & 2));
	gl_Position = vec4(o_uv * 2.0f + -1.0f, 0.0f, 1.0f);
	o_view_dir = mat3(push.inv_view) * (push.inv_proj * gl_Position).xyz;
}
```

#### Fragment Shader
Here is what our vertex shader could look like.

Note that we normalize the view direction as it's a direction and should be normalized
and then sample the cube map using the view direction. If we are using an equirectangular image 
as our skybox we need to convert the view direction to uv space of the image and then sample from it.

```glsl
vec2 direction_to_spherical(vec3 dir) {
  float phi = atan(dir.z, dir.x);
  float theta = acos(dir.y);
  float u = 0.5 - phi / TAU;
  float v = 1.0 - theta / PI;
  return vec2(u, v);
}

vec3 lin_to_rgb(vec3 lin) {
	return pow(lin, vec3(1.0 / 2.2));
}

layout (location = 0) in vec2 i_uv;
layout (location = 1) in vec3 i_view_dir;
layout (location = 0) out vec4 o_color;

void main() {
	// If your skybox is a cubemap
	vec3 view = normalize(i_view_dir);
	vec3 color = texture(cubemap, view).xyz;
	
	// If it's an equirectangular we have more work to do
	vec2 uv = direction_to_spherical(view); // calc the uv's
	vec3 color = texture(equirectangular, uv).xyz; // use them

	// o_color = vec4(i_uv.x, i_uv.y, 0.0, 1.0);
	// o_color = vec4(view, 1.0);
	color = lin_to_rgb(color);
	o_color = vec4(color, 1.0f);
}
```

#### Rendering Loop
Now we can just bind the pipeline and issue a draw call with `vertexCount = 3` just like 
```cpp
vkCmdBindPipeline(cmd_buf, VK_PIPELINE_BIND_POINT_GRAPHICS, fullscreen_pipeline);
vkCmdDraw(cmd_buf, 3, 1, 0, 0);
```

### Further Improvements
We can also use the stencil buffer to only draw the pixels that aren't covered saving further computation
also, we can do this with the lighting pass if we are doing deferred rendering because we have access
to the depth buffer we can just check if the depth is the maximum value we draw the skybox or we can 
check the position image and see if there's anything there, this might hurt the performance as we usually
want all the threads to do the same thing to benefit from the GPU's SIMT(Single instruction, multiple threads).

### Some Ideas
While reading **3D Graphics Rendering Cookbook** by _Sergey Kosarevsky and Viktor Latypov_they implemented
a simple animation making use of `VK_EXT_descriptor_indexing` extension by creating frames array in the GPU
and then indexing through them to create an animation, what if we did the same to the skybox so I loaded up
multiple frames of a HDRI time-laps and indexed through them. here are the results:

{% tweet url="https://twitter.com/the_geeko1/status/1754685060635103429" /%}

Note that you probably don't want to do skybox animation that way because the memory usage is very high and
to get a good-looking skybox you need an image with a very high resolution, I'm loading 120 6K frames each
of them is 74{%sub%}mb{%/sub%} that's more than 8{%sub%}gb{%/sub%} here's the memory usage according
to Radeon Memory Visualizer it used all of my GPU heap and 4{%sub%}gb{%/sub%} of my main memory which something
you probably don't want. this is basically playing a video but most likely in the worst way possible.
!["memory usage"](/images/envmap-memory.png)

### Resource
- [Vulkan tutorial on rendering a fullscreen quad without buffers](https://www.saschawillems.de/blog/2016/08/13/vulkan-tutorial-on-rendering-a-fullscreen-quad-without-buffers/)
- [Optimizing Triangles for a Full-screen Pass](https://wallisc.github.io/rendering/2021/04/18/Fullscreen-Pass.html)
- [A slightly faster buffer-less vertex shader trick](https://www.reddit.com/r/gamedev/comments/2j17wk/a_slightly_faster_bufferless_vertex_shader_trick/)

