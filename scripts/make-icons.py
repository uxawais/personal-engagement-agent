#!/usr/bin/env python3
"""Generate the extension icons (rounded blue square + white chat bubble + sparkle)."""

import os
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.normpath(os.path.join(HERE, "..", "icons"))

TOP = (22, 110, 210)      # #166ed2
BOTTOM = (8, 40, 105)     # #082869
ACCENT = (12, 84, 190)    # sparkle colour inside the bubble
WHITE = (255, 255, 255, 255)


def gradient(r, pad):
    img = Image.new("RGBA", (r, r), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for y in range(pad, r - pad):
        t = (y - pad) / max(1, (r - 2 * pad) - 1)
        col = tuple(int(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,)
        d.line([(pad, y), (r - pad - 1, y)], fill=col)
    return img


def rounded_mask(r, pad, radius):
    mask = Image.new("L", (r, r), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [pad, pad, r - pad - 1, r - pad - 1], radius=radius, fill=255
    )
    return mask


def four_point_star(d, cx, cy, r):
    inner = r * 0.38
    pts = [
        (cx, cy - r), (cx + inner, cy - inner), (cx + r, cy),
        (cx + inner, cy + inner), (cx, cy + r),
        (cx - inner, cy + inner), (cx - r, cy), (cx - inner, cy - inner),
    ]
    d.polygon(pts, fill=ACCENT + (255,))


def make_icon(size):
    pad = max(int(size * 0.06), 1)
    r = size

    img = gradient(r, pad)
    img.putalpha(rounded_mask(r, pad, int(r * 0.22)))

    d = ImageDraw.Draw(img)

    bw = r * 0.60          # bubble width
    bh = r * 0.46          # bubble height
    bx0 = (r - bw) / 2
    by0 = r * 0.16
    bx1 = bx0 + bw
    by1 = by0 + bh

    d.ellipse([bx0, by0, bx1, by1], fill=WHITE)

    # little bubble tail
    tail = [
        (bx0 + bw * 0.18, by0 + bh * 0.72),
        (bx0 + bw * 0.02, by0 + bh),
        (bx0 + bw * 0.34, by0 + bh * 0.86),
    ]
    d.polygon(tail, fill=WHITE)

    cy = by0 + bh * 0.52
    four_point_star(d, r / 2, cy, r * 0.115)

    # two small dots
    dot_r = max(1.0, r * 0.05)
    d.ellipse([r / 2 - r * 0.215 - dot_r, cy - dot_r, r / 2 - r * 0.215 + dot_r, cy + dot_r], fill=ACCENT + (255,))
    d.ellipse([r / 2 + r * 0.215 - dot_r, cy - dot_r, r / 2 + r * 0.215 + dot_r, cy + dot_r], fill=ACCENT + (255,))

    return img


def main():
    os.makedirs(ICON_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        make_icon(size).save(os.path.join(ICON_DIR, f"icon{size}.png"))
        print(f"icon{size}.png written")
    # Also emit a 48px alpha PNG used nowhere but handy.
    print("done")


if __name__ == "__main__":
    main()