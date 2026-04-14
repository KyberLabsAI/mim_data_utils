"""
WebSocket recorder for mim_data_utils.

Connects to the mim_data_utils websocket server as a client (like the
browser frontend) and writes all received messages to a zstandard-compressed
file.  The file format is identical to FileLoggerWriter so recordings can be
read back with FileLoggerReader.
"""

import struct
import threading
import time
from datetime import datetime
from pathlib import Path

import ormsgpack
import zstandard
import websocket

_VIDEO_TYPES = {b'image', b'video_segment', 'image', 'video_segment'}


class Recorder:
    """Records live websocket data to a zstandard-compressed file.

    The websocket connection is maintained for the lifetime of the object.
    Recording (writing to disk) can be started and stopped independently via
    :meth:`start_recording` / :meth:`stop_recording`.

    The output file is readable with ``FileLoggerReader``.
    """

    def __init__(self, path, max_file_size_mb, host='127.0.0.1', port=5678,
                 compression_level=10, with_video=False):
        self.path = str(path)
        self.url = f'ws://{host}:{port}/'
        self.compression_level = compression_level
        self.max_file_size_mb = max_file_size_mb
        self.with_video = with_video

        self._ws = None
        self._ws_thread = None
        self._lock = threading.Lock()
        self._fh = None
        self._compressor = None
        self._connected = False
        self._recording = False
        self._bytes_written = 0
        self._messages_written = 0

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

    # -- websocket callbacks --------------------------------------------------

    def _on_message(self, ws, message):
        if not self._recording or not isinstance(message, bytes):
            return

        if not self.with_video:
            items = ormsgpack.unpackb(message)
            if not isinstance(items, list):
                return
            items = [i for i in items if not (
                isinstance(i, dict)
                and i.get(b'type', i.get('type')) in _VIDEO_TYPES
            )]
            if not items:
                return
            message = ormsgpack.packb(items)

        self._write(message)

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

        self._open_file()
        self._recording = True
        print(f'[recorder] Recording to {self.path}')

    def stop_recording(self):
        """Stop writing and finalise the file."""
        if not self._recording:
            return

        self._recording = False
        self._close_file()

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
    parser.add_argument('--with-video', action='store_true', default=False,
                        help='Record images and video segments (excluded by default)')
    args = parser.parse_args()

    if args.path is None:
        args.path = f'recording_{datetime.now():%Y%m%d_%H%M%S}.zst'

    rec = Recorder(
        path=args.path,
        max_file_size_mb=args.max_size,
        host=args.host,
        port=args.port,
        compression_level=args.compression_level,
        with_video=args.with_video,
    )

    rec.connect()

    print()
    print('  [SPACE] Start/stop recording')
    print('  [Ctrl+C] Exit')
    print()

    # Raw terminal mode for keypress detection
    fd = sys.stdin.fileno()
    old_settings = termios.tcgetattr(fd)

    try:
        tty.setraw(fd)

        while True:
            # Wait for input with a short timeout so Ctrl+C works
            if select.select([sys.stdin], [], [], 0.1)[0]:
                ch = sys.stdin.read(1)

                if ch == ' ':
                    if rec.is_recording:
                        rec.stop_recording()
                        # Reset terminal briefly to print cleanly
                        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                        print('  Stopped. Press [SPACE] to start a new recording.')
                        tty.setraw(fd)
                    else:
                        # New recording gets a fresh timestamp if using default
                        if not any(a for a in sys.argv[1:]
                                   if not a.startswith('-')):
                            rec.path = (f'recording_'
                                        f'{datetime.now():%Y%m%d_%H%M%S}.zst')

                        termios.tcsetattr(fd, termios.TCSADRAIN, old_settings)
                        rec.start_recording()
                        tty.setraw(fd)

                elif ch == '\x03':  # Ctrl+C
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
