/**
 * JpegFrameDecoder — lazily decodes streamed JPEG frames, exactly once each.
 *
 * Camera playback and the point-cloud RGB overlay both receive a high-rate
 * stream of compressed JPEG frames and need the decoded result (a canvas blit,
 * or read-back pixels). Doing this by assigning every received frame to an
 * <img>.src via `URL.createObjectURL(new Blob(...))` churns a Blob + object URL
 * per frame through the GC and re-decodes on each src change.
 *
 * This centralises the churn-prone part so the fix lives in one place:
 *   - frames are stored as raw compressed bytes (see PointDataStore / ImageStore),
 *   - decoding is deferred until a frame is actually displayed,
 *   - frames are deduped by their (monotonic, eviction-stable) timestamp,
 *   - out-of-order async decodes are dropped via a token,
 *   - the decoded ImageBitmap is handed to `onFrame(bitmap)` and then closed,
 *     so nothing decoded is retained.
 */
class JpegFrameDecoder {
    /**
     * @param {(bitmap: ImageBitmap) => void} onFrame  Called with the decoded
     *   frame. The bitmap is closed immediately after this returns, so copy out
     *   whatever you need (e.g. drawImage / getImageData) synchronously.
     */
    constructor(onFrame) {
        this.onFrame = onFrame;
        this._shownTime = null;  // timestamp of the frame most recently requested
        this._token = 0;         // bumped per request to drop stale async decodes
    }

    /**
     * Decode and deliver the frame captured at `time`. No-op if that timestamp
     * is already the current one (dedupe across repeated render ticks).
     * @param {number} time
     * @param {Uint8Array} bytes  compressed JPEG bytes
     */
    request(time, bytes) {
        if (time === this._shownTime) return;
        this._shownTime = time;
        const token = ++this._token;
        createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
            .then(bitmap => {
                if (token !== this._token) {
                    bitmap.close();  // superseded by a newer frame
                    return;
                }
                try {
                    this.onFrame(bitmap);
                } finally {
                    bitmap.close();
                }
            })
            .catch(() => { /* ignore undecodable frames */ });
    }

    /** Forget the current frame and cancel any in-flight decode (e.g. on clear). */
    reset() {
        this._shownTime = null;
        this._token++;
    }
}
