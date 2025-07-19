@echo off

REM ---- Instance 1 (Node.js) ----
start "Instance 1" cmd /k node instance_1.js

REM ---- Instance 2 (Node.js) ----
start "Instance 2" cmd /k node instance_2.js

REM ---- Umschalt-ffmpeg (z.B. Instance 1 zu Twitch) ----
REM Zum Umschalten einfach diesen Prozess beenden und mit anderer Quelle neu starten!
start "Switcher" cmd /k ffmpeg -i rtmp://localhost/live/stream1 -c:v libx264 -c:a aac -f flv rtmp://live.twitch.tv/app/DEIN_STREAMKEY

pause