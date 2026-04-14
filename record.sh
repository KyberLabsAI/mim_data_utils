#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RECORDINGS_DIR="$WS_ROOT/recordings"
mkdir -p "$RECORDINGS_DIR"

python "$SCRIPT_DIR/python/mim_data_utils/recorder.py" \
    "$RECORDINGS_DIR/mim_$(date +%Y%m%d_%H%M%S).zst" \
    "$@"
