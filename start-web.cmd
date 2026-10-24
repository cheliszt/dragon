@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22.13 or newer is required. Install from https://nodejs.org/
  pause
  exit /b 1
)
node --input-type=module -e "await import('pdfjs-dist/legacy/build/pdf.mjs'); await import('@napi-rs/canvas'); await import('pdf-lib');" >nul 2>nul
if errorlevel 1 (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node src/web-server.mjs --open
if errorlevel 1 pause
