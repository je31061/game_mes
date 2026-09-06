@echo off
chcp 65001 >nul
rem Factory World 실행 스크립트
rem  - PATH에 node가 있으면 그것을 사용 (일반 설치)
rem  - 없으면 무설치 Node.js 경로(NODE_PORTABLE)를 시도
rem  - 서버가 비정상 종료(오류)되면 3초 후 자동 재기동 (Ctrl+C로 정상 종료하면 재기동하지 않음)
cd /d %~dp0
set NODE_PORTABLE=%USERPROFILE%\dev\tools\node-v24.19.0-win-x64\node.exe
where node >nul 2>nul
if %errorlevel%==0 (
  set NODE=node
) else if exist "%NODE_PORTABLE%" (
  set NODE=%NODE_PORTABLE%
) else (
  echo [Factory World] Node.js를 찾을 수 없습니다. https://nodejs.org 에서 LTS를 설치하세요.
  pause
  exit /b 1
)
if not exist node_modules (
  echo [Factory World] 의존성 설치 중...
  call npm install
)
if "%PORT%"=="" set PORT=3000
:run
echo [Factory World] http://localhost:%PORT% 에서 실행됩니다. 종료: Ctrl+C
"%NODE%" server\index.js
if %errorlevel% neq 0 (
  echo [Factory World] 서버가 오류로 종료되었습니다 (코드 %errorlevel%). 3초 후 재기동...
  timeout /t 3 /nobreak >nul
  goto run
)
