# -*- coding: utf-8 -*-
"""生成剧库的启动图标：紫底 + 白「剧」字。

跑一次就好，产物直接覆盖 app/src/main/res/mipmap-*/。
"""
import os

from PIL import Image, ImageDraw, ImageFont

SIZES = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
RES = os.path.abspath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), '..', 'app', 'src', 'main', 'res'))

FONTS = [
    r'C:\Windows\Fonts\msyhbd.ttc',
    r'C:\Windows\Fonts\msyh.ttc',
    r'C:\Windows\Fonts\simhei.ttf',
]

BG = (124, 58, 237, 255)   # #7C3AED
FG = (255, 255, 255, 255)

# 超采样倍数：先画大图再缩，边缘才不会有锯齿
SS = 8


def pick_font():
    for p in FONTS:
        if os.path.exists(p):
            return p
    return None


def render(size, circular):
    s = size * SS
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if circular:
        d.ellipse([0, 0, s - 1, s - 1], fill=BG)
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=BG)

    fp = pick_font()
    if fp:
        # 圆形图标里字要缩一点，否则四角会被切掉
        ratio = 0.52 if circular else 0.62
        font = ImageFont.truetype(fp, int(s * ratio))
        text = '剧'
        box = d.textbbox((0, 0), text, font=font)
        w, h = box[2] - box[0], box[3] - box[1]
        d.text(((s - w) / 2 - box[0], (s - h) / 2 - box[1]), text, font=font, fill=FG)

    return img.resize((size, size), Image.LANCZOS)


def main():
    for name, px in SIZES.items():
        out_dir = os.path.join(RES, 'mipmap-' + name)
        os.makedirs(out_dir, exist_ok=True)
        render(px, False).save(os.path.join(out_dir, 'ic_launcher.png'))
        render(px, True).save(os.path.join(out_dir, 'ic_launcher_round.png'))
        print('mipmap-%-8s %3dpx' % (name, px))
    print('图标已生成 -> ' + RES)


if __name__ == '__main__':
    main()
