"""Dump fMP4 data from the websocket to verify box structure."""
import time
import struct
import ormsgpack
from kyber_utils.zeromq import ZmqSubscriber


def parse_boxes(data, indent=0):
    """Parse and print MP4 box structure."""
    offset = 0
    boxes = []
    while offset < len(data) - 8:
        size = struct.unpack('>I', data[offset:offset+4])[0]
        box_type = data[offset+4:offset+8].decode('ascii', errors='replace')
        if size < 8 or offset + size > len(data):
            print(f"{'  '*indent}[INVALID] offset={offset} size={size} type={box_type} remaining={len(data)-offset}")
            break
        boxes.append((box_type, size, offset))
        print(f"{'  '*indent}{box_type} size={size} offset={offset}")
        if box_type in ('moov', 'moof', 'traf', 'trak', 'mdia', 'minf', 'stbl'):
            parse_boxes(data[offset+8:offset+size], indent+1)
        if box_type == 'trun':
            # Parse trun header
            vf = struct.unpack('>I', data[offset+8:offset+12])[0]
            version = vf >> 24
            flags = vf & 0xFFFFFF
            sample_count = struct.unpack('>I', data[offset+12:offset+16])[0]
            print(f"{'  '*indent}  version={version} flags=0x{flags:06x} sample_count={sample_count}")
        offset += size
    return boxes


def main():
    print("Subscribing to /camera/ ZMQ topic...")
    inits = {}
    fragments = {}

    def on_data(topic, data):
        items = ormsgpack.unpackb(data)
        for item in items:
            if not isinstance(item, dict):
                continue
            msg_type = item.get('type')
            name = item.get('name', 'default')

            if msg_type == 'video_init':
                payload = item['payload']
                print(f"\n=== video_init for '{name}' ({len(payload)} bytes) ===")
                parse_boxes(payload)
                inits[name] = payload

                # Write to file for inspection
                fname = name.replace('/', '_') + '_init.mp4'
                with open(f'/tmp/{fname}', 'wb') as f:
                    f.write(payload)
                print(f"  Written to /tmp/{fname}")

            elif msg_type == 'video_fragment':
                payload = item['payload']
                count = fragments.get(name, 0) + 1
                fragments[name] = count

                if count <= 3:  # Only dump first 3 fragments
                    print(f"\n=== video_fragment #{count} for '{name}' ({len(payload)} bytes) ===")
                    print(f"  First 32 bytes: {payload[:32].hex()}")
                    parse_boxes(payload)

                    # Write init+fragments to file
                    if name in inits:
                        fname = name.replace('/', '_') + f'_test.mp4'
                        with open(f'/tmp/{fname}', 'ab' if count > 1 else 'wb') as f:
                            if count == 1:
                                f.write(inits[name])
                            f.write(payload)
                        if count == 3:
                            print(f"  Written init + 3 fragments to /tmp/{fname}")
                            print(f"  Verify with: ffprobe /tmp/{fname}")

    sub = ZmqSubscriber('/camera/', callback=on_data)

    print("Waiting for data (Ctrl+C to stop)...")
    try:
        deadline = time.time() + 15
        while time.time() < deadline:
            time.sleep(0.1)
            # Stop after we have 3 fragments for at least one stream
            if any(v >= 3 for v in fragments.values()):
                time.sleep(1)  # Let a few more come in
                break
    except KeyboardInterrupt:
        pass

    sub.close()
    print(f"\nDone. Received inits: {list(inits.keys())}, fragments: {fragments}")


if __name__ == '__main__':
    main()
