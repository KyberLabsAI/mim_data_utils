import os
import threading
import traceback
import time
import ormsgpack

from SimpleWebSocketServer import SimpleWebSocketServer, WebSocket
from kyber_utils.zeromq import (
    ZmqBroker,
    ZmqPublisher,
    ZmqSubscriber,
    ZmqRemoteKeyValueServer,
    ZmqRemoteValue,
)

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
            self.ws_server.clients.add(self)

    def handleClose(self):
        print(f"Client disconnected: {self.address}")
        if self.ws_server:
            self.ws_server.clients.discard(self)


class BinaryWebSocketServer(threading.Thread):
    def __init__(self, handler_cls, host='0.0.0.0', port=9001,
                 pointcloud_backlog=10, video_backlog=30, ts_backlog=400):
        super().__init__(daemon=True)  # run as daemon thread
        self.host = host
        self.port = port
        self.clients = set()
        self._server = None
        self.handler_cls = handler_cls
        handler_cls.ws_server = self
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

    def on_value_update(key, value):
        if key == 'active_session':
            print(f"Active session set to: {value}")

    value_server = ZmqRemoteKeyValueServer({
        'websocket_num_clients': 0,
        # Sessions are disabled for now (see logger._generate_session_name):
        # all loggers use the fixed 'FooBarSession', so default the filter to
        # it — timeseries flow even if no producer ever activates a session.
        'active_session': 'FooBarSession'
    }, on_update=on_value_update)

    # Shared Zmq value to keep track of connected websockets.
    WebsocketHandlerPubSub.value_server = value_server

    websocket = BinaryWebSocketServer(WebsocketHandlerPubSub, host='127.0.0.1', port=5678)
    websocket.start()
    time.sleep(0.1)  # Give the thread time to print

    from http_server import StaticFileServer
    _pkg_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    static_server = StaticFileServer(directory=_pkg_root, port=8000)
    static_server.start()

    _camera_debug_count = [0]
    _camera_debug_frame_count = [0]
    _camera_debug_last_print = [time.time()]

    def on_camera(topic, data):
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
        # Point clouds are the heaviest payload; broadcast at the lowest
        # priority so a slow viewer sheds them before camera video.
        websocket.broadcast(data, priority='pointcloud')

    def on_timeseries(topic, data):
        active_session = value_server.get('active_session')
        if active_session and topic == f'/timeseries/{active_session}'.encode():
            websocket.broadcast(data, priority='timeseries')

    sub_camera = ZmqSubscriber('/camera/', callback=on_camera)
    sub_pointcloud = ZmqSubscriber('/pointcloud/', callback=on_pointcloud)
    sub_timeseries = ZmqSubscriber('/timeseries/', callback=on_timeseries)

    print("Publishing timeseries (Ctrl+C to stop)...")
    try:
        while True:
            time.sleep(1.)
    except KeyboardInterrupt:
        print("\nStopped.")
        sub_camera.close()
        sub_pointcloud.close()
        sub_timeseries.close()


if __name__ == "__main__":
    run()
