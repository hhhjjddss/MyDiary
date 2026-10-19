@echo off
rem 结束监听 MyDiary 本地服务端口的进程。

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4399" ^| findstr "LISTENING"') do (
  taskkill /f /pid %%p >nul 2>&1
)

exit /b 0
