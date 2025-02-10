
function assert(cond, desc) {
    if (!cond) {
        alert(desc);
        throw new Error(desc);
    }
}

class Traces {
    constructor(callbackFn) {
        this.callbackFn = [callbackFn];
        this.clear(true);
    }

    callback(type, payload) {
        this.callbackFn.forEach(fn => fn(type, this, payload));
    }

    clear(supressEvent) {
        this.timestepData = [];
        this.lineDataNameMap = new Map();
        this.data_idx = -1;
        this.data_size = 0;
        this.full_buffer = false;
        this.staticData = new Map();

        if (!supressEvent) {
            this.callback('Traces::clear')
        }
    }

    setStaticData(name, data) {
        this.staticData.set(name, data);
        this.callback('Traces::setStaticData', name);
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

        timestepMap.set('time', [time]);

        if (this.data_size < maxData) {
            this.timestepData.push(timestepMap);
            this.data_size += 1;
        } else {
            this.full_buffer = true;
            this.timestepData[this.data_idx] = timestepMap;

            for (let [name, ldnm] of this.lineDataNameMap) {
                for (let [idx, lineData] of ldnm) {
                    lineData.shiftPoint();
                }
            }
        }
        this.data_idx = (this.data_idx + 1) % maxData;
    }

    record(name, value) {
        this.timestepData[this.data_idx].set(name, value);
    }

    endTimestep() {
        // Add new data to the excisting lineDatas.
        let lastTimestepData = this.timestepData[this.data_idx];
        let t = lastTimestepData.get('time')[0];

        for (let [name, ldnm] of this.lineDataNameMap) {
            for (let [idx, lineData] of ldnm) {
                if (lastTimestepData.has(name)) {
                    lineData.appendPoint(t, lastTimestepData.get(name)[idx]);
                }
            }
        }

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
