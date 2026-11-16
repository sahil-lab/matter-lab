@echo off
rem Runs the npm bundled with the Node.js selected by env.ps1 (see MATTERLAB_NODE_DIR).
if "%MATTERLAB_NODE_DIR%"=="" (
  echo Run .\env.ps1 from the repository root first. 1>&2
  exit /b 1
)
"%MATTERLAB_NODE_DIR%\node.exe" "%MATTERLAB_NODE_DIR%\node_modules\npm\bin\npm-cli.js" %*
