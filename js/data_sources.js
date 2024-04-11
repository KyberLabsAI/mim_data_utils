function parsewebSocketData(data) {
    data = JSON.parse(data);
    let t = parseFloat(data['time']);

    traces.beginTimestep(t);

    for (let [key, value] of Object.entries(data)) {
        if (key === 'time') {
            continue;
        }

        traces.record(key, value.slice(12, -2).split(', ').map(v => parseFloat(v)));
    }

    traces.endTimestep();
}

function connectViaWebSocket(hideError) {
    var ws = new WebSocket("ws://127.0.0.1:5678/");

    let firstData = true;
    ws.onmessage = function (event) {
        if (firstData) {
            freeze(false);
            traces.clear();
        }

        // Ignore new data in case the view is frozen and there is no space
        // in the traces object left.
        if (isFrozen && traces.willEvictFirstData()) {
            return;
        }

        parsewebSocketData(event.data);

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
}

let loadedFile = null;
function loadFileContent() {
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
    loadedFile = file;
    loadFileContent();
}


