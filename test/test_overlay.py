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
