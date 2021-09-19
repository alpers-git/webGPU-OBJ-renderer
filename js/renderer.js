"use strict";
var scene;
var webAPI;
class Scene {
  constructor(canvas) {
    this.curMesh = { a: 1, b: 2 };
    this.model = mat4.create();
    //this.view =
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
  }
  loadSelection(value) {
    //download
    OBJ.downloadModels([
      {
        name: "cur",
        obj: "models/" + value,
        mtl: false,
      },
    ])
      .then((data) => {
        scene.curMesh = data;
        //console.log("success: ", scene);
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
  struct VertexInput {
      [[location(0)]] position: float3;
      //[[location(1)]] color: float4;
  };

  struct VertexOutput {
      [[builtin(position)]] position: float4;
      [[location(0)]] color: float4;
  };

  [[block]]
  struct ViewParams {
      view_proj: mat4x4<f32>;
  };

  [[group(0), binding(0)]]
  var<uniform> view_params: ViewParams;

  [[stage(vertex)]]
  fn vertex_main(vert: VertexInput) -> VertexOutput {
      var out: VertexOutput;
      out.color =  vec4<f32>(0.0, 0.0, 1.0, 1.0);
      out.position = view_params.view_proj * vec4<f32>(vert.position, 1.0);
      return out;
  };

  [[stage(fragment)]]
  fn fragment_main(in: VertexOutput) -> [[location(0)]] float4 {
      //var light_dir = vec4<f32>(0.0,-1.0,0.0,1.0);
      return float4(in.color /* *(light_dir * in.position)*/);
  }`;

    this.shaderModule = {};
    this.vertexState = {};
    this.fragmentState = {};
    this.bindGroupLayout = {};
    this.renderPipeline = {};
    this.viewParamsBuffer = {};
    this.viewParamBG = {};
    this.vertexBuffer = {};
    this.indexBuffer = {};
  }
  async initDevice() {
    this.adapter = await navigator.gpu.requestAdapter();
    this.device = await this.adapter.requestDevice();
    //while (this.device == null) {}
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
          loadValue: [0.325 / 1.3, 0.125 / 1.3, 0.26 / 1.3, 1],
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
            { format: "float32x3", offset: 0, shaderLocation: 0 },
            //{ format: "float32x4", offset: 4 * 4, shaderLocation: 1 },
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
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "uniform" },
        },
      ],
    });

    // Create render pipeline
    var layout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
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
    this.viewParamsBuffer = this.device.createBuffer({
      size: 16 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.viewParamBG = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.viewParamsBuffer } }],
    });
  }

  createBuffers(mesh) {
    this.vertexBuffer = webAPI.device.createBuffer({
      size: mesh.vertices.length * 4,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    //positions
    new Float32Array(this.vertexBuffer.getMappedRange()).set(mesh.vertices);
    this.vertexBuffer.unmap();

    // Specify index data
    this.indexBuffer = webAPI.device.createBuffer({
      size: mesh.indices.length * 4,
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    //indices
    new Uint32Array(this.indexBuffer.getMappedRange()).set(mesh.indices),
      this.indexBuffer.unmap();
  }
  destroyBuffers() {
    if (typeof this.vertexBuffer === "undefined") destroy(this.vertexBuffer);
    if (typeof this.indexBuffer === "undefined") destroy(this.indexBuffer);
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
  webAPI.createBuffers(scene.curMesh.cur);
  webAPI.stop = false;
}

function drawFrame() {
  if (!webAPI.stop) {
    webAPI.destroyBuffers();//todo
    webAPI.createBuffers(scene.curMesh.cur);//todo
    // Update camera buffer
    scene.projView = mat4.mul(scene.projView, scene.proj, scene.camera.camera);

    var upload = webAPI.device.createBuffer({
      size: 16 * 4,
      usage: GPUBufferUsage.COPY_SRC,
      mappedAtCreation: true,
    });
    {
      var map = new Float32Array(upload.getMappedRange());
      map.set(scene.projView);
      upload.unmap();
    }

    var canvas = document.getElementById("webgpu-canvas");
    var context = canvas.getContext("webgpu");
    webAPI.renderPassDesc.colorAttachments[0].view = context
      .getCurrentTexture()
      .createView();

    var commandEncoder = webAPI.device.createCommandEncoder();
    commandEncoder.copyBufferToBuffer(
      upload,
      0,
      webAPI.viewParamsBuffer,
      0,
      16 * 4
    );

    var renderPass = commandEncoder.beginRenderPass(webAPI.renderPassDesc);

    renderPass.setPipeline(webAPI.renderPipeline);
    renderPass.setBindGroup(0, webAPI.viewParamBG);
    renderPass.setVertexBuffer(0, webAPI.vertexBuffer);
    renderPass.setIndexBuffer(webAPI.indexBuffer, "uint32");
    renderPass.drawIndexed(scene.curMesh.cur.indices.length);
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

  // Get a GPU device to render with
  /*webAPI.adapter = await navigator.gpu.requestAdapter();
  webAPI.device = await webAPI.adapter.requestDevice();*/

  // Get a context to display our rendered image on the canvas
  var canvas = document.getElementById("webgpu-canvas");
  var context = canvas.getContext("webgpu");

  /*var shaderCode = `
  type float4 = vec4<f32>;
  type float3 = vec3<f32>;
  struct VertexInput {
      [[location(0)]] position: float3;
      //[[location(1)]] color: float4;
  };

  struct VertexOutput {
      [[builtin(position)]] position: float4;
      [[location(0)]] color: float4;
  };

  [[block]]
  struct ViewParams {
      view_proj: mat4x4<f32>;
  };

  [[group(0), binding(0)]]
  var<uniform> view_params: ViewParams;

  [[stage(vertex)]]
  fn vertex_main(vert: VertexInput) -> VertexOutput {
      var out: VertexOutput;
      out.color =  vec4<f32>(0.0, 0.0, 1.0, 1.0);
      out.position = view_params.view_proj * vec4<f32>(vert.position, 1.0);
      return out;
  };

  [[stage(fragment)]]
  fn fragment_main(in: VertexOutput) -> [[location(0)]] float4 {
      //var light_dir = vec4<f32>(0.0,-1.0,0.0,1.0);
      return float4(in.color  *(light_dir * in.position));
  }
  `;*/

  // Setup shader modules
  /*var shaderModule = webAPI.device.createShaderModule({ code: shaderCode });
  // This API is only available in Chrome right now
  if (shaderModule.compilationInfo) {
    var compilationInfo = await shaderModule.compilationInfo();
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
  }*/
  // Specify vertex data
  /*var vertexBuffer = webAPI.device.createBuffer({
    size: scene.curMesh.cur.vertices.length * 4,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });
  //positions
  new Float32Array(vertexBuffer.getMappedRange()).set(
    scene.curMesh.cur.vertices
  );
  vertexBuffer.unmap();

  // Specify index data
  var indexBuffer = webAPI.device.createBuffer({
    size: scene.curMesh.cur.indices.length * 4,
    usage: GPUBufferUsage.INDEX,
    mappedAtCreation: true,
  });
  //indices
  new Uint32Array(indexBuffer.getMappedRange()).set(scene.curMesh.cur.indices),
    indexBuffer.unmap();*/

  // Vertex attribute state and shader stage
  /*var vertexState = {
    module: webAPI.shaderModule,
    entryPoint: "vertex_main",
    buffers: [
      {
        arrayStride: 4 * 3,
        attributes: [
          { format: "float32x3", offset: 0, shaderLocation: 0 },
          //{ format: "float32x4", offset: 4 * 4, shaderLocation: 1 },
        ],
      },
    ],
  };

  // Setup render outputs
  var swapChainFormat = "bgra8unorm";
  context.configure({
    device: webAPI.device,
    format: swapChainFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });*/

  /*var depthFormat = "depth24plus-stencil8";
  var depthTexture = webAPI.device.createTexture({
    size: { width: canvas.width, height: canvas.height, depth: 1 },
    format: depthFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });*/

  // Fragment output targets and shader stage
  /*var fragmentState = {
    module: webAPI.shaderModule,
    entryPoint: "fragment_main",
    targets: [{ format: swapChainFormat }],
  };

  // Create bind group layout
  var bindGroupLayout = webAPI.device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });

  // Create render pipeline
  var layout = webAPI.device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  var renderPipeline = webAPI.device.createRenderPipeline({
    layout: layout,
    vertex: vertexState,
    fragment: fragmentState,
    depthStencil: {
      format: webAPI.depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  // Create a buffer to store the view parameters
  var viewParamsBuffer = webAPI.device.createBuffer({
    size: 16 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  var viewParamBG = webAPI.device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: viewParamsBuffer } }],
  });*/

  /*var camera = new ArcballCamera([0, 0, -20], [0, 0, 0], [0, 1, 0], 0.5, [
    canvas.width,
    canvas.height,
  ]);
  scene.proj = mat4.perspective(
    mat4.create(),
    (50 * Math.PI) / 180.0,
    canvas.width / canvas.height,
    0.1,
    100
  );
  scene.projView = mat4.create();*/

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
