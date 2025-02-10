
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
        this.times = new BigUint64Array(size);
        this.timedData = Array(dim).map(_ => new Float32Array(size));
        this.timeFrom = NaN;
        this.timeTo = NaN;
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
            series[entries][i] = newData[i];
        });
        this.entries++;
    }
}

class SeriesData {
    constructor(name, dim, chunkSize) {
        this.name = name;
        this.chunkSize = chunkSize;
        this.dim = dim;

        this.chunks = [];
        this.maxTime = 0n;

        this._addChunk();
    }

    _addChunk() {
        this.chunks.push(new SeriesDataChunk(this.name, this.dim, this.chunkSize))
    }

    _maxChunks(maxData) {
        return Math.ceil(maxData / this.chunkSize) + 1;
    }

    _maxEntries(maxData) {
        return this._maxChunks(maxData) * this.chunkSize
    }

    willEvictData(maxData) {
        return maxData >= this._maxEntries(maxData);
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

    record(time, data, maxData, evictData) {
        if (maxData < this._maxEntries(maxData)) {
            if (this.chunks.at(-1).isFull()) {
                this._addChunk()
            }
        } else {
            if (!evictData) {
                return false;
            }

            this.chunks.shift();
            this._addChunk();
        }

        if (time > this.maxTime) {
            this.maxTime = time;
        }

        this.chunks.at(-1).record(time, data);
        return true;
    }
}

CHUNK_SIZE = 2048;

class Traces {
    constructor(callbackFn) {
        this.callbackFn = [callbackFn];
        this.currentTime = 0;
        this.clear(true);
    }

    callback(type, payload) {
        this.callbackFn.forEach(fn => fn(type, this, payload));
    }

    clear(supressEvent) {
        this.seriesData = new Map();
        this.seriesLineData = new Map();
        // this.data_idx = -1;
        // this.data_size = 0;
        // this.full_buffer = false;
        // this.staticData = new Map();

        if (!supressEvent) {
            this.callback('Traces::clear')
        }
    }

    getFirstTime() {
        // TODO: Compute firstTime only for displayed lines.
        let firstTime = 0n;
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
        let lastTime = 0n;
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

    beginTimestep(time) {
        this.time = time;
    }

    record(name, value) {
        if (!this.seriesData.has(name)) {
            this.seriesData.set(name, new SeriesData(name, value.length, CHUNK_SIZE))
        }
        this.seriesData.get(name).record(this.time, value);

        for (let i = 0; i < value.length; i++) {
            let entryName = `${name}$${i}`;
            if (this.lineData.has(entryName)) {
                this.lineData.get(entryName).appendPoint(this.time, value[i])
            }
        }
    }

    endTimestep() {
        this.callback('Traces::endTimestep');
    }

    fillLineData(lineData, data, name, index) {
        const len = data.length;
        const timestepData = this.timestepData;

        lineData.clear();

        if (this.full_buffer) {
            let steps = 0;
            while (steps < this.data_size) {
                let idx = (this.data_idx + 1 + steps) % this.data_size;
                lineData.appendPoint(timestepData[idx].get('time'), data[idx].get(name)[index]);
                steps += 1;
            }
        } else {
            for (let i = 0; i < len; i++) {
                lineData.appendPoint(timestepData[i].get('time'), data[i].get(name)[index]);
            }
        }

    }

    fillLineDataByNameIndex(lineData, name, index) {
        if (this.timestepData[0].has(name)) {
            this.fillLineData(lineData, this.timestepData, name, index);
        }
    }

    getDataSize(name) {
        if (this.timestepData.length == 0) {
            return 0;
        } else if (this.timestepData[0].has(name)) {
            return this.timestepData[0].get(name).length;
        } else {
            return 0;
        }
    }

    getDataNames() {
        if (this.timestepData.length == 0) {
            return [];
        } else {
            return Array.from(this.timestepData[0].keys())
        }
    }

    getLineData(name, index) {
        var ldnm;
        if (this.lineDataNameMap.has(name)) {
            ldnm = this.lineDataNameMap.get(name);
        } else {
            ldnm = new Map();
            this.lineDataNameMap.set(name, ldnm);
        }

        if (ldnm.has(index)) {
            return ldnm.get(index);
        } else {
            let lineData = new LineData();
            this.fillLineDataByNameIndex(lineData, name, index);
            ldnm.set(index, lineData);
            return lineData;
        }
    }
}
