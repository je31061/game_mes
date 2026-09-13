-- 노하린 2라운드 보완안 — ddl-v1.sql §G 에 덧붙일 점검 뷰 (윤태경 소유 파일이므로 여기서 시험만 한다)
-- 멱등: ddl-v1.sql 은 매 기동 실행된다. 뷰는 CREATE VIEW IF NOT EXISTS 로 두면 "정의를 고쳐도 반영되지 않는" 함정이 있으므로
--       DROP VIEW IF EXISTS → CREATE VIEW 쌍으로 쓴다. (뷰에는 데이터가 없어 DROP 이 안전하다. 테이블·인덱스는 IF NOT EXISTS 유지)

-- ── [D-9] 공정당 산출(OUT) 행 정확히 1행 — E-3 ────────────────────────────
-- "24공정 전부 OUT 1행" 은 지금까지 적재기 관행일 뿐 제약이 없었다. 신설 공정에 OUT 을 빠뜨려도 아무도 못 잡는다.
DROP VIEW IF EXISTS v_chk_proc_no_out;
CREATE VIEW v_chk_proc_no_out AS
SELECT 'D-9' AS rule,
       p.op || ' ' || COALESCE(p.name,'') || ' — OUT ' ||
       (SELECT COUNT(*) FROM process_material m WHERE m.process_id = p.id AND m.io = 'OUT') || '행' AS detail
  FROM processes p
 WHERE (SELECT COUNT(*) FROM process_material m WHERE m.process_id = p.id AND m.io = 'OUT') <> 1;

-- ── [D-19] 같은 공정이 같은 품목을 산출하면서 투입 — E-4 (수명 0 로트) ──────
DROP VIEW IF EXISTS v_chk_self_feed;
CREATE VIEW v_chk_self_feed AS
SELECT 'D-19' AS rule, p.op || ' 가 ' || i.pn || ' 을 산출하면서 같은 공정에서 투입' AS detail
  FROM process_material po
  JOIN processes p ON p.id = po.process_id
  JOIN item i ON i.item_id = po.item_id
 WHERE po.io = 'OUT'
   AND EXISTS (SELECT 1 FROM process_material pi JOIN bom_line l ON l.line_id = pi.line_id
                WHERE pi.process_id = po.process_id AND pi.io = 'IN' AND l.child_item_id = po.item_id);

-- ── [R-23] 자식을 만들기 전에 소비한다 — R-22 가 못 보는 축 ────────────────
-- R-22 는 "부모 OUT vs 자식 IN" 만 본다. 자식이 스스로 MAKE 인 경우 "자식 OUT vs 그 자식의 IN" 은 아무도 안 본다.
-- (결의안 §3 C-1 이 지적한 바로 그 구멍. 결의안은 이 뷰를 추가하지 않았다)
DROP VIEW IF EXISTS v_chk_make_before_use;
CREATE VIEW v_chk_make_before_use AS
SELECT 'R-23' AS rule,
       ic.pn || ' 투입@' || pc.op || '(seq ' || pc.seq || ') < 산출@' || pm.op || '(seq ' || pm.seq || ')'
       || CASE WHEN pc.line <> pm.line THEN ' [라인 다름 — 수동 확인]' ELSE '' END AS detail
  FROM bom_line l
  JOIN item ic ON ic.item_id = l.child_item_id
  JOIN process_material pi ON pi.line_id = l.line_id AND pi.io = 'IN'
  JOIN processes pc ON pc.id = pi.process_id
  JOIN process_material po ON po.item_id = l.child_item_id AND po.io = 'OUT' AND po.is_final = 1
  JOIN processes pm ON pm.id = po.process_id
 WHERE pc.line = pm.line AND pc.seq < pm.seq;

-- ── [D-20] mat_lot.state_pm_id 가 없는 행을 가리킨다 — E-9 ─────────────────
-- PRAGMA foreign_keys 가 OFF 라 OUT 행 DELETE 가 조용히 끊는다. 되돌리기(§7 5·6번)가 정확히 이 경로다.
DROP VIEW IF EXISTS v_chk_lot_state_dangling;
CREATE VIEW v_chk_lot_state_dangling AS
SELECT 'D-20' AS rule, m.lot_no || ' state_pm_id=' || m.state_pm_id || ' (없는 행)' AS detail
  FROM mat_lot m
 WHERE m.state_pm_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM process_material pm WHERE pm.pm_id = m.state_pm_id);

-- ── [D-21] 설비 좌표 — 겹침 · 맵 밖 · 존 밖 — E-8 ─────────────────────────
-- DB 경로로 들어오는 좌표는 server/index.js 의 clampInt(0..23 / 0..15) 를 타지 않는다. 맵 크기는 24×16 상수.
DROP VIEW IF EXISTS v_chk_eq_pos;
CREATE VIEW v_chk_eq_pos AS
SELECT 'D-21' AS rule, '겹침 (' || a.x || ',' || a.y || ') ' || group_concat(a.code) AS detail
  FROM equipments a GROUP BY a.x, a.y HAVING COUNT(*) > 1
UNION ALL
SELECT 'D-21', e.code || ' 맵 밖 (' || e.x || ',' || e.y || ')' FROM equipments e
 WHERE e.hidden = 0 AND (e.x < 0 OR e.x > 23 OR e.y < 0 OR e.y > 15)
UNION ALL
SELECT 'D-21', e.code || ' 존 밖 (' || e.x || ',' || e.y || ') zone ' || z.name FROM equipments e
  JOIN zones z ON z.id = e.zone_id
 WHERE e.hidden = 0 AND z.hidden = 0
   AND NOT (e.x >= z.rect_x AND e.x < z.rect_x + z.rect_w AND e.y >= z.rect_y AND e.y < z.rect_y + z.rect_h);

-- ── 확장 요약 (v_chk_summary 를 대체할 때 쓸 본문) ─────────────────────────
DROP VIEW IF EXISTS v_chk_summary2;
CREATE VIEW v_chk_summary2 AS
SELECT rule, COUNT(*) AS cnt FROM (
  SELECT rule FROM v_chk_r1_cycle          UNION ALL
  SELECT rule FROM v_chk_r2_depth          UNION ALL
  SELECT rule FROM v_chk_r4_orphan         UNION ALL
  SELECT rule FROM v_chk_r5_lost_sa        UNION ALL
  SELECT rule FROM v_chk_r10_split         UNION ALL
  SELECT rule FROM v_chk_bop_unassigned    UNION ALL
  SELECT rule FROM v_chk_r12_phantom_empty UNION ALL
  SELECT rule FROM v_chk_r22_seq           UNION ALL
  SELECT rule FROM v_chk_trace_serial      UNION ALL
  SELECT rule FROM v_chk_bulk_trace        UNION ALL
  SELECT rule FROM v_chk_lot_qty           UNION ALL
  SELECT rule FROM v_chk_proc_no_out       UNION ALL
  SELECT rule FROM v_chk_self_feed         UNION ALL
  SELECT rule FROM v_chk_make_before_use   UNION ALL
  SELECT rule FROM v_chk_lot_state_dangling UNION ALL
  SELECT rule FROM v_chk_eq_pos
) GROUP BY rule;
