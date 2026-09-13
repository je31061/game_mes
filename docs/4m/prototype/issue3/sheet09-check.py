# 2라운드 — 결의안 §5 의 유일한 근거(09시트 C40~C43 손입력 여부) 확인. 원천 xlsx 는 읽기만 한다.
# 실행: python docs/4m/prototype/issue3/sheet09-check.py   (cwd = 저장소 루트)
import openpyxl, io, sys, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
SRC = 'docs/bldc/source/BLDC_500W_48V_BOM_BOP_Master.xlsx'
wb = openpyxl.load_workbook(SRC, data_only=False)   # 수식을 원문으로 본다

print('범례(01_Cover B26~B28):')
cov = wb['01_Cover']
for r in (26, 27, 28):
    print(f'  {cov.cell(r,1).value} = {cov.cell(r,2).value}')

ws = wb['09_BOM_Flat_Consolidated']
print(f'\n09_BOM_Flat_Consolidated  dims={ws.dimensions}')
print('머리글:', [ws.cell(3, c).value for c in range(1, 10)])
print('\nFS-70xx 블록 (행 39~43) — 열 C(상위 P/N) 의 data_type·수식·글자색')
for r in range(39, 44):
    c = ws.cell(r, 3)
    d = ws.cell(r, 4)
    color = c.font.color.rgb if (c.font and c.font.color) else None
    print(f'  행{r}  C{r}={c.value!r} type={c.data_type} 수식={"예" if str(c.value).startswith("=") else "아니오"} 색={color}'
          f'   | D{r}(단품)={d.value!r}  G{r}(Qty/상위)={ws.cell(r,7).value}  H={ws.cell(r,8).value}  I={ws.cell(r,9).value!r}')

print('\n색 규약 실태 — 09시트 전체에서 글자색이 지정된 열')
cols = {}
for row in ws.iter_rows(min_row=4, max_row=53, min_col=1, max_col=9):
    for cell in row:
        rgb = cell.font.color.rgb if (cell.font and cell.font.color) else None
        if rgb:
            cols.setdefault(cell.column_letter, set()).add(rgb)
print('  ', {k: sorted(v) for k, v in sorted(cols.items())})
print('  -> 색이 걸린 열은 숫자 입력 열뿐이다. C(상위 P/N) 를 포함한 문자 열에는 09시트 어디에도 색이 없다.')
print('     따라서 "녹색(다른 시트 참조) 서식이 안 걸려 있다" 는 관찰은 중립이다 — 문자 열은 애초에 색 규약을 안 탄다.')
print('     확정되는 사실은 하나: C40~C43 은 수식도 셀 참조도 아닌 리터럴 문자열이다.')

print('\nOR-7025 가 09시트에서 다른 부모로도 나타나는가')
hits = [(r, ws.cell(r, 2).value, ws.cell(r, 3).value, ws.cell(r, 7).value)
        for r in range(4, 54) if ws.cell(r, 4).value == 'OR-7025']
print('  ', hits)

print('\n합계 행(09!I53) 과 조립 라인 총 C/T 대조용 값')
print('  I53 =', repr(ws.cell(53, 9).value))
b = wb['11_BOP_Assembly_Line']
print('  11!A1 =', repr(b.cell(1, 1).value))
rows = [r for r in range(1, b.max_row + 1) if str(b.cell(r, 1).value or '').startswith('OP-B')]
print('  11시트 OP-B 데이터행 수 =', len(rows), rows and f'({b.cell(rows[0],1).value} ~ {b.cell(rows[-1],1).value})')
s = wb['02_Product_Spec']
for r in range(1, s.max_row + 1):
    if s.cell(r, 1).value and '공정' in str(s.cell(r, 1).value):
        print(f'  02!A{r} = {s.cell(r,1).value!r} / B{r} = {s.cell(r,2).value!r} / C{r} = {s.cell(r,3).value!r}')
