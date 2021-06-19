
plot_data_x = [] // Use a single array for all the x data.
plot_data = {}

got_data = false

plot_div = undefined

max_len = 5000
displayed_field_names = []
displayed_field_data = []
displayed_traces = []

freeze_plot = false

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

    Plotly.newPlot('js_plot', lines).then(function(res) {
        plot_div = res
    })
}

function addTrace(field_name, field_index) {
    displayed_field_names.push(field_name + '[' + field_index + ']');
    displayed_field_data.push(plot_data[field_name][field_index]);
    displayed_traces.push(displayed_traces.length)

    Plotly.addTraces(plot_div, plot_data[field_name][field_index])
    // initPlot()
}


function handleField(field_name, field_data) {
    parsed = field_data.slice(12, -2).split(', ')

    if (!(field_name in plot_data)) {
        empty_data = []
        for (i = 0; i < parsed.length; i++) {
            empty_data.push({
                x: plot_data_x,
                y: []
            });
        }

        plot_data[field_name] = empty_data;
    }

    // Add the recieved data on the y axis.
    field_plot_data = plot_data[field_name]

    shift_data = field_plot_data[0].y.length > max_len;

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
    if (plot_data_x.length > max_len)
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
    // alert('Hello world ws & plotting.')
    var ws = new WebSocket("ws://127.0.0.1:5678/");

    var messages = document.createElement('ul');
    var message = document.createElement('li');
    messages.append(message)

    dbg = document.createElement('li');
    messages.append(dbg)

    ws.onmessage = function (event) {
        window.ws_data = event.data
        parseData(event.data)
        got_data = true
    };

    document.querySelector('#btn_start_stop').addEventListener('click', (evt) => {
        freeze_plot = !freeze_plot;
    })

    document.body.appendChild(messages);

    initPlot()
    window.requestAnimationFrame(update_plot);

};

setTimeout(setup, 1000)

