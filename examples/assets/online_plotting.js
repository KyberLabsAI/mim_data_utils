// Inject
// document.addEventListener("DOMContentLoaded", function() {
plot_data_joint_velocity_2 = {
    'x': [],
    'y': [],
}

plot_data_joint_velocity_1 = {
    'x': [],
    'y': [],
}

function parseData() {
    data = JSON.parse(window.ws_data)
    // data = "array('d', [0.0, 0.003146721098158093, 0.9104816593594021, -1.8725880262586807, 0.006809609095255532, 0.9221193364461262, -1.9009687042236325, -0.0026484896341959618, -0.9214965371025934, 1.9187384728325736, -0.006649294747246614, -0.9023925196329752])"

    parsed = data['ctrl.joint_velocities'].slice(12, -2).split(', ')

    // dbg.textContent = parsed

    plot_data_joint_velocity_1.x.push(plot_data_joint_velocity_1['x'].length)
    plot_data_joint_velocity_1.y.push(parseFloat(parsed[1]))

    plot_data_joint_velocity_2.x.push(plot_data_joint_velocity_2['x'].length)
    plot_data_joint_velocity_2.y.push(parseFloat(parsed[2]))
}

function update_plot() {
    Plotly.animate('js_plot', {
        data: [
            // plot_data_joint_velocity_1,
            plot_data_joint_velocity_2
        ],
        traces: [0],
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
        // message.textContent = event.data

        // message.appendChild(content);
        // messages.appendChild(message);

        parseData()
    };

    Plotly.newPlot('js_plot', [{
        x: [1, 2, 3],
        joint_positions_0: [0, 0.5, 1],
        y: [0.1, 0.6, 1.1],
        line: {simplify: false},
    }]);


    document.body.appendChild(messages);

    window.requestAnimationFrame(update_plot);

};

setTimeout(setup, 3000)

