@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ================================
echo     MyDiary  -  Local Diary
echo  ================================
echo.

rem ---- first run: install dependencies ----
if not exist "node_modules" (
  echo  [1/3] Installing dependencies, please wait...
  echo.
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  Dependency install failed. Is Node.js installed?
    echo.
    pause
    exit /b 1
  )
)

rem ---- clean up any previous instances (avoid EADDRINUSE) ----
echo  [2/3] Cleaning previous instances...
call tools\kill.bat >nul 2>&1

echo  [3/3] Starting services...
echo.
echo  Browser will open automatically.
echo  Close this window to stop ALL services.
echo.

call npm run start

echo.
echo  Services stopped. Goodbye!
echo.

timeout /t 2 >nul
exit /b 0
