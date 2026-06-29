' Decision Hub - start the server hidden, WITHOUT opening a browser.
' This is what the "decisionhub://" custom URL protocol runs, so the in-page
' "Start server" button can boot the backend while the existing tab stays open.
' Logs go to logs\server.log. Does nothing if the server is already listening.
' If you change PORT in .env, update the 8787 below.

Option Explicit
Dim fso, sh, scriptDir, runCmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' Run relative to this script's own folder (where server.js lives).
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = scriptDir

' Start Node hidden (0 = no window, False = don't wait), but only if nothing is
' already listening on the port. Stamp the run and append stdout+stderr to the log.
' NOTE: keep the echoed text free of "(" / ")" so it can't break the if-block.
runCmd = "cmd /c (if not exist logs mkdir logs) & " & _
  "(netstat -ano | findstr "":8787"" | findstr ""LISTENING"" >nul 2>&1) & " & _
  "if errorlevel 1 (echo ===== %DATE% %TIME% protocol-start ===== >> logs\server.log & node server.js >> logs\server.log 2>&1)"
sh.Run runCmd, 0, False
