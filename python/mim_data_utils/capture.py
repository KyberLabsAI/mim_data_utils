"""Snapshot the current camera images for the recorder.

Two sources, mirroring the old ``capture_frame.sh``:
  * shared memory — every ``/dev/shm/kyb_*`` camera segment (color + depth), read
    with ``kyber_utils``' dtype-aware ``SharedImageReader`` so depth is captured
    correctly (the old script hardcoded uint8 and garbled it);
  * websocket — the latest JPEG per camera on the mim data stream.

``recorder.py`` calls :func:`capture_frames` to store ``_begin`` / ``_end`` frames
next to each ``.zst`` recording. Every heavy dependency (kyber_utils, opencv,
ormsgpack, websocket) is imported lazily so the recorder's plain ``.zst`` recording
still works if any of them is missing — capture just logs a warning and is skipped.
"""
import glob
import os
import time


def _camera_name_from_calib(calib_path, fallback):
    """Readable camera name from a calibration file path (drop dir, extension and a
    leading ``camera_``); fall back to ``fallback`` when unavailable."""
    if not calib_path:
        return fallback
    name = os.path.splitext(os.path.basename(calib_path))[0]
    if name.startswith('camera_'):
        name = name[len('camera_'):]
    return name or fallback


def _safe(name):
    return ''.join(c if c.isalnum() or c in '-_.' else '_' for c in str(name))


def capture_shm(prefix, out_dir):
    """Snapshot every ``/dev/shm/kyb_*`` segment (color + depth). Returns saved paths."""
    saved = []
    try:
        import cv2
        import numpy as np
        from kyber_utils.shared_image_buffer import SharedImageReader
    except Exception as e:
        print(f'[capture] shm capture unavailable ({e})')
        return saved

    for shm_path in sorted(glob.glob('/dev/shm/kyb_*')):
        name = os.path.basename(shm_path)
        try:
            # SharedImageReader is keyed by topic, but only uses .shm_name to
            # attach; point it directly at the discovered segment.
            reader = SharedImageReader('')
            reader.shm_name = name
            res = reader.read()
            reader._detach()
        except Exception as e:
            print(f'[capture] {name}: read failed ({e})')
            continue
        if res is None:
            print(f'[capture] {name}: no fresh frame')
            continue

        frame, meta = res
        cam = _camera_name_from_calib(meta.get('calibration_path', ''), name)
        enc = meta.get('encoding', '')
        is_depth = (enc in ('depth16', 'mono16', '16uc1')
                    or getattr(frame, 'dtype', None) == np.uint16)
        if is_depth:
            out = os.path.join(out_dir, f'{prefix}_{cam}_depth.png')   # 16-bit PNG
            img = frame
        else:
            out = os.path.join(out_dir, f'{prefix}_{cam}.png')
            img = (cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                   if enc == 'rgb8' and frame.ndim == 3 else frame)
        try:
            if cv2.imwrite(out, img):
                saved.append(out)
                print(f'[capture] {out}')
            else:
                print(f'[capture] failed to write {out}')
        except Exception as e:
            print(f'[capture] failed to write {out} ({e})')
    return saved


def capture_ws(prefix, out_dir, host, port, duration=0.2):
    """Snapshot the latest JPEG per camera from the mim websocket. Returns saved paths."""
    saved = []
    try:
        import ormsgpack
        import websocket
    except Exception as e:
        print(f'[capture] websocket capture unavailable ({e})')
        return saved

    try:
        ws = websocket.create_connection(f'ws://{host}:{port}/', timeout=2.0)
    except Exception as e:
        print(f'[capture] websocket connect failed ({e})')
        return saved

    seen = set()
    deadline = time.monotonic() + duration
    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            ws.settimeout(remaining)
            try:
                message = ws.recv()
            except Exception:
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
                if item.get(b'type', item.get('type')) not in (b'image', 'image'):
                    continue
                iname = item.get(b'name', item.get('name'))
                payload = item.get(b'payload', item.get('payload'))
                if iname is None or payload is None:
                    continue
                if isinstance(iname, bytes):
                    iname = iname.decode('utf-8', 'replace')
                safe = _safe(iname)
                if safe in seen:
                    continue
                out = os.path.join(out_dir, f'{prefix}_{safe}.jpg')
                try:
                    with open(out, 'wb') as f:
                        f.write(payload)
                    seen.add(safe)
                    saved.append(out)
                    print(f'[capture] {out}')
                except Exception as e:
                    print(f'[capture] failed to write {out} ({e})')
    finally:
        try:
            ws.close()
        except Exception:
            pass
    return saved


def capture_frames(prefix, out_dir, host='127.0.0.1', port=5678, ws_duration=0.2):
    """Snapshot both shared-memory (color+depth) and websocket-JPEG images.

    Never raises; returns the list of saved file paths."""
    os.makedirs(out_dir, exist_ok=True)
    saved = []
    try:
        saved += capture_shm(prefix, out_dir)
    except Exception as e:
        print(f'[capture] shm capture error: {e}')
    try:
        saved += capture_ws(prefix, out_dir, host, port, ws_duration)
    except Exception as e:
        print(f'[capture] websocket capture error: {e}')
    if not saved:
        print('[capture] no images captured.')
    return saved
