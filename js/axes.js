class TickDrawer {
    constructor(tickPixels, drawSize, drawOffset, xAxis, drawTickFn) {
        this.tickPixels = tickPixels;
        this.drawSize = drawSize;
        this.drawOffset = drawOffset;

        this.xAxis = xAxis;
        this.drawTickFn = drawTickFn;
        this.drawnTicks = new Map();
    }


    setSize(size) {
        this.drawSize = size;
    }

    draw(from, to) {
        this.from = from;
        this.to = to;
        let ticks = this.drawSize / this.tickPixels;
        let size = to - from;

        let tickSizeContinous = size / ticks;
        let tickSize10 = Math.floor(Math.log10(tickSizeContinous));
        let tickSizeLeadContinous = tickSizeContinous / Math.pow(10, tickSize10);

        let tickStepSize = 0;
        let tickSizeLeads = [1, 2, 5, 10];
        for (let i = 0; i < tickSizeLeads.length; i++) {
            if (tickSizeLeadContinous < tickSizeLeads[i + 1]) {
                tickStepSize = tickSizeLeads[i] * Math.pow(10, tickSize10);
                break;
            }
        }

        this.tickSize10 = tickSize10;

        let tickMin = from - (from % tickStepSize);
        let tickMax = to - (to % tickStepSize);

        this.drawnTicks.clear();
        for (let tick = tickMin; tick <= tickMax + tickStepSize / 2; tick += tickStepSize) {
            this.drawTick(tick, true, 0);
        }
    }

    getTickText(tick, precision) {
        return tick.toFixed(-Math.min(-precision, this.tickSize10 - precision));
    }

    drawTick(tick, drawText, precision) {
        let pos = this.tickToPos(tick);
        this.drawTickFn(this.getTickText(tick, precision), pos, drawText);
        this.drawnTicks.set(tick, pos);
    }

    tickToPos(tick) {
        return (
            this.drawOffset + this.drawSize / (this.to - this.from) *
            (this.xAxis ? tick - this.from : this.to - tick)
        );
    }

    clientToTick(clientPos) {
        clientPos -= this.drawOffset
        let scale = this.drawSize / (this.to - this.from);

        if (this.xAxis) {
            clientPos += this.from * scale;
            return clientPos / scale;
        } else {
            clientPos -= this.to * scale;
            return -clientPos / scale;
        }
    }

    clientToTickText(clientPos) {
        return this.getTickText(this.clientToTick(clientPos), 3);
    }
}

class VerticalLine {
    constructor(x, style, label) {
        this.x = x;
        this.style = style;
        this.label = label;
    }
}

class AxesDrawer {
    constructor(canvas, canvasGrid, margin, devicePixelRatio, eventCallback) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d");
        this.canvasGrid = canvasGrid;
        this.ctxGrid = canvasGrid.getContext("2d");
        this.devicePixelRatio = devicePixelRatio;

        this.margin = margin;

        this.tickDrawerX = new TickDrawer(
            200, 100, this.margin[3], true, this.drawTickX.bind(this));
        this.tickDrawerY = new TickDrawer(
            100, 100, this.margin[0], false, this.drawTickY.bind(this));

        this.updateSize();

        this.mouseX = 0;
        this.mouseY = 0;

        // TODO: The mouse handling should be on the outer view controller
        // higher up to sync the mouse position with other plots as well.
        let self = this;
        let forwardEvent = (name, forwarded) => {
            canvas.addEventListener(name, (evt) => eventCallback(forwarded, evt));
        }

        ['mousemove', 'mousedown', 'mouseup', 'dblclick', 'click'].forEach(name => {
            forwardEvent(name, 'AxesDrawer::' + name);
        });
    }

    strokeLine(x0, y0, x1, y1, ctx) {
        ctx = ctx || this.ctx;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
    }

    drawTickX(val, pos, drawText) {
        let y = this.axisHeight + this.margin[0];
        this.strokeLine(pos, y - 20, pos, y + 0);
        this.strokeLine(pos, this.margin[0], pos, y, this.ctxGrid);

        if (drawText) {
            this.ctx.fillText(val, pos + 3, y - 8);
        }
    }

    drawTickY(val, y, drawText) {
        this.strokeLine(this.margin[3] - 10, y, this.margin[3] + 10, y);
        this.strokeLine(this.margin[3], y, this.margin[0] + this.axisWidth, y, this.ctxGrid);

        if (drawText) {
            this.ctx.fillText(val, this.margin[3] + 3, y - 3);
        }
    }

    setViewport(x0, y0, x1, y1) {
        this.xFrom = x0;
        this.yFrom = y0;
        this.xTo = x1;
        this.yTo = y1;
    }

    draw(verticalLines) {
        let ctx = this.ctx;
        let ctxGrid = this.ctxGrid;
        let canvas = this.canvas;
        let canvasGrid = this.canvasGrid;
        let margin = this.margin;

        let setupCanvas = (canvas, ctx) => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            ctx.save();
            ctx.translate(0.5, 0.5);
            ctx.scale(this.devicePixelRatio, this.devicePixelRatio);
        }

        setupCanvas(canvas, ctx);
        setupCanvas(canvasGrid, ctxGrid);

        this.strokeLine(margin[3], margin[0] + this.axisHeight, margin[3], margin[0]);

        this.tickDrawerX.draw(this.xFrom, this.xTo);
        this.tickDrawerY.draw(this.yFrom, this.yTo);

        // Draw the zero throughpassing.
        if (this.tickDrawerX.drawnTicks.has(0)) {
            let pos0 = this.tickDrawerX.drawnTicks.get(0);
            this.strokeLine(pos0, 3, pos0, canvas.clientHeight- 3);
        }

        if (this.tickDrawerY.drawnTicks.has(0)) {
            let pos0 = this.tickDrawerY.drawnTicks.get(0);
            this.strokeLine(margin[3], pos0, this.axisWidth + margin[0], pos0);
        }

        // Draw the mouse layer.
        let valX = this.tickDrawerX.clientToTickText(this.mouseX);
        let valY = this.tickDrawerY.clientToTickText(this.mouseY);

        this.strokeLine(this.mouseX, margin[0] + this.axisHeight, this.mouseX, margin[0]);
        this.strokeLine(margin[3], this.mouseY, margin[0] + this.axisWidth, this.mouseY);

        // Draw user vertical lines.
        for (let line of verticalLines) {
            let pos = this.tickDrawerX.tickToPos(line.x);
            ctx.save();
            ctx.strokeStyle = line.style;
            ctx.fillStyle = line.style;
            this.strokeLine(pos, margin[0] + this.axisHeight, pos, margin[0]);

            let text = line.label || `(${line.x.toFixed(3)})`;
            let textWidth = ctx.measureText(text).width;

            let y = margin[0] + this.axisHeight - 8;

            ctx.fillStyle = 'white';
            ctx.fillRect(pos + 5, y, textWidth, 18);

            ctx.fillStyle = line.style;
            ctx.fillText(text, pos + 5, y + 14);
            ctx.restore();
        }

        // Mouse axes label.
        ctx.fillText(`(${valX}, ${valY})`, this.mouseX + 5, this.mouseY - 5)

        ctx.restore();
        ctxGrid.restore();
    }

    clientXToTick(x) {
        return this.tickDrawerX.clientToTick(x);
    }

    setViewportDraw(x0, y0, x1, y1) {
        this.setViewport(x0, y0, x1, y1);
        this.draw();
    }

    updateSize(width, height) {
        this.ctx.font = "12px Helvetica";
        this.ctxGrid.strokeStyle = 'rgb(196, 196, 196)';

        let canvas = this.canvas;
        this.axisWidth = canvas.clientWidth - this.margin[1] - this.margin[3];
        this.axisHeight = canvas.clientHeight - this.margin[0] - this.margin[2];

        this.tickDrawerX.setSize(this.axisWidth);
        this.tickDrawerY.setSize(this.axisHeight);
    }
}
