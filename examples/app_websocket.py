#!/usr/bin/env python

# Based on:
# https://websockets.readthedocs.io/en/stable/intro.html

# WS server that sends messages at random intervals

import asyncio
import datetime
import json
import random
import websockets

from data_utils import DataReader

async def basic_streaming(websocket, path):
    reader = DataReader('test.mds')
    c = 0

    data = {}

    for c in range(reader.idx):
        now = datetime.datetime.utcnow().isoformat() + "Z"

        reader.read_chunck(c, data)

        # Convert the arrays to byte strings.
        for key, value in data.items():
            data[key] = str(value)

        data['_timestamp'] = now

        await websocket.send(json.dumps(data))
        await asyncio.sleep(0.01)

if __name__ == '__main__':
    start_server = websockets.serve(basic_streaming, "127.0.0.1", 5678)

    asyncio.get_event_loop().run_until_complete(start_server)
    asyncio.get_event_loop().run_forever()
