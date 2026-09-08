# -*- coding: utf-8 -*-
"""
Factory World — 렌더 후처리 (PIL + numpy). owner: 한도윤 (docs/team/인터페이스.md §2)

입력(--work): <type>_body.png, <type>_shadow.png, _calib.png, meta.json  (build_equipment.py 산출)
출력(--out):  <type>.png (192×192 RGBA), manifest.json

하는 일
 1. _calib.png 의 마름모를 측정해 폭≈64·높이≈32·중심≈(96,150) 검증. 어긋나면 정수 오프셋으로 전 스프라이트 정렬.
 2. 본체: 알파 ≥ 96 실루엣 주위 1px 어두운 윤곽(다크·라이트 테마 대비).
 3. 그림자: shadow.png 휘도(밝은 바닥 대비 어두운 정도) → 알파 28~60 밴드(24 미만이면 게임 클릭이 통과), 앵커 중심 접지 타원 합성.
 4. 검증: 빈 이미지·검은 사각형·캔버스 밖 잘림·상단 y<10·파일 크기 합계 2MB 초과 → 실패(exit 1).
 5. manifest.json: version 1, tile, anchor, types[type] = { file, lamp{x,y}, labelY }.
"""
import os
import sys
import json
import argparse
import numpy as np
from PIL import Image, ImageFilter

CANVAS = 192
ANCHOR = (96, 150)
TILE_W, TILE_H = 64, 32
SHADOW_RGB = (18, 22, 34)
SHADOW_A_MIN, SHADOW_A_MAX = 28, 60      # 게임 alphaTolerance 24 → 최소 28
OUTLINE_RGB = (16, 18, 24)
OUTLINE_A = 225
TYPES = ['press', 'welder', 'robot', 'assembly', 'inspector', 'packer', 'cnc']


def load_rgba(path):
    return np.asarray(Image.open(path).convert('RGBA')).astype(np.float32)


def measure_calib(path):
    a = load_rgba(path)[..., 3] > 40      # 마름모 꼭짓점은 얇아 AA로 알파가 낮음
    ys, xs = np.nonzero(a)
    if len(xs) == 0:
        raise SystemExit('_calib.png 이 비어 있음 — 카메라/렌더 실패')
    w = xs.max() - xs.min() + 1
    h = ys.max() - ys.min() + 1
    cx = (xs.min() + xs.max() + 1) / 2
    cy = (ys.min() + ys.max() + 1) / 2
    return w, h, cx, cy


def shift(img, dx, dy):
    """정수 픽셀 이동(빈 곳은 투명)."""
    if dx == 0 and dy == 0:
        return img
    out = np.zeros_like(img)
    h, w = img.shape[:2]
    sx0, sx1 = max(0, -dx), min(w, w - dx)
    sy0, sy1 = max(0, -dy), min(h, h - dy)
    out[sy0 + dy:sy1 + dy, sx0 + dx:sx1 + dx] = img[sy0:sy1, sx0:sx1]
    return out


def outline(body):
    """실루엣(알파≥96)을 1px 팽창한 띠를 어두운 윤곽으로 깔고 본체를 그 위에 합성."""
    a = body[..., 3]
    sil = Image.fromarray((a >= 96).astype(np.uint8) * 255)
    dil = np.asarray(sil.filter(ImageFilter.MaxFilter(3))) > 0
    band = dil & ~(a >= 96)
    ol = np.zeros_like(body)
    ol[band, :3] = OUTLINE_RGB
    ol[band, 3] = OUTLINE_A
    return over(body, ol)


def over(top, bottom):
    """straight-alpha 'top over bottom' (float 0..255)."""
    ta = top[..., 3:4] / 255.0
    ba = bottom[..., 3:4] / 255.0
    oa = ta + ba * (1 - ta)
    rgb = np.where(oa > 0, (top[..., :3] * ta + bottom[..., :3] * ba * (1 - ta)) / np.maximum(oa, 1e-6), 0)
    return np.concatenate([rgb, oa * 255.0], axis=-1)


def shadow_layer(shadow_png, body_alpha):
    """바닥 렌더의 휘도로 그림자 강도(0..1)를 만들고 알파 밴드로 바꾼 뒤 접지 타원과 합침."""
    s = load_rgba(shadow_png)
    lum = (0.2126 * s[..., 0] + 0.7152 * s[..., 1] + 0.0722 * s[..., 2]) / 255.0
    valid = s[..., 3] > 200                      # 홀드아웃(설비 실루엣)은 제외
    if valid.sum() < 100:
        raise SystemExit('shadow 렌더가 비어 있음: ' + shadow_png)
    lit = np.percentile(lum[valid], 97)
    strength = np.clip(1 - lum / max(lit, 1e-3), 0, 1)
    strength[~valid] = 0
    peak = np.percentile(strength[valid], 99.7)
    if peak > 0.05:
        strength = np.clip(strength / peak, 0, 1)
    # 살짝 블러 → 부드러운 반그림자
    strength = np.asarray(Image.fromarray((strength * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.0))).astype(np.float32) / 255.0
    cast = np.where(strength > 0.18, SHADOW_A_MIN + (SHADOW_A_MAX - SHADOW_A_MIN) * np.clip((strength - 0.18) / 0.82, 0, 1), 0)

    # 접지 타원(앵커 중심, 타일 마름모보다 약간 큼): 중심 52 → 가장자리 28
    yy, xx = np.mgrid[0:CANVAS, 0:CANVAS]
    r = np.sqrt(((xx + 0.5 - ANCHOR[0]) / 40.0) ** 2 + ((yy + 0.5 - ANCHOR[1]) / 20.0) ** 2)
    contact = np.where(r < 1.0, SHADOW_A_MIN + (52 - SHADOW_A_MIN) * np.clip(1 - r, 0, 1) ** 0.6, 0)
    alpha = np.maximum(cast, contact)
    # 그림자는 캔버스 밖으로 나가지 않게 아래쪽 여백 유지
    alpha[CANVAS - 2:, :] = 0
    layer = np.zeros((CANVAS, CANVAS, 4), np.float32)
    layer[..., :3] = SHADOW_RGB
    layer[..., 3] = alpha
    return layer


def verify(name, img, path, top_limit=10):
    a = img[..., 3]
    ys, xs = np.nonzero(a >= 128)
    problems = []
    if len(xs) < 400:
        problems.append('불투명 픽셀 %d개 — 빈 이미지' % len(xs))
    else:
        rgb = img[..., :3][a >= 128]
        if rgb.mean() < 12:
            problems.append('평균 밝기 %.1f — 검은 사각형/조명 실패' % rgb.mean())
        if xs.min() <= 0 or xs.max() >= CANVAS - 1:
            problems.append('좌우 캔버스 밖 잘림 x=%d..%d' % (xs.min(), xs.max()))
        if ys.min() < top_limit:
            problems.append('상단 y=%d < %d' % (ys.min(), top_limit))
        if ys.max() >= CANVAS - 1:
            problems.append('하단 캔버스 밖 잘림')
        # 발자국: 바닥 마름모(폭 64) 부근에 불투명 픽셀이 있어야 함
        band = (a[ANCHOR[1] - 24:ANCHOR[1] + 8, ANCHOR[0] - 32:ANCHOR[0] + 32] >= 128).sum()
        if band < 200:
            problems.append('앵커 주변 불투명 픽셀 %d — 정렬 의심' % band)
    size = os.path.getsize(path)
    return problems, size, (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--work', default='assets/blender/out')
    p.add_argument('--out', default='public/assets/equipment')
    p.add_argument('--types', default='')
    args = p.parse_args()
    work, out = os.path.abspath(args.work), os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(work, 'meta.json'), encoding='utf-8') as f:
        meta = json.load(f)
    types = [t for t in args.types.split(',') if t] or [t for t in TYPES if t in meta['types']]

    # 1. 캘리브레이션
    w, h, cx, cy = measure_calib(os.path.join(work, '_calib.png'))
    dx, dy = int(round(ANCHOR[0] - cx)), int(round(ANCHOR[1] - cy))
    print('[post] calib diamond: %dx%d px, center (%.1f, %.1f) → offset (%d, %d); meta origin %s' % (w, h, cx, cy, dx, dy, meta.get('origin_px')))
    if abs(w - TILE_W) > 2 or abs(h - TILE_H) > 2:
        raise SystemExit('[post] 마름모 규격 불일치: %dx%d (기대 %dx%d). 카메라 각도/ortho_scale 확인' % (w, h, TILE_W, TILE_H))
    if abs(dx) > 8 or abs(dy) > 8:
        raise SystemExit('[post] 앵커 오프셋 과다 (%d,%d) — shift_y 확인' % (dx, dy))

    # 2~5. 유형별 합성
    manifest_path = os.path.join(out, 'manifest.json')
    manifest = {'version': 1, 'tile': {'w': TILE_W, 'h': TILE_H}, 'anchor': {'x': ANCHOR[0], 'y': ANCHOR[1]}, 'types': {}}
    if os.path.exists(manifest_path):
        try:
            with open(manifest_path, encoding='utf-8') as f:
                old = json.load(f)
            if isinstance(old.get('types'), dict):
                manifest['types'] = old['types']       # 부분 렌더 시 기존 유형 유지
        except Exception:
            pass

    total, failed, report = 0, [], []
    for t in types:
        body = shift(load_rgba(os.path.join(work, t + '_body.png')), dx, dy)
        sh = shift(shadow_layer(os.path.join(work, t + '_shadow.png'), body[..., 3]), dx, dy)
        img = over(outline(body), sh)
        img = np.clip(np.rint(img), 0, 255).astype(np.uint8)
        path = os.path.join(out, t + '.png')
        Image.fromarray(img, 'RGBA').save(path, optimize=True)
        problems, size, bbox = verify(t, img.astype(np.float32), path)
        total += size
        lamp = meta['types'][t]['lamp_px']
        lx, ly = int(round(lamp[0] + dx)), int(round(lamp[1] + dy))
        top = bbox[1] if bbox else CANVAS
        label_y = max(8, min(top - 10, ly - 16))
        manifest['types'][t] = {'file': t + '.png', 'lamp': {'x': lx, 'y': ly}, 'labelY': int(label_y)}
        line = '[post] %-9s %6d B bbox=%s lamp=(%d,%d) labelY=%d %s' % (t, size, bbox, lx, ly, label_y, ('FAIL: ' + '; '.join(problems)) if problems else 'OK')
        print(line)
        report.append(line)
        if problems:
            failed.append(t)

    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('[post] manifest → %s (%d types), PNG 합계 %.1f KB' % (manifest_path, len(manifest['types']), total / 1024))
    if total > 2 * 1024 * 1024:
        failed.append('size>2MB')
    if failed:
        print('[post] FAILED:', failed)
        sys.exit(1)


if __name__ == '__main__':
    main()
