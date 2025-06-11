#!/bin/bash

adb reverse tcp:8000 tcp:8000 # Webserver.
adb reverse tcp:5678 tcp:5678 # Websocket.

python -m http.server 8000
