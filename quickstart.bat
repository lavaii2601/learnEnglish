@echo off
setlocal

cd /d "%~dp0"

echo ======================================
echo Phong hoc tieng Anh - Khoi dong nhanh
echo ======================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js chua duoc cai dat hoac chua co trong PATH.
  echo Vui long cai Node.js LTS roi chay lai quickstart.bat
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm khong co san trong PATH.
  echo Vui long cai dat lai Node.js LTS.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Dang cai dat dependencies lan dau...
  call npm install
  if errorlevel 1 (
    echo [ERROR] Cai dat dependencies that bai.
    pause
    exit /b 1
  )
)

echo [INFO] Dang chay ung dung (frontend + backend)...
echo [INFO] Nhan Ctrl+C de dung.
call npm run dev

endlocal
