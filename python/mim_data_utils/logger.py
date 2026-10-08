import atexit
import heapq
import os
import time
import uuid
from pathlib import Path
import numpy as np
import threading



import zstandard
import struct
import ormsgpack

import queue
import collections
import multiprocessing

from .scene import RawMesh, Scene, PointCloud
from kyber_utils.zeromq import ZmqPublisher, ZmqRemoteValue
from kyber_utils.iters import sync, register_sync_methods

# Item types routed to the low-priority '/camera/' publisher (video frames).
_CAMERA_TYPES = ('image', 'video_segment')
# Point-cloud (depth) frames go on their own '/pointcloud/' publisher so the
# server can shed them independently — they're the heaviest payload, so under
# backpressure they should drop before camera video and long before timeseries.
_POINTCLOUD_TYPES = ('depth',)
# Setup items (scene registrations and viewer settings) go on their own
# '/setup/' publisher. The server unpacks and caches them per session so it can
# replay them to a viewer that connects (or reloads) later; everything else
# stays an opaque blob on the relay hot path.
_SETUP_TYPES = ('setup',)

# Session name used when the producer does not specify one.
DEFAULT_SESSION = 'Default'


def resolve_shm_items(items):
    """Inline shared-memory payload references.

    Log items produced with `Logger(image_shm=True)` carry
    ``{'shm': {field: ref, ...}}`` instead of the payload bytes of those
    fields (images: 'payload'; depth frames: 'depth' and 'rgb'). Consumers
    that need the payloads embedded (file logs, websocket forwarding) call
    this to fetch the bytes back into their fields. Items with any payload
    no longer available (ring wrapped past the reference or the writer
    restarted) are dropped.
    """
    if not any(isinstance(it, dict) and 'shm' in it for it in items):
        return items

    from kyber_utils.shared_image_buffer import resolve_shm_ref
    out = []
    for it in items:
        if not (isinstance(it, dict) and 'shm' in it):
            out.append(it)
            continue
        fields = {}
        for field, ref in it['shm'].items():
            payload = resolve_shm_ref(ref)
            if payload is None:
                fields = None
                break
            fields[field] = payload
        if fields is None:
            continue
        it = {k: v for k, v in it.items() if k != 'shm'}
        it.update(fields)
        out.append(it)
    return out


class FileLoggerWriter:
    def __init__(self, path, max_file_size_mb, compression_level=10, child=None):
        self.path = path
        self.max_file_size_mb = max_file_size_mb
        self.is_full = False
        self.compression_level = compression_level
        self.fh = None
        self.child = child
        self.swap_lock = threading.Lock()

    def set_session(self, name):
        # Sessions only matter for the websocket viewer; the file format stores
        # the session name per sample. Accept the call so Logger can run with a
        # plain file writer (headless logging).
        if self.child:
            self.child.set_session(name)

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

        # Files must be self-contained: inline any shared-memory image
        # references before writing (references are only valid live, on the
        # producing machine).
        data = resolve_shm_items(data)

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
    """Read a `.zst` recording back one entry at a time.

    Entries come out in increasing `time` by default. A recording is not
    written in time order: several producers log into one session -- the 1 kHz
    controller state and the 30 Hz 3d scene, say -- and each is monotonic on
    its own while the interleaving is not, so a plain read walks time
    backwards at every hand-over.

    To fix that without sorting the whole file, entries are held in a small
    buffer and released oldest-first once enough has been read past them for
    an earlier one to be impossible. The buffer grows to cover the
    out-of-orderness the recording actually shows; needing more than
    `max_window_s` of it means the timestamps jump (a clock reset, or two
    unrelated recordings concatenated) and raises rather than silently
    reordering across the gap.

    Args:
        raw_order: hand entries back exactly as recorded, no buffering.
        max_window_s: how much recording time the reorder buffer may span
            before that is treated as an error.
    """

    def __init__(self, path, child=None, raw_order=False, max_window_s=2.0):
        self.path = path
        self.buffer = []
        self.raw_order = bool(raw_order)
        self.max_window_s = float(max_window_s)
        self._setup()

    def _setup(self):
        self.fh = open(self.path, "rb")
        self.dctx = zstandard.ZstdDecompressor()
        self.reader = self.dctx.stream_reader(self.fh)
        self._reset_order_state()

    def _reset_order_state(self):
        self._heap = []
        self._seq = 0            # tie-break, keeps equal stamps in file order
        self._eof = False
        self._t_read_max = None  # newest stamp read so far
        self._t_emitted = None   # newest stamp handed out
        self._max_backstep = 0.0
        # Read-ahead kept before releasing the oldest entry. Starts at a
        # value that covers ordinary interleaving and grows to twice the
        # largest step backwards actually seen.
        self._hold = min(0.1, self.max_window_s / 4.0)

    def reset(self):
        self.fh.seek(0)
        self.buffer = []
        self.reader = self.dctx.stream_reader(self.fh)
        self._reset_order_state()

    def _next_raw(self):
        """The next entry in the order it was written."""
        # If there are no more buffered entries, then read the next one.
        if len(self.buffer) == 0:
            header = self.reader.read(4)

            self.header = header

            if not header:
                return None

            next_size = struct.unpack('>I', header)[0]

            items = ormsgpack.unpackb(self.reader.read(next_size))
            # Recordings made from the websocket stream contain columnar
            # 'sample_batch' items; hand them out as plain samples.
            self.buffer = [x for it in items for x in (
                expand_sample_batch(it)
                if isinstance(it, dict) and it.get('type') == 'sample_batch' else [it])]

        # Return the first entry from the buffered reads. Convert lists
        # to numpy arrays.
        return list2numpy(self.buffer.pop(0))

    @staticmethod
    def _entry_time(entry):
        """Numeric stamp of an entry, or None when it has no orderable one
        (a `'static'` sample, a setup item)."""
        if not isinstance(entry, dict):
            return None
        t = entry.get('time')
        if isinstance(t, bool) or not isinstance(t, (int, float)):
            return None
        return float(t)

    def next(self):
        if self.raw_order:
            return self._next_raw()

        while True:
            if self._heap:
                t_min = self._heap[0][0]
                if self._eof or (self._t_read_max - t_min) >= self._hold:
                    t, _, entry = heapq.heappop(self._heap)
                    if self._t_emitted is not None and t < self._t_emitted:
                        raise ValueError(
                            f'FileLoggerReader: {self._t_emitted - t:.6f} s '
                            f'step backwards survived the reorder buffer at '
                            f't={t:.6f}. Raise max_window_s (currently '
                            f'{self.max_window_s:.3f} s) or pass '
                            f'raw_order=True to read the file as recorded.')
                    self._t_emitted = t
                    return entry

            if self._eof:
                return None

            entry = self._next_raw()
            if entry is None:
                self._eof = True
                continue

            t = self._entry_time(entry)
            if t is None:
                # Not orderable: leave it where the stream put it.
                t = self._t_read_max if self._t_read_max is not None else 0.0

            if self._t_read_max is None or t >= self._t_read_max:
                self._t_read_max = t
            else:
                back = self._t_read_max - t
                if back > self._max_backstep:
                    self._max_backstep = back
                    self._hold = max(self._hold, 2.0 * back)

            heapq.heappush(self._heap, (t, self._seq, entry))
            self._seq += 1

            span = self._t_read_max - self._heap[0][0]
            if span > self.max_window_s:
                raise ValueError(
                    f'FileLoggerReader: the reorder buffer would have to span '
                    f'{span:.3f} s, more than max_window_s='
                    f'{self.max_window_s:.3f} s. The recording jumps backwards '
                    f'in time by more than that (a clock reset, or two '
                    f'recordings concatenated). Pass raw_order=True to read it '
                    f'as recorded, or raise max_window_s.')

    def read_all(self, entry_filter_fn=lambda x: True, reducer_fn=None):
        self.reset()
        data = []

        while True:
            entry = self.next()

            if entry is None:
                break

            if not entry_filter_fn(entry):
                continue

            if reducer_fn is not None:
                entry = reducer_fn(entry)

            data.append(entry)

        return data

    def close(self):
        self.reader.close()
        self.fh.close()


# --- Columnar sample batches ---------------------------------------------
#
# The viewer's cost is per *sample*: at 1 kHz it decoded ~1000 msgpack dicts
# of ~80 small float64 lists per second (6.5 MB/s) and did ~80 k key lookups
# on top -- enough to pin a browser core. The mim server (server.py) therefore
# bins the 'sample' items it relays into one 'sample_batch' item per 30 ms
# with one float32 column per key -- on the server, not in the producer: the
# producer's Logger thread shares the control process's GIL, and packing there
# cost the 1 kHz loop ~1 ms per bin.
#
#   {'type': 'sample_batch', 'session': s, 'n': N,
#    'times':   <N float64, little-endian bytes>,
#    'columns': {key: {'d': d, 'f32': <N*d float32 bytes, row-major>}},
#    'rows':    {key: [N raw values]}}      # non-numeric / irregular keys
#
# A key goes to `columns` only when it is present in every sample of the bin
# with the same numeric shape; everything else (strings, dicts, missing or
# shape-changing keys) keeps its raw per-sample values in `rows`.
# `expand_sample_batch` turns a batch back into plain 'sample' items for
# readers (FileLoggerReader), so recordings keep their old interface.

def pack_sample_batch(samples, session):
    """samples: list of {'type': 'sample', 'time': float, 'payload': dict}.

    Samples in one bin do not have to share a payload: the controller logs its
    state and the visualiser logs the 3d scene through the same session, so a
    bin holds a mix. Each key therefore carries the indices of the samples it
    appears in (`i`, omitted when it is in all of them) -- a key present in
    only some samples is still stored columnar over those, and stays *absent*
    from the others rather than being filled in with None.

    Values may be numpy arrays (producer side) or plain lists/scalars (after
    a msgpack round trip, as in the server). One np.asarray per key over its
    samples; ragged or non-numeric keys fall back to `rows`.
    """
    n = len(samples)
    times = np.fromiter((float(s['time']) for s in samples), dtype='<f8', count=n)
    payloads = [s['payload'] for s in samples]

    # key -> the sample indices carrying it, in order.
    where = {}
    for i, pl in enumerate(payloads):
        for k in pl:
            where.setdefault(k, []).append(i)

    columns, rows = {}, {}
    for k, idx in where.items():
        vals = [payloads[i][k] for i in idx]
        where_i = None if len(idx) == n else idx
        v0 = vals[0]
        try:
            if isinstance(v0, np.ndarray):
                if v0.dtype.kind not in 'fiub':
                    raise TypeError
                col = np.asarray(vals, dtype='<f8').reshape(len(vals), -1)
            elif isinstance(v0, (bool, int, float, np.generic)):
                col = np.asarray(vals, dtype='<f8').reshape(len(vals), 1)
            elif isinstance(v0, (list, tuple)) and v0:
                col = np.asarray(vals, dtype='<f8').reshape(len(vals), -1)
            else:
                raise TypeError
        except (TypeError, ValueError):
            rows[k] = {'v': vals, 'i': where_i}
            continue
        if col.shape[1] == 0:
            rows[k] = {'v': vals, 'i': where_i}
            continue

        # float32 halves the payload but carries only ~7 significant digits.
        # A *relative* check is not enough to decide: a wall-clock stamp
        # (1.79e9) has a float32 step of ~128 s, which is a relative error of
        # 7e-8 yet destroys a column whose own spread is milliseconds. So
        # compare the round-trip error against what the column actually
        # varies by, and fall back to float64 when it does not resolve it.
        col32 = col.astype('<f4')
        finite = np.isfinite(col)
        if finite.any():
            err = float(np.abs(col32.astype('<f8') - col)[finite].max())
            spread = float(np.ptp(col[finite]))
            # Narrow only when the error is negligible against what the
            # column varies by AND small in absolute terms -- the second half
            # catches a large constant (a `t0` stamp is off by ~64 s in
            # float32 while its relative error is a harmless 4e-8).
            keep32 = err <= max(1e-4 * spread, 1e-6)
        else:
            keep32 = True
        data, dtype = (col32, 'f4') if keep32 else (col, 'f8')
        columns[k] = {'d': int(col.shape[1]), 'v': data.tobytes(),
                      'dt': dtype, 'i': where_i}

    return {'type': 'sample_batch', 'session': session, 'n': n,
            'times': times.tobytes(), 'columns': columns, 'rows': rows}


def expand_sample_batch(item):
    """Inverse of pack_sample_batch: list of plain 'sample' items.

    A key is written back only onto the samples that carried it, so an
    expanded batch has exactly the payloads that went in.
    """
    n = item['n']
    times = np.frombuffer(item['times'], dtype='<f8')
    out = [{'type': 'sample', 'time': float(times[i]),
            'session': item.get('session'), 'payload': {}} for i in range(n)]

    for k, c in item.get('columns', {}).items():
        d = c['d']
        buf = c['v'] if 'v' in c else c['f32']          # 'f32': first version
        arr = np.frombuffer(buf, dtype='<' + c.get('dt', 'f4')).reshape(-1, d)
        idx = c.get('i')
        idx = range(n) if idx is None else idx
        for j, i in enumerate(idx):
            out[i]['payload'][k] = (float(arr[j, 0]) if d == 1
                                    else arr[j].astype(np.float64))

    for k, rv in item.get('rows', {}).items():
        if isinstance(rv, dict):
            vals = rv['v']
            idx = rv.get('i')
            idx = range(n) if idx is None else idx
            for j, i in enumerate(idx):
                out[i]['payload'][k] = vals[j]
        else:
            # Recordings from the first version of this format stored a plain
            # full-length list and filled missing entries with None. There is
            # no way to tell those apart from a genuine None, so drop them --
            # a key the producer never logged is better absent than null.
            for i, v in enumerate(rv):
                if v is not None:
                    out[i]['payload'][k] = v
    return out


class WebsocketWriter:
    # pyzmq sockets are NOT thread-safe. This lock serialises all socket
    # touches (init/close/send) across every thread. Everything that can
    # read or write self.publisher / self.camera_publisher acquires it.
    def __init__(self):
        self.session_name = None
        self.publisher = None
        self.camera_publisher = None
        self.pointcloud_publisher = None
        self.setup_publisher = None
        self.num_connected_clients = None
        self._lock = threading.RLock()
    def init(self):
        with self._lock:
            assert(self.session_name is not None)

            # All data topics are session-scoped so the server can track
            # session liveness and route without unpacking payloads.
            self.publisher = ZmqPublisher(f'/timeseries/{self.session_name}')
            self.camera_publisher = ZmqPublisher(f'/camera/{self.session_name}', sndhwm=2)
            self.pointcloud_publisher = ZmqPublisher(f'/pointcloud/{self.session_name}', sndhwm=2)
            self.setup_publisher = ZmqPublisher('/setup/')
            self.num_connected_clients = ZmqRemoteValue('websocket_num_clients')

            if not self.publisher.wait_connected():
                raise ConnectionError('Timeseries publisher failed to connect to ZMQ broker')
            if not self.camera_publisher.wait_connected():
                raise ConnectionError('Camera publisher failed to connect to ZMQ broker')
            if not self.pointcloud_publisher.wait_connected():
                raise ConnectionError('Point cloud publisher failed to connect to ZMQ broker')
            if not self.setup_publisher.wait_connected():
                raise ConnectionError('Setup publisher failed to connect to ZMQ broker')

    def set_session(self, name):
        with self._lock:
            self.session_name = name

            # Need to reconnect the publishers as the timeseries endpoint
            # changes.  Hold the lock across close+init so no other thread
            # can try to send on a half-torn-down socket.
            if self.publisher:
                self.close()
                self.init()

    _log_debug_count = 0
    _log_debug_img_count = 0
    _log_debug_last_print = 0
    _log_debug_max_img_age = 0

    def log(self, data):
        # Pack outside the lock to keep the critical section short. Split into
        # three priority streams (camera video / point cloud / everything else)
        # so the server can shed each independently under backpressure.
        camera_items = [d for d in data if d.get('type') in _CAMERA_TYPES]
        pointcloud_items = [d for d in data if d.get('type') in _POINTCLOUD_TYPES]
        setup_items = [d for d in data if d.get('type') in _SETUP_TYPES]
        other_items = [
            d for d in data
            if d.get('type') not in _CAMERA_TYPES
            and d.get('type') not in _POINTCLOUD_TYPES
            and d.get('type') not in _SETUP_TYPES
        ]

        setup_bytes = (
            ormsgpack.packb(setup_items, option=ormsgpack.OPT_SERIALIZE_NUMPY)
            if setup_items else None
        )
        camera_bytes = (
            ormsgpack.packb(camera_items, option=ormsgpack.OPT_SERIALIZE_NUMPY)
            if camera_items else None
        )
        pointcloud_bytes = (
            ormsgpack.packb(pointcloud_items, option=ormsgpack.OPT_SERIALIZE_NUMPY)
            if pointcloud_items else None
        )
        other_bytes = (
            ormsgpack.packb(other_items, option=ormsgpack.OPT_SERIALIZE_NUMPY)
            if other_items else None
        )

        # Debug: track image age at publish time
        now = time.time()
        WebsocketWriter._log_debug_count += 1
        for item in camera_items:
            if item.get('type') == 'image' and 'time' in item:
                age = now - item['time']
                WebsocketWriter._log_debug_img_count += 1
                WebsocketWriter._log_debug_max_img_age = max(
                    WebsocketWriter._log_debug_max_img_age, age)

        if now - WebsocketWriter._log_debug_last_print >= 2.0 \
                and WebsocketWriter._log_debug_img_count > 0:
            print(f"[ws-writer] {WebsocketWriter._log_debug_count} batches, "
                  f"{WebsocketWriter._log_debug_img_count} imgs, "
                  f"max_img_age={WebsocketWriter._log_debug_max_img_age:.3f}s, "
                  f"batch_size={len(data)} items "
                  f"({len(camera_items)} cam, {len(other_items)} other)")
            WebsocketWriter._log_debug_count = 0
            WebsocketWriter._log_debug_img_count = 0
            WebsocketWriter._log_debug_max_img_age = 0
            WebsocketWriter._log_debug_last_print = now

        # Socket access must be serialised — pyzmq sockets are not
        # thread-safe, and a concurrent close() from set_session() would
        # otherwise let the zmq I/O thread touch freed memory (GPF).
        with self._lock:
            if self.publisher is None:
                self.init()
            self.last_data = data
            if setup_bytes is not None:
                self.setup_publisher.send(setup_bytes)
            if camera_bytes is not None:
                self.camera_publisher.send(camera_bytes)
            if pointcloud_bytes is not None:
                self.pointcloud_publisher.send(pointcloud_bytes)
            if other_bytes is not None:
                self.publisher.send(other_bytes)

    def close(self):
        with self._lock:
            if self.publisher:
                self.publisher.close()
                self.publisher = None
            if getattr(self, 'camera_publisher', None):
                self.camera_publisher.close()
                self.camera_publisher = None
            if getattr(self, 'pointcloud_publisher', None):
                self.pointcloud_publisher.close()
                self.pointcloud_publisher = None
            if getattr(self, 'setup_publisher', None):
                self.setup_publisher.close()
                self.setup_publisher = None

    def wait_for_client(self, timeout_s=5):
        # The publishers are created lazily on the first log(), which happens
        # on the Logger thread. A caller that constructs a Logger and asks for
        # the client count right away can get here first, so connect now
        # instead of relying on winning that race.
        with self._lock:
            if self.publisher is None:
                self.init()

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

@register_sync_methods
class Logger(threading.Thread):
    @staticmethod
    def start_server():
        writer = WebsocketWriter()
        return writer

    @staticmethod
    def to_file(path, file_size_mb, child=None, compression_level=10):
        writer = FileLoggerWriter(path, file_size_mb, compression_level, child)
        return writer

    @staticmethod
    def to_subprocess():
        return SubprocessWriter()

    def __init__(self, server, layout_def=None, start=True, make_session_active=True,
                 session=None, image_shm=True, image_shm_slots=8,
                 image_shm_slot_mb=4):
        super().__init__()

        self.server = server
        self.session_name = session or DEFAULT_SESSION

        # Ship log_image payloads via a shared-memory ring instead of inline
        # zeromq bytes: the message then carries only a small reference, and
        # the server reads the payload lazily — only when it actually forwards
        # the frame to a viewer (nothing is read under backpressure). Requires
        # producer and server on the same machine; falls back to inline
        # payloads automatically if the ring cannot be set up.
        # `image_shm_slots` is the ring depth: how many recent frames stay
        # readable while their references are in flight.
        self.image_shm = image_shm
        self.image_shm_slots = image_shm_slots
        self.image_shm_slot_mb = image_shm_slot_mb
        self._image_rings = {}
        self._image_shm_warned = False

        # Only identifies who registered a setup, for debugging. Registered
        # setups outlive the producer: like the timeseries and images already
        # in the viewer, a scene stays put when its producer goes away.
        self.producer_id = uuid.uuid4().hex

        server.set_session(self.session_name)

        # Lock-free hand-off from the producers (the 1 kHz control thread) to
        # this consumer thread: deque.append()/popleft() are atomic under the
        # GIL, so the producer never blocks on a lock that this thread might be
        # holding while descheduled (queue.Queue.put() took the queue lock and
        # caused ms-scale priority-inversion stalls in the control loop).
        self.log_queue = collections.deque()
        self.loggable_value_classes = [RawMesh, Scene, PointCloud]
        # Per-dict cache of the loggable-key classification, see _log_dict().
        self._log_dict_cache = {}
        self.flush_stats = self._new_flush_stats()

        # Launching a session announces it to the server (registering it in
        # the live-session list, evicting the stalest one if there are more
        # than 4) and starts it fresh: the viewer clears any previous data of
        # this session name and switches to it. Passive loggers
        # (make_session_active=False, e.g. camera-only publishers) join the
        # session without clearing it.
        if make_session_active:
            self.activate_session()

        print(f"Session: {self.session_name}")

        if layout_def is not None:
            self.layout(layout_def)

        self.keep_running = True
        self._own_recordings = []      # prefixes started by record() (wait_finished)

        if start:
            self.start()

    @staticmethod
    def _new_flush_stats():
        return {'n': 0, 'items': 0, 'max_s': 0., 'max_items': 0, 'n_over_2ms': 0, 'sum_s': 0.}

    def queue_depth(self):
        """Number of log items waiting to be flushed by the logger thread."""
        return len(self.log_queue)

    def pop_flush_stats(self):
        """Return and reset the flush timing statistics (see flush())."""
        st, self.flush_stats = self.flush_stats, self._new_flush_stats()
        return st

    def _send_data(self, data):
        self.server.log(data)

    def run(self):
        while self.keep_running:
            # Block until there is something to send instead of waking 1000x
            # a second to find an empty queue. The timeout is only so that
            # keep_running still gets checked while nothing is being logged.
            # Poll the deque (no lock, no condition variable to wake on). A
            # 3 ms cadence batches ~3 control-loop samples per message, about
            # what the previous "first item + 1 ms" strategy produced.
            time.sleep(0.003)
            if not self.log_queue:
                continue
            self.flush()

    _flush_debug_last_print = 0

    def flush(self, first_item=None):
        # Only send data if there is any.
        item_to_log = [] if first_item is None else [first_item]
        while True:
            try:
                item_to_log.append(self.log_queue.popleft())
            except IndexError:
                break

        if len(item_to_log) > 0:
            t_send0 = time.perf_counter()
            now = time.time()
            img_count = sum(1 for item in item_to_log if item.get('type') == 'image')
            if now - Logger._flush_debug_last_print >= 2.0 and img_count > 0:
                # Check age of images in queue
                img_ages = [now - item['time'] for item in item_to_log if item.get('type') == 'image']
                print(f"[logger-flush] queue_depth={self.queue_depth()}, "
                      f"flushing {len(item_to_log)} items ({img_count} imgs), "
                      f"img_age: avg={sum(img_ages)/len(img_ages):.3f}s max={max(img_ages):.3f}s")
                Logger._flush_debug_last_print = now
            self._send_data(item_to_log)
            # Flush timing (the pack + zmq send holds the GIL): exposed as
            # flush_stats for the control-loop health reporter.
            dt = time.perf_counter() - t_send0
            if not hasattr(self, 'flush_stats'):
                self.flush_stats = self._new_flush_stats()
            st = self.flush_stats
            st['n'] += 1
            st['items'] += len(item_to_log)
            if dt > st['max_s']:
                st['max_s'] = dt
                st['max_items'] = len(item_to_log)
            if dt > 0.002:
                st['n_over_2ms'] += 1
            st['sum_s'] += dt

    def _append_log(self, data):
        # Every item carries its session so the viewer can file it into the
        # right per-session store.
        data.setdefault('session', self.session_name)
        self.log_queue.append(data)

    def activate_session(self):
        # Goes through the '/setup/' channel: the server unpacks setup items,
        # so it sees the launch, (re)registers the session, clears the
        # session's cached setups and tells the viewers to start it fresh.
        self._append_log({
            'type': 'setup',
            'op': 'launch',
            'session': self.session_name,
            'producer': self.producer_id,
        })

    def clear(self, max_data=(5 * 60 * 1000)):
        self.clear_setups()
        self.command('clear', {
            'maxData': max_data
        })

    def zoom_reset(self):
        self.command('zoomReset', {})

    def command(self, name, payload):
        """Send a one-off, non-persisted viewer command.

        Use `register_setting` instead for anything that should survive a page
        reload -- a command is only seen by the viewers connected right now.
        """
        self._append_log({
            'type': 'command',
            'name': name,
            'payload': payload
        })

    # --- Registered setups -------------------------------------------------
    # Setups are the part of the stream that a viewer needs in order to make
    # sense of everything else: the 3d scene objects and the viewer settings.
    # The server caches them per session and replays them to every viewer that
    # connects, so opening or reloading the page mid-session still shows the
    # meshes and point clouds. Entries are keyed, so re-registering replaces
    # the previous version. They stay until explicitly removed or cleared --
    # a producer that stops publishing leaves its scene in place, the same way
    # the timeseries and images it already sent stay in the viewer.

    def _setup_action(self, op, **fields):
        self._append_log({
            'type': 'setup',
            'op': op,
            'session': self.session_name,
            'producer': self.producer_id,
            **fields
        })

    def register_setup(self, obj, silent_error=False):
        """Register 3d scene objects (meshes, point clouds) for this session.

        Takes a `Scene` (or a dict of name -> loggable object) and registers one
        entry per object under its '3d/<name>' key.
        """
        if not isinstance(obj, dict):
            obj = obj.to_static_dict()

        for key, payload in self._log_dict(obj, silent_error).items():
            self._setup_action('set', kind='scene', key=key, payload=payload)

    def unregister_setup(self, key):
        """Remove a single registered scene object, e.g. '3d/table'."""
        self._setup_action('remove', kind='scene', key=key)

    def register_setting(self, key, name, payload):
        """Register a viewer setting that is re-applied on every viewer connect.

        `key` identifies the setting in the registry (re-registering replaces
        it), `name` is the viewer-side action to run with `payload`.
        """
        self._setup_action('set', kind='setting', key=key, name=name,
                           payload=payload)

    def clear_setups(self):
        """Drop all registered setups of this session (all producers)."""
        self._setup_action('clear')

    def add_camera(self):
        self.register_setting('3dCamera', '3dCamera', {})

    def camera_location(self, camera_index, position, look_at):
        self.register_setting(f'3dCameraLocation/{camera_index}',
                              '3dCameraLocation', {
            'cameraIndex': camera_index,
            'position': position,
            'lookAt': look_at
        })

    def layout(self, layout_def):
        self.register_setting('layout', 'layout', layout_def)

    # How often (in calls per dict) the cached classification is rebuilt from
    # scratch so that attributes added later, or attributes whose type changed,
    # are picked up. At 1 kHz this is once per second.
    _LOG_DICT_CACHE_REFRESH = 1000

    # Value kinds stored in the classification cache.
    _K_TIME, _K_SCALAR, _K_NPGENERIC, _K_ARRAY, _K_LOGGABLE, _K_LIST = range(6)

    def _classify_value(self, key, value, silent_error):
        """Return the kind code for a (key, value) pair or None to skip it."""
        val_type = type(value)

        if key == 'time':  # HACK: Time is just a value, not an array.
            return self._K_TIME
        if key.startswith('_'):
            return None
        if issubclass(val_type, (float, int, bool, str)):
            return self._K_SCALAR
        if issubclass(val_type, np.generic):
            return self._K_NPGENERIC
        if issubclass(val_type, np.ndarray) and value.ndim == 1:
            return self._K_ARRAY
        # elif issubclass(val_type, dict):
        #     for dk, dv in value.items():
        #         if dk.startswith('_') or dk.endswith('_'):
        #             continue
        #         self.log(dk, dv, prefix=f"{key}/")
        if issubclass(val_type, tuple(self.loggable_value_classes)):
            return self._K_LOGGABLE
        if issubclass(val_type, list):
            if len(value) > 0 and not np.isscalar(value[0]):
                return None
            return self._K_LIST
        if not silent_error:
            raise ValueError(f"Asked to log unsupported value ({str(value)}) for path '{key}'.")
        return None

    def _log_dict_convert(self, res, key, value, kind):
        if kind == self._K_TIME or kind == self._K_SCALAR:
            res[key] = value
        elif kind == self._K_NPGENERIC:
            res[key] = float(value)
        elif kind == self._K_ARRAY:
            res[key] = value.copy()
        elif kind == self._K_LOGGABLE:
            res[key] = value.to_log_dict(key)
        elif kind == self._K_LIST:
            res[key] = np.array(value, np.float32).copy()

    def _log_dict_slow(self, obj, silent_error):
        """Full scan: classify every entry and return (res, cache_items)."""
        res = {}
        items = []
        for key, value in obj.items():
            kind = self._classify_value(key, value, silent_error)
            if kind is None:
                continue
            items.append((key, kind))
            self._log_dict_convert(res, key, value, kind)
        return res, items

    def _log_dict(self, obj, silent_error):
        """Convert a dict of values into the loggable payload.

        Typical use is ``logger.log(controller.__dict__, t)`` at 1 kHz: the
        dict has 100+ entries, most of them not loggable (heads, helpers,
        objects), and the type dispatch gives the same answer every call.
        The classification is therefore cached per dict (keyed by the dict's
        identity) and the per-call work is reduced to copying the loggable
        values. The cache is rebuilt when the number of keys changes, when a
        cached value no longer has the expected type, or every
        ``_LOG_DICT_CACHE_REFRESH`` calls.
        """
        # Plain dict copy so that a producer mutating the dict's keys while
        # we iterate (other thread) doesn't break the iteration.
        cache_key = id(obj)
        cache = self._log_dict_cache.get(cache_key)
        n_keys = len(obj)

        if cache is not None and cache['n_keys'] == n_keys and cache['age'] < self._LOG_DICT_CACHE_REFRESH:
            cache['age'] += 1
            res = {}
            get = obj.get
            try:
                for key, kind in cache['items']:
                    value = get(key, self)   # self = sentinel for "missing"
                    if value is self:
                        raise KeyError(key)
                    if kind == self._K_ARRAY:
                        if type(value) is not np.ndarray or value.ndim != 1:
                            raise TypeError(key)
                        res[key] = value.copy()
                    elif kind == self._K_SCALAR or kind == self._K_TIME:
                        res[key] = value
                    else:
                        self._log_dict_convert(res, key, value, kind)
                return res
            except (KeyError, TypeError, AttributeError):
                pass  # Stale cache -> fall through to the full scan.

        obj = dict(obj)
        res, items = self._log_dict_slow(obj, silent_error)
        # Bound the cache: it is keyed by id(), so dicts that died and whose id
        # got reused just trigger one extra rebuild.
        if len(self._log_dict_cache) > 64:
            self._log_dict_cache.clear()
        self._log_dict_cache[cache_key] = {'n_keys': len(obj), 'age': 0, 'items': items}
        return res

    def log(self, obj, time, silent_error=False):
        if issubclass(type(obj), tuple(self.loggable_value_classes)):
            obj = obj.to_log_dict()

        res = self._log_dict(obj, silent_error)

        self._append_log({
            'type': 'sample',
            'time': time,
            'session': self.session_name,
            'payload': res
        })

    def log_image(self, name, data, time):
        item = {
            'type': 'image',
            'time': time,
            'name': name,
        }
        ref = self._shm_write(name, data)
        if ref is not None:
            item['shm'] = {'payload': ref}
        else:
            item['payload'] = data
        self._append_log(item)

    def _shm_write(self, key, data):
        """Write a payload into the shared-memory ring for `key`.

        Returns the reference dict to send instead of the payload, or None to
        fall back to inline bytes (shm disabled, setup failed, or the payload
        exceeds the slot size). Rings are created lazily per key; the slot
        size adapts to the first payload (with headroom), so raw depth frames
        fit regardless of resolution.
        """
        if not self.image_shm:
            return None
        data = data if isinstance(data, bytes) else bytes(data)
        try:
            ring = self._image_rings.get(key)
            if ring is None:
                from kyber_utils.shared_image_buffer import SharedBytesRingWriter
                mb = 1024 * 1024
                slot_size = max(self.image_shm_slot_mb * mb,
                                -(len(data) * 3 // 2 // -mb) * mb)
                ring = SharedBytesRingWriter(
                    f'/mim_log/{self.session_name}/{key}',
                    slot_size=slot_size,
                    n_slots=self.image_shm_slots)
                self._image_rings[key] = ring
                atexit.register(ring.close)
            return ring.write(data)
        except Exception as e:
            if not self._image_shm_warned:
                print(f"[logger] shm ring unavailable for '{key}' ({e}); "
                      f"sending payload inline")
                self._image_shm_warned = True
            return None

    def log_depth(self, name, depth_u16, time, rgb_jpeg=None,
                  depth_scale=None, intrinsics=None):
        """Log a depth frame for the named PointCloud scene object.

        depth_u16:  np.ndarray, dtype=uint16, shape (H, W). Sent as raw
            little-endian uint16 bytes.
        rgb_jpeg:   Optional JPEG-encoded RGB overlay (bytes). Caller is
            responsible for encoding (e.g. cv2.imencode('.jpg', rgb)).
        depth_scale: Per-frame override. None => use the value from the
            static registration.
        intrinsics: Optional per-frame intrinsics override.
        """
        assert isinstance(depth_u16, np.ndarray) and depth_u16.dtype == np.uint16 \
            and depth_u16.ndim == 2, \
            'log_depth requires a 2D uint16 numpy array'
        h, w = depth_u16.shape
        item = {
            'type': 'depth',
            'time': time,
            'name': name,
            'width': int(w),
            'height': int(h),
            'depth_encoding': 'u16le',
            'depth_scale': depth_scale,
            'rgb_encoding': 'jpeg' if rgb_jpeg is not None else None,
            'rgb': None,
            'intrinsics': intrinsics,
        }
        # The heavy payloads (raw depth ~2 MB/frame, rgb overlay) go through
        # the shared-memory ring like log_image; each falls back to inline
        # bytes independently.
        refs = {}
        depth_bytes = np.ascontiguousarray(depth_u16).tobytes()
        ref = self._shm_write(f'{name}/depth', depth_bytes)
        if ref is not None:
            refs['depth'] = ref
        else:
            item['depth'] = depth_bytes
        if rgb_jpeg is not None:
            ref = self._shm_write(f'{name}/depth_rgb', rgb_jpeg)
            if ref is not None:
                refs['rgb'] = ref
            else:
                item['rgb'] = rgb_jpeg
        if refs:
            item['shm'] = refs
        self._append_log(item)

    def log_video_segment(self, name, segment_info, init_file, base_url):
        self._append_log({
            'type': 'video_segment',
            'name': name,
            'segment': segment_info,
            'init_file': init_file,
            'base_url': base_url
        })

    @staticmethod
    def md_image(image, alt='', fmt='jpg', quality=85, max_width=None):
        """Markdown for an inline image, for log_md: ``![alt](data:image/...;base64,...)``.

        `image`: a numpy array (BGR as OpenCV uses, or grayscale) -- encoded as
        `fmt` ('jpg' / 'png'), optionally downscaled to `max_width` pixels --
        or already encoded bytes (PNG / JPEG). The image counts against the
        viewer's 512 kB text budget per session, so prefer JPEG and a
        modest size (a 640x360 JPEG is ~30-60 kB of base64)."""
        import base64
        if isinstance(image, (bytes, bytearray)):
            data = bytes(image)
            mime = 'png' if data[:8] == b'\x89PNG\r\n\x1a\n' else 'jpeg'
        else:
            import cv2
            img = np.asarray(image)
            if max_width is not None and img.shape[1] > max_width:
                h = int(round(img.shape[0] * max_width / img.shape[1]))
                img = cv2.resize(img, (int(max_width), h), interpolation=cv2.INTER_AREA)
            ext = '.png' if fmt == 'png' else '.jpg'
            params = [cv2.IMWRITE_JPEG_QUALITY, int(quality)] if ext == '.jpg' else []
            ok, buf = cv2.imencode(ext, img, params)
            if not ok:
                raise ValueError('image encoding failed')
            data, mime = buf.tobytes(), ('png' if ext == '.png' else 'jpeg')
        b64 = base64.b64encode(data).decode('ascii')
        return f'![{alt}](data:image/{mime};base64,{b64})'

    def log_md(self, time_s, markdown):
        """Log a text message, rendered as markdown in the viewer's "m" panel
        (add it to the panel layout, e.g. ``(t/m)|img``). Each message shows as
        a bubble with its time (and the label of any marker logged at the same
        time); moving the time cursor highlights the last message at or before
        it. Inline images: ``Logger.md_image(img)`` gives the markdown. The viewer keeps up to 512 kB of text per
        session and drops the oldest messages beyond that."""
        self._append_log({
            'type': 'md',
            'time': time_s,
            'text': str(markdown),
        })

    # -- recordings (run by the server process, see recorder.RecordingManager) --

    RECORDER_RPC_ENDPOINT = 'ipc:///tmp/mim_recorder_rpc'

    def _recorder_rpc(self, op, timeout_ms=2000, **args):
        import zmq
        sock = zmq.Context.instance().socket(zmq.REQ)
        sock.setsockopt(zmq.LINGER, 0)
        sock.connect(self.RECORDER_RPC_ENDPOINT)
        try:
            sock.send(ormsgpack.packb({'op': op, 'args': args}))
            if not sock.poll(timeout_ms):
                raise TimeoutError('no reply from the mim_data_utils server '
                                   '(is serve.sh running, with recording support?)')
            reply = ormsgpack.unpackb(sock.recv())
        finally:
            sock.close()
        if not reply.get('ok'):
            raise RuntimeError(f"recording {op} failed: {reply.get('error')}")
        return reply

    def record(self, duration=None, snapshot=False, average=None, encode_video=None,
               embed_video=False, with_timeseries=True, max_size_mb=500,
               compression_level=10, out_dir=None, template=None):
        """Start a recording of everything the server streams (all sessions,
        like record.sh); returns its filename prefix (``<prefix>.zst``,
        ``<prefix>_begin_<camera>.png``, ``<prefix>_<camera>.mp4``, ...).

        The recording runs in the server process (serve.sh): this only sends a
        request and returns right away. Several recordings may run at once.

        Args:
            duration: seconds (or '0.5s' / '100ms'); stops by itself after it.
                None: until stop_recording(prefix).
            snapshot: no _end frames; without a duration, 1 s.
            average: True / 'mean' / 'median': the _begin images combine every
                frame of the duration (static scene); needs a duration.
            encode_video: True, or record.sh's options as a string / list
                ('480x360 15fps cq32 denoise kf5'): H.265 .mp4 per camera.
            embed_video, with_timeseries, max_size_mb, compression_level: as
                record.sh's --with-embed-video, --without-timeseries,
                --max-size, --compression-level.
            out_dir: folder (default: the server's recordings folder,
                $MIM_RECORDINGS_DIR set by serve.sh).
            template: file name, '{timestamp}' filled in (default
                'mim_{timestamp}.zst').
        """
        if out_dir is not None:
            out_dir = os.path.abspath(out_dir)       # the server has its own cwd
        if template is not None and os.path.dirname(template):
            template = os.path.abspath(template)
        prefix = self._recorder_rpc(
            'record', duration=duration, snapshot=snapshot, average=average,
            encode_video=encode_video, embed_video=embed_video,
            with_timeseries=with_timeseries, max_size_mb=max_size_mb,
            compression_level=compression_level, out_dir=out_dir,
            template=template)['prefix']
        self._own_recordings.append(prefix)
        return prefix

    def stop_recording(self, prefix=None, delete=False):
        """End recording `prefix` (None: every active one); with `delete`, its
        files are removed once finalised (also after it ended by itself). The
        files are finalised in the background; see wait_recording()."""
        return self._recorder_rpc('stop', prefix=prefix, delete=delete)['stopped']

    def wait_recording(self, prefix, timeout=None, poll_s=0.05):
        """Block until `prefix` is finalised (files complete). False on timeout."""
        t_end = None if timeout is None else time.time() + timeout
        while True:
            st = self._recorder_rpc('status')
            if prefix not in st['active'] and prefix not in st['finalizing']:
                return True
            if t_end is not None and time.time() > t_end:
                return False
            time.sleep(poll_s)

    @sync
    def wait_finished_gen(self, timeout=None, poll_s=0.05):
        """Yield until every recording started from this logger is finished
        (files complete); returns their prefixes. ``wait_finished()`` is the
        blocking version. In a generator on the control loop, use
        ``yield from logger.wait_finished_gen()``: the server is asked only
        every `poll_s` (one local request, ~1 ms), otherwise it just yields.
        Raises TimeoutError after `timeout` seconds."""
        t_end = None if timeout is None else time.time() + timeout
        mine = list(self._own_recordings)
        next_poll = 0.0
        while True:
            now = time.time()
            if now >= next_poll:
                next_poll = now + poll_s
                st = self._recorder_rpc('status')
                busy = set(st['active']) | set(st['finalizing'])
                if not busy.intersection(mine):
                    self._own_recordings = [p for p in self._own_recordings if p not in mine]
                    return mine
            if t_end is not None and now > t_end:
                raise TimeoutError(f'recordings still running after {timeout} s: '
                                   f'{sorted(busy.intersection(mine))}')
            yield True

    def recordings(self):
        """Prefixes of the recordings currently taking data."""
        return self._recorder_rpc('status')['active']

    def log_marker(self, time_s, label, show_summary=False):
        self._append_log({
            'type': 'marker',
            'time': time_s,
            'label': str(label),
            'show_summary': bool(show_summary),
        })
