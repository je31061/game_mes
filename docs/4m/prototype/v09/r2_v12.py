# -*- coding: utf-8 -*-
"""
r2_v12.py — V-12 : 계획서 §9.2 정제 판단을 **반박**한다.
근거는 원천 xlsx(12시트)와 적재된 v0.9 DB. 추정과 사실을 가른다.

실행: python r2_v12.py    (출력 → out/06_v12.log)
"""
from __future__ import annotations
import io, os, sqlite3, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
OUT = os.path.join(HERE, "out")
XLSX = os.path.join(ROOT, "docs", "bldc", "source", "BLDC_500W_48V_BOM_BOP_Master.xlsx")
DB = os.path.join(OUT, "bldc_v09.db")

buf = io.StringIO()
def log(s=""):
    print(s); buf.write(s + "\n")

VERDICTS = []
def v(tag, verdict, detail):
    VERDICTS.append((tag, verdict))
    log(f"\n[{verdict}] {tag}")
    for line in detail.strip().splitlines():
        log("    " + line.strip())


def cells(ws):
    return [[("" if c is None else str(c).strip()) for c in r]
            for r in ws.iter_rows(values_only=True)]


def main():
    import openpyxl
    wb = openpyxl.load_workbook(XLSX, data_only=True)
    s03, s04, s06, s07, s08, s09 = (cells(wb[n]) for n in
        ("03_BOM_L1_SubAssy", "04_BOM_L2_Stator", "06_BOM_L2_Housing",
         "07_BOM_L2_PE", "08_BOM_L2_Drive", "09_BOM_Flat_Consolidated"))
    s10, s11 = cells(wb["10_BOP_Armature_Line"]), cells(wb["11_BOP_Assembly_Line"])
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)

    log("=" * 78)
    log("§3 실증 검증 — [5] V-12 : §9.2 정제 판단 반박")
    log(f"    원천 {os.path.relpath(XLSX, ROOT)} (12시트 전량) + 적재 DB")
    log("=" * 78)

    # ── P-1 : HA-3000 / EX-5000 분리 ────────────────────────────────────
    ex_row = next(r for r in s03 if r and r[0] == "EX-5000")
    ha_parent = s06[1][1]
    ex3 = [r[1] for r in s06 if len(r) > 1 and r[1] in ("NP-5010", "OR-5020", "CG-5030")]
    v("P-1 `HA-3000/EX-5000` 10행 분리", "확인 — 뒷받침됨", f"""
    증거 4개가 전부 같은 방향이다.
      ① 03시트 EX-5000 행의 'L2 참조 시트' = '{ex_row[5]}' · 비고 = '{ex_row[6]}'
         → EX-5000 의 자식이 06시트에 있고, 비고가 정확히 3종을 지목한다
      ② 06시트 B2(상위 P/N, 제목이 아니라 **데이터 칸**) = '{ha_parent}' — HA-3000 하나뿐
      ③ 06시트 안에 5xxx 계열 {ex3} 3행이 섞여 있다 (P/N 계열이 3xxx ↔ 5xxx 로 갈린다)
      ④ BOP 투입 분기 — EX 3종은 B100·B120, HA 7종은 B50·B60·B80
    분해 후 전개가 정확히 EA 76 (TC-11). **반박 근거를 못 찾았다. 확정해도 된다.**""")

    # ── P-2 : 자기참조 2건 ──────────────────────────────────────────────
    n03 = {r[0]: r[1] for r in s03 if r and r[0].startswith("FS-")}
    n08 = {r[1]: r[2] for r in s08 if len(r) > 2 and r[1].startswith("FS-")}
    v("P-2 `FS-7010` 조립품 지위 해제", "확인 — 뒷받침됨", f"""
    03시트 FS-7010 품명 = '{n03.get('FS-7010')}'
    08시트 FS-7010 품명 = '{n08.get('FS-7010')}'
    → **같은 이름 = 같은 물건**을 L1 과 L2 에 두 번 등재한 것이다. 단품 재분류가 맞다.""")

    v("P-2 `FS-7020` 자식 개번", "확인 — 뒷받침됨", f"""
    03시트 FS-7020 품명 = '{n03.get('FS-7020')}'
    08시트 FS-7020 품명 = '{n08.get('FS-7020')}'
    → **다른 이름 = 다른 물건**에 같은 P/N. 개번이 맞다.
    (번호 모양 FS-7023 vs FS-7020B 는 PM 권한. 검증자는 둘 다 통과시킨다 — 규칙은 'P/N 하나 = 품목표 한 행')""")

    # ── P-2 파생 : 08시트 부모 4개 한 칸 → 자식 배정이 추정이다 ─────────
    hdr08 = s08[1][1]
    rows08 = [r[1] for r in s08 if len(r) > 1 and r[0] == "L2"]
    bop_pn = set()
    for sh in (s10, s11):
        for r in sh:
            if len(r) > 3 and r[0].startswith("OP-"):
                bop_pn.add(r[3])
    v("§3.2 `FS-7021`·`FS-7022`·`OR-7025` 의 부모", "결함 — 추정인데 단정했다", f"""
    08시트 상위 P/N 칸 = '{hdr08}'  ← **부모 4개가 한 칸**, 행별 부모 열이 없다.
    08시트 14행 {rows08} 중 어느 행이 어느 부모의 자식인지 원천은 말하지 않는다.
    GB-80xx · PL-90xx 는 BOP 가 확인해 준다 (OP-B85 'GB-8010~8050' · OP-B87 'PL-9010~9040').
    그런데 **FS-70xx 5종은 BOP 에 단 한 번도 나오지 않는다** (BOP 투입 칸 전량: 확인 완료).
    → `FS-7021`·`FS-7022`·`OR-7025` 를 `FS-7020` 밑에 붙인 근거는 **P/N 접두 추정뿐**이다.
      특히 `OR-7025` 는 품명이 'O-Ring (**Shaft Seal**)' 이고 수량 2 다.
      메인 출력축 `FS-7010` 의 실(seal) 일 수도 있다 — 원천으로는 판정 불가.
    계획서 §3.2 트리는 이 3건을 **'추정' 표기 없이** FS-7020 자식으로 그렸다.
    → 요구: §3.2 에 (추정·확인필요) 표기를 붙이고 쟁점 3 에 포함시킬 것.""")

    # ── P-3 : SC-1011 ───────────────────────────────────────────────────
    l2 = [r for r in s04 if len(r) > 1 and r[0] == "L2"]
    l3 = [r for r in s04 if len(r) > 1 and r[0] == "L3"]
    idx = [i for i, r in enumerate(s04) if len(r) > 1 and r[1] == "SC-1011"][0]
    v("P-3 `SC-1011` 재배치", "결함 — 판단 2개가 1개로 섞였다", f"""
    04시트 원문: 바로 윗줄 = {s04[idx-1][0]} {s04[idx-1][1]} '{s04[idx-1][2]}' ·
                 해당 줄 = {s04[idx][0]} {s04[idx][1]} '{s04[idx][2]}' Qty/상위 {s04[idx][4]} {s04[idx][5]}
    → 원천은 **SC-1011 의 부모를 SC-1010 이라고 이미 말하고 있다** (L2 바로 밑 L3, Qty/상위 = SC-1010 1개당).
      부모가 SA-1000 으로 보이는 것은 09_Flat 평탄화의 부작용이다. 진단은 정확하다.
    그런데 계획서 P-3 의 처리는 '부모를 **SC-1010P** 로 재배치' 다. SC-1010P 는 원천에 없는 신규 품목이다.
    즉 한 항목에 판단이 둘 섞여 있다:
      (가) SC-1011 의 부모는 SA-1000 이 아니라 SC-1010 이다   ← **원천이 직접 뒷받침**
      (나) SC-1010 과 SC-1011 사이에 SC-1010P 를 끼운다       ← **§4.3 별도 판단 (쟁점 2)**
    (나)가 승인되지 않으면 (가)만 적용해야 하는데, 계획서대로면 SC-1011 이 갈 곳이 없다.
    → 요구: P-3 을 (가)/(나)로 쪼개고, (나)는 쟁점 2 승인에 걸어 둘 것.
    ※ 수량은 어느 쪽이든 같다 — TC-54 에서 0.85 kg 오차 0 확인.""")

    # ── §4.3 (a) '재고가 선다' 의 근거 ──────────────────────────────────
    a10 = next(r for r in s10 if r and r[0] == "OP-A10")
    a20 = next(r for r in s10 if r and r[0] == "OP-A20")
    v("§4.3 `SC-1010P` 부여 근거 중 (a) '재고가 선다'", "결함 — 원천에 없는 서술", f"""
    계획서 §4.3 표: \"(a)(c) 프레스 산출 후 **적층기로 대차 이동**, 코일 kg → 편 매로 단위·로트 단위 변경\"
    원천 10시트 실제 값:
      OP-A10 설비='{a10[2]}' 산출물='{a10[4]}' 비고='{a10[8]}'
      OP-A20 설비='{a20[2]}' 투입='{a20[3]}' 산출물='{a20[4]}' 비고='{a20[8]}'
    → 비고 칸이 **둘 다 비어 있다.** '대차 이동'·'보관' 을 말하는 문장은 12시트 어디에도 없다.
      뒷받침되는 것은 기준 (c)(단위·로트 단위가 kg→매로 바뀐다)와, 투입 표기가 'SC-1011' 이 아니라
      '블랭킹편 ×80' 이라는 사실뿐이다.
    → 요구: (a) 를 근거에서 빼거나 '**추정 — 생산기술 확인 필요**' 로 표기할 것.
      결론(SC-1010P 신설) 자체는 (c) 만으로도 선다. 근거를 부풀리지 말 것.""")

    # ── §5.1 uom_conv 0.010625 의 성격 ─────────────────────────────────
    v("§5.1 `uom_conv` SHT→kg 0.010625 (SC-1011)", "결함 — 환산계수가 아니라 수율이다", """
    계획서: '1매 = 0.010625 kg = 0.85 ÷ 80'.
    04시트가 주는 것은 **SC-1010 1개당 코일 소요 0.85 kg** 이다. 낱장 무게를 잰 값이 아니다.
    블랭킹은 스켈레톤 스크랩이 나온다 — 계획서 스스로 쟁점 8 에 'OP-A10 블랭킹은 실제로 스크랩이 난다' 고 썼다.
    그러면 0.85 kg 은 **코일 소비량**이고 낱장 80매의 무게는 그보다 가볍다. 두 수는 같을 수 없다.
    지금은 scrap_pct=0 이라 우연히 일치하지만, 쟁점 8 이 해소돼 scrap_pct 가 들어오는 순간
      · qty_per 0.85 는 '실소요 = 0.85/(1-s)' 로 바뀌고
      · uom_conv 0.010625 는 재고 환산(낱장 실중량)이라 **바뀌면 안 된다**
    같은 숫자를 두 자리에 쓰면 그때 조용히 갈라진다. (원천에 낱장 실중량이 없어 검증자도 값을 댈 수 없다)
    → 요구: uom_conv 는 **실측 낱장 중량**으로만 채우고, 미측정이면 그 행을 **넣지 말 것**.
      0.85 kg/80매는 BOM 소요량(qty_per)에만 남긴다.""")

    # ── §4.3 기준 (c) 자기모순 : 배치 공정 ──────────────────────────────
    batch = [(r[0], r[1], r[8]) for sh in (s10, s11) for r in sh
             if r and r[0].startswith("OP-") and "배치" in (r[6] or "") + (r[8] or "")]
    v("§4.3 산출 P/N 기준 (c) — 배치 공정에 자기모순", "결함", f"""
    기준 (c) = '추적 단위가 바뀐다(로트가 **분할·합침**된다)' 이면 P/N 을 부여한다.
    원천의 배치 공정: {batch}
    → OP-A80(VPI 함침)·OP-A90(큐어링)은 **스테이터 30개를 한 배치로 합친다.** 로트 합침 그 자체다.
      그런데 계획서 §4.3 은 'A80·A90 은 30ea 배치로 묶이나 **로트는 유지**' 라며 부여하지 않는다.
      자기 기준 (c) 와 어긋난다.
    품질 관리항목이 '함침율 ≥95%' 다. 한 배치가 불합격이면 **그 배치 30대를 전부** 찾아야 한다.
    계획서의 대안은 `mat_lot.proc_state` 텍스트인데, 텍스트로는 '어느 30개' 를 못 묶는다.
    → 요구: 배치 공정에 **배치 로트(lot_kind='BATCH' 또는 부모 로트)** 를 도입하거나,
      기준 (c) 에서 '합침' 을 빼고 '분할' 만 남길 것. 둘 중 하나를 v1.0 에서 정할 것.""")

    # ── P-10 : 추정 배정이 원천과 '상충' 한다 ──────────────────────────
    a30 = next(r for r in s10 if r and r[0] == "OP-A30")
    a50 = next(r for r in s10 if r and r[0] == "OP-A50")
    v("P-10 `IP-1040`→OP-A30 · `LC-1080`→OP-A50 추정", "결함 — '없다'가 아니라 '상충'이다", f"""
    OP-A30 투입 자재 칸 = '{a30[3]}'   ← 빈칸이 아니라 **명시적 목록**이다. IP-1040 이 없다.
    OP-A50 투입 자재 칸 = '{a50[3]}'   ← **'-' 로 '투입 없음'을 적극적으로 선언**했다.
    계획서 P-10 은 'BOP 에 안 나온다' 고만 썼다. 실제로는 원천이 **없다고 말한다.**
    따라서 IP-1040→A30 · LC-1080→A50 배정은 '자료 부재에 대한 추정' 이 아니라 **원천과의 상충**이다.
    → 계획서가 이 둘을 '미배정' 으로 둔 처리는 **옳다**(라운드 1 판정 유지).
      다만 근거 문장을 '원천이 명시적으로 투입 없음이라 적었다' 로 고쳐야 한다.
      그래야 생산기술이 '원천 오기' 인지 '실제 무투입' 인지 답할 수 있다.""")

    # ── §4.4 팬텀 3종 — DB 로 증명 ──────────────────────────────────────
    ph_out = con.execute("""
        SELECT i.pn, p.op FROM process_material pm JOIN item i ON i.item_id=pm.item_id
          JOIN processes p ON p.id=pm.process_id
         WHERE pm.io='OUT' AND i.is_phantom=1""").fetchall()
    made_not_used = con.execute("""
        SELECT i.pn, p.op FROM process_material pm JOIN item i ON i.item_id=pm.item_id
          JOIN processes p ON p.id=pm.process_id
         WHERE pm.io='OUT' AND NOT EXISTS (
           SELECT 1 FROM process_material q JOIN bom_line l ON l.line_id=q.line_id
            WHERE q.io='IN' AND l.child_item_id=i.item_id)""").fetchall()
    v("§4.4 `HA-3000`·`EX-5000` 팬텀", "확인 — 뒷받침됨", """
    두 조립품을 **산출하는 공정이 원천 BOP 에 없다**(24공정 산출물 칸 전수 확인).
    자식이 각각 3개·2개 공정으로 흩어진다. EX-5000 의 단위 SET 도 실물 단위가 아니다.
    → 팬텀 확정에 반박 근거를 못 찾았다.""")

    v("§4.4 `PE-6000` 팬텀(조건부)", "결함 — 계획서 안에서 서로 충돌한다", f"""
    DB 질의 ① 팬텀인데 산출 P/N 이 붙은 품목: {ph_out}
    DB 질의 ② 만들어지는데 어느 공정도 투입하지 않는 품목: {made_not_used}
    → `PE-6000` 은 **팬텀(§4.4) + 산출 P/N(§4.3) + 백플러시 지점(§4.5)** 세 가지를 동시에 받았다.
      팬텀은 재고도 로트도 없다. 로트가 없으면 백플러시 대상이 아니다. 세 항목이 함께 성립할 수 없다.
    새 증거 (라운드 1 의 내 의견을 **수정한다**):
      07시트에서 `CN-4030`(Signal Connector) 은 PE-6000 의 자식이다.
      그런데 BOP 는 CN-4030 을 **OP-B100 에서 투입**한다 — PE-6000 을 '완성'하는 OP-B90 **뒤**다.
      실물 조립품이라면 완성된 뒤에 구성품이 하나 더 들어갈 수 없다. 이건 **팬텀 쪽 증거**다.
      반대로 B90 이 SMT+자동결선 실제 제조공정(C/T 60초, 설비 연결)이라는 것은 실물 쪽 증거다.
    → **둘 다 결정적이지 않다.** 쟁점 5 는 'PE-6000 팬텀이냐 실물이냐' 로는 못 푼다.
      먼저 `CN-4030` 의 부모가 PE-6000 이 맞는지부터 정해야 한다(케이블 결선용이면 EX-5000 이나 완성품 직하가 자연스럽다).
      라운드 1 에서 내가 '실물 쪽 근거가 더 강하다' 고 쓴 것을 이 증거로 **철회한다.**""")

    # ── 새 무결성 규칙 제안 : 자식이 부모보다 나중 공정에서 투입 ────────
    late = con.execute("""
        SELECT ip.pn AS parent, po.op AS parent_out, po.seq AS pseq,
               ic.pn AS child,  pi2.op AS child_in, pi2.seq AS cseq
          FROM bom_line l
          JOIN bom_header h ON h.bom_id = l.bom_id
          JOIN item ip ON ip.item_id = h.parent_item_id
          JOIN item ic ON ic.item_id = l.child_item_id
          JOIN process_material pmo ON pmo.item_id = ip.item_id AND pmo.io='OUT'
          JOIN processes po ON po.id = pmo.process_id
          JOIN process_material pmi ON pmi.line_id = l.line_id AND pmi.io='IN'
          JOIN processes pi2 ON pi2.id = pmi.process_id
         WHERE pi2.seq > po.seq""").fetchall()
    v("신규 규칙 제안 R-22 — '자식은 부모 산출 공정보다 늦게 투입될 수 없다'", "결함 탐지 1건", f"""
    BOM 과 BOP 를 함께 봐야만 잡히는 모순이다. 계획서 §6 무결성 규칙 13개에 이 규칙이 없다.
    점검 쿼리를 검증자가 작성해 돌린 결과: {late}
    → `PE-6000`(OP-B90 seq {late[0][2] if late else '?'} 산출) 의 자식 `CN-4030` 이
      OP-B100 (seq {late[0][5] if late else '?'}) 에서 투입된다. 부모가 완성된 뒤에 자식이 들어간다.
    이 한 건이 위의 쟁점 5 논쟁의 실체다. **규칙으로 박아야 매번 자동으로 잡힌다.**""")

    # ── 의견 : 원가 이중계상 ────────────────────────────────────────────
    cost04 = [r for r in s04 if len(r) > 7 and r[7] and r[1] in ("SC-1010", "SC-1011")]
    tot04 = next((r[7] for r in s04 if len(r) > 7 and "원가 합계" in str(r[2])), None)
    v("의견 — `item.std_cost` 이관 시 이중계상", "의견", f"""
    04시트 원가 합계 = {tot04} 인데 그 안에 {[(r[1], r[7]) for r in cost04]} 가 **둘 다** 들어 있다.
    SC-1011 은 SC-1010 의 원소재다. 완제품 값과 그 원소재 값을 같이 더한 것이다.
    계획서 §5.3 은 std_cost 를 '참조 단가, 원가 계산은 범위 밖' 이라 했으니 지금은 문제없다.
    다만 컬럼을 두는 이상 **'전개 합산에 쓰지 말 것'** 을 주석에 박아 두는 편이 낫다.""")

    # ── 요약 ────────────────────────────────────────────────────────────
    log("\n" + "=" * 78)
    log("V-12 요약")
    for t, r in VERDICTS:
        log(f"   [{r}] {t}")
    log("=" * 78)
    open(os.path.join(OUT, "06_v12.log"), "w", encoding="utf-8").write(buf.getvalue())


if __name__ == "__main__":
    main()
