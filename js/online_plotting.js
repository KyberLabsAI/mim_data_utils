
plot_data_x = [] // Use a single array for all the x data.
plot_data = {}

got_data = false
max_len = 5000

freeze_plot = false
relayoutPlots = false
stream_data = true
scheduledRequestAnimationFrame = false

plots = []

class Plot {
    constructor(domId) {
        this.domId = domId;

        this.displayedFieldNames = []
        this.displayedFieldData = []
        this.displayedTraces = []

        plots.push(this)

        this.createDom();
        this.initFields()
        this.initPlot();
    }

    createDom() {
        function create(type, parent, text) {
            let dom = document.createElement(type);
            dom.textContent = text || '';

            if (parent) {
                parent.appendChild(dom)
            }
            return dom
        }
        this.domMainDiv = create('div');
        this.domSelectFieldName = create('select', this.domMainDiv)
        this.domTraceFieldIndexInput = create('input', this.domMainDiv)
        this.domBtnAddTrace = create('button', this.domMainDiv, 'Add traces')
        this.domBtnRemoveTraces = create('button', this.domMainDiv, 'Remove all traces')
        this.domBtnRemovePlot = create('button', this.domMainDiv, 'Remove plot')
        this.domPlotDiv = create('div', this.domMainDiv)

        document.body.appendChild(this.domMainDiv)

        this.domBtnAddTrace.addEventListener('click', (evt) => {
            let fieldName = this.domSelectFieldName.value
            let ids = this.domTraceFieldIndexInput.value
            ids = ids.split(',').map((e) => parseInt(e.trim()))

            if (ids.length === 0 || isNaN(ids[0])) {
                alert("Please provide the indices of the data to add.");
                document.querySelector('#trace_field_index_input').focus();
                return;
            }

            ids.forEach((id) => {
                this.addTrace(fieldName, id)
            })
        });

        this.domBtnRemoveTraces.addEventListener('click', (evt) => {
            this.removeAllTraces();
        });

        this.domBtnRemovePlot.addEventListener('click', (evt) => {
            this.removePlot()
        })
    }

    removePlot() {
        let idx = plots.indexOf(this);
        plots.splice(idx);
        document.body.removeChild(this.domMainDiv);
    }

    initFields() {
        Object.keys(plot_data).forEach((name) => {
            this.addField(name, plot_data[name].length)
        })
    }

    initPlot() {
        var lines = this.displayedFieldNames.map(function(field_name) {
            return {
                x: [1, 2, 3],
                y: [0.1, 0.6, 1.1],
                line: {simplify: false},
                name: field_name
            }
        });

        var layout = {
            margin: {
                l: 50,
                r: 50,
                b: 50,
                t: 50,
                pad: 4
            }
        };

        Plotly.newPlot(this.domPlotDiv, lines, layout).then((res) => {
            this.plotDiv = res

            // Setting up selection event.
            res.on('plotly_relayout', function(evt) {
                if (relayoutPlots) {
                    return;
                }
                relayoutPlots = true;

                let update = null;
                if ("xaxis.range[0]" in evt) {
                    update = {
                        xaxis: {
                            range: [
                                evt["xaxis.range[0]"],
                                evt["xaxis.range[1]"]
                            ]
                        },
                        yaxis: {
                            autorange: true
                        }
                    }
                } else if ("xaxis.autorange" in evt) {
                    update = {
                        xaxis: {
                            autorange: true
                        },
                        yaxis: {
                            autorange: true
                        }
                    }
                }

                if (update) {
                    plots.forEach((plt) => {
                        Plotly.relayout(plt.plotDiv, update);
                    })
                }

                relayoutPlots = false;
            })
        })
    }

    addTrace(fieldName, fieldIndex) {
        this.displayedFieldNames.push(fieldName + '[' + fieldIndex + ']');
        this.displayedFieldData.push(plot_data[fieldName][fieldIndex]);
        this.displayedTraces.push(this.displayedTraces.length)

        Plotly.addTraces(this.plotDiv, plot_data[fieldName][fieldIndex])
    }

    updateTraces() {
        Plotly.animate(this.plotDiv, {
            data: this.displayedFieldData,
            traces: this.displayedTraces,
            layout: {}
        }, {
            transition: {
                duration: 0
            },
            frame: {
                duration: 0,
            }
        })

        let update = {
            xaxis: {
                autorange: true
            },
            yaxis: {
                autorange: true
            }
        }
        Plotly.relayout(this.plotDiv, update);
    }


    removeAllTraces() {
        Plotly.deleteTraces(this.plotDiv, this.displayedTraces)

        this.displayedFieldNames = [];
        this.displayedFieldData = [];
        this.displayedTraces = [];
    }

    addField(fieldName, fieldSize) {
        // Add the new field to the GUI.
        let option = document.createElement('option')
        option.textContent = fieldName + '['+ fieldSize + ']'
        option.value = fieldName
        this.domSelectFieldName.appendChild(option)
    }
}

function handleField(field_name, field_data) {
    parsed = field_data.slice(12, -2).split(', ')
    fieldSize = parsed.length

    if (!(field_name in plot_data)) {
        let emptyData = []
        for (i = 0; i < fieldSize; i++) {
            emptyData.push({
                x: plot_data_x,
                y: [],
                name: field_name + '[' + i + ']'
            })
        }
        plot_data[field_name] = emptyData;

        plots.forEach((plt) => plt.addField(field_name, fieldSize))
    }

    // Add the recieved data on the y axis.
    let field_plot_data = plot_data[field_name];

    // Remove data if we have logged too much.
    let shift_data = stream_data && plot_data_x.length > max_len;

    for (i = 0; i < fieldSize; i++) {
        field_plot_data[i].y.push(parseFloat(parsed[i]));

        if (shift_data) {
            field_plot_data[i].y.shift();
        }
    }
}

function parseData(data) {
    if (freeze_plot) {
        return;
    }
    data = JSON.parse(data)
    x = parseFloat(data['time'])

    plot_data_x.push(x)
    if (stream_data && plot_data_x.length > max_len)
        plot_data_x.shift()

    for (let [key, value] of Object.entries(data)) {
        if (key === 'time') {
            continue;
        }

        handleField(key, value);
    }
}

function update_plot() {
    if (got_data) {
        got_data = false
        plots.forEach((plt) => plt.updateTraces())


    }

    window.requestAnimationFrame(update_plot);
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

    // Read the header of hte file.
    let idx = dv.getUint32(0, true);
    let num_fields = dv.getUint32(4, true);
    offset += 8;

    // Reset the data as we will read new one.
    plot_data = {};
    plot_data_x = [];

    plots.forEach((plot) => plot.removeAllTraces())

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

        let empty_data = []
        for (i = 0; i < field_size; i++) {
            empty_data.push({
                x: plot_data_x,
                y: [],
                name: field_name + '[' + i + ']'
            });
        }

        plot_data[field_name] = empty_data;

        // Initialize the plot_data for this field.
        plots.forEach((plot) => plot.addField(field_name, field_size))
        console.log('  ', field_name, '@', field_size);
    }

    // Read the data blob.
    for (var j = 0; offset < data.length; j++) {
        for (let f = 0; f < num_fields; f++) {
            let field_name = field_names[f];
            for (let i = 0; i < field_sizes[f]; i++) {
                plot_data[field_name][i].y.push(dv.getFloat32(offset, true));
                offset += 4;
            }
        }
    }

    // Init the x-axis data.
    for (let i = 0; i < j; i++) {
        // HACK: Assuem dt=0.001 for now.
        plot_data_x.push(i * 0.001);
    }
}

function setup() {
    var ws = new WebSocket("ws://127.0.0.1:5678/");

    stream_data = true
    ws.onmessage = function (event) {
        console.log('got data');
        parseData(event.data);
        // When the plot is not frozen, indicate that there is new data to trigger
        // a relayout.
        got_data = !freeze_plot;
    };
    ws.onerror = function (event) {
        stream_data = false
        alert('Failed to open web socket. Assuming to load data file.')
    }

    document.querySelector('#btn_start_stop').addEventListener('click', (evt) => {
        freeze_plot = !freeze_plot;
    });

    document.querySelector('#btn_add_plot').addEventListener('click', (evt) => {
        plot = new Plot()
    });

    document.querySelector('#btn_load_log_file').addEventListener('click', async (evt) => {
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
        [fileHandle] = await window.showOpenFilePicker(pickerOpts);
        let file = await fileHandle.getFile();
        content = await file.arrayBuffer();
        readDatafile(content)
    })

    plot = new Plot()

    // Start the rendering process.
    window.requestAnimationFrame(update_plot);
};

setTimeout(setup, 1000)
