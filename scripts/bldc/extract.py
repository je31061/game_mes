# -*- coding: utf-8 -*-
"""BLDC 500W 48V BOM/BOP 마스터(xlsx) + 분해도(PDF) → Factory World 데이터
사용: python scripts/bldc/extract.py
  입력: docs/bldc/source/BLDC_500W_48V_BOM_BOP_Master.xlsx, docs/bldc/source/BLDC_500W_48V_Exploded_View.pdf
  출력: docs/bldc/bldc-500w-48v.json      제품·공정(BOP 22)·단품(BOM 49+서브어셈블리 9)·공정별 투입/산출
        public/assets/parts/<P/N>.png     분해도의 서브어셈블리 이미지 9장
의존: python -m pip install openpyxl pypdf
"""
import json, os, re, sys
from pathlib import Path
import openpyxl
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / 'docs' / 'bldc' / 'source'
OUT_JSON = ROOT / 'docs' / 'bldc' / 'bldc-500w-48v.json'
OUT_IMG = ROOT / 'public' / 'assets' / 'parts'
XLSX = SRC / 'BLDC_500W_48V_BOM_BOP_Master.xlsx'
PDF = SRC / 'BLDC_500W_48V_Exploded_View.pdf'

def rows(ws):
    for r in ws.iter_rows(values_only=True):
        if any(c is not None for c in r):
            yield [('' if c is None else c) for c in r]

def num(v):
    try: return float(v)
    except: return None

wb = openpyxl.load_workbook(XLSX, data_only=True)

# ── 제품 사양 ──
spec = {}
for r in rows(wb['02_Product_Spec']):
    if r[0] and r[0] not in ('항목',) and not str(r[0]).startswith('Level'):
        spec[str(r[0])] = str(r[1])
product = {
    'code': 'BLDC-500W-48V', 'name': 'BLDC 모터 500W 48V',
    'spec': spec,
}

# ── 서브어셈블리 (L1) ──
subassy = []
for r in rows(wb['03_BOM_L1_SubAssy']):
    pn = str(r[0])
    if not re.match(r'^[A-Z]{2}-\d{4}$', pn): continue
    subassy.append({'pn': pn, 'name': str(r[1]), 'qty': num(r[2]), 'unit': str(r[3]),
                    'line': str(r[4]), 'sheet': str(r[5]), 'note': str(r[6])})

# ── 단품 (통합 BOM) ──
parts = []
for r in rows(wb['09_BOM_Flat_Consolidated']):
    if str(r[0]) not in ('L2', 'L3'): continue
    parts.append({
        'level': str(r[0]), 'parentName': str(r[1]), 'parentPn': str(r[2]),
        'pn': str(r[3]), 'name': str(r[4]), 'spec': str(r[5]),
        'qtyPerParent': num(r[6]), 'parentPerProduct': num(r[7]), 'qtyPerProduct': num(r[8]), 'unit': str(r[9]),
    })
part_index = {p['pn']: p for p in parts}
sub_index = {s['pn']: s for s in subassy}

def expand_materials(text):
    """'IN-1020U/L, SC-1010' · 'GB-8010~8050' · 'BP-3020F/R, BT-3070' · 'PE-6000 자재' → P/N 목록"""
    out = []
    t = str(text or '').strip()
    if t in ('', '-'): return out
    for tok in re.split(r'[,\s]+', t):
        tok = tok.strip()
        if not tok: continue
        m = re.match(r'^([A-Z]{2}-\d{4})([A-Z])/([A-Z])$', tok)          # IN-1020U/L, BP-3020F/R
        if m: out += [m.group(1) + m.group(2), m.group(1) + m.group(3)]; continue
        m = re.match(r'^([A-Z]{2})-(\d{4})~(\d{4})$', tok)                 # GB-8010~8050
        if m:
            lo, hi = int(m.group(2)), int(m.group(3))
            out += [p['pn'] for p in parts if p['pn'].startswith(m.group(1) + '-') and lo <= int(p['pn'][3:7]) <= hi]
            continue
        m = re.match(r'^([A-Z]{2}-\d{4}[A-Z]?)$', tok)
        if m:
            pn = m.group(1)
            if pn in sub_index and pn not in part_index:
                # 서브어셈블리 자재(예: PE-6000 자재) → 그 하위 단품 전체
                out.append(pn)
            else:
                out.append(pn)
    return out

# ── 공정 (BOP) ──
processes = []
for sheet, line, prefix in (('10_BOP_Armature_Line', '아마추어 라인', 'OP-A'), ('11_BOP_Assembly_Line', '조립 라인', 'OP-B')):
    seq = 0
    for r in rows(wb[sheet]):
        op = str(r[0])
        if not op.startswith(prefix): continue
        seq += 1
        materials = expand_materials(r[3])
        processes.append({
            'op': op, 'seq': seq, 'line': line, 'name': str(r[1]), 'equipment': str(r[2]),
            'inputText': str(r[3]), 'inputs': materials, 'output': str(r[4]),
            'ctSec': num(r[5]), 'kind': str(r[6]), 'qc': str(r[7]), 'note': str(r[8]) if len(r) > 8 else '',
        })

# 공정 → 분해도 단계(P/N) 대응: 설비를 클릭했을 때 강조할 서브어셈블리
STAGE_OF = {
    'OP-A10': 'SA-1000', 'OP-A20': 'SA-1000', 'OP-A30': 'SA-1000', 'OP-A40': 'SA-1000', 'OP-A50': 'SA-1000',
    'OP-A60': 'SA-1000', 'OP-A70': 'SA-1000', 'OP-A80': 'SA-1000', 'OP-A90': 'SA-1000', 'OP-A100': 'SA-1000',
    'OP-B10': 'RA-2000', 'OP-B20': 'RA-2000', 'OP-B30': 'RA-2000', 'OP-B40': 'RA-2000',
    'OP-B50': 'HS-3010', 'OP-B60': 'BP-3020', 'OP-B70': 'RA-2000', 'OP-B80': 'BP-3020',
    'OP-B85': 'GB-8000', 'OP-B87': 'PL-9000', 'OP-B90': 'PE-6000', 'OP-B100': 'PE-6000',
    'OP-B110': None, 'OP-B120': None,   # 완성품 시험·포장 → 전체 분해도
}
for p in processes:
    p['stagePn'] = STAGE_OF.get(p['op'])

# ── 라인 밸런스 ──
balance = {}
for r in rows(wb['12_Line_Balance']):
    if r[0] and r[1] not in ('',):
        balance[str(r[0])] = [str(c) for c in r[1:] if c != '']

# ── 분해도 이미지 (PDF 순서 = 조립 순서, P/N은 본문 텍스트 순서와 대응) ──
OUT_IMG.mkdir(parents=True, exist_ok=True)
reader = PdfReader(PDF)
page = reader.pages[0]
text = page.extract_text() or ''
stage_pns = re.findall(r'^([A-Z]{2}-\d{4})\n', text, flags=re.M)   # SA-1000, RA-2000, HS-3010, BP-3020, FS-7010, FS-7020, GB-8000, PL-9000, PE-6000
images = list(page.images)
exploded = []
for i, im in enumerate(images):
    pn = stage_pns[i] if i < len(stage_pns) else f'IMG-{i+1}'
    fname = f'{pn}.png'
    (OUT_IMG / fname).write_bytes(im.data)
    exploded.append({'stage': i + 1, 'pn': pn, 'file': fname})

# 분해도 단계 라벨 (PDF 본문)
stage_meta = {
    'SA-1000': {'group': 'ARMATURE', 'label': '스테이터 어셈블리'},
    'RA-2000': {'group': 'ASSEMBLY', 'label': '로터 어셈블리'},
    'HS-3010': {'group': 'ASSEMBLY', 'label': '모터 하우징'},
    'BP-3020': {'group': 'ASSEMBLY', 'label': '베어링 플레이트'},
    'FS-7010': {'group': 'DRIVE', 'label': '메인 플랜지 샤프트 No.1'},
    'FS-7020': {'group': 'DRIVE', 'label': '플랜지 샤프트 No.2'},
    'GB-8000': {'group': 'DRIVE', 'label': '기어박스 어셈블리'},
    'PL-9000': {'group': 'DRIVE', 'label': '파킹락'},
    'PE-6000': {'group': 'CONTROL', 'label': '파워 일렉트로닉스'},
}
for e in exploded:
    e.update(stage_meta.get(e['pn'], {'group': '', 'label': e['pn']}))

data = {
    'version': 1, 'source': {'xlsx': XLSX.name, 'pdf': PDF.name, 'rev': '1.0', 'date': '2026-09-09'},
    'product': product, 'subassemblies': subassy, 'parts': parts, 'processes': processes,
    'lineBalance': balance, 'exploded': exploded,
}
OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
OUT_JSON.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
print(f'processes {len(processes)}, subassemblies {len(subassy)}, parts {len(parts)}, images {len(exploded)}')
print('->', OUT_JSON.relative_to(ROOT))
for p in processes:
    print(f"  {p['op']:8} {p['name']:18} inputs={p['inputs']}")
