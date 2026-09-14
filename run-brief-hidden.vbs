' Launches the daily brief with no console window.
'
' Why this exists: the task is fired by FOUR triggers (6 AM, logon, session unlock,
' resume-from-sleep) so a 6 AM run that lost the network is covered the next time the
' laptop is opened. Pointed straight at run-brief.bat, that would flash a console
' window on every unlock, several times a day. Window style 0 = hidden.
'
' bWaitOnReturn = True is REQUIRED, do not "optimize" it to False: with False this
' script returns instantly, Task Scheduler considers the task finished, and both
' ExecutionTimeLimit and RestartOnFailure silently stop meaning anything.
'
' The exit code is propagated so a force-terminated or failed run still looks like a
' failure to Task Scheduler, which is what arms RestartOnFailure.

' The bat path is derived from this script's own folder, NOT hardcoded. It used to
' name a profile ("OscarIbarra") that stopped existing when the Windows profile was
' rebuilt on 2026-09-10, so every trigger launched nothing at all.

Dim shell, fso, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
exitCode = shell.Run("""" & fso.GetParentFolderName(WScript.ScriptFullName) & "\run-brief.bat""", 0, True)
WScript.Quit exitCode
