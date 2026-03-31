let plots = [];
let layout = {
    zoomX: null
};
let hasData = false;
let traces = new Traces(wsMaxData, eventCallback);
traces.callbackFn.push(event3DCallback)

let cameras = new Map(); // name -> CameraPlayback
let camerasContainer = document.getElementById('camerasContainer');

function getOrCreateCamera(name) {
    if (cameras.has(name)) return cameras.get(name);
    let cam = new CameraPlayback(name, camerasContainer);
    cameras.set(name, cam);
    return cam;
}

function clearAllCameras() {
    cameras.forEach(cam => cam.remove());
    cameras.clear();
}
let marks = new Marks();
let layoutDom = document.getElementById('layout');
let domPlots = document.getElementById('plots');
let panelRootDom = document.getElementById('panelRoot');
let addOptions = document.getElementById('addOptions');

let forcePlotRefresh = true;

layoutDom.value = localStorage.getItem('layout') || "trig[0],trig[1];trig[:2]";

let scene = new Scene3D(document.getElementById('viewer'));
let plane = new Plane3D('plane')
scene.addObject(plane)

const PANEL_LAYOUT_STORAGE_KEY = 'panelLayout';
const DEFAULT_PANEL_LAYOUT = 't|3d/img';

let imageVisible = false;
let panelLayoutValue = DEFAULT_PANEL_LAYOUT;
let panelVisible = new Set();

const panelNodes = {
    t: domPlots,
    '3d': document.getElementById('viewer'),
    img: camerasContainer,
};


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

function panelNodeVisibleMode(panelId) {
    return panelId === 'img' ? 'flex' : 'block';
}

function tokenizePanelLayout(value) {
    let tokens = [];
    let compact = value.replaceAll(' ', '');
    let idx = 0;
    let squareDepth = 0;

    while (idx < compact.length) {
        let c = compact[idx];

        if ('|/()'.includes(c)) {
            tokens.push(c);
            idx += 1;
            continue;
        }

        if (c === '[' || c === ']') {
            if (c === '[') {
                squareDepth += 1;
            } else {
                squareDepth -= 1;
                if (squareDepth < 0) {
                    throw new Error("Unexpected closing ']'");
                }
            }
            idx += 1;
            continue;
        }

        if (!(/[a-zA-Z0-9]/.test(c))) {
            throw new Error(`Unexpected token '${c}'`);
        }

        let start = idx;
        while (idx < compact.length && /[a-zA-Z0-9]/.test(compact[idx])) {
            idx += 1;
        }
        tokens.push(compact.slice(start, idx));
    }

    if (squareDepth !== 0) {
        throw new Error("Missing closing ']'");
    }

    return tokens;
}

function parsePanelLayout(value) {
    let tokens = tokenizePanelLayout(value);
    if (tokens.length === 0) {
        throw new Error('Layout is empty');
    }

    let idx = 0;

    let parsePrimary = () => {
        if (idx >= tokens.length) {
            throw new Error('Unexpected end of layout');
        }

        let token = tokens[idx++];
        if (token === '(') {
            let nested = parseExpression();
            if (idx >= tokens.length || tokens[idx] !== ')') {
                throw new Error("Missing closing ')'");
            }
            idx += 1;
            return nested;
        }

        if (token === ')' || token === '|' || token === '/') {
            throw new Error(`Unexpected token '${token}'`);
        }

        return {type: 'panel', id: token};
    };

    let parseExpression = () => {
        let left = parsePrimary();

        while (idx < tokens.length && (tokens[idx] === '|' || tokens[idx] === '/')) {
            let op = tokens[idx++];
            let right = parsePrimary();
            left = {type: 'split', op: op, left: left, right: right};
        }

        return left;
    };

    let ast = parseExpression();
    if (idx !== tokens.length) {
        throw new Error(`Unexpected trailing token '${tokens[idx]}'`);
    }

    return ast;
}

function collectPanelIds(ast, out = []) {
    if (ast.type === 'panel') {
        out.push(ast.id);
        return out;
    }
    collectPanelIds(ast.left, out);
    collectPanelIds(ast.right, out);
    return out;
}

function validatePanelLayoutAst(ast) {
    let valid = new Set(['t', '3d', 'img']);
    let seen = new Set();
    let ids = collectPanelIds(ast);

    ids.forEach(id => {
        if (!valid.has(id)) {
            throw new Error(`Unknown panel '${id}'. Valid: t, 3d, img`);
        }
        if (seen.has(id)) {
            throw new Error(`Panel '${id}' is duplicated`);
        }
        seen.add(id);
    });

    if (seen.size === 0) {
        throw new Error('At least one panel is required');
    }
}

function layoutAstToString(ast) {
    if (ast.type === 'panel') {
        return ast.id;
    }
    return `(${layoutAstToString(ast.left)}${ast.op}${layoutAstToString(ast.right)})`;
}

function buildPanelDom(ast) {
    if (ast.type === 'panel') {
        let wrapper = document.createElement('div');
        wrapper.className = 'panel-leaf';
        let panelNode = panelNodes[ast.id];
        panelNode.style.display = panelNodeVisibleMode(ast.id);
        wrapper.appendChild(panelNode);
        panelVisible.add(ast.id);
        return wrapper;
    }

    let split = document.createElement('div');
    let orientation = ast.op === '|' ? 'row' : 'column';
    split.className = `panel-split ${orientation}`;
    split.appendChild(buildPanelDom(ast.left));
    split.appendChild(buildPanelDom(ast.right));
    return split;
}

function applyPanelLayout(layoutText, persist = true) {
    let ast = parsePanelLayout(layoutText);
    validatePanelLayoutAst(ast);

    panelVisible = new Set();
    panelRootDom.innerHTML = '';

    Object.entries(panelNodes).forEach(([panelId, panelNode]) => {
        panelNode.style.display = 'none';
        // Ensure the node can be cleanly re-attached.
        if (panelNode.parentElement && panelNode.parentElement !== panelRootDom) {
            panelNode.parentElement.removeChild(panelNode);
        }
    });

    panelRootDom.appendChild(buildPanelDom(ast));

    imageVisible = panelVisible.has('img');
    panelLayoutValue = layoutAstToString(ast);

    if (persist) {
        localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, panelLayoutValue);
    }

    shouldResize = true;
    forcePlotRefresh = true;
}

async function setPanelLayoutPrompt() {
    let description = [
        'Available panels: t, 3d, img',
        'Operators: "|" horizontal, "/" vertical',
        'Use parentheses for grouping.',
        'Examples: t|3d/img, t|(3d/img), (t|img)/3d',
    ].join('\n');

    let entered = await customPrompt(`${description}\n\nEnter panel layout:`, panelLayoutValue);
    if (entered === null) {
        return;
    }

    try {
        applyPanelLayout(entered, true);
    } catch (err) {
        customAlert(`Invalid layout: ${err.message}`);
    }
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
        layout.zoomX = [layout.zoomX[0], layout.zoomX[0] + xValue];
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

function subs_expand(value, subs) {
    return value.replaceAll( /\{([^}]+)\}/g, (_, g0) => subs.get(g0))
}

function transform_subs(value) {
    value = value.replaceAll(' ', '');
    let bits = value.split(';')

    let subs = new Map();
    let res = [];

    bits.forEach(bit => {
        let capture = bit.match(/^([^=]+)=(.+)$/);

        if (capture) {
            subs.set(capture[1], subs_expand(capture[2], subs));
        } else {
            res.push(subs_expand(bit, subs));
        }
    })

    return res;
}

function updateLayout() {
    plotLayout = layoutDom.value;
    localStorage.setItem('layout', plotLayout);

    // Handle definitions / substitutions like "x=12:3;sin[{x}]"
    plotLayoutPieces = transform_subs(plotLayout);

    // Update the plots if needed.
    let plotDefs = plotLayoutPieces.map(plotDef => {
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

let mouseDown = {
    active: false,
    pos: null,
    x: null,
    shift: false,
    xlim: null
}

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
            if (mouseDown.active && mouseDown.shift) {
                let move = -(evt.offsetX - mouseDown.x) / plots[0].axesDrawer.clientXScale();
                let mouseDownXLim = mouseDown.xlim;
                let xLimStart = mouseDownXLim[0] + move;

                layout.zoomX = [
                    xLimStart, xLimStart + (mouseDownXLim[1] - mouseDownXLim[0])
                ];
            }

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
            mouseDown.active = true;
            mouseDown.x = evt.offsetX;
            mouseDown.pos = plots[0].axesDrawer.clientXToTick(evt.offsetX);
            mouseDown.shift = evt.shiftKey;
            mouseDown.xlim = getXLim();

            if (evt.altKey) {
                marks.addMark(mouseDown.pos);
            } else {
                freeze(true);
            }

            document.activeElement.blur();
            evt.preventDefault();
            break;

        case "AxesDrawer::mouseup":
            mouseDown.active = false;

            if (mouseDown.shift) {
                break;
            }

            let mouseUpPos = plots[0].axesDrawer.clientXToTick(evt.offsetX);
            if (Math.abs(mouseDown.x - evt.offsetX) > 2) {
                zoomStack.push(getXLim())
                layout.zoomX = mouseDown.pos < mouseUpPos ? [mouseDown.pos, mouseUpPos] : [mouseUpPos, mouseDown.pos];
                updatePlotViewport();
                freeze(true);
                evt.preventDefault();
                ignoreMouseClick = true;
            } else {
                scene.setTime(mouseDown.pos);
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

function timeAmountFromKeyEvent(evt) {
    if (evt.ctrlKey) {
        return 0.5;
    } else if (evt.altKey) {
        return 0.001
    } else {
        return undefined;
    }
}

window.addEventListener('keydown', evt => {
    if (evt.target.matches('input, select, textarea')) {
        return;
    }
    switch (evt.key) {
        case 'ArrowLeft':
            stepBack(timeAmountFromKeyEvent(evt));
            evt.preventDefault();
            break;
        case 'ArrowRight':
            stepForward(timeAmountFromKeyEvent(evt));
            evt.preventDefault();
            break;
        case 'Enter':
            marks.addMark(scene.time)
            evt.preventDefault();;
            break;
    }
})

function isPlotDisplayed() {
    return panelVisible.has('t');
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
        scene.resize();
        forcePlotRefresh = true;
    }

    if (isPlotDisplayed()) {
        let xlim = updatePlotViewport();

        let absTime = scene.absoluteTime();

        let refreshPlot = forcePlotRefresh || !arrEqual(xlim, traces.view.xlim) || traces.view.newData;
        forcePlotRefresh = false;
        plots.forEach(plot => plot.draw(absTime, xlim, refreshPlot, false, marks));

        traces.view.xlim = xlim;
        traces.view.newData = false;
    }

    if (imageVisible) {
        let absTime = scene.absoluteTime();
        if (typeof _imgDebug !== 'undefined') {
            _imgDebug.lastSyncTime = absTime;
        }
        cameras.forEach(cam => cam.syncToTime(absTime));
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
    addSampleData(false);
}

try {
    let savedPanelLayout = localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY) || DEFAULT_PANEL_LAYOUT;
    applyPanelLayout(savedPanelLayout, false);
} catch (err) {
    console.warn('Invalid saved panel layout, using default:', err);
    applyPanelLayout(DEFAULT_PANEL_LAYOUT, true);
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

async function removeMark() {
    let label = await customPrompt("Which mark do you want to remove?");
    if (!label) {
        return;
    }
    label.toUpperCase().replaceAll(' ', '').split(',').forEach(l => marks.removeMarkByLabel(l));
}


function loadAllCameraSegments() {
    // Try multi-camera layout: recordings/cameras.json lists camera names
    fetch('http://127.0.0.1:8000/recordings/cameras.json')
        .then(r => {
            if (!r.ok) throw new Error('No cameras.json');
            return r.json();
        })
        .then(data => {
            (data.cameras || []).forEach(name => {
                let cam = getOrCreateCamera(name);
                cam.loadExistingSegments(`recordings/${name}/`);
            });
        })
        .catch(() => {
            // Fallback: try old single-camera layout at recordings/timestamps.json
            fetch('http://127.0.0.1:8000/recordings/timestamps.json')
                .then(r => {
                    if (!r.ok) throw new Error('No timestamps.json');
                    let cam = getOrCreateCamera('camera');
                    cam.loadExistingSegments('recordings/');
                })
                .catch(() => {});
        });
}

connectViaWebSocket();
loadAllCameraSegments();
updateSignals();
updateLayout();
