# -*- coding: utf-8 -*-
"""
bomsql.py — 계획서 v0.9 스키마 위에서 도는 전개/역전개/점검 쿼리.

※ 계획서 v0.9 에는 **전개(정전개·역전개) SQL 이 한 줄도 없다.** §10.1 이 "재귀 CTE" 라고만 적었다.
   그래서 검증자가 직접 썼다. 아래 4가지를 계획서가 명시하지 않아 내가 정한 것이고,
   **v1.0 이 이 규칙을 문서에 박아야 한다** (검증보고서 R-18):
     ① 부모 1개당 소요 = qty_per / bom_header.base_qty
     ② 실소요 = ① / (1 - scrap_pct/100)
     ③ is_phantom=1 노드는 합계에서 제외하고 자식으로 내려간다 (경로에는 남긴다)
     ④ 전개 대상 BOM = status IN ('APPROVED','ACTIVE') AND as_of BETWEEN valid_from AND valid_to
"""
from __future__ import annotations

MAX_DEPTH = 10

EXPLODE = """
WITH RECURSIVE ex(item_id, pn, qty, uom, depth, path, is_phantom) AS (
  SELECT i.item_id, i.pn, CAST(:qty AS REAL), i.base_uom, 0, i.pn, i.is_phantom
    FROM item i WHERE i.pn = :root
  UNION ALL
  SELECT c.item_id, c.pn,
         ex.qty * l.qty_per / h.base_qty / (1.0 - l.scrap_pct/100.0),
         l.uom_code, ex.depth + 1, ex.path || ' > ' || c.pn, c.is_phantom
    FROM ex
    JOIN bom_header h ON h.parent_item_id = ex.item_id
                     AND h.status IN ('APPROVED','ACTIVE')
                     AND :asof BETWEEN h.valid_from AND h.valid_to
    JOIN bom_line   l ON l.bom_id = h.bom_id
                     AND :asof BETWEEN l.valid_from AND l.valid_to
    JOIN item       c ON c.item_id = l.child_item_id
   WHERE ex.depth < {d}
)
SELECT item_id, pn, qty, uom, depth, path, is_phantom FROM ex WHERE depth > 0
""".replace("{d}", str(MAX_DEPTH))

WHERE_USED = """
WITH RECURSIVE up(item_id, pn, qty, uom, depth, path) AS (
  SELECT i.item_id, i.pn, 1.0, i.base_uom, 0, i.pn
    FROM item i WHERE i.pn = :pn
  UNION ALL
  SELECT p.item_id, p.pn, up.qty * l.qty_per / h.base_qty, l.uom_code,
         up.depth + 1, p.pn || ' > ' || up.path
    FROM up
    JOIN bom_line   l ON l.child_item_id = up.item_id
                     AND :asof BETWEEN l.valid_from AND l.valid_to
    JOIN bom_header h ON h.bom_id = l.bom_id
                     AND h.status IN ('APPROVED','ACTIVE')
                     AND :asof BETWEEN h.valid_from AND h.valid_to
    JOIN item       p ON p.item_id = h.parent_item_id
   WHERE up.depth < {d}
)
SELECT item_id, pn, qty, uom, depth, path FROM up WHERE depth > 0
""".replace("{d}", str(MAX_DEPTH))


def has_bom(con, item_id, asof):
    return con.execute(
        "SELECT 1 FROM bom_header h JOIN bom_line l ON l.bom_id=h.bom_id"
        " WHERE h.parent_item_id=? AND h.status IN ('APPROVED','ACTIVE')"
        "   AND ? BETWEEN h.valid_from AND h.valid_to"
        "   AND ? BETWEEN l.valid_from AND l.valid_to LIMIT 1",
        (item_id, asof, asof)).fetchone() is not None


def explode(con, root="BLDC-500W-48V", qty=1.0, asof="2026-06-01"):
    rows = con.execute(EXPLODE, {"root": root, "qty": qty, "asof": asof}).fetchall()
    return [dict(item_id=r[0], pn=r[1], qty=r[2], uom=r[3], depth=r[4], path=r[5], phantom=r[6])
            for r in rows]


def leaf_totals(con, root="BLDC-500W-48V", qty=1.0, asof="2026-06-01"):
    """말단(전개가 더 안 되는) 품목만 단위별로 합산. 팬텀·중간조립품은 자동 제외된다."""
    tot, per_pn = {}, {}
    for r in explode(con, root, qty, asof):
        if has_bom(con, r["item_id"], asof):
            continue
        tot[r["uom"]] = tot.get(r["uom"], 0.0) + r["qty"]
        k = (r["pn"], r["uom"])
        per_pn[k] = per_pn.get(k, 0.0) + r["qty"]
    return tot, per_pn


def where_used(con, pn, asof="2026-06-01"):
    rows = con.execute(WHERE_USED, {"pn": pn, "asof": asof}).fetchall()
    return [dict(item_id=r[0], pn=r[1], qty=r[2], uom=r[3], depth=r[4], path=r[5]) for r in rows]


# ── §6 점검 쿼리 ────────────────────────────────────────────────────────────
Q_R4_ORPHAN = """
SELECT i.pn, i.name, i.item_type FROM item i
 WHERE i.status IN ('APPROVED','ACTIVE') AND i.item_type <> 'FG'
   AND NOT EXISTS (SELECT 1 FROM bom_line l WHERE l.child_item_id = i.item_id)"""

Q_R5_LOST_SA = """
SELECT i.pn, i.name FROM item i
 WHERE i.item_type = 'SA'
   AND NOT EXISTS (SELECT 1 FROM bom_header h JOIN bom_line l ON l.bom_id = h.bom_id
                    WHERE h.parent_item_id = i.item_id)"""

# R-10 · R-12 는 계획서에 규칙만 있고 쿼리가 없다 — 검증자가 작성 (R-18)
Q_R10_SPLIT = """
SELECT l.line_id, ip.pn, ic.pn, COALESCE(SUM(pm.split_pct),0) AS s
  FROM bom_line l
  JOIN bom_header h ON h.bom_id=l.bom_id
  JOIN item ip ON ip.item_id=h.parent_item_id
  JOIN item ic ON ic.item_id=l.child_item_id
  LEFT JOIN process_material pm ON pm.line_id=l.line_id AND pm.io='IN'
 GROUP BY l.line_id HAVING s <> 100"""

Q_R12_EMPTY_PHANTOM = """
SELECT i.pn FROM item i WHERE i.is_phantom=1
   AND NOT EXISTS (SELECT 1 FROM bom_header h JOIN bom_line l ON l.bom_id=h.bom_id
                    WHERE h.parent_item_id=i.item_id)"""

Q_PROC_NO_INPUT = """
SELECT p.op, p.name FROM processes p
 WHERE NOT EXISTS (SELECT 1 FROM process_material pm WHERE pm.process_id=p.id AND pm.io='IN')"""
