import os
import threading
import traceback
import time
import ormsgpack

from SimpleWebSocketServer import SimpleWebSocketServer, WebSocket
from kyber_utils.zeromq import (
    ZmqBroker,
    ZmqSubscriber,
    ZmqRemoteKeyValueServer,
)

class SessionTracker:
    """Live-session bookkeeping: which sessions exist and when each last saw data.

    At most `MAX_SESSIONS` sessions are alive at a time. Registering one more
    evicts the session whose *data* is stalest (oldest last-received sample),
    not the one registered longest ago. Any message on a session's topic
    (re-)registers it, so a session only stays evicted if its producer went
    quiet.
    """

    MAX_SESSIONS = 4

    def __init__(self):
        self.sessions = {}  # name -> wall time of last received data
        self._lock = threading.Lock()
        # Called with (evicted_names) after membership changed; set by run().
        # Invoked outside the lock.
        self.on_change = None

    def touch(self, name):
        """Mark data received for `name`, registering it if unknown.

        Returns the list of evicted session names (empty if none).
        """
        added = False
        evicted = []
        with self._lock:
            if name in self.sessions:
                self.sessions[name] = time.time()
            else:
                while len(self.sessions) >= self.MAX_SESSIONS:
                    oldest = min(self.sessions, key=lambda n: self.sessions[n])
                    del self.sessions[oldest]
                    evicted.append(oldest)
                self.sessions[name] = time.time()
                added = True

        if (added or evicted) and self.on_change:
            self.on_change(evicted)

        return evicted

    def is_live(self, name):
        with self._lock:
            return name in self.sessions

    def snapshot(self):
        """{name: last_data_time} of all live sessions."""
        with self._lock:
            return dict(self.sessions)


class SetupRegistry:
    """Per-session store of the setups a viewer needs to render the stream.

    Producers register their 3d scene objects and viewer settings once (see
    `Logger.register_setup` / `Logger.register_setting`). Keeping them here is
    what lets a viewer that connects late -- or simply reloads the page -- get
    the meshes and point clouds it would otherwise have missed.

    Entries are keyed, so re-registering replaces the previous version. They
    live until explicitly removed or until the session is cleared: a producer
    disconnecting does not unload its scene, just as the timeseries and images
    it already sent stay in the viewer.
    """

    def __init__(self):
        # session -> {'setting': {key: item}, 'scene': {key: item}}. Settings
        # are replayed before scene objects (they create the viewers/layout the
        # objects go into) and insertion order is kept within each kind.
        self.sessions = {}
        self._lock = threading.Lock()

    def _kinds(self, session):
        return self.sessions.setdefault(
            session, {'setting': {}, 'scene': {}})

    def apply(self, item):
        """Fold one setup item into the registry.

        Returns the items to forward to the viewers that are already connected
        (empty if nothing changed).
        """
        op = item.get('op')
        session = item.get('session')

        with self._lock:
            if op == 'clear':
                self.sessions.pop(session, None)
                return [item]

            kinds = self._kinds(session)
            store = kinds.get(item.get('kind'))
            if store is None:
                print(f"[setup] ignoring unknown kind: {item.get('kind')}")
                return []

            key = item.get('key')
            if op == 'remove':
                return [item] if store.pop(key, None) is not None else []

            if op == 'set':
                # Re-registering the exact same setting (a producer restarting,
                # say) must not be re-applied -- '3dCamera' would add a second
                # 3d viewer every time.
                if store.get(key) == item:
                    return []
                store[key] = item
                return [item]

            print(f"[setup] ignoring unknown op: {op}")
            return []

    def clear_session(self, session):
        """Drop all cached setups of `session` (launch restart / eviction)."""
        with self._lock:
            self.sessions.pop(session, None)

    def snapshot(self, session):
        """All setups of `session`, packed and ready to send to a new viewer."""
        items = self.snapshot_items(session)
        if not items:
            return None

        return ormsgpack.packb(items)

    def snapshot_items(self, session):
        """All setups of `session` as a plain item list (may be empty)."""
        with self._lock:
            kinds = self.sessions.get(session)
            if not kinds:
                return []

            return list(kinds['setting'].values()) + list(kinds['scene'].values())


class WebsocketHandler(WebSocket):
    ws_server = None  # set as class attribute by BinaryWebSocketServer

    def handleMessage(self):
        if isinstance(self.data, bytes):
            print("Received binary data:", self.data)
        else:
            print("Received text:", self.data)

    def handleConnected(self):
        print(f"Client connected: {self.address}")
        if self.ws_server:
            # Replay the registered setups *before* joining the broadcast set,
            # so no live data can overtake the setup it depends on.
            self.ws_server.send_setups(self)
            self.ws_server.clients.add(self)

    def handleClose(self):
        print(f"Client disconnected: {self.address}")
        if self.ws_server:
            self.ws_server.clients.discard(self)


class BinaryWebSocketServer(threading.Thread):
    def __init__(self, handler_cls, host='0.0.0.0', port=9001,
                 pointcloud_backlog=10, video_backlog=30, ts_backlog=400,
                 setup_registry=None, session_tracker=None):
        super().__init__(daemon=True)  # run as daemon thread
        self.host = host
        self.port = port
        self.clients = set()
        self._server = None
        self.handler_cls = handler_cls
        handler_cls.ws_server = self
        # Registered setups replayed to every client on connect, for every
        # session the tracker reports live.
        self.setup_registry = setup_registry
        self.session_tracker = session_tracker
        # Prioritized backpressure. A viewer that can't keep up otherwise grows an
        # unbounded SimpleWebSocketServer sendq, so it keeps receiving old data and
        # its lag grows without bound. We cap each client's queue depth, but at
        # three levels against the same (shared) queue so lower-value data is shed
        # first:
        #   - point clouds drop once the queue passes `pointcloud_backlog` (lowest;
        #     heaviest payload, so shed first),
        #   - camera/video frames drop past `video_backlog` (low),
        #   - timeseries frames drop only past `ts_backlog` (high).
        # So under mild overload only point clouds are dropped; if that isn't
        # enough, camera video thins out too; timeseries plots are protected until
        # last. Each bounds the lag and lets the client self-heal once it drains.
        # (deque len/append are atomic, so no lock is needed here.)
        self.pointcloud_backlog = pointcloud_backlog
        self.video_backlog = video_backlog
        self.ts_backlog = ts_backlog
        # Per-priority send caps, keyed by the `priority` passed to broadcast().
        self._caps = {
            'pointcloud': pointcloud_backlog,
            'camera': video_backlog,
            'timeseries': ts_backlog,
        }
        self._dropped = {}          # client -> {priority: n}
        self._last_drop_log = 0.0

    @property
    def num_clients(self):
        return len(self.clients)

    def run(self):
        """Start the WebSocket server."""
        self._server = SimpleWebSocketServer(self.host, self.port, self.handler_cls, selectInterval=0.01)
        print(f"Websocket server running on ws://{self.host}:{self.port}")
        self._server.serveforever()

    def sessions_message(self):
        """The live-session list as a packed viewer control message."""
        sessions = self.session_tracker.snapshot() if self.session_tracker else {}
        return ormsgpack.packb([{
            'type': 'sessions',
            'sessions': [
                {'name': name, 'last_data': last_data}
                for name, last_data in sorted(sessions.items())
            ],
        }])

    def broadcast_sessions(self):
        """Push the current live-session list to all connected viewers."""
        self.broadcast(self.sessions_message(), priority='timeseries')

    def send_setups(self, client):
        """Send the session list and every live session's setups to a
        just-connected client."""
        try:
            client.sendMessage(self.sessions_message())

            if self.setup_registry is None or self.session_tracker is None:
                return

            for name in self.session_tracker.snapshot():
                snapshot = self.setup_registry.snapshot(name)
                if snapshot is None:
                    continue
                client.sendMessage(snapshot)
                print(f"[setup] replayed '{name}' setups to "
                      f"{getattr(client, 'address', client)}")
        except Exception:
            traceback.print_exc()

    def broadcast(self, data: bytes, priority='timeseries'):
        """Send binary data to all clients, dropping for slow ones by priority.

        priority='pointcloud' -> lowest: dropped once the client's queue passes
                                 pointcloud_backlog (heaviest payload, shed first).
        priority='camera'     -> low: dropped once the client's queue passes
                                 video_backlog (video is shed next).
        priority='timeseries' -> high: dropped only past ts_backlog (protected;
                                 thins out only when dropping the rest isn't enough).
        """
        cap = self._caps.get(priority, self.ts_backlog)
        for client in list(self.clients):  # list() to avoid set change during iteration
            try:
                if len(client.sendq) >= cap:
                    # Client is behind at this priority level; drop to let it catch up.
                    counts = self._dropped.setdefault(client, {})
                    counts[priority] = counts.get(priority, 0) + 1
                    continue
                client.sendMessage(data)
            except Exception as e:
                print("Failed to send to client:", e)
                self.clients.discard(client)  # remove dead client
                self._dropped.pop(client, None)
        self._log_drops()

    def _log_drops(self):
        """Print, at most every 2 s, which clients are behind and what's dropped."""
        now = time.time()
        if now - self._last_drop_log < 2.0:
            return
        self._last_drop_log = now
        parts = [
            f"{getattr(c, 'address', c)} backlog={len(c.sendq)} "
            f"pc_dropped={d.get('pointcloud', 0)} "
            f"video_dropped={d.get('camera', 0)} ts_dropped={d.get('timeseries', 0)}"
            for c, d in self._dropped.items() if any(d.values())
        ]
        if parts:
            print("[ws-backlog] slow client(s): " + " | ".join(parts))
            self._dropped.clear()


class WebsocketHandlerPubSub(WebsocketHandler):
    value_server = None  # set as class attribute before use

    def handleConnected(self):
        try:
            super().handleConnected()
            self.value_server.set('websocket_num_clients', self.ws_server.num_clients)
        except Exception:
            traceback.print_exc()

    def handleClose(self):
        try:
            super().handleClose()
            self.value_server.set('websocket_num_clients', self.ws_server.num_clients)
        except Exception:
            traceback.print_exc()


def run():
    # Start the ZeroMQ broker.
    broker = ZmqBroker()
    broker.start()

    while not broker.is_running:
        time.sleep(0.01)

    value_server = ZmqRemoteKeyValueServer({
        'websocket_num_clients': 0,
    })

    # Shared Zmq value to keep track of connected websockets.
    WebsocketHandlerPubSub.value_server = value_server

    setup_registry = SetupRegistry()
    session_tracker = SessionTracker()

    websocket = BinaryWebSocketServer(
        WebsocketHandlerPubSub, host='127.0.0.1', port=5678,
        setup_registry=setup_registry,
        session_tracker=session_tracker)

    def on_sessions_change(evicted):
        # An evicted session's cached setups go with it; its data already in
        # the viewers stays (the viewer greys the session out).
        for name in evicted:
            setup_registry.clear_session(name)
            print(f"[session] evicted: {name}")
        websocket.broadcast_sessions()

    session_tracker.on_change = on_sessions_change

    websocket.start()
    time.sleep(0.1)  # Give the thread time to print

    from http_server import StaticFileServer
    _pkg_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    static_server = StaticFileServer(directory=_pkg_root, port=8000)
    static_server.start()

    def topic_session(topic):
        """'/camera/<session>' (bytes) -> '<session>'; None if malformed."""
        parts = topic.decode('utf-8', 'replace').split('/', 2)
        return parts[2] if len(parts) == 3 and parts[2] else None

    _camera_debug_count = [0]
    _camera_debug_frame_count = [0]
    _camera_debug_last_print = [time.time()]

    def on_camera(topic, data):
        session = topic_session(topic)
        if session is None:
            return
        session_tracker.touch(session)

        now = time.time()
        _camera_debug_count[0] += 1
        # Count individual image items inside the batch
        try:
            items = ormsgpack.unpackb(data)
            n_imgs = sum(1 for item in items if item.get(b'type') == b'image' or item.get('type') == 'image')
            _camera_debug_frame_count[0] += n_imgs
        except Exception:
            pass
        # Print camera relay stats every 2 seconds
        elapsed = now - _camera_debug_last_print[0]
        if elapsed >= 2.0:
            msg_rate = _camera_debug_count[0] / elapsed
            frame_rate = _camera_debug_frame_count[0] / elapsed
            print(f"[camera-relay] {_camera_debug_count[0]} msgs ({msg_rate:.1f}/s), "
                  f"{_camera_debug_frame_count[0]} frames ({frame_rate:.1f} fps), "
                  f"payload={len(data)} bytes, clients={websocket.num_clients}")
            _camera_debug_count[0] = 0
            _camera_debug_frame_count[0] = 0
            _camera_debug_last_print[0] = now
        websocket.broadcast(data, priority='camera')

    def on_pointcloud(topic, data):
        session = topic_session(topic)
        if session is None:
            return
        session_tracker.touch(session)

        # Point clouds are the heaviest payload; broadcast at the lowest
        # priority so a slow viewer sheds them before camera video.
        websocket.broadcast(data, priority='pointcloud')

    def on_setup(topic, data):
        # Setup items are rare and small enough to unpack here: the registry
        # needs to see them so it can replay them to viewers connecting later.
        try:
            items = ormsgpack.unpackb(data)
        except Exception:
            traceback.print_exc()
            return

        changed = []
        for item in items:
            if item.get('op') == 'launch':
                # A producer (re)starting this session: register it (evicting
                # the stalest live session if we're at capacity), drop its
                # cached setups, and forward the launch so viewers clear the
                # session's data and switch to it.
                name = item.get('session') or 'Default'
                setup_registry.clear_session(name)
                session_tracker.touch(name)
                print(f"[session] launched: {name}")
                changed.append(item)
            else:
                changed.extend(setup_registry.apply(item))

        # Forward what actually changed, so viewers that are already open pick
        # up new registrations live.
        if changed:
            websocket.broadcast(ormsgpack.packb(changed), priority='timeseries')

    def on_timeseries(topic, data):
        session = topic_session(topic)
        if session is None:
            return
        session_tracker.touch(session)
        websocket.broadcast(data, priority='timeseries')

    sub_camera = ZmqSubscriber('/camera/', callback=on_camera)
    sub_pointcloud = ZmqSubscriber('/pointcloud/', callback=on_pointcloud)
    sub_timeseries = ZmqSubscriber('/timeseries/', callback=on_timeseries)
    sub_setup = ZmqSubscriber('/setup/', callback=on_setup)

    print("Publishing timeseries (Ctrl+C to stop)...")
    try:
        while True:
            time.sleep(1.)
    except KeyboardInterrupt:
        print("\nStopped.")
        sub_camera.close()
        sub_pointcloud.close()
        sub_timeseries.close()
        sub_setup.close()


if __name__ == "__main__":
    run()
