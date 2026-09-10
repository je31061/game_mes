# -*- coding: utf-8 -*-
"""
Factory World — 설비 유형 15종 절차 모델 + 아이소메트릭 스프라이트 렌더 (Blender 5.2 bpy)
owner: 한도윤 (docs/team/인터페이스.md §2 규격, §9 BLDC 라인 신규 유형 8종)

유형: 스프린트 1 — press, welder, robot, assembly, inspector, packer, cnc
      스프린트 2 — stacker(자동 적층기), winder(니들 와인더), vpi(진공 함침조), oven(열풍 건조로),
                   magnetizer(착자기), balancer(밸런싱 머신), dispenser(접착 디스펜서 지그), smt(SMT 결선 라인)

실행:
  "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" -b -P assets/blender/build_equipment.py -- \
      --out public/assets/equipment [--work assets/blender/out] [--engine eevee|cycles] [--types press,cnc] [--samples N]

산출(작업 폴더 --work):
  <type>_body.png    설비 본체 (투명 배경)
  <type>_shadow.png  바닥만 렌더(설비는 카메라에 안 보이고 그림자만 드리움) → postprocess가 그림자 알파로 변환
  _calib.png         타일 1칸 마름모 (앵커·2:1 검증용)
  meta.json          램프·원점·타일 꼭짓점의 픽셀 투영 좌표, 엔진, 카메라 정보
마지막에 시스템 python으로 postprocess.py를 호출해 --out 에 <type>.png + manifest.json 을 쓴다(--no-post 로 생략).

규격 요약: 192×192 RGBA, 직교 카메라, 타일 1칸 = 바닥 마름모 64×32px, 마름모 중심 = 앵커 (96,150).
카메라 X 회전은 60°(cos60°=0.5 → 정확히 2:1). 인터페이스 §2의 63.435°는 2.236:1(마름모 높이 28.6px)이 되어
규격(64×32)과 어긋나므로 60°를 쓴다 — 협업로그에 제안함. --cam-rx 로 바꿔 _calib.png 로 확인 가능.
"""
import bpy
import bmesh
import sys
import os
import json
import math
import time
import shutil
import argparse
import subprocess
from mathutils import Vector, Euler
from bpy_extras.object_utils import world_to_camera_view

# ── 규격 ─────────────────────────────────────────────
TILE = 2.0                     # 타일 한 변(월드 단위). 설비 발자국은 ±1.0 안쪽
CANVAS = 192
TILE_PX_W = 64
ANCHOR = (96, 150)
CAM_RX_DEFAULT = 60.0          # 2:1 디메트릭
TYPES = ['press', 'welder', 'robot', 'assembly', 'inspector', 'packer', 'cnc',
         'stacker', 'winder', 'vpi', 'oven', 'magnetizer', 'balancer', 'dispenser', 'smt']


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser()
    p.add_argument('--out', default='public/assets/equipment', help='최종 스프라이트·매니페스트 폴더')
    p.add_argument('--work', default='assets/blender/out', help='중간 렌더 폴더(커밋 제외)')
    p.add_argument('--engine', default='eevee', choices=['eevee', 'cycles'])
    p.add_argument('--samples', type=int, default=0, help='0이면 엔진 기본(EEVEE 32, Cycles 64)')
    p.add_argument('--types', default='', help='쉼표 구분 부분 렌더')
    p.add_argument('--cam-rx', type=float, default=CAM_RX_DEFAULT)
    p.add_argument('--no-post', action='store_true')
    return p.parse_args(argv)


# ── 재질 ─────────────────────────────────────────────
M = {}


def mat(name, color, metallic=0.0, rough=0.5, emit=None, emit_str=0.0, alpha=1.0):
    if name in M:
        return M[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1.0)
    bsdf.inputs['Metallic'].default_value = metallic
    bsdf.inputs['Roughness'].default_value = rough
    if emit is not None:
        bsdf.inputs['Emission Color'].default_value = (*emit, 1.0)
        bsdf.inputs['Emission Strength'].default_value = emit_str
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        try:
            m.surface_render_method = 'BLENDED'   # EEVEE Next
        except Exception:
            pass
        try:
            m.use_transparent_shadow = True       # 투명 가드가 그림자 패스에 검게 찍히지 않게
        except Exception:
            pass
    M[name] = m
    return m


def make_materials():
    mat('frame', (0.30, 0.31, 0.34), 0.35, 0.55)        # 회색 프레임
    mat('dark', (0.045, 0.05, 0.06), 0.2, 0.6)          # 검정 부품·베이스
    mat('steel', (0.62, 0.64, 0.68), 0.9, 0.32)         # 금속(램·롤러)
    mat('yellow', (1.0, 0.70, 0.02), 0.0, 0.5)          # 안전 황색 가드
    mat('red', (0.85, 0.04, 0.03), 0.0, 0.4)            # 비상정지
    mat('white', (0.86, 0.87, 0.89), 0.0, 0.45)
    mat('cream', (0.90, 0.89, 0.84), 0.0, 0.45)         # CNC 외장
    mat('press', (0.12, 0.17, 0.30), 0.1, 0.5)          # 프레스 도장(청회색)
    mat('weld', (0.05, 0.30, 0.72), 0.1, 0.45)          # 용접기(청색)
    mat('robot', (0.95, 0.40, 0.03), 0.05, 0.42)        # 로봇(주황)
    mat('packer', (0.55, 0.66, 0.78), 0.05, 0.5)        # 포장기(연청회색)
    mat('green', (0.05, 0.36, 0.20), 0.0, 0.5)          # 스트라이프·가스통
    mat('belt', (0.08, 0.27, 0.18), 0.0, 0.85)          # 컨베이어 벨트(PVC 녹색 — 다크 테마에서도 보이게)
    mat('tan', (0.72, 0.52, 0.28), 0.0, 0.7)            # 골판지 상자
    mat('glass', (0.03, 0.06, 0.10), 0.7, 0.15)         # 검은 창
    mat('screen', (0.05, 0.12, 0.25), 0.0, 0.3, emit=(0.25, 0.55, 1.0), emit_str=1.5)
    mat('led', (0.9, 0.9, 0.9), 0.0, 0.3, emit=(1.0, 1.0, 0.95), emit_str=3.0)
    mat('amber', (0.95, 0.55, 0.10), 0.0, 0.6, alpha=0.75)   # 용접 차광막
    # 스프린트 2 (BLDC 라인)
    mat('copper', (0.92, 0.52, 0.20), 0.55, 0.45)       # 권선·착자 코일·와이어 스풀 (금속성 낮춰 밝게)
    mat('teal', (0.05, 0.42, 0.46), 0.1, 0.45)          # 니들 와인더 본체
    mat('oven', (0.70, 0.67, 0.62), 0.0, 0.5)           # 건조로 챔버(웜그레이)
    mat('clear', (0.60, 0.80, 0.92), 0.0, 0.1, alpha=0.30)   # 밸런서 투명 안전 후드
    mat('heatglass', (0.35, 0.10, 0.02), 0.0, 0.3, emit=(1.0, 0.35, 0.05), emit_str=1.6)   # 건조로 창(내부 열 발광)
    mat('ground', (0.5, 0.5, 0.5), 0.0, 1.0)
    mat('calib', (1, 1, 1), 0.0, 1.0, emit=(1, 1, 1), emit_str=1.0)


# ── 지오메트리 헬퍼 ────────────────────────────────────
CUR = {'col': None}
_n = [0]


def _name(base):
    _n[0] += 1
    return '%s_%03d' % (base, _n[0])


def add_obj(base, data):
    o = bpy.data.objects.new(_name(base), data)
    CUR['col'].objects.link(o)
    return o


def box(base, size, loc=(0, 0, 0), m=None, rot=(0, 0, 0), bottom=True, bevel=0.02):
    """직육면체. bottom=True면 원점이 바닥 중심(로컬 +Z 방향으로 자람) — 팔·기둥 회전에 편함."""
    sx, sy, sz = size
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z = v.co.z * sz + (sz / 2 if bottom else 0)
    me = bpy.data.meshes.new(_name(base))
    bm.to_mesh(me)
    bm.free()
    if m:
        me.materials.append(m)
    o = add_obj(base, me)
    o.location = loc
    o.rotation_euler = Euler([math.radians(a) for a in rot], 'XYZ')
    if bevel and min(size) > 0.05:
        md = o.modifiers.new('bv', 'BEVEL')
        md.width = min(bevel, min(size) / 4)
        md.segments = 2
        md.limit_method = 'ANGLE'
    return o


def cyl(base, r, h, loc=(0, 0, 0), m=None, rot=(0, 0, 0), bottom=True, seg=24, r2=None):
    """원기둥(원뿔). 로컬 Z축이 축. bottom=True면 원점이 아래 캡 중심."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=seg,
                          radius1=r, radius2=(r if r2 is None else r2), depth=h)
    if bottom:
        for v in bm.verts:
            v.co.z += h / 2
    me = bpy.data.meshes.new(_name(base))
    bm.to_mesh(me)
    bm.free()
    if m:
        me.materials.append(m)
    o = add_obj(base, me)
    o.location = loc
    o.rotation_euler = Euler([math.radians(a) for a in rot], 'XYZ')
    return o


def tube(base, pts, r, m):
    """베지어 곡선 튜브(호스·케이블)."""
    cu = bpy.data.curves.new(_name(base), 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = r
    cu.bevel_resolution = 3
    cu.fill_mode = 'FULL'
    sp = cu.splines.new('BEZIER')
    sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = p
        bp.handle_left_type = 'AUTO'
        bp.handle_right_type = 'AUTO'
    cu.materials.append(m)
    return add_obj(base, cu)


def estop(pos, facing='-y'):
    """비상정지: 황색 판 + 적색 버튼. pos = 판이 붙는 면 위의 점."""
    x, y, z = pos
    if facing == '-y':
        box('estop_plate', (0.16, 0.035, 0.16), (x, y - 0.017, z - 0.08), M['yellow'], bevel=0)
        cyl('estop_btn', 0.055, 0.045, (x, y - 0.035, z), M['red'], rot=(90, 0, 0))
    elif facing == '+x':
        box('estop_plate', (0.035, 0.16, 0.16), (x + 0.017, y, z - 0.08), M['yellow'], bevel=0)
        cyl('estop_btn', 0.055, 0.045, (x + 0.035, y, z), M['red'], rot=(0, 90, 0))


def stacklight(pos):
    """경광등 몸통(기둥+검은 몸통+캡). 반환: 게임이 램프 원을 그릴 월드 좌표."""
    x, y, z = pos
    cyl('lamp_post', 0.025, 0.28, (x, y, z), M['steel'], seg=12)
    cyl('lamp_body', 0.085, 0.30, (x, y, z + 0.28), M['dark'], seg=16)
    cyl('lamp_cap', 0.10, 0.03, (x, y, z + 0.58), M['dark'], seg=16)
    return Vector((x, y, z + 0.28 + 0.16))


def legs(x0, x1, y0, y1, h, size=0.06, m=None):
    for (x, y) in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        box('leg', (size, size, h), (x, y, 0), m or M['frame'], bevel=0)


# ── 설비 7종 ──────────────────────────────────────────
def build_press():
    """C-프레임 프레스: 베드 + 뒤 기둥 + 크라운 + 상하 램, 플라이휠, 전면 라이트커튼(황색)."""
    box('bedplate', (1.7, 1.3, 0.2), (0, 0.05, 0), M['dark'])
    box('bolster', (1.15, 0.9, 0.45), (0, -0.05, 0.2), M['press'])
    box('die_lo', (0.72, 0.5, 0.12), (0, -0.15, 0.65), M['steel'])
    box('column', (1.3, 0.55, 2.35), (0, 0.45, 0.2), M['press'])
    box('crown', (1.3, 1.35, 0.6), (0, 0.05, 2.2), M['press'])
    box('ram', (0.78, 0.6, 0.58), (0, -0.15, 1.35), M['frame'])
    box('die_up', (0.72, 0.5, 0.12), (0, -0.15, 1.23), M['steel'])
    box('guide', (0.12, 0.12, 0.85), (-0.5, -0.15, 1.35), M['steel'], bevel=0)
    box('guide', (0.12, 0.12, 0.85), (0.5, -0.15, 1.35), M['steel'], bevel=0)
    cyl('flywheel', 0.34, 0.2, (0.66, 0.45, 2.15), M['dark'], rot=(0, 90, 0))
    cyl('fly_hub', 0.1, 0.3, (0.66, 0.45, 2.15), M['steel'], rot=(0, 90, 0))
    box('panel', (0.4, 0.06, 0.5), (-0.45, -0.66, 1.95), M['frame'])
    for x in (-0.66, 0.66):
        box('lightcurtain', (0.09, 0.09, 1.5), (x, -0.62, 0.2), M['yellow'], bevel=0)
    box('stripe', (1.7, 0.02, 0.08), (0, -0.7, 0.1), M['yellow'], bevel=0)
    estop((0.42, -0.625, 2.45), '-y')
    return stacklight((0.42, 0.45, 2.8))


def build_welder():
    """용접기: 청색 전원 캐비닛 + 와이어 피더 + 가스통 + 토치·호스 + 작업대 + 황색 차광막."""
    box('cab_base', (1.05, 0.8, 0.08), (0.3, 0.35, 0), M['dark'])
    box('cabinet', (1.0, 0.75, 1.05), (0.3, 0.35, 0.08), M['weld'])
    box('cab_panel', (0.55, 0.03, 0.55), (0.3, -0.03, 0.4), M['dark'])
    box('cab_vent', (0.03, 0.5, 0.6), (0.81, 0.35, 0.3), M['dark'], bevel=0)
    box('feeder', (0.55, 0.42, 0.3), (0.35, 0.42, 1.13), M['frame'])
    cyl('spool', 0.17, 0.08, (0.0, 0.42, 1.3), M['steel'], rot=(0, 90, 0), bottom=False)
    cyl('gas', 0.14, 1.45, (-0.55, 0.62, 0), M['green'], seg=20)
    cyl('gas_neck', 0.06, 0.14, (-0.55, 0.62, 1.45), M['steel'], seg=12)
    box('gas_reg', (0.12, 0.12, 0.1), (-0.5, 0.55, 1.5), M['dark'], bevel=0)
    box('table', (0.9, 0.62, 0.06), (-0.35, -0.45, 0.72), M['steel'])
    legs(-0.75, 0.05, -0.72, -0.18, 0.72)
    box('workpiece', (0.45, 0.2, 0.1), (-0.35, -0.45, 0.78), M['frame'])
    box('clamp', (0.12, 0.12, 0.16), (-0.6, -0.5, 0.78), M['dark'], bevel=0)
    tube('hose', [(0.15, 0.3, 1.2), (-0.05, 0.05, 1.3), (-0.25, -0.25, 1.15), (-0.32, -0.42, 0.95)], 0.022, M['dark'])
    cyl('torch', 0.035, 0.28, (-0.32, -0.42, 0.85), M['steel'], rot=(-20, 0, 0), seg=12)
    cyl('torch_tip', 0.02, 0.1, (-0.32, -0.42, 0.85), M['dark'], rot=(-20, 0, 0), seg=8)
    box('screen', (0.05, 1.4, 1.55), (-0.92, 0.1, 0), M['amber'], bevel=0)
    box('screen_post', (0.07, 0.07, 1.6), (-0.92, 0.82, 0), M['frame'], bevel=0)
    box('screen_post', (0.07, 0.07, 1.6), (-0.92, -0.62, 0), M['frame'], bevel=0)
    estop((0.6, -0.025, 0.85), '-y')
    return stacklight((0.6, 0.55, 1.13))


def build_robot():
    """6축 다관절 로봇(주황) + 베이스 + 제어반 + 황색 안전펜스."""
    box('plate', (0.95, 0.95, 0.08), (0.1, 0.15, 0), M['dark'])
    cyl('base', 0.38, 0.32, (0.1, 0.15, 0.08), M['frame'])
    cyl('j1', 0.3, 0.36, (0.1, 0.15, 0.4), M['robot'])
    S = Vector((0.1, 0.15, 0.74))
    box('shoulder', (0.46, 0.34, 0.28), (S.x, S.y, S.z - 0.16), M['robot'])
    cyl('j2', 0.17, 0.5, (S.x, S.y, S.z), M['frame'], rot=(0, 90, 0), bottom=False)
    a1, L1 = 18.0, 1.1
    box('arm1', (0.26, 0.28, L1), S, M['robot'], rot=(a1, 0, 0))
    d1 = Euler((math.radians(a1), 0, 0)).to_matrix() @ Vector((0, 0, 1))
    E = S + d1 * L1
    cyl('j3', 0.16, 0.42, E, M['frame'], rot=(0, 90, 0), bottom=False)
    box('motor', (0.16, 0.2, 0.22), (E.x + 0.2, E.y + 0.05, E.z - 0.1), M['dark'])
    a2, L2 = 112.0, 0.8
    box('arm2', (0.2, 0.2, L2), E, M['robot'], rot=(a2, 0, 0))
    d2 = Euler((math.radians(a2), 0, 0)).to_matrix() @ Vector((0, 0, 1))
    W = E + d2 * L2
    cyl('wrist', 0.1, 0.2, W, M['frame'], rot=(a2, 0, 0), seg=16)
    T = W + d2 * 0.2
    cyl('tool', 0.055, 0.22, T, M['steel'], rot=(a2, 0, 0), seg=12)
    G = T + d2 * 0.22
    for dx in (-0.05, 0.05):
        box('finger', (0.03, 0.05, 0.12), (G.x + dx, G.y, G.z), M['dark'], rot=(a2, 0, 0), bevel=0)
    tube('cable', [(0.35, 0.3, 0.3), (0.42, 0.35, 0.8), (E.x + 0.25, E.y + 0.1, E.z + 0.15)], 0.02, M['dark'])
    box('ctrl', (0.5, 0.42, 0.95), (0.62, 0.62, 0), M['frame'])
    box('ctrl_screen', (0.24, 0.02, 0.16), (0.62, 0.4, 0.62), M['screen'], bevel=0)
    for (x, y) in ((-0.92, 0.92), (-0.05, 0.92), (0.92, 0.92), (-0.92, 0.0), (-0.92, -0.92)):
        box('fence_post', (0.06, 0.06, 1.25), (x, y, 0), M['yellow'], bevel=0)
    for z in (0.45, 1.2):
        box('fence_rail', (1.9, 0.035, 0.035), (0, 0.92, z), M['yellow'], bevel=0)
        box('fence_rail', (0.035, 1.9, 0.035), (-0.92, 0, z), M['yellow'], bevel=0)
    box('fence_mesh', (1.86, 0.01, 0.75), (0, 0.92, 0.45), M['frame'], bevel=0)
    box('fence_mesh', (0.01, 1.86, 0.75), (-0.92, 0, 0.45), M['frame'], bevel=0)
    estop((0.62, 0.41, 0.85), '-y')
    return stacklight((0.72, 0.7, 0.95))


def build_assembly():
    """조립 라인: X축 방향 컨베이어(벨트+양끝 롤러+측면 레일) + 갠트리 툴 + 뒤 황색 가드 + 조작 페데스탈."""
    L = 1.85
    box('base', (L - 0.15, 0.56, 0.2), (0, 0, 0), M['dark'], bevel=0)
    box('body', (L - 0.1, 0.6, 0.5), (0, 0, 0.2), M['frame'])            # 측면 스커트(덩어리감)
    box('bed', (L, 0.7, 0.1), (0, 0, 0.7), M['frame'])
    box('belt', (L - 0.08, 0.54, 0.06), (0, 0, 0.8), M['belt'], bevel=0.01)
    for y in (-0.34, 0.34):
        box('rail', (L, 0.05, 0.16), (0, y, 0.72), M['dark'], bevel=0)
    for x in (-0.93, 0.93):
        cyl('roller', 0.1, 0.66, (x, 0, 0.82), M['steel'], rot=(90, 0, 0), bottom=False, seg=16)
    for x in (-0.85, -0.05, 0.75):
        box('guard_post', (0.07, 0.07, 1.05), (x, 0.55, 0), M['yellow'], bevel=0)
    for z in (0.5, 1.0):
        box('guard_rail', (L - 0.2, 0.045, 0.045), (-0.05, 0.55, z), M['yellow'], bevel=0)
    box('guard_mesh', (L - 0.25, 0.01, 0.5), (-0.05, 0.55, 0.5), M['frame'], bevel=0)
    for i, x in enumerate((-0.58, -0.08, 0.5)):
        box('part', (0.3, 0.3, 0.16), (x, 0, 0.86), M['white'] if i % 2 else M['tan'], bevel=0.01)
    for y in (-0.46, 0.46):
        box('gantry_post', (0.13, 0.13, 1.65), (0.28, y, 0), M['frame'], bevel=0)
    box('gantry_beam', (0.17, 1.05, 0.17), (0.28, 0, 1.65), M['frame'])
    box('slide', (0.2, 0.3, 0.14), (0.28, 0, 1.51), M['dark'], bevel=0)
    box('head', (0.24, 0.24, 0.42), (0.28, 0, 1.1), M['weld'])
    cyl('nozzle', 0.035, 0.14, (0.28, 0, 0.96), M['steel'], seg=8)
    box('pedestal', (0.36, 0.3, 0.95), (0.66, -0.6, 0), M['frame'])
    box('ped_screen', (0.3, 0.03, 0.2), (0.66, -0.76, 0.72), M['screen'], rot=(20, 0, 0), bevel=0)
    estop((0.66, -0.75, 0.5), '-y')
    return stacklight((0.28, 0.42, 1.82))


def build_inspector():
    """검사기: 짧은 컨베이어 위 비전 게이트(백색 기둥+빔) + 카메라·링라이트 + 모니터."""
    box('base', (1.4, 0.5, 0.15), (0, 0, 0), M['dark'], bevel=0)
    box('body', (1.45, 0.56, 0.5), (0, 0, 0.15), M['white'])            # 컨베이어 스커트
    box('bed', (1.55, 0.66, 0.08), (0, 0, 0.65), M['frame'])
    box('belt', (1.47, 0.5, 0.05), (0, 0, 0.73), M['belt'], bevel=0.01)
    for x in (-0.76, 0.76):
        cyl('roller', 0.08, 0.6, (x, 0, 0.75), M['steel'], rot=(90, 0, 0), bottom=False, seg=16)
    box('part', (0.3, 0.3, 0.14), (0.1, 0, 0.78), M['tan'], bevel=0.01)
    for y in (-0.55, 0.55):
        box('gate_col', (0.3, 0.3, 1.8), (0.1, y, 0), M['white'])
        box('gate_foot', (0.4, 0.4, 0.1), (0.1, y, 0), M['dark'], bevel=0)
    box('gate_beam', (0.34, 1.4, 0.3), (0.1, 0, 1.8), M['white'])
    box('gate_stripe', (0.36, 1.42, 0.08), (0.1, 0, 1.92), M['weld'], bevel=0)
    box('cam', (0.32, 0.32, 0.38), (0.1, 0, 1.42), M['dark'])
    cyl('lens', 0.08, 0.1, (0.1, 0, 1.32), M['glass'], seg=12)
    cyl('ring', 0.26, 0.04, (0.1, 0, 1.34), M['led'], seg=20)
    box('ctrl', (0.36, 0.26, 0.5), (0.1, 0.78, 0.6), M['white'])
    box('arm', (0.06, 0.06, 1.0), (0.72, -0.5, 0.65), M['frame'], bevel=0)
    box('monitor', (0.46, 0.04, 0.34), (0.72, -0.56, 1.4), M['dark'], bevel=0)
    box('mon_screen', (0.4, 0.01, 0.28), (0.72, -0.585, 1.43), M['screen'], bevel=0)
    estop((0.1, -0.7, 1.15), '-y')
    return stacklight((0.1, 0.5, 2.1))


def build_packer():
    """포장기: 박스 투입 터널(+X면 어두운 개구) + 투입 컨베이어 위 골판지 상자 + 필름 롤 + 황색 가드."""
    box('skirt', (1.65, 1.0, 0.15), (-0.12, 0.05, 0), M['dark'])
    box('tunnel', (1.3, 0.95, 1.0), (-0.25, 0.05, 0.15), M['packer'])
    box('opening_frame', (0.06, 0.8, 0.7), (0.4, 0.02, 0.35), M['frame'], bevel=0)
    box('opening', (0.1, 0.68, 0.58), (0.4, 0.02, 0.41), M['dark'], bevel=0)     # +X면 투입 개구(어두운 터널)
    box('hood', (0.9, 0.7, 0.22), (-0.35, 0.05, 1.15), M['packer'])
    for x in (-0.15, 0.25):
        box('bracket', (0.05, 0.05, 0.3), (x, 0.05, 1.15), M['frame'], bevel=0)
    cyl('film', 0.15, 0.62, (0.05, 0.05, 1.37), M['white'], rot=(0, 90, 0), bottom=False, seg=20)
    box('infeed_body', (0.5, 0.56, 0.35), (0.72, 0.02, 0.2), M['frame'])
    box('infeed', (0.62, 0.62, 0.06), (0.7, 0.02, 0.52), M['frame'])
    box('infeed_belt', (0.58, 0.52, 0.03), (0.7, 0.02, 0.58), M['belt'], bevel=0)
    legs(0.5, 0.92, -0.24, 0.28, 0.52, 0.05)
    box('carton', (0.36, 0.36, 0.34), (0.62, 0.02, 0.61), M['tan'], bevel=0.01)
    box('tape', (0.38, 0.07, 0.35), (0.62, 0.02, 0.605), M['white'], bevel=0)
    box('panel', (0.34, 0.03, 0.22), (-0.55, -0.44, 0.7), M['screen'], bevel=0)
    for x in (-0.8, -0.2):
        box('guard_post', (0.05, 0.05, 0.55), (x, -0.8, 0), M['yellow'], bevel=0)
    box('guard_rail', (0.65, 0.035, 0.035), (-0.5, -0.8, 0.52), M['yellow'], bevel=0)
    estop((-0.15, -0.425, 0.7), '-y')
    return stacklight((-0.65, 0.35, 1.1))


def build_cnc():
    """CNC 머시닝센터: 밀폐형 크림색 외장 + 전면 슬라이딩 도어·검은 창 + 펜던트 + 후방 툴 매거진 타워 + 칩 컨베이어."""
    box('base', (1.75, 1.45, 0.12), (0, 0.05, 0), M['dark'])
    box('enclosure', (1.7, 1.4, 1.9), (0, 0.05, 0.12), M['cream'])
    box('stripe', (1.72, 1.42, 0.12), (0, 0.05, 0.5), M['green'], bevel=0)
    box('door_frame', (1.05, 0.04, 1.2), (-0.1, -0.66, 0.65), M['frame'], bevel=0)
    box('window', (0.72, 0.03, 0.72), (-0.1, -0.68, 0.85), M['glass'], bevel=0)
    box('handle', (0.04, 0.04, 0.32), (0.44, -0.69, 0.95), M['steel'], bevel=0)
    box('pendant_arm', (0.4, 0.06, 0.06), (0.95, -0.3, 1.5), M['frame'], bevel=0)
    box('pendant', (0.08, 0.42, 0.55), (1.0, -0.3, 1.0), M['dark'])
    box('pendant_screen', (0.02, 0.32, 0.3), (1.05, -0.3, 1.18), M['screen'], bevel=0)
    box('magazine', (0.62, 0.55, 0.7), (-0.42, 0.55, 2.02), M['cream'])
    box('mag_stripe', (0.64, 0.57, 0.06), (-0.42, 0.55, 2.3), M['green'], bevel=0)
    box('chip_conv', (0.55, 0.3, 0.26), (1.0, 0.5, 0.45), M['frame'], rot=(0, -22, 0))
    box('chip_bin', (0.3, 0.32, 0.3), (1.05, 0.5, 0.0), M['yellow'])
    box('step', (0.8, 0.22, 0.08), (-0.1, -0.85, 0), M['yellow'], bevel=0)
    box('coolant', (0.25, 0.4, 0.5), (0.6, -0.6, 0.12), M['frame'])
    estop((0.55, -0.65, 1.45), '-y')
    return stacklight((0.55, 0.45, 2.02))


# ── 스프린트 2: BLDC 라인 신규 유형 8종 (인터페이스 §9) ──────────────────────
# 좌표계 메모: 카메라는 (+X, -Y) 쪽 상공. 화면 x = 96 + 16(x+y), y = 150 + 8(x−y) − 19.6z.
# 정면(-Y면)은 화면 왼쪽 아래, +X면은 오른쪽 아래에 보인다. 발자국은 ±1.0(타일 1칸).

def build_stacker():
    """자동 적층기(Self-bonding): 백색 기둥형 본체 + 크라운·수직 실린더 + 사각 적층 헤드(램) + 가이드 포스트 4개
    + 테이블 위 코어 적층(라미네이션 줄무늬) + 측면 라미네이션 매거진 + HMI + 전면 라이트커튼(황색)."""
    box('base', (1.5, 1.2, 0.15), (0, 0.05, 0), M['dark'])
    box('body', (1.1, 0.9, 0.9), (0, 0.1, 0.15), M['white'])
    box('table', (1.35, 1.0, 0.08), (0, 0.1, 1.05), M['steel'])
    box('column', (0.5, 0.42, 1.6), (-0.05, 0.6, 1.13), M['white'])
    box('crown', (0.95, 0.95, 0.5), (0.05, 0.15, 2.6), M['white'])
    cyl('cylinder', 0.16, 0.42, (0.1, 0.05, 3.1), M['steel'], seg=20)
    cyl('cyl_cap', 0.2, 0.06, (0.1, 0.05, 3.52), M['dark'], seg=20)
    for (x, y) in ((-0.32, -0.32), (0.52, -0.32), (-0.32, 0.42), (0.52, 0.42)):
        cyl('post', 0.045, 1.47, (x, y, 1.13), M['steel'], seg=12)
    box('ram', (0.32, 0.32, 0.72), (0.1, 0.05, 1.88), M['frame'])
    box('die', (0.44, 0.44, 0.14), (0.1, 0.05, 1.74), M['dark'], bevel=0)
    for i in range(7):                                             # 적층 코어(강판 줄무늬)
        cyl('lam', 0.24, 0.05, (0.1, 0.05, 1.13 + i * 0.065), M['steel'] if i % 2 == 0 else M['dark'], seg=24)
    box('magazine', (0.26, 0.26, 0.95), (0.6, 0.1, 1.13), M['frame'])
    box('mag_slot', (0.05, 0.12, 0.8), (0.73, 0.1, 1.2), M['dark'], bevel=0)
    box('hmi_arm', (0.05, 0.05, 0.4), (-0.6, -0.42, 1.13), M['frame'], bevel=0)
    box('hmi', (0.4, 0.05, 0.32), (-0.6, -0.45, 1.53), M['dark'], bevel=0)
    box('hmi_screen', (0.34, 0.02, 0.24), (-0.6, -0.48, 1.57), M['screen'], bevel=0)
    for x in (-0.7, 0.7):
        box('lightcurtain', (0.08, 0.08, 1.0), (x, -0.5, 0.15), M['yellow'], bevel=0)
    box('stripe', (1.5, 0.02, 0.07), (0, -0.55, 0.08), M['yellow'], bevel=0)
    estop((0.4, -0.35, 0.8), '-y')
    return stacklight((-0.32, 0.5, 3.1))


def build_winder():
    """니들 와인더: 청록 벤치 + 좌측 스핀들 헤드스톡 + 스핀들 위 스테이터(강판 링+구리 권선) + 우측 니들 헤드 기둥·갠트리 빔·Z슬라이드
    + 후방 선반 위 구리 와이어 스풀 3개(+와이어 가이드) + HMI."""
    box('base', (1.7, 1.2, 0.12), (0, 0.05, 0), M['dark'])
    box('body', (1.6, 1.0, 0.85), (0, 0.05, 0.12), M['teal'])
    box('table', (1.66, 1.16, 0.06), (0, 0.05, 0.97), M['steel'])
    box('headstock', (0.45, 0.55, 0.62), (-0.55, 0.15, 1.03), M['frame'])
    cyl('spindle', 0.07, 0.55, (-0.33, 0.15, 1.36), M['steel'], rot=(0, 90, 0), seg=16)
    cyl('stator_ring', 0.32, 0.26, (0.02, 0.15, 1.36), M['frame'], rot=(0, 90, 0), bottom=False, seg=28)
    cyl('stator_coil', 0.22, 0.32, (0.02, 0.15, 1.36), M['copper'], rot=(0, 90, 0), bottom=False, seg=24)
    box('column', (0.3, 0.3, 1.0), (0.55, 0.15, 1.03), M['frame'])
    box('post_l', (0.14, 0.14, 0.32), (-0.45, 0.15, 1.65), M['frame'], bevel=0)
    box('beam', (1.0, 0.16, 0.16), (0.05, 0.15, 1.95), M['frame'])
    box('zslide', (0.18, 0.2, 0.62), (0.28, 0.15, 1.35), M['dark'], bevel=0)
    cyl('needle', 0.03, 0.5, (0.3, 0.15, 1.36), M['steel'], rot=(0, -90, 0), seg=8)
    for x in (-0.5, 0.0, 0.5):
        box('shelf_post', (0.05, 0.05, 0.87), (x, 0.6, 1.03), M['frame'], bevel=0)
    box('shelf', (1.4, 0.32, 0.05), (0, 0.6, 1.9), M['frame'])
    for x in (-0.45, 0.05, 0.5):
        cyl('spool', 0.15, 0.3, (x, 0.6, 1.95), M['copper'], seg=20)
        cyl('flange', 0.18, 0.02, (x, 0.6, 1.95), M['dark'], seg=20)
        cyl('flange', 0.18, 0.02, (x, 0.6, 2.23), M['dark'], seg=20)
    tube('wire', [(0.05, 0.6, 2.26), (0.2, 0.4, 2.3), (0.28, 0.15, 2.0)], 0.02, M['dark'])
    box('hmi', (0.42, 0.05, 0.3), (-0.4, -0.47, 0.5), M['dark'], bevel=0)
    box('hmi_screen', (0.36, 0.02, 0.22), (-0.4, -0.5, 0.54), M['screen'], bevel=0)
    box('stripe', (1.7, 0.02, 0.07), (0, -0.55, 0.05), M['yellow'], bevel=0)
    estop((0.5, -0.45, 0.65), '-y')
    return stacklight((0.55, 0.15, 2.11))


def build_vpi():
    """진공 함침조(VPI): 스테인리스 원통 탱크 + 플랜지 밴드 + 돔 뚜껑·측면 진공 포트 + 리프트 포스트·암
    + 진공 펌프 유닛(청색 모터·흑색 펌프) + 진공 배관 + 바니시 드럼(청색)·이송관 + 사이트글라스·압력계·판넬."""
    box('skid', (1.7, 1.4, 0.12), (0, 0.05, 0), M['dark'])
    tx, ty = -0.28, 0.12
    cyl('tank', 0.55, 1.6, (tx, ty, 0.12), M['steel'], seg=32)
    for z in (0.3, 1.0, 1.66):
        cyl('band', 0.59, 0.07, (tx, ty, z), M['frame'], seg=32)
    cyl('lid', 0.58, 0.12, (tx, ty, 1.72), M['frame'], seg=32)
    cyl('dome', 0.55, 0.3, (tx, ty, 1.84), M['steel'], seg=32, r2=0.3)
    cyl('dome_top', 0.3, 0.06, (tx, ty, 2.14), M['steel'], seg=24)
    cyl('lid_port', 0.1, 0.16, (tx, ty, 2.2), M['steel'], seg=16)
    cyl('side_port', 0.06, 0.22, (tx + 0.2, ty, 2.0), M['steel'], rot=(0, 90, 0), seg=12)
    box('lift_post', (0.14, 0.14, 2.55), (tx, 0.9, 0.12), M['frame'], bevel=0)
    box('lift_arm', (0.16, 0.9, 0.12), (tx, 0.55, 2.55), M['frame'])
    cyl('lift_rod', 0.04, 0.2, (tx, ty, 2.36), M['steel'], seg=8)
    box('sight', (0.16, 0.06, 0.28), (tx, ty - 0.56, 0.95), M['glass'], bevel=0)
    cyl('gauge', 0.09, 0.06, (tx + 0.2, ty - 0.52, 1.45), M['white'], rot=(90, 0, 0), seg=16)
    box('pump_skid', (0.6, 0.55, 0.5), (0.58, -0.15, 0.12), M['frame'])
    cyl('motor', 0.15, 0.4, (0.42, -0.15, 0.78), M['weld'], rot=(0, 90, 0), seg=20)
    cyl('pump', 0.13, 0.22, (0.3, -0.15, 0.78), M['dark'], rot=(0, 90, 0), seg=16)
    box('panel', (0.42, 0.04, 0.32), (0.58, -0.44, 0.22), M['dark'], bevel=0)
    box('panel_screen', (0.2, 0.02, 0.14), (0.5, -0.47, 0.34), M['screen'], bevel=0)
    tube('vac_pipe', [(0.15, ty, 2.0), (0.4, 0.0, 1.9), (0.55, -0.1, 1.4), (0.4, -0.15, 0.9)], 0.045, M['steel'])
    cyl('drum', 0.26, 0.9, (0.6, 0.45, 0.12), M['weld'], seg=24)
    cyl('drum_rim', 0.27, 0.04, (0.6, 0.45, 1.0), M['steel'], seg=24)
    tube('resin_pipe', [(0.6, 0.45, 1.04), (0.45, 0.45, 1.3), (0.25, 0.35, 1.2), (tx + 0.5, ty + 0.2, 1.1)], 0.035, M['steel'])
    box('stripe', (1.7, 0.02, 0.07), (0, -0.65, 0.06), M['yellow'], bevel=0)
    estop((0.78, -0.43, 0.5), '-y')
    return stacklight((tx, 0.9, 2.67))


def build_oven():
    """열풍 건조로 150℃: 웜그레이 챔버 + 스테인리스 전면 도어(발광 창·핸들·힌지) + 상부 배기 스택·순환 송풍기 모터
    + 적색 고온 밴드 + 측면(+X) 제어반(온도 표시·비상정지)."""
    box('base', (1.6, 1.4, 0.15), (0, 0.05, 0), M['dark'])
    box('chamber', (1.5, 1.3, 1.9), (-0.05, 0.1, 0.15), M['oven'])
    box('band', (1.52, 1.32, 0.07), (-0.05, 0.1, 1.82), M['red'], bevel=0)
    box('door', (1.1, 0.06, 1.5), (-0.1, -0.58, 0.35), M['steel'])
    box('window', (0.5, 0.03, 0.42), (-0.1, -0.625, 1.05), M['heatglass'], bevel=0)
    box('handle', (0.05, 0.06, 0.6), (0.36, -0.65, 0.8), M['dark'], bevel=0)
    for z in (0.5, 1.6):
        box('hinge', (0.06, 0.05, 0.14), (-0.62, -0.63, z), M['dark'], bevel=0)
    cyl('stack', 0.14, 0.7, (-0.45, 0.42, 2.05), M['frame'], seg=20)
    cyl('stack_cap', 0.2, 0.06, (-0.45, 0.42, 2.78), M['dark'], seg=20)
    box('blower', (0.5, 0.5, 0.32), (0.12, 0.3, 2.05), M['frame'])
    cyl('blower_motor', 0.15, 0.3, (0.12, 0.3, 2.37), M['steel'], seg=20)
    box('ctrl', (0.06, 0.55, 0.75), (0.73, -0.05, 0.85), M['dark'])
    box('ctrl_screen', (0.02, 0.32, 0.18), (0.765, -0.05, 1.3), M['screen'], bevel=0)
    box('stripe', (1.6, 0.02, 0.07), (0, -0.65, 0.08), M['yellow'], bevel=0)
    estop((0.76, 0.12, 0.98), '+x')
    return stacklight((0.55, 0.62, 2.05))


def build_magnetizer():
    """착자기(Capacitor Discharge): 회색 캐패시터 캐비닛(계기 화면·충전 램프·환기 슬릿·황색 고전압 밴드)
    + 백색 작업 벤치 + 구리 착자 코일 헤드(상하 흑색 플랜지) + 코일에 삽입된 로터·샤프트 + 굵은 방전 케이블 2가닥."""
    box('base', (1.75, 1.2, 0.12), (0.0, 0.05, 0), M['dark'])
    box('cabinet', (0.75, 0.8, 1.9), (-0.47, 0.25, 0.12), M['frame'])
    box('cab_door', (0.6, 0.03, 1.45), (-0.47, -0.16, 0.35), M['dark'], bevel=0)
    box('meter', (0.4, 0.02, 0.22), (-0.47, -0.18, 1.45), M['screen'], bevel=0)
    box('hv_band', (0.77, 0.82, 0.1), (-0.47, 0.25, 0.9), M['yellow'], bevel=0)
    box('vent', (0.03, 0.5, 0.55), (-0.1, 0.3, 0.3), M['dark'], bevel=0)
    cyl('charge_lamp', 0.05, 0.03, (-0.3, -0.175, 1.75), M['red'], rot=(90, 0, 0), seg=12)
    box('bench', (0.8, 0.8, 0.75), (0.45, 0.0, 0.12), M['white'])
    box('bench_top', (0.86, 0.86, 0.05), (0.45, 0.0, 0.87), M['steel'])
    cyl('coil_lo', 0.38, 0.06, (0.45, 0.0, 0.92), M['dark'], seg=32)
    cyl('coil', 0.34, 0.34, (0.45, 0.0, 0.98), M['copper'], seg=32)
    cyl('coil_hi', 0.38, 0.06, (0.45, 0.0, 1.32), M['dark'], seg=32)
    cyl('rotor', 0.13, 0.5, (0.45, 0.0, 0.98), M['steel'], seg=20)
    cyl('shaft', 0.05, 0.3, (0.45, 0.0, 1.48), M['dark'], seg=12)
    tube('hv_cable', [(-0.12, 0.05, 1.0), (0.05, 0.0, 1.15), (0.2, -0.05, 1.05), (0.3, -0.15, 1.0)], 0.04, M['dark'])
    tube('hv_cable', [(-0.12, 0.15, 0.85), (0.1, 0.12, 0.95), (0.25, 0.08, 1.0)], 0.04, M['red'])
    box('stripe', (1.75, 0.02, 0.07), (0.0, -0.55, 0.06), M['yellow'], bevel=0)
    estop((0.75, -0.4, 0.55), '-y')
    return stacklight((-0.32, 0.45, 2.02))


def build_balancer():
    """다이나믹 밸런싱 머신: 청회색 저상 베드 + 롤러 페데스탈 2기(V-롤러) + 걸쳐 놓은 로터(샤프트+코어)
    + 좌측 끝 벨트 구동부(청색 모터 헤드) + 뒤로 젖혀 연 투명 안전 후드(황색 힌지·상단 레일) + 전면 측정 콘솔(모니터) + 후방 폴 경광등."""
    box('base', (1.85, 1.3, 0.12), (0, 0.05, 0), M['dark'])
    box('bed', (1.7, 1.0, 0.55), (0, 0.1, 0.12), M['press'])
    box('bed_top', (1.72, 1.02, 0.05), (0, 0.1, 0.67), M['steel'])
    for x in (-0.4, 0.4):
        box('pedestal', (0.24, 0.5, 0.5), (x, 0.05, 0.72), M['frame'])
        for dy in (-0.12, 0.12):
            cyl('roller', 0.08, 0.22, (x, 0.05 + dy, 1.22), M['steel'], rot=(0, 90, 0), bottom=False, seg=16)
    cyl('shaft', 0.06, 1.5, (-0.75, 0.05, 1.34), M['steel'], rot=(0, 90, 0), seg=16)
    cyl('core', 0.2, 0.44, (-0.22, 0.05, 1.34), M['dark'], rot=(0, 90, 0), seg=24)
    box('drive', (0.28, 0.4, 0.5), (-0.72, 0.05, 0.72), M['frame'])
    box('motor', (0.24, 0.24, 0.3), (-0.72, 0.05, 1.22), M['weld'])
    # 열린 후드: 뒤쪽 힌지에서 25° 젖혀진 투명 패널
    box('hood', (1.4, 0.04, 0.66), (-0.05, 0.42, 1.2), M['clear'], rot=(-25, 0, 0), bevel=0)
    box('hood_hinge', (1.42, 0.06, 0.06), (-0.05, 0.42, 1.17), M['yellow'], bevel=0)
    hy, hz = 0.42 + 0.66 * math.sin(math.radians(25)), 1.2 + 0.66 * math.cos(math.radians(25))
    box('hood_rail', (1.42, 0.05, 0.05), (-0.05, hy, hz), M['yellow'], rot=(-25, 0, 0), bevel=0)
    box('console', (0.36, 0.3, 0.9), (0.75, -0.75, 0), M['frame'])
    box('monitor', (0.4, 0.04, 0.3), (0.75, -0.9, 0.95), M['dark'], rot=(20, 0, 0), bevel=0)
    box('mon_screen', (0.34, 0.02, 0.22), (0.75, -0.925, 0.98), M['screen'], rot=(20, 0, 0), bevel=0)
    cyl('lamp_pole', 0.03, 0.6, (0.78, 0.5, 0.72), M['steel'], seg=10)
    estop((0.75, -0.9, 0.55), '-y')
    return stacklight((0.78, 0.5, 1.32))


def build_dispenser():
    """접착 지그 + 디스펜서: 백색 벤치 + Y레일·X브리지 갠트리(청색 포스트) + Z헤드·시린지·니들 + 회전 지그 위 로터
    + 마그넷 트레이 + 접착제 압력 탱크·호스 + HMI + 전면 황색 볼라드."""
    box('base', (1.4, 1.2, 0.1), (0, 0.05, 0), M['dark'])
    box('bench', (1.3, 1.1, 0.8), (0, 0.05, 0.1), M['white'])
    box('bench_top', (1.36, 1.16, 0.05), (0, 0.05, 0.9), M['steel'])
    for x in (-0.5, 0.5):
        box('yrail', (0.1, 1.0, 0.1), (x, 0.05, 0.95), M['frame'], bevel=0)
        box('xpost', (0.12, 0.12, 0.5), (x, 0.1, 1.05), M['weld'], bevel=0)
    box('xbeam', (1.16, 0.14, 0.14), (0, 0.1, 1.45), M['frame'])
    box('carriage', (0.22, 0.22, 0.22), (0.15, 0.08, 1.41), M['dark'], bevel=0)
    box('zhead', (0.16, 0.16, 0.55), (0.15, -0.06, 1.05), M['weld'], bevel=0)
    box('sy_arm', (0.08, 0.2, 0.08), (0.15, -0.22, 1.32), M['dark'], bevel=0)
    cyl('syringe', 0.05, 0.36, (0.15, -0.36, 1.2), M['white'], seg=12)
    cyl('sy_cap', 0.055, 0.04, (0.15, -0.36, 1.56), M['dark'], seg=12)
    cyl('needle', 0.02, 0.12, (0.15, -0.36, 1.08), M['steel'], seg=8)
    cyl('turntable', 0.2, 0.08, (0.15, -0.17, 0.95), M['dark'], seg=24)
    cyl('rotor', 0.15, 0.32, (0.15, -0.17, 1.03), M['steel'], seg=20)
    cyl('rotor_shaft', 0.04, 0.12, (0.15, -0.17, 1.35), M['dark'], seg=8)
    box('tray', (0.36, 0.26, 0.04), (-0.4, -0.22, 0.95), M['tan'], bevel=0)
    for x in (-0.52, -0.4, -0.28):
        box('magnet', (0.06, 0.16, 0.06), (x, -0.22, 0.99), M['dark'], bevel=0)
    cyl('pot', 0.14, 0.45, (-0.5, 0.5, 0.95), M['steel'], seg=20)
    cyl('pot_cap', 0.15, 0.05, (-0.5, 0.5, 1.4), M['dark'], seg=20)
    tube('hose', [(-0.5, 0.5, 1.45), (-0.2, 0.3, 1.75), (0.15, -0.36, 1.6)], 0.02, M['dark'])
    box('hmi', (0.42, 0.05, 0.3), (-0.35, -0.525, 0.45), M['dark'], bevel=0)
    box('hmi_screen', (0.34, 0.02, 0.22), (-0.35, -0.555, 0.49), M['screen'], bevel=0)
    for x in (-0.62, 0.62):
        box('bollard', (0.07, 0.07, 0.45), (x, -0.62, 0), M['yellow'], bevel=0)
    estop((0.4, -0.5, 0.45), '-y')
    return stacklight((0.6, 0.48, 0.95))


def build_smt():
    """SMT + 자동 결선 라인: 백색 통과형 캐비닛(청색 밴드) + 양끝 입·출구 컨베이어(+X 출구 개구, 녹색 기판)
    + 전면 피더 뱅크·릴 6개 + 상부 후드·검은 창 + 모니터 암."""
    box('base', (1.9, 1.15, 0.15), (0, 0.05, 0), M['dark'])
    box('cabinet', (1.5, 1.0, 1.3), (0, 0.1, 0.15), M['white'])
    box('band', (1.52, 1.02, 0.1), (0, 0.1, 0.5), M['weld'], bevel=0)
    box('hood', (1.5, 0.9, 0.45), (0, 0.15, 1.45), M['white'])
    box('window', (1.0, 0.03, 0.3), (-0.05, -0.31, 1.52), M['glass'], bevel=0)
    for x in (-0.88, 0.88):
        box('conv', (0.3, 0.32, 0.1), (x, 0.0, 0.98), M['frame'])
        box('conv_belt', (0.28, 0.26, 0.03), (x, 0.0, 1.08), M['belt'], bevel=0)
        box('conv_leg', (0.06, 0.26, 0.83), (x + (0.1 if x > 0 else -0.1), 0.0, 0.15), M['frame'], bevel=0)
    box('opening', (0.05, 0.38, 0.24), (0.75, 0.0, 1.0), M['dark'], bevel=0)
    box('pcb', (0.22, 0.18, 0.02), (0.9, 0.0, 1.11), M['green'], bevel=0)
    box('feeder', (1.3, 0.28, 0.3), (0, -0.54, 0.6), M['dark'])
    box('feeder_top', (1.32, 0.3, 0.04), (0, -0.54, 0.9), M['frame'], bevel=0)
    for i in range(6):
        x = -0.5 + i * 0.2
        cyl('reel', 0.1, 0.05, (x, -0.62, 1.03), M['white'], rot=(0, 90, 0), bottom=False, seg=20)
        cyl('reel_hub', 0.035, 0.06, (x, -0.62, 1.03), M['dark'], rot=(0, 90, 0), bottom=False, seg=10)
    box('mon_arm', (0.05, 0.05, 0.45), (0.55, -0.1, 1.9), M['frame'], bevel=0)
    box('monitor', (0.42, 0.04, 0.3), (0.55, -0.16, 2.35), M['dark'], bevel=0)
    box('mon_screen', (0.36, 0.02, 0.24), (0.55, -0.185, 2.38), M['screen'], bevel=0)
    box('stripe', (1.9, 0.02, 0.07), (0, -0.525, 0.08), M['yellow'], bevel=0)
    estop((0.65, -0.4, 1.15), '-y')
    return stacklight((-0.55, 0.42, 1.9))


BUILDERS = {
    'press': build_press, 'welder': build_welder, 'robot': build_robot, 'assembly': build_assembly,
    'inspector': build_inspector, 'packer': build_packer, 'cnc': build_cnc,
    'stacker': build_stacker, 'winder': build_winder, 'vpi': build_vpi, 'oven': build_oven,
    'magnetizer': build_magnetizer, 'balancer': build_balancer, 'dispenser': build_dispenser, 'smt': build_smt,
}


# ── 씬·카메라·조명·렌더 ─────────────────────────────────
def pick_engine(scene, want):
    items = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    if want == 'cycles' and 'CYCLES' not in items:
        try:   # 5.x에서 Cycles는 애드온 — 빈 팩토리 설정에서는 꺼져 있을 수 있음
            bpy.ops.preferences.addon_enable(module='cycles')
            items = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
        except Exception as e:
            print('[build] cycles addon enable 실패:', e)
    if want == 'cycles' and 'CYCLES' in items:
        ident = 'CYCLES'
    else:
        ident = next((i for i in items if 'EEVEE' in i), None) or 'CYCLES'
    scene.render.engine = ident
    print('[build] render engine =', ident, '(available:', ', '.join(items), ')')
    return ident


def setup_scene(args):
    scene = bpy.context.scene
    engine = pick_engine(scene, args.engine)
    r = scene.render
    r.resolution_x = r.resolution_y = CANVAS
    r.resolution_percentage = 100
    r.film_transparent = True
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGBA'
    r.image_settings.color_depth = '8'
    r.image_settings.compression = 90
    r.dither_intensity = 0
    r.filter_size = 1.2
    try:
        scene.view_settings.view_transform = 'Standard'
        scene.view_settings.look = 'None'
    except Exception as e:
        print('[build] view transform 설정 실패(무시):', e)
    if engine == 'CYCLES':
        scene.cycles.device = 'CPU'
        scene.cycles.samples = args.samples or 64
        scene.cycles.use_denoising = True
        scene.cycles.use_adaptive_sampling = True
        scene.cycles.max_bounces = 4
    else:
        ev = scene.eevee
        for attr, val in (('taa_render_samples', args.samples or 32), ('use_shadows', True),
                          ('shadow_ray_count', 2), ('shadow_step_count', 4), ('use_shadow_jitter_viewport', False)):
            if hasattr(ev, attr):
                setattr(ev, attr, val)

    # 월드(주변광)
    world = bpy.data.worlds.new('World')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get('Background')
    bg.inputs[0].default_value = (0.62, 0.68, 0.78, 1.0)
    bg.inputs[1].default_value = 0.35

    # 카메라: 직교, (rx, 0, 45°). 프레임 폭 = 타일 3칸 → 마름모 폭 64px. 원점을 앵커(96,150)에 놓기 위해 shift_y
    cam_data = bpy.data.cameras.new('Cam')
    cam_data.type = 'ORTHO'
    cam_data.ortho_scale = 3 * TILE * math.sqrt(2)
    cam_data.clip_start = 0.1
    cam_data.clip_end = 200
    cam_data.shift_y = (CANVAS / 2 - ANCHOR[1]) / CANVAS * -1   # +0.28125 → 내용이 아래로
    cam = bpy.data.objects.new('Cam', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.rotation_euler = Euler((math.radians(args.cam_rx), 0, math.radians(45)), 'XYZ')
    view_dir = cam.rotation_euler.to_matrix() @ Vector((0, 0, -1))
    cam.location = -view_dir * 40

    # 조명: 키(그림자 O, 카메라 왼쪽 앞에서 → 그림자는 오른쪽 뒤로), 필(그림자 X, +X면 보정)
    def sun(name, toward, energy, shadow, angle):
        ld = bpy.data.lights.new(name, 'SUN')
        ld.energy = energy
        ld.angle = angle
        ld.use_shadow = shadow
        o = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(o)
        o.rotation_euler = Vector(toward).normalized().to_track_quat('-Z', 'Y').to_euler()
        return o
    sun('Key', (-0.45, 1.0, -1.15), 4.0, True, math.radians(3))
    sun('Fill', (-1.0, -0.35, -0.6), 1.3, False, math.radians(10))
    sun('Top', (0.2, 0.1, -1.0), 0.8, False, math.radians(20))

    # 바닥(그림자 패스용)·캘리브레이션 타일
    gcol = bpy.data.collections.new('ground')
    scene.collection.children.link(gcol)
    CUR['col'] = gcol
    ground = box('ground', (40, 40, 0.02), (0, 0, -0.02), M['ground'], bevel=0)
    ccol = bpy.data.collections.new('calib')
    scene.collection.children.link(ccol)
    CUR['col'] = ccol
    box('calib', (TILE, TILE, 0.004), (0, 0, 0.0), M['calib'], bevel=0)
    return scene, cam, engine, gcol, ccol


def px(scene, cam, p):
    v = world_to_camera_view(scene, cam, Vector(p))
    return [round(v.x * CANVAS, 2), round((1 - v.y) * CANVAS, 2)]


def render_to(scene, path):
    scene.render.filepath = path
    t = time.time()
    bpy.ops.render.render(write_still=True)
    ok = os.path.exists(path) and os.path.getsize(path) > 0
    print('[build] render %s %s (%.1fs)' % (os.path.basename(path), 'OK' if ok else 'FAILED', time.time() - t))
    if not ok:
        raise RuntimeError('render failed: ' + path)


def main():
    args = parse_args()
    root = os.getcwd()
    work = os.path.abspath(os.path.join(root, args.work))
    out = os.path.abspath(os.path.join(root, args.out))
    os.makedirs(work, exist_ok=True)
    os.makedirs(out, exist_ok=True)
    types = [t.strip() for t in args.types.split(',') if t.strip()] or TYPES
    bad = [t for t in types if t not in BUILDERS]
    if bad:
        raise SystemExit('unknown types: %s' % bad)

    bpy.ops.wm.read_factory_settings(use_empty=True)   # 빈 씬(기본 큐브·라이트 제거). 재질보다 먼저!
    make_materials()
    scene, cam, engine, gcol, ccol = setup_scene(args)

    # 설비 컬렉션 생성
    cols, lamps = {}, {}
    for t in types:
        col = bpy.data.collections.new(t)
        scene.collection.children.link(col)
        CUR['col'] = col
        lamps[t] = BUILDERS[t]()
        cols[t] = col
    all_cols = [gcol, ccol] + list(cols.values())
    bpy.context.view_layer.update()   # matrix_world 갱신(투영 좌표 계산 전 필수)

    def only(visible):
        for c in all_cols:
            c.hide_render = c not in visible

    half = TILE / 2
    meta = {
        'engine': engine, 'canvas': CANVAS, 'tile_px': [TILE_PX_W, TILE_PX_W // 2], 'anchor': list(ANCHOR),
        'cam_rx': args.cam_rx, 'ortho_scale': cam.data.ortho_scale, 'shift_y': cam.data.shift_y,
        'origin_px': px(scene, cam, (0, 0, 0)),
        'tile_corners_px': [px(scene, cam, p) for p in ((half, -half, 0), (half, half, 0), (-half, half, 0), (-half, -half, 0))],
        'unit_up_px': px(scene, cam, (0, 0, 0))[1] - px(scene, cam, (0, 0, 1))[1],
        'types': {},
    }
    print('[build] origin px =', meta['origin_px'], 'tile corners =', meta['tile_corners_px'], 'unit up =', meta['unit_up_px'])

    # 캘리브레이션 마름모
    only([ccol])
    render_to(scene, os.path.join(work, '_calib.png'))

    for t in types:
        col = cols[t]
        objs = list(col.objects)
        # A: 본체
        only([col])
        render_to(scene, os.path.join(work, t + '_body.png'))
        # B: 바닥 + 그림자 (설비는 카메라에 안 보이게)
        for o in objs:
            o.visible_camera = False
            o.is_holdout = True
        only([col, gcol])
        render_to(scene, os.path.join(work, t + '_shadow.png'))
        for o in objs:
            o.visible_camera = True
            o.is_holdout = False
        # 최고점(라벨 위치 참고): 모든 오브젝트 바운딩박스 꼭짓점 중 화면 최상단
        top = CANVAS
        for o in objs:
            for c in o.bound_box:
                p = o.matrix_world @ Vector(c)
                top = min(top, px(scene, cam, p)[1])
        meta['types'][t] = {'lamp_px': px(scene, cam, lamps[t]), 'lamp_world': [round(v, 3) for v in lamps[t]],
                            'top_px': round(top, 1), 'objects': len(objs)}
        print('[build] %s lamp px = %s top = %.1f' % (t, meta['types'][t]['lamp_px'], top))

    with open(os.path.join(work, 'meta.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print('[build] meta.json written →', work)

    if args.no_post:
        return
    post = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'postprocess.py')
    py = shutil.which('python') or shutil.which('py')
    if not py:
        print('[build] 시스템 python 없음 — 수동 실행:', 'python', post, '--work', work, '--out', out)
        return
    cmd = [py, post, '--work', work, '--out', out]
    print('[build] postprocess:', ' '.join(cmd))
    rc = subprocess.call(cmd, cwd=root)
    if rc != 0:
        raise SystemExit('postprocess failed rc=%d' % rc)


if __name__ == '__main__':
    main()
