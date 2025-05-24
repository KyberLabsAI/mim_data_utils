class Plot {
    constructor(domParent, eventCallback) {
        this.domParent = domParent;
        eventCallback = eventCallback.bind(this);

        let dom = this.dom = document.createElement('div');
        domParent.appendChild(dom);

        let canvasGrid = this.canvasGrid = document.createElement('canvas');
        let canvasLine = this.canvasLine = document.createElement('canvas');
        let canvasAxes = this.canvasAxes = document.createElement('canvas');
        let legend = this.legend = document.createElement('span');

        this.updateCanvasStyle(domParent.clientWidth, 300);

        legend.setAttribute('class', 'legend');

        dom.appendChild(canvasGrid);
        dom.appendChild(canvasLine);
        dom.appendChild(canvasAxes);
        dom.append(legend);

        this.margin = [10, 20, 10, 20];

        this.glDrawer = new GLDrawer(canvasLine, this.margin);
        this.lineDrawer = new GLLineDrawer(this.glDrawer.ctx);
        this.axesDrawer = new AxesDrawer(canvasAxes, canvasGrid, this.margin, eventCallback);

        this.lines = [];
    }

    updateCanvasStyle(width, height) {
        let dom = this.dom;
        this.width = width;
        this.height = height;
        let style = `width:${width}px;height:${height}px;position:absolute`;

        let setStyle = (canvas, width, height) => {
            canvas.setAttribute('width', width);
            canvas.setAttribute('height', height);
            canvas.setAttribute('style', style);
        }

        setStyle(this.canvasGrid, 4 * width, 4 * height);
        setStyle(this.canvasLine, width, height);
        setStyle(this.canvasAxes, 4 * width, 4 * height);

        dom.style.position = 'relative';
        dom.style.width = `${width}px`;
        dom.style.height = `${height}px`;
    }

    updateSize(width, height) {
        if (this.width == width && this.height == height) {
            return; // Only update if size changed.
        }

        this.updateCanvasStyle(width, height);
        this.glDrawer.updateSize(width, height);
        this.lineDrawer.updateSize(width, height);
        this.axesDrawer.updateSize(width, height);
    }

    remove() {
        // Remove the event listeners from the doms.
        this.canvasLine.remove();
        this.canvasAxes.remove();
        this.legend.remove();
        this.dom.remove();
    }

    clear() {
        this.lines = [];
        this.legend.textContent = '';
    }

    addLine(name, idx, lineData, style) {
        let label = `${name}[${idx}]`
        this.lines.push({
            dataName: name,
            dataIdx: idx,
            label: label,
            lineData: lineData,
            style: style
        });

        this.legend.textContent = '';
        this.lines.forEach(line => {
            let style = line.style;
            let legendDiv = document.createElement('div');
            legendDiv.textContent = line.label;
            let borderColor = `rgb(${style.r * 256}, ${style.g * 256}, ${style.b * 256})`;
            legendDiv.style = `border-color: ${borderColor}`
            this.legend.appendChild(legendDiv);
        });
    }

    setViewport(xl, yl, xh, yh) {
        this.axesDrawer.setViewport(xl, yl, xh, yh);
        this.lineDrawer.setViewport(xl, yl, xh, yh);
    }

    updateLegendValues(time) {
        let entries = Array.from(this.legend.childNodes);

        this.lines.forEach((line, i) => {
            let data = traces.dataAtTime(line.dataName, time);
            let label = line.label;

            // In case the user clicked outside of available data.
            if (data) {
                label += ': ' + data[line.dataIdx].toFixed(3);
            }
            entries[i].textContent = label;
        })
    }

    draw(time, xlim, refreshPlots, axesOnly) {
        this.axesDrawer.draw([new VerticalLine(time, 'orange')]);

        this.updateLegendValues(time);

        if (axesOnly) {
            return
        }

        let updated = 0;
        if (refreshPlots) {
            if (this.lines.length == 0) {
                this.lineDrawer.clear();
            } else {
                this.lines.toReversed().forEach(line => {
                    let lineData = traces.getLineData(line.dataName, line.dataIdx);
                    let xlimIndices = lineData.findXLimIndices(xlim);
                    let chunks = lineData.chunks;
                    for (let idx = xlimIndices.from.chunkIdx; idx <= xlimIndices.to.chunkIdx; idx++) {
                        updated += this.lineDrawer.drawLineChunk(chunks[idx], line.style)
                    }
                });
            }
        }
    }
}
