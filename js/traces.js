
function assert(cond, desc) {
    if (!cond) {
        alert(desc);
        throw new Error(desc);
    }
}

class SeriesDataChunk {
    constructor(name, dim, size) {
        this.name = name;
        this.size = size;
        this.dim = dim;
        this.times = new Float32Array(size);
        this.timedData = Array.from(Array(dim)).map(_ => new Float32Array(size));
        this.timeFrom = 0;
        this.timeTo = 0;
        this.entries = 0;
    }

    isFull() {
        return this.entries == this.size;
    }

    record(time, newData) {
        if (this.entries == 0) {
            this.timeFrom = this.timeTo = time;
        } else if (time < this.timeFrom) {
            this.timeFrom = time;
        } else if (time > this.timeTo) {
            this.timeTo = time;
        }

        let entries = this.entries;
        this.times[entries] = time;
        this.timedData.forEach((series, i) => {
            series[entries] = newData[i];
        });
        this.entries++;
    }

    forEachLinearTimeIndex(index, callback) {
        let times = this.times;
        let timedData = this.timedData[index];

        for (let i = 0; i < this.entries; i++) {
            callback(times[i], timedData[i]);
        }
    }

    _dataAtIndex(index) {
        return this.timedData.map(d => d[index]);
    }

    /**
     * Returns the data entry is stored at or before the given time.
     */
    dataAtTime(time) {
        if (time < this.timeFrom || this.entires == 0) {
            return undefined;
        }

        let last = 0;
        let times = this.times;
        for (let i = 1; i < this.entries; i++) {
            if (times[i] > time) {
                break;
            }
            last = i;
        }

        return this._dataAtIndex(last);
    }
}

class SeriesData {
    constructor(name, dim, chunkSize, maxSize) {
        this.name = name;
        this.chunkSize = chunkSize;
        this.dim = dim;

        this.chunks = [];
        this.maxTime = 0;
        this.maxSize = maxSize;

        this._addChunk();
    }

    dataAtTime(time) {
        // TODO: Assuming the chuncks are chronologically ordered here. Doesn't need to
        // be the case. Fix later to support out-of-order recording of data.
        for (let chunck of this.chunks) {
            let data = chunck.dataAtTime(time);
            if (data) {
                return data;
            }
        }
        return undefined;
    }

    forEachLinearTimeIndex(index, callback) {
        // TODO: Make sure to run through this in linear timed order.
        this.chunks.forEach(chunck => chunck.forEachLinearTimeIndex(index, callback));
    }

    _addChunk() {
        this.chunks.push(new SeriesDataChunk(this.name, this.dim, this.chunkSize))
    }

    _maxChunks() {
        // We support at least maxData entries. Adding an extra chunck. This way
        // when the chuncks are full and the first one gets emptied, there is still
        // room for at least maxData entries.
        return Math.ceil(this.maxData / this.chunkSize) + 1;
    }

    _maxEntries() {
        return this._maxChunks() * this.chunkSize
    }

    willEvictData() {
        return this.chunks.at(-1).isFull();
    }

    firstTime() {
        let minTime = this.maxTime;
        this.chunks.forEach(chunk => {
            if (chunk.timeFrom < minTime) {
                minTime = chunk.timeFrom;
            }
        });
        return minTime;
    }

    lastTime() {
        let maxTime = 0n;
        this.chunks.forEach(chunk => {
            if (chunk.timeTo > maxTime) {
                maxTime = chunk.timeTo;
            }
        });
        return maxTime;
    }

    record(time, data) {
        if (this.chunks.at(-1).isFull()) {
            if (this.chunks.length >= this._maxChunks()) {
                this.chunks.shift();
            }
            this._addChunk();
        }

        this.chunks.at(-1).record(time, data);
        return true;
    }
}

CHUNK_SIZE = 2048;

class Traces {
    constructor(maxData, callbackFn) {
        this.maxData = maxData;
        this.callbackFn = [callbackFn];
        this.currentTime = 0;
        this.clear(true);
    }

    callback(type, payload) {
        this.callbackFn.forEach(fn => fn(type, this, payload));
    }

    clear(supressEvent) {
        this.seriesData = new Map();
        this.lineData = new Map();
        this.staticData = new Map();

        if (!supressEvent) {
            this.callback('Traces::clear')
        }
    }

    dataAtTime(name, time) {
        if (this.seriesData.has(name)) {
            return this.seriesData.get(name).dataAtTime(time);
        } else {
            return undefined;
        }
    }

    getFirstTime() {
        // TODO: Compute firstTime only for displayed lines.
        let firstTime = 0.;
        this.seriesData.values().forEach(series => {
            let seriesFirstTime = series.firstTime();
            if (seriesFirstTime < firstTime) {
                firstTime = seriesFirstTime
            }
        });
        return firstTime;
    }

    getLastTime() {
        // TODO: Compute firstTime only for displayed lines.
        let lastTime = 0.;
        this.seriesData.values().forEach(series => {
            let seriesLastTime = series.lastTime();
            if (seriesLastTime < lastTime) {
                lastTime = seriesLastTime
            }
        });
        return lastTime;
    }

    willEvictFirstData(maxData) {
        return this.seriesData.values().some(series => series.willEvictData());
    }

    recordStaticData(name, data) {
        this.staticData.set(name, data);
        this.callback('Traces::recordStaticData', name);
    }

    beginTimestep(time) {
        this.time = time;
    }

    _lineDataKey(name, index) {
        return `${name}$${index}`;
    }

    record(name, value) {
        if (!this.seriesData.has(name)) {
            this.seriesData.set(name, new SeriesData(name, value.length, CHUNK_SIZE, this.maxSize))
        }
        this.seriesData.get(name).record(this.time, value);

        for (let i = 0; i < value.length; i++) {
            let entryName = this._lineDataKey(name, i);
            if (this.lineData.has(entryName)) {
                this.lineData.get(entryName).appendPoint(this.time, value[i])
            }
        }
    }

    endTimestep() {
        this.callback('Traces::endTimestep');
    }

    fillLineData(lineData, name, index) {
        lineData.clear();

        let key = this._lineDataKey(name, index);
        if (!this.seriesData.has(name)) {
            return;
        }

        let boundAppendPoint = lineData.appendPoint.bind(lineData);
        this.seriesData.get(name).forEachLinearTimeIndex(index, boundAppendPoint);
    }

    getDataSize(name) {
        if (this.seriesData.has(name)) {
            return this.seriesData.get(name).dim;
        } else {
            return 0;
        }
    }

    getDataNames() {
        return Array.from(this.seriesData.keys());
    }

    getLineData(name, index) {
        let key = this._lineDataKey(name, index);

        if (this.lineData.has(key)) {
            return this.lineData.get(key);
        }


        let lineData = new LineData();
        this.fillLineData(lineData, name, index);
        this.lineData.set(key, lineData);
        return lineData;
    }
}
