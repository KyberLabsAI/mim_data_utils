"""Snapshot the current camera images for the recorder.

Two sources, mirroring the old ``capture_frame.sh``:
  * shared memory — every ``/dev/shm/kyb_*`` camera segment (color + depth), read
    with ``kyber_utils``' dtype-aware ``SharedImageReader`` so depth is captured
    correctly (the old script hardcoded uint8 and garbled it);
  * websocket — the latest JPEG per camera on the mim data stream.

``recorder.py`` calls :func:`capture_frames` to store ``_begin`` / ``_end`` frames
next to each ``.zst`` recording. With ``average`` ('mean' or 'median') every new
frame of the next ``duration`` seconds is combined per pixel into one noise-reduced
image (static scene; ``record.sh --snapshot 1s --average``). Every heavy dependency (kyber_utils, opencv,
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


def combine_frames(frames, method='mean', depth=False):
    """Per-pixel combination of frames of a static scene: 'mean' (noise / sqrt(N)) or
    'median' (robust to outliers). Depth: median of the valid (non-zero) samples."""
    import numpy as np
    stack = np.stack(frames)
    if depth:
        import warnings
        valid = np.where(stack > 0, stack.astype(np.float32), np.nan)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', RuntimeWarning)  # all-NaN pixels -> 0 below
            med = np.nanmedian(valid, axis=0)
        return np.nan_to_num(med, nan=0).round().astype(stack.dtype)
    if method == 'median':
        return np.median(stack, axis=0).round().astype(stack.dtype)
    return (stack.astype(np.float32).mean(axis=0) + 0.5).astype(stack.dtype)


def _read_shm_frames(names, duration):
    """Read every new frame (by frame_counter) of the given segments for `duration` s.
    Returns {name: (frames, last_meta)}."""
    from kyber_utils.shared_image_buffer import SharedImageReader
    readers = {}
    for name in names:
        reader = SharedImageReader('')
        reader.shm_name = name
        readers[name] = reader
    out = {name: ([], None, None) for name in names}   # frames, meta, last counter
    deadline = time.monotonic() + duration
    try:
        while True:
            for name, reader in readers.items():
                try:
                    res = reader.read()
                except Exception:
                    res = None
                if res is None:
                    continue
                frame, meta = res
                frames, _, last = out[name]
                if meta.get('frame_counter') == last:
                    continue
                frames.append(frame.copy())
                out[name] = (frames, meta, meta.get('frame_counter'))
            if time.monotonic() >= deadline:
                break
            time.sleep(0.003)
    finally:
        for reader in readers.values():
            try:
                reader._detach()
            except Exception:
                pass
    return {name: (frames, meta) for name, (frames, meta, _) in out.items()}


def capture_shm(prefix, out_dir, average=None, duration=0.0):
    """Snapshot every ``/dev/shm/kyb_*`` segment (color + depth). With `average`,
    combine all new frames of the next `duration` s (see combine_frames). Returns
    saved paths."""
    saved = []
    try:
        import cv2
        import numpy as np
        from kyber_utils.shared_image_buffer import SharedImageReader
    except Exception as e:
        print(f'[capture] shm capture unavailable ({e})')
        return saved

    names = [os.path.basename(p) for p in sorted(glob.glob('/dev/shm/kyb_*'))]
    averaged = {}
    if average and names:
        try:
            averaged = _read_shm_frames(names, duration)
        except Exception as e:
            print(f'[capture] averaging read failed ({e}); falling back to single frames')

    for name in names:
        if name in averaged and averaged[name][0]:
            frames, meta = averaged[name]
            res = (frames, meta)
        else:
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
            res = ([res[0]], res[1])

        frames, meta = res
        cam = _camera_name_from_calib(meta.get('calibration_path', ''), name)
        enc = meta.get('encoding', '')
        is_depth = (enc in ('depth16', 'mono16', '16uc1')
                    or getattr(frames[0], 'dtype', None) == np.uint16)
        frame = (combine_frames(frames, average, depth=is_depth) if len(frames) > 1
                 else frames[0])
        note = f' ({average} of {len(frames)} frames)' if len(frames) > 1 else ''
        if average and len(frames) == 1:
            note = ' (only 1 frame arrived -- not averaged)'
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
                print(f'[capture] {out}{note}')
            else:
                print(f'[capture] failed to write {out}')
        except Exception as e:
            print(f'[capture] failed to write {out} ({e})')
    return saved


def capture_ws(prefix, out_dir, host, port, duration=0.2, average=None):
    """Snapshot the latest JPEG per camera from the mim websocket. With `average`,
    decode every JPEG of the `duration` window and combine them per camera into a
    lossless PNG (see combine_frames). Returns saved paths."""
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
    collected = {}   # average: camera -> [jpeg payloads]
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
                if average:
                    collected.setdefault(safe, []).append(bytes(payload))
                    continue
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

    for safe, payloads in collected.items():
        try:
            import cv2
            import numpy as np
            frames = [cv2.imdecode(np.frombuffer(p, np.uint8), cv2.IMREAD_UNCHANGED) for p in payloads]
            frames = [f for f in frames if f is not None]
            shapes = {f.shape for f in frames}
            if not frames or len(shapes) != 1:
                print(f'[capture] {safe}: no consistent frames to average')
                continue
            out = os.path.join(out_dir, f'{prefix}_{safe}.png')
            if cv2.imwrite(out, combine_frames(frames, average)):
                saved.append(out)
                print(f'[capture] {out} ({average} of {len(frames)} frames)')
        except Exception as e:
            print(f'[capture] {safe}: averaging failed ({e})')
    return saved


def capture_frames(prefix, out_dir, host='127.0.0.1', port=5678, ws_duration=0.2,
                   average=None, duration=None):
    """Snapshot both shared-memory (color+depth) and websocket-JPEG images.

    With `average` ('mean' / 'median'), both sources are read in parallel for
    `duration` seconds and every new frame is combined into one image per camera.
    Never raises; returns the list of saved file paths."""
    os.makedirs(out_dir, exist_ok=True)
    saved = []
    if average:
        import threading
        results = {}

        def run(key, fn, *a):
            try:
                results[key] = fn(*a)
            except Exception as e:
                print(f'[capture] {key} capture error: {e}')
                results[key] = []

        threads = [threading.Thread(target=run, args=('shm', capture_shm, prefix, out_dir, average, duration)),
                   threading.Thread(target=run, args=('websocket', capture_ws, prefix, out_dir, host, port,
                                                      duration, average))]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        saved = results.get('shm', []) + results.get('websocket', [])
        if not saved:
            print('[capture] no images captured.')
        return saved
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
