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

        let width = 800;
        let height = 300;

        let style = `width:${width}px;height:${height}px;position:absolute`;

        let setStyle= (canvas, width, height) => {
            canvas.setAttribute('width', width);
            canvas.setAttribute('height', height);
            canvas.setAttribute('style', style);
        }

        setStyle(canvasGrid, 4 * width, 4 * height);
        setStyle(canvasLine, width, height);
        setStyle(canvasAxes, 4 * width, 4 * height);

        legend.setAttribute('style', 'position:absolute;right:20px;text-align:right;background:white');

        dom.appendChild(canvasGrid);
        dom.appendChild(canvasLine);
        dom.appendChild(canvasAxes);
        dom.append(legend);

        dom.style.position = 'relative';
        dom.style.width = `${width}px`;
        dom.style.height = `${height}px`;

        this.margin = [10, 20, 10, 20];

        this.glDrawer = new GLDrawer(canvasLine, this.margin);
        this.lineDrawer = new GLLineDrawer(this.glDrawer.ctx);
        this.axesDrawer = new AxesDrawer(canvasAxes, canvasGrid, this.margin, eventCallback);

        this.lines = [];
        this.lastDataVersion = -1;
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

    addLine(label, lineData, style) {
        this.lines.push({
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
            legendDiv.style = `border-right: 3px solid ${borderColor}; padding-right: 3px; margin-bottom: 3px`
            this.legend.appendChild(legendDiv);
        });
    }

    setViewport(xl, yl, xh, yh) {
        this.axesDrawer.setViewport(xl, yl, xh, yh);
        this.lineDrawer.setViewport(xl, yl, xh, yh);
    }

    draw(xlim, dataVersion) {
        this.axesDrawer.draw();

        if (this.lastDataVersion != dataVersion) {
            if (this.lines.length == 0) {
                this.lineDrawer.clear();
            } else {
                this.lines.forEach(line => {
                    let xlimIndices = line.lineData.findXLimIndices(xlim);
                    let chuncks = line.lineData.chuncks;
                    for (let idx = xlimIndices.from.chunckIdx; idx <= xlimIndices.to.chunckIdx; idx++) {
                        this.lineDrawer.drawLineChunck(chuncks[idx], line.style)
                    }
                });
            }

            this.lastDataVersion = dataVersion;
        }
    }
}
