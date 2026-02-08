import time
import io
import numpy as np
from logger import Logger


def render_frame(cx, cy, size=1920, height=1080, cube_size=60):
    """Render a 1080p JPEG frame with a cube at (cx, cy) in normalized [-1,1] coords."""
    w, h = size, height

    # Map normalized coords to pixel coords
    px = int((cx + 1) / 2 * w)
    py = int((1 - cy) / 2 * h)  # flip y so +1 is top

    half = cube_size // 2
    x0 = max(0, px - half)
    y0 = max(0, py - half)
    x1 = min(w, px + half)
    y1 = min(h, py + half)

    # Build raw RGB image (dark background, white cube)
    img = np.full((h, w, 3), 30, dtype=np.uint8)
    if x0 < x1 and y0 < y1:
        img[y0:y1, x0:x1] = [255, 200, 50]

    # Encode as JPEG using Pillow
    from PIL import Image
    pil_img = Image.fromarray(img)
    buf = io.BytesIO()
    pil_img.save(buf, format='JPEG', quality=70)
    return buf.getvalue()


if __name__ == "__main__":
    logger_server = Logger.start_server()
    logger = Logger(logger_server)

    print('Waiting for clients...')
    logger_server.wait_for_client()

    print('Clients ready!')

    t0 = time.time()
    last_image_time = 0
    image_interval = 1.0 / 60  # 60 Hz

    while True:
        t = time.time()
        dt = t - t0

        sin_val = np.sin(2 * np.pi * dt)
        cos_val = np.cos(2 * np.pi * dt)

        # Log data at ~1000 Hz
        logger.log({
            'sin': sin_val,
            'cos': cos_val
        }, t)

        # Log image at ~60 Hz
        if dt - last_image_time >= image_interval:
            last_image_time = dt
            jpeg_data = render_frame(0.5 * sin_val, 0.5 * cos_val)
            logger.log_image('camera', jpeg_data, t)

        time.sleep(0.001)
