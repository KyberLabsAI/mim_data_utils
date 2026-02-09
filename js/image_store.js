class ImageStore {
    constructor(maxFrames) {
        this.maxFrames = maxFrames || 5000;
        this.times = [];
        this.urls = [];
    }

    addFrame(time, binaryData) {
        let url = URL.createObjectURL(new Blob([binaryData], {type: 'image/jpeg'}));

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
            this.urls.splice(idx, 0, url);
        } else {
            this.times.push(time);
            this.urls.push(url);
        }

        // Evict oldest frames if over limit
        while (this.times.length > this.maxFrames) {
            URL.revokeObjectURL(this.urls[0]);
            this.times.shift();
            this.urls.shift();
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
        return this.urls[lo];
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

        for (let i = start; i < end; i++) {
            URL.revokeObjectURL(this.urls[i]);
        }
        this.times.splice(start, end - start);
        this.urls.splice(start, end - start);
    }

    clear() {
        this.urls.forEach(url => URL.revokeObjectURL(url));
        this.times = [];
        this.urls = [];
    }
}
