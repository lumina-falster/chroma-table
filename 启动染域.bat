@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" server.js
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 请先安装 Node.js 22.8 或更高版本：https://nodejs.org/zh-cn/download
    echo 或将 Windows 版 Node.js 的 node.exe 放入本目录的 runtime 文件夹。
    pause
    exit /b 1
  )
  node server.js
)
pause
