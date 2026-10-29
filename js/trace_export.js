/**
 * "Export data": download the time traces of the current session, its camera
 * images as video, its depth frames and its 3D scene setup (each optional) as
 * one gzip-compressed .mdutrace.gz file (read with mim_data_utils.load_mdutrace,
 * load_mdutrace_videos, load_mdutrace_depth, load_mdutrace_scene).
 *
 * File layout (before gzip, little-endian):
 *   'MDUTRACE' | u32 header length | u32 version (2) | JSON header (space padded
 *   to 8 bytes) | payload
 * The header lists per series {name, dim, n, times_offset, data_offset}, offsets
 * relative to the payload start and 8-byte aligned: n float64 times, then
 * dim * n float32 values, one column after the other.
 * Version 2 adds `videos`, one per camera {name, codec, width, height, n,
 * times_offset, sizes_offset, keys_offset, data_offset, data_bytes, ...}: n
 * float64 capture times [s] (the image timestamps), n u32 packet sizes, n u8
 * keyframe flags, then the n encoded packets back to back, in decode order.
 * The codec is a WebCodecs string: 'avc1.*' = H.264 Annex B (SPS/PPS in every
 * keyframe), 'vp09.*' = VP9.
 * `depth`, one per depth source {name, n, registration, intrinsics (per-frame
 * overrides or null), times_offset (f64), depth_scales_offset (f64, NaN = the
 * registration's), depth_sizes_offset (u32), depth_offset (the raw u16 depth
 * images back to back), rgb_sizes_offset (u32, 0 = none), rgb_offset (JPEGs)}.
 * `scene` {objects: {name: registration payload}} or null: the 3D objects;
 * their typed arrays are payload blocks {"__array__": dtype, offset, length}.
 * Version 1 files are the same without `videos`, `depth` and `scene`.
 *
 * The button first asks what to export (checkboxes: the traces, each camera,
 * each depth source, the 3D scene setup; sources shown in the layout start
 * checked), and the range: the
 * last N minutes (counted back from the newest exported sample), the series
 * plotted in the current layout (all their buffered samples), or everything.
 * Camera images are re-encoded with the browser's VideoEncoder (WebCodecs):
 * consecutive frames share most of their content, so a video codec stores
 * them ~5-20x smaller than the JPEGs the viewer holds.
 */

const _traceExportCSS = `
.custom-dialog .export-progress {
    height: 10px;
    background: #e4e4e4;
    border-radius: 5px;
    overflow: hidden;
    margin-bottom: 12px;
}
.custom-dialog .dump-options {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    margin-bottom: 12px;
}
.custom-dialog .dump-check {
    display: block;
    margin-bottom: 12px;
}
.custom-dialog .export-progress > div {
    height: 100%;
    width: 0%;
    background: #4a90d9;
    transition: width 0.1s linear;
}
`;

(function injectTraceExportCSS() {
    const style = document.createElement('style');
    style.textContent = _traceExportCSS;
    document.head.appendChild(style);
})();

// Progress bar shares: collecting the series, encoding the videos (when there
// are any), the rest is compression.
const _EXPORT_COLLECT_SHARE = 0.2;
const _EXPORT_VIDEO_SHARE = 0.6;
// Compression input slice: small enough for a smooth bar, large enough that
// the per-slice overhead does not matter.
const _EXPORT_SLICE_BYTES = 1 << 20;

// Encoders tried in order: H.264 High / Main / Baseline (Annex B), then VP9.
const _VIDEO_CODECS = ['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'vp09.00.51.08'];
// Target bitrate as bits per pixel and frame: 0.1 at 640x480 / 30 fps is
// ~0.9 Mbit/s, ~10x below the JPEG stream, sharp on a mostly static scene.
const _VIDEO_BITS_PER_PIXEL = 0.1;
// A keyframe every this many seconds of capture time (seek granularity).
const _VIDEO_KEYFRAME_S = 2;
// Frames handed to the encoder ahead of its output.
const _VIDEO_MAX_QUEUE = 4;

function _exportProgressDialog() {
    const overlay = _createOverlay();
    const dialog = document.createElement('div');
    dialog.className = 'custom-dialog';
    dialog.innerHTML = `
        <div class="msg">Exporting data...</div>
        <div class="export-progress"><div></div></div>
        <div class="buttons">
            <button class="cancel-btn">Cancel</button>
        </div>
    `;
    overlay.appendChild(dialog);
    const state = {cancelled: false};
    const msg = dialog.querySelector('.msg');
    const bar = dialog.querySelector('.export-progress > div');
    dialog.querySelector('.cancel-btn').addEventListener('click', () => {
        state.cancelled = true;
    });
    state.update = (fraction, text) => {
        bar.style.width = `${(100 * Math.min(Math.max(fraction, 0), 1)).toFixed(1)}%`;
        if (text) msg.textContent = text;
    };
    state.close = () => overlay.remove();
    return state;
}

const _DUMP_MINUTES = [0.5, 1, 2, 5, 10, 20];

/** Asks what to export: which data (one checkbox per entry of `options`,
 * {label, title, checked, disabled}) and which range. Resolves to
 * {kind: 'minutes', minutes} | {kind: 'displayed'} | {kind: 'all'}, each with
 * `checked` (one bool per option), or null on cancel. */
function _dumpOptionsDialog(options) {
    return new Promise(resolve => {
        const overlay = _createOverlay();
        const dialog = document.createElement('div');
        dialog.className = 'custom-dialog';
        const minuteButtons = _DUMP_MINUTES.map(m =>
            `<button data-minutes="${m}">Last ${m} min</button>`).join('');
        const dataOptions = options.map((o, i) => `
            <label class="dump-check" title="${_escapeHtml(o.title)}">
                <input type="checkbox" data-option="${i}" ${o.checked ? 'checked' : ''}
                       ${o.disabled ? 'disabled' : ''}> ${_escapeHtml(o.label)}
            </label>`).join('');
        dialog.innerHTML = `
            <div class="msg">Export which data?</div>
            ${dataOptions}
            <div class="msg">Which range?</div>
            <div class="dump-options">
                ${minuteButtons}
                <button data-kind="displayed" title="The series plotted in the current layout, all buffered samples">Displayed</button>
                <button data-kind="all">All</button>
            </div>
            <div class="buttons">
                <button class="cancel-btn">Cancel</button>
            </div>
        `;
        overlay.appendChild(dialog);
        const finish = (choice) => {
            overlay.remove();
            if (!choice) { resolve(null); return; }
            resolve({
                ...choice,
                checked: options.map((o, i) => dialog.querySelector(`input[data-option="${i}"]`).checked),
            });
        };
        dialog.querySelectorAll('.dump-options button').forEach(b => b.addEventListener('click', () => {
            if (b.dataset.minutes) finish({kind: 'minutes', minutes: Number(b.dataset.minutes)});
            else finish({kind: b.dataset.kind});
        }));
        dialog.querySelector('.cancel-btn').addEventListener('click', () => finish(null));
        overlay.addEventListener('keydown', e => { if (e.key === 'Escape') finish(null); });
        dialog.querySelector('.cancel-btn').focus();
    });
}

/** Series names plotted in the current layout. */
function _displayedSeriesNames() {
    const names = new Set();
    plots.forEach(plot => plot.lines.forEach(line => names.add(line.dataName)));
    return names;
}

/** Cameras of the session with buffered images, sorted by name. */
function _exportCameras(session) {
    return Array.from(session.cameras.values())
        .filter(cam => cam.imageStore.times.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
}

/** Depth sources (PointCloud3D objects of the 3D scene) with buffered
 * frames, sorted by name. The scene only hosts the displayed session's
 * objects, and only that session receives depth frames. */
function _exportDepthSources() {
    if (typeof scene === 'undefined' || !scene.objects) return [];
    return Array.from(scene.objects.values())
        .filter(obj => obj.store instanceof PointDataStore && obj.store.times.length > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
}

const _escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

/** Newest sample time over the series (`seriesNames`: all if null) and the
 * frame stores (sorted `times` arrays). */
function _latestDataTime(traces, seriesNames, frameStores) {
    let t = -Infinity;
    for (const [name, s] of traces.seriesData) {
        if (seriesNames && !seriesNames.has(name)) continue;
        const c = s.chunks[s.chunks.length - 1];
        if (c && c.entries > 0) t = Math.max(t, c.times[c.entries - 1]);
    }
    for (const store of frameStores) {
        t = Math.max(t, store.times[store.times.length - 1]);
    }
    return t;
}

// Typed array constructor name -> numpy dtype (little-endian).
const _DTYPES = {
    Float32Array: '<f4', Float64Array: '<f8', Int8Array: 'i1', Uint8Array: 'u1',
    Uint8ClampedArray: 'u1', Int16Array: '<i2', Uint16Array: '<u2', Int32Array: '<i4',
    Uint32Array: '<u4', BigInt64Array: '<i8', BigUint64Array: '<u8',
};

/** JSON-able copy of a registration payload: typed arrays (mesh vertices,
 * indices, ...) go to the payload as binary blocks, replaced by
 * {"__array__": dtype, "offset", "length"} (mim_data_utils restores them as
 * numpy arrays). */
function _serializeStatic(value, payload) {
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        const dtype = _DTYPES[value.constructor.name];
        if (dtype) return {__array__: dtype, offset: payload.add(value.slice()), length: value.length};
    }
    if (value instanceof ArrayBuffer) {
        return {__array__: 'u1', offset: payload.add(new Uint8Array(value.slice(0))), length: value.byteLength};
    }
    if (Array.isArray(value)) return value.map(v => _serializeStatic(v, payload));
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = _serializeStatic(v, payload);
        return out;
    }
    return value;
}

/** The 3D scene setup: every registered object's payload (meshes, point
 * cloud registrations), by name. Their poses / colours are the '3d/<name>/...'
 * series, exported with the traces. */
function _collectSceneSetup(traces, payload) {
    const objects = {};
    for (const [name, data] of traces.staticData) objects[name] = _serializeStatic(data, payload);
    return {objects};
}

/** Copies the depth source's frames from tMin on: per frame the time, the raw
 * depth (u16, little-endian), the depth scale (NaN = the registration's), the
 * JPEG colour image (0 bytes if none) and the intrinsics override. */
function _collectDepthSource(pc, staticData, payload, tMin) {
    const store = pc.store;
    const start = _firstIndexFrom(store.times, store.times.length, tMin);
    const n = store.times.length - start;
    if (n <= 0) return null;
    const idx = Array.from({length: n}, (_, k) => start + k);
    const depths = idx.map(i => store.depths[i]);
    const rgbs = idx.map(i => store.rgbBytes[i] || new Uint8Array(0));
    const intrinsics = idx.map(i => store.intrinsicsList[i]);
    const entry = {
        name: pc.name, n,
        registration: _serializeStatic(staticData.get(pc.name) || {}, payload),
        intrinsics: intrinsics.some(x => x != null) ? intrinsics : null,
    };
    entry.times_offset = payload.add(Float64Array.from(idx, i => store.times[i]));
    entry.depth_scales_offset = payload.add(Float64Array.from(idx, i => store.depthScales[i] ?? NaN));
    entry.depth_sizes_offset = payload.add(Uint32Array.from(depths, d => d.byteLength));
    entry.depth_offset = payload.add(...depths.map(d => d.slice()));
    entry.rgb_sizes_offset = payload.add(Uint32Array.from(rgbs, r => r.byteLength));
    entry.rgb_offset = payload.add(...rgbs.map(r => r.slice()));
    return entry;
}

/** First index of the sorted `times` (length `n`) with time >= tMin (n if none). */
function _firstIndexFrom(times, n, tMin) {
    let lo = 0, hi = n;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] < tMin) lo = mid + 1; else hi = mid;
    }
    return lo;
}

const _nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));

class _ExportCancelled extends Error {}

/** The payload: blocks of typed arrays back to back, each block 8-byte aligned. */
class _PayloadWriter {
    constructor() {
        this.parts = [];
        this.offset = 0;
    }

    /** Appends the arrays as one contiguous block; returns its offset. */
    add(...arrays) {
        const p = (8 - this.offset % 8) % 8;
        if (p) { this.parts.push(new Uint8Array(p)); this.offset += p; }
        const at = this.offset;
        for (const arr of arrays) {
            this.parts.push(arr);
            this.offset += arr.byteLength;
        }
        return at;
    }
}

/** Copies every series out of the chunked ring buffers. One series at a time
 * so the dialog can redraw in between; a single series is copied in one go,
 * so streaming data cannot evict a chunk halfway through it. */
async function _collectTraceParts(traces, progress, payload, names = null, tMin = -Infinity) {
    const series = [];
    const all = Array.from(traces.seriesData).filter(([name]) => !names || names.has(name));
    for (let i = 0; i < all.length; i++) {
        if (progress.cancelled) throw new _ExportCancelled();
        const [name, s] = all[i];
        // Per chunk the first entry inside the window; chunks are in time order.
        const starts = s.chunks.map(c => _firstIndexFrom(c.times, c.entries, tMin));
        const n = s.chunks.reduce((a, c, ci) => a + c.entries - starts[ci], 0);
        if (n > 0) {
            const times = new Float64Array(n);
            const data = new Float32Array(n * s.dim);
            let k = 0;
            s.chunks.forEach((c, ci) => {
                const from = starts[ci];
                if (from >= c.entries) return;
                times.set(c.times.subarray(from, c.entries), k);
                for (let d = 0; d < s.dim; d++) {
                    c.copyColumn(d, data, d * n + k, from, c.entries);
                }
                k += c.entries - from;
            });
            const entry = {name, dim: s.dim, n, times_offset: payload.add(times)};
            entry.data_offset = payload.add(data);
            series.push(entry);
        }
        progress.update(_EXPORT_COLLECT_SHARE * (i + 1) / all.length,
                        `Collecting traces (${i + 1}/${all.length})...`);
        await _nextFrame();
    }
    return series;
}

/** First encoder config of _VIDEO_CODECS the browser supports, or null. */
async function _pickVideoConfig(width, height, fps) {
    for (const codec of _VIDEO_CODECS) {
        const config = {
            codec, width, height, framerate: fps,
            bitrate: Math.round(width * height * fps * _VIDEO_BITS_PER_PIXEL),
            bitrateMode: 'variable', latencyMode: 'quality',
        };
        if (codec.startsWith('avc1')) config.avc = {format: 'annexb'};
        try {
            if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
        } catch (e) { /* invalid for this browser, try the next */ }
    }
    return null;
}

const _decodeJpeg = (bytes) => createImageBitmap(new Blob([bytes], {type: 'image/jpeg'}));

/** Encodes the camera's buffered images from tMin on. Each frame keeps its
 * capture time: the encoder runs on microseconds since the first frame, and
 * every packet is mapped back to the exact image timestamp. Frames whose size
 * differs from the first one, or that do not decode, are skipped (counted).
 * Returns null when the camera has no images in the window. */
async function _encodeCamera(cam, tMin, progress, onProgress) {
    const store = cam.imageStore;
    // Snapshot: streaming keeps appending to (and evicting from) the store.
    const start = _firstIndexFrom(store.times, store.times.length, tMin);
    const allTimes = store.times.slice(start), allBlobs = store.blobs.slice(start);
    const times = [], blobs = [];
    allTimes.forEach((t, i) => {
        if (times.length === 0 || t > times[times.length - 1]) { times.push(t); blobs.push(allBlobs[i]); }
    });
    if (times.length === 0) return null;

    let first = null, firstIdx = 0;
    while (!first && firstIdx < blobs.length) {
        try { first = await _decodeJpeg(blobs[firstIdx]); } catch (e) { firstIdx++; }
    }
    if (!first) throw new Error('no decodable image');
    const srcW = first.width, srcH = first.height;
    // 4:2:0 video needs even dimensions: drop a last odd row / column.
    const width = srcW & ~1, height = srcH & ~1;
    const n = times.length;
    const span = times[n - 1] - times[firstIdx];
    const fps = n - firstIdx > 1 && span > 0 ? Math.min(Math.max((n - firstIdx - 1) / span, 1), 240) : 30;
    const config = await _pickVideoConfig(width, height, fps);
    if (!config) {
        first.close();
        throw new Error(`no supported video encoder for ${width}x${height}`);
    }

    const t0 = times[firstIdx];
    const timeOfUs = new Map();
    const packets = [];
    let encodeError = null;
    const encoder = new VideoEncoder({
        output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            packets.push({data, us: chunk.timestamp, key: chunk.type === 'key'});
        },
        error: (e) => { encodeError = e; },
    });
    encoder.configure(config);

    let skipped = firstIdx, lastKey = -Infinity;
    try {
        for (let i = firstIdx; i < n; i++) {
            if (progress.cancelled) throw new _ExportCancelled();
            if (encodeError) throw encodeError;
            let bitmap;
            if (i === firstIdx) bitmap = first;
            else {
                try { bitmap = await _decodeJpeg(blobs[i]); } catch (e) { skipped++; continue; }
            }
            if (bitmap.width !== srcW || bitmap.height !== srcH) {
                bitmap.close();
                skipped++;
                continue;
            }
            const us = Math.round((times[i] - t0) * 1e6);
            timeOfUs.set(us, times[i]);
            const frame = new VideoFrame(bitmap, {
                timestamp: us, visibleRect: {x: 0, y: 0, width, height}});
            const keyFrame = times[i] - lastKey >= _VIDEO_KEYFRAME_S;
            if (keyFrame) lastKey = times[i];
            encoder.encode(frame, {keyFrame});
            frame.close();
            bitmap.close();
            while (encoder.encodeQueueSize > _VIDEO_MAX_QUEUE) {
                await new Promise(resolve => setTimeout(resolve, 1));
            }
            if (i % 10 === 0) {
                onProgress((i + 1) / n);
                await _nextFrame();
            }
        }
        await encoder.flush();
        if (encodeError) throw encodeError;
    } finally {
        if (encoder.state !== 'closed') encoder.close();
    }
    onProgress(1);

    return {
        name: cam.name, codec: config.codec, width, height,
        bitrate: config.bitrate, frames_in: n, skipped,
        times: Float64Array.from(packets, p => timeOfUs.get(p.us) ?? t0 + p.us * 1e-6),
        keys: Uint8Array.from(packets, p => p.key ? 1 : 0),
        sizes: Uint32Array.from(packets, p => p.data.byteLength),
        packets: packets.map(p => p.data),
    };
}

/** Encodes every camera and appends it to the payload. A camera that fails
 * (no encoder, decode error) is reported in `failed` and left out. */
async function _collectVideoParts(cams, progress, payload, tMin, from, to) {
    const videos = [], failed = [];
    if (cams.length && typeof VideoEncoder === 'undefined') {
        cams.forEach(cam => failed.push({name: cam.name, error: 'WebCodecs VideoEncoder not available'}));
        return {videos, failed};
    }
    for (let ci = 0; ci < cams.length; ci++) {
        const cam = cams[ci];
        const share = (to - from) / cams.length;
        const onProgress = (f) => progress.update(
            from + share * (ci + f), `Encoding ${cam.name} (${ci + 1}/${cams.length}): ${Math.round(100 * f)}%`);
        let v;
        try {
            v = await _encodeCamera(cam, tMin, progress, onProgress);
        } catch (e) {
            if (e instanceof _ExportCancelled) throw e;
            console.error(`exportData: encoding ${cam.name} failed`, e);
            failed.push({name: cam.name, error: String(e)});
            continue;
        }
        if (!v || v.packets.length === 0) continue;
        const {times, keys, sizes, packets, ...meta} = v;
        const entry = {...meta, n: packets.length};
        entry.times_offset = payload.add(times);
        entry.sizes_offset = payload.add(sizes);
        entry.keys_offset = payload.add(keys);
        entry.data_offset = payload.add(...packets);
        entry.data_bytes = sizes.reduce((a, s) => a + s, 0);
        videos.push(entry);
    }
    return {videos, failed};
}

/** File start: magic, header length, version, then the JSON header. */
function _traceFileHead(contents, selection) {
    const header = new TextEncoder().encode(JSON.stringify({
        version: 2, session: currentSession.name, exported_at: new Date().toISOString(),
        endianness: 'little', selection, ...contents,
    }));
    // Pad the header so the payload starts 8-byte aligned in the file.
    const hpad = (8 - (16 + header.length) % 8) % 8;
    const pre = new Uint8Array(16);
    pre.set(new TextEncoder().encode('MDUTRACE'));
    const view = new DataView(pre.buffer);
    view.setUint32(8, header.length + hpad, true);
    view.setUint32(12, 2, true);
    const padded = new Uint8Array(header.length + hpad).fill(0x20);
    padded.set(header);
    return [pre, padded];
}

/** gzip of `parts`, fed in slices so the bar follows the compression (from
 * `from` to 1). */
async function _gzipParts(parts, progress, from) {
    const total = parts.reduce((a, p) => a + p.byteLength, 0);
    let partIdx = 0, partOffset = 0, fed = 0;
    const input = new ReadableStream({
        pull(controller) {
            if (progress.cancelled) {
                controller.error(new _ExportCancelled());
                return;
            }
            if (partIdx >= parts.length) {
                controller.close();
                return;
            }
            const p = parts[partIdx];
            const bytes = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
            const len = Math.min(_EXPORT_SLICE_BYTES, bytes.length - partOffset);
            // Copy: the stream may hold on to the chunk after pull returns.
            controller.enqueue(bytes.slice(partOffset, partOffset + len));
            partOffset += len;
            fed += len;
            if (partOffset >= bytes.length) { partIdx++; partOffset = 0; }
            progress.update(from + (1 - from) * fed / total,
                            `Compressing ${(fed / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB...`);
        }
    });

    const out = [];
    const reader = input.pipeThrough(new CompressionStream('gzip')).getReader();
    for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        out.push(value);
    }
    return {blob: new Blob(out, {type: 'application/gzip'}), rawBytes: total};
}

async function exportData() {
    const session = currentSession;
    const traces = session.traces;
    const cams = _exportCameras(session);
    const depthSources = _exportDepthSources();
    const hasTraces = traces.seriesData.size > 0;
    const hasScene = traces.staticData.size > 0;
    if (!hasTraces && cams.length === 0 && depthSources.length === 0 && !hasScene) {
        await customAlert('No data to export.');
        return;
    }
    const options = [
        {label: 'Traces', title: 'The time series (all, or those plotted for "Displayed")',
         checked: hasTraces, disabled: !hasTraces},
        ...cams.map(cam => ({label: `${cam.name} (video)`, checked: !disabledImageSources.has(cam.name),
                             title: 'Re-encode the buffered camera images as video (H.264 / VP9)'})),
        ...depthSources.map(pc => ({label: `${pc.name.replace(/^3d\//, '')} (depth)`,
                                    checked: !disabledPointClouds.has(pc.name),
                                    title: 'Raw depth frames (u16), their colour images (JPEG) and intrinsics'})),
        {label: '3D scene setup', checked: hasScene, disabled: !hasScene,
         title: 'The registered 3D objects (meshes, point cloud setups) and their 3d/... pose series'},
    ];
    const choice = await _dumpOptionsDialog(options);
    if (!choice) return;
    const checked = choice.checked;
    const withTraces = checked[0];
    const withScene = checked[checked.length - 1];
    const selCams = cams.filter((cam, i) => checked[1 + i]);
    const selDepth = depthSources.filter((pc, i) => checked[1 + cams.length + i]);
    if (!withTraces && !withScene && selCams.length === 0 && selDepth.length === 0) {
        await customAlert('Nothing selected to export.');
        return;
    }

    // Series to export: null = all. The scene setup brings its pose / colour series.
    let names = withTraces ? null : new Set();
    let tag = 'all';
    if (withTraces && choice.kind === 'displayed') {
        names = _displayedSeriesNames();
        tag = 'displayed';
    }
    if (withScene && names) {
        for (const name of traces.seriesData.keys()) if (name.startsWith('3d/')) names.add(name);
    }
    let tMin = -Infinity;
    if (choice.kind === 'minutes') {
        const stores = [...selCams.map(cam => cam.imageStore), ...selDepth.map(pc => pc.store)];
        tMin = _latestDataTime(traces, names, stores) - 60 * choice.minutes;
        tag = `last${choice.minutes}min`;
    }
    const selection = {kind: choice.kind, minutes: choice.minutes ?? null,
                       t_min: Number.isFinite(tMin) ? tMin : null,
                       series: names ? Array.from(names) : null, traces: withTraces,
                       cameras: selCams.map(cam => cam.name), depth: selDepth.map(pc => pc.name),
                       scene: withScene};

    const progress = _exportProgressDialog();
    let failed = [];
    try {
        const payload = new _PayloadWriter();
        const series = names && names.size === 0
            ? [] : await _collectTraceParts(traces, progress, payload, names, tMin);
        const depth = selDepth.map(pc => _collectDepthSource(pc, traces.staticData, payload, tMin))
            .filter(d => d);
        const sceneSetup = withScene ? _collectSceneSetup(traces, payload) : null;
        const videoTo = selCams.length ? _EXPORT_COLLECT_SHARE + _EXPORT_VIDEO_SHARE : _EXPORT_COLLECT_SHARE;
        const collected = await _collectVideoParts(
            selCams, progress, payload, tMin, _EXPORT_COLLECT_SHARE, videoTo);
        const videos = collected.videos;
        failed = collected.failed;
        if (series.length === 0 && videos.length === 0 && depth.length === 0 && !sceneSetup) {
            throw new Error('no samples in the selected range');
        }
        if (failed.length) selection.video_failed = failed;
        const {blob, rawBytes} = await _gzipParts(
            [..._traceFileHead({series, videos, depth, scene: sceneSetup}, selection), ...payload.parts],
            progress, videoTo);
        progress.update(1, 'Saving...');

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `export_${new Date().toISOString().replace(/[:.]/g, '-')}_${tag}.mdutrace.gz`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        const videoInfo = videos.map(v => `${v.name}: ${v.n} frames ${v.codec} ` +
                                     `${(v.data_bytes / 1e6).toFixed(1)} MB`).join(', ');
        console.log(`exportData: ${series.length} series, ${videos.length} videos` +
                    (videoInfo ? ` (${videoInfo})` : '') + `, ${depth.length} depth sources, ` +
                    `scene ${sceneSetup ? Object.keys(sceneSetup.objects).length + ' objects' : 'no'}, ` +
                    `${(rawBytes / 1e6).toFixed(1)} MB, gzip ${(blob.size / 1e6).toFixed(1)} MB -> ${a.download}`);
    } catch (e) {
        if (!(e instanceof _ExportCancelled)) {
            console.error('exportData failed', e);
            progress.close();
            await customAlert(`Export failed: ${e}`);
            return;
        }
        failed = [];
    } finally {
        progress.close();
    }
    if (failed.length) {
        await customAlert('Exported, but without the video of: ' +
                          failed.map(f => `${f.name} (${f.error})`).join(', '));
    }
}
