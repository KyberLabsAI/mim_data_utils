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

class GPUBufferHandler {
    constructor(buffer) {
        this.buffer = buffer;
        this.lastDataVersion = -1;
    }

    bindSync(gl, dataVersion, data) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

        if (this.lastDataVersion < dataVersion) {
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        }
        this.lastDataVersion = dataVersion;
    }
}

class GPUData {
    constructor(parent, data) {
        this.parent = parent;
        this.buffer = new Map();
        this.data = data;
    }

    bind(gl) {
        if (!this.buffer.has(gl)) {
            this.buffer.set(gl, new GPUBufferHandler(gl.createBuffer()));
        }

        this.buffer.get(gl).bindSync(gl, this.parent.dataVersion, this.data);
    }
}

// Holds the Float32 array with points, margin and color. Also holds the buffers.
class LineChunck {
    constructor(size) {
        this.points = 4 * size; // There are 4 entires per stored point.
        this.lineCenter = new Float32Array(2 * this.points);
        this.lineTangential = new Float32Array(2 * this.points);

        this.from = 0;
        this.to = 0;
        this.fromY = 0;
        this.toY = 0;
        this.lastPoint = null;
        this.dataVersion = 0;

        this.gpuLineCenter = new GPUData(this, this.lineCenter);
        this.gpuLineTangential = new GPUData(this, this.lineTangential);
    }

    getLineCenterY(i) {
        return this.lineCenter[2 * i + 1];
    }

    addVertex(x, y, tx, ty) {
        let to = this.to;
        this.lineCenter[2 * to + 0] = x;
        this.lineCenter[2 * to + 1] = y;
        this.lineTangential[2 * to + 0] = tx;
        this.lineTangential[2 * to + 1] = ty;

        this.to += 1;
    }

    appendPoint(x1, y1) {
        if (y1 < this.fromY) {
            this.fromY = y1;
        } else if (y1 > this.toY) {
            this.toY = y1;
        }

        if (this.lastPoint == null) {
            this.lastPoint = {x: x1, y: y1};
            return;
        }
        let x0 = this.lastPoint.x;
        let y0 = this.lastPoint.y;

        this.lastPoint.x = x1;
        this.lastPoint.y = y1;

        // The tangential directions with respect to the line from 0 to 1.
        let tx = -(y1 - y0);
        let ty = (x1 - x0);
        // 1         3
        //  +-------+
        //  |   /   |
        //  +-------+
        // 2         4

        let topBottom = true;

        // We always add 4 vertices for a new line segment. This makes the
        // corners draw nicely.
        this.addVertex(x0, y0, tx, ty);
        this.addVertex(x0, y0, -tx, -ty);
        this.addVertex(x1, y1, tx, ty);
        this.addVertex(x1, y1, -tx, -ty);

        this.dataVersion++;
    }

    shiftPoint() {
        this.from += 4;
        if (this.isEmpty()) {
            this.lastPoint = null;
        }
    }

    isEmpty() {
        return this.from == this.to;
    }

    capacity() {
        return this.points - this.to;
    }

    isFull() {
        return this.capacity() == 0;
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
        this.chunkSize = 32 * 512;
        this.clear();
    }

    _maxChunks() {
        // We support at least maxData entries. Adding an extra chunk. This way
        // when the chunks are full and the first one gets emptied, there is still
        // room for at least maxData entries.
        return Math.ceil(this.maxData / this.chunkSize) + 1;
    }

    clear() {
        this.chunks = [new LineChunck(this.chunkSize)]
    }

    findXIdx(x) {
        let chunks = this.chunks;

        let cIdx = binarySearch(0, this.chunks.length - 1, x, (idx) => {
            let chunk = chunks[idx];
            return chunk.lineCenter[2 * (chunk.to - 1)];
        });

        let chunk = chunks[cIdx];
        let pIdx = binarySearch(chunk.from, chunk.to - 1, x, (idx) => {
            return chunk.lineCenter[2 * idx];
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

    _findYLimPartialChunk(xIdx, pFrom, pTo, ylim) {
        let chunk = this.chunks[xIdx];
        for (let pIdx = pFrom; pIdx <= pTo; pIdx ++) {
            let y = chunk.getLineCenterY(pIdx);
            if (ylim === undefined) {
                ylim = [y, y];
            } else if (y < ylim[0]) {
                ylim[0] = y;
            } else if (y > ylim[1]) {
                ylim[1] = y;
            }
        }
        return ylim;
    }

    // Returns the yi of point i with xi = max x st xi < x.
    findYLim(xlimIndices, ylim) {
        let x0c = xlimIndices.from.chunkIdx;
        let x0p = xlimIndices.from.pointIdx;
        let x1c = xlimIndices.to.chunkIdx;
        let x1p = xlimIndices.to.pointIdx;

        // Look up the ylim in the middle from chunk limits.
        for (let cidx = x0c + 1; cidx < x1c; cidx++) {
            let chunk = this.chunks[cidx];
            if (ylim === undefined) {
                ylim = [chunk.fromY, chunk.toY];
            } else if (chunk.fromY < ylim[0]) {
                ylim[0] = chunk.fromY;
            } else if (chunk.toY > ylim[1]) {
                ylim[1] = chunk.toY;
            }
        }

        ylim = this._findYLimPartialChunk(x0c, x0p, this.chunks[x0c].to - 1, ylim);
        ylim = this._findYLimPartialChunk(x1c, 0, x1p, ylim);

        return ylim;
    }

    _addChunk() {
        let lastChunck = this.chunks.at(-1);
        let chunk = new LineChunck(this.chunkSize);
        chunk.lastPoint = lastChunck.lastPoint;
        this.chunks.push(chunk);
    }

    appendPoint(x, y) {
        if (this.chunks.at(-1).isFull()) {
            if (this.chunks.length >= this._maxChunks()) {
                this.chunks.shift();
            }
            this._addChunk();
        }

        this.chunks.at(-1).appendPoint(x, y);
    }
}

class GLLineDrawer {
    constructor(ctx) {
        this.ctx = ctx;
        this.setViewport(-1, 1, -1, 1)
        this.createGLProgram();
    }

    createGLProgram() {
        let gl = this.ctx.gl;
        const program = this.program = gl.createProgram();
        gl.attachShader(program, this.ctx.vertexShader);
        gl.attachShader(program, this.ctx.fragmentShader);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw gl.getProgramInfoLog(program);
        }
        gl.useProgram(program);

        this.offsetUniformLocation = gl.getUniformLocation(program, "u_offset");
        this.transformCenterUniformLocation = gl.getUniformLocation(program, "u_transformCenter");
        this.colorUniformLocation = gl.getUniformLocation(program, "u_color");
        this.zUniformLocation = gl.getUniformLocation(program, "u_z");
    }

    bindData(attributeName, gpuData, size) {
        const gl = this.ctx.gl;
        gpuData.bind(gl);

        const attribute = gl.getAttribLocation(this.program, attributeName);
        gl.enableVertexAttribArray(attribute);
        gl.vertexAttribPointer(attribute, size, gl.FLOAT, false, 0, 0);
    }

    clear() {
        let gl = this.ctx.gl;
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    drawLineChunk(lineChunk, style) {
        let gl = this.ctx.gl;
        let canvas = this.ctx.canvas;
        let program = this.program;
        gl.useProgram(program);

        this.bindData('lineCenter', lineChunk.gpuLineCenter, 2, );
        this.bindData('lineTangential', lineChunk.gpuLineTangential, 2);

        lineChunk.wasBuffered = true;

        gl.uniform2fv(this.offsetUniformLocation, [this.offsetX, this.offsetY])
        gl.uniform4fv(this.colorUniformLocation, [style.r, style.g, style.b, 1.])

        gl.uniformMatrix2fv(this.transformCenterUniformLocation, false, [
            this.zoomX, 0,
            0, this.zoomY
        ])

        gl.uniform1f(this.zUniformLocation, style.z);

        gl.drawArrays(gl.TRIANGLE_STRIP, lineChunk.from, lineChunk.to - lineChunk.from);
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
