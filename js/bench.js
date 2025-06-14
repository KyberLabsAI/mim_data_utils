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
    let points = 800;
    const data = new Float32Array(4 * points); // Using more data for better demonstration

    let fx = x => 125 * Math.sin(2 * Math.PI * x / 100) + 150

    for (let i = 0; i < width; i++) {
        data[4 * i] = i;
        data[4 * i + 1] = fx(i);
        data[4 * i + 2] = i + 1;
        data[4 * i + 3] = fx(i + 1);
    }

    // data[0] = 10
    // data[1] = 10
    // data[2] = 60
    // data[3] = 70


    ctx2.lineWidth = 6;
    ctx2.beginPath();
    ctx2.moveTo(data[0], data[1]);
    ctx2.lineTo(data[2], data[3]);
    ctx2.stroke()

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
            let radius = 3.;
            let squareRadius = radius * radius;
            let antiAliasingRange = 0.7;

            let x = global_id.x / 2; // We only care about the x-dimension for a 1D array

            if (x >= width) {
                return;
            }

            for (var y: u32 = 0; y < height / 2; y++) {
                let P = vec2f(f32(x), f32(y));

                let A = vec2f(2., 3.);
                let B = vec2f(5., 6.);
                let v = B - A;
                let v2 = dot(v, v);
                var rgba = vec4u(0, 0, 0, 0);

                for (var i: u32 = 0; i < 350; i++) {
                    let dxy = vec2f(f32(i), f32(y));

                    let t = 2 + dot(dxy, v) / v2;

                    let t_out = f32(t >= 0 && t <= 1);

                    let P_closest = A + t * v;
                    let dist = length(P - P_closest);

                    let d_out = f32(dist <= 800.);

                    if (t_out * d_out == 1) {
                        rgba.w = 255;
                    }
                }

                outputPixel[x + width * y] = ((rgba.x << 24) | (rgba.y << 16) | (rgba.z << 8) | rgba.w);
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
    passEncoder.dispatchWorkgroups(2 * Math.ceil(width / 32));
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
