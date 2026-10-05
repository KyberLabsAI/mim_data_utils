#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RECORDINGS_DIR="$WS_ROOT/recordings"
mkdir -p "$RECORDINGS_DIR"

# Pass a template; the recorder fills {timestamp} per recording section, so
# each pause/resume starts a fresh file instead of overwriting the previous one.
#
# Extra args are forwarded to recorder.py, e.g.:
#   ./record.sh --with-encode-video
#   ./record.sh --with-encode-video 640x360 24fps
#   ./record.sh --with-encode-video 720p 24fps
#   ./record.sh --with-encode-video 320p
#   ./record.sh --with-encode-video 480x360 15fps cq32   # ~50 MB per 30 min
#   ./record.sh --with-encode-video 480x360 15fps cq32 denoise   # ~36 MB per 30 min
#   ./record.sh --with-encode-video 480x360 15fps cq32 denoise kf5   # ~25 MB per 30 min
# kfN: keyframe every N s (default 2). Longer = smaller file (keyframes dominate
# at low res/fps) but coarser seeking and up to N s until a live viewer decodes.
# denoise / denoiseN applies ffmpeg hqdn3d (default strength 4) before the
# encoder: sensor noise is what costs bits on a mostly static scene (~-35%).
# Video is H.265 (hevc_nvenc) in constant-quality mode; cqNN picks the level
# (default cq30; lower = better/bigger: cq26 ~1.6 Mbit/s, cq30 ~0.9, cq34 ~0.5
# at 640x480 on the D405 colour stream).
#
# Snapshots instead of full recordings: SPACE stores the current frames plus a
# short stretch of data, then stops (no _end frames); default 1 s:
#   ./record.sh --snapshot
#   ./record.sh --snapshot 0.5       # seconds; also 0.5s or 500ms
# --average (with --snapshot): the _begin image combines all camera frames of
# the snapshot duration into one noise-reduced image (static scene; mean by
# default, or `--average median`):
#   ./record.sh --snapshot --average          # 1 s, ~30 frames
#   ./record.sh --snapshot 2s --average       # explicit duration
python "$SCRIPT_DIR/python/mim_data_utils/recorder.py" \
    "$RECORDINGS_DIR/mim_{timestamp}.zst" \
    "$@"
