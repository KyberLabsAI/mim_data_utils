"""Snapshot the current camera images for the recorder.

Two sources, mirroring the old ``capture_frame.sh``:
  * shared memory — every ``/dev/shm/kyb_*`` camera segment (color + depth), read
    with ``kyber_utils``' dtype-aware ``SharedImageReader`` so depth is captured
    correctly (the old script hardcoded uint8 and garbled it);
  * websocket — the latest JPEG per camera on the mim data stream, plus one image
    per image overlay (Logger.log_overlay): frame + that overlay, and the
    overlay alone.

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


def _field(item, key):
    v = item.get(key.encode(), item.get(key))
    return v.decode('utf-8', 'replace') if isinstance(v, bytes) and key in ('type', 'name', 'overlay') else v


def _frame_key(number, t):
    """Key matching an image frame with its overlays (see js/overlay_store.js)."""
    return ('n', int(number)) if number is not None else ('t', t)


def _overlay_names(cam_overlays, keys=None):
    """Overlay names in {frame key: {name: overlay}}, of `keys` only if given."""
    keys = cam_overlays.keys() if keys is None else [k for k in keys if k in cam_overlays]
    return {name for k in keys for name in cam_overlays[k]}


def _full_overlay(overlay, size):
    """A rendered overlay (PNG cropped at `offset`) as a full-size BGRA image."""
    import cv2
    import numpy as np
    w, h = size
    full = np.zeros((h, w, 4), np.uint8)
    if not overlay['payload']:
        return full
    crop = cv2.imdecode(np.frombuffer(overlay['payload'], np.uint8), cv2.IMREAD_UNCHANGED)
    if crop is None:
        return full
    if crop.ndim == 2 or crop.shape[2] == 3:
        crop = cv2.cvtColor(crop, cv2.COLOR_GRAY2BGRA if crop.ndim == 2 else cv2.COLOR_BGR2BGRA)
    x, y = (int(v) for v in (overlay['offset'] or (0, 0)))
    x1, y1 = min(w, x + crop.shape[1]), min(h, y + crop.shape[0])
    if x1 > x and y1 > y:
        full[y:y1, x:x1] = crop[:y1 - y, :x1 - x]
    return full


def _composite(img, overlays_bgra):
    """Alpha-blend full-size BGRA overlays (in order) onto a BGR/gray image."""
    import cv2
    import numpy as np
    out = img if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    out = out.astype(np.float32)
    for ov in overlays_bgra:
        a = ov[..., 3:4].astype(np.float32) / 255.0
        out = out * (1.0 - a) + ov[..., :3].astype(np.float32) * a
    return (out + 0.5).astype(np.uint8)


def _write_overlay_image(prefix, out_dir, safe, name, img, overlay):
    """The overlay image `name` of camera `safe`, as in the viewer: the frame
    with that overlay drawn over it (``_overlay_<name>.png``), plus the overlay
    alone, full size and transparent (``_overlay_<name>_alpha.png``)."""
    import cv2
    saved = []
    h, w = img.shape[:2]
    ov = _full_overlay(overlay, (w, h))
    stem = os.path.join(out_dir, f'{prefix}_{safe}_overlay_{_safe(name)}')
    for out, data in ((f'{stem}.png', _composite(img, [ov])), (f'{stem}_alpha.png', ov)):
        if cv2.imwrite(out, data):
            saved.append(out)
            print(f'[capture] {out}')
    return saved


def capture_ws(prefix, out_dir, host, port, duration=0.2, average=None,
               overlay_wait=0.6):
    """Snapshot the latest JPEG per camera from the mim websocket. With `average`,
    decode every JPEG of the `duration` window and combine them per camera into a
    lossless PNG (see combine_frames). Returns saved paths.

    Each image overlay (Logger.log_overlay) of a camera is saved as an image of
    its own, like in the viewer: the frame with that overlay drawn over it
    (``_overlay_<name>.png``) and the overlay alone (``_overlay_<name>_alpha.png``,
    full size, transparent). Overlays arrive after their image and not every
    frame has one (e.g. AprilTags at the detector rate), so capture listens up
    to `overlay_wait` s longer until every overlay seen has a frame, and uses
    the first frame (with `average`: the last) that has that overlay, over the
    averaged image with `average`."""
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

    frames = {}      # camera -> [(key, payload, in_window)] in arrival order
    overlays = {}    # camera -> {key: {overlay name: {payload, offset}}}
    statics = {}     # camera -> {overlay name: {payload, offset}}, the newest static overlay
    t_start = time.monotonic()
    deadline = t_start + duration
    try:
        while True:
            now = time.monotonic()
            if now >= deadline:
                # Extend the window while an overlay seen has no frame yet.
                pending = [c for c in overlays
                           if _overlay_names(overlays[c]) - _overlay_names(
                               overlays[c], [f[0] for f in frames.get(c, [])])]
                if not pending or now >= t_start + duration + overlay_wait:
                    break
                deadline = min(now + 0.05, t_start + duration + overlay_wait)
            ws.settimeout(max(1e-3, deadline - time.monotonic()))
            try:
                message = ws.recv()
            except Exception:
                if time.monotonic() >= t_start + duration + overlay_wait:
                    break
                continue
            if not isinstance(message, (bytes, bytearray)):
                continue
            try:
                items = ormsgpack.unpackb(bytes(message))
            except Exception:
                continue
            if not isinstance(items, list):
                continue
            in_window = time.monotonic() < t_start + duration
            for item in items:
                if not isinstance(item, dict):
                    continue
                kind = _field(item, 'type')
                iname = _field(item, 'name')
                if iname is None:
                    continue
                safe = _safe(iname)
                key = _frame_key(_field(item, 'number'), _field(item, 'time'))
                if kind == 'image':
                    payload = _field(item, 'payload')
                    if payload is None:
                        continue
                    # After the window only keep collecting frames that may
                    # still get overlays; without averaging the first
                    # frame is enough for cameras without overlays.
                    if not average and not in_window and safe not in overlays:
                        continue
                    frames.setdefault(safe, []).append((key, bytes(payload), in_window))
                elif kind == 'image_overlay' and _field(item, 'static'):
                    # On every frame; the server replays the current ones on
                    # connect, so they never extend the wait.
                    statics.setdefault(safe, {})[_field(item, 'overlay') or 'overlay'] = {
                        'payload': _field(item, 'payload'),
                        'offset': _field(item, 'offset')}
                elif kind == 'image_overlay':
                    overlays.setdefault(safe, {}).setdefault(key, {})[
                        _field(item, 'overlay') or 'overlay'] = {
                            'payload': _field(item, 'payload'),
                            'offset': _field(item, 'offset')}
    finally:
        try:
            ws.close()
        except Exception:
            pass

    import cv2
    import numpy as np

    for safe, cam_frames in frames.items():
        if not cam_frames:
            continue
        payload = cam_frames[0][1]
        img = None
        # Averaging uses the window's frames, not those that came in while
        # waiting for overlays.
        window_frames = [f for f in cam_frames if f[2]] or cam_frames[:1]
        if average:
            try:
                decoded = [cv2.imdecode(np.frombuffer(p, np.uint8), cv2.IMREAD_UNCHANGED)
                           for _, p, _ in window_frames]
                decoded = [f for f in decoded if f is not None]
                shapes = {f.shape for f in decoded}
                if not decoded or len(shapes) != 1:
                    print(f'[capture] {safe}: no consistent frames to average')
                    continue
                img = combine_frames(decoded, average)
                out = os.path.join(out_dir, f'{prefix}_{safe}.png')
                if cv2.imwrite(out, img):
                    saved.append(out)
                    print(f'[capture] {out} ({average} of {len(decoded)} frames)')
            except Exception as e:
                print(f'[capture] {safe}: averaging failed ({e})')
                continue
        else:
            out = os.path.join(out_dir, f'{prefix}_{safe}.jpg')
            try:
                with open(out, 'wb') as f:
                    f.write(payload)
                saved.append(out)
                print(f'[capture] {out}')
            except Exception as e:
                print(f'[capture] failed to write {out} ({e})')
                continue

        cam_ovs = overlays.get(safe, {})
        for name in sorted(_overlay_names(cam_ovs)):
            with_ov = [(k, p) for k, p, _ in cam_frames if name in cam_ovs.get(k, {})]
            if not with_ov:
                print(f'[capture] {safe}: no frame with overlay {name!r} arrived '
                      f'within {overlay_wait} s')
                continue
            key, frame_payload = with_ov[-1] if average else with_ov[0]
            try:
                base = img if average else cv2.imdecode(
                    np.frombuffer(frame_payload, np.uint8), cv2.IMREAD_UNCHANGED)
                saved += _write_overlay_image(prefix, out_dir, safe, name, base,
                                              cam_ovs[key][name])
            except Exception as e:
                print(f'[capture] {safe}: overlay {name!r} export failed ({e})')

        # Static overlays apply to every frame: drawn over the saved image.
        for name, ov in sorted(statics.get(safe, {}).items()):
            if name in _overlay_names(cam_ovs):
                continue
            try:
                base = img if average else cv2.imdecode(
                    np.frombuffer(payload, np.uint8), cv2.IMREAD_UNCHANGED)
                saved += _write_overlay_image(prefix, out_dir, safe, name, base, ov)
            except Exception as e:
                print(f'[capture] {safe}: static overlay {name!r} export failed ({e})')
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
