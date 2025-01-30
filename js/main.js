let plots = [];
let layout = {
    zoomX: null
};
let hasData = false;
let traces = new Traces(eventCallback);

let layoutDom = document.getElementById('layout');
let domPlots = document.getElementById('plots');
let addOptions = document.getElementById('addOptions');
let layoutVersion = 0;

layoutDom.value = localStorage.getItem('layout') || "plots=sin[0],msin[0]/msin[0]; xlim=[-3,-0]";

// https://matplotlib.org/stable/gallery/color/named_colors.html
colors = [
    [38, 120, 178], // blue
    [253, 127, 40], // orange
    [51, 159, 52], // green
    [212, 42, 47], // red
    [147, 106, 187], // purple
    [137, 85, 75], // brown
    [225, 122, 193], // pink
    [127, 127, 127], // gray
    [188, 188, 53], // olive
    [41, 190, 206] // cyan
]

let parseArray = (str) => {
    return str.slice(1, str.length - 1).split(',').map((val => parseFloat(val)));
}

function isZeroNegative(val) {
    let isZero = val === 0;
    isNegative = 1 / val === -Infinity;
    return isZero && isNegative;
}

function updatePlotViewport() {
    let xlim = [0, 0];
    // Zoom setting overwrites the xlim setting.
    if (layout.zoomX) {
        xlim = layout.zoomX;
    } else {
        let xValue = parseFloat(document.getElementById('xlimDom').value);
        xlim[0] = Math.max(0, traces.getLastTime() - xValue);
        xlim[1] = Math.max(0, traces.getLastTime());

        if (xlim[0] == xlim[1]) {
            xlim[1] += 1.;
        } else {
            // Adding a bit at the end to draw next tick.
            xlim[1] += (xlim[1] - xlim[0]) * 0.01;
        }
    }

    plots.forEach(plot => {
        let ylim;
        plot.lines.forEach(line => {
            ylim = line.lineData.findYLim(line.lineData.findXLimIndices(xlim), ylim);
        });

        if (!ylim) {
            ylim = [-0.1, 0.1];
        } else if (ylim[0] == ylim[1]) {
            ylim[0] -= 0.1;
            ylim[1] += 0.1;
        } else {
            let yspace = (ylim[1] - ylim[0]) * 0.1;
            ylim[0] -= yspace;
            ylim[1] += yspace;
        }

        if (ylim[1] - ylim[0] < 1e-4) {
            ylim[1] = 0.01;
            ylim[0] = -0.01;
        }

        plot.setViewport(xlim[0], ylim[0], xlim[1], ylim[1]);
    });

    layoutVersion += 1;
    return xlim;
}

function updateLayout() {
    plotLayout = layoutDom.value;
    localStorage.setItem('layout', plotLayout);

    // Update the plots if needed.
    let plotDefs = plotLayout.split('/').map(plotDef => {
        let parts = [];
        while (plotDef.length > 0) {
            let match = plotDef.match(/(([^\[]+)\[([^\]]*)\],*)/);
            match[3].split(',').forEach(bit => {
                let details = bit.match(/^(\d+)?(:(\d+)?)?/);

                let from, to;

                if (details[2] === undefined) { // No ":" detected. Single number.
                    if (details[1] === undefined) {
                        // If there is no colon and no first number, then ignore this
                        // entry as not valid.
                        return;
                    }

                    from = parseInt(details[1], 10);
                    to = from + 1;
                } else { // There is a colon. From and to defined from nubmer if any.
                    from = details[1];
                    to = details[3];
                }

                parts.push({
                    name: match[2],
                    from: from,
                    to: to,
                    style: ''
                });
            });

            plotDef = plotDef.slice(match[0].length);
        }
        return parts;
    });

    // Remove plots that are no longer needed.
    plots.splice(plotDefs.length).forEach(plot => {
        plot.remove();
    });

    // Clear the still required plots. No lines to show now.
    plots.forEach(plot => plot.clear());

    plots = plotDefs.map((plotParts, idx) => {
        // Need to have the div in the document before creating Plot. Plot queries
        // the clientHeight of canvas, which is otherwise not defined.

        let plot = idx < plots.length ? plots[idx] : new Plot(domPlots, eventCallback);

        if (!hasData) {
            return plot;
        }

        let colorIdx = 0;

        plotParts.forEach((part, partIdx) => {
            let dataSize = traces.getDataSize(part.name);

            let from = parseInt(part.from || '0', 10);
            let to;
            if (part.to !== undefined) {
                to = parseInt(part.to, 10);
            } else {
                to = dataSize;
            }

            if (from >= dataSize || to > dataSize) {
                // alert(`Trace for "${part.name}" has ${dataSize} entries. Indices from ${from} to ${to} is out of range. Ignorning entry.`);
                return;
            }

            for (let idx = from; idx < to; idx++) {
                let color = colors[colorIdx++ % colors.length];
                plot.addLine(
                    `${part.name}[${idx}]`,
                    traces.getLineData(part.name, idx),
                    {r: color[0]/256, g: color[1]/256, b: color[2]/256, z:-colorIdx * 0.001});
            }
        });

        plot.setViewport(0., -1., 2 * Math.PI, 1.)

        return plot;
    });

    updatePlotViewport();
}

layoutDom.addEventListener('keydown', (evt) => {
    if (evt.key == "Enter") {
        updateLayout();
        evt.preventDefault();
        return false;
    }
});

// let derivedVal = document.getElementById('derived').value;

// // ttData, dtData, this.timestepData, idx
// let derivedFn = Function('data', 'derived', 'fullData', 'index', derivedVal);

// traces.setDerivedFn(derivedFn);

let mouseDownPos = null;
let mouseDownX = null;

let ignoreMouseClick = false;

function eventCallback(type, evt) {
    switch(type) {
        case "AxesDrawer::mousemove":
            plots.forEach(plot => {
                let axesDrawer = plot.axesDrawer;
                axesDrawer.mouseX = evt.offsetX;

                if (this == plot) {
                    axesDrawer.mouseY = evt.offsetY;
                } else {
                    axesDrawer.mouseY = -10;
                }
            });
            break;

        case "AxesDrawer::mousedown":
            freeze(true);
            mouseDownX = evt.offsetX;
            mouseDownPos = plots[0].axesDrawer.clientXToTick(evt.offsetX);
            evt.preventDefault();
            break;

        case "AxesDrawer::mouseup":
            let mouseUpPos = plots[0].axesDrawer.clientXToTick(evt.offsetX);
            if (Math.abs(mouseDownX - evt.offsetX) > 2) {
                layout.zoomX = mouseDownPos < mouseUpPos ? [mouseDownPos, mouseUpPos] : [mouseUpPos, mouseDownPos];
                updatePlotViewport();
                freeze(true);
                evt.preventDefault();
                ignoreMouseClick = true;
            } else {
                layout.zoomX = null;
                updatePlotViewport();
            }
            break;

        case "AxesDrawer::dblclick":
            layout.zoomX = null;
            freeze(false);
            updatePlotViewport();
            evt.preventDefault();
            break;

        case "Traces::endTimestep":
        case "Traces::setDerivedFn":
        case "Traces::clear":
            // updatePlotViewport();
            break;

    }
}

var isFrozen = false;
function freeze(newValue) {
    if (newValue !== undefined) {
        isFrozen = !newValue; // Negate as will be negated once more below.
    }
    if (!isFrozen) {
        let axesDrawer = plots[0].axesDrawer
        layout.zoomX = [axesDrawer.xFrom, axesDrawer.xTo];
    } else {
        layout.zoomX = null;
    }
    isFrozen = !isFrozen;
}

let drawCounter = 0;
let shouldResize = true; // Force resize on first draw.
let draw = () => {
    requestAnimationFrame(draw);

    let updateAxesOnly = drawCounter++ % 5 > 0;
    if (updateAxesOnly) {
        return;
    }

    if (shouldResize) {
        shouldResize = false;
        let width = domPlots.clientWidth;
        plots.forEach(p => p.updateSize(width, 300));
    }

    let xlim = updatePlotViewport();

    plots.forEach(plot => plot.draw(xlim, layoutVersion, updateAxesOnly));
}

window.addEventListener('resize', (evt) => {
    shouldResize = true;
});

function firstNewData() {
    hasData = true;
    updateSignals();
    updateLayout();
}


// let counter = 600;
// let addSampleData = () => {
//     setTimeout(addSampleData, 1);

//     if (isFrozen) {
//         return;
//     }
//     traces.beginTimestep(counter * 0.001, 2000);
//     traces.record('F', [Math.random(), Math.sin(Math.PI * 0.1 * counter)]);
//     traces.endTimestep();
//     counter += 1;
// }
// addSampleData();

firstNewData();
draw();

function updateSignals() {
    addOptions.innerHTML = '<option value="$add">Add trace...</option>';

    traces.getDataNames().sort(function (a, b) {
        return a.toLowerCase().localeCompare(b.toLowerCase());
    }).forEach((key) => {
        let option = document.createElement('option');
        option.value = key;
        option.label = `${key}[${traces.getDataSize(key)}]`;
        addOptions.appendChild(option);
    });
}
addOptions.addEventListener('change', evt => {
    let value = addOptions.value;
    if (value == '$add') {
        return;
    }

    // Add the new trace at the end of the layout text.
    // HACK: We assume the plot is always last.
    if (!layoutDom.value.endsWith('=') && !layoutDom.value.endsWith('/')) {
        layoutDom.value += ',';
    }
    layoutDom.value += value + '[0]';
    layoutDom.focus();

    let val = layoutDom.value;
    layoutDom.selectionStart = val.length - 2;
    layoutDom.selectionEnd = val.length - 1;
    updateLayout();
})
updateSignals();
