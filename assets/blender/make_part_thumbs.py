# -*- coding: utf-8 -*-
"""
Factory World — 분해도 서브어셈블리 이미지 → HUD 썸네일 (PIL). owner: 한도윤 (docs/team/인터페이스.md §8 썸네일)

입력: public/assets/parts/<PN>.png  (PM이 PDF에서 추출한 325×484 카드. 투명 배경 위 흰 정사각 카드(약 260px) + 부드러운 그림자)
출력: public/assets/parts/thumb/<PN>.png  (96×96 RGBA, 흰 배경 유지, 1px 회색 테두리 — 다크 테마에서도 카드가 보이게)

  python assets/blender/make_part_thumbs.py [--size 96] [--pad 0.08] [--border 1]

방식: 흰 카드 영역(밝기 ≥ 250 픽셀의 행·열 프로파일) 안에서 콘텐츠(밝기 < 235) bbox를 찾고,
      긴 변 기준 정사각 + 여백(pad)으로 자른 뒤 LANCZOS 축소. 원본은 건드리지 않는다.
"""
import os
import sys
import argparse
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
SRC = os.path.join(ROOT, 'public', 'assets', 'parts')
DST = os.path.join(SRC, 'thumb')
BORDER_RGB = (150, 154, 164)      # 다크(#1e2230)·라이트(#f4f4f6) 양쪽에서 보이는 중간 회색


def card_and_content(img):
    """(카드 bbox, 콘텐츠 bbox) — 좌표는 (x0, y0, x1, y1) 포함 범위."""
    a = np.asarray(img.convert('RGBA')).astype(int)
    rgb, alpha = a[..., :3], a[..., 3]
    white = (rgb.min(axis=2) >= 250) & (alpha >= 250)
    rows = np.nonzero(white.sum(axis=1) > white.shape[1] * 0.5)[0]
    cols = np.nonzero(white.sum(axis=0) > white.shape[0] * 0.3)[0]
    if len(rows) == 0 or len(cols) == 0:
        raise SystemExit('흰 카드 영역을 찾지 못함')
    cy0, cy1, cx0, cx1 = rows.min(), rows.max(), cols.min(), cols.max()
    sub = rgb[cy0:cy1 + 1, cx0:cx1 + 1]
    content = (sub.min(axis=2) < 235)
    ys, xs = np.nonzero(content)
    if len(xs) == 0:
        raise SystemExit('카드 안에 콘텐츠 없음')
    return (tuple(int(v) for v in (cx0, cy0, cx1, cy1)),
            tuple(int(v) for v in (cx0 + xs.min(), cy0 + ys.min(), cx0 + xs.max(), cy0 + ys.max())))


def make_thumb(path, size, pad, border):
    img = Image.open(path)
    card, (x0, y0, x1, y1) = card_and_content(img)
    w, h = x1 - x0 + 1, y1 - y0 + 1
    side = int(round(max(w, h) * (1 + 2 * pad)))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    # 흰 배경 캔버스에 카드 영역만 붙인 뒤 정사각 크롭(카드 밖은 흰색으로 채움)
    base = Image.new('RGBA', img.size, (255, 255, 255, 255))
    card_img = img.convert('RGBA').crop((card[0], card[1], card[2] + 1, card[3] + 1))
    base.paste(card_img, (card[0], card[1]))
    left, top = int(round(cx - side / 2)), int(round(cy - side / 2))
    sq = Image.new('RGBA', (side, side), (255, 255, 255, 255))
    sq.paste(base.crop((left, top, left + side, top + side)), (0, 0))
    inner = size - 2 * border
    th = sq.resize((inner, inner), Image.LANCZOS)
    out = Image.new('RGBA', (size, size), (255, 255, 255, 255))
    out.paste(th, (border, border))
    if border:
        d = ImageDraw.Draw(out)
        for i in range(border):
            d.rectangle([i, i, size - 1 - i, size - 1 - i], outline=BORDER_RGB + (255,))
    return out, card, (x0, y0, x1, y1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--size', type=int, default=96)
    p.add_argument('--pad', type=float, default=0.08)
    p.add_argument('--border', type=int, default=1)
    a = p.parse_args()
    os.makedirs(DST, exist_ok=True)
    files = sorted(f for f in os.listdir(SRC) if f.lower().endswith('.png'))
    if not files:
        raise SystemExit('원본 없음: ' + SRC)
    total = 0
    for f in files:
        src = os.path.join(SRC, f)
        out, card, bbox = make_thumb(src, a.size, a.pad, a.border)
        dst = os.path.join(DST, f)
        out.save(dst, optimize=True)
        sz = os.path.getsize(dst)
        total += sz
        print('[thumb] %-12s card=%s content=%s → %s %dx%d %5d B' % (f, card, bbox, os.path.relpath(dst, ROOT), out.size[0], out.size[1], sz))
    print('[thumb] %d장, 합계 %.1f KB → %s' % (len(files), total / 1024, os.path.relpath(DST, ROOT)))


if __name__ == '__main__':
    main()
