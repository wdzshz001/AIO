Option Explicit
' Launch launch.cmd without a console window
Dim sh, base
Set sh = CreateObject("WScript.Shell")
base = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run Chr(34) & base & "launch.cmd" & Chr(34), 0, False
