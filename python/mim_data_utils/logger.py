import os
import time
from pathlib import Path
import numpy as np
import threading



import zstandard
import struct
import ormsgpack

import queue
import multiprocessing

from scene import RawMesh, Scene
from server import ZmqPublisher, ZmqRemoteValue


class FileLoggerWriter:
    def __init__(self, path, max_file_size_mb, compression_level=10, child=None):
        self.path = path
        self.max_file_size_mb = max_file_size_mb
        self.is_full = False
        self.compression_level = compression_level
        self.fh = None
        self.child = child
        self.swap_lock = threading.Lock()

    def init(self):
        self.is_full = False
        self.fh = open(self.path, "wb+")
        self.cctx = zstandard.ZstdCompressor(level=self.compression_level)
        self.compressor = self.cctx.stream_writer(self.fh)

        self.file_size_thread = threading.Thread(target=self.check_file_size)
        self.file_size_thread.start()

    def check_file_size(self):
        while not self.is_full and self.fh:
            self.check_path = self.path
            path = Path(self.check_path)

            if not path.exists():
                break

            file_size_mb = os.stat(path).st_size / (1024 * 1024)

            # In case the file changed in the mean time, ignore this.
            if self.check_path != self.path:
                break

            if file_size_mb > self.max_file_size_mb:
                self.is_full = True
                break

            time.sleep(5)

    def reset(self, move_file_to=None):
        with self.swap_lock:
            self.close()

            if move_file_to:
                os.rename(self.path, move_file_to)

            self.init()

    def flush(self):
        self.compressor.flush(zstandard.FLUSH_FRAME)

    def log(self, data):
        if self.child:
            self.child.log(data)

        if self.is_full:
            return

        data_msgp = ormsgpack.packb(data, option=ormsgpack.OPT_SERIALIZE_NUMPY)
        header = struct.pack('>I', len(data_msgp))

        with self.swap_lock:
            if self.fh is None:
                self.init()

            self.compressor.write(header)
            self.compressor.write(data_msgp)


    def close(self):
        if self.fh is None:
            return

        self.flush()
        self.compressor.close()
        self.fh.close()
        self.fh = None
        self.is_full = False


def list2numpy(data):
    for key, value in data.items():
        if isinstance(value, dict):
            data[key] = list2numpy(value)
        elif isinstance(value, list) and len(value) > 0 and isinstance(value[0], (float, int)):
            data[key] = np.array(value)

    return data

class FileLoggerReader:
    def __init__(self, path, child=None):
        self.path = path
        self.buffer = []
        self._setup()

    def _setup(self):
        self.fh = open(self.path, "rb")
        self.dctx = zstandard.ZstdDecompressor()
        self.reader = self.dctx.stream_reader(self.fh)

    def reset(self):
        self.reader = self.dctx.stream_reader(self.fh)

    def next(self):
        # If there are no more buffered entries, then read the next one.
        if len(self.buffer) == 0:
            header = self.reader.read(4)

            self.header = header

            if not header:
                return None

            next_size = struct.unpack('>I', header)[0]

            self.buffer = ormsgpack.unpackb(self.reader.read(next_size))

        # Return the first entry from the buffered reads. Convert lists
        # to numpy arrays.
        return list2numpy(self.buffer.pop(0))

    def read_all(self, entry_filter_fn=lambda x: True):
        self.reset()
        data = []

        while True:
            entry = self.next()

            if entry is None:
                break

            if entry_filter_fn(entry):
                data.append(entry)

        return data

    def close(self):
        self.reader.close()
        self.fh.close()

class WebsocketWriter:
    def init(self):
        self.publisher = ZmqPublisher('/timeseries/')
        self.num_connected_clients = ZmqRemoteValue('websocket_num_clients')

    def log(self, data):
        if self.publisher is None:
            self.init()

        self.last_data = data
        self.publisher.send(ormsgpack.packb(data, option=ormsgpack.OPT_SERIALIZE_NUMPY))

    def close(self):
        if self.publisher:
            self.publisher.close()

    def wait_for_client(self, timeout_s=5):
        tic = time.time()

        while time.time() < tic + timeout_s:
            if self.num_connected_clients.get() > 0:
                return

            time.sleep(0.1)

        print('No websocket client connected.')

def call_method(method, arr, idx=None):
    if idx is not None:
        arr = [arr[idx]]

    for a in arr:
        getattr(a, method)()

def sub_logger(q):
    writer = []

    chunck = []
    flush = False
    min_chunck = 30
    while True:
        try:
            t, data = q.get(timeout=0.1)

            if t == 'writer':
                writer.append(data)
            elif t == 'data':
                chunck += data
            elif t == 'close' or t == 'reset':
                call_method(t, writer, data)
        except KeyboardInterrupt:
            pass  # Ignore this error.
        except queue.Empty:
            flush = True

        try:
            if len(chunck) >= min_chunck or flush:
                for w in writer:
                    w.log(chunck)

                chunck = []
        except KeyboardInterrupt:
            pass  # Ignore this error.

class SubprocessWriter:
    def __init__(self):
        self.queue = multiprocessing.Queue()
        self.p = multiprocessing.Process(target=sub_logger, args=(self.queue,))
        self.p.start()

    def _send(self, data):
        self.queue.put(data)

    def _with_writer(self, writer):
        self._send(('writer', writer))

    def with_websocket(self, host='127.0.0.1', port=5678):
        self._with_writer(WebsocketWriter(host, port))
        return self

    def with_file(self, path, file_size_mb, compression_level=10):
        self._with_writer(FileLoggerWriter(
            path, file_size_mb, compression_level))
        return self

    def log(self, data):
        self._send(('data', data))

    def close(self, idx=None):
        self._send(('close', idx))

    def reset(self, idx=None):
        self._send(('reset', idx))

class Logger(threading.Thread):
    @staticmethod
    def start_server():
        writer = WebsocketWriter()
        writer.init()
        return writer

    @staticmethod
    def to_file(path, file_size_mb, child=None, compression_level=10):
        writer = FileLoggerWriter(path, file_size_mb, compression_level, child)
        writer.init()
        return writer

    @staticmethod
    def to_subprocess():
        return SubprocessWriter()

    def __init__(self, server, layout_def=None, start=True):
        super().__init__()

        self.server = server

        self.log_queue = queue.Queue()
        self.loggable_value_classes = [RawMesh, Scene]

        if layout_def is not None:
            self.layout(layout_def)

        self.keep_running = True

        if start:
            self.start()

    def _send_data(self, data):
        self.server.log(data)

    def run(self):
        while self.keep_running:
            self.flush()
            time.sleep(0.01)

    def flush(self):
        # Only send data if there is any.
        item_to_log = []
        while not self.log_queue.empty():
            item_to_log.append(self.log_queue.get())

        if len(item_to_log) > 0:
            self._send_data(item_to_log)

    def _append_log(self, data):
        self.log_queue.put(data)

    def clear(self, max_data=(5 * 60 * 1000)):
        self.command('clear', {
            'maxData': max_data
        })

    def zoom_reset(self):
        self.command('zoomReset', {})

    def command(self, name, payload):
        self._append_log({
            'type': 'command',
            'name': name,
            'payload': payload
        })

    def add_camera(self):
        self.command('3dCamera', {})

    def camera_location(self, camera_index, position, look_at):
        self.command('3dCameraLocation', {
            'cameraIndex': camera_index,
            'position': position,
            'lookAt': look_at
        })

    def layout(self, layout_def):
        self.command('layout', layout_def)

    def log_static(self, obj, silent_error=False):
        if not isinstance(obj, dict):
            obj = obj.to_static_dict()

        self.log(obj, 'static', silent_error)

    def _log_dict(self, obj, silent_error):
        res = {}

        for key, value in obj.items():
            val_type = type(value)

            if key == 'time':  # HACK: Time is just a value, not an array.
                res['time'] = value
                continue

            if key.startswith('_'):
                continue

            if issubclass(val_type, (float, int, bool, str)):
                res[key] = value
            elif issubclass(val_type, np.generic):
                res[key] = float(value)
            elif issubclass(val_type, np.ndarray) and value.ndim == 1:
                res[key] = value.copy()
            # elif issubclass(val_type, dict):
            #     for dk, dv in value.items():
            #         if dk.startswith('_') or dk.endswith('_'):
            #             continue
            #         self.log(dk, dv, prefix=f"{key}/")
            elif issubclass(val_type,  tuple(self.loggable_value_classes)):
                res[key] = value.to_log_dict(key)
            elif issubclass(val_type, list):
                if len(value) > 0 and not np.isscalar(value[0]):
                    continue
                res[key] = np.array(value, np.float32).copy()
            elif not silent_error:
                raise ValueError(f"Asked to log unsupported value ({str(value)}) for path '{key}'.")

        return res

    def log(self, obj, time, silent_error=False):
        if issubclass(type(obj), tuple(self.loggable_value_classes)):
            obj = obj.to_log_dict()

        res = self._log_dict(obj, silent_error)

        self._append_log({
            'type': 'sample',
            'time': time,
            'payload': res
        })

    def log_image(self, name, data, time):
        self._append_log({
            'type': 'image',
            'time': time,
            'name': name,
            'payload': data
        })

    def log_video_segment(self, name, segment_info, init_file, base_url):
        self._append_log({
            'type': 'video_segment',
            'name': name,
            'segment': segment_info,
            'init_file': init_file,
            'base_url': base_url
        })

