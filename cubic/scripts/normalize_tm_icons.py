# 把 tm_*.png 的图案长边统一到 14px，居中画在 20x20、底色 #141A28 上。
# 有 SVG 的从 design-preview/icons 重新渲染，避免把小位图放大。
# zcode 没有矢量源，只缩小现有 tm_zcode.png。
# 用法：python scripts/normalize_tm_icons.py

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ICON_DIR = ROOT / "design-preview" / "icons"
ASSET_DIR = ROOT / "package" / "assets"
CHROME = Path(r"C:\Program Files\Google\Chrome\Application\chrome.exe")

CANVAS = 20
TARGET = 14
BG = (0x14, 0x1A, 0x28)
FG = (0xE8, 0xEC, 0xF5)
CELL = 480

SVG_ICONS = [
    ("claude.svg", "tm_claude.png"),
    ("codex.svg", "tm_codex.png"),
    ("cursor.svg", "tm_cursor.png"),
    ("deepseek.svg", "tm_dsh.png"),
    ("grok.svg", "tm_grok.png"),
    ("kimi.svg", "tm_kimi.png"),
    ("workbuddy.svg", "tm_workbuddy.png"),
]


def force_black(svg: str) -> str:
    style = "<style>path,circle,rect,polygon,polyline,ellipse{fill:#000!important;stroke:none!important}</style>"
    return svg.replace(">", ">" + style, 1)


def render_svgs(work: Path) -> Image.Image:
    parts = []
    for name, _out in SVG_ICONS:
        raw = (ICON_DIR / name).read_text(encoding="utf-8")
        (work / name).write_text(force_black(raw), encoding="utf-8")
        parts.append(f'<img src="{name}">')
    width = CELL * len(SVG_ICONS)
    html = f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
*{{margin:0;padding:0}}
html,body{{width:{width}px;height:{CELL}px;background:#FF00FF;overflow:hidden}}
body{{display:flex}}
img{{width:{CELL}px;height:{CELL}px;display:block}}
</style></head><body>{''.join(parts)}</body></html>"""
    html_path = work / "sheet.html"
    html_path.write_text(html, encoding="utf-8")
    shot = work / "sheet.png"
    profile = work / "chrome-profile"
    subprocess.run(
        [
            str(CHROME),
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--allow-file-access-from-files",
            "--force-device-scale-factor=1",
            f"--window-size={width},{CELL}",
            "--default-background-color=00000000",
            f"--user-data-dir={profile}",
            f"--screenshot={shot}",
            html_path.resolve().as_uri(),
        ],
        check=True,
        timeout=60,
    )
    image = Image.open(shot).convert("RGB")
    if image.size != (width, CELL):
        raise SystemExit(f"screenshot size {image.size}, expected {(width, CELL)}")
    return image


def alpha_from_magenta(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    pix = rgba.load()
    w, h = rgba.size
    for y in range(h):
        for x in range(w):
            r, g, b, _a = pix[x, y]
            # 黑标叠在 #FF00FF 上：R 通道剩下的就是未覆盖比例。
            cover = max(0.0, min(1.0, 1.0 - r / 255.0))
            if g > 40 and cover < 0.95:
                cover = 0.0
            pix[x, y] = (*FG, int(round(cover * 255)))
    return rgba


def alpha_from_background(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    pix = rgba.load()
    w, h = rgba.size
    axis = tuple(fg - bg for fg, bg in zip(FG, BG))
    denom = sum(c * c for c in axis) or 1
    for y in range(h):
        for x in range(w):
            r, g, b, _a = pix[x, y]
            delta = (r - BG[0], g - BG[1], b - BG[2])
            cover = sum(d * a for d, a in zip(delta, axis)) / denom
            cover = max(0.0, min(1.0, cover))
            pix[x, y] = (*FG, int(round(cover * 255)))
    return rgba


def ink_box(image: Image.Image, threshold: int = 16) -> tuple[int, int, int, int] | None:
    pix = image.load()
    w, h = image.size
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            if pix[x, y][3] < threshold:
                continue
            if x < minx:
                minx = x
            if y < miny:
                miny = y
            if x > maxx:
                maxx = x
            if y > maxy:
                maxy = y
    if maxx < 0:
        return None
    return minx, miny, maxx, maxy


def fit_mark(mark: Image.Image) -> Image.Image:
    box = ink_box(mark)
    if box is None:
        raise SystemExit("icon has no ink")
    cropped = mark.crop(box)
    long_side = max(cropped.size)
    scale = TARGET / long_side
    resized = cropped.resize(
        (max(1, round(cropped.size[0] * scale)), max(1, round(cropped.size[1] * scale))),
        Image.Resampling.LANCZOS,
    )
    # 抗锯齿会把边缘淡像素裁掉一圈，长边不够 14 时补一档。
    fitted = ink_box(resized)
    if fitted is not None:
        got = max(fitted[2] - fitted[0], fitted[3] - fitted[1]) + 1
        if got < TARGET and long_side > 0:
            bump = TARGET / got
            resized = cropped.resize(
                (max(1, round(resized.size[0] * bump)), max(1, round(resized.size[1] * bump))),
                Image.Resampling.LANCZOS,
            )
    canvas = Image.new("RGB", (CANVAS, CANVAS), BG)
    layer = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    ox = (CANVAS - resized.size[0]) // 2
    oy = (CANVAS - resized.size[1]) // 2
    layer.paste(resized, (ox, oy), resized)
    canvas.paste(layer, mask=layer.getchannel("A"))
    return canvas


def measure(path: Path) -> str:
    image = alpha_from_background(Image.open(path).convert("RGB"))
    box = ink_box(image)
    if box is None:
        return f"{path.name}: empty"
    w = box[2] - box[0] + 1
    h = box[3] - box[1] + 1
    return f"{path.name:16} ink {w:2}x{h:<2} at ({box[0]},{box[1]})"


def main() -> None:
    if not CHROME.exists():
        raise SystemExit(f"Chrome not found: {CHROME}")
    zcode_src = alpha_from_background(Image.open(ASSET_DIR / "tm_zcode.png").convert("RGB"))
    outputs: list[tuple[str, Image.Image]] = []
    with tempfile.TemporaryDirectory(prefix="tm-icons-") as tmp:
        sheet = render_svgs(Path(tmp))
        for index, (_svg, name) in enumerate(SVG_ICONS):
            cell = sheet.crop((index * CELL, 0, (index + 1) * CELL, CELL))
            outputs.append((name, fit_mark(alpha_from_magenta(cell))))
    outputs.append(("tm_zcode.png", fit_mark(zcode_src)))
    for name, image in outputs:
        image.save(ASSET_DIR / name, format="PNG")
    for name, _image in outputs:
        print(measure(ASSET_DIR / name))


if __name__ == "__main__":
    main()
