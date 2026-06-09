#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RECORDINGS_DIR="$WS_ROOT/recordings"
mkdir -p "$RECORDINGS_DIR"

# Pass a template; the recorder fills {timestamp} per recording section, so
# each pause/resume starts a fresh file instead of overwriting the previous one.
python "$SCRIPT_DIR/python/mim_data_utils/recorder.py" \
    "$RECORDINGS_DIR/mim_{timestamp}.zst" \
    "$@"
