"""Unit tests for image overlays (no server needed): python -m pytest test/test_overlay.py"""
import io
import time

import cv2
import numpy as np
import ormsgpack
from PIL import Image

from mim_data_utils.overlay import Overlay, OverlayRenderer, image_size, render_overlay
from mim_data_utils.logger import WebsocketWriter


def _decode(png):
    return np.array(Image.open(io.BytesIO(png)).convert('RGBA'))


def test_image_size_jpeg_png():
    img = np.zeros((48, 64, 3), np.uint8)
    assert image_size(cv2.imencode('.jpg', img)[1].tobytes()) == (64, 48)
    assert image_size(cv2.imencode('.png', img)[1].tobytes()) == (64, 48)
    assert image_size(b'not an image') is None


def test_empty_overlay():
    assert render_overlay([], (640, 480)) == (None, (0, 0))
    # Entirely outside the image -> nothing visible.
    assert render_overlay(Overlay().circle(-100, -100, 5).items, (640, 480))[0] is None


def test_crop_offset_stroke_and_fill():
    ov = Overlay().rect(100, 50, 120, 70, color=(255, 0, 0), width=2)
    ov.circle(200, 100, 10, width=0, fill=(0, 255, 0, 128))
    png, (x, y) = render_overlay(ov.items, (640, 480))
    px = _decode(png)
    assert (x, y) == (98, 48)                    # rect corner minus stroke pad
    assert px.shape[1] == 211 - 98 and px.shape[0] == 111 - 48
    # Rect stroke is red, antialiased across the edge (2 px of coverage in
    # total), its inside transparent.
    col = px[48 - y:54 - y, 110 - x]
    assert np.all(col[col[:, 3] > 0, :3] == (255, 0, 0))
    assert col[:, 3].max() == 255 and abs(col[:, 3].sum() / 255 - 2.0) < 0.05
    assert px[60 - y, 110 - x, 3] == 0
    # Filled circle centre is green, half transparent.
    assert tuple(px[100 - y, 200 - x]) == (0, 255, 0, 128)


def test_subpixel_position():
    # A line half a pixel lower shifts its coverage by half a pixel.
    def centre(y):
        png, (x0, y0) = render_overlay(Overlay().line((10, y), (60, y), width=1).items, (100, 100))
        a = _decode(png)[:, 35 - x0, 3].astype(float)
        return (a * (np.arange(len(a)) + y0)).sum() / a.sum()
    assert abs(centre(20.0) - 20.0) < 0.05
    assert abs(centre(20.5) - 20.5) < 0.05


def test_text_and_lines():
    ov = Overlay().text(10, 30, 'id=3', color=(0, 255, 0), bg=(0, 0, 0, 160))
    ov.lines([[0, 0], [50, 0], [50, 50]], closed=True, color=(255, 255, 0))
    png, offset = render_overlay(ov.items, (100, 100))
    px = _decode(png)
    assert offset == (0, 0)
    assert (px[..., 1] == 255).sum() > 20       # text + lines drawn
    assert px[10, 40, 3] == 0                   # inside the triangle: not filled


def test_renderer_waits_for_size():
    sent = []
    r = OverlayRenderer(sent.extend, wait_size_s=1.0)
    item = {'type': 'overlay', 'time': 1.0, 'name': 'cam', 'number': 7,
            'overlay': 'tags', 'session': 'S', 'items': Overlay().line((1, 1), (5, 5)).items,
            'size': None}
    r.submit([item])
    time.sleep(0.2)
    assert sent == []                           # size unknown yet
    r.note_image_size('S', 'cam', (32, 24))
    for _ in range(50):
        if sent:
            break
        time.sleep(0.02)
    r.stop()
    out = sent[0]
    assert out['type'] == 'image_overlay' and out['number'] == 7 and out['overlay'] == 'tags'
    assert out['size'] == [32, 24] and out['payload'][:4] == b'\x89PNG'


def test_renderer_drops_new_items_when_queue_full():
    import queue
    r = OverlayRenderer(lambda items: None)
    r.stop()
    # Stand-in for the render process's queue, which nothing drains.
    r._stop = False
    r._proc = type('Alive', (), {'is_alive': lambda self: True})()
    r._in = queue.Queue(maxsize=2)
    items = [{'type': 'overlay', 'number': i, 'items': []} for i in range(5)]
    r.submit(items)
    assert r.dropped == 3 and r.dropped_full == 3
    # The first two stay queued in order; the new ones were dropped.
    assert [r._in.get_nowait()[1]['number'] for _ in range(2)] == [0, 1]
    # A size that doesn't fit is not remembered, so it is resent later.
    r._in = queue.Queue(maxsize=1)
    r._in.put_nowait(('render', {}))
    r.note_image_size('S', 'cam', (32, 24))
    assert ('S', 'cam') not in r._sizes_sent
    r._in.get_nowait()
    r.note_image_size('S', 'cam', (32, 24))
    assert r._sizes_sent[('S', 'cam')] == (32, 24)


def test_overlay_items_routed_to_overlay_topic():
    sent = {}

    class Pub:
        def __init__(self, name):
            self.name = name

        def send(self, data):
            sent[self.name] = ormsgpack.unpackb(data)

    w = WebsocketWriter()
    w.publisher, w.camera_publisher = Pub('ts'), Pub('cam')  # type: ignore[assignment]
    w.pointcloud_publisher, w.setup_publisher = Pub('pc'), Pub('setup')  # type: ignore[assignment]
    w.overlay_publisher = Pub('overlay')  # type: ignore[assignment]
    w.log([{'type': 'overlay', 'name': 'cam', 'items': []},
           {'type': 'image', 'name': 'cam', 'payload': b'x'},
           {'type': 'md', 'text': 'hi'}])
    assert [i['type'] for i in sent['overlay']] == ['overlay']
    assert [i['type'] for i in sent['cam']] == ['image']
    assert [i['type'] for i in sent['ts']] == ['md']


# --- static overlays ----------------------------------------------------------

from mim_data_utils.overlay import StaticOverlayCache  # noqa: E402


def _static(items, session='S', overlay='cup', size=(32, 24)):
    return {'type': 'overlay', 'time': 1.0, 'name': 'cam', 'number': None, 'overlay': overlay,
            'session': session, 'items': items, 'size': list(size), 'static': True}


def test_logger_static_overlay_dedupe_and_resend():
    from mim_data_utils.logger import Logger

    class Stub:
        STATIC_OVERLAY_RESEND_S = 0.2

        def __init__(self):
            self._static_overlays, self.out = {}, []

        def _append_log(self, item):
            self.out.append(item)

    lg, ov = Stub(), Overlay().line((1, 1), (5, 5))
    for _ in range(3):
        Logger.log_overlay(lg, 1.0, 'cam', 12, 'cup', ov, static=True)
    assert len(lg.out) == 1                       # unchanged repeats are not sent
    assert lg.out[0]['static'] is True and lg.out[0]['number'] is None
    Logger.log_overlay(lg, 2.0, 'cam', None, 'cup', Overlay().line((1, 1), (6, 5)), static=True)
    assert len(lg.out) == 2                       # a change is
    Logger.log_overlay(lg, 2.0, 'cam', None, 'other', ov, static=True)
    assert len(lg.out) == 3                       # per overlay name
    time.sleep(0.25)
    Logger.log_overlay(lg, 3.0, 'cam', None, 'other', ov, static=True)
    assert len(lg.out) == 4                       # heartbeat resend
    # Per-frame overlays are never deduped and carry no static flag.
    Logger.log_overlay(lg, 3.0, 'cam', 5, 'tags', ov)
    Logger.log_overlay(lg, 3.0, 'cam', 5, 'tags', ov)
    assert len(lg.out) == 6 and 'static' not in lg.out[-1] and lg.out[-1]['number'] == 5


def test_static_overlay_cache():
    c = StaticOverlayCache()
    a, b = Overlay().line((1, 1), (5, 5)).items, Overlay().line((1, 1), (6, 5)).items
    assert c.is_new(_static(a)) and not c.is_new(_static(a))
    assert c.is_new(_static(a, size=(64, 48)))   # size is part of the content
    assert c.is_new(_static(b)) and c.is_new(_static(a, session='T'))
    c.forget(_static(b))
    assert c.is_new(_static(b))                  # not rendered -> rendered on the repeat

    c.rendered({'type': 'image_overlay', 'session': 'S', 'name': 'cam', 'overlay': 'cup', 'v': 1})
    c.rendered({'type': 'image_overlay', 'session': 'S', 'name': 'cam', 'overlay': 'cup', 'v': 2})
    c.rendered({'type': 'image_overlay', 'session': 'T', 'name': 'cam', 'overlay': 'cup', 'v': 3})
    assert [it['v'] for it in c.snapshot('S')] == [2]       # newest version only
    assert len(c.snapshot()) == 2
    c.clear_session('S')
    assert c.snapshot('S') == [] and c.is_new(_static(b))   # relaunch sends it again
    assert [it['v'] for it in c.snapshot()] == [3]


def test_renderer_static_flag_and_drop_callback():
    sent, dropped = [], []
    r = OverlayRenderer(sent.extend, on_drop=dropped.append, wait_size_s=0.1)
    r.submit([_static(Overlay().line((1, 1), (5, 5)).items)])
    r.submit([_static(Overlay().line((1, 1), (5, 5)).items, overlay='nosize', size=(0, 0)) | {'size': None}])
    for _ in range(100):
        if sent and dropped:
            break
        time.sleep(0.02)
    r.stop()
    assert sent[0]['static'] is True and sent[0]['number'] is None
    # Dropped in the render process (no size): reported with its key fields.
    assert dropped == [{'session': 'S', 'name': 'cam', 'overlay': 'nosize', 'static': True}]


def test_server_replays_static_overlays():
    from mim_data_utils.server import BinaryWebSocketServer
    c = StaticOverlayCache()
    c.rendered({'type': 'image_overlay', 'session': 'S', 'name': 'cam', 'overlay': 'cup',
                'payload': b'\x89PNG', 'static': True})
    c.rendered({'type': 'image_overlay', 'session': 'gone', 'name': 'cam', 'overlay': 'cup'})

    class Tracker:
        def snapshot(self):
            return {'S': 1.0}

    stub = type('Stub', (), {})()
    stub.static_overlays, stub.session_tracker = c, Tracker()
    msgs = BinaryWebSocketServer.static_overlay_messages(stub)
    assert len(msgs) == 1                         # live sessions only
    items = ormsgpack.unpackb(msgs[0])
    assert items[0]['overlay'] == 'cup' and items[0]['payload'] == b'\x89PNG'
