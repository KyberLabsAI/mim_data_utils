let plots = [];
let layout = {
    zoomX: null
};

// --- Session bootstrap -------------------------------------------------------
// All data lives in per-session stores (see sessions.js). The globals below
// (`traces`, `cameras`, `marks`, `hasData`, ...) always point at the displayed
// session's structures; switchSession() re-points them.
migrateLegacySettings();
currentSession = ensureSession(DEFAULT_SESSION_NAME);

let hasData = false;
let traces = currentSession.traces;

let cameras = currentSession.cameras; // name -> CameraPlayback
let camerasContainer = document.getElementById('camerasContainer');

function getOrCreateCamera(sd, name) {
    if (sd.cameras.has(name)) return sd.cameras.get(name);
    let cam = new CameraPlayback(name, camerasContainer);
    sd.cameras.set(name, cam);
    if (sd !== currentSession) {
        // Background session: panel exists but stays hidden until the session
        // is switched to.
        cam.container.style.display = 'none';
    } else {
        // A newly-appearing source honors any saved "disabled" selection; new
        // sources default to shown.
        applyImageVisibility();
    }
    return cam;
}

// --- Display filtering for image sources and 3D scene entries ---------------
// Stored as arrays of DISABLED names in the session's settings, so a source
// not in the set defaults to shown (new sources appear automatically). See
// openLayoutWindow(). Re-pointed by switchSession().
let disabledImageSources = new Set(currentSession.settings.disabledImageSources || []);
let disabledPointClouds = new Set(currentSession.settings.disabledPointClouds || []);
// All non-point-cloud 3D objects (meshes, plane, ...) collapse to one toggle.
let sceneObjectsHidden = !!currentSession.settings.sceneObjectsHidden;

// A scene entry is a streamed point cloud iff it exposes addFrame() (PointCloud3D).
function isPointCloudEntry(entry) {
    return entry && typeof entry.addFrame === 'function';
}

function applyImageVisibility() {
    cameras.forEach(cam => {
        cam.container.style.display = disabledImageSources.has(cam.name) ? 'none' : '';
    });
}

function applySceneVisibility() {
    if (typeof scene === 'undefined' || !scene.objects) return;
    scene.objects.forEach((entry, name) => {
        let obj = entry.getObject && entry.getObject();
        if (!obj) return;
        if (isPointCloudEntry(entry)) {
            obj.visible = !disabledPointClouds.has(name);
        } else {
            obj.visible = !sceneObjectsHidden;
        }
    });
}

function persistVisibility() {
    currentSession.settings.disabledImageSources = [...disabledImageSources];
    currentSession.settings.disabledPointClouds = [...disabledPointClouds];
    currentSession.settings.sceneObjectsHidden = sceneObjectsHidden;
    persistSessionSettings(currentSession);
}

let marks = currentSession.marks;
let layoutDom = document.getElementById('layout');
let domPlots = document.getElementById('plots');
let panelRootDom = document.getElementById('panelRoot');
let addOptions = document.getElementById('addOptions');

let forcePlotRefresh = true;

layoutDom.value = currentSession.settings.plotLayout;

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
        currentSession.settings.panelLayout = panelLayoutValue;
        persistSessionSettings(currentSession);
    }

    shouldResize = true;
    forcePlotRefresh = true;
}

const PANEL_LAYOUT_LEGEND = [
    'Panels: t (plots), 3d (viewer), img (images)',
    'Operators: "|" horizontal, "/" vertical',
    'Grouping: ( )',
    'Examples: t|3d/img   t|(3d/img)   (t|img)/3d',
].join('\n');

// Strip the internal '3d/' prefix that Scene.to_static_dict adds, for display.
function sceneDisplayName(name) {
    return name.startsWith('3d/') ? name.slice(3) : name;
}

// Local helper: a titled `.toggle-section` block.
function makeLayoutSection(title) {
    const section = document.createElement('div');
    section.className = 'toggle-section';
    const header = document.createElement('h4');
    header.textContent = title;
    section.appendChild(header);
    return section;
}

// The currently-open layout panel element (null when closed). Also gates the
// toggle behavior of the "Set Layout" button and the "l" hotkey.
let layoutPanelEl = null;

// Close the left-side layout panel, returning the borrowed trace controls to
// their hidden holder so the toolbar references in main.js keep resolving.
function closeLayoutWindow() {
    if (!layoutPanelEl) return;
    const holder = document.getElementById('tracesHolder');
    holder.appendChild(layoutDom);
    holder.appendChild(addOptions);
    layoutPanelEl.remove();
    layoutPanelEl = null;
    refreshSessionsUI = () => {};
    // Let the views row reclaim the panel's width and force an immediate rerender.
    document.body.classList.remove('layout-panel-open');
    applyResize();
}

// Toggle the layout panel: open it if closed, close it if open.
function toggleLayoutWindow(focusTraces = false) {
    if (layoutPanelEl) closeLayoutWindow();
    else openLayoutWindow(focusTraces);
}

// Align the panel to the views region (below the fixed top toolbar) so the
// toolbar stays fully visible and only the lower content is covered/pushed.
function positionLayoutPanel() {
    if (!layoutPanelEl) return;
    const pr = document.getElementById('panelRoot').getBoundingClientRect();
    layoutPanelEl.style.top = pr.top + 'px';
    layoutPanelEl.style.height = pr.height + 'px';
}

// Left-side layout panel. Sections top-to-bottom: "Layout" (panel-layout input +
// syntax legend below it), "Traces" (the trace input + "Add trace..." dropdown,
// reparented from the toolbar), "Visuals" (one checkbox per image source) and
// "Scene" ("3D objects" group + one checkbox per streamed point cloud).
// Checkboxes toggle visibility live; the layout line applies on Enter / Apply.
// Pass focusTraces=true (e.g. from the "l" hotkey) to focus the trace input.
function openLayoutWindow(focusTraces = false) {
    if (layoutPanelEl) {
        // Already open: just (re)focus the requested field.
        if (focusTraces) { layoutDom.focus(); layoutDom.select(); }
        return;
    }
    const dialog = document.createElement('div');
    dialog.className = 'custom-dialog layout-panel';
    layoutPanelEl = dialog;

    // --- Sessions section: one row per known session, click to switch ---
    const sessionsSection = makeLayoutSection('Sessions');
    const sessionsList = document.createElement('div');
    sessionsList.className = 'toggle-list';
    sessionsSection.appendChild(sessionsList);
    dialog.appendChild(sessionsSection);

    function populateSessions() {
        sessionsList.innerHTML = '';
        const names = [...sessions.keys()].sort();
        names.forEach(name => {
            const sd = sessions.get(name);
            const row = document.createElement('div');
            row.className = 'session-row'
                + (sd === currentSession ? ' active' : '')
                + (sd.live ? '' : ' ended');
            row.textContent = name + (!sd.live && sd.hasData ? ' (ended)' : '');
            row.title = sd.live
                ? 'Live session — click to view'
                : 'Not live on the server; its data is kept until the page reloads';
            row.addEventListener('click', () => switchSession(name));
            sessionsList.appendChild(row);
        });
    }
    populateSessions();

    // --- Layout section: input line first, legend below ---
    const layoutSection = makeLayoutSection('Layout');

    const inputRow = document.createElement('div');
    inputRow.className = 'layout-input-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'prompt-input';
    input.value = panelLayoutValue;
    const applyBtn = document.createElement('button');
    applyBtn.className = 'primary';
    applyBtn.textContent = 'Apply';
    inputRow.appendChild(input);
    inputRow.appendChild(applyBtn);
    layoutSection.appendChild(inputRow);

    const errorLine = document.createElement('div');
    errorLine.className = 'layout-error';
    layoutSection.appendChild(errorLine);

    const legend = document.createElement('div');
    legend.className = 'msg layout-legend';
    legend.textContent = PANEL_LAYOUT_LEGEND;
    layoutSection.appendChild(legend);

    dialog.appendChild(layoutSection);

    function applyLayout() {
        try {
            applyPanelLayout(input.value, true);
            errorLine.textContent = '';
        } catch (err) {
            errorLine.textContent = `Invalid layout: ${err.message}`;
        }
    }
    applyBtn.addEventListener('click', applyLayout);
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); applyLayout(); }
    });

    // --- Traces section: reparent the toolbar's #layout input + #addOptions ---
    const tracesSection = makeLayoutSection('Traces');
    const tracesRow = document.createElement('div');
    tracesRow.className = 'traces-row';
    // Reparented live nodes keep their identity and all main.js event handlers.
    tracesRow.appendChild(layoutDom);
    tracesRow.appendChild(addOptions);
    tracesSection.appendChild(tracesRow);
    dialog.appendChild(tracesSection);

    // --- Visuals section: one checkbox per image source ---
    const visualsSection = document.createElement('div');
    visualsSection.className = 'toggle-section';
    const visualsHeader = document.createElement('h4');
    visualsHeader.textContent = 'Visuals';
    visualsSection.appendChild(visualsHeader);
    const visualsList = document.createElement('div');
    visualsList.className = 'toggle-list';
    visualsSection.appendChild(visualsList);
    dialog.appendChild(visualsSection);

    // --- Scene section: "3D objects" group + one checkbox per point cloud ---
    const sceneSection = document.createElement('div');
    sceneSection.className = 'toggle-section';
    const sceneHeader = document.createElement('h4');
    sceneHeader.textContent = 'Scene';
    sceneSection.appendChild(sceneHeader);
    const sceneList = document.createElement('div');
    sceneList.className = 'toggle-list';
    sceneSection.appendChild(sceneList);
    dialog.appendChild(sceneSection);

    function makeRow(labelText, checked, onToggle) {
        const label = document.createElement('label');
        label.className = 'toggle-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked;
        cb.addEventListener('change', () => onToggle(cb.checked));
        label.appendChild(cb);
        label.appendChild(document.createTextNode(' ' + labelText));
        return label;
    }

    function populate() {
        // Visuals: sorted image source names.
        visualsList.innerHTML = '';
        const camNames = [...cameras.keys()].sort();
        if (camNames.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'toggle-empty';
            empty.textContent = 'No image sources yet';
            visualsList.appendChild(empty);
        } else {
            camNames.forEach(name => {
                visualsList.appendChild(makeRow(name, !disabledImageSources.has(name), on => {
                    if (on) disabledImageSources.delete(name);
                    else disabledImageSources.add(name);
                    applyImageVisibility();
                    persistVisibility();
                }));
            });
        }

        // Scene: the collapsed "3D objects" entry, then each point cloud.
        sceneList.innerHTML = '';
        sceneList.appendChild(makeRow('3D objects', !sceneObjectsHidden, on => {
            sceneObjectsHidden = !on;
            applySceneVisibility();
            persistVisibility();
        }));
        const pcNames = [...scene.objects.entries()]
            .filter(([, entry]) => isPointCloudEntry(entry))
            .map(([name]) => name)
            .sort();
        pcNames.forEach(name => {
            sceneList.appendChild(makeRow(sceneDisplayName(name), !disabledPointClouds.has(name), on => {
                if (on) disabledPointClouds.delete(name);
                else disabledPointClouds.add(name);
                applySceneVisibility();
                persistVisibility();
            }));
        });
    }
    populate();

    // While the panel is open, session changes (new session, eviction, switch)
    // re-render its lists live. Reset to a no-op on close.
    refreshSessionsUI = () => {
        populateSessions();
        populate();
    };

    // --- Footer: Close ---
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'primary';
    closeBtn.textContent = 'Close';
    buttons.appendChild(closeBtn);
    dialog.appendChild(buttons);

    closeBtn.addEventListener('click', closeLayoutWindow);
    // Escape bubbles here from any focused field inside the panel.
    dialog.addEventListener('keydown', e => { if (e.key === 'Escape') closeLayoutWindow(); });

    document.body.appendChild(dialog);
    // Shrink only the lower views row so the panel pushes it aside (the top
    // toolbar stays fixed and full-width), then align the panel to that row and
    // force an immediate rerender.
    document.body.classList.add('layout-panel-open');
    positionLayoutPanel();
    applyResize();
    if (focusTraces) {
        layoutDom.focus();
        layoutDom.select();
    } else {
        input.focus();
        input.select();
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
    currentSession.settings.plotLayout = plotLayout;
    persistSessionSettings(currentSession);

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
        case 'l':
        case 'L':
            openLayoutWindow(true);
            evt.preventDefault();
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

// Re-fit the plots and 3D scene to the current container size and flag a full
// plot refresh. Safe to call synchronously (e.g. right after a resize) — it does
// not touch the requestAnimationFrame loop.
function applyResize() {
    let width = domPlots.clientWidth;
    plots.forEach(p => p.updateSize(width, 300));
    scene.resize();
    forcePlotRefresh = true;
}

let draw = () => {
    requestAnimationFrame(draw);

    // let updateAxesOnly = drawCounter++ % 5 > 0;
    // if (updateAxesOnly) {
    //     return;
    // }

    if (shouldResize) {
        shouldResize = false;
        applyResize();
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
        cameras.forEach(cam => {
            if (disabledImageSources.has(cam.name)) return;
            cam.syncToTime(absTime);
        });
    }
}

window.addEventListener('resize', (evt) => {
    positionLayoutPanel();
    // Force a rerender right after the resize instead of waiting for the next frame.
    applyResize();
});

function firstNewData() {
    hasData = true;
    currentSession.hasData = true;
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
    applyPanelLayout(currentSession.settings.panelLayout || DEFAULT_PANEL_LAYOUT, false);
} catch (err) {
    console.warn('Invalid saved panel layout, using default:', err);
    applyPanelLayout(DEFAULT_PANEL_LAYOUT, true);
}

// Keep the displayed session's settings (incl. the 3d camera poses, which are
// only snapshotted on demand) persisted across page unloads.
window.addEventListener('beforeunload', () => {
    if (!currentSession) return;
    currentSession.settings.cameras3d = snapshotSceneCameras();
    currentSession.settings.plotLayout = layoutDom.value;
    persistSessionSettings(currentSession);
});

// Apply any saved per-source display filters once the scene/cameras exist.
applyImageVisibility();
applySceneVisibility();

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
                let cam = getOrCreateCamera(currentSession, name);
                cam.loadExistingSegments(`recordings/${name}/`);
            });
        })
        .catch(() => {
            // Fallback: try old single-camera layout at recordings/timestamps.json
            fetch('http://127.0.0.1:8000/recordings/timestamps.json')
                .then(r => {
                    if (!r.ok) throw new Error('No timestamps.json');
                    let cam = getOrCreateCamera(currentSession, 'camera');
                    cam.loadExistingSegments('recordings/');
                })
                .catch(() => {});
        });
}

connectViaWebSocket();
loadAllCameraSegments();
updateSignals();
updateLayout();
