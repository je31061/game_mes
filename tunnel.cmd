@echo off
chcp 65001 >nul
rem Factory World 외부 공개 (임시 터널) — Cloudflare Quick Tunnel
rem  - 서버(start.cmd 또는 npm start)가 포트 3000에 떠 있어야 한다
rem  - 실행하면 https://xxxx.trycloudflare.com 형태의 임시 공개 주소가 출력된다 (창을 닫으면 사라짐)
rem  - 설치: winget install Cloudflare.cloudflared
rem  - 공개 전에 관리자 비밀번호를 바꾸고, 필요하면 운영 정책에서 "신규 사번 자동 등록"을 끌 것
set CF="C:\Program Files (x86)\cloudflared\cloudflared.exe"
if not exist %CF% set CF=cloudflared
if "%PORT%"=="" set PORT=3000
echo [Factory World] localhost:%PORT% 를 외부에 공개합니다. 아래 trycloudflare.com 주소를 공유하세요. 종료: Ctrl+C
%CF% tunnel --url http://localhost:%PORT% --no-autoupdate
