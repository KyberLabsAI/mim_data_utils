#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Recordings (Logger.record / record.sh) are written by this server process,
# to the same folder record.sh always used. Override by exporting it first.
export MIM_RECORDINGS_DIR="${MIM_RECORDINGS_DIR:-$WS_ROOT/recordings}"
mkdir -p "$MIM_RECORDINGS_DIR"

taskset -c 7 python "$SCRIPT_DIR/python/mim_data_utils/server.py"
