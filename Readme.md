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

## Image overlays

Debug drawings on camera images are logged as vector overlays instead of a
second, annotated copy of the image:

```python
from mim_data_utils import Overlay

logger.log_image('cam', jpeg_bytes, t, number=frame_counter)

ov = (Overlay()
      .lines(corners, color=(0, 255, 0), width=2, closed=True)
      .text(x, y, 'id=3', color=(0, 255, 0), bg=(0, 0, 0, 160))
      .circle(cx, cy, 4, width=0, fill=(255, 0, 0))
      .rect(x0, y0, x1, y1, color=(255, 255, 0), width=1))
logger.log_overlay(t, 'cam', frame_counter, 'tags', ov, size=(w, h))
```

Coordinates are image pixels, colors RGB(A) 0-255. The overlay refers to the
frame logged with the same `number` (or, with `img_number=None`, the frame
logged at exactly the same time). `size` defaults to the size of the images the
server last saw on that topic.

The server renders each overlay into a transparent PNG cropped to the drawn
area, antialiased at sub-pixel positions with skia (`pip install skia-python`;
without it, Pillow with 4x supersampling, about 4x slower), and sends only that; the camera frame is not sent again. In the viewer
every overlay name is an image of its own, `<camera> / <overlay>`, placed
right after the camera image: the frame with only that overlay drawn over it.
*Set Layout -> Visuals* groups these overlay images under their camera (a
checkbox each), followed by the camera's live view setting (also in the bar
shown when hovering an overlay image).

Overlays arrive after their image and often exist for only some frames (e.g.
AprilTags at the detector rate), so an overlay image shows the newest frame
that has its overlay (looking back up to 1 s); it trails the live camera image
by the overlay latency and doesn't flicker. *Live view* `Top left`, ... adds
the newest camera frame as a small picture-in-picture in that corner of the
overlay images. Overlays are not drawn while a camera plays back from video
segments. Overlays are recorded like
images (with `embed_video`).

## Recording

Recordings are written by the server process (`serve.sh`): every message it
sends to the viewers also goes into the active recordings (`.zst`, readable with
`FileLoggerReader`, plus `_begin`/`_end` camera images and optional per-camera
H.265 `.mp4`). They land in `$MIM_RECORDINGS_DIR` (`serve.sh` sets it to the
workspace's `recordings/`).

From Python, through any `Logger` (the call only sends a request, ~1 ms):

```python
prefix = logger.record()                     # until stopped
logger.stop_recording(prefix)                # finalised in the background
logger.wait_recording(prefix)                # until the files are complete

p = logger.record(snapshot=True)             # _begin images + 1 s of data, no _end
p = logger.record(2, snapshot=True, average=True)   # _begin = mean of 2 s of frames
p = logger.record(10, encode_video='480x360 15fps cq32')
logger.stop_recording(p, delete=True)        # end it and delete its files
logger.recordings()                          # active prefixes
```

A camera with image overlays additionally gets, per `_begin`/`_end` image and
overlay name, `<prefix>_<camera>_overlay_<name>.png` (the frame with that
overlay drawn over it, like the overlay image in the viewer) and
`..._overlay_<name>_alpha.png` (the overlay alone, full size, transparent).
Since overlays arrive after their image and not every frame has one, the
capture waits up to 0.6 s until each overlay has a frame and uses the first
frame with that overlay (with `average`: its last overlay over the averaged
image).

Several recordings can run at the same time. `record.sh` is the same thing
behind keyboard keys (SPACE start/stop or snapshot, `c` quick capture), with
the options documented in the script; it needs `serve.sh` running.

## License and Copyrights

Copyright(c) 2021 New York University.

BSD 3-Clause License
