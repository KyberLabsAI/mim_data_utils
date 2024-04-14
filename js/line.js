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

// Holds the Float32 array with points, margin and color. Also holds the buffers.
class LineChunck {
    constructor() {
        this.points = 512;
        this.lineCenter = new Float32Array(2 * this.points);
        this.lineTangential = new Float32Array(2 * this.points);

        this.from = 0;
        this.to = 0;
        this.lastPoint = null;
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
    constructor() {
        this.chuncks = []
    }

    clear() {
        this.chuncks = []
    }

    findXIdx(x) {
        let chuncks = this.chuncks;

        let cIdx = binarySearch(0, this.chuncks.length - 1, x, (idx) => {
            let chunck = chuncks[idx];
            return chunck.lineCenter[2 * (chunck.to - 1)];
        });

        let chunck = chuncks[cIdx];
        let pIdx = binarySearch(chunck.from, chunck.to - 1, x, (idx) => {
            return chunck.lineCenter[2 * idx];
        });

        return {
            chunckIdx: cIdx,
            pointIdx: pIdx
        };
    }

    findXLimIndices(xlim) {
        return {
            from: this.findXIdx(xlim[0]),
            to: this.findXIdx(xlim[1]),
        }
    }

    // Returns the yi of point i with xi = max x st xi < x.
    findYLim(xlimIndices, ylim) {
        let x0c = xlimIndices.from.chunckIdx;
        let x0p = xlimIndices.from.pointIdx;
        let x1c = xlimIndices.to.chunckIdx;
        let x1p = xlimIndices.to.pointIdx;

        for (let xIdx = x0c; xIdx <= x1c; xIdx++) {
            let chunck = this.chuncks[xIdx];

            let pFrom = 0;
            let pTo = 0;
            if (xIdx == x0c) {
                pFrom = x0p;
            } else {
                pFrom = chunck.from;
            }

            if (xIdx == x1c) {
                pTo = x1p;
            } else {
                pTo = chunck.to - 1;
            }

            for (let pIdx = pFrom; pIdx <= pTo; pIdx ++) {
                let y = chunck.getLineCenterY(pIdx);
                if (ylim === undefined) {
                    ylim = [y, y];
                } else if (y < ylim[0]) {
                    ylim[0] = y;
                } else if (y > ylim[1]) {
                    ylim[1] = y;
                }
            }
        }

        return ylim;
    }

    appendPoint(x, y) {
        let chunck = this.chuncks.at(-1)
        if (!chunck || chunck.capacity() == 0) {
            let lastPoint = (chunck && chunck.lastPoint) || null;
            chunck = new LineChunck();
            chunck.lastPoint = lastPoint;
            this.chuncks.push(chunck);
        }
        chunck.appendPoint(x, y);
    }

    shiftPoint() {
        let chunck = this.chuncks[0];
        chunck.shiftPoint();

        if (chunck.isEmpty() && chunck.capacity() == 0) {
            this.chuncks.shift();
        }
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

        this.bufferLineCenterData = gl.createBuffer();
        this.bufferLineTangential = gl.createBuffer();
    }

    bindData(attribute, buffer, dataArray, size) {
        const gl = this.ctx.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, dataArray, gl.STATIC_DRAW);

        const attributeLineCenter = gl.getAttribLocation(this.program, attribute);
        gl.enableVertexAttribArray(attributeLineCenter);
        gl.vertexAttribPointer(attributeLineCenter, size, gl.FLOAT, false, 0, 0);
    }

    clear() {
        let gl = this.ctx.gl;
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    drawLineChunck(lineChunck, style) {
        let gl = this.ctx.gl;
        let canvas = this.ctx.canvas;
        let program = this.program;
        gl.useProgram(program);

        this.bindData('lineCenter', this.bufferLineCenterData, lineChunck.lineCenter, 2);
        this.bindData('lineTangential', this.bufferLineTangential, lineChunck.lineTangential, 2);

        gl.uniform2fv(this.offsetUniformLocation, [this.offsetX, this.offsetY])
        gl.uniform4fv(this.colorUniformLocation, [style.r, style.g, style.b, 1.])

        gl.uniformMatrix2fv(this.transformCenterUniformLocation, false, [
            this.zoomX, 0,
            0, this.zoomY
        ])

        gl.uniform1f(this.zUniformLocation, style.z);

        gl.drawArrays(gl.TRIANGLE_STRIP, lineChunck.from, lineChunck.to - lineChunck.from);
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
