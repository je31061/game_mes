# -*- coding: utf-8 -*-
"""
load_source.py — BLDC 원천(JSON·XLSX)을 "정규화된 중간 형태"로 변환한다.

목적
  다음 라운드에 윤태경의 자재 스키마(DDL)가 확정되면, **적재부만 갈아끼우고**
  추출·정규화 로직은 그대로 쓰기 위한 중간 형태를 만든다.
  이 스크립트는 스키마를 확정하지 않는다 — 부모-자식 관계 목록(edge list)과
  품목 목록(item list), 그리고 발견한 이상값 목록(issue list)만 낸다.

원칙
  1. 원천을 고치지 않는다. 이상한 값은 **그대로 싣고 issue로 표시**한다.
     (예: 부모가 'HA-3000/EX-5000'인 행은 그 문자열 그대로 edge를 만든다)
  2. 추정으로 보정하지 않는다. 보정안이 있으면 `derived=True`로 **따로** 낸다
     (`--split-composite`). 기본값은 보정하지 않음.
  3. 운영 DB(data/factory.db)는 읽지도 쓰지도 않는다. 원천 파일만 읽는다.

사용
  python load_source.py                       # 기본 경로에서 읽어 stdout 요약
  python load_source.py --out out/normalized.json
  python load_source.py --split-composite --out out/normalized.split.json
  python load_source.py --format csv --out out/          # items.csv / edges.csv / issues.csv

작성: 노하린 (자재 데이터 검증)
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict

try:  # Windows 콘솔 cp949 회피
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
DEF_JSON = os.path.join(REPO, "docs", "bldc", "bldc-500w-48v.json")
DEF_XLSX = os.path.join(REPO, "docs", "bldc", "source", "BLDC_500W_48V_BOM_BOP_Master.xlsx")

SCHEMA_VERSION = "normalized-bom/0.1"

# ────────────────────────────────────────────────────────────── 이상값 코드
# severity: ERROR(트리가 깨짐) / WARN(해석이 갈림) / INFO(기록만)
ISSUE = {
    "COMPOSITE_PARENT":      ("ERROR", "부모 칸에 P/N이 둘 이상 적혀 있다 (한 칸에 다부모)"),
    "SELF_PARENT":           ("ERROR", "자기 자신을 부모로 참조한다"),
    "PARENT_NOT_FOUND":      ("ERROR", "부모 P/N이 품목 목록에 없다"),
    "LEVEL_PARENT_MISMATCH": ("WARN",  "레벨 표기와 실제 부모 깊이가 어긋난다"),
    "DUP_EDGE":              ("ERROR", "같은 부모에 같은 자식이 두 번"),
    "QTY_NONPOSITIVE":       ("ERROR", "수량이 0 이하"),
    "QTY_FRACTIONAL":        ("INFO",  "소수 수량 (단위 정책·반올림 규칙 필요)"),
    "UNIT_CONFLICT":         ("ERROR", "같은 P/N이 자리마다 다른 단위로 쓰인다"),
    "UNIT_UNREGISTERED":     ("WARN",  "표준 단위 코드가 아니다 (환산 불가)"),
    "UNIT_NONSTANDARD":      ("WARN",  "단위 표기가 한글·비표준이라 코드화가 필요하다"),
    "UNIT_SET_NO_CONTENT":   ("WARN",  "SET 단위인데 구성 내역이 없다"),
    "PN_DUAL_ROLE":          ("WARN",  "같은 P/N이 어셈블리와 단품 양쪽에 있다"),
    "ORPHAN_ITEM":           ("WARN",  "어느 부모에도 속하지 않는다 (루트 제외)"),
    "BOP_INPUT_UNKNOWN":     ("ERROR", "공정 투입 P/N이 품목 목록에 없다"),
    "BOP_NO_INPUT":          ("WARN",  "투입 자재가 하나도 없는 공정"),
    "BOP_UNCONSUMED":        ("WARN",  "어느 공정에서도 투입되지 않는 품목"),
    "BOP_STAGE_UNKNOWN":     ("WARN",  "공정의 단계 P/N이 품목 목록에 없다"),
    "BOP_MIXED_LEVEL":       ("WARN",  "어셈블리와 그 구성품이 같은 BOP에 섞여 있다 (합산 시 이중 계상)"),
    "SRC_MISMATCH":          ("ERROR", "원천끼리 값이 다르다 (엑셀 vs JSON)"),
    "NAME_MISMATCH":         ("INFO",  "같은 P/N의 품명이 원천마다 다르다"),
}

# 이 라인에서 실제로 쓰이는 단위. 환산 정의가 없으면 UNIT_UNREGISTERED.
UNIT_CANON = {
    "EA": ("EA", None, "낱개"),
    "SET": ("SET", None, "세트 — 구성 전개 필요"),
    "g": ("g", ("kg", 0.001), "그램"),
    "kg": ("kg", ("g", 1000.0), "킬로그램"),
    "m": ("m", ("mm", 1000.0), "미터"),
    "매": ("SHT", None, "장(sheet) — 한글 단위, 코드화 필요"),
}

PN_RE = re.compile(r"^[A-Z]{2}-\d{4}[A-Z]?$")


def _issue(code, subject, detail, evidence=None):
    sev, title = ISSUE[code]
    return {"code": code, "severity": sev, "title": title,
            "subject": subject, "detail": detail, "evidence": evidence or {}}


def _num(v, default=None):
    if v is None or v == "":
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


# ────────────────────────────────────────────────────────────── 원천 읽기
def read_json_source(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def read_xlsx_source(path):
    """엑셀 03(L1) · 04~08(부모별 상세) · 09(평면 통합)을 읽어 원문 그대로 돌려준다."""
    try:
        import openpyxl
    except ImportError:  # pragma: no cover
        print("[!] openpyxl 이 없다. `pip install openpyxl` 후 다시 실행.", file=sys.stderr)
        return None
    wb = openpyxl.load_workbook(path, data_only=True)

    def cells(ws, min_row):
        for r in ws.iter_rows(min_row=min_row, values_only=True):
            yield ["" if c is None else (c if isinstance(c, (int, float)) else str(c).strip())
                   for c in r]

    out = {"l1": [], "detail": {}, "flat": [], "sheetHeader": {}}

    for r in cells(wb["03_BOM_L1_SubAssy"], 4):
        pn = str(r[0])
        if not PN_RE.match(pn):
            continue
        out["l1"].append({"pn": pn, "name": str(r[1]), "qty": _num(r[2], 0.0),
                          "unit": str(r[3]), "line": str(r[4]), "sheet": str(r[5]),
                          "note": str(r[6]) if len(r) > 6 else ""})

    for sn in ("04_BOM_L2_Stator", "05_BOM_L2_Rotor", "06_BOM_L2_Housing",
               "07_BOM_L2_PE", "08_BOM_L2_Drive"):
        ws = wb[sn]
        out["sheetHeader"][sn] = {"title": str(ws["A1"].value or ""),
                                  "parentCell": str(ws["B2"].value or ""),
                                  "setQty": _num(ws["F2"].value)}
        rows = []
        for r in cells(ws, 4):
            if not r[1] or not PN_RE.match(str(r[1])):
                continue
            rows.append({"level": str(r[0]), "pn": str(r[1]), "name": str(r[2]),
                         "spec": str(r[3]), "qty": _num(r[4], 0.0), "unit": str(r[5])})
        out["detail"][sn] = rows

    for r in cells(wb["09_BOM_Flat_Consolidated"], 4):
        if not r[3] or not PN_RE.match(str(r[3])):
            continue
        out["flat"].append({"level": str(r[0]), "parentName": str(r[1]), "parentPn": str(r[2]),
                            "pn": str(r[3]), "name": str(r[4]), "spec": str(r[5]),
                            "qtyPerParent": _num(r[6], 0.0), "parentPerProduct": _num(r[7], 1.0),
                            "qtyPerProduct": _num(r[8], 0.0), "unit": str(r[9])})
    return out


# ────────────────────────────────────────────────────────────── 정규화
def normalize(js, xl, split_composite=False):
    issues = []
    items = {}        # pn -> item
    edges = []        # 부모-자식 관계
    root = js["product"]["code"]

    def put_item(pn, **kw):
        it = items.setdefault(pn, {"pn": pn, "name": "", "spec": "", "unit": "",
                                   "srcLevel": "", "roles": [], "sources": []})
        for k, v in kw.items():
            if k == "roles" or k == "sources":
                for x in v:
                    if x not in it[k]:
                        it[k].append(x)
            elif v not in ("", None) and not it.get(k):
                it[k] = v
        return it

    # 0) 루트 = 완성품
    put_item(root, name=js["product"]["name"], unit="EA", srcLevel="L0",
             roles=["product"], sources=["json.product"])

    # 1) L1 서브어셈블리  (제품 -> L1)
    for s in js["subassemblies"]:
        put_item(s["pn"], name=s["name"], unit=s["unit"], srcLevel="L1",
                 roles=["subassembly"], sources=["json.subassemblies"])
        edges.append({"parentPn": root, "childPn": s["pn"],
                      "qtyPerParent": float(s["qty"]), "unit": s["unit"],
                      "srcLevel": "L1", "source": "json.subassemblies",
                      "derived": False, "note": s.get("note", "")})

    # 2) 단품 (부모 -> 자식). 원천의 parentPn을 **그대로** 쓴다.
    for p in js["parts"]:
        put_item(p["pn"], name=p["name"], spec=p.get("spec", ""), unit=p["unit"],
                 srcLevel=p["level"], roles=["part"], sources=["json.parts"])
        edges.append({"parentPn": p["parentPn"], "childPn": p["pn"],
                      "qtyPerParent": float(p["qtyPerParent"]), "unit": p["unit"],
                      "srcLevel": p["level"], "source": "json.parts",
                      "derived": False, "note": ""})

    # 3) 공정 / 공정 투입
    processes = [{"op": q["op"], "seq": q["seq"], "line": q["line"], "name": q["name"],
                  "ctSec": q["ctSec"], "kind": q["kind"], "stagePn": q.get("stagePn"),
                  "output": q.get("output", ""), "inputText": q.get("inputText", "")}
                 for q in js["processes"]]
    qpp = {p["pn"]: float(p["qtyPerProduct"]) for p in js["parts"]}
    qpp.update({s["pn"]: float(s["qty"]) for s in js["subassemblies"]})
    process_inputs = [{"op": q["op"], "pn": pn, "qty": qpp.get(pn),
                       "unit": items.get(pn, {}).get("unit", ""), "source": "json.processes.inputs"}
                      for q in js["processes"] for pn in q["inputs"]]

    # ── 이상값 판정 ────────────────────────────────────────────
    child_of = defaultdict(list)
    for e in edges:
        child_of[e["parentPn"]].append(e)

    # 복합 부모
    composite = {}
    for e in edges:
        if "/" in e["parentPn"]:
            composite.setdefault(e["parentPn"], []).append(e["childPn"])
    for cp, kids in composite.items():
        issues.append(_issue("COMPOSITE_PARENT", cp,
                             f"부모 칸에 '{cp}' — P/N {len(cp.split('/'))}개가 한 칸에. "
                             f"자식 {len(kids)}건이 어느 부모 소속인지 판정 불가.",
                             {"children": kids, "candidates": cp.split("/")}))

    # 자기 참조 / 부모 미존재
    for e in edges:
        if e["parentPn"] == e["childPn"]:
            issues.append(_issue("SELF_PARENT", e["childPn"],
                                 f"{e['childPn']} 의 부모가 자기 자신이다 (길이 1 순환).",
                                 {"edge": e}))
        elif e["parentPn"] not in items and "/" not in e["parentPn"]:
            issues.append(_issue("PARENT_NOT_FOUND", e["parentPn"],
                                 f"자식 {e['childPn']} 의 부모 {e['parentPn']} 가 품목에 없다.",
                                 {"edge": e}))

    # 중복 edge
    for (par, ch), n in Counter((e["parentPn"], e["childPn"]) for e in edges).items():
        if n > 1:
            issues.append(_issue("DUP_EDGE", f"{par}->{ch}", f"같은 부모-자식 쌍이 {n}번.", {}))

    # 레벨 표기 vs 부모 깊이
    lvl_of = {i["pn"]: i["srcLevel"] for i in items.values()}
    for e in edges:
        cl, pl = e["srcLevel"], lvl_of.get(e["parentPn"], "")
        if cl.startswith("L") and pl.startswith("L") and cl[1:].isdigit() and pl[1:].isdigit():
            if int(cl[1:]) != int(pl[1:]) + 1:
                issues.append(_issue("LEVEL_PARENT_MISMATCH", e["childPn"],
                                     f"{e['childPn']}({cl}) 의 부모 {e['parentPn']}({pl}) — "
                                     f"레벨 차가 1이 아니다.", {"edge": e}))

    # 수량
    for e in edges:
        q = e["qtyPerParent"]
        if q is None or q <= 0:
            issues.append(_issue("QTY_NONPOSITIVE", e["childPn"], f"수량 {q}", {"edge": e}))
        elif abs(q - round(q)) > 1e-9:
            issues.append(_issue("QTY_FRACTIONAL", e["childPn"],
                                 f"{e['parentPn']} 당 {q} {e['unit']}", {"edge": e}))

    # 단위
    unit_seen = defaultdict(set)
    for e in edges:
        unit_seen[e["childPn"]].add(e["unit"])
    for pn, us in unit_seen.items():
        if len(us) > 1:
            issues.append(_issue("UNIT_CONFLICT", pn, f"단위가 {sorted(us)} 로 갈린다.", {}))
    used_units = sorted({e["unit"] for e in edges} | {i["unit"] for i in items.values()})
    for u in used_units:
        if not u:
            continue
        if u not in UNIT_CANON:
            issues.append(_issue("UNIT_UNREGISTERED", u, f"단위 '{u}' 가 표준 코드표에 없다.", {}))
        elif UNIT_CANON[u][0] != u:
            pns = sorted({e["childPn"] for e in edges if e["unit"] == u})
            issues.append(_issue("UNIT_NONSTANDARD", u,
                                 f"단위 '{u}' → 코드 '{UNIT_CANON[u][0]}' 로 치환 필요. 사용 품목: "
                                 + ", ".join(pns), {"pns": pns}))
    for u, (code, conv, desc) in UNIT_CANON.items():
        if conv is None and u in ("SET",):
            for i in items.values():
                if i["unit"] == "SET" and not child_of.get(i["pn"]):
                    issues.append(_issue("UNIT_SET_NO_CONTENT", i["pn"],
                                         f"{i['pn']} 은 SET 인데 자식 edge가 0건 — 몇 EA인지 알 수 없다.", {}))

    # P/N 이중 역할
    for i in items.values():
        if "subassembly" in i["roles"] and "part" in i["roles"]:
            issues.append(_issue("PN_DUAL_ROLE", i["pn"],
                                 f"{i['pn']} 이 L1 어셈블리이면서 단품 행으로도 있다.", {}))

    # 고아
    has_parent = {e["childPn"] for e in edges}
    for i in items.values():
        if i["pn"] != root and i["pn"] not in has_parent:
            issues.append(_issue("ORPHAN_ITEM", i["pn"], f"{i['pn']} 은 어느 부모에도 없다.", {}))

    # BOP
    consumed = {pi["pn"] for pi in process_inputs}
    for q in processes:
        if not any(pi["op"] == q["op"] for pi in process_inputs):
            issues.append(_issue("BOP_NO_INPUT", q["op"], f"{q['op']} {q['name']} — 투입 자재 0건 "
                                                          f"(inputText='{q['inputText']}')", {}))
        if q["stagePn"] and q["stagePn"] not in items:
            issues.append(_issue("BOP_STAGE_UNKNOWN", q["stagePn"],
                                 f"{q['op']} 의 단계 P/N {q['stagePn']} 이 품목에 없다.", {}))
    for pi in process_inputs:
        if pi["pn"] not in items:
            issues.append(_issue("BOP_INPUT_UNKNOWN", pi["pn"], f"{pi['op']} 투입 P/N 미등록", {}))
    unconsumed = sorted(set(items) - consumed - {root})
    if unconsumed:
        issues.append(_issue("BOP_UNCONSUMED", f"{len(unconsumed)}건",
                             "어느 공정에서도 투입되지 않는 품목: " + ", ".join(unconsumed),
                             {"pns": unconsumed}))
    mixed = []
    for pi in process_inputs:
        if child_of.get(pi["pn"]):  # 어셈블리를 투입으로 쓴다
            kids = {e["childPn"] for e in child_of[pi["pn"]]}
            if kids & consumed:
                mixed.append(pi["pn"])
    for pn in sorted(set(mixed)):
        issues.append(_issue("BOP_MIXED_LEVEL", pn,
                             f"{pn} 이 어셈블리로도 투입되고 그 구성품도 따로 투입된다 — "
                             f"process_inputs 단순합은 이중 계상.", {}))

    # 엑셀 대조
    if xl:
        fm = {r["pn"]: r for r in xl["flat"]}
        for p in js["parts"]:
            x = fm.get(p["pn"])
            if not x:
                issues.append(_issue("SRC_MISMATCH", p["pn"], "엑셀 09 시트에 없다.", {}))
                continue
            for jk, xk, lab in (("qtyPerParent", "qtyPerParent", "수량"),
                                ("qtyPerProduct", "qtyPerProduct", "총소요"),
                                ("parentPn", "parentPn", "부모"),
                                ("unit", "unit", "단위"),
                                ("level", "level", "레벨")):
                if p[jk] != x[xk] and not (isinstance(p[jk], float) and abs(p[jk] - x[xk]) < 1e-9):
                    issues.append(_issue("SRC_MISMATCH", p["pn"],
                                         f"{lab}: JSON={p[jk]} / 엑셀09={x[xk]}", {}))
        # 04~08 시트의 B2(상위 P/N) 과 09 시트의 부모 칸 대조
        sheet_parent = {"04_BOM_L2_Stator": "SA-1000", "05_BOM_L2_Rotor": "RA-2000",
                        "06_BOM_L2_Housing": "HA-3000", "07_BOM_L2_PE": "PE-6000"}
        for sn, par in sheet_parent.items():
            for r in xl["detail"].get(sn, []):
                x = fm.get(r["pn"])
                if x and x["parentPn"] != par:
                    issues.append(_issue("SRC_MISMATCH", r["pn"],
                                         f"{sn} B2 상위 P/N='{par}' 인데 09 시트 부모 칸='{x['parentPn']}'",
                                         {"sheet": sn, "sheetParent": par, "flatParent": x["parentPn"]}))

    # ── 복합 부모 분해안(선택) ────────────────────────────────
    # 근거: 06 시트 B2='HA-3000', 03 시트 EX-5000 비고='네임플레이트/오링/글랜드',
    #       P/N 계열(3xxx=HA-3000, 5xxx=EX-5000).
    if split_composite:
        derived = []
        for e in list(edges):
            if "/" not in e["parentPn"]:
                continue
            cands = e["parentPn"].split("/")
            series = re.match(r"^[A-Z]{2}-(\d)", e["childPn"])
            pick, why, conf = None, "", "low"
            if series:
                d = series.group(1)
                for c in cands:
                    m = re.match(r"^[A-Z]{2}-(\d)", c)
                    if m and m.group(1) == d:
                        pick, why, conf = c, f"P/N 계열 {d}xxx 일치", "high"
                        break
            if not pick:
                pick, why, conf = cands[0], "계열 불일치 — 첫 후보로 가정", "low"
            derived.append({**e, "parentPn": pick, "derived": True,
                            "derivedFrom": e["parentPn"], "confidence": conf, "note": why})
        edges = [e for e in edges if "/" not in e["parentPn"]] + derived

    by_sev = Counter(i["severity"] for i in issues)
    return {
        "schema": SCHEMA_VERSION,
        "meta": {"root": root, "product": js["product"]["name"],
                 "sourceJson": os.path.basename(DEF_JSON),
                 "sourceXlsx": os.path.basename(DEF_XLSX) if xl else None,
                 "splitComposite": split_composite,
                 "counts": {"items": len(items), "edges": len(edges),
                            "processes": len(processes), "processInputs": len(process_inputs),
                            "issues": len(issues)},
                 "issuesBySeverity": dict(by_sev)},
        "items": sorted(items.values(), key=lambda x: x["pn"]),
        "edges": sorted(edges, key=lambda x: (x["parentPn"], x["childPn"])),
        "processes": processes,
        "processInputs": process_inputs,
        "units": {k: {"code": v[0], "convert": v[1], "desc": v[2]} for k, v in UNIT_CANON.items()},
        "issues": issues,
    }


# ────────────────────────────────────────────────────────────── 출력
def write_csv(norm, outdir):
    os.makedirs(outdir, exist_ok=True)
    specs = [
        ("items.csv", norm["items"], ["pn", "name", "spec", "unit", "srcLevel", "roles", "sources"]),
        ("edges.csv", norm["edges"], ["parentPn", "childPn", "qtyPerParent", "unit", "srcLevel",
                                      "source", "derived", "note"]),
        ("processes.csv", norm["processes"], ["op", "seq", "line", "name", "ctSec", "kind", "stagePn"]),
        ("process_inputs.csv", norm["processInputs"], ["op", "pn", "qty", "unit"]),
        ("issues.csv", norm["issues"], ["code", "severity", "subject", "detail"]),
    ]
    for fn, rows, cols in specs:
        with open(os.path.join(outdir, fn), "w", newline="", encoding="utf-8-sig") as fh:
            w = csv.writer(fh)
            w.writerow(cols)
            for r in rows:
                w.writerow([",".join(r[c]) if isinstance(r.get(c), list) else r.get(c, "") for c in cols])
    return [s[0] for s in specs]


def summary(norm):
    m, out = norm["meta"], []
    out.append(f"정규화 완료  schema={norm['schema']}  root={m['root']}")
    out.append(f"  품목 {m['counts']['items']} · 관계 {m['counts']['edges']} · "
               f"공정 {m['counts']['processes']} · 공정투입 {m['counts']['processInputs']}")
    out.append(f"  복합부모 분해: {'적용' if m['splitComposite'] else '미적용(원천 그대로)'}")
    out.append(f"  이상값 {m['counts']['issues']}건  {dict(m['issuesBySeverity'])}")
    out.append("  코드별:")
    for code, n in Counter(i["code"] for i in norm["issues"]).most_common():
        out.append(f"    {ISSUE[code][0]:5s} {code:22s} {n:3d}  {ISSUE[code][1]}")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description="BLDC 원천 -> 정규화 중간 형태")
    ap.add_argument("--json", default=DEF_JSON)
    ap.add_argument("--xlsx", default=DEF_XLSX)
    ap.add_argument("--no-xlsx", action="store_true", help="엑셀 대조를 건너뛴다")
    ap.add_argument("--split-composite", action="store_true",
                    help="복합 부모(HA-3000/EX-5000)를 근거에 따라 분해한 edge도 낸다(derived=True)")
    ap.add_argument("--out", help="출력 경로(.json) 또는 디렉터리(--format csv)")
    ap.add_argument("--format", choices=["json", "csv"], default="json")
    a = ap.parse_args(argv)

    js = read_json_source(a.json)
    xl = None if a.no_xlsx else read_xlsx_source(a.xlsx)
    norm = normalize(js, xl, split_composite=a.split_composite)

    if a.out and a.format == "json":
        os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
        with open(a.out, "w", encoding="utf-8") as fh:
            json.dump(norm, fh, ensure_ascii=False, indent=2)
        print(f"[out] {a.out}")
    elif a.out:
        for fn in write_csv(norm, a.out):
            print(f"[out] {os.path.join(a.out, fn)}")
    print(summary(norm))
    return norm


if __name__ == "__main__":
    main()
