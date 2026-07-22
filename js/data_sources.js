let wsMaxData = 5 * 60 * 1000;
//let wsMaxData = 1000 * 1000;

function parseTimeSample(sd, data) {
    let t = parseFloat(data.time);

    // Ignore new data in case the session is frozen and there is no space
    // in the traces object left. (A background session stays frozen with the
    // state it was left in.)
    let frozen = sd === currentSession ? isFrozen : sd.frozen;
    if (frozen && sd.traces.willEvictFirstData(wsMaxData)) {
        return false;
    }

    sd.traces.beginTimestep(t, wsMaxData);

    for (let [key, value] of Object.entries(data.payload)) {
        if (key === 'time') {
            continue;
        }

        let valueType = typeof value;

        if (valueType === 'boolean') {
            value = value ? 1 : 0;
        }

        if (valueType === 'number') {
            value = [value]
        } else if (valueType == 'string') {
            if (value.startsWith("array('d', [") || value.startsWith("array('f', [")) {
                value = value.slice(12, -2).split(', ').map(v => parseFloat(v))
            } else {
                continue; // Ignorning generic strings for now.
            }
        }

        sd.traces.record(key, value)
    }

    sd.traces.endTimestep();
    return false;
}

// A setting is a viewer configuration the producer registered for the session.
// It arrives both live and as part of the setup replay a reconnecting viewer
// gets, so applying one must be idempotent. Producer settings also update the
// session's persisted settings, so they become the "last used" configuration
// the session comes back with.
function applySetting(sd, name, payload) {
    const active = sd === currentSession;

    switch (name) {
        case '3dCamera': {
            if (active) {
                scene.addViewer();
                sd.settings.cameras3d = snapshotSceneCameras();
            } else if (!sd.settings.cameras3d) {
                // Background session with no stored camera state: record that
                // it wants the default viewer plus one more. If camera state
                // is already stored, that wins (it is the last-used config).
                sd.settings.cameras3d = [
                    {position: [1.5, 1.5, 1.5], lookAt: [0, 0, 0]},
                    {position: [1.5, 1.5, 1.5], lookAt: [0, 0, 0]},
                ];
            }
            persistSessionSettings(sd);
            return false;
        }

        case '3dCameraLocation': {
            if (active) {
                scene.updateCamera(payload.cameraIndex, payload.position, payload.lookAt);
            }
            const cams = sd.settings.cameras3d = sd.settings.cameras3d || [];
            while (cams.length <= payload.cameraIndex) {
                cams.push({position: [1.5, 1.5, 1.5], lookAt: [0, 0, 0]});
            }
            cams[payload.cameraIndex] = {position: payload.position, lookAt: payload.lookAt};
            persistSessionSettings(sd);
            return false;
        }

        case 'layout':
            sd.settings.plotLayout = payload;
            persistSessionSettings(sd);
            if (active) {
                layoutDom.value = payload;
                updateLayout();
            }
            return false;
    }

    console.warn('Unknown setting:', name);
    return false;
}

// Registered setups: the 3d scene objects and viewer settings the server keeps
// per session and replays whenever a viewer connects, so a page reload does not
// lose the meshes and point clouds that were registered before it opened.
function parseSetup(sd, data) {
    const active = sd === currentSession;

    if (data.op === 'launch') {
        // A producer (re)started this session: it begins fresh (settings are
        // kept — "same name, same configuration"), and the view follows it.
        sd.clearData();
        sd.live = true;
        if (!active) {
            switchSession(sd.name);
        }
        return true;
    } else if (data.op === 'set') {
        if (data.kind === 'scene') {
            // Goes through traces so the existing Traces::recordStaticData
            // handler in scene3d.js builds the Mesh3D / PointCloud3D (only
            // when this session is the displayed one; see SessionData).
            sd.traces.recordStaticData(data.key, data.payload);
            return true;
        } else if (data.kind === 'setting') {
            return applySetting(sd, data.name, data.payload);
        }
    } else if (data.op === 'remove') {
        sd.traces.staticData.delete(data.key);
        if (active) scene.removeObject(data.key);
        return true;
    } else if (data.op === 'clear') {
        sd.traces.staticData.clear();
        if (active) {
            scene.clear();
            scene.addObject(new Plane3D('plane'));
        }
        return true;
    }

    return false;
}

function parsewebSocketData(data) {
    // Viewer control messages from the server (not tied to one session).
    if (data.type == 'sessions') {
        handleSessionsMessage(data.sessions);
        return;
    }

    const sd = ensureSession(data.session || DEFAULT_SESSION_NAME);
    const active = sd === currentSession;
    let relayout = false;

    if (data.type == 'sample') {
        if (data.time == 'static') {
            for (let [key, value] of Object.entries(data.payload)) {
                if (key === 'time') {
                    continue;
                }
                sd.traces.recordStaticData(key, value);
            }
            relayout = true;
        } else {
            relayout = parseTimeSample(sd, data)
        }

        if (!sd.hasData) {
            sd.hasData = true;
            if (active) {
                firstNewData();
            }
        }
    } else if (data.type == 'image') {
        let imgTime = parseFloat(data.time);
        let wallNow = Date.now() / 1000;
        let lag = wallNow - imgTime;
        _imgDebug.imgCount++;
        _imgDebug.totalLag += lag;
        _imgDebug.maxLag = Math.max(_imgDebug.maxLag, lag);
        _imgDebug.lastImgTime = imgTime;
        let cam = getOrCreateCamera(sd, data.name || 'default');
        let frozen = active ? isFrozen : sd.frozen;
        if (frozen && cam.imageStore.times.length >= cam.imageStore.maxFrames) {
            // Don't evict frozen images — drop the incoming frame instead
        } else {
            cam.addImage(imgTime, data.payload);
        }
    } else if (data.type == 'video_segment') {
        let cam = getOrCreateCamera(sd, data.name || 'default');
        cam.addVideoSegment(data);
    } else if (data.type == 'depth') {
        // Point-cloud frames feed the PointCloud3D object living in the 3d
        // scene, which only hosts the displayed session's objects — frames of
        // background sessions are dropped (their streaming resumes when they
        // are switched to).
        if (active) {
            const key = '3d/' + (data.name || 'default');
            const pc = scene.objects.get(key);
            if (pc && pc.addFrame) {
                const t = parseFloat(data.time);
                pc.addFrame(t, data.depth, data.rgb, data.depth_scale, data.intrinsics);
            }
        }
        // If no PointCloud has been registered yet for this name, drop the
        // frame. The static registration is normally sent once before any
        // depth frame via the registered-setup replay.
    } else if (data.type == 'setup') {
        relayout = parseSetup(sd, data);
    } else if (data.type == 'marker') {
        let markerTime = parseFloat(data.time);
        let showSummary = data.show_summary === true;
        sd.marks.addMarkWithLabel(data.label, markerTime, showSummary);
    } else if (data.type == 'command') {
        let payload = data.payload;
        switch (data.name) {
            case 'clear':
                wsMaxData = payload.maxData;
                sd.clearData();     // handles scene/layout when sd is displayed
                if (active) {
                    freeZoom();
                }
                relayout = active;
                break;

            case 'zoomReset':
                if (active) freeZoom();
                break;

            default:
                // Settings used to be sent as one-off commands; recorded files
                // and older producers still do.
                relayout = applySetting(sd, data.name, payload) || relayout;
                break;
        }
    }

    if (relayout && sd === currentSession) {
        updateLayout();
    }
}

let dataRecord = [];
let domMessage = document.getElementById('message');

let packets = 0;
let datas = 0;

// === Image lag debug stats ===
let _imgDebug = {
    lastPrint: performance.now(),
    imgCount: 0,
    totalLag: 0,     // sum of (wallclock - image_timestamp) in seconds
    maxLag: 0,
    lastImgTime: 0,  // last image timestamp received
    lastSyncTime: 0, // last absTime passed to syncToTime
    decodeTotalMs: 0, // time spent in msgpack decode
};

setInterval(() => {
    if (_imgDebug.imgCount === 0) return;
    let now = performance.now();
    let elapsed = (now - _imgDebug.lastPrint) / 1000;
    let avgLag = _imgDebug.totalLag / _imgDebug.imgCount;
    console.log(
        `[img-debug] ${_imgDebug.imgCount} imgs in ${elapsed.toFixed(1)}s ` +
        `| avg_lag=${avgLag.toFixed(3)}s max_lag=${_imgDebug.maxLag.toFixed(3)}s ` +
        `| last_img_t=${_imgDebug.lastImgTime.toFixed(3)} last_sync_t=${_imgDebug.lastSyncTime.toFixed(3)} ` +
        `| sync_delta=${(_imgDebug.lastSyncTime - _imgDebug.lastImgTime).toFixed(3)}s ` +
        `| decode_total=${_imgDebug.decodeTotalMs.toFixed(1)}ms ` +
        `| packets=${packets} items=${datas}`
    );
    _imgDebug.imgCount = 0;
    _imgDebug.totalLag = 0;
    _imgDebug.maxLag = 0;
    _imgDebug.decodeTotalMs = 0;
    _imgDebug.lastPrint = now;
    packets = 0;
    datas = 0;
}, 2000);
// === End image lag debug stats ===

let ws = null;
function connectViaWebSocket() {
    ws = new WebSocket("ws://127.0.0.1:5678/");
    ws.binaryType = "arraybuffer";

    ws.onmessage = function (event) {
        domMessage.textContent = '';

        let _t0 = performance.now();
        let data = MessagePack.decode(new Uint8Array(event.data));
        _imgDebug.decodeTotalMs += (performance.now() - _t0);

        // Session data lives in the browser: no wholesale clear on
        // (re)connect. A session launch clears just that session, and the
        // server's 'sessions' message (first thing it sends) refreshes the
        // liveness of the session list.
        data.forEach(parsewebSocketData);
        packets += 1;
        datas += data.length;
    };

    ws.onerror = function (event) {
        domMessage.textContent = 'Error with streaming. Is the data streamed?'
    };
}

setInterval(() => {
    if (!ws || ws.readyState >= 2) {
        connectViaWebSocket(true);
    }
}, 100);


function readDatafile(binaryBuffer) {
    if (ws) {
        ws.close();
    }

    got_data = true

    // Ungzip the datafile.
    let binData = new Uint8Array(binaryBuffer);
    var data = pako.inflate(binData);

    // Create a dataview on the data for easier reading of values.
    let dv = new DataView(data.buffer);

    let offset = 0;
    var enc = new TextDecoder("utf-8");

    let field_names = [];
    let field_sizes = []

    // Read the header of the file.
    let idx = dv.getUint32(0, true);
    let num_fields = dv.getUint32(4, true);
    offset += 8;

    // Read the field data.
    for (let f = 0; f < num_fields; f++) {
        arr = []
        for (let i = 0; i < 64; i++) {
            arr.push(dv.getUint8(offset));

            offset += 1
        }
        field_name = enc.decode(new Uint8Array(arr))
        field_name = field_name.replaceAll('\u0000', '')
        field_size = dv.getUint32(offset, true);
        offset += 4;

        field_names.push(field_name);
        field_sizes.push(field_size);
        console.log('  ', field_name, '@', field_size);
    }

    let dtData = new Map();
    field_names.forEach((name, i) => {
        dtData.set(name, new Array(field_sizes[i]));
    });

    let fieldNamesWithoutTime = field_names.filter(name => name != 'time');

    traces.clear(false, Number.POSITIVE_INFINITY);

    let timeFilter = (t) => {
        return true;
    }

    let time;
    // Read the data blob.
    for (var j = 0; offset < data.length; j++) {
        time = j * 0.001; // Fallback value assuming 1 kHz.
        let recordTime = timeFilter(time);

        for (let f = 0; f < num_fields; f++) {
            let fieldData = dtData.get(field_names[f]);
            for (let i = 0; i < field_sizes[f]; i++) {
                if (recordTime) {
                    fieldData[i] = dv.getFloat32(offset, true);
                }

                offset += 4;
            }
        }

        if (!recordTime) {
            continue;
        }

        if (dtData.has('time')) {
            time = dtData.get('time')[0];
        }

        traces.beginTimestep(time);

        fieldNamesWithoutTime.forEach(name => {
            traces.record(name, dtData.get(name));
        });

        traces.endTimestep();
    }

    console.log('Data end-time:', time);

    layout.zoomX = [traces.getFirstTime(), traces.getLastTime()]
    updatePlotViewport();
}

function loadFileContent(loadedFile) {
    loadedFile.arrayBuffer().then((content) => {
        traces.clear();
        readDatafile(content);
        firstNewData();
    });
}

async function loadDataFile() {
    const pickerOpts = {
        types: [
            {
            description: 'MIM Data Storage',
            accept: {
                'data/*': ['.mds']
            }
            },
        ],
        excludeAcceptAllOption: true,
        multiple: false
    };
    let [fileHandle] = await window.showOpenFilePicker(pickerOpts);
    let file = await fileHandle.getFile();
    loadFileContent(file);
}


let dropArea = document.body;

// Drag and drop handling.
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, preventDefaults, false);
})

function preventDefaults (e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, highlight, false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, unhighlight, false);
});

function highlight(e) {
    dropArea.classList.add('highlight');
}

function unhighlight(e) {
    dropArea.classList.remove('highlight');
}

dropArea.addEventListener('drop', handleDrop, false);

function handleDrop(e) {
    loadFileContent(e.dataTransfer.files[0]);
}
