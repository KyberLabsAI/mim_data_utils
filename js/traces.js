
function assert(cond, desc) {
    if (!cond) {
        alert(desc);
        throw new Error(desc);
    }
}

class Lim {
    constructor(from, to) {
        this.from = from;
        this.to = to;
    }

    copy() {
        return new Lim(this.from, this.to);
    }

    extend(other) {
        if (other.from < this.from) {
            this.from = other.from;
        }
        if (other.to > this.to) {
            this.to = other.to
        }
    }

    extendByValue(val) {
        if (val < this.from) {
            this.from = val;
        } else if (val > this.to) {
            this.to = val;
        }
    }

    expandByMargin(val) {
        this.from -= val;
        this.to += val;
    }
}

class SeriesDataChunk {
    constructor(name, dim, size) {
        this.name = name;
        this.size = size;
        this.dim = dim;
        this.times = new Float32Array(size);
        this.timedData = Array.from(Array(dim)).map(_ => new Float32Array(size));
        this.timedDataYLimits = Array.from(Array(dim)).map(_ => new Lim(0, 0));
        this.timeFrom = 0;
        this.timeTo = 0;
        this.entries = 0;
    }

    isFull() {
        return this.entries == this.size;
    }

    dataYLim(index) {
        return this.timedDataYLimits[index];
    }

    record(time, newData) {
        let timedDataYLimits = this.timedDataYLimits;

        if (this.entries == 0) {
            this.timeFrom = this.timeTo = time;
            for (let i = 0; i < this.dim; i++) {
                timedDataYLimits[i].from = timedDataYLimits[i].to = newData[i];
            }
        } else if (time < this.timeFrom) {
            this.timeFrom = time;
        } else if (time > this.timeTo) {
            this.timeTo = time;
        }

        let entries = this.entries;
        this.times[entries] = time;
        this.timedData.forEach((series, i) => {
            const val = newData[i]
            const lim = timedDataYLimits[i];

            series[entries] = val;
            if (val > lim.to) {
                lim.to = val;
            } else if (val < lim.from) {
                lim.from = val;
            }
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

    _valueIndexAtEntrie(index, entry) {
        return this.timedData[index][entry];
    }

    _valueIndexAtEntries(index, entryFrom, entryTo, callback) {
        let indexTimedData = this.timedData[index];
        for (let i = entryFrom; i <= entryTo; i++) {
            callback(indexTimedData[i]);
        }
    }


    dataAtTimeIndex(time) {
        if (time < this.timeFrom || this.entires == 0) {
            return null;
        }

        let last = 0;
        let times = this.times;
        for (let i = 1; i < this.entries; i++) {
            if (times[i] > time) {
                break;
            }
            last = i;
        }

        return last;
    }

    /**
     * Returns the data entry is stored just after the given time.
     */
    dataAtTime(time) {
        let index = this.dataAtTimeIndex(time);

        if (index === null) {
            return null;
        } else {
            return this.timedData.map(d => d[index]);
        }
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

        this.dataVersion = 0;

        this._addChunk();


        this.xLimCache = {
            dataVersion: -1,
            ...this.xLimIndices(0, 0)
        };
    }

    dataAtTime(time) {
        // TODO: Assuming the chuncks are chronologically ordered here. Doesn't need to
        // be the case. Fix later to support out-of-order recording of data.
        for (let i = this.chunks.length - 1; i >= 0; i--) {
            let data = this.chunks[i].dataAtTime(time);
            if (data) {
                return data;
            }
        }
    }

    forEachLinearTimeIndex(index, callback) {
        // TODO: Make sure to run through this in linear timed order.
        this.chunks.forEach(chunck => chunck.forEachLinearTimeIndex(index, callback));
    }

    _addChunk() {
        this.chunks.push(new SeriesDataChunk(this.name, this.dim, this.chunkSize))
    }

    _maxChunks() {
        // We support at least maxSize entries. Adding an extra chunck. This way
        // when the chuncks are full and the first one gets emptied, there is still
        // room for at least maxSize entries.
        return Math.ceil(this.maxSize / this.chunkSize) + 1;
    }

    _maxEntries() {
        return this._maxChunks() * this.chunkSize
    }

    willEvictData() {
        return (
            this.chunks.length >= this._maxChunks() &&
            this.chunks.at(-1).isFull()
        );
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
        let maxTime = 0;
        this.chunks.forEach(chunk => {
            if (chunk.timeTo > maxTime) {
                maxTime = chunk.timeTo;
            }
        });
        return maxTime;
    }

    record(time, data) {
        if (time > this.maxTime) {
            this.maxTime = time;
        }

        if (this.chunks.at(-1).isFull()) {
            if (this.chunks.length >= this._maxChunks()) {
                this.chunks.shift();
            }
            this._addChunk();
        }

        this.chunks.at(-1).record(time, data);
        this.dataVersion ++;
        return true;
    }

    xLimIdx(time) {
        let chunks = this.chunks;

        let cIdx = binarySearch(0, this.chunks.length - 1, time, (idx) => {
            return chunks[idx].timeTo;
        });

        let chunk = chunks[cIdx];
        let pIdx = binarySearch(0, chunk.entries - 1, time, (idx) => {
            return chunk.times[idx];
        });

        return {
            chunkIdx: cIdx,
            pointIdx: pIdx
        };
    }

    xLimIndices(timeFrom, timeTo) {
        const cache = this.xLimCache;
        if (cache && this.dataVersion == cache.dataVersion &&
            cache.time.from == timeFrom && cache.time.to == timeTo
        ) {
            return cache;
        } else {
            return {
                time: new Lim(timeFrom, timeTo),
                from: this.xLimIdx(timeFrom),
                to: this.xLimIdx(timeTo),
            }
        }
    }

    _findYLimPartialChunk(xIdx, pFrom, pTo, index, yLim) {
        let chunck = this.chunks[xIdx];

        if (yLim === null) {
            let val = chunck._valueIndexAtEntrie(index, pFrom);
            yLim = new Lim(val, val);
        }

        chunck._valueIndexAtEntries(index, pFrom, pTo, (val) => {
            yLim.extendByValue(val);
        });

        return yLim;
    }

    yLim(timeFrom, timeTo, index, yLim) {
        let xLimIndices = this.xLimIndices(timeFrom, timeTo)

        let x0c = xLimIndices.from.chunkIdx;
        let x0p = xLimIndices.from.pointIdx;
        let x1c = xLimIndices.to.chunkIdx;
        let x1p = xLimIndices.to.pointIdx;

        // Look up the ylim in the middle from chunk limits.
        for (let cidx = x0c + 1; cidx < x1c; cidx++) {
            let chunkYLim = this.chunks[cidx].dataYLim(index);

            if (yLim === null) {
                yLim = chunkYLim.copy();
            } else {
                yLim.extend(chunkYLim);
            }
        }

        if (x0c == x1c) {
            yLim = this._findYLimPartialChunk(x0c, x0p, x1p, index, yLim);
        } else {
            yLim = this._findYLimPartialChunk(x0c, x0p, this.chunks[x0c].to - 1, index, yLim);
            yLim = this._findYLimPartialChunk(x1c, 0, x1p, index, yLim);
        }

        return yLim;
    }
}

CHUNK_SIZE = 1024;

class Traces {
    constructor(maxSize, callbackFn) {
        this.maxSize = maxSize;
        this.callbackFn = [callbackFn];
        this.currentTime = 0;
        this.clear(true);
    }

    callback(type, payload) {
        this.callbackFn.forEach(fn => fn(type, this, payload));
    }

    clear(supressEvent, newMaxSize) {
        this.seriesData = new Map();
        this.lineData = new Map();
        this.staticData = new Map();

        if (!supressEvent) {
            this.callback('Traces::clear')
        }

        if (newMaxSize) {
            this.maxSize = newMaxSize;
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
        let firstTime = this.getLastTime();
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
            if (seriesLastTime > lastTime) {
                lastTime = seriesLastTime
            }
        });
        return lastTime;
    }

    willEvictFirstData(maxSize) {
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
        let newSeries = false;
        if (!this.seriesData.has(name)) {
            this.seriesData.set(name, new SeriesData(name, value.length, CHUNK_SIZE, this.maxSize))
            newSeries = true;
        }
        this.seriesData.get(name).record(this.time, value);

        for (let i = 0; i < value.length; i++) {
            let entryName = this._lineDataKey(name, i);
            // if (this.lineData.has(entryName)) {
            //     this.lineData.get(entryName).appendPoint(this.time, value[i])
            // }
        }

        if (newSeries) {
            this.callback('Traces::newSeriesData', name);
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

    getLineData(name, index, width) {
        let key = this._lineDataKey(name, index);

        // if (this.lineData.has(key)) {
        //     return this.lineData.get(key);
        // }


        let lineData = new LineData(this.maxSize);
        this.fillLineData(lineData, name, index);
        this.lineData.set(key, lineData);
        return lineData;
    }

    yLim(timeFrom, timeTo, name, index, yLim) {
        return this.seriesData.get(name).yLim(timeFrom, timeTo, index, yLim);
    }
}
