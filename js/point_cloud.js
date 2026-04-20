/**
 * PointCloud3D — a scene object that renders a depth-image derived point cloud.
 *
 * Receives a static registration payload with intrinsics and material via
 * `new PointCloud3D(payload)`. Depth frames are pushed via `addFrame()` into
 * an internal PointDataStore. Each render tick, Scene3D calls `syncToTime`
 * which picks the nearest frame <= time, unprojects depth to XYZ using the
 * pinhole model, and optionally decodes JPEG RGB to colour the points.
 *
 * The root THREE.Object3D returned by getObject() is moved by Scene3D's
 * usual per-tick pose-update (from `3d/<name>/pos` samples), so moving the
 * depth camera origin in the world is just `scene.update_pos(name, pose)`.
 */
class PointCloud3D {
    constructor(payload) {
        // payload.name is already the '3d/<user-name>' key.
        this.name = payload.name;
        this.width = payload.width;
        this.height = payload.height;
        this.fx = payload.fx;
        this.fy = payload.fy;
        this.cx = payload.cx;
        this.cy = payload.cy;
        this.depthScale = payload.depth_scale;
        this.stride = Math.max(1, payload.stride || 1);
        this.material = payload.material || {};

        // Pre-allocate buffers once at the decimated resolution.
        const wDec = Math.ceil(this.width / this.stride);
        const hDec = Math.ceil(this.height / this.stride);
        this.maxPoints = wDec * hDec;
        this.positions = new Float32Array(this.maxPoints * 3);
        this.colors = new Float32Array(this.maxPoints * 3);

        this.store = new PointDataStore(200);
        this.points = null;
        this.group = null;
        this.lastRenderedTime = null;

        // Default colour (as RGB floats) for when no RGB overlay is supplied.
        const defaultColor = this._parseColor(this.material.color);
        this.defaultColor = defaultColor;

        // RGB decode state — async via <img> + offscreen canvas.
        this._rgbCanvas = document.createElement('canvas');
        this._rgbCanvas.width = this.width;
        this._rgbCanvas.height = this.height;
        this._rgbCtx = this._rgbCanvas.getContext('2d', { willReadFrequently: true });
        this._rgbImg = new Image();
        this._rgbReady = false;
        this._rgbPixels = null;
        this._rgbPendingUrl = null;
        this._rgbImg.onload = () => {
            this._rgbCtx.drawImage(this._rgbImg, 0, 0, this.width, this.height);
            this._rgbPixels = this._rgbCtx.getImageData(0, 0, this.width, this.height).data;
            this._rgbReady = true;
        };
        this._rgbImg.onerror = (e) => {
            console.warn(`PointCloud3D '${this.name}': RGB JPEG decode failed`, e);
        };
    }

    _parseColor(color) {
        // Accept a 'rrggbb' or 'rrggbbaa' hex string, or leave default white.
        if (typeof color === 'string' && (color.length === 6 || color.length === 8)) {
            const val = parseInt(color, 16);
            if (color.length === 6) {
                return [
                    ((val >> 16) & 0xff) / 255,
                    ((val >> 8) & 0xff) / 255,
                    (val & 0xff) / 255,
                ];
            } else {
                return [
                    ((val >> 24) & 0xff) / 255,
                    ((val >> 16) & 0xff) / 255,
                    ((val >> 8) & 0xff) / 255,
                ];
            }
        }
        return [1, 1, 1];
    }

    buildObject() {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        geom.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
        geom.setDrawRange(0, 0);

        const mat = new THREE.PointsMaterial({
            size: this.material.size != null ? this.material.size : 0.003,
            sizeAttenuation: this.material.sizeAttenuation !== false,
            vertexColors: true,
        });

        this.points = new THREE.Points(geom, mat);
        // Wrap in a group so that the root node driven by Scene3D.render
        // (.position / .quaternion from '3d/<name>/pos') rigidly transforms
        // the entire cloud together.
        this.group = new THREE.Group();
        this.group.add(this.points);
        return this.group;
    }

    getObject() {
        return this.group || this.buildObject();
    }

    addFrame(time, depthBytes, rgbBytes, depthScale, intrinsics) {
        this.store.addFrame(time, depthBytes, rgbBytes, depthScale, intrinsics);
    }

    syncToTime(absTime) {
        const frame = this.store.getFrameAtTime(absTime);
        if (!frame) return;
        if (frame.time === this.lastRenderedTime) return;

        // Kick off RGB decode if this frame has a new URL. We intentionally
        // do NOT reset _rgbReady here: at live frame rates new URLs arrive
        // faster than the browser can decode JPEGs, and flipping the flag
        // on every frame would leave the points rendering the default
        // colour forever. Instead we keep the last successfully-decoded
        // image until a newer one finishes loading.
        if (frame.rgbUrl && frame.rgbUrl !== this._rgbPendingUrl) {
            this._rgbPendingUrl = frame.rgbUrl;
            this._rgbImg.src = frame.rgbUrl;
        } else if (!frame.rgbUrl) {
            // No RGB for this frame — reset state so the default colour is used.
            this._rgbPendingUrl = null;
            this._rgbReady = false;
            this._rgbPixels = null;
        }

        this._unproject(frame);
        this.lastRenderedTime = frame.time;
    }

    _unproject(frame) {
        if (!this.points) this.buildObject();

        // Resolve per-frame overrides.
        const scale = frame.depthScale != null ? frame.depthScale : this.depthScale;
        let fx = this.fx, fy = this.fy, cx = this.cx, cy = this.cy;
        let W = this.width, H = this.height;
        if (frame.intrinsics) {
            fx = frame.intrinsics.fx != null ? frame.intrinsics.fx : fx;
            fy = frame.intrinsics.fy != null ? frame.intrinsics.fy : fy;
            cx = frame.intrinsics.cx != null ? frame.intrinsics.cx : cx;
            cy = frame.intrinsics.cy != null ? frame.intrinsics.cy : cy;
            W = frame.intrinsics.width != null ? frame.intrinsics.width : W;
            H = frame.intrinsics.height != null ? frame.intrinsics.height : H;
        }

        // frame.depth is a Uint8Array view of raw u16 little-endian bytes.
        // Construct a Uint16Array view over the same buffer (x86 is little-endian).
        // The msgpack decoder can hand us the bytes at an odd byteOffset; in
        // that case fall back to a copy so the Uint16Array view is aligned.
        let bytes = frame.depth;
        if (bytes.byteOffset % 2 !== 0) {
            bytes = new Uint8Array(bytes);
        }
        const depth = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);

        const stride = this.stride;
        const pos = this.positions;
        const col = this.colors;
        const rgb = this._rgbReady ? this._rgbPixels : null;
        const dc = this.defaultColor;

        let n = 0;
        for (let v = 0; v < H; v += stride) {
            const rowBase = v * W;
            for (let u = 0; u < W; u += stride) {
                const i = rowBase + u;
                const d = depth[i];
                if (d === 0) continue;
                const z = d * scale;
                const ox = n * 3;
                pos[ox    ] = (u - cx) * z / fx;
                pos[ox + 1] = (v - cy) * z / fy;
                pos[ox + 2] = z;
                if (rgb) {
                    const p = 4 * i;
                    col[ox    ] = rgb[p    ] / 255;
                    col[ox + 1] = rgb[p + 1] / 255;
                    col[ox + 2] = rgb[p + 2] / 255;
                } else {
                    col[ox    ] = dc[0];
                    col[ox + 1] = dc[1];
                    col[ox + 2] = dc[2];
                }
                n++;
                if (n >= this.maxPoints) break;
            }
            if (n >= this.maxPoints) break;
        }

        const geom = this.points.geometry;
        geom.attributes.position.needsUpdate = true;
        geom.attributes.color.needsUpdate = true;
        geom.setDrawRange(0, n);
        geom.computeBoundingSphere();
    }
}
