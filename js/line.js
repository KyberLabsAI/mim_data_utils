let GL_ARRAY_BUFFER = 34962;



class GLDrawer {
    constructor(canvas, margin) {
        this.canvas = canvas;
        this.setupGL();

        this.ctx = {
            canvas: this.canvas,
            gl: this.gl,
            vertexShader: this.vertexShader,
            fragmentShader: this.fragmentShader,
            margin: margin
        };
    }

    setupGL() {
        let canvas = this.canvas;

        const vertexCode = document.getElementById("vertex").textContent;
        const fragmentCode = document.getElementById("fragment").textContent;

        let gl = canvas.getContext("webgl2");
        if (!gl) throw "WebGL2 not supported";

        gl.viewport(0, 0, canvas.width, canvas.height);

        gl.enable(gl.DEPTH_TEST);

        const vertexShader = gl.createShader(gl.VERTEX_SHADER);
        gl.shaderSource(vertexShader, vertexCode.trim());
        gl.compileShader(vertexShader);
        if (!gl.getShaderParameter(vertexShader, gl.COMPILE_STATUS)) {
            throw gl.getShaderInfoLog(vertexShader);
        }

        const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        gl.shaderSource(fragmentShader, fragmentCode.trim());
        gl.compileShader(fragmentShader);
        if (!gl.getShaderParameter(fragmentShader, gl.COMPILE_STATUS)) {
            throw gl.getShaderInfoLog(fragmentShader);
        }

        this.gl = gl;
        this.vertexShader = vertexShader;
        this.fragmentShader = fragmentShader;
    }

    updateSize(width, height) {
        this.ctx.gl.viewport(0, 0, width, height);
    }
}

/**
 * The one WebGL2 context every plot draws its lines with. Browsers allow only
 * a handful of live WebGL contexts (~16 in Chrome) and drop the oldest beyond
 * that, so a context per plot made plots go blank on big layouts. Each plot
 * draws into this offscreen canvas and copies the result into its own 2D
 * canvas (Plot.draw). One context also means one GPU copy of a line shown in
 * several plots.
 */
class SharedLineGL {
    constructor() {
        this.canvas = document.createElement('canvas');
        this.canvas.addEventListener('webglcontextlost', e => e.preventDefault());
        this.drawer = new GLDrawer(this.canvas, [0, 0, 0, 0]);
        this.gl = this.drawer.gl;
    }

    /** Sizes the drawing buffer to `width` x `height` and clears it. */
    begin(width, height) {
        const gl = this.gl;
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        // Depth too: plots are drawn one after the other into the same buffer.
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    }
}

let _sharedLineGL = null;

/** The shared context, recreated if the GPU dropped it (driver reset). */
function sharedLineGL() {
    if (_sharedLineGL === null || _sharedLineGL.gl.isContextLost()) {
        _sharedLineGL = new SharedLineGL();
    }
    return _sharedLineGL;
}

class GPUBufferHandler {
    constructor(gl, buffer, array_type, to_rel_entries) {
        this.gl = gl;
        this.buffer = buffer;
        this.array_type = array_type;
        this.to_rel_entries = to_rel_entries;
        this.lastDataVersion = -1;
        this.lastTo = -1;
    }

    bindSync(gl, dataVersion, to, data) {
        let res = 0;
        gl.bindBuffer(this.array_type, this.buffer);

        if (this.lastTo == -1) {
            gl.bufferData(this.array_type, data, gl.DYNAMIC_DRAW);
            res = 1;
        } else if (this.lastDataVersion < dataVersion) {
            let byteLen = 4;
            if (data instanceof Uint16Array) {
                byteLen = 2;
            }
            let entryFrom = this.to_rel_entries * this.lastTo;
            let entryTo = this.to_rel_entries * to;
            gl.bufferSubData(this.array_type, entryFrom * byteLen, data, entryFrom, entryTo - entryFrom);
        }
        this.lastTo = to;
        this.lastDataVersion = dataVersion;

        return res;
    }

    release() {
        if (!this.gl.isContextLost()) {
            this.gl.deleteBuffer(this.buffer);
        }
        this.buffer = null;
    }
}

class GPUData {
    constructor(parent, data, array_type, to_rel_entries) {
        this.parent = parent;
        this.buffer = new Map();
        this.data = data;
        this.array_type = array_type;
        this.to_rel_entries = to_rel_entries;
    }

    bind(gl) {
        if (!this.buffer.has(gl)) {
            this.buffer.set(gl, new GPUBufferHandler(gl, gl.createBuffer(), this.array_type, this.to_rel_entries));
        }

        let res = this.buffer.get(gl).bindSync(gl, this.parent.dataVersion, this.parent.to, this.data);
        return res;
    }

    /** Deletes the GPU copies in every context. */
    release() {
        this.buffer.forEach(handler => handler.release());
        this.buffer.clear();
    }

    /** Drops the GPU copies of contexts that are gone (removed plots). */
    pruneLostContexts() {
        for (const [gl, handler] of this.buffer) {
            if (gl.isContextLost()) {
                this.buffer.delete(gl);
            }
        }
    }
}

// The points of one piece of a line: x (relative to LineData.timeOffset), y
// as float32, 8 bytes per point. Drawn as one instanced quad per segment
// (points i, i+1), built in the vertex shader -- no per-vertex copies.
class LineChunck {
    constructor(size) {
        this.size = size;
        this.points = new Float32Array(2 * size);
        // Number of points; the GPU sync and the draw call use it as `to`.
        this.to = 0;
        this.dataVersion = 0;

        this.gpuPoints = new GPUData(this, this.points, GL_ARRAY_BUFFER, 2);
    }

    appendPoint(x, y) {
        this.points[2 * this.to] = x;
        this.points[2 * this.to + 1] = y;
        this.to += 1;
        this.dataVersion++;
    }

    lastX() {
        return this.points[2 * (this.to - 1)];
    }

    isEmpty() {
        return this.to == 0;
    }

    capacity() {
        return this.size - this.to;
    }

    isFull() {
        return this.capacity() == 0;
    }

    release() {
        this.gpuPoints.release();
    }
}

let binarySearch = (min, max, x, valFn) => {
    while (max - min > 1) {
        let mid = Math.floor(min + (max - min) / 2);
        let val = valFn(mid);
        if (x < val) {
            max = mid;
        } else {
            min = mid;
        }
    }
    return x > valFn(min) ? max : min;
}

class LineData {
    constructor(maxData) {
        this.maxData = maxData;
        this.chunkSize = 16 * 512;
        this.clear();
    }

    _maxChunks() {
        // We support at least maxData entries. Adding an extra chunk. This way
        // when the chunks are full and the first one gets emptied, there is still
        // room for at least maxData entries.
        return Math.ceil(this.maxData / this.chunkSize) + 1;
    }

    clear() {
        if (this.chunks) {
            this.release();
        }
        this.chunks = [new LineChunck(this.chunkSize)]
        this.timeOffset = 0;
    }

    /** Deletes the GPU buffers of all chunks (the CPU side goes with GC). */
    release() {
        this.chunks.forEach(chunk => chunk.release());
    }

    pruneLostContexts() {
        this.chunks.forEach(chunk => chunk.gpuPoints.pruneLostContexts());
    }

    memoryBytes() {
        return this.chunks.reduce((a, chunk) => a + chunk.points.byteLength, 0);
    }

    findXIdx(x) {
        let chunks = this.chunks;
        let xRel = x - this.timeOffset;

        let cIdx = binarySearch(0, this.chunks.length - 1, xRel, (idx) => {
            let chunk = chunks[idx];
            return chunk.isEmpty() ? -Infinity : chunk.lastX();
        });

        let chunk = chunks[cIdx];
        let pIdx = binarySearch(0, Math.max(chunk.to - 1, 0), xRel, (idx) => {
            return chunk.points[2 * idx];
        });

        return {
            chunkIdx: cIdx,
            pointIdx: pIdx
        };
    }

    findXLimIndices(xlim) {
        return {
            from: this.findXIdx(xlim[0]),
            to: this.findXIdx(xlim[1]),
        }
    }

    _addChunk() {
        let lastChunck = this.chunks.at(-1);
        let chunk = new LineChunck(this.chunkSize);
        // Start with the previous chunk's last point, so the segment joining
        // the two chunks is drawn.
        if (!lastChunck.isEmpty()) {
            chunk.appendPoint(lastChunck.points[2 * (lastChunck.to - 1)],
                              lastChunck.points[2 * (lastChunck.to - 1) + 1]);
        }
        this.chunks.push(chunk);
    }

    appendPoint(x, y) {
        if (this.chunks.at(-1).isFull()) {
            if (this.chunks.length >= this._maxChunks()) {
                this.chunks.shift().release();
            }
            this._addChunk();
        }

        if (this.timeOffset === 0 && x !== 0) {
            this.timeOffset = x;
        }

        this.chunks.at(-1).appendPoint(x - this.timeOffset, y);
    }
}

class GLLineDrawer {
    /**
     * ctx: {canvas, margin} of the plot; the canvas only gives the plot's
     * size. The GL work goes to the shared context (sharedLineGL()).
     */
    constructor(ctx) {
        this.ctx = ctx;
        this.setViewport(-1, 1, -1, 1)
        this.gl = null;
    }

    /** The shared context, with this drawer's program (re)built for it. */
    _gl() {
        const shared = sharedLineGL();
        if (this.gl !== shared.gl) {
            this.gl = shared.gl;
            this.createGLProgram(shared.drawer);
        }
        return this.gl;
    }

    createGLProgram(drawer) {
        let gl = this.gl;
        const program = this.program = gl.createProgram();
        gl.attachShader(program, drawer.vertexShader);
        gl.attachShader(program, drawer.fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw gl.getProgramInfoLog(program);
        }
        gl.useProgram(program);

        this.offsetUniformLocation = gl.getUniformLocation(program, "u_offset");
        this.transformCenterUniformLocation = gl.getUniformLocation(program, "u_transformCenter");
        this.colorUniformLocation = gl.getUniformLocation(program, "u_color");
        this.zUniformLocation = gl.getUniformLocation(program, "u_z");
        this.viewport2pixelUniformLocation = gl.getUniformLocation(program, "u_viewport2pixel");
        this.aspectCorrectionUniformLocation = gl.getUniformLocation(program, "u_aspectCorrection");
    }

    bindData(gpuData) {
        return gpuData.bind(this.gl);
    }

    /** Binds a chunk's point buffer as the two per-instance attributes p0
     * (point i) and p1 (point i + 1). */
    bindPointAttributes(gpuData) {
        const gl = this.gl;

        let updated = this.bindData(gpuData);
        [['p0', 0], ['p1', 8]].forEach(([name, offset]) => {
            const attribute = gl.getAttribLocation(this.program, name);
            gl.enableVertexAttribArray(attribute);
            gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 8, offset);
            gl.vertexAttribDivisor(attribute, 1);
        });

        return updated;
    }

    drawLineChunk(lineChunk, style) {
        let gl = this._gl();
        let canvas = this.ctx.canvas;
        let program = this.program;
        gl.useProgram(program);

        if (lineChunk.to < 2) {
            return 0;               // no segment yet
        }
        let updated = this.bindPointAttributes(lineChunk.gpuPoints);

        lineChunk.wasBuffered = true;

        gl.uniform2fv(this.offsetUniformLocation, [this.offsetX, this.offsetY])
        gl.uniform4fv(this.colorUniformLocation, [style.r, style.g, style.b, 1.])

        gl.uniformMatrix2fv(this.transformCenterUniformLocation, false, [
            this.zoomX, 0,
            0, this.zoomY
        ])

        // Set viewport2pixel matrix based on canvas dimensions
        // Converts from viewport coordinates (-1 to 1) to pixel coordinates
        gl.uniformMatrix2fv(this.viewport2pixelUniformLocation, false, [
            canvas.width / 2, 0,
            0, canvas.height / 2
        ])

        // Set aspect ratio correction for line thickness
        // Compensates for non-square canvas (e.g., 1200px × 300px = 0.25)
        let aspectCorrection = canvas.height / canvas.width;
        gl.uniform1f(this.aspectCorrectionUniformLocation, aspectCorrection);

        gl.uniform1f(this.zUniformLocation, style.z);

        // One instance per segment, 4 strip vertices each (see the vertex shader).
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, lineChunk.to - 1);

        return updated;
    }

    setViewport(xl, yl, xh, yh) {
        this.viewport = [xl, yl, xh, yh];

        // Adjust for the margin. The margin is in view pixel space.
        let width = this.ctx.canvas.width;
        let height = this.ctx.canvas.height;
        let margin = this.ctx.margin;

        let widthMinusMargin = width - margin[1] - margin[3];
        let heightMinusMargin = height - margin[0] - margin[2];

        this.xs = (xh - xl) * (width / widthMinusMargin);
        this.ys = (yh - yl) * (height / heightMinusMargin);

        // Need to find how much margin[0] is in xl-xh space.
        // One pixel is this.xs / widthMinusMargin
        let shiftX = (xh - xl) / widthMinusMargin * margin[3];
        let shiftY = (yh - yl) / heightMinusMargin * margin[2];

        this.zoomX = 2 / this.xs;
        this.zoomY = 2 / this.ys;
        this.offsetX = -xl + shiftX  - 1 / this.zoomX;
        this.offsetY = -yl + shiftY - 1 / this.zoomY;
    }

    updateSize(width, height) {
        this.setViewport.apply(this, this.viewport);
    }
}
