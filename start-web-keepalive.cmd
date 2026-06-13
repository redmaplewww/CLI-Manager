@echo off
cd /d F:\opencode\aura-butler
:loop
call "C:\Users\1\AppData\Roaming\npm\bun.cmd" run src/cli.ts web --port 8799
echo Web server exited, restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto loop
