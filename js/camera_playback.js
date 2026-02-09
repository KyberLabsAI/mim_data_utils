class CameraPlayback {
    constructor(name, camerasContainer) {
        this.name = name;

        this.container = document.createElement('div');
        this.container.className = 'camera-panel';
        this.container.dataset.cameraName = name;

        let label = document.createElement('div');
        label.className = 'camera-label';
        label.textContent = name;

        this.videoEl = document.createElement('video');
        this.videoEl.muted = true;
        this.videoEl.playsInline = true;
        this.videoEl.style.display = 'none';

        this.imgEl = document.createElement('img');
        this.imgEl.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1920' height='1080'%3E%3Crect width='1920' height='1080' fill='%23888'/%3E%3Ctext x='960' y='540' text-anchor='middle' dominant-baseline='central' font-family='sans-serif' font-size='48' fill='%23fff'%3ENo Image%3C/text%3E%3C/svg%3E";

        this.container.appendChild(label);
        this.container.appendChild(this.videoEl);
        this.container.appendChild(this.imgEl);

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

        this.imageStore = new ImageStore(20000);
        this.videoStore = new VideoStore(this.videoEl, (tStart, tEnd) => {
            this.imageStore.evictRange(tStart, tEnd);
        });
    }

    addImage(time, payload) {
        this.imageStore.addFrame(time, payload);
    }

    addVideoSegment(msg) {
        this.videoStore.onSegmentAvailable(msg);
    }

    syncToTime(absTime) {
        if (this.videoStore.isVideoReadyForTime(absTime)) {
            this.videoEl.style.display = '';
            this.imgEl.style.display = 'none';
            this.videoStore.syncToTime(absTime);
        } else {
            this.videoEl.style.display = 'none';
            this.imgEl.style.display = '';
            let url = this.imageStore.getFrameAtTime(absTime);
            if (url && this.imgEl.src !== url) {
                this.imgEl.src = url;
            }
            if (this.videoStore.hasVideoForTime(absTime)) {
                this.videoStore.syncToTime(absTime);
            }
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
    }

    remove() {
        this.clear();
        this.container.remove();
    }
}
