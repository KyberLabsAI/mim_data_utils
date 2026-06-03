"""
WebSocket recorder for mim_data_utils.

Connects to the mim_data_utils websocket server as a client (like the
browser frontend) and writes all received messages to a zstandard-compressed
file.  The file format is identical to FileLoggerWriter so recordings can be
read back with FileLoggerReader.
"""

import struct
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path

import ormsgpack
import zstandard
import websocket

_VIDEO_TYPES = {b'image', b'video_segment', 'image', 'video_segment'}
_TIMESERIES_TYPES = {b'sample', b'depth', 'sample', 'depth'}

# Frames buffered per camera before fps is estimated and ffmpeg is launched.
_FPS_ESTIMATE_FRAMES = 15
# Force a keyframe every this many seconds of video.
_KEYFRAME_INTERVAL_S = 2


def _item_field(d, key):
    """Fetch a field from a msgpack-decoded dict, tolerating bytes-or-str keys."""
    if key in d:
        return d[key]
    bkey = key.encode() if isinstance(key, str) else key
    return d.get(bkey)


def _safe_name(name):
    """Make a camera name safe to embed in a filename."""
    if isinstance(name, bytes):
        name = name.decode('utf-8', 'replace')
    return ''.join(c if (c.isalnum() or c in '-_.') else '_' for c in str(name))


class _CameraEncoder:
    """Encodes one camera's incoming JPEG frames into an H.265 .mp4 via ffmpeg.

    The first few frames are buffered to estimate the stream fps from their
    timestamps; ffmpeg is then launched and the buffer flushed.  JPEG bytes are
    piped straight in (decoded on CPU by ffmpeg, encoded on the GPU via
    ``hevc_nvenc``), so no decode is needed on our side.
    """

    def __init__(self, name, out_path):
        self.name = name
        self.out_path = out_path
        self.proc = None
        self.started = False
        self.failed = False
        self.buffer = []  # list of (jpeg_bytes, t) until fps is known
        self.fps = None
        self.frame_count = 0

    def feed(self, jpeg, t):
        if self.failed or jpeg is None:
            return
        if not self.started:
            self.buffer.append((jpeg, t))
            if len(self.buffer) >= _FPS_ESTIMATE_FRAMES:
                self._start()
            return
        self._write(jpeg)

    def _estimate_fps(self):
        ts = [t for _, t in self.buffer
              if isinstance(t, (int, float))]
        if len(ts) >= 2 and ts[-1] > ts[0]:
            fps = (len(ts) - 1) / (ts[-1] - ts[0])
            if fps == fps and fps > 0:  # not NaN, positive
                return min(240.0, max(1.0, fps))
        return 30.0

    def _start(self):
        self.fps = self._estimate_fps()
        fps = self.fps
        cmd = [
            'ffmpeg', '-y',
            '-f', 'image2pipe',
            '-c:v', 'mjpeg',
            '-framerate', f'{fps:.6f}',
            '-i', 'pipe:0',
            '-c:v', 'hevc_nvenc',
            '-pix_fmt', 'yuv420p',
            '-preset', 'p4',
            '-g', str(max(1, round(fps * _KEYFRAME_INTERVAL_S))),
            '-force_key_frames',
            f'expr:gte(t,n_forced*{_KEYFRAME_INTERVAL_S})',
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
                cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
        except OSError as e:
            print(f'[recorder] Failed to start ffmpeg for {self.name}: {e}')
            self.failed = True
            self.buffer = []
            return
        print(f'[recorder] Encoding video {self.name} (~{self.fps:.0f} fps) '
              f'-> {self.out_path}')
        self.started = True
        for jpeg, _ in self.buffer:
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
            if ret != 0 or self.failed:
                print(f'[recorder]   {self.name}: ENCODE FAILED '
                      f'(ffmpeg exit {ret}) -> {self.out_path}')
            else:
                print(f'[recorder]   {self.name}: {self.frame_count} frames '
                      f'@ {fps:.1f} fps -> {self.out_path}')
            self.proc = None


class Recorder:
    """Records live websocket data to a zstandard-compressed file.

    The websocket connection is maintained for the lifetime of the object.
    Recording (writing to disk) can be started and stopped independently via
    :meth:`start_recording` / :meth:`stop_recording`.

    The output file is readable with ``FileLoggerReader``.
    """

    def __init__(self, path, max_file_size_mb, host='127.0.0.1', port=5678,
                 compression_level=10, embed_video=False, encode_video=False,
                 with_timeseries=True):
        self.path = str(path)
        self.url = f'ws://{host}:{port}/'
        self.compression_level = compression_level
        self.max_file_size_mb = max_file_size_mb
        self.embed_video = embed_video
        self.encode_video = encode_video
        self.with_timeseries = with_timeseries

        self._ws = None
        self._ws_thread = None
        self._lock = threading.Lock()
        self._fh = None
        self._compressor = None
        self._connected = False
        self._recording = False
        self._bytes_written = 0
        self._messages_written = 0

        self._enc_lock = threading.Lock()
        self._encoders = {}  # camera name -> _CameraEncoder

    # -- file handling --------------------------------------------------------

    def _open_file(self):
        self._fh = open(self.path, 'wb')
        cctx = zstandard.ZstdCompressor(level=self.compression_level)
        self._compressor = cctx.stream_writer(self._fh)
        self._bytes_written = 0
        self._messages_written = 0

    def _write(self, data: bytes):
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

    # -- websocket callbacks --------------------------------------------------

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

    def _on_message(self, ws, message):
        if not self._recording or not isinstance(message, bytes):
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
                enc = _CameraEncoder(name, out_path)
                self._encoders[name] = enc
            enc.feed(jpeg, t)

    def _on_error(self, ws, error):
        print(f'[recorder] WebSocket error: {error}')

    def _on_close(self, ws, close_status_code, close_msg):
        print('[recorder] WebSocket disconnected')

    def _on_open(self, ws):
        print(f'[recorder] Connected to {self.url}')

    # -- public API -----------------------------------------------------------

    def connect(self):
        """Connect to the websocket server."""
        if self._connected:
            return

        self._connected = True

        self._ws = websocket.WebSocketApp(
            self.url,
            on_open=self._on_open,
            on_message=self._on_message,
            on_error=self._on_error,
            on_close=self._on_close,
        )

        self._ws_thread = threading.Thread(target=self._ws_run, daemon=True)
        self._ws_thread.start()

    def _ws_run(self):
        while self._connected:
            self._ws.run_forever()
            if self._connected:
                print('[recorder] Disconnected, reconnecting in 1s...')
                time.sleep(1)

    def disconnect(self):
        """Disconnect from the websocket server."""
        self._connected = False
        if self._ws:
            self._ws.close()
        if self._ws_thread:
            self._ws_thread.join(timeout=3)
            self._ws_thread = None

    def start_recording(self):
        """Start writing received messages to disk."""
        if self._recording:
            return

        with self._enc_lock:
            self._encoders = {}
        self._open_file()
        self._recording = True
        print(f'[recorder] Recording to {self.path}')
        if self.encode_video:
            stem = Path(self.path).with_suffix('')
            print(f'[recorder] Encoding H.265 video per camera to '
                  f'{stem}_<camera>.mp4 (opened when each stream starts)')

    def stop_recording(self):
        """Stop writing and finalise the file."""
        if not self._recording:
            return

        self._recording = False
        self._close_file()
        self._close_encoders()

        path = Path(self.path)
        if path.exists():
            disk_mb = path.stat().st_size / (1024 * 1024)
            print(f'[recorder] Saved {self._messages_written} messages '
                  f'({self._bytes_written / (1024*1024):.1f} MB uncompressed, '
                  f'{disk_mb:.1f} MB on disk) to {self.path}')

    @property
    def is_recording(self):
        return self._recording


def main():
    import argparse
    import sys
    import tty
    import termios
    import select

    parser = argparse.ArgumentParser(
        description='Record mim_data_utils websocket stream to a file.')
    parser.add_argument('path', nargs='?', default=None,
                        help='Output file path (default: recording_<timestamp>.zst)')
    parser.add_argument('--max-size', type=float, default=500,
                        help='Max file size in MB (default: 500)')
    parser.add_argument('--host', default='127.0.0.1',
                        help='WebSocket host (default: 127.0.0.1)')
    parser.add_argument('--port', type=int, default=5678,
                        help='WebSocket port (default: 5678)')
    parser.add_argument('--compression-level', type=int, default=10,
                        help='Zstandard compression level 1-22 (default: 10)')
    parser.add_argument('--with-embed-video', action='store_true', default=False,
                        help='Embed raw image/video_segment messages in the '
                             'recording (excluded by default)')
    parser.add_argument('--with-encode-video', action='store_true', default=False,
                        help="Encode each camera's images into an H.265 .mp4 "
                             'beside the recording (5s keyframes, GPU hevc_nvenc)')
    parser.add_argument('--without-timeseries', action='store_true', default=False,
                        help='Do not log timeseries (sample/depth) data to the '
                             'recording (logged by default)')
    args = parser.parse_args()

    if args.path is None:
        args.path = f'recording_{datetime.now():%Y%m%d_%H%M%S}.zst'

    rec = Recorder(
        path=args.path,
        max_file_size_mb=args.max_size,
        host=args.host,
        port=args.port,
        compression_level=args.compression_level,
        embed_video=args.with_embed_video,
        encode_video=args.with_encode_video,
        with_timeseries=not args.without_timeseries,
    )

    rec.connect()

    print()
    print('  [SPACE] Start/stop recording')
    print('  [Ctrl+C] Exit')
    print()

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

                if ch == ' ':
                    if rec.is_recording:
                        rec.stop_recording()
                        print('  Stopped. Press [SPACE] to start a new recording.')
                    else:
                        # New recording gets a fresh timestamp if using default
                        if not any(a for a in sys.argv[1:]
                                   if not a.startswith('-')):
                            rec.path = (f'recording_'
                                        f'{datetime.now():%Y%m%d_%H%M%S}.zst')

                        rec.start_recording()

                elif ch == '\x03':  # Ctrl+C (fallback if ISIG is disabled)
                    raise KeyboardInterrupt

    except KeyboardInterrupt:
        pass
    finally:
        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
        print()

        if rec.is_recording:
            rec.stop_recording()

        rec.disconnect()
        print('[recorder] Done.')


if __name__ == '__main__':
    main()
