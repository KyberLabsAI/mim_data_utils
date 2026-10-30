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

Memory: traces are stored in chunks of 1024 samples (float32 values, float64
times). Once a chunk is full, a column whose values are all the same is kept as
one number and identical time columns are shared between series (lossless;
on a hand session about 4x less memory). Each plotted line keeps its points
once more for the GPU (8 bytes per sample), freed as soon as no plot shows the
line anymore. All plots draw their lines with one shared WebGL2 context
(browsers drop the oldest beyond ~16 contexts), copied into each plot's 2D
canvas. `traceMemory()` in the browser console prints what is held.

## Exporting data

*Export data* (top bar) first asks what to export, one checkbox each:

* **Traces**: the time series.
* **`<camera>` (video)**, one per image source: the buffered camera images,
  re-encoded in the browser (WebCodecs `VideoEncoder`, H.264, VP9 as
  fallback; ~0.1 bit per pixel and frame, a keyframe every 2 s). Consecutive
  frames share most of their content, so this is ~5-20x smaller than the JPEGs.
  Every frame keeps its capture timestamp.
* **`<camera>` (overlays)**, one per image source with overlays
  (`Logger.log_overlay`): the rendered overlay PNGs, per frame (with the
  capture time of the image each belongs to) and the static versions.
* **`<source>` (depth)**, one per depth source / point cloud: the raw u16
  depth frames, their JPEG colour images, depth scale and intrinsics.
* **Markdown messages**: the `Logger.log_md` messages.
* **3D scene setup**: the registered 3D objects (meshes with their vertices and
  indices, point cloud setups); their `3d/<name>/pos` / `color` series are
  exported with it.

Sources shown in the layout start checked. Then the range: the last 0.5 / 1 /
2 / 5 / 10 / 20 minutes (counted back from the newest exported sample),
*Displayed* (the series plotted in the current layout, all buffered samples),
or *All*. It downloads what the viewer currently holds (the in-memory window,
not older data it has already dropped: ~1000 images per camera, 200 depth
frames per source) as one gzip-compressed `export_<time>_<selection>.mdutrace.gz`,
with a progress dialog; the header's `selection` records the choice. Camera
images already handed over to recorded video segments are not in the window.
The markers and the session's viewer settings (plot layout, 3D cameras) always
go along.

```python
from mim_data_utils import (load_mdutrace, load_mdutrace_videos, load_mdutrace_depth,
                            load_mdutrace_scene, load_mdutrace_overlays,
                            load_mdutrace_log, composite)

f = 'export_....mdutrace.gz'
traces = load_mdutrace(f)
t, cur = traces['current']      # t: (n,) float64 [s], cur: (n, dim) float32

cam = load_mdutrace_videos(f)['wrist']  # MduVideo
cam.times                       # (n,) the capture timestamps (trace time axis)
cam.write('wrist.mp4')          # no re-encode; frame k at times[k] - times[0]
for t, img in cam.frames():     # decoded RGB frames with their timestamps
    ...

depth = load_mdutrace_depth(f)['3d/d405']   # MduDepth
z = depth.depth_m(0)            # (h, w) [m]; depth.rgb(0), depth.points(0)
scene = load_mdutrace_scene(f)  # {name: registration payload, arrays as numpy}

ov = load_mdutrace_overlays(f)['wrist']['replay_object']   # MduOverlay
for t, img in cam.frames():
    rgba, offset = ov.at(t)     # this frame's overlay, else the static one then
    img = composite(img, rgba, offset)   # as the viewer shows it

log = load_mdutrace_log(f)      # {'markdown': [(t, text)], 'markers': [(label, t)], 'settings': {...}}
```

The mp4 timestamps have microsecond resolution (mkv / webm round to 1 ms),
so the video timing matches the image timestamps; the start time `t0` is in
the mp4's `comment` metadata. Needs PyAV (`pip install av`) for the videos and
the depth colour images.

`python -m mim_data_utils.trace_dump <file>` lists the contents of an export;
`--videos [OUT_DIR]` also writes every camera as `<export>_<camera>.mp4` (next
to the export by default). The file layout is documented at the top of
`js/trace_export.js`. Older trace-only dumps (version 1) still load.

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
without it, Pillow with 4x supersampling, about 4x slower), and sends only that; the camera frame is not sent again.
Rendering runs in a separate Python process, on the CPUs the server is not
pinned to and at a lower priority, so it does not slow down the relaying of
the other data. Its instruction queue holds 64 overlays; while it is full, new
overlays are dropped (the server's `[overlay]` stats line counts them). In the viewer
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

### Static overlays

`static=True` makes an overlay that belongs to no frame: the viewer draws it
over every frame of the camera, from its time on, until a new static overlay
with the same name replaces it (scrubbing back shows the version valid then).
A wireframe of a tracked object, for example:

```python
from kyber_utils.draw_image_3d import DrawImage3D

ov = Overlay()
DrawImage3D(camera).set_overlay(ov).draw_wireframe(
    'cup.stl', pose=T_cam_obj, scale=1e-3,           # mesh file in mm, cached per file
    edge_color=(0, 255, 255, 180), vertex_color=(255, 0, 0),
    edge_width=1, vertex_radius=2)
logger.log_overlay(t, 'cam', None, 'cup', ov, static=True)
```

Each version is rendered and sent once: calling this every tick with the same
drawing sends nothing new (the Logger repeats an unchanged one every 5 s, which
the server drops if it has it already), and the viewer decodes each version's
PNG once. Static overlays go at a higher priority than camera frames, so
backpressure doesn't drop them. The server keeps the current one per overlay
and sends it to viewers that connect later (page reload) and at the start of
every recording and snapshot.

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
