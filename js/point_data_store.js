class PointDataStore {
    constructor(maxFrames) {
        this.maxFrames = maxFrames || 200;
        this.times = [];
        this.depths = [];        // Uint8Array (raw u16 little-endian) views
        this.rgbBytes = [];      // Uint8Array of compressed JPEG bytes, or null
        this.depthScales = [];   // number or null (per-frame override)
        this.intrinsicsList = []; // object or null
    }

    addFrame(time, depthBytes, rgbBytes, depthScale, intrinsics) {
        // Keep the compressed RGB bytes; decoding is deferred to display time via
        // a shared JpegFrameDecoder (see PointCloud3D). Creating a Blob + object
        // URL here, per frame, churned the GC — the same bug as ImageStore had.
        const rgbVal = rgbBytes || null;
        const depthScaleVal = depthScale != null ? depthScale : null;
        const intrVal = intrinsics != null ? intrinsics : null;

        // Insert in sorted order (usually appending at end)
        let idx = this.times.length;
        if (idx > 0 && this.times[idx - 1] > time) {
            // Out-of-order: binary search for insertion point
            let lo = 0, hi = idx;
            while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (this.times[mid] < time) lo = mid + 1;
                else hi = mid;
            }
            idx = lo;
            this.times.splice(idx, 0, time);
            this.depths.splice(idx, 0, depthBytes);
            this.rgbBytes.splice(idx, 0, rgbVal);
            this.depthScales.splice(idx, 0, depthScaleVal);
            this.intrinsicsList.splice(idx, 0, intrVal);
        } else {
            this.times.push(time);
            this.depths.push(depthBytes);
            this.rgbBytes.push(rgbVal);
            this.depthScales.push(depthScaleVal);
            this.intrinsicsList.push(intrVal);
        }

        // Evict oldest frames if over limit
        while (this.times.length > this.maxFrames) {
            this.times.shift();
            this.depths.shift();
            this.rgbBytes.shift();
            this.depthScales.shift();
            this.intrinsicsList.shift();
        }
    }

    getFrameAtTime(time) {
        const times = this.times;
        const len = times.length;
        if (len === 0 || time < times[0]) return null;

        // Binary search: largest index where times[i] <= time
        let lo = 0, hi = len - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (times[mid] <= time) lo = mid;
            else hi = mid - 1;
        }
        return {
            time: times[lo],
            depth: this.depths[lo],
            rgbBytes: this.rgbBytes[lo],
            depthScale: this.depthScales[lo],
            intrinsics: this.intrinsicsList[lo],
        };
    }

    clear() {
        this.times = [];
        this.depths = [];
        this.rgbBytes = [];
        this.depthScales = [];
        this.intrinsicsList = [];
    }
}
