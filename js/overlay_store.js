/**
 * OverlayStore — rendered image overlays (PNG, from Logger.log_overlay) of one
 * image source, keyed per overlay name by the image frame they belong to.
 *
 * The key is the frame number logged with the image (log_image(..., number=))
 * or, without one, the exact frame time. Only the compressed bytes are kept;
 * CameraPlayback decodes the overlays of the frame it shows.
 */
class OverlayStore {
    constructor(maxPerName) {
        this.maxPerName = maxPerName || 1000;
        this.byName = new Map();   // overlay name -> Map(key -> entry)
        this.version = 0;          // bumped on every change
    }

    static frameKey(number, time) {
        return number != null ? 'n' + number : 't' + time;
    }

    add(name, number, time, bytes, offset) {
        let m = this.byName.get(name);
        if (!m) {
            m = new Map();
            this.byName.set(name, m);
        }
        const key = OverlayStore.frameKey(number, time);
        m.delete(key);  // re-insert so a re-logged overlay counts as newest
        m.set(key, { time, bytes: bytes || null, offset: offset || [0, 0] });
        while (m.size > this.maxPerName) {
            m.delete(m.keys().next().value);  // Map iterates in insertion order
        }
        this.version++;
    }

    get(name, key) {
        const m = this.byName.get(name);
        return m ? m.get(key) : undefined;
    }

    names() {
        return [...this.byName.keys()].sort();
    }

    get size() {
        return this.byName.size;
    }

    clear() {
        this.byName.clear();
        this.version++;
    }
}
