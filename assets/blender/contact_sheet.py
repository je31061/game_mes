# -*- coding: utf-8 -*-
"""
Factory World — 스프라이트 컨택트 시트 (육안 검증용). owner: 한도윤

  python assets/blender/contact_sheet.py                       # public/assets/equipment/*.png + manifest → out/contact_{dark,light}.png
  python assets/blender/contact_sheet.py --work                 # assets/blender/out/<type>_body.png (후처리 전 본체)
  python assets/blender/contact_sheet.py --types stacker,winder --scale 4

각 칸: 스프라이트를 정수 배(기본 3배, NEAREST)로 확대하고 타일 마름모(64×32, 중심 앵커)·램프 원(r5)·labelY 선을 겹친다.
다크(#1e2230)·라이트(#f4f4f6) 배경 두 장을 만든다. 산출은 assets/blender/out/ (커밋 제외).
"""
import os
import sys
import json
import argparse
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
TYPES = ['press', 'welder', 'robot', 'assembly', 'inspector', 'packer', 'cnc',
         'stacker', 'winder', 'vpi', 'oven', 'magnetizer', 'balancer', 'dispenser', 'smt']


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--work', action='store_true', help='후처리 전 본체(_body.png) 시트')
    p.add_argument('--types', default='')
    p.add_argument('--scale', type=int, default=3)
    p.add_argument('--cols', type=int, default=5)
    p.add_argument('--out', default=os.path.join(HERE, 'out'))
    a = p.parse_args()
    types = [t for t in a.types.split(',') if t] or TYPES
    src_dir = os.path.join(HERE, 'out') if a.work else os.path.join(ROOT, 'public', 'assets', 'equipment')
    manifest = {}
    mp = os.path.join(ROOT, 'public', 'assets', 'equipment', 'manifest.json')
    if os.path.exists(mp):
        with open(mp, encoding='utf-8') as f:
            manifest = json.load(f).get('types', {})
    meta = {}
    mt = os.path.join(HERE, 'out', 'meta.json')
    if os.path.exists(mt):
        with open(mt, encoding='utf-8') as f:
            meta = json.load(f).get('types', {})
    S, C, ax, ay = a.scale, 192, 96, 150
    cell = C * S
    rows = (len(types) + a.cols - 1) // a.cols
    for bgname, bg, fg in (('dark', (30, 34, 48, 255), (235, 235, 240)), ('light', (244, 244, 246, 255), (30, 30, 40))):
        sheet = Image.new('RGBA', (a.cols * cell, rows * cell), bg)
        d = ImageDraw.Draw(sheet)
        for i, t in enumerate(types):
            fn = os.path.join(src_dir, t + ('_body.png' if a.work else '.png'))
            ox, oy = (i % a.cols) * cell, (i // a.cols) * cell
            if not os.path.exists(fn):
                d.text((ox + 8, oy + 8), t + ' (없음)', fill=(255, 80, 80))
                continue
            im = Image.open(fn).convert('RGBA').resize((cell, cell), Image.NEAREST)
            sheet.alpha_composite(im, (ox, oy))
            # 타일 마름모
            pts = [(ax, ay - 16), (ax + 32, ay), (ax, ay + 16), (ax - 32, ay)]
            d.polygon([(ox + x * S, oy + y * S) for x, y in pts], outline=(0, 200, 255))
            lamp = (manifest.get(t) or {}).get('lamp') or (meta.get(t) or {}).get('lamp_px')
            if lamp:
                lx, ly = (lamp['x'], lamp['y']) if isinstance(lamp, dict) else lamp
                r = 5 * S
                d.ellipse([ox + lx * S - r, oy + ly * S - r, ox + lx * S + r, oy + ly * S + r], outline=(0, 255, 90), width=2)
            label_y = (manifest.get(t) or {}).get('labelY')
            if label_y is not None:
                d.line([(ox, oy + label_y * S), (ox + cell, oy + label_y * S)], fill=(255, 120, 200))
            d.text((ox + 6, oy + 6), t, fill=fg)
        os.makedirs(a.out, exist_ok=True)
        path = os.path.join(a.out, 'contact_%s%s.png' % ('body_' if a.work else '', bgname))
        sheet.save(path)
        print('[sheet]', path, sheet.size)


if __name__ == '__main__':
    main()
