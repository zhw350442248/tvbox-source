@echo off
REM 绕过执行策略跑 push.ps1：push.cmd user/repo [token]
setlocal
set "REPO=%~1"
set "TOKEN=%~2"
if "%REPO%"=="" (
  echo 用法: push.cmd 你的用户名/tvbox-source [ghp_xxx]
  echo   token 可放在环境变量 GH_TOKEN 里
  exit /b 2
)
if "%TOKEN%"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push.ps1" -Repo "%REPO%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push.ps1" -Repo "%REPO%" -Token "%TOKEN%"
)
