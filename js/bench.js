let canvasDom = document.getElementById('canvas');
let ctx = canvasDom.getContext('2d');

let canvasDom2 = document.getElementById('canvas2');
let ctx2 = canvasDom2.getContext('2d');

async function runComputeShaderExample() {
    if (!navigator.gpu) {
        alert("WebGPU is not supported in your browser!");
        return;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        alert("No WebGPU adapter found.");
        return;
    }

    const device = await adapter.requestDevice();


    let width = 800;
    let height = 300;
    let imageDataSize = width * height * 4;

    // 1. Define the input data
    let WORK_GROUPS = 32;
    let points = 2 * 800;
    const data = new Float32Array(2 * points); // Using more data for better demonstration

    let fx = x => 125 * Math.sin(2 * Math.PI * x / 100) + 150

    ctx2.lineWidth = 3;


    ctx2.moveTo(0, fx(0));

    let dx = width / points;
    let x = 0;

    // for (let i = 0; i < points; i++) {
    //     let from = fx(x);
    //     x += dx;
    //     let to = fx(x);

    //     let hheight = Math.max(ctx2.lineWidth, Math.abs(from - to)) / 2

    //     let center = (from + to) / 2;
    //     let yFrom = center - hheight;
    //     let yTo = center + hheight;

    //     data[2 * i + 0] = yFrom;
    //     data[2 * i + 1] = yTo;
    // }

    i = 100;
    data[2 * i + 0] = 100
    data[2 * i + 1] = 200

    i = 101;
    data[2 * i + 0] = 150
    data[2 * i + 1] = 250


    x = 0;
    for (let i = 0; i < points; i++) {
        x += dx;

        ctx2.beginPath();
        ctx2.moveTo(x + 0.5, data[2 * i + 0]);
        ctx2.lineTo(x + 0.5, data[2 * i + 1]);
        ctx2.stroke();
    }




    ctx2.beginPath();
    ctx2.moveTo(20 + 0.5, 40);
    ctx2.lineTo(20 + 0.5, 3000);
    // ctx2.moveTo(20 + 1., 50);
    // ctx2.lineTo(20 + 1., 70);
    ctx2.stroke();

    const dataSize = data.byteLength;
    const numElements = data.length;


    // 2. Create GPU Buffers
    // Input buffer
    const inputBuffer = device.createBuffer({
        size: dataSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true, // Map for initial data upload
    });
    new Float32Array(inputBuffer.getMappedRange()).set(data);
    inputBuffer.unmap();

    // Output buffer for the sum (initially 0)


    const outputByteSize = imageDataSize * Uint8ClampedArray.BYTES_PER_ELEMENT
    const outputBuffer = device.createBuffer({
        size: outputByteSize, // Just one float for the sum
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // Staging buffer to read data back to CPU
    const stagingBuffer = device.createBuffer({
        size: outputByteSize,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });

    // 3. Define the Compute Shader (WGSL - WebGPU Shading Language)
    const computeShaderCode = `
        @group(0) @binding(0) var<storage, read> inputData: array<f32>;
        @group(0) @binding(1) var<storage, read_write> outputPixel: array<u32>; // Using a single f32 for atomic ops

        @compute @workgroup_size(32) // Process 64 elements per workgroup
        fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
            let width = 800u;
            let height = 300u;
            let hlineWidth = 1;

            let x = global_id.x; // We only care about the x-dimension for a 1D array

            if (x >= width) {
                return;
            }

            for (var y: u32 = 0; y < height; y++) {
                var covered = 0u;
                for (var dx: i32 = 0; dx < 1; dx += 1) {
                    let lxFrom = u32(max(0, 2 * i32(x) - hlineWidth + dx));
                    let lxTo = u32(min(2 * i32(width - 1) , 2 * i32(x) + hlineWidth + dx));

                    for (var dy: f32 = 0.; dy < 1.; dy += 0.5) {
                        let yval = f32(y) + dy;

                        for (var lx: u32 = lxFrom; lx <= lxTo; lx += 1u) {
                            if (inputData[2 * lx + 0] <= yval && yval <= inputData[2 * lx + 1]) {
                            // if (f32(lx) <= yval && yval < f32(lx + 2u)) {
                                covered += 1u;
                                break;
                            }
                        }
                    }
                }

                if (covered >= 4u) {
                    outputPixel[x + width * y] = ((255) | (0 << 8) | (0 << 16) | (255 << 24));
                } else if (covered > 0) {
                    outputPixel[x + width * y] = ((0) | (0 << 8) | (255 << 16) | (255 << 24));
                // outputPixel[x + width * y] = ((255) | (0 << 8) | (0 << 16) | ((covered * 63) << 24));
                }

            }
        }
    `;

    // 4. Create Shader Module
    const computeShaderModule = device.createShaderModule({
        code: computeShaderCode,
    });

    // 5. Create Bind Group Layout
    const bindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0, // Corresponds to @binding(0) in shader
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "read-only-storage" }, // inputData
            },
            {
                binding: 1, // Corresponds to @binding(1) in shader
                visibility: GPUShaderStage.COMPUTE,
                buffer: { type: "storage" }, // outputSum (read_write)
            },
        ],
    });

    // 6. Create Pipeline Layout
    const pipelineLayout = device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
    });

    // 7. Create Compute Pipeline
    const computePipeline = device.createComputePipeline({
        layout: pipelineLayout,
        compute: {
            module: computeShaderModule,
            entryPoint: "main",
        },
    });

    // 8. Create Bind Group (connect buffers to shader bindings)
    const bindGroup = device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: { buffer: inputBuffer },
            },
            {
                binding: 1,
                resource: { buffer: outputBuffer },
            },
        ],
    });

    // 9. Create Command Encoder and Dispatch Commands
    const commandEncoder = device.createCommandEncoder();

    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(computePipeline);
    passEncoder.setBindGroup(0, bindGroup);

    // Calculate the number of workgroups needed.
    // Each workgroup processes 64 elements.
    // If numElements is 16, and workgroup_size is 64, we need 1 workgroup.
    // (16 + 64 - 1) / 64 = 1
    const workgroupCount = WORK_GROUPS;
    passEncoder.dispatchWorkgroups(Math.ceil(width / 32));
    passEncoder.end();

    // Copy the result from the GPU-only outputBuffer to the CPU-readable stagingBuffer
    commandEncoder.copyBufferToBuffer(
        outputBuffer,
        0,
        stagingBuffer,
        0,
        outputByteSize
    );

    let tic = performance.now();

    // Finish encoding and submit commands to the GPU
    const commandBuffer = commandEncoder.finish();
    device.queue.submit([commandBuffer]);

    // 10. Read the result back from the staging buffer
    await stagingBuffer.mapAsync(GPUMapMode.READ);
    console.log('Time: ', performance.now() - tic);

    let result = new Uint8ClampedArray(stagingBuffer.getMappedRange());

    let imageData = new ImageData(result, width, height);

    ctx.putImageData(imageData, 0, 0);


    window.result = result;

    // Clean up
    inputBuffer.destroy();
    outputBuffer.destroy();
    stagingBuffer.destroy();
    device.destroy();
}

runComputeShaderExample();
