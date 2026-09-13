CREATE TRIGGER IF NOT EXISTS trg_proc_seq_upd BEFORE UPDATE OF seq, line ON processes
BEGIN
  SELECT RAISE(ABORT, 'R-22(seq): 이 공정의 투입이 부모 산출 공정보다 늦어진다')
   WHERE EXISTS (SELECT 1 FROM process_material pi
                   JOIN bom_line l ON l.line_id = pi.line_id
                   JOIN bom_header h ON h.bom_id = l.bom_id
                   JOIN process_material po ON po.item_id = h.parent_item_id AND po.io='OUT' AND po.is_final=1
                   JOIN processes pp ON pp.id = po.process_id
                  WHERE pi.process_id = NEW.id AND pi.io='IN' AND pp.id <> NEW.id
                    AND pp.line = NEW.line AND NEW.seq > pp.seq);
  SELECT RAISE(ABORT, 'R-22(seq): 이 산출 공정보다 늦게 투입되는 자식 라인이 생긴다')
   WHERE EXISTS (SELECT 1 FROM process_material po
                   JOIN bom_header h ON h.parent_item_id = po.item_id
                   JOIN bom_line l ON l.bom_id = h.bom_id
                   JOIN process_material pi ON pi.line_id = l.line_id AND pi.io='IN'
                   JOIN processes pc ON pc.id = pi.process_id
                  WHERE po.process_id = NEW.id AND po.io='OUT' AND po.is_final=1 AND pc.id <> NEW.id
                    AND pc.line = NEW.line AND pc.seq > NEW.seq);
  SELECT RAISE(ABORT, 'R-23(seq): 만들기 전에 소비하는 자재가 생긴다')
   WHERE EXISTS (SELECT 1 FROM process_material pi
                   JOIN bom_line l ON l.line_id = pi.line_id
                   JOIN process_material po ON po.item_id = l.child_item_id AND po.io='OUT' AND po.is_final=1
                   JOIN processes pm ON pm.id = po.process_id
                  WHERE pi.process_id = NEW.id AND pi.io='IN' AND pm.id <> NEW.id
                    AND pm.line = NEW.line AND NEW.seq < pm.seq);
END;
