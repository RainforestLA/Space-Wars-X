@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  if exist "%LOCALAPPDATA%\loach-node\node-v22.14.0-win-x64\node.exe" (
    set "PATH=%LOCALAPPDATA%\loach-node\node-v22.14.0-win-x64;%PATH%"
  ) else (
    echo Node.js not found. Install from https://nodejs.org then run: npm install ^& npm run dev
    pause
    exit /b 1
  )
)
if not exist "node_modules\" (
  echo Installing dependencies...
  call npm.cmd install
)
echo.
echo  Space Wars X  -^>  http://localhost:3000
echo.
node server/index.js
