let canvas = document.getElementById('canvas');
let ctx = canvas.getContext("2d");

const offCanvas = new OffscreenCanvas(canvas.width, canvas.height);
const offCtx = offCanvas.getContext('2d');


p = new Path2D();

w = 800 * 4;
const N = w;
dt = 2 * Math.PI / N;
dx = w / N;

let x = 0;
let t = 0

let pxy = new Float32Array(2 * N);

function fillPath(p, pxy) {
    for (let i = 0; i < 2*N; i += 2) {
        p.lineTo(pxy[i], pxy[i + 1]);
    }
}

function stroke(ctx, p) {
    ctx.lineWidth = 4;
    ctx.stroke(p);
}

function fillData(pxy) {
    for (let i = 0; i < N; i++) {
        pxy[2 * i] = Math.round(x);
        if (i % 2 == 0) {
            pxy[2 * i + 1] = 0;
        } else {
            pxy[2 * i + 1] = 300 * 4
        }
        // pxy[2 * i + 1] = 150 * 2 + 2 * 150 * Math.sin(t);
        x += dx;
        t += dt;
    }
}

function paint() {
    p.moveTo(0, 150 * 4);

    fillData(pxy);
    fillPath(p, pxy);
    stroke(offCtx, p);

    let imData = offCtx.getImageData(0, 0, 10, 10);
    ctx.putImageData(imData, 0, 0);
}

r = 200
setTimeout(() => {
    paint();
}, r)

// setTimeout(() => {
//     paint();
// }, r + 1)
