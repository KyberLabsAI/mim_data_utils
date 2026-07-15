class ImageStore {
    constructor(maxFrames) {
        this.maxFrames = maxFrames || 5000;
        this.times = [];
        this.blobs = [];   // Uint8Array of compressed JPEG bytes; decoded lazily on display.
    }

    addFrame(time, binaryData) {
        // Store only the compressed bytes. Previously this created a Blob + an
        // object URL for *every* received frame (30-60/s) and retained them for
        // the whole ring buffer, churning ArrayBuffers through the GC and
        // forcing the <img> element to re-decode on each src change. Decoding
        // now happens lazily, once per displayed frame (see CameraPlayback).

        // Insert in sorted order (usually appending at end since times are monotonic)
        let idx = this.times.length;
        if (idx > 0 && this.times[idx - 1] > time) {
            // Out-of-order: binary search for insertion point
            let lo = 0, hi = idx;
            while (lo < hi) {
                let mid = (lo + hi) >> 1;
                if (this.times[mid] < time) lo = mid + 1;
                else hi = mid;
            }
            idx = lo;
            this.times.splice(idx, 0, time);
            this.blobs.splice(idx, 0, binaryData);
        } else {
            this.times.push(time);
            this.blobs.push(binaryData);
        }

        // Evict oldest frames if over limit
        while (this.times.length > this.maxFrames) {
            this.times.shift();
            this.blobs.shift();
        }
    }

    getFrameAtTime(time) {
        let times = this.times;
        let len = times.length;
        if (len === 0 || time < times[0]) return null;

        // Binary search: largest index where times[i] <= time
        let lo = 0, hi = len - 1;
        while (lo < hi) {
            let mid = (lo + hi + 1) >> 1;
            if (times[mid] <= time) lo = mid;
            else hi = mid - 1;
        }
        // Return the frame's stable timestamp alongside its bytes so the
        // consumer can dedupe by time (index is not stable across eviction).
        return { time: times[lo], bytes: this.blobs[lo] };
    }

    evictRange(timeStart, timeEnd) {
        // Binary search for first index where time >= timeStart
        let lo = 0, hi = this.times.length;
        while (lo < hi) {
            let mid = (lo + hi) >> 1;
            if (this.times[mid] < timeStart) lo = mid + 1;
            else hi = mid;
        }
        let start = lo;

        // Binary search for last index where time <= timeEnd
        lo = start;
        hi = this.times.length - 1;
        while (lo < hi) {
            let mid = (lo + hi + 1) >> 1;
            if (this.times[mid] <= timeEnd) lo = mid;
            else hi = mid - 1;
        }

        if (start >= this.times.length || this.times[start] > timeEnd) return;
        let end = lo + 1;

        this.times.splice(start, end - start);
        this.blobs.splice(start, end - start);
    }

    clear() {
        this.times = [];
        this.blobs = [];
    }
}
