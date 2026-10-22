// Image overlays (Logger.log_overlay) are shown as images of their own: one
// OverlayView panel per (image source, overlay name), placed right after the
// source's panel. It draws the source's frame with only that overlay; just the
// overlay PNG is transmitted, the frame comes from the source's ImageStore.

// "Live view" of an overlay image (per source setting liveView): the overlay
// image shows the newest frame that has its overlay, which trails the camera
// (overlays are rendered after their image); a corner mode adds the newest
// frame of the source as a small picture-in-picture in that corner.
const LIVE_VIEW_MODES = [
    ['none', 'None'],
    ['top_left', 'Top left'], ['top_right', 'Top right'],
    ['bottom_left', 'Bottom left'], ['bottom_right', 'Bottom right'],
];
// Picture-in-picture live view: width relative to the shown image, margin [px].
const LIVE_PIP_SCALE = 0.3;
const LIVE_PIP_MARGIN = 6;
// Overlays usually exist only for some frames (e.g. AprilTags at the detector
// rate), so an overlay image shows the newest frame that has its overlay,
// looking back at most this far [s] before falling back to the plain frame.
const OVERLAY_FRAME_MAX_AGE_S = 1.0;

/** Panel / settings name of the overlay image `overlay` of image source `source`. */
function overlayViewName(source, overlay) {
    return `${source} / ${overlay}`;
}

/** A camera panel: div.camera-panel with a label and an image canvas whose
 *  frames come from a JpegFrameDecoder (onFrame also gets called). */
function makeImagePanel(name, onFrame) {
    const container = document.createElement('div');
    container.className = 'camera-panel';
    container.dataset.cameraName = name;
    const label = document.createElement('div');
    label.className = 'camera-label';
    label.textContent = name;
    container.appendChild(label);
    // Frames are drawn onto a canvas via ImageBitmap rather than assigned to an
    // <img> src. This avoids a Blob + object URL per frame and lets us decode
    // each displayed frame exactly once (via the shared JpegFrameDecoder).
    const canvas = document.createElement('canvas');
    canvas.className = 'camera-canvas';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    const decoder = new JpegFrameDecoder(bitmap => {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
        }
        ctx.drawImage(bitmap, 0, 0);
        if (onFrame) onFrame(bitmap);
    });
    return { container, canvas, ctx, decoder };
}

class CameraPlayback {
    constructor(name, camerasContainer) {
        this.name = name;
        this.camerasContainer = camerasContainer;

        const panel = makeImagePanel(name);
        this.container = panel.container;
        this.canvasEl = panel.canvas;
        this.ctx = panel.ctx;
        this.decoder = panel.decoder;

        this.videoEl = document.createElement('video');
        this.videoEl.muted = true;
        this.videoEl.playsInline = true;
        this.videoEl.style.display = 'none';
        this.container.insertBefore(this.videoEl, this.canvasEl);

        // Insert sorted by name
        let inserted = false;
        for (let child of camerasContainer.children) {
            if (child.dataset.cameraName > name) {
                camerasContainer.insertBefore(this.container, child);
                inserted = true;
                break;
            }
        }
        if (!inserted) camerasContainer.appendChild(this.container);

        this.imageStore = new ImageStore(1000);
        this.videoStore = new VideoStore(this.videoEl, (tStart, tEnd) => {
            this.imageStore.evictRange(tStart, tEnd);
        });

        this.overlays = new OverlayStore(1000);
        this.overlayViews = new Map();   // overlay name -> OverlayView
        // Called with each new OverlayView (set by main.js: visibility, settings).
        this.onOverlayView = null;
    }

    /** Show or hide the source's own image. */
    setShown(shown) {
        this.container.style.display = shown ? '' : 'none';
    }

    /** Hide the source's image and all its overlay images (session switch). */
    hideAll() {
        this.setShown(false);
        this.overlayViews.forEach(v => v.setShown(false));
    }

    addImage(time, payload, number) {
        this.imageStore.addFrame(time, payload, number);
    }

    addOverlay(overlayName, number, time, payload, offset, isStatic) {
        if (isStatic) this.overlays.addStatic(overlayName, time, payload, offset);
        else this.overlays.add(overlayName, number, time, payload, offset);
        if (!this.overlayViews.has(overlayName)) {
            const view = new OverlayView(this, overlayName);
            this.overlayViews.set(overlayName, view);
            if (this.onOverlayView) this.onOverlayView(view);
        }
    }

    addVideoSegment(msg) {
        this.videoStore.onSegmentAvailable(msg);
    }

    /** Show the frame at `absTime`. */
    syncToTime(absTime) {
        if (this.videoStore.isVideoReadyForTime(absTime)) {
            this.videoEl.style.display = '';
            this.canvasEl.style.display = 'none';
            this.videoStore.syncToTime(absTime);
        } else {
            this.videoEl.style.display = 'none';
            this.canvasEl.style.display = '';
            let frame = this.imageStore.getFrameAtTime(absTime);
            if (frame) {
                this.decoder.request(frame.time, frame.bytes);
            }
            if (this.videoStore.hasVideoForTime(absTime)) {
                this.videoStore.syncToTime(absTime);
            }
        }

        // Debug: log image store status periodically
        if (!this._debugLastPrint || performance.now() - this._debugLastPrint > 2000) {
            this._debugLastPrint = performance.now();
            let store = this.imageStore;
            let newestImg = store.times.length > 0 ? store.times[store.times.length - 1] : null;
            let oldestImg = store.times.length > 0 ? store.times[0] : null;
            let imgGap = newestImg != null ? (absTime - newestImg) : null;
            console.log(
                `[sync-debug:${this.name}] absTime=${absTime?.toFixed(3)} ` +
                `| store: ${store.times.length} frames, ` +
                `oldest=${oldestImg?.toFixed(3)} newest=${newestImg?.toFixed(3)} ` +
                `| gap(absTime-newest)=${imgGap?.toFixed(3)}s ` +
                `| using=${this.videoEl.style.display === '' ? 'video' : 'image'}`
            );
        }
    }

    loadExistingSegments(baseUrl) {
        return fetch(`http://127.0.0.1:8000/${baseUrl}timestamps.json`)
            .then(r => {
                if (!r.ok) throw new Error('No timestamps.json found');
                return r.json();
            })
            .then(data => {
                if (!data.segments) return;
                let promises = data.segments.map(s => {
                    let jsonFile = s.file.replace('.mp4', '.json');
                    return fetch(`http://127.0.0.1:8000/${baseUrl}${jsonFile}`)
                        .then(r => r.ok ? r.json() : null)
                        .catch(() => null)
                        .then(segJson => {
                            if (!segJson) return;
                            this.videoStore.onSegmentAvailable({
                                type: 'video_segment',
                                name: this.name,
                                segment: {
                                    file: s.file,
                                    time_start: s.time_start,
                                    time_end: s.time_end,
                                    fps: segJson.fps || data.fps,
                                    frame_offset: segJson.frame_offset || 0,
                                    frame_to_time: segJson.frame_to_time || null
                                },
                                init_file: 'init.mp4',
                                base_url: baseUrl
                            });
                        });
                });
                return Promise.all(promises);
            })
            .catch(e => {
                console.warn(`CameraPlayback(${this.name}): no existing segments`, e);
            });
    }

    clear() {
        this.imageStore.clear();
        this.videoStore.clear();
        this.decoder.reset();  // cancel any in-flight decode
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
        }
        this.overlays.clear();
        this.overlayViews.forEach(v => v.clear());
    }

    remove() {
        this.clear();
        this.container.remove();
        this.overlayViews.forEach(v => v.remove());
        this.overlayViews.clear();
    }
}

/**
 * Image of one overlay of an image source: the source's frame with that
 * overlay drawn over it (the newest frame that has it), optionally with the
 * live frame as a picture-in-picture.
 */
class OverlayView {
    constructor(source, overlayName) {
        this.source = source;
        this.overlayName = overlayName;
        this.name = overlayViewName(source.name, overlayName);

        const panel = makeImagePanel(this.name, () => {
            // Only the newest request is ever delivered (stale decodes are
            // dropped), so the frame drawn is the one requested last.
            this.shownKey = this._requestedKey;
            this.shownTime = this._requestedTime;
        });
        this.container = panel.container;
        this.container.classList.add('overlay-panel');
        this.canvasEl = panel.canvas;
        this.decoder = panel.decoder;
        this.shownKey = null;        // OverlayStore.frameKey of the drawn frame
        this.shownTime = null;       // and its time (picks a static overlay's version)
        this._requestedKey = null;
        this._requestedTime = null;

        // The overlay goes on a transparent canvas of the image's pixel size
        // stacked over the image canvas; both are scaled by the same CSS
        // (object-fit: contain), so they stay aligned.
        this.overlayEl = document.createElement('canvas');
        this.overlayEl.className = 'camera-overlay';
        this.overlayCtx = this.overlayEl.getContext('2d');
        this.container.appendChild(this.overlayEl);
        this._overlaySig = null;
        this._bitmap = null;         // {key, bitmap, failed} of the shown overlay PNG

        // Live picture-in-picture: own decoder and canvas.
        this.liveMode = 'none';
        this.liveCanvas = document.createElement('canvas');
        this.liveCanvas.className = 'camera-pip';
        this.liveCanvas.style.display = 'none';
        this.liveCtx = this.liveCanvas.getContext('2d');
        this.liveDecoder = new JpegFrameDecoder(bitmap => {
            if (this.liveCanvas.width !== bitmap.width ||
                this.liveCanvas.height !== bitmap.height) {
                this.liveCanvas.width = bitmap.width;
                this.liveCanvas.height = bitmap.height;
            }
            this.liveCtx.drawImage(bitmap, 0, 0);
        });
        this.container.appendChild(this.liveCanvas);
        this._pipSig = null;

        // Live view setting of the source (shown on hover). Edits the config
        // given to syncToolbar and calls onSettingsChange().
        this.toolbar = document.createElement('div');
        this.toolbar.className = 'camera-toolbar';
        this._toolbarSig = null;
        this.onSettingsChange = null;
        this.container.appendChild(this.toolbar);

        // Right after the source's panel and its other overlay images (by name).
        let after = source.container;
        const prefix = source.name + ' / ';
        for (let el = after.nextElementSibling; el; el = el.nextElementSibling) {
            const n = el.dataset.cameraName || '';
            if (!n.startsWith(prefix) || n > this.name) break;
            after = el;
        }
        after.after(this.container);
    }

    setShown(shown) {
        this.container.style.display = shown ? '' : 'none';
    }

    /**
     * Show the newest frame at or before `absTime` that has this overlay
     * (falling back to the plain frame) with the overlay over it; `liveMode`
     * adds the frame at `absTime` in a corner. A static overlay is on every
     * frame: it shows the frame at `absTime` with the version valid then.
     */
    sync(absTime, liveMode) {
        const src = this.source;
        const t = absTime;
        const name = this.overlayName;
        let frame = null;
        if (!src.overlays.isStatic(name)) {
            frame = src.imageStore.findFrameAtOrBefore(t, (number, time) =>
                src.overlays.get(name, OverlayStore.frameKey(number, time)) !== undefined,
                OVERLAY_FRAME_MAX_AGE_S);
        }
        if (!frame) frame = src.imageStore.getFrameAtTime(t);
        if (frame) {
            this._requestedKey = OverlayStore.frameKey(frame.number, frame.time);
            this._requestedTime = frame.time;
            this.decoder.request(frame.time, frame.bytes);
        }
        this._syncOverlay();
        this._syncLive(liveMode, absTime);
    }

    /** Draw the overlay of the shown frame; the previous drawing stays until
     *  the new PNG is decoded (no blank frames). A static overlay's PNG is
     *  decoded once per version and kept while the frames change. */
    _syncOverlay() {
        const overlays = this.source.overlays;
        let key, entry;
        if (overlays.isStatic(this.overlayName)) {
            entry = this.shownKey == null ? undefined
                : overlays.getStatic(this.overlayName, this.shownTime);
            key = entry ? 's' + entry.id : null;
        } else {
            key = this.shownKey;
            entry = key == null ? undefined : overlays.get(this.overlayName, key);
        }
        const w = this.canvasEl.width, h = this.canvasEl.height;
        const sig = `${key}|${entry ? 1 : 0}|${w}x${h}`;
        if (sig === this._overlaySig) return;

        let slot = this._bitmap;
        if (slot && slot.key !== key) {
            if (slot.bitmap) slot.bitmap.close();
            slot = this._bitmap = null;
        }
        if (entry && entry.bytes && !slot) {
            slot = this._bitmap = { key, bitmap: null, failed: false };
            createImageBitmap(new Blob([entry.bytes], { type: 'image/png' }))
                .then(bitmap => {
                    if (this._bitmap === slot) slot.bitmap = bitmap;
                    else bitmap.close();  // frame changed meanwhile
                })
                .catch(() => { slot.failed = true; });
        }
        if (slot && !slot.bitmap && !slot.failed) return;  // retried next frame

        this._overlaySig = sig;
        if (this.overlayEl.width !== w || this.overlayEl.height !== h) {
            this.overlayEl.width = w;
            this.overlayEl.height = h;
        }
        this.overlayCtx.clearRect(0, 0, w, h);
        if (slot && slot.bitmap) {
            this.overlayCtx.drawImage(slot.bitmap, entry.offset[0], entry.offset[1]);
        }
    }

    _syncLive(mode, absTime) {
        if (mode !== this.liveMode) {
            this.liveMode = mode;
            this._pipSig = null;
            this.liveDecoder.reset();
        }
        const show = mode !== 'none' && LIVE_VIEW_MODES.some(([m]) => m === mode);
        this.liveCanvas.style.display = show ? '' : 'none';
        if (!show) return;
        const frame = this.source.imageStore.getFrameAtTime(absTime);
        if (frame) this.liveDecoder.request(frame.time, frame.bytes);
        this._positionPip(mode);
    }

    /** Place the picture-in-picture in `corner` of the image as displayed
     *  (object-fit: contain letterboxes it inside the panel). */
    _positionPip(corner) {
        const el = this.canvasEl;
        const iw = el.width, ih = el.height;
        const lw = this.liveCanvas.width, lh = this.liveCanvas.height;
        const cw = el.clientWidth, ch = el.clientHeight;
        const sig = `${corner}|${iw}x${ih}|${lw}x${lh}|${cw}x${ch}|${el.offsetLeft},${el.offsetTop}`;
        if (sig === this._pipSig) return;
        this._pipSig = sig;
        if (!iw || !ih || !cw || !ch || !lw || !lh) return;
        const scale = Math.min(cw / iw, ch / ih);
        const dw = iw * scale, dh = ih * scale;
        const ox = el.offsetLeft + (cw - dw) / 2, oy = el.offsetTop + (ch - dh) / 2;
        const pw = dw * LIVE_PIP_SCALE, ph = pw * lh / lw;
        const m = LIVE_PIP_MARGIN;
        const left = corner.endsWith('left') ? ox + m : ox + dw - pw - m;
        const top = corner.startsWith('top') ? oy + m : oy + dh - ph - m;
        Object.assign(this.liveCanvas.style, {
            left: `${left}px`, top: `${top}px`, width: `${pw}px`, height: `${ph}px`,
        });
    }

    /** Live view dropdown for the source's `cfg` = {liveView}. */
    syncToolbar(cfg) {
        const sig = `${cfg.liveView || 'none'}`;
        if (sig === this._toolbarSig) return;
        this._toolbarSig = sig;
        const changed = () => {
            this._toolbarSig = null;
            if (this.onSettingsChange) this.onSettingsChange();
        };
        this.toolbar.innerHTML = '';
        const label = document.createElement('label');
        label.appendChild(document.createTextNode('Live view '));
        label.appendChild(makeLiveViewSelect(cfg.liveView, mode => {
            cfg.liveView = mode;
            changed();
        }));
        this.toolbar.appendChild(label);
    }

    clear() {
        this.decoder.reset();
        this.liveDecoder.reset();
        if (this._bitmap && this._bitmap.bitmap) this._bitmap.bitmap.close();
        this._bitmap = null;
        this.shownKey = this._requestedKey = this._overlaySig = null;
        this.shownTime = this._requestedTime = null;
        this.overlayCtx.clearRect(0, 0, this.overlayEl.width, this.overlayEl.height);
        this.liveCtx.clearRect(0, 0, this.liveCanvas.width, this.liveCanvas.height);
        this._toolbarSig = null;
    }

    remove() {
        this.clear();
        this.container.remove();
    }
}

/** <select> of LIVE_VIEW_MODES; `onChange(mode)` on selection. */
function makeLiveViewSelect(current, onChange) {
    const select = document.createElement('select');
    LIVE_VIEW_MODES.forEach(([value, text]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        select.appendChild(opt);
    });
    select.value = LIVE_VIEW_MODES.some(([m]) => m === current) ? current : 'none';
    select.addEventListener('change', () => onChange(select.value));
    return select;
}
