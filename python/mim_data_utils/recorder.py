"""
Recordings for mim_data_utils.

The recordings run inside the server process (server.py, started by
serve.sh): `RecordingManager` gets every message the server sends to its
viewers and writes it to zstandard-compressed files (same format as
FileLoggerWriter, readable with FileLoggerReader). Producers start and stop
recordings over a small RPC (Logger.record / Logger.stop_recording); the
`main()` here (record.sh) is just a Logger plus keyboard handling.
"""

import collections
import os
import struct
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import ormsgpack
import zstandard

_VIDEO_TYPES = {b'image', b'video_segment', 'image', 'video_segment'}
_TIMESERIES_TYPES = {b'sample', b'depth', 'sample', 'depth', b'sample_batch', 'sample_batch'}

# Frames buffered per camera before fps is estimated and ffmpeg is launched.
_FPS_ESTIMATE_FRAMES = 15
# Force a keyframe every this many seconds of video.
_KEYFRAME_INTERVAL_S = 2
# Constant-quality level for hevc_nvenc (-rc vbr -cq N -b:v 0): lower = better
# quality / bigger file. Without an explicit rate control nvenc targets a fixed
# ~2 Mbit/s, which is ~10x more than a mostly static 640x480 robot scene needs.
# Measured on a D405 colour stream: cq 26 ~1.6 Mbit/s, cq 30 ~0.9, cq 34 ~0.5.
_DEFAULT_ENCODE_CQ = 30

# Named heights (16:9) for --with-encode-video SIZE args like 720p.
_P_SIZES = {
    144: (256, 144),
    240: (426, 240),
    320: (568, 320),
    360: (640, 360),
    480: (854, 480),
    720: (1280, 720),
    1080: (1920, 1080),
    1440: (2560, 1440),
    2160: (3840, 2160),
}


def _item_field(d, key):
    """Fetch a field from a msgpack-decoded dict, tolerating bytes-or-str keys."""
    if key in d:
        return d[key]
    bkey = key.encode() if isinstance(key, str) else key
    return d.get(bkey)


def _even(n):
    """Round down to an even integer (yuv420p / nvenc requirement)."""
    n = int(n)
    return n - (n % 2)


def parse_encode_size(token):
    """Parse a size token: ``640x360``, ``640×360``, or ``720p`` / ``320p``.

    Returns ``(width, height)`` with even dimensions.
    """
    t = token.strip().lower().replace('×', 'x')
    if t.endswith('p') and t[:-1].isdigit():
        h = int(t[:-1])
        if h in _P_SIZES:
            return _P_SIZES[h]
        w = _even(round(h * 16 / 9))
        return (w, _even(h))
    if 'x' in t:
        w_s, h_s = t.split('x', 1)
        if w_s.isdigit() and h_s.isdigit():
            w, h = _even(w_s), _even(h_s)
            if w > 0 and h > 0:
                return (w, h)
    raise ValueError(
        f'invalid encode size {token!r} (expected e.g. 640x360, 640×360, 720p)')


def parse_encode_fps(token):
    """Parse an fps token: ``24fps`` or ``24``."""
    t = token.strip().lower()
    if t.endswith('fps'):
        t = t[:-3]
    try:
        fps = float(t)
    except ValueError as e:
        raise ValueError(
            f'invalid encode fps {token!r} (expected e.g. 24fps or 24)') from e
    if not (fps == fps) or fps <= 0:  # NaN or non-positive
        raise ValueError(f'encode fps must be positive, got {token!r}')
    return fps


def parse_encode_cq(token):
    """Parse a quality token: ``cq30`` (hevc_nvenc constant-quality level, 1-51)."""
    t = token.strip().lower()
    if not t.startswith('cq'):
        raise ValueError(f'invalid encode quality {token!r} (expected e.g. cq30)')
    try:
        cq = int(t[2:])
    except ValueError as e:
        raise ValueError(f'invalid encode quality {token!r} (expected e.g. cq30)') from e
    if not 1 <= cq <= 51:
        raise ValueError(f'encode quality must be in 1..51, got {token!r}')
    return cq


def parse_encode_denoise(token):
    """Parse a denoise token: ``denoise`` (hqdn3d default strength 4) or
    ``denoiseN`` with luma spatial strength N (1..20); the other hqdn3d
    parameters follow ffmpeg's default ratios (chroma 0.75 N, temporal 1.5 N,
    chroma temporal 1.125 N). Returns the ffmpeg filter string."""
    t = token.strip().lower()
    if not t.startswith('denoise'):
        raise ValueError(f'invalid denoise token {token!r} (expected denoise or denoiseN)')
    rest = t[len('denoise'):]
    if rest == '':
        n = 4.0
    else:
        try:
            n = float(rest)
        except ValueError as e:
            raise ValueError(f'invalid denoise strength {token!r} (expected e.g. denoise6)') from e
        if not 1 <= n <= 20:
            raise ValueError(f'denoise strength must be in 1..20, got {token!r}')
    return f'hqdn3d={n:g}:{0.75 * n:g}:{1.5 * n:g}:{1.125 * n:g}'


def parse_encode_keyframe(token):
    """Parse a keyframe-interval token: ``kf5`` = a keyframe every 5 s
    (0.5..60). Longer intervals shrink the file (a lot at low resolution/fps,
    where keyframes dominate) at the cost of coarser seeking and a longer wait
    for a viewer joining a live stream."""
    t = token.strip().lower()
    if not t.startswith('kf'):
        raise ValueError(f'invalid keyframe token {token!r} (expected e.g. kf5)')
    try:
        k = float(t[2:])
    except ValueError as e:
        raise ValueError(f'invalid keyframe interval {token!r} (expected e.g. kf5)') from e
    if not 0.5 <= k <= 60:
        raise ValueError(f'keyframe interval must be in 0.5..60 s, got {token!r}')
    return k


def parse_duration(token):
    """Parse a duration for ``--snapshot``: a bare number of seconds (``0.1``,
    ``2``), or with a unit (``0.5s``, ``100ms``). Returns seconds."""
    t = str(token).strip().lower()
    scale = 1.0
    if t.endswith('ms'):
        t, scale = t[:-2], 1e-3
    elif t.endswith('s'):
        t = t[:-1]
    try:
        v = float(t) * scale
    except ValueError as e:
        raise ValueError(f'invalid duration {token!r} (expected e.g. 0.1, 2, 0.5s or 100ms)') from e
    if v <= 0:
        raise ValueError(f'duration must be positive, got {token!r}')
    return v


def parse_encode_video_args(tokens):
    """Parse optional ``--with-encode-video`` tokens into
    ``(size, fps_limit, cq, denoise, keyframe_s)``.

    Tokens may be SIZE (``640x360`` / ``720p``), FPS (``24fps`` / ``24``),
    quality (``cq30``), ``denoise``/``denoiseN`` (hqdn3d before encode; sensor
    noise is what costs bits on a static scene) and/or ``kfN`` (keyframe every
    N seconds), in any order. Missing values are ``None`` (native size /
    estimated fps / default cq / no denoise / default keyframe interval).
    """
    size, fps, cq, denoise, kf = None, None, None, None, None
    for tok in tokens:
        t = tok.strip().lower().replace('×', 'x')
        is_size = ('x' in t) or (t.endswith('p') and t[:-1].isdigit())
        is_fps = t.endswith('fps') or (
            not is_size and t.replace('.', '', 1).isdigit())
        if is_size:
            if size is not None:
                raise ValueError(f'duplicate encode size: {tok!r}')
            size = parse_encode_size(tok)
        elif is_fps:
            if fps is not None:
                raise ValueError(f'duplicate encode fps: {tok!r}')
            fps = parse_encode_fps(tok)
        elif t.startswith('cq'):
            if cq is not None:
                raise ValueError(f'duplicate encode quality: {tok!r}')
            cq = parse_encode_cq(tok)
        elif t.startswith('denoise'):
            if denoise is not None:
                raise ValueError(f'duplicate denoise option: {tok!r}')
            denoise = parse_encode_denoise(tok)
        elif t.startswith('kf'):
            if kf is not None:
                raise ValueError(f'duplicate keyframe option: {tok!r}')
            kf = parse_encode_keyframe(tok)
        else:
            raise ValueError(
                f'unrecognized --with-encode-video argument: {tok!r} '
                f'(expected SIZE like 640x360/720p, FPS like 24fps, quality like cq30 '
                f'denoise/denoiseN and/or keyframe interval like kf5)')
    return size, fps, cq, denoise, kf


def _safe_name(name):
    """Make a camera name safe to embed in a filename."""
    if isinstance(name, bytes):
        name = name.decode('utf-8', 'replace')
    return ''.join(c if (c.isalnum() or c in '-_.') else '_' for c in str(name))


def _fill_template(template, reserved=()):
    """Fill a recording-path template for a new section.

    A ``{timestamp}`` placeholder in ``template`` is replaced with the current
    ``YYYYmmdd_HHMMSS``; if the template has no placeholder the timestamp is
    appended before the extension instead. A numeric suffix is added if the
    resulting file already exists (or is in `reserved`: a name handed out
    whose file is not created yet), so recordings never overwrite each other.
    """
    ts = datetime.now().strftime('%Y%m%d_%H%M%S')
    if '{timestamp}' in template:
        filled = template.replace('{timestamp}', ts)
    else:
        p = Path(template)
        filled = str(p.with_name(f'{p.stem}_{ts}{p.suffix}'))
    p = Path(filled)
    candidate = p
    n = 2
    while candidate.exists() or str(candidate) in reserved:
        candidate = p.with_name(f'{p.stem}_{n}{p.suffix}')
        n += 1
    return str(candidate)


def _all_cpus():
    """ffmpeg child: undo the server's CPU pinning (serve.sh runs it with
    taskset on one core, which children would inherit)."""
    try:
        os.sched_setaffinity(0, range(os.cpu_count() or 1))
    except (AttributeError, OSError):
        pass


class _CameraEncoder:
    """Encodes one camera's incoming JPEG frames into an H.265 .mp4 via ffmpeg.

    The first few frames are buffered to estimate the stream fps from their
    timestamps; ffmpeg is then launched and the buffer flushed.  JPEG bytes are
    piped straight in (decoded on CPU by ffmpeg, encoded on the GPU via
    ``hevc_nvenc``), so no decode is needed on our side.

    Optional ``size=(w, h)`` rescales via ffmpeg before encode. Optional
    ``fps_limit`` drops excess frames (phase-locked schedule) and caps the
    written stream rate; the fps estimate is always taken from the raw stream
    so a limit never poisons the measurement.
    """

    def __init__(self, name, out_path, size=None, fps_limit=None, cq=None,
                 denoise=None, keyframe_s=None):
        self.name = name
        self.out_path = out_path
        self.size = size  # (w, h) or None
        self.fps_limit = fps_limit  # float or None
        self.cq = _DEFAULT_ENCODE_CQ if cq is None else cq
        self.denoise = denoise  # ffmpeg filter string (hqdn3d=...) or None
        self.keyframe_s = _KEYFRAME_INTERVAL_S if keyframe_s is None else keyframe_s
        self.proc = None
        self.started = False
        self.failed = False
        self.buffer = []  # list of (jpeg_bytes, t) until fps is known
        self.fps = None
        self.frame_count = 0
        self._next_keep_t = None  # phase-locked drop schedule

    def feed(self, jpeg, t):
        if self.failed or jpeg is None:
            return
        if not self.started:
            # Buffer raw frames (no dropping) so the fps estimate reflects the
            # true arrival rate, not an undershot cap.
            self.buffer.append((jpeg, t))
            if len(self.buffer) >= _FPS_ESTIMATE_FRAMES:
                self._start()
            return
        if self._should_keep(t):
            self._write(jpeg)

    def _should_keep(self, t):
        """Keep this frame under ``fps_limit``, using a phase-locked timeline.

        A greedy ``t - last_kept >= 1/limit`` check undershoots badly when
        source timestamps sit on a coarser grid (e.g. 33.3 ms / 30 fps) than
        ``1/limit`` (e.g. 41.7 ms / 24 fps): every other frame fails the gap
        test and the measured rate collapses to ~half. Advancing a regular
        schedule instead keeps up to ``fps_limit`` without that bias.
        """
        if self.fps_limit is None or not isinstance(t, (int, float)):
            return True
        dt = 1.0 / self.fps_limit
        if self._next_keep_t is None:
            self._next_keep_t = t + dt
            return True
        if t + 1e-9 < self._next_keep_t:
            return False
        while self._next_keep_t <= t + 1e-9:
            self._next_keep_t += dt
        return True

    def _estimate_fps(self):
        ts = [t for _, t in self.buffer
              if isinstance(t, (int, float))]
        if len(ts) >= 2 and ts[-1] > ts[0]:
            fps = (len(ts) - 1) / (ts[-1] - ts[0])
            if fps == fps and fps > 0:  # not NaN, positive
                return min(240.0, max(1.0, fps))
        return 30.0

    def _start(self):
        est = self._estimate_fps()
        if self.fps_limit is not None:
            # Cap only: never invent frames if the source is slower than the limit.
            self.fps = min(est, self.fps_limit)
        else:
            self.fps = est
        fps = self.fps
        cmd = [
            'ffmpeg', '-y',
            '-f', 'image2pipe',
            '-c:v', 'mjpeg',
            '-framerate', f'{fps:.6f}',
            '-i', 'pipe:0',
        ]
        vf = []
        if self.denoise:
            vf.append(self.denoise)   # denoise at source resolution, before scaling
        if self.size is not None:
            w, h = self.size
            vf.append(f'scale={w}:{h}')
        if vf:
            cmd += ['-vf', ','.join(vf)]
        cmd += [
            '-c:v', 'hevc_nvenc',
            '-pix_fmt', 'yuv420p',
            '-preset', 'p5',
            '-tune', 'hq',
            # Constant quality VBR: bits go where the picture changes. -b:v 0
            # lets cq drive the size; maxrate only caps pathological bursts.
            '-rc', 'vbr', '-cq', str(self.cq), '-b:v', '0',
            '-maxrate', '6M', '-bufsize', '12M',
            '-spatial-aq', '1',
            '-g', str(max(1, round(fps * self.keyframe_s))),
            '-force_key_frames',
            f'expr:gte(t,n_forced*{self.keyframe_s:g})',
            # Fragmented MP4: write self-contained fragments as we go so the
            # file is valid/playable while still being recorded.  A fragment is
            # cut at every keyframe or after 1s, whichever comes first, and
            # flushed straight to disk so a viewer can follow it live.
            '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
            '-frag_duration', '1000000',
            '-flush_packets', '1',
            self.out_path,
        ]
        try:
            # Default buffering: a 1080p JPEG is larger than the buffer so it is
            # written straight through (one syscall per frame, no extra latency
            # for live viewers), while many tiny writes still get coalesced.
            self.proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL,
                preexec_fn=_all_cpus)
        except OSError as e:
            print(f'[recorder] Failed to start ffmpeg for {self.name}: {e}')
            self.failed = True
            self.buffer = []
            return
        size_note = f', {self.size[0]}x{self.size[1]}' if self.size else ''
        if self.fps_limit is not None and est > self.fps_limit + 0.05:
            fps_note = f'{est:.0f}->{self.fps:.0f}'
        else:
            fps_note = f'{self.fps:.0f}'
        print(f'[recorder] Encoding video {self.name} (~{fps_note} fps'
              f'{size_note}) -> {self.out_path}')
        self.started = True
        self._next_keep_t = None
        for jpeg, t in self.buffer:
            if self._should_keep(t):
                self._write(jpeg)
        self.buffer = []

    def _write(self, jpeg):
        if self.proc is None or self.proc.stdin is None:
            return
        try:
            self.proc.stdin.write(jpeg)
            self.frame_count += 1
        except (BrokenPipeError, OSError) as e:
            print(f'[recorder] ffmpeg pipe broke for {self.name}: {e}')
            self.failed = True

    def close(self):
        if not self.started and not self.failed:
            # Fewer than _FPS_ESTIMATE_FRAMES arrived; encode what we have.
            self._start()
        if self.proc is not None:
            try:
                if self.proc.stdin is not None:
                    self.proc.stdin.close()
            except OSError:
                pass
            try:
                ret = self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                ret = self.proc.wait()
            fps = self.fps if self.fps is not None else 0.0
            self.proc = None
            if ret != 0 or self.failed:
                print(f'[recorder]   {self.name}: ENCODE FAILED '
                      f'(ffmpeg exit {ret}) -> {self.out_path}')
            else:
                self._remux_faststart()
                print(f'[recorder]   {self.name}: {self.frame_count} frames '
                      f'@ {fps:.1f} fps -> {self.out_path}')

    def _remux_faststart(self):
        """Rewrite the fragmented recording into a normal indexed MP4.

        The live file is fragmented (empty_moov) so it can be viewed while
        recording, but a fragmented file has no sample table, so players seek
        poorly (artefacts on non-keyframe fragments, jumping time counter).
        A stream-copy remux with +faststart rebuilds a proper moov index, so
        the finished file seeks cleanly.  No re-encoding, so it is fast.
        """
        src = Path(self.out_path)
        if not src.exists() or src.stat().st_size == 0:
            return
        tmp = src.with_name(src.stem + '.remux.mp4')
        cmd = ['ffmpeg', '-y', '-loglevel', 'error', '-i', str(src),
               '-c', 'copy', '-movflags', '+faststart', str(tmp)]
        try:
            ret = subprocess.run(
                cmd, stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode
        except OSError as e:
            print(f'[recorder]   {self.name}: remux skipped ({e}); '
                  'kept fragmented file (live-viewable, seeks poorly)')
            return
        if ret == 0 and tmp.exists() and tmp.stat().st_size > 0:
            tmp.replace(src)
        else:
            if tmp.exists():
                tmp.unlink()
            print(f'[recorder]   {self.name}: remux failed (ffmpeg exit {ret}); '
                  'kept fragmented file (live-viewable, seeks poorly)')


class Recorder:
    """Writes a stream of viewer messages (raw msgpack bytes, as the server
    sends them to its websocket clients) to a zstandard-compressed file.

    The server feeds it from its broadcast path (see ``RecordingManager``);
    nothing here connects anywhere. The output file is readable with
    ``FileLoggerReader``. ``files`` lists every file the recording created
    (``.zst``, per-camera ``.mp4``, ``_begin`` / ``_end`` images).
    """

    def __init__(self, path, max_file_size_mb, compression_level=10,
                 embed_video=False, encode_video=False, with_timeseries=True,
                 encode_size=None, encode_fps=None, encode_cq=None,
                 encode_denoise=None, encode_keyframe_s=None,
                 host='127.0.0.1', port=5678, async_write=False):
        self.path = str(path)
        self._host = host           # websocket the _begin/_end frame capture reads from
        self._port = port
        self.compression_level = compression_level
        self.max_file_size_mb = max_file_size_mb
        self.embed_video = embed_video
        self.encode_video = encode_video
        self.encode_size = encode_size  # (w, h) or None
        self.encode_fps = encode_fps    # float or None
        self.encode_cq = encode_cq      # int or None (default _DEFAULT_ENCODE_CQ)
        self.encode_denoise = encode_denoise  # hqdn3d filter string or None
        self.encode_keyframe_s = encode_keyframe_s  # seconds or None (default 2 s)
        self.with_timeseries = with_timeseries

        self._lock = threading.Lock()
        self._fh = None
        self._compressor = None
        self._recording = False
        self._bytes_written = 0
        self._messages_written = 0
        self.files = []

        self._enc_lock = threading.Lock()
        self._encoders = {}  # camera name -> _CameraEncoder

        # async_write: feed() only queues; a writer thread compresses and
        # writes, so the caller (the server's broadcast threads) never waits
        # on zstd.
        self.async_write = async_write
        self._queue = collections.deque()
        self._queue_event = threading.Event()
        self._writer = None
        self._writer_stop = False

    # -- file handling --------------------------------------------------------

    def _open_file(self):
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(self.path, 'wb')
        self.files.append(self.path)
        cctx = zstandard.ZstdCompressor(level=self.compression_level)
        self._compressor = cctx.stream_writer(self._fh)
        self._bytes_written = 0
        self._messages_written = 0
        if self.async_write:
            self._writer_stop = False
            self._writer = threading.Thread(target=self._writer_run, daemon=True,
                                            name=f'recorder-writer-{Path(self.path).stem}')
            self._writer.start()

    def _writer_run(self):
        while True:
            self._queue_event.wait(0.1)
            self._queue_event.clear()
            while self._queue:
                self._write_now(self._queue.popleft())
            if self._writer_stop and not self._queue:
                return

    def _write(self, data: bytes):
        if self.async_write:
            self._queue.append(data)
            self._queue_event.set()
        else:
            self._write_now(data)

    def _write_now(self, data: bytes):
        """Write one websocket message (raw msgpack bytes) to the file."""
        header = struct.pack('>I', len(data))
        with self._lock:
            if self._compressor is None:
                return

            self._compressor.write(header)
            self._compressor.write(data)
            self._bytes_written += len(header) + len(data)
            self._messages_written += 1

            if self._messages_written % 100 == 0:
                disk_size = Path(self.path).stat().st_size / (1024 * 1024)
                if disk_size > self.max_file_size_mb:
                    print(f'[recorder] File size limit reached '
                          f'({disk_size:.1f} MB), stopping recording.')
                    self._recording = False

    def _close_file(self):
        if self._writer is not None:
            self._writer_stop = True
            self._queue_event.set()
            self._writer.join()
            self._writer = None
        with self._lock:
            if self._compressor is not None:
                self._compressor.flush(zstandard.FLUSH_FRAME)
                self._compressor.close()
                self._compressor = None
            if self._fh is not None:
                self._fh.close()
                self._fh = None

    def _close_encoders(self):
        with self._enc_lock:
            encoders = list(self._encoders.values())
            self._encoders = {}
        if encoders:
            print(f'[recorder] Finalising {len(encoders)} video file(s)...')
        for enc in encoders:
            enc.close()

    # -- the stream -----------------------------------------------------------

    def _keep(self, item):
        """Whether an item should be written to the .zst, given the flags."""
        if not isinstance(item, dict):
            return True
        t = _item_field(item, 'type')
        if t in _VIDEO_TYPES and not self.embed_video:
            return False
        if t in _TIMESERIES_TYPES and not self.with_timeseries:
            return False
        return True

    def feed(self, message):
        """One viewer message (msgpack bytes of a list of items)."""
        if not self._recording or not isinstance(message, (bytes, bytearray)):
            return

        # Nothing to filter and nothing to encode -> write raw bytes, no unpack.
        no_filter = self.embed_video and self.with_timeseries
        if no_filter and not self.encode_video:
            self._write(message)
            return

        items = ormsgpack.unpackb(message)
        if not isinstance(items, list):
            if no_filter:
                self._write(message)
            return

        if self.encode_video:
            for i in items:
                if isinstance(i, dict) and _item_field(i, 'type') in (b'image', 'image'):
                    self._feed_encoder(
                        _item_field(i, 'name'),
                        _item_field(i, 'payload'),
                        _item_field(i, 'time'))

        if no_filter:
            self._write(message)
            return

        items = [i for i in items if self._keep(i)]
        if not items:
            return
        self._write(ormsgpack.packb(items))

    def _feed_encoder(self, name, jpeg, t):
        if name is None or jpeg is None:
            return
        with self._enc_lock:
            if not self._recording:
                return
            enc = self._encoders.get(name)
            if enc is None:
                stem = Path(self.path).with_suffix('')
                out_path = f'{stem}_{_safe_name(name)}.mp4'
                enc = _CameraEncoder(
                    name, out_path,
                    size=self.encode_size, fps_limit=self.encode_fps,
                    cq=self.encode_cq, denoise=self.encode_denoise,
                    keyframe_s=self.encode_keyframe_s)
                self._encoders[name] = enc
                self.files.append(out_path)
            enc.feed(jpeg, t)

    # -- public API -----------------------------------------------------------

    def _capture_frames(self, suffix, average=None, duration=None):
        """Snapshot current camera images (shm color+depth + websocket JPEGs) next
        to the recording, prefixed like the .zst with `suffix` (e.g. '_begin').
        With `average` ('mean' / 'median'), combine every frame of the next
        `duration` s into one noise-reduced image per camera."""
        try:
            try:
                from . import capture  # package import
            except ImportError:
                import capture          # run-as-script (recorder.py's dir on sys.path)
            p = Path(self.path)
            saved = capture.capture_frames(prefix=p.stem + suffix, out_dir=str(p.parent),
                                           host=self._host, port=self._port,
                                           average=average, duration=duration)
            self.files.extend(saved or [])
        except Exception as e:
            print(f'[recorder] frame capture ({suffix}) failed: {e}')

    def open(self, header=()):
        """Open the file, write `header` messages (what a newly connecting viewer
        gets: session list + registered setups) and start taking the stream."""
        if self._recording:
            return
        with self._enc_lock:
            self._encoders = {}
        self._open_file()
        for msg in header:
            if msg is not None:
                self._write(msg)
        self._recording = True
        print(f'[recorder] Recording to {self.path}')
        if self.encode_video:
            stem = Path(self.path).with_suffix('')
            opts = []
            if self.encode_size is not None:
                opts.append(f'{self.encode_size[0]}x{self.encode_size[1]}')
            if self.encode_fps is not None:
                opts.append(f'≤{self.encode_fps:g} fps')
            opts.append(f'cq{_DEFAULT_ENCODE_CQ if self.encode_cq is None else self.encode_cq}')
            if self.encode_denoise:
                opts.append(self.encode_denoise)
            if self.encode_keyframe_s is not None:
                opts.append(f'keyframe every {self.encode_keyframe_s:g}s')
            opt_note = f" ({', '.join(opts)})" if opts else ''
            print(f'[recorder] Encoding H.265 video per camera{opt_note} to '
                  f'{stem}_<camera>.mp4 (opened when each stream starts)')

    def capture_begin(self, average=None, average_s=None):
        """The _begin frames. With `average`, they combine all frames of the next
        `average_s` seconds (blocks that long while data keeps recording)."""
        self._capture_frames('_begin', average, average_s)

    def deactivate(self):
        """Stop taking the stream (the file stays open until stop_recording)."""
        self._recording = False

    def stop_recording(self, capture_end=True):
        """Stop writing and finalise the file; snapshot _end frames unless
        `capture_end` is False."""
        self._recording = False
        if self._fh is None:
            return
        self._close_file()
        self._close_encoders()

        path = Path(self.path)
        if path.exists():
            disk_mb = path.stat().st_size / (1024 * 1024)
            print(f'[recorder] Saved {self._messages_written} messages '
                  f'({self._bytes_written / (1024*1024):.1f} MB uncompressed, '
                  f'{disk_mb:.1f} MB on disk) to {self.path}')

        if capture_end:
            self._capture_frames('_end')

    def delete_files(self):
        """Remove exactly the files this recording created."""
        removed = []
        for f in dict.fromkeys(self.files):
            try:
                os.remove(f)
                removed.append(f)
            except FileNotFoundError:
                pass
            except OSError as e:
                print(f'[recorder] could not delete {f}: {e}')
        return removed

    @property
    def is_recording(self):
        return self._recording


# -- recordings managed by the server -----------------------------------------

RPC_ENDPOINT = 'ipc:///tmp/mim_recorder_rpc'
DEFAULT_TEMPLATE = 'mim_{timestamp}.zst'
_PRUNE_DONE_S = 600.0


def default_recordings_dir():
    """$MIM_RECORDINGS_DIR (serve.sh exports the same folder record.sh used),
    else ./recordings of the server's working directory."""
    return os.environ.get('MIM_RECORDINGS_DIR') or os.path.abspath('recordings')


def parse_average(average):
    """True -> 'mean'; 'mean' / 'median'; False / None -> None."""
    if average is None or average is False:
        return None
    if average is True:
        return 'mean'
    if average in ('mean', 'median'):
        return average
    raise ValueError(f"average must be True, 'mean' or 'median', got {average!r}")


class Recording:
    """One recording run by a RecordingManager (in the server process)."""

    def __init__(self, prefix, recorder, duration, snapshot, average):
        self.prefix = prefix
        self.recorder = recorder
        self.duration = duration
        self.snapshot = snapshot
        self.average = average
        self.state = 'active'       # active -> finalizing -> done
        self.t_start = time.time()
        self.t_done = None
        self.delete = False
        self.deleted = []
        self.stop_event = threading.Event()
        self.thread = None


class RecordingManager:
    """The server's recordings. `feed()` gets every message the server sends
    to its viewers; `start` / `stop` / `status` are served over RPC
    (Logger.record / stop_recording)."""

    def __init__(self, header_fn=None, host='127.0.0.1', port=5678):
        self.header_fn = header_fn or (lambda: [])
        self.host, self.port = host, port
        self._lock = threading.Lock()
        self._recordings = {}           # prefix -> Recording
        self._active = ()               # recorders taking the stream (tuple swap: lock-free feed)
        self._reserved = set()

    @property
    def has_active(self):
        return bool(self._active)

    def feed(self, data):
        for rec in self._active:
            rec.feed(data)

    def _refresh_active(self):
        self._active = tuple(r.recorder for r in self._recordings.values()
                             if r.state == 'active')

    def _reserve_path(self, out_dir, template):
        t = template or DEFAULT_TEMPLATE
        if not os.path.isabs(t):
            t = os.path.join(out_dir or default_recordings_dir(), t)
        if not t.endswith('.zst'):
            t += '.zst'
        path = _fill_template(t, self._reserved)
        self._reserved.add(path)
        return path

    def start(self, duration=None, snapshot=False, average=None, encode_video=None,
              embed_video=False, with_timeseries=True, max_size_mb=500,
              compression_level=10, out_dir=None, template=None):
        if duration is not None:
            duration = parse_duration(duration)
        elif snapshot:
            duration = 1.0
        average = parse_average(average)
        if average and duration is None:
            raise ValueError('average needs a duration (the averaging window)')
        enc_on = bool(encode_video)
        size = fps = cq = denoise = kf = None
        if isinstance(encode_video, str):
            encode_video = encode_video.split()
        if isinstance(encode_video, (list, tuple)):
            size, fps, cq, denoise, kf = parse_encode_video_args(list(encode_video))
            enc_on = True

        with self._lock:
            self._prune()
            path = self._reserve_path(out_dir, template)
            rec = Recorder(path, max_file_size_mb=max_size_mb,
                           compression_level=compression_level,
                           embed_video=embed_video, encode_video=enc_on,
                           with_timeseries=with_timeseries, encode_size=size,
                           encode_fps=fps, encode_cq=cq, encode_denoise=denoise,
                           encode_keyframe_s=kf, host=self.host, port=self.port,
                           async_write=True)
            prefix = str(Path(path).with_suffix(''))
            recording = Recording(prefix, rec, duration, snapshot, average)
            rec.open(self.header_fn())
            self._recordings[prefix] = recording
            self._refresh_active()

        recording.thread = threading.Thread(target=self._run, args=(recording,),
                                            daemon=True, name=f'recording-{Path(path).stem}')
        recording.thread.start()
        return prefix

    def _run(self, r):
        try:
            r.recorder.capture_begin(r.average, r.duration if r.average else None)
            if r.duration is not None:
                remaining = r.duration - (time.time() - r.t_start)
                if remaining > 0:
                    r.stop_event.wait(remaining)
            else:
                while not r.stop_event.wait(0.5):
                    if not r.recorder.is_recording:     # size limit reached
                        break
            self._finish(r)
        except Exception as e:
            print(f'[recorder] {r.prefix}: {e}')
            with self._lock:
                r.state = 'done'
                r.t_done = time.time()
                self._refresh_active()

    def _finish(self, r):
        with self._lock:
            r.state = 'finalizing'
            self._refresh_active()
        r.recorder.stop_recording(capture_end=not r.snapshot and not r.delete)
        while True:
            if r.delete and not r.deleted:
                r.deleted = r.recorder.delete_files() or ['(none)']
            with self._lock:
                if r.delete and not r.deleted:      # delete asked for meanwhile
                    continue
                r.state = 'done'
                r.t_done = time.time()
                return

    def stop(self, prefix=None, delete=False):
        """Stop `prefix` (None: every active recording); with `delete`, its
        files are removed once finalised. Returns the affected prefixes."""
        with self._lock:
            if prefix is None:
                targets = [r for r in self._recordings.values() if r.state == 'active']
            elif prefix in self._recordings:
                targets = [self._recordings[prefix]]
            else:
                raise KeyError(f'unknown recording {prefix!r}')
            for r in targets:
                r.delete = r.delete or delete
                if r.state == 'active':
                    r.recorder.deactivate()     # the stream stops going in right away
                    r.state = 'finalizing'
            self._refresh_active()
        for r in targets:
            r.stop_event.set()
            if r.state == 'done' and delete and not r.deleted:
                r.deleted = r.recorder.delete_files() or ['(none)']
        return [r.prefix for r in targets]

    def status(self):
        with self._lock:
            out = {'active': [], 'finalizing': [], 'done': []}
            for r in self._recordings.values():
                out[r.state].append(r.prefix)
            return out

    def _prune(self):
        now = time.time()
        for p in [p for p, r in self._recordings.items()
                  if r.state == 'done' and now - r.t_done > _PRUNE_DONE_S]:
            del self._recordings[p]

    def close_all(self, timeout=60.0):
        self.stop()
        for r in list(self._recordings.values()):
            if r.thread is not None:
                r.thread.join(timeout)

    def handle_rpc(self, request):
        """{'op': ..., ...} -> reply dict (never raises)."""
        try:
            op = request.get('op')
            args = request.get('args') or {}
            if op == 'record':
                return {'ok': True, 'prefix': self.start(**args)}
            if op == 'stop':
                return {'ok': True, 'stopped': self.stop(**args)}
            if op == 'status':
                return {'ok': True, **self.status()}
            return {'ok': False, 'error': f'unknown op {op!r}'}
        except Exception as e:
            return {'ok': False, 'error': f'{type(e).__name__}: {e}'}


def serve_rpc(manager, endpoint=RPC_ENDPOINT):
    """REP loop for Logger.record / stop_recording (run in a server thread)."""
    import zmq
    sock = zmq.Context.instance().socket(zmq.REP)
    sock.bind(endpoint)
    while True:
        try:
            request = ormsgpack.unpackb(sock.recv())
        except Exception as e:
            sock.send(ormsgpack.packb({'ok': False, 'error': f'bad request: {e}'}))
            continue
        sock.send(ormsgpack.packb(manager.handle_rpc(request)))


def main():
    """record.sh: keyboard front end. The recording runs in the server
    (serve.sh); this only asks for it through a passive Logger."""
    import argparse
    import sys
    import tty
    import termios
    import select
    try:
        from mim_data_utils.logger import Logger
    except ImportError:                       # run as a script from a source tree
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from mim_data_utils.logger import Logger

    parser = argparse.ArgumentParser(
        description='Record the mim_data_utils stream (written by the serve.sh server).')
    parser.add_argument('path', nargs='?', default=None,
                        help='Output path template; "{timestamp}" is replaced '
                             'per recording (default: the server\'s recordings '
                             'folder, mim_{timestamp}.zst)')
    parser.add_argument('--max-size', type=float, default=500,
                        help='Max file size in MB (default: 500)')
    parser.add_argument('--compression-level', type=int, default=10,
                        help='Zstandard compression level 1-22 (default: 10)')
    parser.add_argument('--with-embed-video', action='store_true', default=False,
                        help='Embed raw image/video_segment messages in the '
                             'recording (excluded by default)')
    parser.add_argument(
        '--with-encode-video', nargs='*', default=None,
        metavar='OPT',
        help="Encode each camera's images into an H.265 .mp4 beside the "
             'recording (GPU hevc_nvenc). Optional OPT args: SIZE '
             '(640x360, 640×360, or 720p/320p/…) and/or FPS (24fps or 24) '
             'to rescale and/or cap frame rate before encode. '
             'Example: --with-encode-video 640×360 24fps')
    parser.add_argument('--without-timeseries', action='store_true', default=False,
                        help='Do not log timeseries (sample/depth) data to the '
                             'recording (logged by default)')
    parser.add_argument('--snapshot', nargs='?', const='1s', default=None,
                        metavar='DURATION',
                        help='SPACE records a snapshot instead of toggling a full '
                             'recording: current frames (_begin) + DURATION of data, '
                             'then stops (no _end frames). DURATION in seconds '
                             '(0.1, 2) or with a unit (0.5s, 100ms); default 1')
    parser.add_argument('--average', nargs='?', const='mean', default=None,
                        choices=('mean', 'median'),
                        help='with --snapshot: the _begin image combines every camera '
                             'frame of the snapshot duration into one noise-reduced image '
                             '(static scene): mean (default, noise / sqrt(N)) or median '
                             '(robust to outliers). Depth: median of valid samples. '
                             'E.g. --snapshot --average')
    args = parser.parse_args()
    if args.average and args.snapshot is None:
        parser.error('--average needs --snapshot (the snapshot duration is the averaging window)')

    snapshot_s = None
    if args.snapshot is not None:
        try:
            snapshot_s = parse_duration(args.snapshot)
        except ValueError as e:
            parser.error(str(e))
    if args.with_encode_video is not None:
        try:
            parse_encode_video_args(args.with_encode_video)    # report bad options here
        except ValueError as e:
            parser.error(str(e))

    opts = dict(max_size_mb=args.max_size, compression_level=args.compression_level,
                embed_video=args.with_embed_video,
                encode_video=(list(args.with_encode_video)
                              if args.with_encode_video is not None else None),
                with_timeseries=not args.without_timeseries)
    if args.path is not None:
        opts['template'] = os.path.abspath(args.path)

    logger = Logger(Logger.start_server(), start=False, make_session_active=False)
    try:
        logger.recordings()
    except TimeoutError as e:
        sys.exit(f'[recorder] {e}')

    print()
    if snapshot_s is not None and args.average:
        print(f'  [SPACE]  Snapshot: {args.average} of all frames + data over '
              f'{snapshot_s * 1e3:g} ms (no _end frames)')
    elif snapshot_s is not None:
        print(f'  [SPACE]  Snapshot: current frames + {snapshot_s * 1e3:g} ms of data '
              f'(no _end frames)')
    else:
        print('  [SPACE]  Start/stop a full recording (stores _begin/_end frames)')
    print('  [c]      Capture current frames + 100 ms of data (no _end frames)')
    print('  [Ctrl+C] Exit')
    print()

    current = None      # this CLI's running full recording (others are left alone)

    def snapshot(duration_s, average=None):
        prefix = logger.record(duration_s, snapshot=True, average=average, **opts)
        print(f'  Recording {prefix}.zst')
        logger.wait_recording(prefix)
        return prefix

    # cbreak (not raw) terminal mode: char-by-char keypresses without echo,
    # but output post-processing stays on so '\n' still maps to '\r\n' and
    # background-thread log lines don't staircase.  Ctrl+C (ISIG) still works.
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)

    try:
        tty.setcbreak(fd)

        while True:
            # Wait for input with a short timeout so Ctrl+C works
            if select.select([sys.stdin], [], [], 0.1)[0]:
                ch = sys.stdin.read(1)

                if ch == ' ' and snapshot_s is not None:
                    snapshot(snapshot_s, args.average)
                    print(f'  Captured frames + {snapshot_s * 1e3:g} ms. Press [SPACE] for the next.')

                elif ch == ' ':
                    if current is not None:
                        logger.stop_recording(current)
                        logger.wait_recording(current)
                        print(f'  Stopped {current}.zst. Press [SPACE] to start a new recording.')
                        current = None
                    else:
                        current = logger.record(**opts)
                        print(f'  Recording {current}.zst')

                elif ch in ('c', 'C') and current is None:
                    snapshot(0.1)
                    print('  Captured frames + 100 ms. Press [SPACE] or [c].')

                elif ch == '\x03':  # Ctrl+C (fallback if ISIG is disabled)
                    raise KeyboardInterrupt

    except KeyboardInterrupt:
        pass
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        print()
        if current is not None:
            logger.stop_recording(current)
            logger.wait_recording(current, timeout=60)
            print(f'  Stopped {current}.zst')
        print('[recorder] Done.')


if __name__ == '__main__':
    main()
