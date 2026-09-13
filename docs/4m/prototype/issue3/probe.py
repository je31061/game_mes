# 쟁점 3 반례 실험 — 운영 DB 사본(probe.db)에서만 돈다. data/factory.db 는 열지 않는다.
# 실행: python docs/4m/prototype/issue3/probe.py   (cwd = 저장소 루트)
import sqlite3, shutil, os, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
SNAP = os.path.join(HERE, 'factory-snapshot.db')
PROBE = os.path.join(HERE, 'probe.db')

def fresh():
    for ext in ('', '-wal', '-shm'):
        p = PROBE + ext
        if os.path.exists(p): os.remove(p)
    shutil.copyfile(SNAP, PROBE)
    c = sqlite3.connect(PROBE)
    c.execute('PRAGMA foreign_keys = OFF')   # server/db.js 와 동일(어디에도 ON 이 없다)
    return c

def counts(c, tag):
    g = lambda s: c.execute(s).fetchone()[0]
    print(f'[{tag}] proc={g("select count(*) from processes")} '
          f'pmIN={g("select count(*) from process_material where io = \'IN\'")} '
          f'pmOUT={g("select count(*) from process_material where io = \'OUT\'")} '
          f'pmOUTfinal={g("select count(*) from process_material where io = \'OUT\' and is_final=1")} '
          f'parts={g("select count(*) from parts")} process_inputs={g("select count(*) from process_inputs")} '
          f'D-8={g("select count(*) from v_chk_bop_unassigned")} R-10={g("select count(*) from v_chk_r10_split")} '
          f'R-22={g("select count(*) from v_chk_r22_seq")}')

def try_(c, label, sql, *a):
    try:
        c.execute(sql, a); print(f'   [통과] {label}')
        return True
    except Exception as e:
        print(f'   [거부] {label}  -> {e}')
        return False

def lid(c, parent, child):
    return c.execute("""select l.line_id from bom_line l join bom_header h on h.bom_id=l.bom_id
        join item ip on ip.item_id=h.parent_item_id join item ic on ic.item_id=l.child_item_id
        where ip.pn=? and ic.pn=?""", (parent, child)).fetchone()[0]

def pid(c, op): return c.execute('select id from processes where op=?', (op,)).fetchone()[0]
def iid(c, pn): return c.execute('select item_id from item where pn=?', (pn,)).fetchone()[0]

EIGHT = [('BLDC-500W-48V','FS-7010'),('BLDC-500W-48V','FS-7020'),('BLDC-500W-48V','GB-8000'),
         ('BLDC-500W-48V','PL-9000'),('FS-7020','FS-7023'),('FS-7020','FS-7021'),
         ('FS-7020','FS-7022'),('FS-7020','OR-7025')]

print('=' * 78); print('E-1  processes.seq — 중복 seq · 재번호 무방비')
c = fresh(); counts(c, '기준')
try_(c, 'OP-B88 을 기존 OP-B90 과 같은 seq=11 로 삽입',
     "insert into processes(product_code,op,seq,line,name,ct_sec,kind,stage_pn) values('BLDC-500W-48V','OP-B88',11,'조립 라인','동력전달부 체결',40,'표준','FS-7010')")
print('   같은 라인 seq=11 인 공정:', c.execute("select group_concat(op) from processes where line='조립 라인' and seq=11").fetchone()[0])
print('   -> (product_code,line,seq) 에 UNIQUE 가 없다. 상태창/맵 정렬은 seq 동률에서 비결정적.')
try_(c, 'seq 재번호(B90~B120 → 12~15) UPDATE', "update processes set seq=seq+1 where line='조립 라인' and op in ('OP-B90','OP-B100','OP-B110','OP-B120')")
print('   재번호 후 조립 라인 seq:', c.execute("select group_concat(op||'='||seq) from (select op,seq from processes where line='조립 라인' order by seq)").fetchone()[0])
print('   -> processes 에 UPDATE 트리거가 없다. R-22 는 INSERT 시점에만 본다(아래 E-2).')
c.close()

print(); print('=' * 78); print('E-2  seq UPDATE 가 R-22 를 우회한다')
c = fresh()
c.execute("insert into processes(product_code,op,seq,line,name,ct_sec,kind) values('BLDC-500W-48V','OP-B88',11,'조립 라인','동력전달부 체결',40,'표준')")
p88 = pid(c, 'OP-B88')
c.execute("update processes set seq=seq+1 where line='조립 라인' and op in ('OP-B90','OP-B100','OP-B110','OP-B120')")
for par, ch in EIGHT:
    c.execute("insert into process_material(process_id,io,line_id,issue_method) values(?,'IN',?,'BACKFLUSH')", (p88, lid(c, par, ch)))
print('   IN 8행 삽입 후 R-22 뷰:', c.execute('select count(*) from v_chk_r22_seq').fetchone()[0], '건')
try_(c, '이제 OP-B88 만 seq=99 로 밀어 완성품 산출(OP-B120,seq15)보다 뒤로 보낸다',
     "update processes set seq=99 where op='OP-B88'")
rows = c.execute('select detail from v_chk_r22_seq').fetchall()
print(f'   R-22 뷰: {len(rows)}건  ->', [r[0] for r in rows][:4])
print('   -> UPDATE 는 막히지 않고, 점검 뷰로만 사후 발견된다. 결함.')
c.close()

print(); print('=' * 78); print('E-3  새 공정에 OUT 행이 없어도 아무도 막지 않는다 (OUT 24행 불변식 붕괴)')
c = fresh()
c.execute("insert into processes(product_code,op,seq,line,name,ct_sec,kind) values('BLDC-500W-48V','OP-B88',11,'조립 라인','동력전달부 체결',40,'표준')")
print('   OUT 없는 공정 수:',
      c.execute("select count(*) from processes p where not exists(select 1 from process_material m where m.process_id=p.id and m.io='OUT')").fetchone()[0])
print('   현행 점검 뷰 11종 중 이것을 잡는 뷰:',
      c.execute("select count(*) from v_chk_summary").fetchone()[0], '건(= D-8/R-10 만, OUT 누락은 안 뜬다)')
print('   -> "24공정 전부 OUT 1행" 은 DB 제약이 아니라 적재기 관행일 뿐. 결함.')
c.close()

print(); child = None
print('=' * 78); print('E-4  안 A(단일 공정) — FS-7020 을 같은 공정에서 만들고 동시에 소비')
c = fresh()
c.execute("insert into processes(product_code,op,seq,line,name,ct_sec,kind,stage_pn) values('BLDC-500W-48V','OP-B88',11,'조립 라인','동력전달부 체결',40,'표준','FS-7010')")
c.execute("update processes set seq=seq+1 where line='조립 라인' and op in ('OP-B90','OP-B100','OP-B110','OP-B120')")
p88 = pid(c, 'OP-B88')
try_(c, "OUT: FS-7020 is_final=1 @OP-B88", "insert into process_material(process_id,io,item_id,is_final,qty_out) values(?,'OUT',?,1,1)", p88, iid(c, 'FS-7020'))
try_(c, "OUT: BLDC 상태행 '동력전달부 체결' @OP-B88", "insert into process_material(process_id,io,item_id,is_final,out_state) values(?,'OUT',?,0,'동력전달부 체결')", p88, iid(c, 'BLDC-500W-48V'))
for par, ch in EIGHT:
    try_(c, f'IN {par} > {ch}', "insert into process_material(process_id,io,line_id,issue_method) values(?,'IN',?,'BACKFLUSH')", p88, lid(c, par, ch))
counts(c, '안 A')
print('   FS-7020 이 같은 공정의 IN 이자 OUT:',
      c.execute("""select count(*) from process_material o join item i on i.item_id=o.item_id
                   where o.process_id=? and o.io='OUT' and i.pn='FS-7020'
                     and exists(select 1 from process_material m join bom_line l on l.line_id=m.line_id
                                where m.process_id=? and m.io='IN' and l.child_item_id=i.item_id)""", (p88, p88)).fetchone()[0], '건 — 막는 제약 없음')
print('   -> 같은 공정에서 FS-7020 로트를 만들고 즉시 소비. 수명 0 로트. 백플러시 순서가 정의되지 않는다.')
c.close()

print(); print('=' * 78); print('E-5  안 B(2공정) — FS-7020 조립 공정 + 체결 공정')
c = fresh()
c.execute("insert into processes(product_code,op,seq,line,name,ct_sec,kind,stage_pn) values('BLDC-500W-48V','OP-B83',9,'조립 라인','플랜지샤프트 No.2 조립',30,'표준','FS-7020')")
c.execute("update processes set seq=seq+1 where line='조립 라인' and seq>=9 and op<>'OP-B83'")
c.execute("insert into processes(product_code,op,seq,line,name,ct_sec,kind,stage_pn) values('BLDC-500W-48V','OP-B88',12,'조립 라인','동력전달부 체결',40,'표준','FS-7010')")
c.execute("update processes set seq=seq+1 where line='조립 라인' and seq>=12 and op<>'OP-B88'")
print('   조립 라인 seq:', c.execute("select group_concat(op||'='||seq) from (select op,seq from processes where line='조립 라인' order by seq)").fetchone()[0])
p83, p88 = pid(c, 'OP-B83'), pid(c, 'OP-B88')
try_(c, 'OUT FS-7020 is_final @OP-B83', "insert into process_material(process_id,io,item_id,is_final,qty_out) values(?,'OUT',?,1,1)", p83, iid(c, 'FS-7020'))
for ch in ('FS-7023', 'FS-7021', 'FS-7022', 'OR-7025'):
    try_(c, f'IN FS-7020 > {ch} @OP-B83', "insert into process_material(process_id,io,line_id,issue_method) values(?,'IN',?,'BACKFLUSH')", p83, lid(c, 'FS-7020', ch))
try_(c, "OUT BLDC 상태행 @OP-B88", "insert into process_material(process_id,io,item_id,is_final,out_state) values(?,'OUT',?,0,'동력전달부 체결')", p88, iid(c, 'BLDC-500W-48V'))
for ch in ('FS-7010', 'FS-7020', 'GB-8000', 'PL-9000'):
    try_(c, f'IN BLDC > {ch} @OP-B88', "insert into process_material(process_id,io,line_id,issue_method) values(?,'IN',?,'BACKFLUSH')", p88, lid(c, 'BLDC-500W-48V', ch))
counts(c, '안 B')
print('   D-8 잔여:', [r[0] for r in c.execute('select detail from v_chk_bop_unassigned').fetchall()])
print('   조립 라인 총 C/T:', c.execute("select sum(ct_sec) from processes where line='조립 라인'").fetchone()[0],
      ' 병목:', c.execute("select op||' '||ct_sec from processes where line='조립 라인' order by ct_sec desc limit 1").fetchone()[0])
c.close()

print(); print('=' * 78); print('E-6  R-22 트리거는 순서를 거꾸로 넣으면 실제로 막는다(대조군)')
c = fresh()
c.execute("insert into processes(product_code,op,seq,line,name,ct_sec,kind) values('BLDC-500W-48V','OP-B125',15,'조립 라인','늦은 체결',40,'표준')")
p = pid(c, 'OP-B125')
try_(c, 'OP-B120(완성품 OUT,seq14) 보다 늦은 seq15 에 BLDC>FS-7010 IN',
     "insert into process_material(process_id,io,line_id,issue_method) values(?,'IN',?,'BACKFLUSH')", p, lid(c, 'BLDC-500W-48V', 'FS-7010'))
c.close()

print(); print('=' * 78); print('E-7  split_pct — 두 공정으로 쪼개면 R-10 이 뜨는가')
c = fresh()
c.execute("insert into processes(product_code,op,seq,line,name,ct_sec,kind) values('BLDC-500W-48V','OP-B88',11,'조립 라인','체결',40,'표준')")
c.execute("insert into processes(product_code,op,seq,line,name,ct_sec,kind) values('BLDC-500W-48V','OP-B89',12,'조립 라인','체결2',10,'표준')")
c.execute("update processes set seq=seq+2 where line='조립 라인' and op in ('OP-B90','OP-B100','OP-B110','OP-B120')")
a, b = pid(c, 'OP-B88'), pid(c, 'OP-B89')
l = lid(c, 'FS-7020', 'OR-7025')
c.execute("insert into process_material(process_id,io,line_id,split_pct) values(?,'IN',?,50)", (a, l))
c.execute("insert into process_material(process_id,io,line_id,split_pct) values(?,'IN',?,50)", (b, l))
print('   50/50 → R-10:', [r[0] for r in c.execute("select detail from v_chk_r10_split where detail like '%OR-7025%'").fetchall()] or '없음(정상)')
print('   process_inputs 의 OR-7025 행:', c.execute("select group_concat(process_id||':'||qty) from process_inputs where pn='OR-7025'").fetchone()[0])
c.execute("update process_material set split_pct=60 where process_id=? and line_id=?", (b, l))
print('   50/60 → R-10:', [r[0] for r in c.execute("select detail from v_chk_r10_split where detail like '%OR-7025%'").fetchall()])
print('   -> R-10 은 합계만 본다. 100 을 넘겨도 트리거는 없고 뷰로만 잡힌다.')
c.close()

print(); print('=' * 78); print('E-8  맵 좌표 — equipments(x,y) 유니크 없음 / 존 밖 배치')
c = fresh()
print('   조립 라인 존 rect:', c.execute("select rect_x,rect_y,rect_w,rect_h from zones where name='조립 라인'").fetchone(), ' MAP 24x16')
print('   y=13 행 x 목록:', [r[0] for r in c.execute("select x from equipments where zone_id=6 and y=13 order by x").fetchall()])
print('   이미 겹친 좌표(숨김 포함):',
      [r for r in c.execute("select x,y,group_concat(code) from equipments group by x,y having count(*)>1").fetchall()])
try_(c, '8대째를 x=23,y=13 에 삽입(존 안, 맵 안)',
     "insert into equipments(zone_id,code,name,x,y,type,op) values(6,'OP-B88','동력전달부 체결기',23,13,'assembly','OP-B88')")
try_(c, '9대째를 x=26,y=13 에 삽입(맵 밖 x>23)',
     "insert into equipments(zone_id,code,name,x,y,type,op) values(6,'OP-B89','체결기2',26,13,'assembly','OP-B89')")
try_(c, '9대째를 x=2,y=16 에 삽입(존 밖·맵 밖 y>15)',
     "insert into equipments(zone_id,code,name,x,y,type,op) values(6,'OP-B89b','체결기2',2,16,'assembly','OP-B89')")
try_(c, '기존 OP-B85 와 같은 칸(5,13) 에 삽입',
     "insert into equipments(zone_id,code,name,x,y,type,op) values(6,'OP-B89c','체결기3',5,13,'assembly','OP-B89')")
print('   -> DB 는 전부 받는다. 맵 밖/겹침 방지는 server/index.js 의 clampInt(0..23 / 0..15) 뿐이고, 그것은 배치 API 경로만 탄다.')
c.close()

print(); print('=' * 78); print('E-9  mat_lot.state_pm_id — OUT 행 재생성 시 끊긴다')
c = fresh()
print('   PRAGMA foreign_keys =', c.execute('pragma foreign_keys').fetchone()[0], '(server/db.js 에 ON 이 없다)')
pm = c.execute("select pm.pm_id from process_material pm join processes p on p.id=pm.process_id join item i on i.item_id=pm.item_id where p.op='OP-B85' and pm.io='OUT'").fetchone()[0]
c.execute("insert into mat_lot(lot_no,item_id,lot_kind,qty,uom_code,status,state_pm_id) values('GB-TEST-001',?,'LOT',1,'EA','AVAILABLE',?)", (iid(c, 'GB-8000'), pm))
print('   로트 상태 표시:', c.execute("""select m.lot_no, p.op, case when pm.is_final=1 then '완성' else pm.out_state end
        from mat_lot m left join process_material pm on pm.pm_id=m.state_pm_id left join processes p on p.id=pm.process_id""").fetchall())
try_(c, 'OUT 행 삭제(콘솔 links 편집이 keep 밖 OUT 을 지우는 경로: materials.js:845)', 'delete from process_material where pm_id=?', pm)
print('   삭제 후 로트 상태 표시:', c.execute("""select m.lot_no, m.state_pm_id, p.op, case when pm.is_final=1 then '완성' else pm.out_state end
        from mat_lot m left join process_material pm on pm.pm_id=m.state_pm_id left join processes p on p.id=pm.process_id""").fetchall())
print('   -> FK OFF 라 조용히 끊긴다. 잡는 점검 뷰 없음.')
c.close()

print(); print('=' * 78); print('E-10  OR-7025 부모를 FS-7010 으로 옮기면 무슨 일이 생기나')
c = fresh()
try_(c, 'FS-7010(단품, BOM 헤더 없음) 밑으로 OR-7025 이동 — 먼저 헤더부터',
     "insert into bom_header(parent_item_id,bom_type,alt_no,rev,base_qty,base_uom,status,valid_from) values(?, 'PROD','00','A',1,'EA','ACTIVE','2026-01-01')", iid(c, 'FS-7010'))
h = c.execute('select bom_id from bom_header where parent_item_id=?', (iid(c, 'FS-7010'),)).fetchone()
if h:
    try_(c, 'FS-7010 > OR-7025 2EA 라인 추가', "insert into bom_line(bom_id,line_no,child_item_id,qty_per,uom_code,valid_from) values(?,10,?,2,'EA','2026-01-01')", h[0], iid(c, 'OR-7025'))
    try_(c, '기존 FS-7020 > OR-7025 라인 삭제', 'delete from bom_line where line_id=?', lid(c, 'FS-7020', 'OR-7025'))
print('   완성품당 OR-7025 소요량:', c.execute("select group_concat(parent_pn||'='||qty_per_product) from v_bom_line_qpp where child_pn='OR-7025'").fetchone()[0])
print('   item_type 은 그대로:', c.execute("select item_type from item where pn='FS-7010'").fetchone()[0], '-> 단품(PT)인데 BOM 을 갖게 된다')
print('   parts 뷰 level:', c.execute("select pn,level,parent_pn from parts where pn='OR-7025'").fetchall())
c.close()
print(); print('끝. probe.db 는 사본이며 .gitignore 대상.')
