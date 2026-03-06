"""Capture init + fragments from WebSocket and write to MP4 file for verification."""
import time
import struct
import asyncio
import websockets
import ormsgpack


async def main():
    uri = "ws://127.0.0.1:5678/"
    print(f"Connecting to {uri} ...")

    init_data = None
    fragments = []
    target_name = None

    async with websockets.connect(uri) as ws:
        deadline = time.time() + 15

        while time.time() < deadline:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=2.0)
            except asyncio.TimeoutError:
                continue

            items = ormsgpack.unpackb(msg)
            for item in items:
                if not isinstance(item, dict):
                    continue

                msg_type = item.get('type')
                name = item.get('name', 'default')

                if msg_type == 'video_init':
                    if target_name is None or name == target_name:
                        if '/longterm' not in name:
                            target_name = name
                            init_data = item['payload']
                            if isinstance(init_data, memoryview):
                                init_data = bytes(init_data)
                            print(f"Got init for '{name}': {len(init_data)} bytes")
                            print(f"  First 32 bytes: {init_data[:32].hex()}")

                elif msg_type == 'video_fragment' and name == target_name:
                    payload = item['payload']
                    if isinstance(payload, memoryview):
                        payload = bytes(payload)
                    fragments.append(payload)
                    print(f"Got fragment #{len(fragments)}: {len(payload)} bytes, first 16: {payload[:16].hex()}")

                    if len(fragments) >= 5:
                        break

            if len(fragments) >= 5:
                break

    if not init_data:
        print("ERROR: No init segment received!")
        return

    print(f"\nCapture: init={len(init_data)} bytes, {len(fragments)} fragments")

    # Write to MP4 file
    out_path = "/tmp/ws_capture.mp4"
    with open(out_path, "wb") as f:
        f.write(init_data)
        for frag in fragments:
            f.write(frag)

    print(f"Written to {out_path}")

    # Parse box structure
    def parse_boxes(data, prefix=""):
        offset = 0
        while offset < len(data) - 8:
            size = struct.unpack('>I', data[offset:offset+4])[0]
            box_type = data[offset+4:offset+8]
            try:
                bt = box_type.decode('ascii')
            except:
                bt = box_type.hex()
            if size < 8 or offset + size > len(data):
                print(f"{prefix}[TRUNC] offset={offset} size={size} type={bt} data_remaining={len(data)-offset}")
                break
            print(f"{prefix}{bt} size={size}")
            if bt in ('moov', 'moof', 'traf', 'trak', 'mdia', 'minf', 'stbl', 'mvex'):
                parse_boxes(data[offset+8:offset+size], prefix + "  ")
            offset += size

    print(f"\n--- Init segment ({len(init_data)} bytes) ---")
    parse_boxes(init_data)

    print(f"\n--- Fragment 1 ({len(fragments[0])} bytes) ---")
    parse_boxes(fragments[0])

    if len(fragments) > 1:
        print(f"\n--- Fragment 2 ({len(fragments[1])} bytes) ---")
        parse_boxes(fragments[1])

    # Verify with ffprobe
    import subprocess
    print(f"\n--- ffprobe {out_path} ---")
    r = subprocess.run(["ffprobe", "-v", "error", "-show_streams", out_path],
                       capture_output=True, text=True)
    print(r.stdout or "(no output)")
    if r.stderr:
        print(f"stderr: {r.stderr}")


asyncio.run(main())
