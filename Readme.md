# Machines in Motion Data Utils (mim_data_utils)

## What is this

A collection of scripts for:
* Experiment data storage (online, offline)
* Setup for plotting the data in the browser (online, offline)

## Installation

From the top folder, run

```
pip install .
```

Then open the `index.html` file locally in your browser (no need for a webserver).

## Examples

See `example/` folder. 

## Visualizer usage

Use the layout input to specify which data to plot. An entry like `qpos[:3];qvel[0],qvel[1],qvel[2]` creates two plots. Different plots are sepeated by semicolons. Which timeseries to plot is given by a name (e.g. `qpos`). Which entry of the timeseries to plot is given within the brackets. The syntax supports slicing like in python (e.g. `qpos[:3]` plots the first 3 entries of `qpos`) as well as individual entries. Multiple timeseries can be displayed in one plot by placing a comma between them (e.g. `qvel[0],qvel[1]`). To update the layout, update the text and then press enter.

The plots have a current time, which is the yellow vertical line. The data at this time is what is also shown in the 3D viewer. When using live plotting, the plot freezes when clicked once. Clicking at a different location moves the current time. You can move the current time relatively using the left and right arrow keys (in steps of 50 ms). If you hold down the ALT key and press the left or right arrow keys, the time-steps will be by 1 ms.

The y-axis is always auto zoomed to display the range of data displayed. The duration to display is controlled by the drop down next to the "Layout:" on the webpage. You can move to previous timeseries by holding down the SHIFT key, clicking on the plot and dragging the mouse.

Zooming is supported by click and hold: Assuming you want to zoom onto the time between 1 and 2 s. To do this, you can either adjust the time resolution from the drop box. Otherwise, you can click on the 1 s on the plot, keep the mouse pressed, move to 2 s and lift the mouse again. This will zoom onto this timespan. You can keep zooming further by selecting a new subset. To zoom out again, double click.

Note that clicking on the plot or zooming freezes the live-plotting. To resume the live-plotting, double click till you are zoomed out completely again.

At this time, the plotter renders all data poins using the GPU.

## License and Copyrights

Copyright(c) 2021 New York University.

BSD 3-Clause License
