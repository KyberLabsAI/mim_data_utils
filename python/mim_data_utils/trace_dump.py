"""Load a trace dump of the viewer ("Dump traces" button, js/trace_export.js).

    from mim_data_utils import load_mdutrace
    traces = load_mdutrace('traces_....mdutrace.gz')
    t, v = traces['current']        # t: (n,) float64 [s], v: (n, dim) float32

python -m mim_data_utils.trace_dump <file> lists the series of a dump.
"""
import gzip
import json
import sys

import numpy as np


def load_mdutrace(path):
    """{name: (times, values)} of a .mdutrace(.gz) file, sorted by time."""
    with open(path, 'rb') as f:
        buf = f.read()
    if buf[:2] == b'\x1f\x8b':
        buf = gzip.decompress(buf)
    if buf[:8] != b'MDUTRACE':
        raise ValueError(f'{path}: not a trace dump')
    header_len, version = np.frombuffer(buf, '<u4', 2, 8)
    if version != 1:
        raise ValueError(f'{path}: unsupported version {version}')
    header = json.loads(buf[16:16 + header_len])
    base = 16 + int(header_len)
    out = {}
    for s in header['series']:
        n, dim = s['n'], s['dim']
        t = np.frombuffer(buf, '<f8', n, base + s['times_offset'])
        v = np.frombuffer(buf, '<f4', n * dim, base + s['data_offset']).reshape(dim, n).T
        order = np.argsort(t, kind='stable')
        out[s['name']] = (t[order], v[order])
    return out


if __name__ == '__main__':
    for name, (t, v) in load_mdutrace(sys.argv[1]).items():
        print(f'{name:40s} {v.shape[0]:8d} x {v.shape[1]:3d}  {t[0]:.3f} .. {t[-1]:.3f}')
