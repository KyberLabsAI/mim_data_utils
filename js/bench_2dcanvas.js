const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Set line properties
ctx.strokeStyle = 'blue'; // Line color
ctx.lineWidth = 3;      // Line width

function draw() {
    for (let x = 0; x < 800; x++) {
        // Begin drawing the path
        ctx.beginPath();
        // Move to the starting point
        ctx.moveTo(x, 0);
        // Draw a line to the ending point
        ctx.lineTo(x, 300);
        // Render the line
        ctx.stroke();
    }

    ctx.getImageData(0, 0, 800, 300)
}

let tic = performance.now();

for (let i = 0; i < 1000; i++) {
    draw()
}

console.log(performance.now() - tic)


