@echo off
rem Factory World — 설비 스프라이트 배치 렌더 (owner: 한도윤, docs/team/인터페이스.md §2)
rem 사용: assets\blender\render.cmd [--types press,cnc] [--engine cycles] [--samples N]
rem   1) Blender 5.2 배치: 모델 생성 + 렌더 → assets\blender\out\ (중간 파일, 커밋 제외)
rem   2) 시스템 python(PIL+numpy): 후처리 → public\assets\equipment\<type>.png + manifest.json
setlocal
cd /d "%~dp0..\.."
set BLENDER=C:\Program Files\Blender Foundation\Blender 5.2\blender.exe
if not exist "%BLENDER%" (
  echo [render] Blender not found: %BLENDER%
  exit /b 1
)
"%BLENDER%" -b -P assets\blender\build_equipment.py -- --out public\assets\equipment --work assets\blender\out --no-post %*
if errorlevel 1 (
  echo [render] Blender step failed
  exit /b 1
)
python assets\blender\postprocess.py --work assets\blender\out --out public\assets\equipment
if errorlevel 1 (
  echo [render] postprocess failed
  exit /b 1
)
echo [render] done: public\assets\equipment
endlocal
