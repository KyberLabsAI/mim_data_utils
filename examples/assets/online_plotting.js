
plot_data_x = [] // Use a single array for all the x data.
plot_data = {}

got_data = false

plot_div = undefined

max_len = 5000
displayed_field_names = []
displayed_field_data = []
displayed_traces = []

freeze_plot = false
stream_data = true

function initPlot() {
    if (plot_div) {
        Plotly.purge(plot_div)
    }

    lines = displayed_field_names.map(function(field_name) {
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

    Plotly.newPlot('js_plot', lines, layout).then(function(res) {
        plot_div = res
    })
}

function addTrace(field_name, field_index) {
    displayed_field_names.push(field_name + '[' + field_index + ']');
    displayed_field_data.push(plot_data[field_name][field_index]);
    displayed_traces.push(displayed_traces.length)

    Plotly.addTraces(plot_div, plot_data[field_name][field_index])
}

function remove_all_traces() {
    Plotly.deleteTraces(plot_div, displayed_traces)

    displayed_field_names = []
    displayed_field_data = []
    displayed_traces = []
}


function handleField(field_name, field_data) {
    parsed = field_data.slice(12, -2).split(', ')

    if (!(field_name in plot_data)) {
        let empty_data = []
        for (i = 0; i < parsed.length; i++) {
            empty_data.push({
                x: plot_data_x,
                y: [],
                name: field_name + '[' + i + ']'
            });
        }

        plot_data[field_name] = empty_data;

        // Add the new field to the GUI.
        let option = document.createElement('option')
        option.textContent = field_name
        option.value = field_name
        document.querySelector('#trace_field_name_select').appendChild(option)
    }

    // Add the recieved data on the y axis.
    let field_plot_data = plot_data[field_name]

    let shift_data = stream_data && field_plot_data[0].y.length > max_len;

    for (i = 0; i < parsed.length; i++) {
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
        Plotly.animate('js_plot', {
            data: displayed_field_data,
            traces: displayed_traces,
            layout: {}
        }, {
            transition: {
                duration: 1,
                easing: 'cubic-in-out'
            },
            frame: {
                duration: 1
            }
        })
    }

    window.requestAnimationFrame(update_plot);
}

function setup() {
    var ws = new WebSocket("ws://127.0.0.1:5678/");

    stream_data = true
    ws.onmessage = function (event) {
        parseData(event.data)
        got_data = true
    };
    ws.onerror = function (event) {
        stream_data = false
        alert('Failed to open web socket. Assuming to load data file.')
    }

    document.querySelector('#btn_start_stop').addEventListener('click', (evt) => {
        freeze_plot = !freeze_plot;
    });

    document.querySelector('#btn_add_traces').addEventListener('click', (evt) => {
        let field_name = document.querySelector('#trace_field_name_select').value
        let ids = document.querySelector('#trace_field_index_input').value
        ids = ids.split(',').map((e) => parseInt(e.trim()))

        ids.forEach((id) => {
            addTrace(field_name, id)
        })
    });

    document.querySelector('#btn_remove_all_traces').addEventListener('click', (evt) => {
        remove_all_traces();
    });

    document.querySelector('#btn_load_log_file').addEventListener('click', (evt) => {

    })

    initPlot()
    window.requestAnimationFrame(update_plot);

};

setTimeout(setup, 1000)

