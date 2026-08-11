#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
taskset -c 7 python "$SCRIPT_DIR/python/mim_data_utils/server.py"
