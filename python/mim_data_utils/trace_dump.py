"""Load a data export of the viewer ("Export data" button, js/trace_export.js).

    from mim_data_utils import load_mdutrace, load_mdutrace_videos
    traces = load_mdutrace('export_....mdutrace.gz')
    t, v = traces['current']        # t: (n,) float64 [s], v: (n, dim) float32

    videos = load_mdutrace_videos('export_....mdutrace.gz')
    cam = videos['camera']          # MduVideo: codec, width, height, times
    cam.write('camera.mp4')         # frame k shown at cam.times[k] - cam.times[0]
    for t, img in cam.frames():     # decoded (height, width, 3) uint8 RGB
        ...

    depth = load_mdutrace_depth('export_....mdutrace.gz')
    d = depth['3d/d405']            # MduDepth: times, registration, ...
    z = d.depth_m(0)                # (height, width) float [m], 0 = no depth
    xyz = d.points(0)               # (N, 3) camera-frame points, as the viewer draws them

    scene = load_mdutrace_scene('export_....mdutrace.gz')
    mesh = scene['3d/table']        # registration: vertices, indices, material, ...

The videos keep the capture time of every image: `times` holds the exact
image timestamps (the time axis of the traces), and write() places frame k at
times[k] - times[0] in the mp4 (microsecond resolution).

python -m mim_data_utils.trace_dump <file> lists the series, videos, depth
sources and scene objects of an export; with --videos [OUT_DIR] it also writes every video as an mp4 (named
<export>_<camera>.mp4, next to the export by default).
"""
import argparse
import gzip
import json
import os
import re
from fractions import Fraction

import numpy as np

# Microseconds: what the browser encoder runs on, and the mp4 timescale.
_TIME_BASE = Fraction(1, 1_000_000)


def _read(path):
    """(header, buf, payload start) of a .mdutrace(.gz) file."""
    with open(path, 'rb') as f:
        buf = f.read()
    if buf[:2] == b'\x1f\x8b':
        buf = gzip.decompress(buf)
    if buf[:8] != b'MDUTRACE':
        raise ValueError(f'{path}: not a viewer export')
    header_len, version = np.frombuffer(buf, '<u4', 2, 8)
    if version not in (1, 2):
        raise ValueError(f'{path}: unsupported version {version}')
    header = json.loads(buf[16:16 + header_len])
    return header, buf, 16 + int(header_len)


def load_mdutrace(path):
    """{name: (times, values)} of a .mdutrace(.gz) file, sorted by time."""
    header, buf, base = _read(path)
    out = {}
    for s in header['series']:
        n, dim = s['n'], s['dim']
        t = np.frombuffer(buf, '<f8', n, base + s['times_offset'])
        v = np.frombuffer(buf, '<f4', n * dim, base + s['data_offset']).reshape(dim, n).T
        order = np.argsort(t, kind='stable')
        out[s['name']] = (t[order], v[order])
    return out


class MduVideo:
    """One camera of an export: the encoded packets (decode order) and the
    capture time of each.

    Attributes: name, codec (WebCodecs string, 'avc1.*' = H.264 Annex B,
    'vp09.*' = VP9), width, height, times ((n,) float64 [s], the image
    timestamps), keyframes ((n,) bool), packets (list of n bytes), info (the
    header entry: bitrate, frames_in, skipped, ...).
    """

    def __init__(self, info, times, keyframes, packets):
        self.info = info
        self.name = info['name']
        self.codec = info['codec']
        self.width = int(info['width'])
        self.height = int(info['height'])
        self.times = times
        self.keyframes = keyframes
        self.packets = packets

    def __len__(self):
        return len(self.packets)

    def __repr__(self):
        span = self.times.max() - self.times.min() if len(self) else 0.
        return (f'MduVideo({self.name!r}, {self.codec}, {self.width}x{self.height}, '
                f'{len(self)} frames, {span:.2f} s, {sum(map(len, self.packets)) / 1e6:.2f} MB)')

    @property
    def ffmpeg_codec(self):
        """The ffmpeg / PyAV codec name: 'h264' or 'vp9'."""
        if self.codec.startswith(('avc1', 'avc3')):
            return 'h264'
        if self.codec.startswith('vp09'):
            return 'vp9'
        raise ValueError(f'{self.name}: unsupported codec {self.codec}')

    def _pts_dts(self):
        """Presentation / decode timestamps [us since times.min()]. The
        packets are in decode order; should the encoder have reordered frames,
        dts are the sorted pts, shifted so that no dts is after its pts."""
        pts = np.round((self.times - self.times.min()) * 1e6).astype(np.int64)
        dts = np.sort(pts)
        dts -= max(0, int(np.max(dts - pts)))
        return pts, dts

    def write(self, path):
        """Writes the video to `path` (mp4 recommended: microsecond timing;
        mkv / webm round to 1 ms) without re-encoding. Frame k is shown at
        times[k] - times.min(); the start time is stored in the 'comment'
        metadata (t0=<s>). Returns `path`."""
        import av
        pts, dts = self._pts_dts()
        with av.open(str(path), 'w') as out:
            out.metadata['comment'] = f't0={float(self.times.min())!r}'
            stream = out.add_stream(self.ffmpeg_codec)
            stream.width, stream.height = self.width, self.height
            stream.time_base = _TIME_BASE
            for data, p, d, key in zip(self.packets, pts, dts, self.keyframes):
                packet = av.Packet(data)
                packet.pts, packet.dts = int(p), int(d)
                # Constant: the muxer may change stream.time_base on write.
                packet.time_base = _TIME_BASE
                packet.is_keyframe = bool(key)
                packet.stream = stream
                out.mux(packet)
        return path

    def frames(self, format='rgb24'):
        """Decodes the video: yields (time [s], (height, width, 3) uint8)
        in presentation order, time = the image timestamp."""
        import av
        codec = av.CodecContext.create(self.ffmpeg_codec, 'r')
        pts, _ = self._pts_dts()
        time_of = {int(p): t for p, t in zip(pts, self.times)}
        packets = []
        for data, p in zip(self.packets, pts):
            packet = av.Packet(data)
            packet.pts = int(p)
            packets.append(packet)
        for packet in packets + [None]:
            for frame in codec.decode(packet):
                yield time_of[frame.pts], frame.to_ndarray(format=format)


def load_mdutrace_videos(path):
    """{camera name: MduVideo} of an export (empty for version 1 files)."""
    header, buf, base = _read(path)
    out = {}
    for v in header.get('videos') or []:
        n = v['n']
        times = np.frombuffer(buf, '<f8', n, base + v['times_offset']).copy()
        sizes = np.frombuffer(buf, '<u4', n, base + v['sizes_offset'])
        keys = np.frombuffer(buf, 'u1', n, base + v['keys_offset']).astype(bool)
        packets = _split(buf, base + v['data_offset'], sizes)
        out[v['name']] = MduVideo(v, times, keys, packets)
    return out


def _restore_arrays(value, buf, base):
    """Payload blocks {"__array__": dtype, offset, length} -> numpy arrays."""
    if isinstance(value, dict):
        if '__array__' in value:
            return np.frombuffer(buf, value['__array__'], value['length'],
                                 base + value['offset']).copy()
        return {k: _restore_arrays(v, buf, base) for k, v in value.items()}
    if isinstance(value, list):
        return [_restore_arrays(v, buf, base) for v in value]
    return value


def load_mdutrace_scene(path):
    """{object name: registration payload} of the export's 3D scene setup
    (meshes: vertices, indices, scale, material; point clouds: width, height,
    fx, fy, cx, cy, depth_scale, ...), typed arrays as numpy arrays. Empty if
    the export has none. Object poses / colours are the '3d/<name>/pos' /
    '3d/<name>/color' series of load_mdutrace()."""
    header, buf, base = _read(path)
    scene = header.get('scene') or {}
    return {name: _restore_arrays(obj, buf, base) for name, obj in (scene.get('objects') or {}).items()}


def _split(buf, start, sizes):
    ends = start + np.cumsum(sizes.astype(np.int64))
    return [buf[e - s:e] for e, s in zip(ends, sizes)]


class MduDepth:
    """One depth source (point cloud) of an export.

    Attributes: name ('3d/<name>'), registration (width, height, fx, fy, cx,
    cy, depth_scale, ...), times ((n,) float64 [s]), depth_scales ((n,), the
    per-frame scale or the registration's), intrinsics (per-frame overrides,
    None entries = the registration's), depth_bytes / rgb_jpegs (lists of n
    bytes; an empty JPEG = no colour image).
    """

    def __init__(self, info, registration, times, depth_scales, depth_bytes, rgb_jpegs):
        self.info = info
        self.name = info['name']
        self.registration = registration
        self.times = times
        default_scale = registration.get('depth_scale', 1e-3)
        self.depth_scales = np.where(np.isnan(depth_scales), default_scale, depth_scales)
        self.intrinsics = info.get('intrinsics') or [None] * len(times)
        self.depth_bytes = depth_bytes
        self.rgb_jpegs = rgb_jpegs

    def __len__(self):
        return len(self.times)

    def __repr__(self):
        span = self.times[-1] - self.times[0] if len(self) else 0.
        return (f'MduDepth({self.name!r}, {self.registration.get("width")}x'
                f'{self.registration.get("height")}, {len(self)} frames, {span:.2f} s, '
                f'{sum(1 for j in self.rgb_jpegs if j)} with colour)')

    def camera(self, k):
        """(width, height, fx, fy, cx, cy) of frame k."""
        cam = dict(self.registration)
        cam.update({key: v for key, v in (self.intrinsics[k] or {}).items() if v is not None})
        return tuple(cam[key] for key in ('width', 'height', 'fx', 'fy', 'cx', 'cy'))

    def depth(self, k):
        """Raw depth of frame k: (height, width) uint16, 0 = no measurement."""
        width, height = self.camera(k)[:2]
        return np.frombuffer(self.depth_bytes[k], '<u2').reshape(int(height), int(width))

    def depth_m(self, k):
        """Depth of frame k [m]: (height, width) float64, 0 = no measurement."""
        return self.depth(k) * self.depth_scales[k]

    def rgb(self, k):
        """Colour image of frame k: (h, w, 3) uint8 RGB, or None."""
        if not self.rgb_jpegs[k]:
            return None
        import av
        codec = av.CodecContext.create('mjpeg', 'r')
        frames = codec.decode(av.Packet(self.rgb_jpegs[k]))
        return frames[0].to_ndarray(format='rgb24')

    def points(self, k):
        """Frame k as points in the depth camera frame [m]: (N, 3), pixels
        without depth left out -- the pinhole unprojection the viewer uses."""
        fx, fy, cx, cy = self.camera(k)[2:]
        z = self.depth_m(k)
        v, u = np.nonzero(z)
        z = z[v, u]
        return np.stack([(u - cx) * z / fx, (v - cy) * z / fy, z], axis=1)


def load_mdutrace_depth(path):
    """{source name: MduDepth} of an export (empty if it has none)."""
    header, buf, base = _read(path)
    out = {}
    for d in header.get('depth') or []:
        n = d['n']
        arr = lambda key, dtype: np.frombuffer(buf, dtype, n, base + d[key])
        out[d['name']] = MduDepth(
            d, _restore_arrays(d.get('registration') or {}, buf, base),
            arr('times_offset', '<f8').copy(), arr('depth_scales_offset', '<f8').copy(),
            _split(buf, base + d['depth_offset'], arr('depth_sizes_offset', '<u4')),
            _split(buf, base + d['rgb_offset'], arr('rgb_sizes_offset', '<u4')))
    return out


def _export_stem(path):
    name = os.path.basename(path)
    for ext in ('.gz', '.mdutrace'):
        if name.endswith(ext):
            name = name[:-len(ext)]
    return name


def export_mdutrace_videos(path, out_dir=None):
    """Writes every video of the export as <export>_<camera>.mp4 into
    `out_dir` (default: next to the export). Returns {camera: mp4 path}."""
    out_dir = os.path.dirname(os.path.abspath(path)) if out_dir is None else out_dir
    os.makedirs(out_dir, exist_ok=True)
    out = {}
    for name, video in load_mdutrace_videos(path).items():
        safe = re.sub(r'[^A-Za-z0-9_.-]+', '_', name).strip('_') or 'camera'
        out[name] = video.write(os.path.join(out_dir, f'{_export_stem(path)}_{safe}.mp4'))
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(description='List (and unpack) a viewer data export.')
    parser.add_argument('file')
    parser.add_argument('--videos', nargs='?', const='', metavar='OUT_DIR',
                        help='write every video as an mp4 (default: next to the export)')
    args = parser.parse_args(argv)
    for name, (t, v) in load_mdutrace(args.file).items():
        print(f'{name:40s} {v.shape[0]:8d} x {v.shape[1]:3d}  {t[0]:.3f} .. {t[-1]:.3f}')
    videos = load_mdutrace_videos(args.file)
    for video in videos.values():
        print(video)
    for depth in load_mdutrace_depth(args.file).values():
        print(depth)
    for name, obj in load_mdutrace_scene(args.file).items():
        print(f'scene object {name}: {obj.get("type")}')
    if args.videos is not None:
        for name, out in export_mdutrace_videos(args.file, args.videos or None).items():
            print(f'{name} -> {out}')


if __name__ == '__main__':
    main()
