# 生成 Agent Tank 鱼形素材：6 个体型（按用量排名）x 5 个余额档颜色 x 3 种姿态。
# 透明底 PNG，配合 main.lua 第二页水族箱使用；命名 fish_<w>x<h>_<color>[_dead].png。
# 高倍绘制后 LANCZOS 缩到目标尺寸，保证 320x240 屏上边缘平滑。
from PIL import Image, ImageDraw

S = 4  # 超采样倍数

SIZES = [(56, 28), (48, 24), (38, 22), (34, 16), (30, 14), (26, 12)]

# 与 main.lua 四档余额配色一致（gray 用于无数据/离线降暗）
COLORS = {
    "green": (0x4A, 0xDE, 0x80),
    "blue": (0x60, 0xA5, 0xFA),
    "amber": (0xFA, 0xCC, 0x15),
    "red": (0xF8, 0x71, 0x71),
    "gray": (0x8A, 0x93, 0xA6),
}

DARK = (6, 16, 24)  # 眼睛 / X 眼，与缸底深色一致


def darker(c, f=0.75):
    return tuple(int(x * f) for x in c)


def draw_fish(w, h, color, dead=False):
    """按 design-preview/shots/aquarium.html 的 54x26 SVG 比例绘制。"""
    W, H = w * S, h * S
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    sx, sy = W / 54.0, H / 26.0

    def P(x, y):
        return (x * sx, y * sy)

    # 尾巴与双鳍
    d.polygon([P(11, 13), P(0, 5), P(3, 13), P(0, 21)], fill=color + (255,))
    d.polygon([P(22, 4), P(31, 2), P(28, 11)], fill=darker(color) + (255,))
    d.polygon([P(24, 22), P(33, 24), P(29, 16)], fill=darker(color) + (255,))
    # 身体
    d.ellipse([*P(13, 3.5), *P(47, 22.5)], fill=color + (255,))
    # 腹部高光（白 18% 透明）
    d.ellipse([*P(23, 11.5), *P(43, 20.5)], fill=(255, 255, 255, 46))

    if dead:
        # X 眼：两条交叉线，线宽随体型缩放
        lw = max(1, int(round(1.3 * S * min(sx, sy) / S * S / 4)))
        lw = max(2, int(round(1.3 * S)))
        cx, cy = P(42, 11)
        r = 2.5 * S
        d.line([cx - r, cy - r, cx + r, cy + r], fill=DARK + (255,), width=lw)
        d.line([cx + r, cy - r, cx - r, cy + r], fill=DARK + (255,), width=lw)
        # 翻白肚：整体旋转 165°
        img = img.rotate(-165, resample=Image.BICUBIC, center=(W / 2, H / 2))
    else:
        ex, ey = P(42, 11)
        r = 2.3 * S * min(sx, sy) / min(W / 54.0, H / 26.0)
        r = 2.3 * S
        d.ellipse([ex - r, ey - r, ex + r, ey + r], fill=DARK + (255,))
        g = 0.7 * S
        gx, gy = P(42.8, 10.3)
        d.ellipse([gx - g, gy - g, gx + g, gy + g], fill=(255, 255, 255, 255))

    return img.resize((w, h), Image.LANCZOS)


def draw_weed(w, h, blades=2, phase=0.0):
    """水草：若干条正弦摆动、尖端收窄的叶片，半透明深绿。"""
    import math

    W, H = w * S, h * S
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    GREEN = (0x3A, 0xA0, 0x6E)
    for b in range(blades):
        cx = W * (0.25 + 0.5 * b / max(1, blades - 1)) if blades > 1 else W / 2
        amp = W * 0.16
        lam = H / (1.1 + 0.35 * b)
        th = max(2, W // 5)
        left, right = [], []
        steps = 24
        for i in range(steps + 1):
            y = H - H * i / steps
            x = cx + amp * math.sin(2 * math.pi * (H - y) / lam + phase + b * 1.7)
            shrink = 1 - 0.6 * i / steps  # 向叶尖收窄
            left.append((x - th * shrink / 2, y))
            right.append((x + th * shrink / 2, y))
        d.polygon(left + right[::-1], fill=GREEN + (200,))
    return img.resize((w, h), Image.LANCZOS)


def draw_shrimp(w, h, flip=False):
    """小虾米：弓形身体 + 尾扇 + 眼点，浅橙粉色。"""
    W, H = w * S, h * S
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    BODY = (0xF2, 0xA6, 0x88)
    lw = max(2, int(H * 0.30))
    d.arc([W * 0.10, -H * 0.35, W * 1.05, H * 1.15], start=25, end=165,
          fill=BODY + (255,), width=lw)
    # 尾扇（弧的收尾端，右侧）
    d.polygon([(W * 0.86, H * 0.28), (W * 1.02, H * 0.05), (W * 0.99, H * 0.45)],
              fill=BODY + (255,))
    # 眼点（弧的起始端，左侧）
    r = max(1, S)
    d.ellipse([W * 0.13 - r, H * 0.55 - r, W * 0.13 + r, H * 0.55 + r],
              fill=DARK + (255,))
    img = img.resize((w, h), Image.LANCZOS)
    if flip:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    return img


def draw_zcode_logo():
    """20px 白色 Z.ai 标识；与现有 tm_* 透明底单色图标一致。"""
    size = 20 * S
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    white = (0xE8, 0xEC, 0xF5, 255)
    d.line([(4 * S, 5 * S), (16 * S, 5 * S), (4 * S, 15 * S), (16 * S, 15 * S)],
           fill=white, width=3 * S, joint="curve")
    return img.resize((20, 20), Image.LANCZOS)


def main():
    import os
    out = os.path.join(os.path.dirname(__file__), "..", "package", "assets")
    os.makedirs(out, exist_ok=True)
    count = 0
    for (w, h) in SIZES:
        for cname, rgb in COLORS.items():
            for dead in (False, True):
                suffix = "_dead" if dead else ""
                name = f"fish_{w}x{h}_{cname}{suffix}.png"
                sprite = draw_fish(w, h, rgb, dead)
                sprite.save(os.path.join(out, name))
                count += 1
                if not dead:
                    # 左朝向：调头折返时换图（LVGL 无水平镜像 API）
                    sprite.transpose(Image.FLIP_LEFT_RIGHT).save(
                        os.path.join(out, f"fish_{w}x{h}_{cname}_left.png"))
                    count += 1
    # 水草 / 小虾米装饰
    for name, w, h, blades, phase in (
        ("weed_a", 16, 36, 2, 0.0),
        ("weed_b", 12, 26, 2, 1.3),
        ("weed_c", 10, 18, 1, 2.6),
    ):
        draw_weed(w, h, blades, phase).save(os.path.join(out, f"{name}.png"))
        count += 1
    draw_shrimp(12, 8).save(os.path.join(out, "shrimp.png"))
    draw_shrimp(12, 8, flip=True).save(os.path.join(out, "shrimp_left.png"))
    count += 2
    draw_zcode_logo().save(os.path.join(out, "tm_zcode.png"))
    count += 1
    print(f"generated {count} sprites -> {os.path.abspath(out)}")


if __name__ == "__main__":
    main()
