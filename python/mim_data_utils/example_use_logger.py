import time
import io
import os
import shutil
import subprocess
import json
import numpy as np
from logger import Logger


def render_frame(cx, cy, size=1920, height=1080, cube_size=60):
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

    # Build raw RGB image (dark background, white cube)
    img = np.full((h, w, 3), 30, dtype=np.uint8)
    if x0 < x1 and y0 < y1:
        img[y0:y1, x0:x1] = [255, 200, 50]

    return img


def encode_jpeg(img):
    """Encode a numpy RGB image as JPEG bytes."""
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

    fps = 60

    shutil.rmtree('recordings', ignore_errors=True)
    os.makedirs('recordings')

    ffmpeg_proc = subprocess.Popen([
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
        "-hls_segment_filename", "recordings/segment%03d.mp4",
        "-hls_flags", "append_list",
        "recordings/stream.m3u8",
    ], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)

    segment_timestamps = []
    completed_segments = []
    current_segment_idx = 0
    frame_count = 0

    t0 = time.time()
    last_image_time = 0
    image_interval = 1.0 / fps

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

            # Log image at target fps
            if dt - last_image_time >= image_interval:
                last_image_time = dt
                img = render_frame(0.5 * sin_val, 0.5 * cos_val)
                jpeg_data = encode_jpeg(img)
                logger.log_image('camera', jpeg_data, t)

                ffmpeg_proc.stdin.write(img.tobytes())
                segment_timestamps.append(t)
                frame_count += 1

                # Check if ffmpeg created a new segment file
                next_seg = f'recordings/segment{current_segment_idx + 1:03d}.mp4'
                if os.path.exists(next_seg):
                    seg_file = f'segment{current_segment_idx:03d}'
                    with open(f'recordings/{seg_file}.json', 'w') as f:
                        json.dump({"fps": fps, "frame_to_time": segment_timestamps}, f)
                    completed_segments.append({
                        "file": f"{seg_file}.mp4",
                        "time_start": segment_timestamps[0],
                        "time_end": segment_timestamps[-1]
                    })
                    segment_timestamps = []
                    current_segment_idx += 1

                # Write overview timestamps.json every ~1 second
                if frame_count % fps == 0:
                    overview_segs = list(completed_segments)
                    if segment_timestamps:
                        overview_segs.append({
                            "file": f"segment{current_segment_idx:03d}.mp4",
                            "time_start": segment_timestamps[0],
                            "time_end": segment_timestamps[-1]
                        })
                    with open('recordings/timestamps.json', 'w') as f:
                        json.dump({"fps": fps, "segments": overview_segs}, f)

            time.sleep(0.001)
    except KeyboardInterrupt:
        print('\nShutting down...')
        ffmpeg_proc.stdin.close()
        ffmpeg_proc.wait()

        # Write final segment JSON
        if segment_timestamps:
            seg_file = f'segment{current_segment_idx:03d}'
            with open(f'recordings/{seg_file}.json', 'w') as f:
                json.dump({"fps": fps, "frame_to_time": segment_timestamps}, f)
            completed_segments.append({
                "file": f"{seg_file}.mp4",
                "time_start": segment_timestamps[0],
                "time_end": segment_timestamps[-1]
            })

        # Write final overview
        with open('recordings/timestamps.json', 'w') as f:
            json.dump({"fps": fps, "segments": completed_segments}, f)

        print(f'Recorded {frame_count} frames across {current_segment_idx + 1} segments.')
