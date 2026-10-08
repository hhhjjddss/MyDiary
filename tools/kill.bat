@echo off
rem Kill any node process serving MyDiary ports, and any leftover vite.
rem Safe: only targets processes listening on our ports.

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4399" ^| findstr "LISTENING"') do (
  taskkill /f /pid %%p >nul 2>&1
)

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":5399" ^| findstr "LISTENING"') do (
  taskkill /f /pid %%p >nul 2>&1
)

exit /b 0
