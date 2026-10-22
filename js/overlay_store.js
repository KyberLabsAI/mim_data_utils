/**
 * OverlayStore — rendered image overlays (PNG, from Logger.log_overlay) of one
 * image source, keyed per overlay name by the image frame they belong to.
 *
 * The key is the frame number logged with the image (log_image(..., number=))
 * or, without one, the exact frame time. Only the compressed bytes are kept;
 * CameraPlayback decodes the overlays of the frame it shows.
 *
 * Static overlays (log_overlay(..., static=True)) belong to no frame: each
 * version applies from its time on, over every frame of the source. They are
 * kept per name as a time-sorted list of versions (each sent once).
 */
class OverlayStore {
    constructor(maxPerName, maxStaticPerName) {
        this.maxPerName = maxPerName || 1000;
        this.maxStaticPerName = maxStaticPerName || 50;
        this.byName = new Map();   // overlay name -> Map(key -> entry)
        this.statics = new Map();  // overlay name -> [{id, time, bytes, offset}] by time
        this._nextStaticId = 1;
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

    /** Add a static overlay version, valid from `time` on (replaces one at the same time). */
    addStatic(name, time, bytes, offset) {
        let list = this.statics.get(name);
        if (!list) {
            list = [];
            this.statics.set(name, list);
        }
        const entry = { id: this._nextStaticId++, time, bytes: bytes || null, offset: offset || [0, 0] };
        let i = list.length;
        while (i > 0 && list[i - 1].time > time) i--;
        if (i > 0 && list[i - 1].time === time) list[i - 1] = entry;
        else list.splice(i, 0, entry);
        while (list.length > this.maxStaticPerName) list.shift();   // oldest first
        this.version++;
    }

    isStatic(name) {
        return this.statics.has(name);
    }

    /** Static version valid at `time`: the newest one at or before it, else
     *  the earliest (so an offset between image and overlay clocks never
     *  blanks it). Undefined if `name` has none. */
    getStatic(name, time) {
        const list = this.statics.get(name);
        if (!list || list.length === 0) return undefined;
        if (time == null) return list[list.length - 1];
        let lo = 0, hi = list.length - 1;
        if (list[0].time > time) return list[0];
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (list[mid].time <= time) lo = mid;
            else hi = mid - 1;
        }
        return list[lo];
    }

    get(name, key) {
        const m = this.byName.get(name);
        return m ? m.get(key) : undefined;
    }

    names() {
        return [...new Set([...this.byName.keys(), ...this.statics.keys()])].sort();
    }

    get size() {
        return this.names().length;
    }

    clear() {
        this.byName.clear();
        this.statics.clear();
        this.version++;
    }
}
