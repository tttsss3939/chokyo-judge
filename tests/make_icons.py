"""アイコン PNG を生成（依存: numpy のみ）。python tests/make_icons.py"""
import struct, zlib, numpy as np
from pathlib import Path

def png(path, rgba):
    h, w, _ = rgba.shape
    raw = b''.join(b'\x00' + rgba[y].tobytes() for y in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    Path(path).write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))

def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    t = np.clip(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy), 0, 1)
    return np.hypot(px - (ax + t * vx), py - (ay + t * vy))

def icon(size, rounded=True, ss=4):
    n = size * ss
    y, x = (np.mgrid[0:n, 0:n] + 0.5) / n
    bg = np.array([31, 122, 52], float); fg = np.array([255, 255, 255], float); acc = np.array([255, 196, 61], float)
    if rounded:
        r = 0.22; dx = np.maximum(np.abs(x - 0.5) - (0.5 - r), 0); dy = np.maximum(np.abs(y - 0.5) - (0.5 - r), 0)
        alpha = (np.hypot(dx, dy) <= r).astype(float)
    else:
        alpha = np.ones_like(x)
    cx, cy, R = 0.5, 0.55, 0.27
    d = np.hypot(x - cx, y - cy)
    ring = np.abs(d - R) <= 0.035
    knob = (np.abs(x - cx) <= 0.05) & (y >= 0.17) & (y <= 0.26)
    stem = (np.abs(x - cx) <= 0.025) & (y >= 0.24) & (y <= 0.29)
    hand = seg_dist(x, y, cx, cy, cx + 0.13, cy - 0.15) <= 0.028
    dot = d <= 0.045
    tick = np.zeros_like(ring)
    for k in range(12):
        a = k * np.pi / 6
        tick |= seg_dist(x, y, cx + 0.19 * np.sin(a), cy - 0.19 * np.cos(a), cx + 0.215 * np.sin(a), cy - 0.215 * np.cos(a)) <= 0.012
    img = np.broadcast_to(bg, x.shape + (3,)).copy()
    img[ring | knob | stem | tick] = fg
    img[hand | dot] = acc
    out = np.dstack([img, alpha * 255]).reshape(size, ss, size, ss, 4).mean(axis=(1, 3))
    return np.round(out).astype(np.uint8)

root = Path(__file__).resolve().parent.parent / 'icons'
root.mkdir(exist_ok=True)
png(root / 'icon-192.png', icon(192))
png(root / 'icon-512.png', icon(512))
png(root / 'icon-maskable-512.png', icon(512, rounded=False))
png(root / 'apple-touch-icon.png', icon(180, rounded=False))
print('ok')
