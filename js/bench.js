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
    const data = new Float32Array(2 * width); // Using more data for better demonstration

    let fx = x => 125 * Math.sin(2 * Math.PI * x / 100) + 150


    for (let i = 0; i < width; i++) {
        data[2 * i] = height;
    }

    for (let i = 0; i < width; i++) {
        let yFrom = fx(i);
        let yTo = fx(i + 1);
        let yDiff = yFrom - yTo;

        let lineWidth = 6;
        let hlw = lineWidth / 2;

        let dy = yDiff;
        let dx = 1.;

        let vy = dx;
        let vx = -dy;

        let len = Math.sqrt(dx * dx + dy * dy);
        let ny = vy / len;
        let nx = vx / len;

        let startX = i + nx * hlw;
        let startY = yFrom + ny * hlw;

        let xIter = Math.ceil(startX);
        let yIter = startY + (i - startX) * yDiff;
        let height = Math.abs(yIter - yFrom);

        dx = Math.abs(i - xIter);

        for (let offset = -dx; offset <= -dx + 1; offset++) {
            let j = i + offset;
            let y = fx(j);
            data[2 * j] = Math.min(data[2 * j], y - height);
            data[2 * j + 1] = Math.max(y, data[2 * j + 1]);
        }
        // data[2 * ]

        ctx2.lineWidth = 6;
        ctx2.beginPath();
        ctx2.moveTo(i, yFrom);
        ctx2.lineTo(i + 1, yTo);
        ctx2.stroke()

    }

    ctx2.lineWidth = 6;
    ctx2.beginPath();
    ctx2.moveTo(10, 30);
    ctx2.lineTo(10, 60);
    ctx2.stroke()

    ctx2.lineWidth = 1;
    ctx2.beginPath();
    ctx2.moveTo(40, 60);
    ctx2.lineTo(10, 60);
    ctx2.stroke()

    const dataSize = data.byteLength;
    const numElements = data.length;


    // 2. Create GPU Buffers
    // Input buffer
    const inputBuffer = device.createBuffer({
        size: width * 2 * Float32Array.BYTES_PER_ELEMENT,
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
            let index = global_id.x; // We only care about the x-dimension for a 1D array
            let width = 800u;
            let height = 300u;

            if (index >= width) {
                return;
            }

            let size = arrayLength(&inputData);

            let initRatio = inputData[2 * index] % 1;
            let yFrom = u32(inputData[2 * index]);
            let yTo = u32(inputData[2 * index + 1]);

            var idx = (index + yFrom * width);

            let initAlpha = (1 - initRatio);
            let r = u32(initRatio * 255 + initAlpha * 255);
            let g = u32(initRatio * 255 + initAlpha * 0);
            let b = u32(initRatio * 255 + initAlpha * 0);
            let a = 255u;


            outputPixel[idx - width] = ((r << 24) | (g << 16) | (b << 8) | a);

            for (var y: u32 = yFrom; y <= yTo; y++) {
                outputPixel[idx] = ((255 << 24) | 255);

                idx += width;
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
