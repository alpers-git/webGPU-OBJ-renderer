"use strict";
var curMesh = {};

window.onload = function () {
  document.getElementById("model-select").value = "car.obj";
  loadSelection("car.obj");

  render();
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

function onModelSelect() {
  //get selection
  var x = document.getElementById("model-select").value;
  loadSelection(x);
}

function loadSelection(value) {
  //download
  OBJ.downloadModels([
    {
      name: "cur",
      obj: "models/" + value,
      mtl: false,
    },
  ])
    .then((data) => {
      curMesh = data;
      console.log("success: ", data);
    })
    .catch((e) => console.error("Failure:", e));
}

async function render() {
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
  var adapter = await navigator.gpu.requestAdapter();
  var device = await adapter.requestDevice();

  // Get a context to display our rendered image on the canvas
  var canvas = document.getElementById("webgpu-canvas");
  var context = canvas.getContext("webgpu");

  var shaderCode = `
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
  }
  `;

  // Setup shader modules
  var shaderModule = device.createShaderModule({ code: shaderCode });
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
  }

  // Specify vertex data
  var vertexBuffer = device.createBuffer({
    size: curMesh.cur.vertices.length * 4,
    usage: GPUBufferUsage.VERTEX,
    mappedAtCreation: true,
  });
  //positions
  new Float32Array(vertexBuffer.getMappedRange()).set(curMesh.cur.vertices);
  vertexBuffer.unmap();

  // Specify index data
  var indexBuffer = device.createBuffer({
    size: curMesh.cur.indices.length * 4,
    usage: GPUBufferUsage.INDEX,
    mappedAtCreation: true,
  });
  //indices
  new Uint32Array(indexBuffer.getMappedRange()).set(curMesh.cur.indices),
    indexBuffer.unmap();

  // Vertex attribute state and shader stage
  var vertexState = {
    module: shaderModule,
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
    device: device,
    format: swapChainFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  var depthFormat = "depth24plus-stencil8";
  var depthTexture = device.createTexture({
    size: { width: canvas.width, height: canvas.height, depth: 1 },
    format: depthFormat,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  });

  // Fragment output targets and shader stage
  var fragmentState = {
    module: shaderModule,
    entryPoint: "fragment_main",
    targets: [{ format: swapChainFormat }],
  };

  // Create bind group layout
  var bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });

  // Create render pipeline
  var layout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });

  var renderPipeline = device.createRenderPipeline({
    layout: layout,
    vertex: vertexState,
    fragment: fragmentState,
    depthStencil: {
      format: depthFormat,
      depthWriteEnabled: true,
      depthCompare: "less",
    },
  });

  var renderPassDesc = {
    colorAttachments: [{ view: undefined, loadValue: [0.3, 0.3, 0.3, 1] }],
    depthStencilAttachment: {
      view: depthTexture.createView(),
      depthLoadValue: 1.0,
      depthStoreOp: "store",
      stencilLoadValue: 0,
      stencilStoreOp: "store",
    },
  };

  // Create a buffer to store the view parameters
  var viewParamsBuffer = device.createBuffer({
    size: 16 * 4,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  var viewParamBG = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: viewParamsBuffer } }],
  });

  var camera = new ArcballCamera([0, 0, -20], [0, 0, 0], [0, 1, 0], 0.5, [
    canvas.width,
    canvas.height,
  ]);
  var proj = mat4.perspective(
    mat4.create(),
    (50 * Math.PI) / 180.0,
    canvas.width / canvas.height,
    0.1,
    100
  );
  var projView = mat4.create();

  // Register mouse and touch listeners
  var controller = new Controller();
  controller.mousemove = function (prev, cur, evt) {
    if (evt.buttons == 1) {
      camera.rotate(prev, cur);
    } else if (evt.buttons == 2) {
      camera.pan([cur[0] - prev[0], prev[1] - cur[1]]);
    }
  };
  controller.wheel = function (amt) {
    camera.zoom(amt);
  };
  controller.pinch = controller.wheel;
  controller.twoFingerDrag = function (drag) {
    camera.pan(drag);
  };
  controller.registerForCanvas(canvas);

  // Not covered in the tutorial: track when the canvas is visible
  // on screen, and only render when it is visible.
  var canvasVisible = false;
  var observer = new IntersectionObserver(
    function (e) {
      if (e[0].isIntersecting) {
        canvasVisible = true;
      } else {
        canvasVisible = false;
      }
    },
    { threshold: [0] }
  );
  observer.observe(canvas);

  var frame = function () {
    if (canvasVisible) {
      // Update camera buffer
      projView = mat4.mul(projView, proj, camera.camera);

      var upload = device.createBuffer({
        size: 16 * 4,
        usage: GPUBufferUsage.COPY_SRC,
        mappedAtCreation: true,
      });
      {
        var map = new Float32Array(upload.getMappedRange());
        map.set(projView);
        upload.unmap();
      }

      renderPassDesc.colorAttachments[0].view = context
        .getCurrentTexture()
        .createView();

      var commandEncoder = device.createCommandEncoder();
      commandEncoder.copyBufferToBuffer(upload, 0, viewParamsBuffer, 0, 16 * 4);

      var renderPass = commandEncoder.beginRenderPass(renderPassDesc);

      renderPass.setPipeline(renderPipeline);
      renderPass.setBindGroup(0, viewParamBG);
      renderPass.setVertexBuffer(0, vertexBuffer);
      renderPass.setIndexBuffer(indexBuffer, "uint32");
      renderPass.drawIndexed(curMesh.cur.indices.length);

      renderPass.endPass();
      device.queue.submit([commandEncoder.finish()]);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
