@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
set "GHDIR=C:\Program Files\GitHub CLI"
set "GH=%GHDIR%\gh.exe"

if not exist "%GH%" (
  echo [x] 没找到 gh.exe，路径: %GH%
  exit /b 1
)

echo.
echo ==== TVBox 源仓库一键推送 ====
echo.

"%GH%" auth status >nul 2>&1
if errorlevel 1 (
  echo [1/3] 需要登录 GitHub
  echo       屏幕上会出现 one-time code，记下来，按回车，浏览器里输入该码完成授权
  echo.
  "%GH%" auth login --web -h github.com --git-protocol https
  if errorlevel 1 (
    echo [x] 登录失败或被取消
    exit /b 1
  )
) else (
  echo [1/3] gh 已登录
)

echo.
echo [2/3] 取出凭证写入 %USERPROFILE%\.gh_token
"%GH%" auth token > "%USERPROFILE%\.gh_token"
if errorlevel 1 (
  echo [x] 取 token 失败
  exit /b 1
)
echo       完成

echo.
echo [3/3] 建仓并推送
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push.ps1" -Repo tvbox-source
set RC=%errorlevel%

echo.
if %RC% neq 0 (
  echo [x] 推送失败，退出码 %RC%
) else (
  echo ==== 全部完成 ====
)
endlocal
exit /b 0
