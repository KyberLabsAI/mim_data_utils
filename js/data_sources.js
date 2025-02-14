let wsMaxData = 5 * 60 * 1000;

let lastTime = 0;

function parsewebSocketData(data) {
    if ('__static__' in data) {
        traces.recordStaticData(data['name'], data['data']);
        return;
    }

    let t = parseFloat(data['time']);
    let relayout = false;

    if (Math.abs(t - lastTime) > 5) {
        traces.clear();
        relayout = true
    }

    lastTime = t;

    traces.beginTimestep(t, wsMaxData);

    for (let [key, value] of Object.entries(data)) {
        if (key === 'time') {
            continue;
        }

        if (!Array.isArray(value)) {
            value = value.slice(12, -2).split(', ').map(v => parseFloat(v))
        }

        traces.record(key, value)
    }

    traces.endTimestep();

    if (relayout) {
        updateLayout();
    }
}

let dataRecord = [];

let ws = null;
function connectViaWebSocket(hideError) {
    ws = new WebSocket("ws://127.0.0.1:5678/");

    JSON.parse((localStorage.getItem('lastData') || '[]')).forEach(entries => {
        JSON.parse(entries).forEach(parsewebSocketData);
    });
    firstNewData();

    let firstData = true;
    ws.onmessage = function (event) {
        if (firstData) {
            freeze(false);
            traces.clear();
            dataRecord = []
        }

        // Ignore new data in case the view is frozen and there is no space
        // in the traces object left.
        if (isFrozen && traces.willEvictFirstData(wsMaxData)) {
            return;
        }

        let data = JSON.parse(event.data);

        if (dataRecord.length < 100) {
            dataRecord.push(event.data);
            localStorage.setItem('lastData', JSON.stringify(dataRecord));
        }

        data.forEach(parsewebSocketData);

        if (firstData) {
            firstData = false;
            firstNewData();
        }
    };
    ws.onerror = function (event) {
        if (!hideError) {
            alert('Error with streaming. Is the data streamed?');
        }

        setTimeout(() => {
            if (firstData) {
                connectViaWebSocket(true);
            }
        }, 1000);
    };
}

function readDatafile(binaryBuffer) {
    if (ws) {
        ws.close();
    }

    got_data = true

    // Ungzip the datafile.
    let binData = new Uint8Array(binaryBuffer);
    var data = pako.inflate(binData);

    // Create a dataview on the data for easier reading of values.
    let dv = new DataView(data.buffer);

    let offset = 0;
    var enc = new TextDecoder("utf-8");

    let field_names = [];
    let field_sizes = []

    // Read the header of the file.
    let idx = dv.getUint32(0, true);
    let num_fields = dv.getUint32(4, true);
    offset += 8;

    // Read the field data.
    for (let f = 0; f < num_fields; f++) {
        arr = []
        for (let i = 0; i < 64; i++) {
            arr.push(dv.getUint8(offset));

            offset += 1
        }
        field_name = enc.decode(new Uint8Array(arr))
        field_name = field_name.replaceAll('\u0000', '')
        field_size = dv.getUint32(offset, true);
        offset += 4;

        field_names.push(field_name);
        field_sizes.push(field_size);
        console.log('  ', field_name, '@', field_size);
    }

    let dtData = new Map();
    field_names.forEach((name, i) => {
        dtData.set(name, new Array(field_sizes[i]));
    });

    let fieldNamesWithoutTime = field_names.filter(name => name != 'time');

    // Read the data blob.
    for (var j = 0; offset < data.length; j++) {
        for (let f = 0; f < num_fields; f++) {
            let fieldData = dtData.get(field_names[f]);
            for (let i = 0; i < field_sizes[f]; i++) {
                fieldData[i] = dv.getFloat32(offset, true);
                offset += 4;
            }
        }

        let time = j * 0.001; // Fallback value assuming 1 kHz.
        if (dtData.has('time')) {
            time = dtData.get('time')[0];
        }

        traces.beginTimestep(time);

        fieldNamesWithoutTime.forEach(name => {
            traces.record(name, dtData.get(name));
        });

        traces.endTimestep();
    }

    layout.zoomX = [traces.getFirstTime(), traces.getLastTime()]
    updatePlotViewport();
}

function loadFileContent(loadedFile) {
    loadedFile.arrayBuffer().then((content) => {
        traces.clear();
        readDatafile(content);
        firstNewData();
    });
}

async function loadDataFile() {
    const pickerOpts = {
        types: [
            {
            description: 'MIM Data Storage',
            accept: {
                'data/*': ['.mds']
            }
            },
        ],
        excludeAcceptAllOption: true,
        multiple: false
    };
    let [fileHandle] = await window.showOpenFilePicker(pickerOpts);
    let file = await fileHandle.getFile();
    loadFileContent(file);
}


let dropArea = document.body;

// Drag and drop handling.
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, preventDefaults, false);
})

function preventDefaults (e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, highlight, false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, unhighlight, false);
});

function highlight(e) {
    dropArea.classList.add('highlight');
}

function unhighlight(e) {
    dropArea.classList.remove('highlight');
}

dropArea.addEventListener('drop', handleDrop, false);

function handleDrop(e) {
    loadFileContent(e.dataTransfer.files[0]);
}
