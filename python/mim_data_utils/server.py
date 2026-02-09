import os
import threading
import traceback
import time

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
    def __init__(self, handler_cls, host='0.0.0.0', port=9001):
        super().__init__(daemon=True)  # run as daemon thread
        self.host = host
        self.port = port
        self.clients = set()
        self._server = None
        self.handler_cls = handler_cls
        handler_cls.ws_server = self

    @property
    def num_clients(self):
        return len(self.clients)

    def run(self):
        """Start the WebSocket server."""
        self._server = SimpleWebSocketServer(self.host, self.port, self.handler_cls, selectInterval=0.01)
        print(f"Websocket server running on ws://{self.host}:{self.port}")
        self._server.serveforever()

    def broadcast(self, data: bytes):
        """Send binary data to all connected clients."""
        for client in list(self.clients):  # list() to avoid set change during iteration
            try:
                client.sendMessage(data)
            except Exception as e:
                print("Failed to send to client:", e)
                self.clients.discard(client)  # remove dead client


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
        'active_session': None
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

    def on_camera(topic, data):
        websocket.broadcast(data)

    def on_timeseries(topic, data):
        active_session = value_server.get('active_session')
        if active_session and topic == f'/timeseries/{active_session}'.encode():
            websocket.broadcast(data)

    sub_camera = ZmqSubscriber('/camera/', callback=on_camera)
    sub_timeseries = ZmqSubscriber('/timeseries/', callback=on_timeseries)

    print("Publishing timeseries (Ctrl+C to stop)...")
    try:
        while True:
            time.sleep(1.)
    except KeyboardInterrupt:
        print("\nStopped.")
        sub_camera.close()
        sub_timeseries.close()


if __name__ == "__main__":
    run()
