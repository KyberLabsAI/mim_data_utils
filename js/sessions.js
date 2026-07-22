// Per-session data and settings.
//
// Every stream item carries a `session` name; the viewer keeps one SessionData
// per name (traces, cameras, marks, freeze/zoom state) and displays exactly
// one of them at a time. The rendering code keeps using the historical globals
// (`traces`, `cameras`, `marks`, ...) — switchSession() re-points them.
//
// Settings (plot layout, panel layout, visibility toggles, 3d camera poses)
// are per-session and persisted in localStorage, so a session with a known
// name comes back with its last-used configuration. Unknown names start from
// the "Default" session's stored settings.

const DEFAULT_SESSION_NAME = 'Default';
const SESSION_SETTINGS_PREFIX = 'mdu:session:';

const BUILTIN_SESSION_SETTINGS = {
    plotLayout: 'trig[0],trig[1];trig[:2]',
    panelLayout: 't|3d/img',
    disabledImageSources: [],
    disabledPointClouds: [],
    sceneObjectsHidden: false,
    // null = leave the 3d viewers as they are; else [{position, lookAt}, ...]
    cameras3d: null,
};

// One-time migration of the old flat localStorage keys into the "Default"
// session's settings entry.
function migrateLegacySettings() {
    if (localStorage.getItem(SESSION_SETTINGS_PREFIX + DEFAULT_SESSION_NAME)) return;

    const legacy = {...BUILTIN_SESSION_SETTINGS};
    const plotLayout = localStorage.getItem('layout');
    if (plotLayout) legacy.plotLayout = plotLayout;
    const panelLayout = localStorage.getItem('panelLayout');
    if (panelLayout) legacy.panelLayout = panelLayout;
    try {
        legacy.disabledImageSources = JSON.parse(localStorage.getItem('disabledImageSources') || '[]');
        legacy.disabledPointClouds = JSON.parse(localStorage.getItem('disabledPointClouds') || '[]');
    } catch (err) { /* keep defaults */ }
    legacy.sceneObjectsHidden = localStorage.getItem('sceneObjectsHidden') === 'true';

    localStorage.setItem(
        SESSION_SETTINGS_PREFIX + DEFAULT_SESSION_NAME, JSON.stringify(legacy));
}

function loadSessionSettings(name) {
    const parse = (raw) => {
        try {
            return {...BUILTIN_SESSION_SETTINGS, ...JSON.parse(raw)};
        } catch (err) {
            return null;
        }
    };

    const own = localStorage.getItem(SESSION_SETTINGS_PREFIX + name);
    if (own) {
        const settings = parse(own);
        if (settings) return settings;
    }

    // Session not stored yet: use the "Default" session as reference.
    const def = localStorage.getItem(SESSION_SETTINGS_PREFIX + DEFAULT_SESSION_NAME);
    if (def) {
        const settings = parse(def);
        if (settings) return settings;
    }

    return {...BUILTIN_SESSION_SETTINGS};
}

function persistSessionSettings(session) {
    localStorage.setItem(
        SESSION_SETTINGS_PREFIX + session.name, JSON.stringify(session.settings));
}

class SessionData {
    constructor(name) {
        this.name = name;
        this.live = true;       // still alive on the server (greyed out if not)
        this.lastData = null;   // server-reported wall time of last data
        this.hasData = false;
        this.frozen = false;
        this.zoomX = null;
        this.settings = loadSessionSettings(name);
        this.marks = new Marks();
        this.cameras = new Map();   // name -> CameraPlayback
        this.traces = new Traces(
            wsMaxData, (type, evt, payload) => this._onTracesEvent(type, evt, payload));
    }

    // Traces events drive plot/scene updates — only the displayed session may
    // touch the UI; background sessions just accumulate data.
    _onTracesEvent(type, evt, payload) {
        if (currentSession !== this) return;
        eventCallback(type, evt);
        event3DCallback(type, evt, payload);
    }

    // Drop all recorded data (settings are kept). Used on session launch and
    // the 'clear' command.
    clearData() {
        this.traces.clear(true, wsMaxData);
        this.cameras.forEach(cam => cam.remove());
        this.cameras.clear();
        this.marks.clearMarks();
        this.hasData = false;
        this.frozen = false;
        this.zoomX = null;

        if (this === currentSession) {
            hasData = false;
            isFrozen = false;
            layout.zoomX = null;
            scene.clear();
            scene.addObject(new Plane3D('plane'));
            scene.setTime(null);
            updateLayout();
        }
    }
}

let sessions = new Map();       // name -> SessionData
let currentSession = null;      // set by main.js bootstrap

// Re-renders any session list UI; main.js points this at the sidebar section
// while it is open.
let refreshSessionsUI = () => {};

function ensureSession(name) {
    let sd = sessions.get(name);
    if (!sd) {
        sd = new SessionData(name);
        sessions.set(name, sd);
        refreshSessionsUI();
    }
    return sd;
}

// The server's live-session list: mark everything dead first, then revive the
// listed ones (creating entries for sessions we have not seen data of yet).
function handleSessionsMessage(list) {
    sessions.forEach(sd => { sd.live = false; });
    (list || []).forEach(entry => {
        const sd = ensureSession(entry.name);
        sd.live = true;
        sd.lastData = entry.last_data;
    });
    refreshSessionsUI();
}

function snapshotSceneCameras() {
    return scene.viewers.map(viewer => ({
        position: viewer.camera.position.toArray(),
        lookAt: (viewer.controls && viewer.controls.target)
            ? viewer.controls.target.toArray() : [0, 0, 0],
    }));
}

function restoreSceneCameras(cameras3d) {
    if (!cameras3d || !cameras3d.length) return;
    while (scene.viewers.length < cameras3d.length) {
        scene.addViewer();
    }
    if (scene.viewers.length > cameras3d.length) {
        scene.viewers = scene.viewers.slice(0, cameras3d.length);
        scene.resize();
    }
    cameras3d.forEach((cam, idx) => scene.updateCamera(idx, cam.position, cam.lookAt));
}

// Rebuild the single 3d scene from a session's registered static objects (the
// same payloads the live registration path uses).
function rebuildSceneForSession(sd) {
    scene.clear();
    scene.addObject(new Plane3D('plane'));
    sd.traces.staticData.forEach(payload => buildSceneObjectFromStatic(payload));
    applySceneVisibility();
}

// Save the outgoing session's view state, re-point the globals the rendering
// code uses, and apply the incoming session's settings.
function switchSession(name) {
    const target = ensureSession(name);
    if (target === currentSession) {
        refreshSessionsUI();
        return;
    }

    if (currentSession) {
        currentSession.frozen = isFrozen;
        currentSession.zoomX = layout.zoomX;
        currentSession.settings.cameras3d = snapshotSceneCameras();
        persistSessionSettings(currentSession);
        currentSession.cameras.forEach(cam => { cam.container.style.display = 'none'; });
    }

    currentSession = target;

    // Re-point the historical globals (declared in main.js).
    traces = target.traces;
    cameras = target.cameras;
    marks = target.marks;
    hasData = target.hasData;
    isFrozen = target.frozen;
    layout.zoomX = target.zoomX;
    scene.setTime(null);

    // Apply the session's settings to the UI.
    const s = target.settings;
    layoutDom.value = s.plotLayout;
    disabledImageSources = new Set(s.disabledImageSources || []);
    disabledPointClouds = new Set(s.disabledPointClouds || []);
    sceneObjectsHidden = !!s.sceneObjectsHidden;
    try {
        applyPanelLayout(s.panelLayout || BUILTIN_SESSION_SETTINGS.panelLayout, false);
    } catch (err) {
        console.warn('Invalid session panel layout, keeping current:', err);
    }

    rebuildSceneForSession(target);
    restoreSceneCameras(s.cameras3d);
    applyImageVisibility();

    updateSignals();
    updateLayout();
    updatePlotViewport();
    refreshSessionsUI();
}
