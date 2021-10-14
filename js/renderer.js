"use strict";
var scene;
var webAPI;
class Scene {
  constructor(canvas) {
    this.curMesh = { a: 1, b: 2 };
    this.model = mat4.create();
    this.normalMat = mat3.create();
    this.proj = mat4.perspective(
      mat4.create(),
      (50 * Math.PI) / 180.0,
      canvas.width / canvas.height,
      0.1,
      100
    );
    this.projView = mat4.create();
    this.camera = new ArcballCamera([0, 0, -20], [0, 0, 0], [0, 1, 0], 0.5, [
      canvas.width,
      canvas.height,
    ]);
    this.light = {
      position: vec3.create(),
      color: vec3.create(),
    };
  }
  async loadSelection(value) {
    //download
    await OBJ.downloadModels([
      {
        name: "cur",
        obj: "models/" + value,
        mtl: false,
      },
    ])
      .then((data) => {
        scene.curMesh = data;
        console.log("success: ", scene);
      })
      .catch((e) => console.error("Failure:", e));
  }
}

class RenderAPI {
  constructor() {
    var stop = false;

    this.adapter = {}; //await navigator.gpu.requestAdapter();
    this.device = {}; //await webAPI.adapter.requestDevice();

    this.depthFormat = "depth24plus-stencil8";
    this.depthTexture = {}; /*this.device.createTexture({
      size: { width: canvas.width, height: canvas.height, depth: 1 },
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });*/
    this.renderPassDesc = {
      /*colorAttachments: [{ view: undefined, loadValue: [0.9, 0.3, 0.3, 1] }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthLoadValue: 1.0,
        depthStoreOp: "store",
        stencilLoadValue: 0,
        stencilStoreOp: "store",
      },*/
    };
    this.shaderCode = `
  type float4 = vec4<f32>;
  type float3 = vec3<f32>;
  type float2 = vec2<f32>;
  struct VertexInput {
      [[location(0)]] position: float3;
      [[location(1)]] normal: float3;
  };

  struct VertexOutput {
      [[builtin(position)]] w_position: float4;
      [[location(0)]] color: float4;
      [[location(1)]] w_normal: float3;
      [[location(2)]] vert_pos: float3;
  };

  [[block]]
  struct Camera {
    proj         : mat4x4<f32>;
    view         : mat4x4<f32>;
    inv_view     : mat4x4<f32>;
    view_pos     : vec4<f32>;
  };

  [[block]]
  struct Transforms {
    model_mat    : mat4x4<f32>;
    normal_mat   : mat3x3<f32>;
  };

  [[group(0), binding(0)]]
  var<uniform> camera: Camera;

  [[group(0), binding(1)]]
  var<uniform> tr: Transforms;


  [[block]]
  struct Light {
      position: vec4<f32>;
      color: vec4<f32>;
  };
  [[group(1), binding(0)]]
  var<uniform> light: Light;

  [[stage(vertex)]]
  fn vertex_main(vert: VertexInput) -> VertexOutput {
      var out: VertexOutput;
      out.color = float4(0.7, 0.7, 0.7, 1.0);
      let vert_pos_4 = camera.view * vec4<f32>(vert.position, 1.0);

      out.vert_pos = (vert_pos_4).xyz / vert_pos_4.w;
      out.w_position = camera.proj * float4(out.vert_pos.xyz, 1.0);

      out.w_normal = normalize( tr.normal_mat * vert.normal ).xyz;
      return out;
  };

  [[stage(fragment)]]
  fn fragment_main(in: VertexOutput) -> [[location(0)]] float4 {

    let ambient_strength = 0.1;
    let ambient_color = float3(0.4,0.2,0.45) * ambient_strength;

    let light_dir = normalize(light.position.xyz - in.vert_pos.xyz);
    let view_dir = normalize(camera.view_pos.xyz - in.vert_pos.xyz);
    let half_dir = normalize(view_dir + light_dir);

    let diffuse_strength = max(dot(in.w_normal, light_dir),0.0);
    let diffuse_color = light.color.xyz * diffuse_strength;

    let specular_strength = pow(max(dot(in.w_normal, half_dir), 0.0), 32.0);
    let specular_color = specular_strength * light.color.xyz;

    let res = float4((ambient_color + diffuse_color + specular_color) * in.color.xyz,1.0);
    return res;
  }`;

    this.shaderModule = {};
    this.vertexState = {};
    this.fragmentState = {};
    this.bindGroupLayoutCamera = {};
    this.bindGroupLayoutLight = {};
    this.renderPipeline = {};
    this.cameraParamsBuffer = {};
    this.transformsParamsBuffer = {};
    this.lightParamsBuffer = {};
    this.cameraParamBG = {};
    this.lightParamBG = {};
    this.vertexBuffer = {};
    this.indexBuffer = {};
    this.normalBuffer = {};
    this.indexCount = 0;
  }
  async initDevice() {
    this.adapter = await navigator.gpu.requestAdapter();
    this.device = await this.adapter.requestDevice();
  }

  async compileShaderModules(canvas) {
    var context = canvas.getContext("webgpu");
    this.shaderModule = this.device.createShaderModule({
      code: this.shaderCode,
    });
    // This API is only available in Chrome right now
    if (this.shaderModule.compilationInfo) {
      var compilationInfo = await this.shaderModule.compilationInfo();
      if (compilationInfo.messages.length > 0) {
        var hadError = false;
        console.log("Shader compilation log:");
        for (var i = 0; i < compilationInfo.messages.length; ++i) {
          var msg = compilationInfo.messages[i];
          console.log(`${msg.lineNum}:${msg.linePos} - ${msg.message}`);
          hadError = hadError || msg.type == "error";
        }
        if (hadError) {
          console.log("Shader failed to compile");
          return;
        }
      }
    }

    this.depthTexture = this.device.createTexture({
      size: { width: canvas.width, height: canvas.height, depth: 1 },
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    this.renderPassDesc = {
      colorAttachments: [
        {
          view: undefined,
          loadValue: [0.325 / 2.9, 0.125 / 2.3, 0.26 / 2.3, 1],
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthLoadValue: 1.0,
        depthStoreOp: "store",
        stencilLoadValue: 0,
        stencilStoreOp: "store",
      },
    };

    // Vertex attribute state and shader stage
    this.vertexState = {
      module: this.shaderModule,
      entryPoint: "vertex_main",
      buffers: [
        {
          arrayStride: 4 * 3,
          attributes: [
            { format: "float32x3", offset: 0, shaderLocation: 0 }, //position
          ],
        },
        {
          arrayStride: 4 * 3,
          attributes: [
            { format: "float32x3", offset: 0, shaderLocation: 1 }, //normal
          ],
        },
      ],
    };

    // Setup render outputs
    var swapChainFormat = "bgra8unorm";
    context.configure({
      device: this.device,
      format: swapChainFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

    // Fragment output targets and shader stage
    this.fragmentState = {
      module: this.shaderModule,
      entryPoint: "fragment_main",
      targets: [{ format: swapChainFormat }],
    };

    // Create bind group layout
    this.bindGroupLayoutCamera = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });
    this.bindGroupLayoutLight = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    // Create render pipeline
    var layout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayoutCamera, this.bindGroupLayoutLight],
    });

    this.renderPipeline = this.device.createRenderPipeline({
      layout: layout,
      vertex: this.vertexState,
      fragment: this.fragmentState,
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // Create a buffer to store the view parameters
    this.cameraParamsBuffer = this.device.createBuffer({
      size: (16 * 3 + 4) * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // Buffer for model and normal matrices
    this.transformsParamsBuffer = this.device.createBuffer({
      size: (16 * 2) * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    //Do the same for light parameters
    this.lightParamsBuffer = this.device.createBuffer({
      size: 8 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.cameraParamBG = this.device.createBindGroup({
      layout: this.bindGroupLayoutCamera,
      entries: [{ binding: 0, resource: { buffer: this.cameraParamsBuffer } },
                { binding: 1, resource: { buffer: this.transformsParamsBuffer } }],
    });


    this.lightParamBG = this.device.createBindGroup({
      layout: this.bindGroupLayoutLight,
      entries: [{ binding: 0, resource: { buffer: this.lightParamsBuffer } }],
    });
  }

  createBuffer(arr, usage) {
    if (arr.constructor === Uint32Array || arr.constructor === Float32Array) {
      //from: https://alain.xyz/blog/raw-webgpu
      let desc = {
        size: (arr.byteLength + 3) & ~3,
        usage,
        mappedAtCreation: true,
      };
      let buffer = this.device.createBuffer(desc);

      const writeArray =
        arr.constructor === Uint32Array
          ? new Uint32Array(buffer.getMappedRange())
          : new Float32Array(buffer.getMappedRange());
      writeArray.set(arr);
      buffer.unmap();
      return buffer;
    } else {
      console.warn("Failed to create buffer: type mismatch", typeof arr);
      return {};
    }
  }

  createBuffers(mesh) {
    //vertices
    let tmp = new Float32Array(mesh.vertices);
    this.vertexBuffer = this.createBuffer(tmp, GPUBufferUsage.VERTEX);

    //normals
    tmp = new Float32Array(mesh.vertexNormals);
    this.normalBuffer = this.createBuffer(tmp, GPUBufferUsage.VERTEX);

    //indices
    tmp = new Uint32Array(mesh.indices);
    this.indexBuffer = this.createBuffer(tmp, GPUBufferUsage.INDEX);

    this.indexCount = mesh.indices.length;
  }
  destroyBuffers() {
    if (typeof this.vertexBuffer === "undefined") {
      destroy(this.vertexBuffer);
      this.vertex.buffer = {};
    }
    if (typeof this.normalBuffer === "undefined") {
      destroy(this.normalBuffer);
      this.normalBuffer = {};
    }
    if (typeof this.indexBuffer === "undefined") {
      destroy(this.indexBuffer);
      this.indexBuffer = {};
    }
  }
}

async function init() {
  await webAPI.initDevice();
  await webAPI.compileShaderModules(document.getElementById("webgpu-canvas"));
  webAPI.createBuffers(scene.curMesh.cur);
}

window.onload = async function () {
  scene = new Scene(document.getElementById("webgpu-canvas"));
  webAPI = new RenderAPI();
  //document.getElementById("model-select").value = "rabbit.obj";
  await scene.loadSelection("utah_teapot.obj");
  await init();
  main();
};

document.addEventListener("DOMContentLoaded", function () {
  $.getJSON("./models", (options) => {
    var elems = document.querySelectorAll("select");
    var instances = M.FormSelect.init(elems, options);
    let modS = document.getElementById("model-select");
    for (let i of options) {
      let opt = document.createElement("option");
      opt.innerText = i;
      modS.appendChild(opt);
    }
  });
});

async function onModelSelect() {
  //get selection
  webAPI.stop = true;
  webAPI.destroyBuffers();
  var x = document.getElementById("model-select").value;
  await scene.loadSelection(x);
  await webAPI.createBuffers(scene.curMesh.cur);
  webAPI.stop = false;
}

function hex2rgbRatio(value) {
  let r = 0,
    g = 0,
    b = 0;
  if (value.length == 4) {
    r = "0x" + value[1] + value[1];
    g = "0x" + value[2] + value[2];
    b = "0x" + value[3] + value[3];
  } else if (value.length == 7) {
    r = "0x" + value[1] + value[2];
    g = "0x" + value[3] + value[4];
    b = "0x" + value[5] + value[6];
  }
  r = +(r / 255).toFixed(1);
  g = +(g / 255).toFixed(1);
  b = +(b / 255).toFixed(1);
  return new Float32Array([r, g, b]);
}

function drawFrame() {
  if (!webAPI.stop) {
    //Update light
    scene.light.position[0] = document.getElementById("lx").value;
    scene.light.position[1] = document.getElementById("ly").value;
    scene.light.position[2] = document.getElementById("lz").value;
    scene.light.color = hex2rgbRatio(
      document.getElementById("lcolor-picker").value
    );
    var uploadLight = webAPI.device.createBuffer({
      size: 8 * 4,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    {
      let data = [...scene.light.position, 1, ...scene.light.color, 1];
      var map = new Float32Array(uploadLight.getMappedRange());
      map.set(data);
      console.log(data);
      uploadLight.unmap();
    }

    // Update camera buffer
    scene.projView = mat4.mul(scene.projView, scene.proj, scene.camera.camera);
    scene.camera.invCamera = mat4.invert(
      scene.camera.invCamera,
      scene.camera.camera
    );

    scene.model = mat4.create()
    scene.normalMat = mat4.create()
    scene.normalMat = mat3.normalFromMat4(scene.normalMat, scene.camera.camera)
    //scene.normalMat = mat4.invert(scene.normalMat, scene.normalMat);
    /*var tmpMat = mat3.create();

    console.log(scene.normalMat);

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
          tmpMat[ i * 3 + j ] = scene.normalMat[i * 4 + j]
      }
    }
    console.log("aaa", tmpMat);

    tmpMat = mat3.invert(tmpMat);
    tmpMat = mat3.transpose(tmpMat);

    console.log(tmpMat);

    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if(i > 3 || j > 3)
          scene.normalMat[i * 4 + j] = 0
        else
          scene.normalMat[i * 4 + j] = tmpMat[ i * 3 + j ]
      }
    }*/

    var uploadView = webAPI.device.createBuffer({
      size: (16 * 3 + 4) * 4,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    let v = vec4.create();
    for (let i = 0; i < 3; i++) {
      v[i] = scene.camera.invCamera[12 + i];
      /*if (i < 3) {
        v[i] = v[i] * v[3];
      }*/
    }
    v[3] = 1;
    {
      let data = [
        ...scene.proj,
        ...scene.camera.camera,
        ...v,
      ];
      var map = new Float32Array(uploadView.getMappedRange());
      map.set(data);
      uploadView.unmap();
    }

    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("webgpu");
    webAPI.renderPassDesc.colorAttachments[0].view = context
      .getCurrentTexture()
      .createView();

    var commandEncoder = webAPI.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(
      uploadView,
      0,
      webAPI.cameraParamsBuffer,
      0,
      (16 * 3 + 4) * 4
    );
    
    var transforms = webAPI.device.createBuffer({
      size: (16 * 3 + 4) * 4,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });

    {
      let data = [
        ...scene.model,
        ...scene.normalMat,
      ];
      var map = new Float32Array(transforms.getMappedRange());
      map.set(data);
      transforms.unmap();
    }

    commandEncoder.copyBufferToBuffer(
      transforms,
      0,
      webAPI.transformsParamsBuffer,
      0,
      (16 * 2) * 4
    );

    commandEncoder.copyBufferToBuffer(
      uploadLight,
      0,
      webAPI.lightParamsBuffer,
      0,
      8 * 4
    );

    var renderPass = commandEncoder.beginRenderPass(webAPI.renderPassDesc);

    renderPass.setPipeline(webAPI.renderPipeline);
    renderPass.setBindGroup(0, webAPI.cameraParamBG);
    renderPass.setBindGroup(1, webAPI.lightParamBG);
    renderPass.setVertexBuffer(0, webAPI.vertexBuffer);
    renderPass.setVertexBuffer(1, webAPI.normalBuffer);
    renderPass.setIndexBuffer(webAPI.indexBuffer, "uint32");
    renderPass.drawIndexed(webAPI.indexCount);
    renderPass.endPass();
    webAPI.device.queue.submit([commandEncoder.finish()]);
  }
  requestAnimationFrame(drawFrame);
}

async function main() {
  if (!navigator.gpu) {
    document
      .getElementById("webgpu-canvas")
      .setAttribute("style", "display:none;");
    document
      .getElementById("no-webgpu")
      .setAttribute("style", "display:block;");
    return;
  }

  // Get a context to display our rendered image on the canvas
  var canvas = document.getElementById("webgpu-canvas");
  var context = canvas.getContext("webgpu");

  // Register mouse and touch listeners
  var controller = new Controller();
  controller.mousemove = function (prev, cur, evt) {
    if (evt.buttons == 1) {
      scene.camera.rotate(prev, cur);
    } else if (evt.buttons == 2) {
      scene.camera.pan([cur[0] - prev[0], prev[1] - cur[1]]);
    }
  };
  controller.wheel = function (amt) {
    scene.camera.zoom(amt);
  };
  controller.pinch = controller.wheel;
  controller.twoFingerDrag = function (drag) {
    camera.pan(drag);
  };
  controller.registerForCanvas(canvas);

  // Not covered in the tutorial: track when the canvas is visible
  // on screen, and only render when it is visible.
  var observer = new IntersectionObserver(
    function (e) {
      if (e[0].isIntersecting) {
        webAPI.stop = false;
      } else {
        webAPI.stop = true;
      }
    },
    { threshold: [0] }
  );
  observer.observe(canvas);

  requestAnimationFrame(drawFrame);
}
