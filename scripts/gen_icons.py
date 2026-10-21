"""Generate the app icon set (no external assets required).

Run: python scripts/gen_icons.py
Writes into src-tauri/icons/.
"""

from pathlib import Path

from PIL import Image, ImageDraw

SIZE = 1024
OUT = Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

# --- gradient background ---------------------------------------------------
grad = Image.new("RGBA", (SIZE, SIZE))
draw = ImageDraw.Draw(grad)
top = (30, 36, 56)
bottom = (72, 58, 138)
for y in range(SIZE):
    t = y / (SIZE - 1)
    color = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,)
    draw.line([(0, y), (SIZE, y)], fill=color)

mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).rounded_rectangle(
    [0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.22), fill=255
)

icon = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
icon.paste(grad, (0, 0), mask)
draw = ImageDraw.Draw(icon)

# --- "text lines" + caret --------------------------------------------------
white = (255, 255, 255, 232)
line_x0 = int(SIZE * 0.18)
heights = [0.34, 0.47, 0.60]
ends = [0.62, 0.58, 0.50]
line_h = int(SIZE * 0.055)
for y_ratio, end_ratio in zip(heights, ends):
    y0 = int(SIZE * y_ratio)
    draw.rounded_rectangle(
        [line_x0, y0, int(SIZE * end_ratio), y0 + line_h],
        radius=line_h // 2,
        fill=white,
    )

caret_x = int(SIZE * 0.68)
draw.rounded_rectangle(
    [caret_x, int(SIZE * 0.30), caret_x + int(SIZE * 0.055), int(SIZE * 0.70)],
    radius=int(SIZE * 0.027),
    fill=(122, 162, 247, 255),
)

# --- write outputs ---------------------------------------------------------
icon.save(OUT / "icon.png")
for size in (512, 256, 128, 32, 16):
    name = f"{size}x{size}.png" if size != 256 else "128x128@2x.png"
    icon.resize((size, size), Image.LANCZOS).save(OUT / name)

icon.save(
    OUT / "icon.ico",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

print("icons written to", OUT)
for path in sorted(OUT.iterdir()):
    print(" -", path.name, path.stat().st_size, "bytes")