# -*- coding: utf-8 -*-

# Run this app with `python app.py` and
# visit http://127.0.0.1:8050/ in your web browser.

import time

import dash
import dash_core_components as dcc
import dash_html_components as html
import plotly.express as px
import pandas as pd
import plotly.graph_objects as go
from dash.dependencies import Input, Output

import asyncio
import datetime
import json
import random
import websockets
import threading

from data_utils import DataReader

import numpy as np

external_stylesheets = ['https://codepen.io/chriddyp/pen/bWLwgP.css']

app = dash.Dash(__name__, external_stylesheets=external_stylesheets)

dr = DataReader('test.mds')
x = np.linspace(0., dr.idx, dr.idx + 1)

fig = go.Figure()
fig.add_trace(go.Scatter(x=x, y=dr.data['ctrl.joint_positions'][:, 1],
                    hovertext='ctrl.joint_positions[1]',
                    mode='lines'))
# fig.add_trace(go.Scatter(x=random_x, y=random_y1,
#                     mode='lines+markers',
#                     name='lines+markers'))
# fig.add_trace(go.Scatter(x=random_x, y=random_y2,
#                     mode='markers', name='markers'))

# About animating plots from JavaScript:
# https://plotly.com/javascript/animations/

# About updating the plot and preventing the view:
# https://community.plotly.com/t/preserving-ui-state-like-zoom-in-dcc-graph-with-uirevision-with-dash/15793


fig.update_layout(legend=dict(
    yanchor="top",
    y=0.99,
    xanchor="left",
    x=0.01
))

app.layout = html.Div(children=[
    html.H1(children='Hello Dash Tutorial'),

    html.Div(
        id="info",
        children='''
            Dash: A web application framework for Python.
        '''),

    html.Div(
        id="js_plot",
        style={
            'height': '400px'
        },
        children='''
            Plot generated from JavaScript placeholder.
        '''),
])

async def basic_streaming(websocket, path):
    reader = DataReader('test.mds')
    c = 0

    data = {}
    for c in range(reader.idx):
        now = datetime.datetime.utcnow().isoformat() + "Z"

        reader.read_chunck(c, data)

        # Convert the arrays to byte strings.
        for key, value in data.items():
            data[key] = str(value)

        data['_timestamp'] = now

        await websocket.send(json.dumps(data))
        await asyncio.sleep(0.001)

def ws_thread_fn():
    print("Hello world from ws thread.")

    # Init an event loop.
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    # Init streaming of data using websockets.
    start_server = websockets.serve(basic_streaming, "127.0.0.1", 5678)
    asyncio.get_event_loop().run_until_complete(start_server)
    asyncio.get_event_loop().run_forever()

if __name__ == '__main__':
    x = threading.Thread(target=ws_thread_fn)
    x.start()

    app.run_server(debug=False)
