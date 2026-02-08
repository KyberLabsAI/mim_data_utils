class VideoStore {
    constructor(videoElement, onSegmentLoaded) {
        this.video = videoElement;
        this.onSegmentLoaded = onSegmentLoaded || (() => {});
        this.segments = [];      // [{file, time_start, time_end, fps, frameToTime, frameOffset, loaded, _pendingLoad}]
        this.initFile = null;
        this.baseUrl = null;
        this.maxBufferedDuration = 300; // 5 minutes

        this.mediaSource = null;
        this.sourceBuffer = null;
        this.objectUrl = null;
        this.initLoaded = false;

        this._appendQueue = [];
        this._appending = false;
        this._currentSegment = null;
        this._abortController = new AbortController();

        this._setupMediaSource();
    }

    _setupMediaSource() {
        this.mediaSource = new MediaSource();
        this.objectUrl = URL.createObjectURL(this.mediaSource);
        this.video.src = this.objectUrl;

        this.mediaSource.addEventListener('sourceopen', () => {
            if (this.sourceBuffer) return;
            this.sourceBuffer = this.mediaSource.addSourceBuffer(
                'video/mp4; codecs="avc1.42E01E"'
            );
            this.sourceBuffer.addEventListener('updateend', () => {
                this._appending = false;
                if (this._currentSegment) {
                    let seg = this._currentSegment;
                    this._currentSegment = null;
                    seg.loaded = true;
                    this.onSegmentLoaded(seg.time_start, seg.time_end);
                }
                this._processQueue();
            });
            this._loadInitSegment();
        });
    }

    _loadInitSegment() {
        if (!this.initFile || !this.baseUrl || this.initLoaded) return;
        let url = `http://127.0.0.1:8000/${this.baseUrl}${this.initFile}`;
        fetch(url, {signal: this._abortController.signal})
            .then(r => r.arrayBuffer())
            .then(buf => {
                this.initLoaded = true;
                this._enqueueAppend(buf);
            })
            .catch(e => {
                if (e.name !== 'AbortError') console.warn('VideoStore: failed to load init segment', e);
            });
    }

    _enqueueAppend(buffer, segment) {
        this._appendQueue.push({buffer, segment});
        this._processQueue();
    }

    _processQueue() {
        if (this._appending || this._appendQueue.length === 0) return;
        if (!this.sourceBuffer || this.sourceBuffer.updating) return;
        if (!this.mediaSource || this.mediaSource.readyState !== 'open') return;
        this._appending = true;
        let item = this._appendQueue.shift();
        this._currentSegment = item.segment || null;
        try {
            this.sourceBuffer.appendBuffer(item.buffer);
        } catch (e) {
            console.warn('VideoStore: appendBuffer error', e);
            this._currentSegment = null;
            this._appending = false;
            this._processQueue();
        }
    }

    onSegmentAvailable(msg) {
        let segData = msg.segment;
        if (!this.initFile && msg.init_file) {
            this.initFile = msg.init_file;
        }
        if (!this.baseUrl && msg.base_url) {
            this.baseUrl = msg.base_url;
        }

        // Check for duplicate
        for (let i = 0; i < this.segments.length; i++) {
            if (this.segments[i].file === segData.file) return;
        }

        let frameToTime = segData.frame_to_time || null;
        let frameOffset = segData.frame_offset || 0;
        let numFrames = frameToTime ? frameToTime.length : 0;

        let seg = {
            file: segData.file,
            time_start: segData.time_start,
            time_end: segData.time_end,
            fps: segData.fps,
            frameToTime: frameToTime,
            frameOffset: frameOffset,
            videoTimeStart: frameOffset / segData.fps,
            videoTimeEnd: (frameOffset + numFrames) / segData.fps,
            loaded: false,
            _pendingLoad: false
        };
        console.log('Segment available: ', seg.time_start, seg.time_end, seg);

        // Insert sorted by time_start
        let idx = this.segments.length;
        if (idx > 0 && this.segments[idx - 1].time_start > seg.time_start) {
            let lo = 0, hi = idx;
            while (lo < hi) {
                let mid = (lo + hi) >> 1;
                if (this.segments[mid].time_start < seg.time_start) lo = mid + 1;
                else hi = mid;
            }
            idx = lo;
            this.segments.splice(idx, 0, seg);
        } else {
            this.segments.push(seg);
        }

        // Try loading init if we now have the info and source buffer is ready
        if (this.sourceBuffer && !this.initLoaded) {
            this._loadInitSegment();
        }
    }

    // Convert absolute timestamp to video presentation time using frame_to_time mapping.
    // Returns null if no segment covers this time or frameToTime is not available.
    _absTimeToVideoTime(absTime) {
        let seg = this._segmentForTime(absTime);
        if (!seg || !seg.frameToTime || seg.frameToTime.length === 0) return null;

        let ftt = seg.frameToTime;

        // Binary search for the largest frame index where frameToTime[i] <= absTime
        let lo = 0, hi = ftt.length - 1;
        while (lo < hi) {
            let mid = (lo + hi + 1) >> 1;
            if (ftt[mid] <= absTime) lo = mid;
            else hi = mid - 1;
        }

        return (seg.frameOffset + lo) / seg.fps;
    }

    _segmentForTime(absTime) {
        for (let i = 0; i < this.segments.length; i++) {
            let s = this.segments[i];
            if (absTime >= s.time_start && absTime <= s.time_end) return s;
        }
        return null;
    }

    _findSegmentIndexForTime(absTime) {
        for (let i = 0; i < this.segments.length; i++) {
            let s = this.segments[i];
            if (absTime >= s.time_start && absTime <= s.time_end) return i;
        }
        return -1;
    }

    hasVideoForTime(absTime) {
        return this._segmentForTime(absTime) !== null;
    }

    isVideoReadyForTime(absTime) {
        let seg = this._segmentForTime(absTime);
        return seg !== null && seg.loaded && seg.frameToTime !== null;
    }

    syncToTime(absTime) {
        if (this.segments.length === 0) return;

        let seg = this._loadSegmentIfNeeded(absTime);

        let videoTime = this._absTimeToVideoTime(absTime);
        if (videoTime === null) return;

        let delta = Math.abs(this.video.currentTime - videoTime);
        if (delta > 0.04) {
            this.video.currentTime = videoTime;
        }

        return seg;
    }

    _loadSegmentIfNeeded(absTime) {
        if (!this.initLoaded || !this.sourceBuffer) return;

        this._evictIfNeeded(absTime);

        let idx = this._findSegmentIndexForTime(absTime);
        if (idx >= 0) {
            let seg = this.segments[idx];
            if (!seg.loaded && !seg._pendingLoad) {
                this._fetchAndAppend(seg);
            }
            // Preload next segment
            if (idx + 1 < this.segments.length) {
                let next = this.segments[idx + 1];
                if (!next.loaded && !next._pendingLoad) {
                    this._fetchAndAppend(next);
                }
            }
            return seg;
        } else {
            return null;
        }
    }

    _fetchAndAppend(seg) {
        seg._pendingLoad = true;
        let url = `http://127.0.0.1:8000/${this.baseUrl}${seg.file}`;
        fetch(url, {signal: this._abortController.signal})
            .then(r => r.arrayBuffer())
            .then(buf => {
                this._enqueueAppend(buf, seg);
            })
            .catch(e => {
                if (e.name === 'AbortError') return;
                seg._pendingLoad = false;
                console.warn('VideoStore: failed to load segment', seg.file, e);
            });
    }

    _evictIfNeeded(absTime) {
        let totalLoaded = 0;
        for (let i = 0; i < this.segments.length; i++) {
            if (this.segments[i].loaded) {
                totalLoaded += this.segments[i].time_end - this.segments[i].time_start;
            }
        }

        while (totalLoaded > this.maxBufferedDuration) {
            // Find loaded segment furthest from current time
            let worstIdx = -1;
            let worstDist = -1;
            for (let i = 0; i < this.segments.length; i++) {
                let s = this.segments[i];
                if (!s.loaded) continue;
                let mid = (s.time_start + s.time_end) / 2;
                let dist = Math.abs(mid - absTime);
                if (dist > worstDist) {
                    worstDist = dist;
                    worstIdx = i;
                }
            }
            if (worstIdx < 0) break;

            let evict = this.segments[worstIdx];
            try {
                if (!this.sourceBuffer.updating) {
                    this.sourceBuffer.remove(evict.videoTimeStart, evict.videoTimeEnd);
                }
            } catch (e) {
                console.warn('VideoStore: remove error', e);
            }
            evict.loaded = false;
            evict._pendingLoad = false;
            totalLoaded -= (evict.time_end - evict.time_start);
        }
    }

    loadExistingSegments() {
        return fetch('http://127.0.0.1:8000/recordings/timestamps.json', {signal: this._abortController.signal})
            .then(r => {
                if (!r.ok) throw new Error('No timestamps.json found');
                return r.json();
            })
            .then(data => {
                if (!data.segments) return;
                // Fetch each segment's JSON to get frame_to_time mapping
                let promises = data.segments.map((s, i) => {
                    let jsonFile = s.file.replace('.mp4', '.json');
                    return fetch(`http://127.0.0.1:8000/recordings/${jsonFile}`, {signal: this._abortController.signal})
                        .then(r => r.ok ? r.json() : null)
                        .catch(e => { if (e.name !== 'AbortError') return null; })
                        .then(segJson => {
                            if (!segJson) return;
                            this.onSegmentAvailable({
                                type: 'video_segment',
                                name: 'camera',
                                segment: {
                                    file: s.file,
                                    time_start: s.time_start,
                                    time_end: s.time_end,
                                    fps: segJson.fps || data.fps,
                                    frame_offset: segJson.frame_offset || 0,
                                    frame_to_time: segJson.frame_to_time || null
                                },
                                init_file: 'init.mp4',
                                base_url: 'recordings/'
                            });
                        });
                });
                return Promise.all(promises);
            })
            .catch(e => {
                if (e.name !== 'AbortError') console.warn('VideoStore: no existing segments', e);
            });
    }

    clear() {
        // Cancel all in-flight fetches
        this._abortController.abort();
        this._abortController = new AbortController();

        this.segments = [];
        this.initLoaded = false;
        this._appendQueue = [];
        this._appending = false;
        this._currentSegment = null;

        if (this.sourceBuffer) {
            try {
                this.mediaSource.removeSourceBuffer(this.sourceBuffer);
            } catch (e) {}
            this.sourceBuffer = null;
        }
        if (this.objectUrl) {
            URL.revokeObjectURL(this.objectUrl);
            this.objectUrl = null;
        }
        this.mediaSource = null;

        this._setupMediaSource();
    }
}
