
plot_data_x = [] // Use a single array for all the x data.
plot_data = {}

got_data = false
max_len = 1000

freeze_plot = false
relayoutPlots = false
stream_data = true
scheduledRequestAnimationFrame = false

plots = []

function parseFieldIndex(str, fieldSize)
{
    let errorMsg = '';
    let ids = str.split(',').map((e) => e.trim());
    let parseIds = []

    for (let id of ids) {
        let match, start, stop, step;
        // Test for start-stop-step:
        if (match = /^(\d+)\s*:\s*(\d+)\s*:\s*(\d+)$/.exec(id)) {
            start = parseInt(match[1]);
            stop = Math.min(parseInt(match[2]), fieldSize);
            step = parseInt(match[3]);

        // Test for start-step.
        } else if (match = /^(\d+)\s*:\s*:\s*(\d+)$/.exec(id)) {
            start = parseInt(match[1]);
            stop = fieldSize;
            step = parseInt(match[2]);

        // Test for start-stop.
        } else if (match = /^(\d+)\s*:\s*(\d+)$/.exec(id)) {
            start = parseInt(match[1]);
            stop = parseInt(match[2]);
            step = 1;

        // Test for stop only.
        } else if (match = /^:\s*(\d+)$/.exec(id)) {
            start = 0;
            stop = parseInt(match[1]);
            step = 1;

        // Test for start only.
        } else if (match = /^\s*(\d+):$/.exec(id)) {
            start = parseInt(match[1]);
            stop = fieldSize;
            step = 1;

        // Test for single number:
        } else if (match = /^(\d+)$/.exec(id)) {
            start = parseInt(match[1]);
            stop = start + 1
            step = 1
        } else {
            errorMsg = 'Unable to parse indexing "' + id + '"';
        }

        if (start >= fieldSize || start < 0) {
            errorMsg = 'Start index "' + start + '" out of bounds';
            break;
        }

        if (step < 0) {
            errorMsg = 'Only supporting positive step index';
            break;
        }

        // Add the ids to the list.
        for (let i = start; i < stop; i += step) {
            parseIds.push(i);
        }
    }

    return [parseIds, errorMsg]
}

function findXDataRange(xFrom, xTo)
{
    let xIdxFrom, xIdxTo;
    for (xIdxFrom = 0; xIdxFrom < plot_data_x.length; xIdxFrom++) {
        if (plot_data_x[xIdxFrom] >= xFrom) {
            xIdxFrom -= 1;
            break;
        }
    }

    xIdxTo = xIdxFrom + 1
    for (xIdxTo; xIdxTo < plot_data_x.length; xIdxTo++) {
        if (plot_data_x[xIdxTo] >= xTo) {
            break;
        }
    }

    return [xIdxFrom, xIdxTo]
}

function updatePlotLayouts(update, xIdxFrom, xIdxTo) {
    plots.forEach((plt) => {
        // For each visible line, loop over the y data and find
        // min max values.
        let ymin = Number.MAX_VALUE, ymax = Number.MIN_VALUE;
        for (let line of plt.plotDiv.data) {
            if (line.visible === undefined || line.visible === true) {
                let dataY = line.y
                for (let i = xIdxFrom; i < xIdxTo; i++) {
                    if (dataY[i] < ymin) {
                        ymin = dataY[i];
                    }
                    if (dataY[i] > ymax) {
                        ymax = dataY[i];
                    }
                }
            }
        }

        if (ymin == Number.MAX_VALUE && ymax == Number.MIN_VALUE) {
            update.yaxis = { autorange: true };
        } else {
            let margin = 0.05 * (ymax - ymin) // Add 5% on each side.
            update.yaxis = { range: [ymin - margin, ymax + margin] }
        }

        Plotly.relayout(plt.plotDiv, update);
    });
}

function force_update() {
    // Take the x range from the first plot and hope it exists always.
    let layout = plots[0].plotDiv.layout;
    repaint_update = {
        xaxis: layout.xaxis,
    }
    reapint_data = findXDataRange(
        layout.xaxis.range[0], layout.xaxis.range[1])

    relayoutPlots = true;
    updatePlotLayouts(layout, reapint_data[0], reapint_data[1]);
    relayoutPlots = false;
}

class Plot {
    constructor(domId) {
        this.domId = domId;

        this.displayedFieldNames = []
        this.displayedFieldData = []
        this.displayedTraces = []
        this.displayedFieldInfo = []

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
            let [ids, errorMsg] = parseFieldIndex(
                this.domTraceFieldIndexInput.value, plot_data[fieldName].length);

            if (errorMsg) {
                alert(errorMsg);
                return;
            }

            if (ids.length === 0 || isNaN(ids[0])) {
                alert("Please provide valid indices of the data to add.");
                document.querySelector('#trace_field_index_input').focus();
                return;
            }

            ids.forEach((id) => {
                this.addTrace(fieldName, id)
            })

            setUrlHashFromPlots();
            force_update();
        });

        this.domBtnRemoveTraces.addEventListener('click', (evt) => {
            this.removeAllTraces();
            setUrlHashFromPlots();
            force_update();
        });

        this.domBtnRemovePlot.addEventListener('click', (evt) => {
            this.removePlot();
            setUrlHashFromPlots();
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
            },
            showline: true,
            // hovermode: 'x',
            shapes: [{
                xid: plots.length + 1,
                type: 'line',
                // x-reference is assigned to the x-values
                xref: 'x',
                // // y-reference is assigned to the plot paper [0,1]
                yref: 'paper',
                fillcolor: '#d3d3d3',
                opacity: 0.1,
                x0: 0,
                x1: 0,
                y0: 0.,
                y1: 1.
            }],
            legend: {
                yanchor: "top",
                y: 0.99,
                xanchor: "right",
                x: 0.99
            }
        };


        Plotly.newPlot(this.domPlotDiv, lines, layout).then((res) => {
            this.plotDiv = res

            let repaint_update = null;
            let reapint_data = []

            // Clicking on the legend to toggle a line does not result in an
            // update right away. Therefore, whenenver the mouse goes up,
            // force layout-range-update on the next afterplot event (see below).
            this.domPlotDiv.addEventListener('mouseup', function(evt) {
                repaint_update = {
                    xaxis: res.layout.xaxis,
                }
                reapint_data = findXDataRange(
                    res.layout.xaxis.range[0], res.layout.xaxis.range[1])
            })

            res.on('plotly_afterplot', function() {
                if (repaint_update) {
                    let layout = repaint_update;
                    repaint_update = null;
                    relayoutPlots = true;
                    updatePlotLayouts(layout, reapint_data[0], reapint_data[1]);
                    relayoutPlots = false;
                }
            })

            // Setting up selection event.
            res.on('plotly_relayout', function(evt) {
                if (relayoutPlots) {
                    return;
                }
                relayoutPlots = true;

                let xIdxFrom, xIdxTo;
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

                    let res = findXDataRange(
                        evt["xaxis.range[0]"], evt["xaxis.range[1]"]);
                    xIdxFrom = res[0]
                    xIdxTo = res[1]
                } else if ("xaxis.autorange" in evt) {
                    update = {
                        xaxis: {
                            autorange: true
                        },
                        yaxis: {
                            autorange: true
                        }
                    }

                    xIdxFrom = 0;
                    xIdxTo = plot_data_x.length;
                }

                if (update) {
                    updatePlotLayouts(update, xIdxFrom, xIdxTo);
                }

                relayoutPlots = false;
            })

            res.on('plotly_hover', function(data) {
                relayoutPlots = true;
                // Update the cursor on all plots.
                for (let plot of plots) {
                    let layout = plot.plotDiv.layout

                    var update = {
                        'shapes[0].x0': data.points[0].x,
                        'shapes[0].x1': data.points[0].x,
                    };
                    Plotly.relayout(plot.plotDiv, update);
                }
                relayoutPlots = false;
            })
        })
    }

    addTrace(fieldName, fieldIndex) {
        this.displayedFieldNames.push(fieldName + '[' + fieldIndex + ']');
        this.displayedFieldData.push(plot_data[fieldName][fieldIndex]);
        this.displayedTraces.push(this.displayedTraces.length)
        this.displayedFieldInfo.push({
            'fieldName': fieldName,
            'fieldIndex': fieldIndex
        })

        Plotly.addTraces(this.plotDiv, plot_data[fieldName][fieldIndex]);
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
        this.displayedFieldInfo = [];
    }

    removeAllFields() {
        this.domSelectFieldName.innerText = '';
    }

    addField(fieldName, fieldSize) {
        // Add the new field to the GUI.
        let option = document.createElement('option')
        option.textContent = fieldName + '['+ fieldSize + ']'
        option.value = fieldName
        this.domSelectFieldName.appendChild(option)
    }
}

function setUrlHashFromPlots() {
    let searchParams = new URLSearchParams(document.location.search)

    let hash = '';

    plots.forEach((plot, idx) => {
        let displayed = {};
        plot.displayedFieldInfo.forEach(info => {
            if (info.fieldName in displayed) {
            displayed[info.fieldName].push(info.fieldIndex);
          } else {
            displayed[info.fieldName] = [info.fieldIndex];
          }
        });

        let plotFields = ''
        fields = Object.keys(displayed);
        fields.forEach(fieldName => {
            let indices = displayed[fieldName];

            if (plotFields != '') {
                plotFields += ';'
            }

            plotFields += fieldName + '=' + indices;
        });

        if (hash != '') {
            hash += '&';
        }

        hash += 'plot' + idx + ':' + plotFields;
    });

    document.location.hash = '#' + hash;
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
    let shift_data = stream_data && field_plot_data[0].y.length > max_len;

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

    // Store the plots displayedFieldInfo to restore after the load again.
    let plots_display_field_info = plots.map((plot) => plot.displayedFieldInfo);

    // Reset the data as we will read new one.
    plot_data = {};
    plot_data_x = [];

    plots.forEach((plot) => plot.removeAllTraces())
    plots.forEach((plot) => plot.removeAllFields())


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

    // Restore the displayed plots if they are in the data still.
    plots_display_field_info.forEach((displayFieldInfo, plot_i) => {
        displayFieldInfo.forEach((info) => {
            let fieldName = info['fieldName'];
            let fieldIndex = info['fieldIndex'];
            if (fieldName in plot_data && fieldIndex in plot_data[fieldName]) {
                plots[plot_i].addTrace(fieldName, fieldIndex);
            }
        })
    });
}

let lastUrlHash = '';
function rebuildPlotsFromUrlHash() {
    // Remove all plots.
    plots.forEach(plot => plot.removePlot());

    // Parse the current hash.
    let plotParts = location.hash.substring(1).split('&');

    let plotArray = [];

    plotParts.forEach(plotPart => {
        let parts = plotPart.split(':');
        let plotId = parseInt(parts[0].substring(4), 10);
        plotArray[plotId] = {};

        let fields = parts[1].split(';');
        fields.forEach(field => {
            let parts = field.split('=');
            plotArray[plotId][parts[0]] = parts[1].split(',').map(entry => parseInt(entry, 10));
        });
    });

    for (let i = 0; i < plotArray.length; i++) {
        new Plot();
    }

    let restorePlotTraces = () => {
        for (let i = 0; i < plotArray.length; i++) {
            let plotData = plotArray[i];
            let plot = plots[i];
            if (plotData) {
                Object.keys(plotData).forEach(fieldName => {
                    if (!(fieldName in plot_data)) {
                        return;
                    }

                    let fieldIndices = plotData[fieldName];
                    fieldIndices.forEach(index => {
                        plot.addTrace(fieldName, index);
                    })
                })
            }
        }
    }
    setTimeout(restorePlotTraces, 0);
}

function setup() {
    var ws = new WebSocket("ws://127.0.0.1:5678/");

    stream_data = true
    ws.onmessage = function (event) {
        // console.log('got data');
        parseData(event.data);

        // Check if the UrlHash has changed since last check. This can happen when
        // the page gets reloaded and first new data arrives.
        if (lastUrlHash != location.href) {
            lastUrlHash = location.href;
            rebuildPlotsFromUrlHash();
        }

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

    reload_file_handle = async (evt) => {
        let file = await fileHandle.getFile();
        content = await file.arrayBuffer();
        readDatafile(content);

        // Check if the UrlHash has changed since last check. This can happen when
        // the page gets reloaded and first new data arrives.
        if (lastUrlHash != location.href) {
            lastUrlHash = location.href;
            rebuildPlotsFromUrlHash();
        }
    }

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
        reload_file_handle()
    })

    document.querySelector('#btn_reload_log_file').addEventListener('click', reload_file_handle)

    plot = new Plot()

    // Start the rendering process.
    window.requestAnimationFrame(update_plot);
};

setTimeout(setup, 0)
