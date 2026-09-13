# -*- coding: utf-8 -*-
"""
r2_lot.py — V-9 : 로트 계보 1건 완주(정·역방향)를 서술형으로 찍는다.
판정 자체는 r2_tests.py 의 TC-45~47 · TC-H1~H4 가 낸다. 이 스크립트는 **감사 대응 화면 그대로** 보여준다.

실행: python r2_lot.py    (출력 → out/07_lot.log)
"""
from __future__ import annotations
import io, os, shutil, sqlite3
import r2_tests as T

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

buf = io.StringIO()
def log(s=""):
    print(s); buf.write(s + "\n")


def main():
    src = os.path.join(OUT, "bldc_v09.db")
    dst = os.path.join(OUT, "lot_demo.db")
    if os.path.exists(dst): os.remove(dst)
    shutil.copyfile(src, dst)
    c = sqlite3.connect(dst); c.execute("PRAGMA foreign_keys=ON")
    T.seed_lots(c); c.commit()

    log("=" * 78)
    log("§3 실증 검증 — [6] V-9 : 로트 계보 1건 완주")
    log("    시나리오는 계획서 §3.3 그대로 (코일 → 서브로트 → SC-1010P → SC-1010 → SA-1000 → 시리얼)")
    log("=" * 78)

    log("\n── 적재된 로트 ──")
    for r in c.execute("SELECT m.lot_no, i.pn, m.lot_kind, m.qty, m.uom_code,"
                       " (SELECT lot_no FROM mat_lot p WHERE p.lot_id=m.parent_lot_id),"
                       " m.supplier, m.supplier_lot FROM mat_lot m"
                       " JOIN item i ON i.item_id=m.item_id ORDER BY m.lot_id"):
        log(f"   {r[0]:28} {r[1]:14} {r[2]:6} {r[3]:>9} {r[4]:3}"
            f"  부모={r[5] or '-':22} {r[6] or ''} {r[7] or ''}")

    log("\n── 계보 행 (4M 이 한 행에 모인다) ──")
    for r in c.execute("""
        SELECT o.lot_no, i.lot_no, p.op, e.code, u.name, g.qty_consumed, g.uom_code, g.record_id
          FROM lot_genealogy g
          JOIN mat_lot o ON o.lot_id=g.out_lot_id
          JOIN mat_lot i ON i.lot_id=g.in_lot_id
          LEFT JOIN processes p ON p.id=g.process_id
          LEFT JOIN equipments e ON e.id=g.equipment_id
          LEFT JOIN users u ON u.id=g.user_id
         ORDER BY g.gen_id"""):
        log(f"   산출 {r[0]:26} ← 투입 {r[1]:26} @ {r[2]} / 설비 {r[3]} / 작업자 {r[4]}"
            f" / {r[5]} {r[6]} / 실적 #{r[7]}")

    log("\n── 정방향 : '밀시트 MS-8842 코일이 들어간 완성품을 전부 대라' ──")
    for d, lot, pn, path in c.execute(T.GEN_FWD, {"lot": "LOT-SC1011-260912-A"}):
        log(f"   [{d}] {'  '*d}{lot:28} {pn}")
    log("\n── 역방향 : 'SN-BLDC-2026-000481 에 쓰인 자재 로트를 전부 대라' ──")
    for d, lot, pn, path in c.execute(T.GEN_BACK, {"lot": "SN-BLDC-2026-000481"}):
        log(f"   [{d}] {'  '*d}{lot:28} {pn}")
    end = c.execute("SELECT supplier, supplier_lot FROM mat_lot"
                    " WHERE lot_no='LOT-SC1011-260912-A'").fetchone()
    log(f"\n   종착점 = 공급사 {end[0]} · 밀시트 {end[1]}  ← 역추적이 사외까지 닿는다")

    log("\n── 답하지 못하는 질문 (이번 구조의 한계) ──")
    log("   ① 'OP-A80 함침 배치 #7 에 들어간 스테이터 30개를 대라'")
    log("      → 배치를 묶는 로트가 없다. mat_lot.proc_state 는 텍스트라 '어느 30개'를 못 묶는다 (V-12 §4.3 반례)")
    log("   ② 'SUB-SC1011-A-001 이 실제로 0.85 kg 만큼 쓰였나'")
    log("      → lot_genealogy.qty_consumed 는 있으나, **원로트 잔량이 자동으로 줄지 않는다.**")
    log("         mat_lot.qty 와 계보 소비량을 맞추는 규칙이 계획서에 없다 (재고는 범위 밖이라 해도, ")
    log("         '전량 소진(qty=0)' 을 누가 언제 쓰는지는 정해야 한다) → 결함 D-17")
    bal = c.execute("SELECT lot_no, qty FROM mat_lot WHERE lot_no LIKE 'LOT-SC1011%'").fetchone()
    sub = c.execute("SELECT SUM(qty) FROM mat_lot WHERE parent_lot_id="
                    "(SELECT lot_id FROM mat_lot WHERE lot_no='LOT-SC1011-260912-A')").fetchone()[0]
    log(f"      실측: 원로트 {bal[0]} qty={bal[1]} · 서브로트 합계={sub}"
        f" → **합이 {bal[1]+sub} 로 원로트의 2배가 된다.** 분할 시 원로트를 줄일지 둘지가 미정이다")
    log("   ③ '완성품 1대에 들어간 BT-3070 볼트 8개의 로트'")
    log("      → BULK 출고(§4.5) 품목은 계보 행을 만들 근거가 없다. 백플러시 규칙이 issue_method 별로")
    log("         어떻게 다른지 계획서에 없다 → 결함 D-18")

    c.close()
    open(os.path.join(OUT, "07_lot.log"), "w", encoding="utf-8").write(buf.getvalue())


if __name__ == "__main__":
    main()
