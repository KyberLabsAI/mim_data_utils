
function assert(cond, desc) {
    if (!cond) {
        alert(desc);
        throw new Error(desc);
    }
}

function vectorify(value) {
    value.__proto__ = va_prototype;
    return value;
}

class VectorArray extends Array {
    vecMap(valB, fn) {
        if (typeof(valB) == 'number') {
            return vectorify(this.map(val => fn(val, valB)))
        } else {
            assert(this.length == valB.length,
                `Array.add: Length of vectors do not match (${this.length} vs ${valB.length}).`);

            return vectorify(this.map((val, idx) => fn(val, valB[idx])))
        }
    }

    add(valB) {
        return this.vecMap(valB, (numA, numB) => numA + numB);
    }

    sub(valB) {
        return this.vecMap(valB, (numA, numB) => numA - numB);
    }

    mul(valB) {
        return this.vecMap(valB, (numA, numB) => numA * numB);
    }

    div(valB) {
        return this.vecMap(valB, (numA, numB) => numA / numB);
    }

    dot(valB) {
        assert(this.length == valB.length,
            `Array.add: Length of vectors do not match (${this.length} vs ${valB.length}).`);

        let sum = 0.;
        for (let i = 0; i < this.length; i++) {
            sum += this[i] * valB[i];
        }
        return sum;
    }
}

let va_prototype = new VectorArray();

class Traces {
    constructor(callbackFn) {
        this.callbackFn = callbackFn;
        this.clear(true);
    }

    clear(supressEvent) {
        this.timestepData = [];
        this.derivedData = [];
        this.derivedFn = null;
        this.lineDataNameMap = new Map();
        this.data_idx = -1;
        this.data_size = 0;
        this.full_buffer = false;

        if (!supressEvent) {
            this.callbackFn('Traces::clear', this);
        }
    }

    getFirstTime() {
        if (this.timestepData.length == 0) {
            return 0;
        } else {
            return this.timestepData[0].get('time')[0];
        }
    }

    getLastTime() {
        if (this.timestepData.length == 0) {
            return 0;
        } else {
            return this.timestepData[this.data_idx].get('time')[0];
        }
    }

    willEvictFirstData(maxData) {
        return this.timestepData.length >= maxData - 1;
    }

    beginTimestep(time, maxData) {
        this.time = time;

        let timestepMap;
        if (this.data_size == 0) {
            timestepMap = new Map();
        } else {
            timestepMap = new Map(this.timestepData[this.data_idx]);
        }

        timestepMap.set('time', vectorify([time]));

        if (this.data_size < maxData) {
            this.timestepData.push(timestepMap);
            this.derivedData.push(new Map());
            this.data_size += 1;
        } else {
            this.full_buffer = true;
            this.timestepData[this.data_idx] = timestepMap;
            this.derivedData[this.data_idx] = new Map();

            for (let [name, ldnm] of this.lineDataNameMap) {
                for (let [idx, lineData] of ldnm) {
                    lineData.shiftPoint();
                }
            }
        }
        this.data_idx = (this.data_idx + 1) % maxData;
    }

    record(name, value) {
        this.timestepData[this.data_idx].set(name, vectorify([...value]));
    }

    computeDerivedData(idx, ttData, dtData) {
        this.derivedFn(ttData, dtData, this.timestepData, idx);

        // Convert single numbers to vectory instances for keeping consistent
        // object shapes.
        for (let [key, val] of dtData) {
            if (typeof(val) == 'number') {
                dtData.set(key, vectorify([val]));
            }
        }
    }

    computeDerivedDataByIdx(idx) {
        this.computeDerivedData(idx, this.timestepData[idx], this.derivedData[idx]);
    }

    endTimestep() {
        // Run the derivedFn function to compute the derived data.
        if (this.derivedFn) {
            this.computeDerivedDataByIdx(this.data_idx);
        }

        // Add new data to the excisting lineDatas.
        let lastTimestepData = this.timestepData[this.data_idx];
        let lastDerivedData = this.derivedData[this.data_idx];
        let t = lastTimestepData.get('time')[0];

        for (let [name, ldnm] of this.lineDataNameMap) {
            for (let [idx, lineData] of ldnm) {
                if (lastTimestepData.has(name)) {
                    lineData.appendPoint(t, lastTimestepData.get(name)[idx]);
                } else if (lastDerivedData.has(name)) {
                    lineData.appendPoint(t, lastDerivedData.get(name)[idx]);
                }
            }
        }

        this.callbackFn('Traces::endTimestep', this);
    }

    setDerivedFn(derivedFn) {
        // Make sure the `this` object is not captured.
        this.derivedFn = derivedFn.bind(null);

        // Recompute the derived data.
        this.timestepData.forEach((tdata, idx) => {
            let derivedTimestepData = this.derivedData[idx];
            derivedTimestepData.clear();

            this.derivedFn(tdata, derivedTimestepData);
        });

        // Refill the lineData for derived data.
        for (let [name, ldnm] of this.lineDataNameMap) {
            if (this.timestepData[0].has(name)) {
                continue;
            }

            for (let [idx, lineData] of ldnm) {
                this.fillLineDataByNameIndex(lineData, name, idx);
            }
        }

        this.callbackFn('Traces::setDerivedFn', this);
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
        } else if (this.derivedData[0].has(name)) {
            this.fillLineData(lineData, this.derivedData, name, index);
        }
    }

    getDataSize(name) {
        if (this.timestepData.length == 0) {
            return 0;
        } else if (this.timestepData[0].has(name)) {
            return this.timestepData[0].get(name).length;
        } else if (this.derivedData[0].has(name)) {
            return this.derivedData[0].get(name).length;
        } else {
            return 0;
        }
    }

    getDataNames() {
        if (this.timestepData.length == 0) {
            return [];
        } else {
            return Array.from(this.timestepData[0].keys()).concat(Array.from(this.derivedData[0].keys()))
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
