@echo off
setlocal
cd /d "%~dp0"

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

call npm run dev -- --host 127.0.0.1 --open
