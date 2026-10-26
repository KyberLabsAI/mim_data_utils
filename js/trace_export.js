/**
 * "Dump traces": download the time traces of the current session as one
 * gzip-compressed .mdutrace.gz file (read with mim_data_utils.load_mdutrace).
 *
 * File layout (before gzip, little-endian):
 *   'MDUTRACE' | u32 header length | u32 version (1) | JSON header (space padded
 *   to 8 bytes) | payload
 * The header lists per series {name, dim, n, times_offset, data_offset}, offsets
 * relative to the payload start and 8-byte aligned: n float64 times, then
 * dim * n float32 values, one column after the other.
 *
 * The button first asks what to dump: the last N minutes (of every series,
 * counted back from the newest sample), the series shown in the current layout
 * (all their buffered samples), or everything.
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

// Share of the bar for collecting the series; the rest is compression.
const _EXPORT_COLLECT_SHARE = 0.2;
// Compression input slice: small enough for a smooth bar, large enough that
// the per-slice overhead does not matter.
const _EXPORT_SLICE_BYTES = 1 << 20;

function _exportProgressDialog() {
    const overlay = _createOverlay();
    const dialog = document.createElement('div');
    dialog.className = 'custom-dialog';
    dialog.innerHTML = `
        <div class="msg">Dumping traces...</div>
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

/** Asks what to dump. Resolves to {kind: 'minutes', minutes} | {kind:
 * 'displayed'} | {kind: 'all'}, or null on cancel. */
function _dumpOptionsDialog() {
    return new Promise(resolve => {
        const overlay = _createOverlay();
        const dialog = document.createElement('div');
        dialog.className = 'custom-dialog';
        const minuteButtons = _DUMP_MINUTES.map(m =>
            `<button data-minutes="${m}">Last ${m} min</button>`).join('');
        dialog.innerHTML = `
            <div class="msg">Dump which traces?</div>
            <div class="dump-options">
                ${minuteButtons}
                <button data-kind="displayed" title="The series plotted in the current layout, all buffered samples">Displayed traces</button>
                <button data-kind="all">All</button>
            </div>
            <div class="buttons">
                <button class="cancel-btn">Cancel</button>
            </div>
        `;
        overlay.appendChild(dialog);
        const finish = (choice) => { overlay.remove(); resolve(choice); };
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

/** Newest sample time over all series. */
function _latestTraceTime(traces) {
    let t = -Infinity;
    for (const s of traces.seriesData.values()) {
        const c = s.chunks[s.chunks.length - 1];
        if (c && c.entries > 0) t = Math.max(t, c.times[c.entries - 1]);
    }
    return t;
}

/** First entry of `c` with time >= tMin (c.entries if none). */
function _firstEntryFrom(c, tMin) {
    let lo = 0, hi = c.entries;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (c.times[mid] < tMin) lo = mid + 1; else hi = mid;
    }
    return lo;
}

const _nextFrame = () => new Promise(resolve => setTimeout(resolve, 0));

class _ExportCancelled extends Error {}

/** Copies every series out of the chunked ring buffers. One series at a time
 * so the dialog can redraw in between; a single series is copied in one go,
 * so streaming data cannot evict a chunk halfway through it. */
async function _collectTraceParts(traces, progress, names = null, tMin = -Infinity) {
    const series = [];
    const parts = [];
    let offset = 0;
    const pad8 = () => {
        const p = (8 - offset % 8) % 8;
        if (p) { parts.push(new Uint8Array(p)); offset += p; }
    };

    const all = Array.from(traces.seriesData).filter(([name]) => !names || names.has(name));
    for (let i = 0; i < all.length; i++) {
        if (progress.cancelled) throw new _ExportCancelled();
        const [name, s] = all[i];
        // Per chunk the first entry inside the window; chunks are in time order.
        const starts = s.chunks.map(c => _firstEntryFrom(c, tMin));
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
            pad8();
            const entry = {name, dim: s.dim, n, times_offset: offset};
            parts.push(times); offset += times.byteLength;
            entry.data_offset = offset;
            parts.push(data); offset += data.byteLength;
            series.push(entry);
        }
        progress.update(_EXPORT_COLLECT_SHARE * (i + 1) / all.length,
                        `Collecting traces (${i + 1}/${all.length})...`);
        await _nextFrame();
    }
    return {series, parts};
}

function _traceFileHead(series, selection) {
    const header = new TextEncoder().encode(JSON.stringify({
        version: 1, session: currentSession.name, exported_at: new Date().toISOString(),
        endianness: 'little', selection, series,
    }));
    // Pad the header so the payload starts 8-byte aligned in the file.
    const hpad = (8 - (16 + header.length) % 8) % 8;
    const pre = new Uint8Array(16);
    pre.set(new TextEncoder().encode('MDUTRACE'));
    const view = new DataView(pre.buffer);
    view.setUint32(8, header.length + hpad, true);
    view.setUint32(12, 1, true);
    const padded = new Uint8Array(header.length + hpad).fill(0x20);
    padded.set(header);
    return [pre, padded];
}

/** gzip of `parts`, fed in slices so the bar follows the compression. */
async function _gzipParts(parts, progress) {
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
            progress.update(_EXPORT_COLLECT_SHARE + (1 - _EXPORT_COLLECT_SHARE) * fed / total,
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

async function dumpTraces() {
    const traces = currentSession.traces;
    if (traces.seriesData.size === 0) {
        await customAlert('No traces to dump.');
        return;
    }
    const choice = await _dumpOptionsDialog();
    if (!choice) return;
    let names = null, tMin = -Infinity, tag = 'all';
    if (choice.kind === 'minutes') {
        tMin = _latestTraceTime(traces) - 60 * choice.minutes;
        tag = `last${choice.minutes}min`;
    } else if (choice.kind === 'displayed') {
        names = _displayedSeriesNames();
        tag = 'displayed';
        if (names.size === 0) {
            await customAlert('No traces are displayed.');
            return;
        }
    }
    const selection = {kind: choice.kind, minutes: choice.minutes ?? null,
                       t_min: Number.isFinite(tMin) ? tMin : null,
                       series: names ? Array.from(names) : null};

    const progress = _exportProgressDialog();
    try {
        const {series, parts} = await _collectTraceParts(traces, progress, names, tMin);
        if (series.length === 0) throw new Error('no samples in the selected range');
        const {blob, rawBytes} = await _gzipParts([..._traceFileHead(series, selection), ...parts], progress);
        progress.update(1, 'Saving...');

        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `traces_${new Date().toISOString().replace(/[:.]/g, '-')}_${tag}.mdutrace.gz`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        console.log(`dumpTraces: ${series.length} series, ${(rawBytes / 1e6).toFixed(1)} MB, ` +
                    `gzip ${(blob.size / 1e6).toFixed(1)} MB -> ${a.download}`);
    } catch (e) {
        if (!(e instanceof _ExportCancelled)) {
            console.error('dumpTraces failed', e);
            progress.close();
            await customAlert(`Dumping traces failed: ${e}`);
            return;
        }
    } finally {
        progress.close();
    }
}
