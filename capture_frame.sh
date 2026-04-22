#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RECORDINGS_DIR="$WS_ROOT/recordings"
mkdir -p "$RECORDINGS_DIR"

HOST="${MIM_HOST:-127.0.0.1}"
PORT="${MIM_PORT:-5678}"
DURATION="${CAPTURE_DURATION:-1.0}"

STAMP="$(date +%Y%m%d_%H%M%S)"

RECORDINGS_DIR="$RECORDINGS_DIR" STAMP="$STAMP" HOST="$HOST" PORT="$PORT" \
    DURATION="$DURATION" python3 - "$@" <<'PY'
import os
import sys
import time
import ormsgpack
import websocket

recordings_dir = os.environ['RECORDINGS_DIR']
stamp = os.environ['STAMP']
host = os.environ['HOST']
port = int(os.environ['PORT'])
duration = float(os.environ['DURATION'])

url = f'ws://{host}:{port}/'
ws = websocket.create_connection(url, timeout=2.0)

seen = {}
deadline = time.monotonic() + duration

try:
    while time.monotonic() < deadline:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        ws.settimeout(remaining)
        try:
            message = ws.recv()
        except websocket.WebSocketTimeoutException:
            break
        if not isinstance(message, (bytes, bytearray)):
            continue
        try:
            items = ormsgpack.unpackb(bytes(message))
        except Exception:
            continue
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            itype = item.get(b'type', item.get('type'))
            if itype not in (b'image', 'image'):
                continue
            name = item.get(b'name', item.get('name'))
            payload = item.get(b'payload', item.get('payload'))
            if name is None or payload is None:
                continue
            if isinstance(name, bytes):
                name = name.decode('utf-8', 'replace')
            safe_name = ''.join(c if c.isalnum() or c in '-_.' else '_'
                                for c in name)
            if safe_name in seen:
                continue
            out_path = os.path.join(
                recordings_dir, f'frame_{stamp}_{safe_name}.jpg')
            with open(out_path, 'wb') as f:
                f.write(payload)
            seen[safe_name] = out_path
            print(f'[capture_frame] {out_path}')
finally:
    ws.close()

if not seen:
    print('[capture_frame] No images received.', file=sys.stderr)
    sys.exit(1)

print(f'[capture_frame] Saved {len(seen)} frame(s).')
PY
