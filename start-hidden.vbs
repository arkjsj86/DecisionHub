' Decision Hub - launch the server with NO console window, then open the browser.
' Double-click this file. Logs are written to logs\server.log.
' To stop: close the browser tab; the server auto-shuts-down when idle.
' If you change PORT in .env, update the URL near the bottom of this file.

Option Explicit
Dim fso, sh, scriptDir, q, runCmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' Run relative to this script's own folder (where server.js lives).
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = scriptDir

' Start Node hidden (0 = no window, False = don't wait). Ensure logs\ exists,
' stamp the run, and append stdout+stderr to logs\server.log.
runCmd = "cmd /c (if not exist logs mkdir logs) & echo ===== %DATE% %TIME% ===== >> logs\server.log & node server.js >> logs\server.log 2>&1"
sh.Run runCmd, 0, False

' Give the server a moment to bind the port, then open the default browser.
q = Chr(34)
WScript.Sleep 2500
sh.Run "cmd /c start " & q & q & " http://localhost:8787", 0, False
