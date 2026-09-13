# -*- coding: utf-8 -*-
"""
bomkit.py — **스키마에 의존하지 않는** BOM 검증 루틴.

왜 이렇게 만들었나
  윤태경의 자재 스키마(DDL)는 아직 없다. 그래서 검증 루틴이 특정 테이블·컬럼 이름을
  알면 안 된다. 여기 있는 함수는 전부 다음 두 가지만 받는다.

      items : [ {pn, name, unit, ...}, ... ]
      edges : [ {parentPn, childPn, qtyPerParent, unit,
                 validFrom?, validTo?, altGroup?, altPriority?, seq?}, ... ]

  스키마가 확정되면 `Mapping` 하나만 채워서 `from_sqlite()` 로 읽어 오면
  아래 함수는 **한 줄도 고치지 않고** 그대로 돈다.

제공 루틴
  detect_cycles        순환 참조(자기 참조 포함)
  explode              다단계 정전개 (완성품 N대 -> 품목별 총 소요량)
  where_used           역전개 (단품 -> 상위 경로 전부)
  as_of_edges          특정 시점(as-of) 유효 BOM 잘라내기
  find_duplicate_edges 같은 부모에 같은 자식
  find_orphans         부모 없는 품목 / 자식 없는 어셈블리
  find_qty_anomalies   0·음수·소수 수량
  find_unit_conflicts  같은 P/N 단위 불일치 / 미등록 단위
  find_effectivity_overlaps  유효일자 구간 겹침
  find_alternate_conflicts   같은 대체 그룹 동시 유효 / 우선순위 중복
  find_composite_parents     한 칸에 P/N 둘 이상

작성: 노하린 (자재 데이터 검증)
"""
from __future__ import annotations

import sqlite3
from collections import Counter, defaultdict, deque
from dataclasses import dataclass, field

MAX_DEPTH = 64  # 순환이 남아 있어도 전개가 멈추도록 하는 안전장치


# ══════════════════════════════════════════════ 스키마 어댑터
@dataclass
class Mapping:
    """어떤 DDL이 와도 여기만 채우면 된다."""
    item_table: str = "items"
    item_pn: str = "pn"
    item_cols: dict = field(default_factory=lambda: {"name": "name", "unit": "unit"})

    edge_table: str = "bom_edges"
    edge_parent: str = "parent_pn"
    edge_child: str = "child_pn"
    edge_qty: str = "qty_per_parent"
    edge_cols: dict = field(default_factory=lambda: {
        "unit": "unit", "validFrom": "valid_from", "validTo": "valid_to",
        "altGroup": "alt_group", "altPriority": "alt_priority", "seq": "seq"})

    def load(self, con: sqlite3.Connection):
        con.row_factory = sqlite3.Row
        have = {r["name"] for r in con.execute(f"PRAGMA table_info({self.edge_table})")}
        ihave = {r["name"] for r in con.execute(f"PRAGMA table_info({self.item_table})")}

        items = []
        for r in con.execute(f"SELECT * FROM {self.item_table}"):
            it = {"pn": r[self.item_pn]}
            for k, c in self.item_cols.items():
                it[k] = r[c] if c in ihave else None
            items.append(it)

        edges = []
        for r in con.execute(f"SELECT * FROM {self.edge_table}"):
            e = {"parentPn": r[self.edge_parent], "childPn": r[self.edge_child],
                 "qtyPerParent": r[self.edge_qty]}
            for k, c in self.edge_cols.items():
                e[k] = r[c] if c in have else None
            edges.append(e)
        return items, edges


def from_sqlite(con, mapping: Mapping | None = None):
    return (mapping or Mapping()).load(con)


def _kids(edges):
    d = defaultdict(list)
    for e in edges:
        d[e["parentPn"]].append(e)
    return d


def _pars(edges):
    d = defaultdict(list)
    for e in edges:
        d[e["childPn"]].append(e)
    return d


# ══════════════════════════════════════════════ 1. 순환 참조
def detect_cycles(edges):
    """순환을 전부 찾는다. 자기 참조(A->A)도 길이 1 순환으로 낸다.
    반환: [[pn, pn, ...], ...]  (마지막 원소는 첫 원소와 같다)"""
    kids, found, seen_key = _kids(edges), [], set()
    WHITE, GRAY, BLACK = 0, 1, 2
    color = defaultdict(int)

    def key(cyc):
        core = cyc[:-1]
        i = core.index(min(core))
        return tuple(core[i:] + core[:i])

    def dfs(node, stack):
        color[node] = GRAY
        stack.append(node)
        for e in kids.get(node, []):
            c = e["childPn"]
            if color[c] == GRAY:
                cyc = stack[stack.index(c):] + [c]
                k = key(cyc)
                if k not in seen_key:
                    seen_key.add(k)
                    found.append(cyc)
            elif color[c] == WHITE:
                dfs(c, stack)
        stack.pop()
        color[node] = BLACK

    for n in {e["parentPn"] for e in edges} | {e["childPn"] for e in edges}:
        if color[n] == WHITE:
            dfs(n, [])
    return found


# ══════════════════════════════════════════════ 2. 정전개
def explode(edges, root, qty=1.0, as_of=None, include_assemblies=False, max_depth=MAX_DEPTH):
    """완성품 `root` `qty`대 기준 다단계 전개.

    반환 dict:
      lines[]       전개된 각 노드 (pn, depth, path, qty, unit)
      totals{pn}    품목별 총 소요량 {qty, unit, depth}
      byUnit{unit}  단위별 합계
      leaves[pn]    자식이 없는 품목만
      cyclesHit[]   전개 중 만난 순환 (끊고 계속)
      depthMax
    NOTE: 기본값은 **리프만** 소요량으로 집계한다(어셈블리는 중간 산출물).
          include_assemblies=True 면 중간 어셈블리도 totals에 넣는다.
    """
    e2 = as_of_edges(edges, as_of) if as_of else edges
    kids = _kids(e2)
    lines, cycles, depth_max = [], [], 0
    totals, by_unit = {}, defaultdict(float)

    stack = deque([(root, qty, 0, (root,))])
    while stack:
        pn, mult, depth, path = stack.pop()
        depth_max = max(depth_max, depth)
        if depth >= max_depth:
            cycles.append(list(path) + ["...MAX_DEPTH"])
            continue
        for e in kids.get(pn, []):
            c, q = e["childPn"], (e["qtyPerParent"] or 0) * mult
            if c in path:
                cycles.append(list(path) + [c])
                continue
            leaf = not kids.get(c)
            lines.append({"pn": c, "depth": depth + 1, "path": path + (c,),
                          "qty": q, "unit": e.get("unit"), "leaf": leaf})
            if leaf or include_assemblies:
                t = totals.setdefault(c, {"qty": 0.0, "unit": e.get("unit"), "depth": depth + 1})
                t["qty"] += q
                if t["unit"] != e.get("unit"):
                    t["unitConflict"] = True
            stack.append((c, q, depth + 1, path + (c,)))

    for pn, t in totals.items():
        by_unit[t["unit"] or "?"] += t["qty"]
    return {"root": root, "qty": qty, "lines": lines, "totals": totals,
            "byUnit": dict(by_unit), "leaves": {k: v for k, v in totals.items()},
            "cyclesHit": cycles, "depthMax": depth_max}


# ══════════════════════════════════════════════ 3. 역전개
def where_used(edges, pn, as_of=None, max_depth=MAX_DEPTH):
    """`pn` 이 쓰이는 상위 경로를 전부. 반환: {paths[], directParents[], roots[]}"""
    e2 = as_of_edges(edges, as_of) if as_of else edges
    pars = _pars(e2)
    paths, roots = [], set()

    def up(cur, path, depth):
        if depth >= max_depth:
            paths.append(list(path) + ["...MAX_DEPTH"])
            return
        ps = pars.get(cur, [])
        if not ps:
            paths.append(list(path))
            roots.add(cur)
            return
        for e in ps:
            p = e["parentPn"]
            if p in path:
                paths.append(list(path) + [p, "(CYCLE)"])
                continue
            up(p, [p] + path, depth + 1)

    up(pn, [pn], 0)
    return {"pn": pn, "paths": paths, "roots": sorted(roots),
            "directParents": sorted({e["parentPn"] for e in pars.get(pn, [])})}


# ══════════════════════════════════════════════ 4. 유효일자
def _ov(a1, a2, b1, b2):
    lo = "0000-00-00"
    hi = "9999-12-31"
    a1, a2 = a1 or lo, a2 or hi
    b1, b2 = b1 or lo, b2 or hi
    return a1 <= b2 and b1 <= a2


def as_of_edges(edges, as_of):
    """`as_of`(YYYY-MM-DD) 시점에 유효한 edge만."""
    out = []
    for e in edges:
        f, t = e.get("validFrom"), e.get("validTo")
        if (f is None or f <= as_of) and (t is None or as_of <= t):
            out.append(e)
    return out


def find_effectivity_overlaps(edges):
    """같은 (부모, 자식)에 유효기간이 겹치는 행이 둘 이상."""
    g = defaultdict(list)
    for e in edges:
        g[(e["parentPn"], e["childPn"])].append(e)
    bad = []
    for k, rows in g.items():
        for i in range(len(rows)):
            for j in range(i + 1, len(rows)):
                a, b = rows[i], rows[j]
                if _ov(a.get("validFrom"), a.get("validTo"),
                       b.get("validFrom"), b.get("validTo")):
                    bad.append({"parentPn": k[0], "childPn": k[1], "a": a, "b": b})
    return bad


# ══════════════════════════════════════════════ 5. 그 밖의 검출기
def find_duplicate_edges(edges, key=("parentPn", "childPn")):
    """같은 부모에 같은 자식. 유효일자가 있으면 '동시에 유효한' 중복만 잡는다."""
    c = Counter(tuple(e[k] for k in key) for e in edges)
    dups = []
    for k, n in c.items():
        if n <= 1:
            continue
        rows = [e for e in edges if tuple(e[x] for x in key) == k]
        if any(e.get("validFrom") or e.get("validTo") for e in rows):
            if not any(_ov(a.get("validFrom"), a.get("validTo"),
                           b.get("validFrom"), b.get("validTo"))
                       for i, a in enumerate(rows) for b in rows[i + 1:]):
                continue
        dups.append({"key": dict(zip(key, k)), "count": n, "rows": rows})
    return dups


def find_composite_parents(edges, seps=("/", "\\", ",", "·", "&", " 및 ", "~")):
    out = []
    for e in edges:
        p = str(e["parentPn"])
        hit = [s for s in seps if s in p]
        if hit:
            out.append({"parentPn": p, "childPn": e["childPn"], "separators": hit,
                        "candidates": [x.strip() for x in p.replace("\\", "/").split("/")]})
    return out


def find_orphans(items, edges, roots=()):
    pns = {i["pn"] for i in items}
    has_par = {e["childPn"] for e in edges}
    has_kid = {e["parentPn"] for e in edges}
    return {
        "noParent": sorted(pns - has_par - set(roots)),
        "parentNotInItems": sorted({e["parentPn"] for e in edges} - pns),
        "childNotInItems": sorted({e["childPn"] for e in edges} - pns),
        "leafItems": sorted(pns - has_kid),
        "unreachable": sorted(pns - _reachable(edges, roots)) if roots else [],
    }


def _reachable(edges, roots):
    kids, seen, q = _kids(edges), set(roots), deque(roots)
    while q:
        n = q.popleft()
        for e in kids.get(n, []):
            if e["childPn"] not in seen:
                seen.add(e["childPn"])
                q.append(e["childPn"])
    return seen


def find_qty_anomalies(edges):
    out = {"nonPositive": [], "null": [], "fractional": [], "huge": []}
    for e in edges:
        q = e.get("qtyPerParent")
        if q is None:
            out["null"].append(e)
        elif q <= 0:
            out["nonPositive"].append(e)
        else:
            if abs(q - round(q)) > 1e-9:
                out["fractional"].append(e)
            if q >= 100000:
                out["huge"].append(e)
    return out


def find_unit_conflicts(items, edges, canon=None):
    item_unit = {i["pn"]: i.get("unit") for i in items}
    seen = defaultdict(set)
    for e in edges:
        if e.get("unit"):
            seen[e["childPn"]].add(e["unit"])
    out = {"edgeDisagree": [], "edgeVsItem": [], "unregistered": []}
    for pn, us in seen.items():
        if len(us) > 1:
            out["edgeDisagree"].append({"pn": pn, "units": sorted(us)})
        iu = item_unit.get(pn)
        if iu and us and iu not in us:
            out["edgeVsItem"].append({"pn": pn, "itemUnit": iu, "edgeUnits": sorted(us)})
    if canon is not None:
        for u in sorted({u for us in seen.values() for u in us} |
                        {v for v in item_unit.values() if v}):
            if u not in canon:
                out["unregistered"].append(u)
    return out


def find_alternate_conflicts(edges):
    """같은 (부모, altGroup)에서 동시에 유효한 행이 둘 이상 / 우선순위 중복·결측."""
    g = defaultdict(list)
    for e in edges:
        if e.get("altGroup"):
            g[(e["parentPn"], e["altGroup"])].append(e)
    out = {"simultaneous": [], "priorityDup": [], "priorityMissing": [], "singleton": []}
    for k, rows in g.items():
        if len(rows) == 1:
            out["singleton"].append({"key": k, "rows": rows})
            continue
        for i, a in enumerate(rows):
            for b in rows[i + 1:]:
                if _ov(a.get("validFrom"), a.get("validTo"),
                       b.get("validFrom"), b.get("validTo")):
                    out["simultaneous"].append({"key": k, "a": a, "b": b})
        pr = [e.get("altPriority") for e in rows]
        if any(p is None for p in pr):
            out["priorityMissing"].append({"key": k, "rows": rows})
        dups = [p for p, n in Counter(p for p in pr if p is not None).items() if n > 1]
        if dups:
            out["priorityDup"].append({"key": k, "priorities": dups})
    return out


# ══════════════════════════════════════════════ 6. 한 번에 돌리기
def run_all(items, edges, roots=(), canon=None, as_of=None):
    """모든 검출기를 돌려 요약 dict. 판정 자동화용."""
    cyc = detect_cycles(edges)
    res = {
        "cycles": cyc,
        "compositeParents": find_composite_parents(edges),
        "duplicateEdges": find_duplicate_edges(edges),
        "orphans": find_orphans(items, edges, roots),
        "qty": find_qty_anomalies(edges),
        "units": find_unit_conflicts(items, edges, canon),
        "effectivityOverlaps": find_effectivity_overlaps(edges),
        "alternates": find_alternate_conflicts(edges),
    }
    if roots and not cyc:
        res["explode"] = {r: explode(edges, r, as_of=as_of) for r in roots}
    res["blocking"] = (
        len(cyc)
        + len(res["compositeParents"])
        + len(res["duplicateEdges"])
        + len(res["orphans"]["parentNotInItems"])
        + len(res["qty"]["nonPositive"]) + len(res["qty"]["null"])
        + len(res["units"]["edgeDisagree"])
        + len(res["effectivityOverlaps"])
        + len(res["alternates"]["simultaneous"])
    )
    return res
