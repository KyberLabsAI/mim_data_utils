let plots = [];
let layout = {
    zoomX: null
};
let hasData = false;
let traces = new Traces(wsMaxData, eventCallback);
traces.callbackFn.push(event3DCallback)

let marks = new Marks();
let layoutDom = document.getElementById('layout');
let domPlots = document.getElementById('plots');
let addOptions = document.getElementById('addOptions');

let forcePlotRefresh = true;

layoutDom.value = localStorage.getItem('layout') || "trig[0],trig[1];trig[:2]";

function arrEqual(a, b) {
    if (a.length != b.length) {
        return false;
    } else {
        return a.every((v, i) => v == b[i]);
    }
}

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

function getXLim() {
    let xlim = [0, 0];
    // Zoom setting overwrites the xlim setting.
    if (layout.zoomX) {
        xlim = layout.zoomX;
    } else {
        let xValue = parseFloat(document.getElementById('xlimDom').value);
        xlim[0] = Math.max(0, traces.getLastTime() - xValue);
        xlim[1] = xlim[0] + xValue;

        if (xlim[0] == xlim[1]) {
            xlim[1] += 1.;
        } else {
            // Adding a bit at the end to draw next tick.
            xlim[1] += (xlim[1] - xlim[0]) * 0.01;
        }
    }

    return xlim;
}

document.getElementById('xlimDom').addEventListener('change', (evt) => {
    if (isFrozen) {
        let xValue = parseFloat(document.getElementById('xlimDom').value);
        // Ensure the start point is positive.
        let start = Math.max(0, 0.5 * (layout.zoomX[1] + layout.zoomX[0]) - xValue/2);
        layout.zoomX = [start, start + xValue];
    } else {
        layout.zoomX = null;
    }

    updatePlotViewport();
})

function updatePlotViewport() {
    let xlim = getXLim();

    plots.forEach(plot => {
        let ylim = null;
        plot.lines.forEach(line => {
            ylim = traces.yLim(xlim[0], xlim[1], line.dataName, line.dataIdx, ylim);
        });

        if (!ylim) {
            ylim = new Lim(-0.1, 0.1);
        } else if (ylim.from == ylim.to) {
            ylim.expandByMargin(0.1);
        } else {
            ylim.expandByMargin((ylim.to - ylim.from) * 0.1);
        }

        plot.setViewport(xlim[0], ylim.from, xlim[1], ylim.to);
    });

    return xlim;
}

function updateLayout() {
    plotLayout = layoutDom.value;
    localStorage.setItem('layout', plotLayout);

    // Update the plots if needed.
    let plotDefs = plotLayout.split(';').map(plotDef => {
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
                    part.name, idx,
                    traces.getLineData(part.name, idx),
                    {r: color[0]/256, g: color[1]/256, b: color[2]/256, z:-colorIdx * 0.001});
            }
        });

        plot.setViewport(0., -1., 2 * Math.PI, 1.)

        return plot;
    });

    updatePlotViewport();
    forcePlotRefresh = true;
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

let zoomStack = [];

function freeZoom() {
    layout.zoomX = null;
    scene.setTime(null);
    freeze(false);
    updatePlotViewport();
}

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
            mouseDownX = evt.offsetX;
            mouseDownPos = plots[0].axesDrawer.clientXToTick(evt.offsetX);

            if (evt.altKey) {
                marks.addMark(mouseDownPos);
            } else {
                freeze(true);
            }

            evt.preventDefault();
            break;

        case "AxesDrawer::mouseup":
            let mouseUpPos = plots[0].axesDrawer.clientXToTick(evt.offsetX);
            if (Math.abs(mouseDownX - evt.offsetX) > 2) {
                zoomStack.push(getXLim())
                layout.zoomX = mouseDownPos < mouseUpPos ? [mouseDownPos, mouseUpPos] : [mouseUpPos, mouseDownPos];
                updatePlotViewport();
                freeze(true);
                evt.preventDefault();
                ignoreMouseClick = true;
            } else {
                scene.setTime(mouseDownPos);
            }
            break;

        case "AxesDrawer::dblclick":
            if (zoomStack.length > 0) {
                layout.zoomX = zoomStack.pop()
                updatePlotViewport();
            } else {
                freeZoom();
            }
            evt.preventDefault();
            break;

        case "Traces::newSeriesData":
            updateSignals();
            updateLayout();
            break;

        case "Traces::endTimestep":
        case "Traces::setDerivedFn":
        case "Traces::clear":
            // updatePlotViewport();
            break;

    }
}

var viewSceneState = 0;

function isSceneDisplayed() {
    return viewSceneState % 3 > 0;
}

function toggleScene(state) {
    if (state === undefined) {
        viewSceneState++;
    } else {
        if (viewSceneState == state) {
            return;
        }
        viewSceneState = state;
    }

    let showBoth = false;
    let showSceneOnly = false;

    if (viewSceneState % 3 == 1) {
        showBoth = true;
    } else if (viewSceneState % 3 == 2) {
        showSceneOnly = true
    }

    document.body.classList.toggle('showBoth', showBoth);
    document.body.classList.toggle('showSceneOnly', showSceneOnly);

    scene.resize();
    shouldResize = true;
    forcePlotRefresh = true;
}

var isFrozen = false;
function freeze(newValue) {
    if (newValue !== undefined) {
        isFrozen = !newValue; // Negate as will be negated once more below.
    }

    isFrozen = !isFrozen;

    if (isFrozen) {
        let axesDrawer = plots[0].axesDrawer
        layout.zoomX = [axesDrawer.xFrom, axesDrawer.xTo];
    } else {
        layout.zoomX = null;
    }
}

let drawCounter = 0;
let shouldResize = true; // Force resize on first draw.
let draw = () => {
    requestAnimationFrame(draw);

    // let updateAxesOnly = drawCounter++ % 5 > 0;
    // if (updateAxesOnly) {
    //     return;
    // }

    if (shouldResize) {
        shouldResize = false;
        let width = domPlots.clientWidth;
        plots.forEach(p => p.updateSize(width, 300));
        forcePlotRefresh = true;
    }

    let xlim = updatePlotViewport();

    let absTime = scene.absoluteTime();

    let refreshPlot = forcePlotRefresh || !arrEqual(xlim, traces.view.xlim) || traces.view.newData;
    forcePlotRefresh = false;
    plots.forEach(plot => plot.draw(absTime, xlim, refreshPlot, false, marks));

    traces.view.xlim = xlim;
    traces.view.newData = false;

    if (isSceneDisplayed()) {
        scene.render();
    }
}

window.addEventListener('resize', (evt) => {
    shouldResize = true;
});

function firstNewData() {
    hasData = true;
    updateSignals();
    updateLayout();
}


let counter = 600;
let addSampleData = (once) => {
    // if (isFrozen) {
    //     return;
    // }

    for (let n = 0; n < 1; n++) {
        let data = [];
        for (let i = 0; i < 10; i++) {
            data.push(Math.sin(Math.PI * i * 0.1 * counter))
        }

        traces.beginTimestep(counter * 0.001, 200000);
        traces.record('sin', data);
        traces.endTimestep();
        counter += 1;
    }

    if (!once) {
        setTimeout(addSampleData, 1);
    }
}

if (window.location.hash == '#example-data') {
    layoutDom.value = 'sin[:]'

    while (counter < 600 + 300 * 1000) {
        addSampleData(true);
    }
    // addSampleData(false);
}

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

function removeMark() {
    let label = prompt("Which mark do you want to remove?").toUpperCase();
    if (!label) {
        return;
    }
    label.replaceAll(' ', '').split(',').forEach(l => marks.removeMarkByLabel(l));
}

if (window.location.hash == '#dummy') {
    traces.clear(false, Number.POSITIVE_INFINITY);
    wsMaxData = 1000 * 1000;

    for (let ti = 0; ti < 1000 * 1000; ti++) {
        traces.beginTimestep(0.001 * ti);
        traces.record('sin', [Math.sin(0.001 * ti)])
        traces.endTimestep();
    }
} else {
    connectViaWebSocket();

    // setTimeout(() => {
    //     JSON.parse((localStorage.getItem('lastData') || '[]')).forEach(entries => {
    //         JSON.parse(entries).forEach(parsewebSocketData);
    //     });
    //     firstNewData();

    // }, 10)
}

updateSignals();
updateLayout();
