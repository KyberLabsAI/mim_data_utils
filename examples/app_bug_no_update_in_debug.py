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

from data_utils import DataReader

import numpy as np

external_stylesheets = ['https://codepen.io/chriddyp/pen/bWLwgP.css']

app = dash.Dash(__name__, external_stylesheets=external_stylesheets)


dr = DataReader('test.dgds')
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

    dcc.Graph(
        id='example-graph',
        figure=fig
    ),

    dcc.Interval(
        id='interval-component',
        interval=10, # in milliseconds
        n_intervals=0
    ),

    html.Div(
        id="other-plot",
        children='''
            Placeholder for JS plot.
        '''),
])

@app.callback(Output('example-graph', 'figure'),
              Output('info', 'children'),
              Input('interval-component', 'n_intervals'))
def update_figure(n):
    # dr = DataReader('test.dgds')
    # x = np.linspace(0., dr.idx, dr.idx + 1)

    x = np.linspace(0., dr.idx, dr.idx + 1)
    y = np.sin(x / (100) + time.time())

    fig = go.Figure()
    fig.add_trace(go.Scatter(x=x, y=y,
                        hovertext='ctrl.joint_positions[1]',
                        mode='lines'))
    fig.add_trace(go.Scatter(x=x, y=y + 1,
                        hovertext='ctrl.joint_velocities[1]',
                        mode='lines'))
    fig.add_trace(go.Scatter(x=x, y=y - 1,
                        hovertext='ctrl.joint_torques',
                        mode='lines'))

    print('Update', time.time())
    return fig, str(n)


if __name__ == '__main__':
    app.run_server(debug=True)
