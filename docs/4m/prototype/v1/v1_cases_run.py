# -*- coding: utf-8 -*-
"""
v1_cases_run.py — cases.json 의 반례 배터리를 python sqlite3 로 실행한다.
케이스마다 새 DB. 판정: 확인(기대와 같음) / 결함(기대와 다름) / 오류(setup 실패).
실행: python v1_cases.py && python v1_cases_run.py   → out/03_cases_python.log · out/cases_python.json
"""
from __future__ import annotations
import json, os, sqlite3, sys, time
import common as C

log = C.Log("03_cases_python.log")


def run_case(case):
    con = C.fresh()
    try:
        for s in case["setup"]:
            con.execute(s)
    except Exception as e:
        con.close()
        return dict(id=case["id"], outcome="error", detail=f"setup 실패: {type(e).__name__}: {e}")
    t0 = time.perf_counter()
    try:
        con.execute(case["attack"]); got = "accept"; msg = ""
    except Exception as e:
        got = "reject"; msg = f"{type(e).__name__}: {e}"
    dt = (time.perf_counter() - t0) * 1000
    ok = got == case["expect"]
    want = case.get("msg")
    if ok and want and got == "reject":
        wants = want if isinstance(want, list) else [want]
        if not any(w in msg for w in wants):
            ok = False; msg += f"  ← 기대 메시지 {wants} 없음"
    post = None
    if ok and case.get("post"):
        try:
            v = con.execute(case["post"]["sql"]).fetchone()
            post = str(v[0]) if v else None
            exp = str(case["post"]["expect"])
            same = post == exp
            try: same = same or (float(post) == float(exp))
            except (TypeError, ValueError): pass
            if not same:
                ok = False; msg += f"  ← 사후 확인 기대 {case['post']['expect']} 실제 {post}"
        except Exception as e:
            ok = False; msg += f"  ← 사후 확인 오류 {e}"
    con.close()
    return dict(id=case["id"], outcome="확인" if ok else "결함", got=got, ms=round(dt, 3), msg=msg, post=post)


def main():
    cases = json.load(open(os.path.join(C.HERE, "cases.json"), encoding="utf-8"))["cases"]
    log("=" * 78)
    log("§6 v1.0 재검증 — [2] 반례 배터리 (python sqlite3)")
    log(f"    python {sys.version.split()[0]} · sqlite3 {sqlite3.sqlite_version} · 케이스 {len(cases)}건 · 케이스마다 새 DB")
    log("=" * 78)
    results = []
    cur_group = None
    for c in cases:
        g = c["group"].split()[0]
        if g != cur_group:
            log(f"\n── {c['group']} ──"); cur_group = g
        r = run_case(c); r["group"] = c["group"]; r["title"] = c["title"]; r["expect"] = c["expect"]
        results.append(r)
        mark = {"확인": "OK ", "결함": "!! ", "error": "ERR"}[r["outcome"]]
        log(f"  [{mark}] {c['id']:7} {c['title']}")
        if r["outcome"] != "확인":
            log(f"          기대={c['expect']} 실제={r.get('got')} · {r.get('msg') or r.get('detail')}")
        elif os.environ.get("TC_VERBOSE"):
            log(f"          {r.get('msg','')[:100]}")
        if c.get("note") and r["outcome"] != "확인":
            log(f"          note: {c['note']}")
    n_ok = sum(1 for r in results if r["outcome"] == "확인")
    n_ng = sum(1 for r in results if r["outcome"] == "결함")
    n_er = sum(1 for r in results if r["outcome"] == "error")
    log("\n" + "=" * 78)
    log(f"합계 {len(results)} — 확인 {n_ok} · 결함 {n_ng} · 오류 {n_er}")
    for r in results:
        if r["outcome"] != "확인": log(f"   [{r['outcome']}] {r['id']} {r['title']}")
    log("=" * 78)
    json.dump(dict(runtime=f"python {sys.version.split()[0]} / sqlite {sqlite3.sqlite_version}", results=results),
              open(os.path.join(C.OUT, "cases_python.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    log.save()
    return 0 if not (n_ng or n_er) else 1


if __name__ == "__main__":
    sys.exit(main())
