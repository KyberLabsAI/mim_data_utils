import threading
import traceback
import time
import struct

import zmq
import ormsgpack
from SimpleWebSocketServer import SimpleWebSocketServer, WebSocket

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


class ZmqBroker(threading.Thread):
    """ZeroMQ XSUB/XPUB broker that forwards messages from publishers to subscribers."""

    def __init__(self, pub_endpoint="ipc:///tmp/zmq_broker_pub", sub_endpoint="ipc:///tmp/zmq_broker_sub"):
        super().__init__(daemon=True)
        self.pub_endpoint = pub_endpoint
        self.sub_endpoint = sub_endpoint
        self.is_running = False

    def run(self):
        context = zmq.Context()
        xsub = context.socket(zmq.XSUB)
        xsub.bind(self.pub_endpoint)

        xpub = context.socket(zmq.XPUB)
        xpub.bind(self.sub_endpoint)

        print(f"ZMQ broker: publishers->{self.pub_endpoint}  subscribers->{self.sub_endpoint}")
        self.is_running = True
        zmq.proxy(xsub, xpub)


class ZmqPublisher:
    """Publishes binary data on a named topic via the ZeroMQ broker."""

    def __init__(self, topic: str, endpoint="ipc:///tmp/zmq_broker_pub"):
        self.topic = topic.encode() if isinstance(topic, str) else topic
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.PUB)
        self.socket.connect(endpoint)

    def send(self, data: bytes):
        self.socket.send_multipart([self.topic, data])

    def close(self):
        self.socket.close()
        self.context.term()


class ZmqSubscriber(threading.Thread):
    """Subscribes to a named topic via the ZeroMQ broker and optionally calls a callback on each message."""

    def __init__(self, topic: str, callback=None, endpoint="ipc:///tmp/zmq_broker_sub"):
        super().__init__(daemon=True)
        self.topic = topic.encode() if isinstance(topic, str) else topic
        self.callback = callback
        self.context = zmq.Context()
        self.socket = self.context.socket(zmq.SUB)
        self.socket.connect(endpoint)
        self.socket.setsockopt(zmq.SUBSCRIBE, self.topic)
        self._running = False

        if callback is not None:
            self.start()

    def recv(self):
        """Receive a single message (blocking)."""
        topic, data = self.socket.recv_multipart()
        return topic, data

    def run(self):
        """Start the subscriber loop. Calls callback on each message."""
        if self.callback is None:
            return
        
        self._running = True
        try:
            while self._running:
                self.callback(*self.recv())
        except zmq.error.ContextTerminated:
            pass

    def close(self):
        """Stop the subscriber and clean up."""
        self._running = False
        self.socket.close()
        self.context.term()


class ZmqRemoteValueServer(threading.Thread):
    """REP server that stores values and handles get/set requests by name."""

    def __init__(self, initial_values=None, endpoint="ipc:///tmp/zmq_remote_values"):
        super().__init__(daemon=True)
        self.endpoint = endpoint
        self._values = {} if initial_values is None else initial_values
        self._lock = threading.Lock()
        self.start()

    def get(self, name):
        with self._lock:
            return self._values.get(name)

    def set(self, name, value):
        with self._lock:
            self._values[name] = value

    def run(self):
        context = zmq.Context()
        socket = context.socket(zmq.REP)
        socket.bind(self.endpoint)
        while True:
            parts = socket.recv_multipart()
            action = parts[0].decode('utf-8')
            name = parts[1].decode('utf-8')

            with self._lock:
                if action == 'get':
                    value = self._values.get(name)
                    socket.send(ormsgpack.packb(value, option=ormsgpack.OPT_SERIALIZE_NUMPY))
                elif action == 'set':
                    self._values[name] = ormsgpack.unpackb(parts[2])
                    socket.send(b'ok')
                else:
                    socket.send(ormsgpack.packb(None))


class ZmqRemoteValue:
    """REQ client that gets/sets a named value on a ZmqRemoteValueServer."""

    def __init__(self, name: str, endpoint="ipc:///tmp/zmq_remote_values", timeout_ms=1000):
        self.name = name
        self.endpoint = endpoint
        self.timeout_ms = timeout_ms
        self.context = zmq.Context()

    def _request(self, *frames):
        socket = self.context.socket(zmq.REQ)
        socket.setsockopt(zmq.LINGER, 0)
        socket.connect(self.endpoint)
        try:
            socket.send_multipart(frames)
            if socket.poll(self.timeout_ms):
                return socket.recv()
            else:
                raise TimeoutError(f"No response for '{self.name}'")
        finally:
            socket.close()

    def get(self):
        response = self._request(b'get', self.name.encode('utf-8'))
        return ormsgpack.unpackb(response)

    def set(self, value):
        data = ormsgpack.packb(value, option=ormsgpack.OPT_SERIALIZE_NUMPY)
        self._request(b'set', self.name.encode('utf-8'), data)


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


if __name__ == "__main__":
    import math

    # Start the ZeroMQ broker.
    broker = ZmqBroker()
    broker.start()

    while not broker.is_running:
        time.sleep(0.01)

    value_server = ZmqRemoteValueServer({
        'websocket_num_clients': 0
    })

    # Shared Zmq value to keep track of connected websockets.
    WebsocketHandlerPubSub.value_server = value_server

    websocket = BinaryWebSocketServer(WebsocketHandlerPubSub, host='127.0.0.1', port=5678)
    websocket.start()
    time.sleep(0.1)  # Give the thread time to print

    # Broadcast the timeseries data to all the websocket clients.
    def on_message(topic, data):
        websocket.broadcast(data)

    sub = ZmqSubscriber('/timeseries/', callback=on_message)
    
    print("Publishing timeseries (Ctrl+C to stop)...")
    try:
        while True:
            time.sleep(1.)
    except KeyboardInterrupt:
        print("\nStopped.")
        sub.close()
