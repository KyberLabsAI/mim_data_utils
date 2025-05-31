class Plot {
    constructor(domParent, eventCallback) {
        this.domParent = domParent;
        eventCallback = eventCallback.bind(this);

        let dom = this.dom = document.createElement('div');
        domParent.appendChild(dom);

        this.devicePixelRatio = window.devicePixelRatio;

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

        this.margin = [-10, 20, -5, 20];

        this.glDrawer = new GLDrawer(canvasLine, this.margin);
        this.lineDrawer = new GLLineDrawer(this.glDrawer.ctx);
        this.axesDrawer = new AxesDrawer(canvasAxes, canvasGrid, this.margin, this.devicePixelRatio, eventCallback);

        this.lines = [];
        this.lastVLines = '';
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

        let ratio = this.devicePixelRatio;
        setStyle(this.canvasGrid, ratio * width, ratio * height);
        setStyle(this.canvasLine, width, height);
        setStyle(this.canvasAxes, ratio * width, ratio * height);

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
    }

    setViewport(xl, yl, xh, yh) {
        this.axesDrawer.setViewport(xl, yl, xh, yh);
        this.lineDrawer.setViewport(xl, yl, xh, yh);
    }

    updateLegendValues(vLines) {
        // Only redraw when vLines has changed.
        let json = JSON.stringify(vLines);
        if (json == this.lastVLines && this.legend.innerHTML !== '') {
            return;
        }
        this.lastVLines = json;


        let out = '<table><tr><th></th>'
        vLines.forEach(line => {
            out += `<th>${line.label || ''}</th>`;
        })

        out += '</tr><tr><td>Time:</td>';

        vLines.forEach(vLine => {
            out += `<td>${vLine.x.toFixed(3)}</td>`
        });

        out += '</tr>'

        this.lines.forEach((line, i) => {
            let borderColor = `rgb(${line.style.r * 256}, ${line.style.g * 256}, ${line.style.b * 256})`
            out += `<tr><td class="label" style="border-color:${borderColor}">${line.label}</td>`;
            vLines.forEach(vLine => {
                let data = traces.dataAtTime(line.dataName, vLine.x);

                // In case the user clicked outside of available data.
                let label = !data ? '' : data[line.dataIdx].toFixed(3);

                out += `<td>${label}</td>`
            })

            out += '</tr>';
        })
        out += '</table>';

        this.legend.innerHTML = out;
    }

    draw(time, xlim, refreshPlots, axesOnly, marks) {
        let verticalLines = [new VerticalLine(time, 'orange')];
        marks.withinXLim(xlim).forEach(mark => {
            verticalLines.push(new VerticalLine(mark.time, 'red', mark.label));
        });

        this.axesDrawer.draw(verticalLines);

        this.updateLegendValues(verticalLines);

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
