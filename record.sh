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
python "$SCRIPT_DIR/python/mim_data_utils/recorder.py" \
    "$RECORDINGS_DIR/mim_{timestamp}.zst" \
    "$@"
