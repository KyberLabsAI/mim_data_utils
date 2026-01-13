# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

**mim_data_utils** is a real-time data visualization platform for robotics and simulation research. It streams time-series data from Python backends via WebSocket to a browser-based visualizer with GPU-accelerated 2D plotting (WebGL2) and 3D scene rendering (Three.js).

## Installation & Setup

```bash
# Install Python package
pip install .

# For development in ROS2 workspace
# The package.xml indicates this is also a ROS2 ament_python package
colcon build --symlink-install

# Serve the web interface (optional - can also open index.html directly)
python -m http.server 8000
# Or for Android device testing:
./serve.sh  # Sets up ADB reverse tunneling + HTTP server
```

## Architecture Overview

### Data Flow Pipeline

```
Python Backend (logger.py)
  → Logger.log(data)                    # Queue data with timestamps
  → ormsgpack serialization             # Binary MessagePack encoding
  → WebSocket broadcast (port 5678)     # BinaryWebSocketServer

Browser Client (data_sources.js)
  → MessagePack.decode()                # Deserialize binary data
  → parsewebSocketData()                # Route samples vs commands
  → traces.record()                     # Store in chunked circular buffer

Rendering Pipeline
  → SeriesData chunks → LineChunks      # GPU-ready vertex data
  → GLLineDrawer                        # WebGL2 shader pipeline
  → AxesDrawer                          # Canvas 2D for axes/grid
  → Canvas output                       # Composite display
```

### Key Architectural Patterns

**Dual-Backend System**: Python logger can write to both WebSocket (live streaming) and compressed files (.mds format with zstandard compression). The `Logger` class accepts multiple writers via `child` parameter chaining.

**Chunked Circular Buffer**: Frontend uses `SeriesData` with fixed-size chunks (default 1024 entries). When max memory exceeded (default 5 min), oldest chunks auto-evict. Critical for real-time streaming without memory growth.

**WebGL Vertex Layout**: Lines rendered as quads (4 vertices per segment). Each vertex has `lineCenter` (x,y position) and `lineTangential` (direction vector). Vertex shader applies perpendicular offset for line thickness with dynamic aspect ratio correction (`canvas.height / canvas.width`) to ensure uniform line width across different canvas dimensions. Fragment shader outputs solid color.

**Message Format**: All messages are lists of entries with structure:
```python
{
  'type': 'sample',  # or 'command'
  'time': float,     # seconds
  'payload': {
    'field_name': array_or_scalar,
    '3d/object_name/pos': [x, y, z, qx, qy, qz, qw]  # 7D pose format
  }
}
```

**Layout DSL**: String format `"qpos[:3];qvel[0],qvel[1]"` where:
- Semicolons separate plots
- Commas place multiple traces on same plot
- Brackets support Python-like slicing and indexing

### Critical Implementation Details

**Logger Thread Safety**: The `Logger` class runs a daemon thread that flushes queued data every 10ms. Always use `Logger.log()` method - never write directly to the queue. The `wait_for_client(timeout_s=5)` method blocks until WebSocket client connects.

**3D Pose Handling** (scene.py): The `Scene.update()` method accepts multiple pose formats:
- 7D: `[x, y, z, qx, qy, qz, qw]` (position + quaternion)
- 4x4: Transformation matrix
- 6D: `[x, y, z, roll, pitch, yaw]` (Euler angles)
- 3D: `[x, y, z]` (position only)

All converted via `scipy.spatial.transform.Rotation` and output as `'3d/{name}/pos'` entries.

**GPU Buffer Management** (line.js): Each `LineChunk` maintains a `GPUBufferHandler` that lazily creates WebGL buffers per context. Uses `DYNAMIC_DRAW` with `bufferSubData()` for incremental updates. Track data version to avoid redundant uploads.

**WebGL Shader Uniforms** (set dynamically per draw call in line.js:348-367):
- `u_offset`, `u_transformCenter`: Viewport transformation (zoom/pan)
- `u_viewport2pixel`: Matrix converting viewport coords to pixels (`[canvas.width/2, 0, 0, canvas.height/2]`)
- `u_aspectCorrection`: Aspect ratio correction for line thickness (`canvas.height / canvas.width`)
- `u_color`, `u_z`: Line color and depth ordering

**Field Filtering**: Logger automatically skips fields starting with underscore and non-scalar arrays (except those matching `'3d/.*/pos'` or `'3d/.*/color'` regex patterns).

## File Organization

```
python/mim_data_utils/
  logger.py          # Core: Logger, FileLoggerWriter, WebsocketWriter
  scene.py           # 3D: RawMesh, Mesh, Scene
  mujoco.py          # Integration: MujocoVisualizer

js/
  main.js            # Entry point: layout parsing, user interactions, zoom/pan
  data_sources.js    # WebSocket client, file loading (.mds format)
  traces.js          # Data storage: SeriesData, SeriesDataChunk, Traces
  line.js            # WebGL rendering: LineChunk, GLLineDrawer
  plot.js            # Orchestration: Plot class coordinates components
  axes.js            # Canvas 2D: AxesDrawer, TickDrawer
  scene3d.js         # Three.js: Scene3D, ControlableViewer, WebXR
  marker.js          # Timeline marks (A, B, C labels)

index.html           # Main web interface (includes inline GLSL shaders)
indexVR.html         # VR variant with WebXR
```

## Python API Usage

```python
from mim_data_utils import Logger, Scene, RawMesh

# Start WebSocket server (runs in separate thread)
server = Logger.start_server(host='127.0.0.1', port=5678)
logger = Logger(server)

# Optional: Add file logging (chaining writers)
file_writer = FileLoggerWriter('data.mds', max_file_size_mb=100)
logger = Logger(file_writer, child=server)  # Writes to both file and WebSocket

# Wait for browser client to connect
logger.wait_for_client(timeout_s=5)

# Log timestamped data
logger.log({'qpos': np.array([1, 2, 3]), 'qvel': np.array([0.1, 0.2])}, time=0.001)

# Clear plots
logger.clear()

# Reset zoom to full view
logger.zoom_reset()

# Change layout programmatically
logger.layout('qpos[:3];qvel[0],qvel[1]')

# 3D scene usage
scene = Scene()
mesh = RawMesh(vertices=vertices, indices=indices, color=[1, 0, 0])
scene.add_mesh('robot', mesh)
scene.update({'robot': pose_7d})  # pose_7d = [x, y, z, qx, qy, qz, qw]
logger.log(scene.to_log(), time=t)
```

## JavaScript Extension Points

To add new plot types or data sources, key integration points:

**Custom data source**: Extend `parsewebSocketData()` in data_sources.js to handle new message types.

**Custom rendering**: Create new drawer class similar to `GLLineDrawer` in line.js. Register with `Plot` class in plot.js.

**3D objects**: Add to `Scene3D.addMesh()` in scene3d.js. Follow naming convention `'3d/{object_name}/pos'` for automatic updates.

## WebSocket Protocol

Default endpoint: `ws://127.0.0.1:5678/`

Messages are binary MessagePack arrays. Each array element is a dict with `type` field:

**Sample Message**:
```python
{
  'type': 'sample',
  'time': 0.001,
  'payload': {'qpos': [0.1, 0.2, 0.3], 'qvel': [0.0, 0.0]}
}
```

**Command Messages**:
- `{'type': 'command', 'name': 'clear', 'payload': {'maxData': 300000}}`
- `{'type': 'command', 'name': 'layout', 'payload': {'layout': 'qpos[:3]'}}`
- `{'type': 'command', 'name': '3dCamera', 'payload': {...}}`
- `{'type': 'command', 'name': 'zoomReset', 'payload': {}}`

## Frontend User Interactions

- **Timeline navigation**: Yellow vertical line shows current time. Click to jump, arrow keys to step (50ms default, 1ms with ALT).
- **Zooming**: Click-drag to zoom into time range. Double-click to zoom out (stack-based).
- **Panning**: SHIFT+drag for horizontal pan.
- **Layout editing**: Edit text field, press Enter to apply.
- **Freezing**: Clicking plot freezes live streaming. Double-click out to full view to resume.
- **Markers**: Press Enter to add timeline marker (labeled A, B, C, ...).

## ROS2 Integration

The package is both a Python package and ROS2 ament_python package. When in a ROS2 workspace:

```bash
colcon build --symlink-install --packages-select mim_data_utils
source install/setup.bash
```

Tests can be run via ROS2 test infrastructure:
```bash
colcon test --packages-select mim_data_utils
# Runs: ament_copyright, ament_flake8, ament_pep257, python3-pytest
```

## Performance Considerations

- Default max data size: 5 minutes (300,000 ms). Configurable via `clear` command.
- GPU upload optimization: Only modified `LineChunk` objects trigger `bufferSubData()`.
- WebSocket reconnection: Automatic retry every 100ms if disconnected.
- File compression: Zstandard level 10 for .mds files provides ~10x compression.
- Chunk size: 1024 entries per chunk balances memory granularity vs overhead.

## License

BSD 3-Clause License - Copyright (c) 2021 New York University
