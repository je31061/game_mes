@echo off
chcp 65001 >nul
rem Factory World 데이터 백업
rem  사용: backup.cmd [대상폴더]   (생략 시 FW_BACKUP_DIR → OneDrive\FactoryWorld-백업 → 프로젝트\backups 순)
cd /d %~dp0
set NODE_PORTABLE=%USERPROFILE%\dev\tools\node-v24.19.0-win-x64\node.exe
where node >nul 2>nul
if %errorlevel%==0 (
  set NODE=node
) else if exist "%NODE_PORTABLE%" (
  set NODE=%NODE_PORTABLE%
) else (
  echo [Factory World] Node.js를 찾을 수 없습니다.
  exit /b 1
)
"%NODE%" scripts\backup.js %*
