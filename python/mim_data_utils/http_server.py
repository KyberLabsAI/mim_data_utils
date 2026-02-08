import os
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler


class RangeHTTPRequestHandler(SimpleHTTPRequestHandler):
    """HTTP handler that supports Range requests and CORS headers."""

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def guess_type(self, path):
        if path.endswith('.mp4'):
            return 'video/mp4'
        if path.endswith('.json'):
            return 'application/json'
        return super().guess_type(path)

    def do_GET(self):
        path = self.translate_path(self.path)

        if not os.path.isfile(path):
            return super().do_GET()

        file_size = os.path.getsize(path)
        range_header = self.headers.get('Range')

        if range_header is None:
            return super().do_GET()

        # Parse Range: bytes=N-M
        try:
            range_spec = range_header.strip().replace('bytes=', '')
            parts = range_spec.split('-')
            start = int(parts[0]) if parts[0] else 0
            end = int(parts[1]) if parts[1] else file_size - 1
        except (ValueError, IndexError):
            self.send_error(416, 'Invalid Range')
            return

        if start >= file_size or end >= file_size or start > end:
            self.send_error(416, 'Range Not Satisfiable')
            return

        content_length = end - start + 1
        content_type = self.guess_type(path)

        self.send_response(206)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(content_length))
        self.send_header('Content-Range', f'bytes {start}-{end}/{file_size}')
        self.end_headers()

        with open(path, 'rb') as f:
            f.seek(start)
            self.wfile.write(f.read(content_length))

    def log_message(self, format, *args):
        pass  # Silence request logging


class StaticFileServer(threading.Thread):
    """Threaded HTTP server that serves static files from a directory."""

    def __init__(self, directory='.', host='0.0.0.0', port=8000):
        super().__init__(daemon=True)
        self.directory = os.path.abspath(directory)
        self.host = host
        self.port = port
        self._server = None

    def run(self):
        handler = lambda *args, **kwargs: RangeHTTPRequestHandler(
            *args, directory=self.directory, **kwargs
        )
        self._server = HTTPServer((self.host, self.port), handler)
        print(f"Static file server running on http://{self.host}:{self.port} (serving {self.directory})")
        self._server.serve_forever()
