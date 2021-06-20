# Maschines in Motion Data Utils (mim_data_utils)

## What is this

A collection of scripts for:
* Experiment data storage (online, offline)
* Setup for plotting the data in the browser (online, offline)

## Installation

We rely on [plotly](https://plotly.com/) for the plotting part. We use the [websockets](https://websockets.readthedocs.io/en/stable/intro.html) library to communicate data between the browser and the server.

```
$ pip install websockets
```

## Examples

See `examples/` folder.

## Todos
- [ ] Get live plotting at 30 Hz working
- [ ] Have the data streamed in the data file and treat the file as ring buffer
- [ ] Write documentation for the data protocol

## License and Copyrights

Copyright(c) 2021 New York University.

BSD 3-Clause License
