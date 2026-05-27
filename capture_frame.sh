#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RECORDINGS_DIR="$SCRIPT_DIR/captured"
mkdir -p "$RECORDINGS_DIR"

HOST="${MIM_HOST:-127.0.0.1}"
PORT="${MIM_PORT:-5678}"
DURATION="${CAPTURE_DURATION:-1.0}"

STAMP="$(date +%Y%m%d_%H%M%S)"

RECORDINGS_DIR="$RECORDINGS_DIR" STAMP="$STAMP" HOST="$HOST" PORT="$PORT" \
    DURATION="$DURATION" python3 - "$@" <<'PY'
import glob
import os
import struct
import sys
import time
from multiprocessing import shared_memory

import cv2
import numpy as np
import ormsgpack
import websocket

recordings_dir = os.environ['RECORDINGS_DIR']
stamp = os.environ['STAMP']
host = os.environ['HOST']
port = int(os.environ['PORT'])
duration = float(os.environ['DURATION'])

saved = {}

# --- Shared-memory raw frames -----------------------------------------------
# SharedImageWriter (kyber_hand_tracker.shared_image_buffer) creates segments
# named /dev/shm/kyb_<md5>. Header layout is mirrored here so this script does
# not need to import the ROS package.
HEADER_SIZE = 320
HEADER_STRUCT = struct.Struct('<QQqIIII')
ENCODING_OFFSET = 40
ENCODING_MAX_LEN = 16
CALIB_PATH_LEN_OFFSET = 56
CALIB_PATH_OFFSET = 64
CALIB_PATH_MAX_LEN = 256


def read_shm_frame(name, max_retries=20):
    try:
        shm = shared_memory.SharedMemory(name=name, create=False)
    except FileNotFoundError:
        return None
    try:
        # Don't let resource_tracker shm_unlink() the writer's segment on exit.
        try:
            from multiprocessing.resource_tracker import unregister
            unregister(f'/{name}', 'shared_memory')
        except Exception:
            pass

        for _ in range(max_retries):
            buf = shm.buf
            seq1 = struct.unpack_from('<Q', buf, 0)[0]
            if seq1 == 0 or seq1 % 2 != 0:
                time.sleep(0.001)
                continue
            _, frame_counter, timestamp_ns, h, w, c, enc_len = \
                HEADER_STRUCT.unpack_from(buf, 0)
            enc_len = min(enc_len, ENCODING_MAX_LEN)
            encoding = bytes(
                buf[ENCODING_OFFSET:ENCODING_OFFSET + enc_len]).decode(
                'utf-8', 'replace')
            calib_len = struct.unpack_from('<I', buf, CALIB_PATH_LEN_OFFSET)[0]
            calib_len = min(calib_len, CALIB_PATH_MAX_LEN)
            calibration_path = bytes(
                buf[CALIB_PATH_OFFSET:CALIB_PATH_OFFSET + calib_len]).decode(
                'utf-8', 'replace')
            data_len = h * w * c
            data = bytes(buf[HEADER_SIZE:HEADER_SIZE + data_len])
            seq2 = struct.unpack_from('<Q', buf, 0)[0]
            if seq2 != seq1:
                time.sleep(0.001)
                continue
            shape = (h, w, c) if c > 1 else (h, w)
            frame = np.frombuffer(data, dtype=np.uint8).reshape(shape).copy()
            return frame, encoding, calibration_path, frame_counter
        return None
    finally:
        shm.close()


for shm_path in sorted(glob.glob('/dev/shm/kyb_*')):
    shm_name = os.path.basename(shm_path)
    result = read_shm_frame(shm_name)
    if result is None:
        print(f'[capture_frame] shm {shm_name}: no fresh frame', file=sys.stderr)
        continue
    frame, encoding, _, _ = result
    if frame.ndim == 3 and frame.shape[2] == 3 and encoding == 'rgb8':
        out = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
    else:
        out = frame
    out_path = os.path.join(
        recordings_dir, f'frame_{stamp}_{shm_name}.png')
    if cv2.imwrite(out_path, out):
        saved[shm_name] = out_path
        print(f'[capture_frame] {out_path}')
    else:
        print(f'[capture_frame] failed to write {out_path}', file=sys.stderr)

# --- WebSocket-published JPEG frames ----------------------------------------
url = f'ws://{host}:{port}/'
try:
    ws = websocket.create_connection(url, timeout=2.0)
except Exception as e:
    print(f'[capture_frame] WebSocket connect failed ({e}); '
          f'shared-memory only', file=sys.stderr)
    ws = None

if ws is not None:
    seen_ws = {}
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
                if safe_name in seen_ws:
                    continue
                out_path = os.path.join(
                    recordings_dir, f'frame_{stamp}_{safe_name}.jpg')
                with open(out_path, 'wb') as f:
                    f.write(payload)
                seen_ws[safe_name] = out_path
                saved[safe_name] = out_path
                print(f'[capture_frame] {out_path}')
    finally:
        ws.close()

if not saved:
    print('[capture_frame] No images received.', file=sys.stderr)
    sys.exit(1)

print(f'[capture_frame] Saved {len(saved)} frame(s).')
PY
