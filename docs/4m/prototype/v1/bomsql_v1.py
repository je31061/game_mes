# -*- coding: utf-8 -*-
"""
bomsql_v1.py — 계획서 v1.0 §5.9 기준 쿼리(ddl-v1.sql 절 I 의 Q-1 · Q-2 · Q-3 · Q-5)를 **주석을 벗겨 그대로** 쓴다.
v0.9 때는 계획서에 전개 SQL 이 없어 검증자가 규칙을 정했다(bomsql.py). v1.0 은 DDL 이 정본이므로 여기서는 옮겨 적기만 한다.
차이가 나면 DDL 절 I 가 틀린 것이다.
"""
from __future__ import annotations

# ── Q-1 정전개 (DDL 절 I 원문, :root :qty :asof) ─────────────────────────
Q1 = """
WITH RECURSIVE eff AS (
  SELECT h.parent_item_id, h.base_qty, l.line_id, l.child_item_id, l.uom_code, l.bop_link, l.qty_per,
         CASE WHEN l.qty_basis='GROSS' THEN (1.0-l.scrap_pct/100.0) ELSE 1.0 END AS nf,
         CASE WHEN l.qty_basis='GROSS' THEN 1.0 ELSE 1.0/(1.0-l.scrap_pct/100.0) END AS gf
    FROM bom_header h JOIN bom_line l ON l.bom_id=h.bom_id
   WHERE h.status IN ('APPROVED','ACTIVE') AND :asof BETWEEN h.valid_from AND h.valid_to
     AND :asof BETWEEN l.valid_from AND l.valid_to
     AND (l.alt_group IS NULL OR l.alt_priority = (SELECT MIN(alt_priority) FROM bom_line l2
           WHERE l2.bom_id=l.bom_id AND l2.alt_group=l.alt_group AND :asof BETWEEN l2.valid_from AND l2.valid_to))),
ex(item_id, pn, depth, qty, qty_gross, uom, path, is_phantom, line_id) AS (
  SELECT i.item_id, i.pn, 0, CAST(:qty AS REAL), CAST(:qty AS REAL), i.base_uom, i.pn, i.is_phantom, NULL
    FROM item i WHERE i.pn = :root
  UNION ALL
  SELECT c.item_id, c.pn, ex.depth+1, ex.qty*e.qty_per*e.nf/e.base_qty, ex.qty_gross*e.qty_per*e.gf/e.base_qty, e.uom_code,
         ex.path || ' > ' || c.pn, c.is_phantom, e.line_id
    FROM ex JOIN eff e ON e.parent_item_id = ex.item_id JOIN item c ON c.item_id = e.child_item_id
   WHERE ex.depth < 64)
"""
Q1_SELECT = Q1 + "SELECT item_id, pn, depth, qty, qty_gross, uom, path, is_phantom, line_id FROM ex WHERE depth > 0"

# 말단 = 유효 BOM 이 없는 품목 · 팬텀 제외 (Q-2 조건 그대로). 원 단위(uom) 별 합 — §1.9 기대값(EA 76 · g 221 · SHT 12 · kg 0.85 · m 0.5) 대조용
Q2_RAW = Q1 + """
SELECT ex.pn, ex.uom, SUM(ex.qty) AS qty
  FROM ex
 WHERE ex.depth > 0 AND ex.is_phantom = 0
   AND NOT EXISTS (SELECT 1 FROM eff e WHERE e.parent_item_id = ex.item_id)
 GROUP BY ex.pn, ex.uom"""

# Q-2 원문: 차원 기준단위 환산 (kg 0.85 + g 221 → MASS 1.071 kg)
Q2_BASE = Q1 + """
SELECT ex.pn, b.dim, b.base_uom, SUM(ex.qty * b.to_base) AS qty_base
  FROM ex JOIN v_uom_base b ON b.uom_code = ex.uom
 WHERE ex.depth > 0 AND ex.is_phantom = 0
   AND NOT EXISTS (SELECT 1 FROM eff e WHERE e.parent_item_id = ex.item_id)
 GROUP BY ex.pn, b.dim, b.base_uom"""

# ── Q-3 역전개 (DDL 절 I 원문, :pn :asof) ────────────────────────────────
Q3 = """
WITH RECURSIVE up(item_id, pn, qty, depth, path) AS (
  SELECT i.item_id, i.pn, 1.0, 0, i.pn FROM item i WHERE i.pn = :pn
  UNION ALL
  SELECT p.item_id, p.pn, up.qty * l.qty_per / h.base_qty, up.depth+1, p.pn || ' > ' || up.path
    FROM up JOIN bom_line l ON l.child_item_id = up.item_id AND :asof BETWEEN l.valid_from AND l.valid_to
    JOIN bom_header h ON h.bom_id = l.bom_id AND h.status IN ('APPROVED','ACTIVE') AND :asof BETWEEN h.valid_from AND h.valid_to
    JOIN item p ON p.item_id = h.parent_item_id
   WHERE up.depth < 64)
SELECT item_id, pn, qty, depth, path FROM up WHERE depth > 0"""

# ── Q-5 로트 추적 (DDL 절 I 원문, :lot) ─────────────────────────────────
_LOT_EDGE = """
WITH RECURSIVE lot_edge(parent, child, kind) AS (
  SELECT parent_lot_id, lot_id, 'SPLIT' FROM mat_lot WHERE parent_lot_id IS NOT NULL
  UNION ALL SELECT in_lot_id, out_lot_id, 'CONSUME' FROM lot_genealogy),
"""
Q5_FWD = _LOT_EDGE + """
fwd(lot_id, depth, path) AS (
  SELECT lot_id, 0, lot_no FROM mat_lot WHERE lot_no = :lot
  UNION SELECT e.child, fwd.depth+1, fwd.path || ' > ' || m.lot_no
    FROM fwd JOIN lot_edge e ON e.parent = fwd.lot_id JOIN mat_lot m ON m.lot_id = e.child WHERE fwd.depth < 64)
SELECT f.depth, m.lot_no, i.pn, m.lot_kind, f.path FROM fwd f JOIN mat_lot m ON m.lot_id = f.lot_id JOIN item i ON i.item_id = m.item_id ORDER BY f.depth"""
Q5_BACK = _LOT_EDGE + """
back(lot_id, depth, path) AS (
  SELECT lot_id, 0, lot_no FROM mat_lot WHERE lot_no = :lot
  UNION SELECT e.parent, back.depth+1, back.path || ' < ' || m.lot_no
    FROM back JOIN lot_edge e ON e.child = back.lot_id JOIN mat_lot m ON m.lot_id = e.parent WHERE back.depth < 64)
SELECT b.depth, m.lot_no, i.pn, m.lot_kind, b.path FROM back b JOIN mat_lot m ON m.lot_id = b.lot_id JOIN item i ON i.item_id = m.item_id ORDER BY b.depth"""


def explode(con, root="BLDC-500W-48V", qty=1.0, asof="2026-06-01"):
    rows = con.execute(Q1_SELECT, dict(root=root, qty=qty, asof=asof)).fetchall()
    return [dict(item_id=r[0], pn=r[1], depth=r[2], qty=r[3], qty_gross=r[4], uom=r[5], path=r[6], phantom=r[7], line_id=r[8]) for r in rows]


def leaf_totals(con, root="BLDC-500W-48V", qty=1.0, asof="2026-06-01"):
    """(단위별 합, {(pn,uom): qty}) — 원 단위 기준 (§1.9 대조)"""
    tot, per = {}, {}
    for pn, uom, q in con.execute(Q2_RAW, dict(root=root, qty=qty, asof=asof)):
        tot[uom] = tot.get(uom, 0.0) + q
        per[(pn, uom)] = per.get((pn, uom), 0.0) + q
    return tot, per


def base_totals(con, root="BLDC-500W-48V", qty=1.0, asof="2026-06-01"):
    """차원 기준단위 합 {(dim, base_uom): qty}"""
    tot = {}
    for pn, dim, base, q in con.execute(Q2_BASE, dict(root=root, qty=qty, asof=asof)):
        tot[(dim, base)] = tot.get((dim, base), 0.0) + (q or 0.0)
    return tot


def where_used(con, pn, asof="2026-06-01"):
    return [dict(item_id=r[0], pn=r[1], qty=r[2], depth=r[3], path=r[4]) for r in con.execute(Q3, dict(pn=pn, asof=asof))]


def lot_fwd(con, lot):
    return con.execute(Q5_FWD, dict(lot=lot)).fetchall()


def lot_back(con, lot):
    return con.execute(Q5_BACK, dict(lot=lot)).fetchall()


def has_bom(con, item_id, asof):
    return con.execute("SELECT 1 FROM bom_header h JOIN bom_line l ON l.bom_id=h.bom_id WHERE h.parent_item_id=?"
                       " AND h.status IN ('APPROVED','ACTIVE') AND ? BETWEEN h.valid_from AND h.valid_to"
                       " AND ? BETWEEN l.valid_from AND l.valid_to LIMIT 1", (item_id, asof, asof)).fetchone() is not None
