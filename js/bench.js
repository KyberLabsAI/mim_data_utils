let canvas = document.getElementById('canvas');

drawer = new GLDrawer(canvas);

const N = 5;
let linesCenter = new Float32Array(2 * N);

let x = -1;
let dx = 2 / N;

for (let i = 0; i < N; i++) {
    linesCenter[2 * i] = x;
    linesCenter[2 * i + 1] = Math.sin(2 * Math.PI * x);
    x += dx;
}


class LineRenderer {
    constructor() {
        this.dataVersion = 0;
        this.gpuLineCenter = new GPUData(this, linesCenter);
    }
}



class GLLineStripDrawer {
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

        gl.uniform4fv(this.colorUniformLocation, [style.r, style.g, style.b, 1.])
        gl.uniform1f(this.zUniformLocation, style.z);

        gl.drawArrays(gl.LINE_STRIP , lineChunk.from, lineChunk.to - lineChunk.from);
    }

    updateSize(width, height) {
        this.setViewport.apply(this, this.viewport);
    }
}

let gl = drawer.gl;
console.log(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE));
