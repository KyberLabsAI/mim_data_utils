import time
import io
import os
import shutil
import subprocess
import json
import numpy as np
from .logger import Logger


def render_frame(cx, cy, color, size=1920, height=1080, cube_size=60):
    """Render a 1080p RGB frame with a cube at (cx, cy) in normalized [-1,1] coords."""
    w, h = size, height

    # Map normalized coords to pixel coords
    px = int((cx + 1) / 2 * w)
    py = int((1 - cy) / 2 * h)  # flip y so +1 is top

    half = cube_size // 2
    x0 = max(0, px - half)
    y0 = max(0, py - half)
    x1 = min(w, px + half)
    y1 = min(h, py + half)

    # Build raw RGB image (dark background, colored cube)
    img = np.full((h, w, 3), 30, dtype=np.uint8)
    if x0 < x1 and y0 < y1:
        img[y0:y1, x0:x1] = color

    return img


def encode_jpeg(img):
    """Encode a numpy RGB image as JPEG bytes."""
    from PIL import Image
    pil_img = Image.fromarray(img)
    buf = io.BytesIO()
    pil_img.save(buf, format='JPEG', quality=70)
    return buf.getvalue()


def make_camera(name, fps, recordings_base):
    """Create per-camera state: FFmpeg subprocess, recordings dir, tracking dicts."""
    cam_dir = os.path.join(recordings_base, name)
    os.makedirs(cam_dir, exist_ok=True)

    proc = subprocess.Popen([
        "ffmpeg", "-y",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-video_size", "1920x1080",
        "-framerate", str(fps),
        "-i", "pipe:0",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-preset", "ultrafast",
        "-tune", "zerolatency",
        "-g", str(fps * 2),
        "-f", "hls",
        "-hls_time", "10",
        "-hls_list_size", "0",
        "-hls_segment_type", "fmp4",
        "-hls_fmp4_init_filename", "init.mp4",
        "-hls_segment_filename", os.path.join(cam_dir, "segment%03d.mp4"),
        "-hls_flags", "append_list",
        os.path.join(cam_dir, "stream.m3u8"),
    ], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    return {
        'name': name,
        'fps': fps,
        'dir': cam_dir,
        'proc': proc,
        'segment_timestamps': [],
        'completed_segments': [],
        'current_segment_idx': 0,
        'segment_frame_offset': 0,
        'frame_count': 0,
        'last_image_time': 0,
        'image_interval': 1.0 / fps,
    }


def process_camera_frame(cam, img, t, logger):
    """Feed a frame to a camera's FFmpeg, check for new segments, log image."""
    jpeg_data = encode_jpeg(img)
    logger.log_image(cam['name'], jpeg_data, t)

    cam['proc'].stdin.write(img.tobytes())
    cam['segment_timestamps'].append(t)
    cam['frame_count'] += 1

    cam_dir = cam['dir']
    idx = cam['current_segment_idx']
    fps = cam['fps']

    # Check if ffmpeg created a new segment file
    next_seg = os.path.join(cam_dir, f'segment{idx + 1:03d}.mp4')
    if os.path.exists(next_seg):
        seg_file = f'segment{idx:03d}'
        with open(os.path.join(cam_dir, f'{seg_file}.json'), 'w') as f:
            json.dump({"fps": fps, "frame_offset": cam['segment_frame_offset'],
                        "frame_to_time": cam['segment_timestamps']}, f)
        segment_info = {
            "file": f"{seg_file}.mp4",
            "time_start": cam['segment_timestamps'][0],
            "time_end": cam['segment_timestamps'][-1],
            "fps": fps,
            "index": idx,
            "frame_offset": cam['segment_frame_offset'],
            "frame_to_time": list(cam['segment_timestamps'])
        }
        cam['completed_segments'].append({
            "file": f"{seg_file}.mp4",
            "time_start": cam['segment_timestamps'][0],
            "time_end": cam['segment_timestamps'][-1]
        })
        logger.log_video_segment(cam['name'], segment_info, 'init.mp4',
                                  f'recordings/{cam["name"]}/')
        cam['segment_frame_offset'] += len(cam['segment_timestamps'])
        cam['segment_timestamps'] = []
        cam['current_segment_idx'] += 1

    # Write overview timestamps.json every ~1 second
    if cam['frame_count'] % fps == 0:
        with open(os.path.join(cam_dir, 'timestamps.json'), 'w') as f:
            json.dump({"fps": fps, "segments": list(cam['completed_segments'])}, f)


def finalize_camera(cam):
    """Shut down a camera's FFmpeg and write final segment data."""
    cam['proc'].stdin.close()
    cam['proc'].wait()

    if cam['segment_timestamps']:
        seg_file = f'segment{cam["current_segment_idx"]:03d}'
        with open(os.path.join(cam['dir'], f'{seg_file}.json'), 'w') as f:
            json.dump({"fps": cam['fps'], "frame_offset": cam['segment_frame_offset'],
                        "frame_to_time": cam['segment_timestamps']}, f)
        cam['completed_segments'].append({
            "file": f"{seg_file}.mp4",
            "time_start": cam['segment_timestamps'][0],
            "time_end": cam['segment_timestamps'][-1]
        })

    with open(os.path.join(cam['dir'], 'timestamps.json'), 'w') as f:
        json.dump({"fps": cam['fps'], "segments": cam['completed_segments']}, f)

    print(f'  {cam["name"]}: {cam["frame_count"]} frames, '
          f'{cam["current_segment_idx"] + 1} segments')


if __name__ == "__main__":
    logger_server = Logger.start_server()
    logger = Logger(logger_server)

    print('Waiting for clients...')
    logger_server.wait_for_client()

    print('Clients ready!')

    _pkg_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    recordings_dir = os.path.join(_pkg_root, 'recordings')

    shutil.rmtree(recordings_dir, ignore_errors=True)
    os.makedirs(recordings_dir)

    cam_yellow = make_camera('camera_yellow', 30, recordings_dir)
    cam_green = make_camera('camera_green', 55, recordings_dir)
    all_cams = [cam_yellow, cam_green]

    # Write camera index for frontend startup discovery
    with open(os.path.join(recordings_dir, 'cameras.json'), 'w') as f:
        json.dump({"cameras": [c['name'] for c in all_cams]}, f)

    color_yellow = [255, 200, 50]
    color_green = [50, 200, 80]

    t0 = time.time()

    try:
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

            # Yellow camera at 30 fps
            if dt - cam_yellow['last_image_time'] >= cam_yellow['image_interval']:
                cam_yellow['last_image_time'] = dt
                img = render_frame(0.5 * sin_val, 0.5 * cos_val, color_yellow)
                process_camera_frame(cam_yellow, img, t, logger)

            # Green camera at 55 fps
            if dt - cam_green['last_image_time'] >= cam_green['image_interval']:
                cam_green['last_image_time'] = dt
                img = render_frame(-0.5 * sin_val, -0.5 * cos_val, color_green)
                process_camera_frame(cam_green, img, t, logger)

            time.sleep(0.001)
    except KeyboardInterrupt:
        print('\nShutting down...')
        for cam in all_cams:
            finalize_camera(cam)
