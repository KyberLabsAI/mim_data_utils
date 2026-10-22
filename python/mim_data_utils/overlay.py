"""Image overlays: vector debug drawings logged against an image frame.

Producers build an `Overlay` (text, rectangles, lines, circles) and log it with
`Logger.log_overlay(time, img_topic, img_number, overlay_name, overlay)`. The
server hands it to a separate render process (`OverlayRenderer`), which renders
it with `render_overlay` into a transparent PNG cropped to the drawn area; the
server sends that to the viewer, which composites it over the image frame with
the same number.

Coordinates are image pixels (floats are fine), colors RGB or RGBA 0-255.

Static overlays (``log_overlay(..., static=True)``) belong to no frame: the
viewer draws the newest one of an overlay name over every frame of its image
source. The server renders and relays each version once (`StaticOverlayCache`
drops unchanged repeats) and replays the current ones to viewers and
recordings that start later.
"""

import io
import struct

import numpy as np

# Item types, as stored in Overlay.items (plain dicts so they msgpack).
TEXT, RECT, LINES, CIRCLE = 'text', 'rect', 'lines', 'circle'


def _color(c):
    """RGBA int tuple (alpha 255 if not given); plain ints so items msgpack."""
    if c is None:
        return None
    c = tuple(int(v) for v in c)
    return c if len(c) == 4 else c + (255,)


class Overlay:
    """Chainable builder for overlay primitives.

    ``width`` is the stroke width in pixels; ``fill`` an optional fill color.
    ``width=0`` with a ``fill`` gives a filled shape without outline.
    """

    def __init__(self, items=None):
        self.items = list(items) if items is not None else []

    def __len__(self):
        return len(self.items)

    def text(self, x, y, text, color=(255, 255, 255), size=13, bg=None, anchor='ls'):
        """Single line of text. ``anchor`` is a PIL text anchor; the default
        'ls' puts (x, y) at the left end of the baseline, like cv2.putText."""
        self.items.append({'type': TEXT, 'pos': [float(x), float(y)], 'text': str(text),
                           'color': _color(color), 'size': int(size), 'bg': _color(bg), 'anchor': anchor})
        return self

    def rect(self, x0, y0, x1, y1, color=(255, 255, 255), width=2, fill=None):
        self.items.append({'type': RECT, 'box': [float(x0), float(y0), float(x1), float(y1)],
                           'color': _color(color), 'width': int(width), 'fill': _color(fill)})
        return self

    def lines(self, points, color=(255, 255, 255), width=2, closed=False, fill=None):
        """Line strip through ``points`` ((N, 2)); ``closed`` joins the last point
        to the first, ``fill`` (closed only) fills the polygon."""
        pts = np.asarray(points, dtype=float).reshape(-1, 2).tolist()
        self.items.append({'type': LINES, 'points': pts, 'color': _color(color),
                           'width': int(width), 'closed': bool(closed), 'fill': _color(fill)})
        return self

    def line(self, p0, p1, color=(255, 255, 255), width=2):
        return self.lines([p0, p1], color=color, width=width)

    def circle(self, cx, cy, r, color=(255, 255, 255), width=2, fill=None):
        self.items.append({'type': CIRCLE, 'center': [float(cx), float(cy)], 'r': float(r),
                           'color': _color(color), 'width': int(width), 'fill': _color(fill)})
        return self


def overlay_items(overlay):
    """Plain item list from an Overlay or an iterable of item dicts."""
    if overlay is None:
        return []
    if isinstance(overlay, Overlay):
        return overlay.items
    return list(overlay)


try:
    import skia         # antialiased, sub-pixel vector rendering
except ImportError:     # fall back to PIL + supersampling
    skia = None

_fonts = {}


def _font(size):
    """PIL font (fallback renderer)."""
    font = _fonts.get(size)
    if font is None:
        from PIL import ImageFont
        font = _fonts[size] = ImageFont.load_default(size)
    return font


_sk_fonts = {}


def _sk_font(size):
    font = _sk_fonts.get(size)
    if font is None:
        font = _sk_fonts[size] = skia.Font(skia.Typeface('DejaVu Sans'), float(size))
        font.setEdging(skia.Font.Edging.kAntiAlias)
        font.setSubpixel(True)
    return font


def _sk_text_box(item):
    """Text box (x0, y0, x1, y1) in image pixels for a PIL-style two-letter
    anchor: horizontal l/m/r, vertical a(scender)/t(op)/m(iddle)/s(baseline)/
    b(ottom)/d(escender). Returns (box, baseline origin)."""
    font = _sk_font(item.get('size', 13))
    m = font.getMetrics()
    width = font.measureText(item['text'])
    asc, desc = -m.fAscent, m.fDescent          # both positive
    h_anchor, v_anchor = (item.get('anchor') or 'ls')[:2]
    x, y = item['pos']
    ox = x - {'l': 0.0, 'm': width / 2, 'r': width}.get(h_anchor, 0.0)
    oy = y + {'a': asc, 't': asc, 'm': (asc - desc) / 2, 's': 0.0, 'b': -desc, 'd': -desc}.get(v_anchor, 0.0)
    return (ox, oy - asc, ox + width, oy + desc), (ox, oy)


def _item_bbox(item):
    """(x0, y0, x1, y1) a primitive can touch, or None for an empty one."""
    kind = item.get('type')
    pad = item.get('width', 0) / 2 + 1
    if kind == TEXT:
        if skia is not None:
            (x0, y0, x1, y1), _ = _sk_text_box(item)
            return x0 - 3, y0 - 3, x1 + 3, y1 + 3
        x, y = item['pos']
        b = _font(item.get('size', 13)).getbbox(item['text'], anchor=item.get('anchor', 'ls'))
        return x + b[0] - 2, y + b[1] - 2, x + b[2] + 2, y + b[3] + 2
    if kind == RECT:
        x0, y0, x1, y1 = item['box']
        return min(x0, x1) - pad, min(y0, y1) - pad, max(x0, x1) + pad, max(y0, y1) + pad
    if kind == LINES:
        pts = np.asarray(item['points'], dtype=float).reshape(-1, 2)
        if len(pts) == 0:
            return None
        lo, hi = pts.min(axis=0), pts.max(axis=0)
        return lo[0] - pad, lo[1] - pad, hi[0] + pad, hi[1] + pad
    if kind == CIRCLE:
        (cx, cy), r = item['center'], item['r'] + pad
        return cx - r, cy - r, cx + r, cy + r
    return None


def _crop_box(items, size):
    """Integer pixel box (x0, y0, x1, y1) covering all items, clipped to the
    image, or None when nothing is visible."""
    w, h = int(size[0]), int(size[1])
    boxes = [b for b in (_item_bbox(it) for it in items) if b is not None]
    if not boxes:
        return None
    b = np.array(boxes)
    x0 = max(0, int(np.floor(b[:, 0].min())))
    y0 = max(0, int(np.floor(b[:, 1].min())))
    x1 = min(w, int(np.ceil(b[:, 2].max())))
    y1 = min(h, int(np.ceil(b[:, 3].max())))
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def render_overlay(items, size):
    """Render overlay items for an image of ``size`` = (w, h).

    Returns ``(png_bytes, (x, y))``: a transparent RGBA PNG covering only the
    drawn area (clipped to the image) and its top-left offset in the image.
    Returns ``(None, (0, 0))`` when nothing is visible.

    Antialiased at sub-pixel positions (skia; without it, PIL with
    supersampling). Coordinates follow the image (OpenCV) convention: pixel
    i's centre at i.
    """
    box = _crop_box(items, size)
    if box is None:
        return None, (0, 0)
    if skia is None:
        return _render_pil(items, box), box[:2]
    return _render_skia(items, box), box[:2]


def _sk_paint(color, stroke_width=None):
    r, g, b, a = color
    paint = skia.Paint(AntiAlias=True, Color=skia.Color(r, g, b, a))
    if stroke_width is not None:
        paint.setStyle(skia.Paint.kStroke_Style)
        paint.setStrokeWidth(float(stroke_width))
        paint.setStrokeJoin(skia.Paint.kRound_Join)
        paint.setStrokeCap(skia.Paint.kRound_Cap)
    return paint


def _render_skia(items, box):
    x0, y0, x1, y1 = box
    surface = skia.Surface(x1 - x0, y1 - y0)       # N32 premultiplied, transparent
    canvas = surface.getCanvas()
    canvas.clear(skia.ColorTRANSPARENT)
    # Image pixel i's centre is at i; skia's is at i + 0.5.
    canvas.translate(0.5 - x0, 0.5 - y0)

    for it in items:
        kind = it.get('type')
        color, fill = _color(it.get('color')), _color(it.get('fill'))
        width = float(it.get('width', 0))
        if kind == TEXT:
            (bx0, by0, bx1, by1), (ox, oy) = _sk_text_box(it)
            if it.get('bg') is not None:
                canvas.drawRect(skia.Rect.MakeLTRB(bx0 - 2, by0 - 2, bx1 + 2, by1 + 2), _sk_paint(_color(it['bg'])))
            canvas.drawString(it['text'], ox, oy, _sk_font(it.get('size', 13)), _sk_paint(color))
        elif kind == RECT:
            ax0, ay0, ax1, ay1 = it['box']
            rect = skia.Rect.MakeLTRB(min(ax0, ax1), min(ay0, ay1), max(ax0, ax1), max(ay0, ay1))
            if fill is not None:
                canvas.drawRect(rect, _sk_paint(fill))
            if width > 0:
                canvas.drawRect(rect, _sk_paint(color, width))
        elif kind == LINES:
            pts = np.asarray(it['points'], dtype=float).reshape(-1, 2)
            if len(pts) < 2:
                continue
            path = skia.Path()
            path.moveTo(*pts[0])
            for p in pts[1:]:
                path.lineTo(*p)
            if it.get('closed'):
                path.close()
                if fill is not None:
                    canvas.drawPath(path, _sk_paint(fill))
            if width > 0:
                canvas.drawPath(path, _sk_paint(color, width))
        elif kind == CIRCLE:
            (cx, cy), r = it['center'], float(it['r'])
            if fill is not None:
                canvas.drawCircle(cx, cy, r, _sk_paint(fill))
            if width > 0:
                canvas.drawCircle(cx, cy, r, _sk_paint(color, width))

    data = surface.makeImageSnapshot().encodeToData(skia.kPNG, 100)
    return bytes(data)


SUPERSAMPLE = 4        # PIL fallback: render at this many times the resolution, then average down


def _render_pil(items, box, supersample=SUPERSAMPLE):
    from PIL import Image, ImageDraw

    x0, y0, x1, y1 = box
    ss = max(1, int(supersample))
    img = Image.new('RGBA', ((x1 - x0) * ss, (y1 - y0) * ss), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img, 'RGBA')
    # image pixel centre i -> centre of its ss x ss block in the big image
    X = lambda x: (x - x0 + 0.5) * ss - 0.5
    Y = lambda y: (y - y0 + 0.5) * ss - 0.5
    shift = lambda pts: [(X(p[0]), Y(p[1])) for p in pts]
    lw = lambda width: max(1, int(round(width * ss))) if width > 0 else 0

    for it in items:
        kind = it.get('type')
        color, fill = _color(it.get('color')), _color(it.get('fill'))
        width = lw(it.get('width', 0))
        outline = color if width > 0 else None
        if kind == TEXT:
            x, y = X(it['pos'][0]), Y(it['pos'][1])
            font, anchor = _font(it.get('size', 13) * ss), it.get('anchor', 'ls')
            if it.get('bg') is not None:
                tb = draw.textbbox((x, y), it['text'], font=font, anchor=anchor)
                pad = 2 * ss
                draw.rectangle((tb[0] - pad, tb[1] - pad, tb[2] + pad, tb[3] + pad), fill=_color(it['bg']))
            draw.text((x, y), it['text'], fill=color, font=font, anchor=anchor)
        elif kind == RECT:
            bx0, by0, bx1, by1 = it['box']
            draw.rectangle((X(min(bx0, bx1)), Y(min(by0, by1)), X(max(bx0, bx1)), Y(max(by0, by1))),
                           outline=outline, fill=fill, width=width)
        elif kind == LINES:
            pts = shift(it['points'])
            if len(pts) < 2:
                continue
            if it.get('closed'):
                if fill is not None:
                    draw.polygon(pts, fill=fill)
                pts = pts + pts[:1]
            if width > 0:
                draw.line(pts, fill=color, width=width, joint='curve')
        elif kind == CIRCLE:
            (cx, cy), r = it['center'], it['r'] * ss
            draw.ellipse((X(cx) - r, Y(cy) - r, X(cx) + r, Y(cy) + r),
                         outline=outline, fill=fill, width=width)

    if ss > 1:
        # Pillow premultiplies alpha when resizing RGBA, so edges keep their colour.
        img = img.resize((x1 - x0, y1 - y0), Image.Resampling.BOX)
    buf = io.BytesIO()
    img.save(buf, format='PNG', compress_level=1)
    return buf.getvalue()


_JPEG_SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def image_size(data):
    """(width, height) from a JPEG or PNG header, or None if not recognized.
    Reads only the header, no decode."""
    try:
        data = memoryview(data)
        if bytes(data[:8]) == b'\x89PNG\r\n\x1a\n':
            return tuple(struct.unpack('>II', data[16:24]))
        if bytes(data[:2]) != b'\xff\xd8':
            return None
        i, n = 2, len(data)
        while i + 4 <= n:
            if data[i] != 0xFF:
                return None
            marker = data[i + 1]
            if marker == 0xFF:  # fill byte
                i += 1
                continue
            if marker in (0x01, 0xD8) or 0xD0 <= marker <= 0xD7:  # no length
                i += 2
                continue
            if marker in _JPEG_SOF:
                h, w = struct.unpack('>HH', data[i + 5:i + 9])
                return (w, h)
            if marker in (0xD9, 0xDA):  # EOI / start of scan before any SOF
                return None
            i += 2 + struct.unpack('>H', data[i + 2:i + 4])[0]
    except Exception:
        pass
    return None


def _isolate_worker(avoid_cpus, niceness):
    """Render process: run on the CPUs the server is NOT pinned to (serve.sh
    pins it with taskset, which a child would inherit) and at a lower
    priority, so rendering competes neither with the relaying nor with the
    control loops on the machine."""
    import os
    try:
        cpus = set(range(os.cpu_count() or 1)) - set(avoid_cpus or ())
        if cpus:
            os.sched_setaffinity(0, cpus)
    except (AttributeError, OSError):
        pass
    if niceness:
        try:
            os.nice(int(niceness))
        except (AttributeError, OSError):
            pass


def _item_ref(it):
    """The identifying fields of an overlay item (for drop reports)."""
    return {k: it.get(k) for k in ('session', 'name', 'overlay', 'static')}


def _render_worker(in_q, out_q, wait_size_s, avoid_cpus, niceness):
    """Body of the overlay render process (see OverlayRenderer).

    Reads ``('size', (session, name), (w, h))`` and ``('render', item)``
    messages from ``in_q``; writes ``('rendered', image_overlay_item,
    render_s)`` and ``('dropped', 1, item_ref)`` to ``out_q``. ``None`` stops it."""
    import queue
    import time

    _isolate_worker(avoid_cpus, niceness)

    sizes = {}                  # (session, name) -> (w, h)
    pending = []                # (t_received, item) waiting for a size
    warned = set()

    def size_for(it):
        if it.get('size'):
            return it['size']
        return sizes.get((it.get('session'), it.get('name')))

    while True:
        # Block for the next message; with overlays waiting for a size, wake
        # up regularly to expire them.
        try:
            msgs = [in_q.get(timeout=0.1 if pending else None)]
        except queue.Empty:
            msgs = []
        # Take everything queued, so size updates in the batch apply before
        # the overlays rendered from it.
        while True:
            try:
                msgs.append(in_q.get_nowait())
            except queue.Empty:
                break

        now = time.monotonic()
        batch = []
        for msg in msgs:
            if msg is None:
                out_q.put(None)
                return
            if msg[0] == 'size':
                sizes[msg[1]] = msg[2]
            elif msg[0] == 'render':
                batch.append((now, msg[1]))

        waiting, pending = pending, []
        for t_recv, it in waiting + batch:
            size = size_for(it)
            if size is None:
                if now - t_recv < wait_size_s:
                    pending.append((t_recv, it))
                else:
                    out_q.put(('dropped', 1, _item_ref(it)))
                    key = (it.get('session'), it.get('name'))
                    if key not in warned:
                        warned.add(key)
                        print(f"[overlay] no image size known for {key}; "
                              f"dropping overlays (pass size= to log_overlay)", flush=True)
                continue
            try:
                tic = time.perf_counter()
                png, offset = render_overlay(it.get('items') or [], size)
                render_s = time.perf_counter() - tic
                out_q.put(('rendered', {
                    'type': 'image_overlay',
                    'time': it.get('time'),
                    'name': it.get('name'),
                    'number': it.get('number'),
                    'overlay': it.get('overlay'),
                    'session': it.get('session'),
                    'size': list(size),
                    'offset': list(offset),
                    'payload': png,
                    'static': bool(it.get('static')),
                }, render_s))
            except Exception as e:
                out_q.put(('dropped', 1, _item_ref(it)))
                print(f"[overlay] render failed for {it.get('name')}/{it.get('overlay')}: {e}",
                      flush=True)


class OverlayRenderer:
    """Server-side overlay rendering in a separate Python process, so it
    shares neither the GIL nor the server's CPU core with the relaying.

    ``submit(items)`` queues logged overlay items as render instructions for
    the render process (a bounded queue of ``max_queue`` messages). When the
    queue is full, the NEW items are dropped (counted in ``dropped_full``),
    so a render backlog never grows and what is queued keeps its order.

    ``send(items)`` is called, from a reader thread, with a list holding one
    rendered ``image_overlay`` item. ``on_drop(item)`` (optional) is called
    with each overlay that is not rendered (only its session / name /
    overlay / static fields for drops in the render process). Image sizes come from the overlay itself
    or from ``note_image_size`` (fed with the sizes of relayed images; only
    changes are forwarded to the render process); an overlay whose size is
    not known yet waits up to ``wait_size_s`` for its image, then is dropped.

    The render process runs on the CPUs the server is not pinned to, at
    ``niceness`` (added to the server's).

    Stats (reset by the caller as it likes): ``rendered``, ``render_s``
    (render time spent in the process), ``dropped`` (all drops, including
    ``dropped_full``).
    """

    def __init__(self, send, max_queue=64, wait_size_s=2.0, niceness=10, on_drop=None):
        import multiprocessing as mp
        import os
        import threading
        self.send = send
        self.on_drop = on_drop
        self.dropped = 0
        self.dropped_full = 0
        self.rendered = 0
        self.render_s = 0.0
        self._sizes_sent = {}                   # (session, name) -> (w, h) forwarded
        self._stop = False
        self._warned_dead = False
        try:
            avoid_cpus = sorted(os.sched_getaffinity(0))
        except AttributeError:                  # not Linux
            avoid_cpus = []
        # spawn, not fork: the server is multi-threaded (ZMQ, websocket
        # threads), and forking a threaded process can deadlock the child.
        ctx = mp.get_context('spawn')
        self._in = ctx.Queue(maxsize=max_queue)
        self._out = ctx.Queue()
        self._proc = ctx.Process(
            target=_render_worker, name='overlay-render', daemon=True,
            args=(self._in, self._out, wait_size_s, avoid_cpus, niceness))
        self._proc.start()
        self._reader = threading.Thread(target=self._read_results,
                                        name='overlay-results', daemon=True)
        self._reader.start()

    def _put(self, msg):
        """Queue a message for the render process; False if the queue is full
        (or the process is gone)."""
        import queue
        if self._stop or not self._proc.is_alive():
            return False
        try:
            self._in.put_nowait(msg)
            return True
        except queue.Full:
            return False

    def note_image_size(self, session, name, size):
        if size is None:
            return
        key, size = (session, name), (int(size[0]), int(size[1]))
        if self._sizes_sent.get(key) == size:
            return
        # Remembered only once queued: a size lost to a full queue is
        # resent with the next image.
        if self._put(('size', key, size)):
            self._sizes_sent[key] = size

    def submit(self, items):
        for it in items:
            if not self._put(('render', it)):
                self.dropped += 1
                self.dropped_full += 1
                self._notify_drop(it)

    def _notify_drop(self, item):
        if self.on_drop is not None:
            try:
                self.on_drop(item)
            except Exception as e:
                print(f"[overlay] on_drop failed: {e}")

    def _read_results(self):
        import queue
        while True:
            try:
                msg = self._out.get(timeout=0.5)
            except queue.Empty:
                if self._stop:
                    return
                if not self._proc.is_alive() and not self._warned_dead:
                    self._warned_dead = True
                    print(f"[overlay] render process exited (code {self._proc.exitcode}); "
                          f"overlays are dropped from now on")
                continue
            except (EOFError, OSError):
                return
            if msg is None:
                return
            if msg[0] == 'rendered':
                self.rendered += 1
                self.render_s += msg[2]
                try:
                    self.send([msg[1]])
                except Exception as e:
                    print(f"[overlay] send failed: {e}")
            elif msg[0] == 'dropped':
                self.dropped += msg[1]
                if len(msg) > 2 and msg[2] is not None:
                    self._notify_drop(msg[2])

    def stop(self, timeout_s=2.0):
        """Stop the render process (queued overlays are not rendered)."""
        import queue
        self._stop = True
        try:
            self._in.put(None, timeout=timeout_s)
        except (queue.Full, ValueError, OSError):
            pass
        self._proc.join(timeout_s)
        if self._proc.is_alive():
            self._proc.terminate()
            self._proc.join(timeout_s)
        self._reader.join(timeout_s)
        # The queues' feeder threads must not block interpreter exit on data
        # the stopped process will never read.
        self._in.cancel_join_thread()


class StaticOverlayCache:
    """Server side of the static overlays (``log_overlay(..., static=True)``),
    keyed by (session, image source, overlay name).

    ``is_new(item)`` tells whether a logged static overlay differs from the
    last one of its key (same items and size: a repeat, not rendered or sent
    again); ``forget(item)`` undoes that for an overlay that was not rendered,
    so the next repeat is. ``rendered(item)`` keeps the newest rendered
    version, which ``snapshot()`` replays to viewers connecting later and to
    new recordings. ``clear_session`` drops a session's entries (producer
    relaunch, eviction). Thread-safe.
    """

    def __init__(self):
        import threading
        self._lock = threading.Lock()
        self._sig = {}          # key -> packed (items, size) last accepted
        self._last = {}         # key -> rendered image_overlay item

    @staticmethod
    def key(item, session=None):
        return (item.get('session') or session, item.get('name'), item.get('overlay'))

    @staticmethod
    def is_static(item):
        return bool(item.get('static'))

    def is_new(self, item, session=None):
        import ormsgpack
        key = self.key(item, session)
        sig = ormsgpack.packb([item.get('items') or [], item.get('size')],
                              option=ormsgpack.OPT_SERIALIZE_NUMPY)
        with self._lock:
            if self._sig.get(key) == sig:
                return False
            self._sig[key] = sig
            return True

    def forget(self, item, session=None):
        with self._lock:
            self._sig.pop(self.key(item, session), None)

    def rendered(self, item):
        with self._lock:
            self._last[self.key(item)] = item

    def snapshot(self, session=None):
        """Rendered static overlays (of ``session`` only, if given)."""
        with self._lock:
            return [it for k, it in self._last.items() if session is None or k[0] == session]

    def clear_session(self, session):
        with self._lock:
            for d in (self._sig, self._last):
                for k in [k for k in d if k[0] == session]:
                    del d[k]
