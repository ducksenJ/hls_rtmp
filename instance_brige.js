const { spawn } = require('child_process');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const ioServer = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Add CORS middleware
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Twitch Stream-Key und Server (ersetzen!)
const twitchStreamKey = 'live_62882992_0RZTbV9GqdOSg8cYFIwZChoq1ZGMTR';
const twitchServer = 'rtmp://live.twitch.tv/app/';

let ffmpegProc3 = null; // Blackscreen Instance
let nginxHlsToTwitchProc = null;
let blackscreenToTwitchProc = null;
let isLiveStreaming = false;
let activeIndex = 0; // 1 = Blackscreen, 2 = nginx-HLS

// HLS-Verzeichnisse, die bereinigt werden sollen
const hlsDirs = [
    path.join(__dirname, 'hls', 'stream3')
];

// Funktion zum Löschen aller Dateien in den HLS-Verzeichnissen
function cleanHlsDirs() {
    for (const dir of hlsDirs) {
        if (fs.existsSync(dir)) {
            for (const file of fs.readdirSync(dir)) {
                const filePath = path.join(dir, file);
                try {
                    fs.unlinkSync(filePath);
                } catch (err) {
                    console.warn(`Konnte ${filePath} nicht löschen: ${err.message}`);
                }
            }
        }
    }
}

// Direkt beim Start ausführen
cleanHlsDirs();

// Blackscreen HLS erzeugen (instance_3.js)
function startBlackscreenInstance() {
    if (ffmpegProc3) stopBlackscreenInstance();
    ffmpegProc3 = spawn('node', [path.join(__dirname, 'instance_3.js')]);
    ffmpegProc3.stdout.on('data', d => process.stdout.write(`[blackscreen] ${d}`));
    ffmpegProc3.stderr.on('data', d => process.stderr.write(`[blackscreen] ${d}`));
    ffmpegProc3.on('close', code => {
        console.log(`instance_3.js exited with code ${code}`);
        ffmpegProc3 = null;
    });
    activeIndex = 1;
    isLiveStreaming = false; // <--- HIER: false, weil nur HLS, kein Twitch!
    broadcastLiveStatus();
}
function stopBlackscreenInstance() {
    if (ffmpegProc3) {
        try { ffmpegProc3.kill(); } catch {}
        ffmpegProc3 = null;
    }
}

// nginx-HLS zu Twitch weiterleiten
function startNginxHlsToTwitch() {
    if (nginxHlsToTwitchProc) stopNginxHlsToTwitch();
    nginxHlsToTwitchProc = spawn('ffmpeg', [
        '-re',
        '-fflags', 'nobuffer',
        '-flags', 'low_delay',
        '-strict', 'experimental',
        '-i', '/tmp/hls/stream.m3u8',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '160k',
        '-ar', '44100',
        '-f', 'flv',
        twitchServer + twitchStreamKey
    ]);
    nginxHlsToTwitchProc.stderr.on('data', d => process.stderr.write(`[nginx-hls->twitch] ${d}`));
    nginxHlsToTwitchProc.on('close', code => {
        console.log(`nginx-hls->twitch ffmpeg exited with code ${code}`);
        nginxHlsToTwitchProc = null;
        isLiveStreaming = false;
        broadcastLiveStatus();
        // Automatisch auf Blackscreen umschalten!
        stopBlackscreenToTwitch();
        stopBlackscreenInstance();
        startBlackscreenInstance();
        setTimeout(() => startBlackscreenToTwitch(), 1500);
    });
    isLiveStreaming = true;
    activeIndex = 2;
    broadcastLiveStatus();
}
function stopNginxHlsToTwitch() {
    if (nginxHlsToTwitchProc) {
        try { nginxHlsToTwitchProc.kill(); } catch {}
        nginxHlsToTwitchProc = null;
    }
    isLiveStreaming = false;
    broadcastLiveStatus();
}

// Blackscreen (HLS) zu Twitch weiterleiten
function startBlackscreenToTwitch() {
    if (blackscreenToTwitchProc) stopBlackscreenToTwitch();
    blackscreenToTwitchProc = spawn('ffmpeg', [
        '-re',
        '-i', path.join(__dirname, 'hls', 'stream3', 'playlist.m3u8'),
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '160k',
        '-ar', '44100',
        '-f', 'flv',
        twitchServer + twitchStreamKey
    ]);
    blackscreenToTwitchProc.stderr.on('data', d => process.stderr.write(`[blackscreen->twitch] ${d}`));
    blackscreenToTwitchProc.on('close', code => {
        console.log(`Blackscreen->Twitch ffmpeg exited with code ${code}`);
        blackscreenToTwitchProc = null;
        isLiveStreaming = false;
        broadcastLiveStatus();
    });
    isLiveStreaming = true;
    activeIndex = 1;
    broadcastLiveStatus();
}
function stopBlackscreenToTwitch() {
    if (blackscreenToTwitchProc) {
        try { blackscreenToTwitchProc.kill(); } catch {}
        blackscreenToTwitchProc = null;
    }
}

// Status an alle Clients senden
function broadcastLiveStatus() {
    ioServer.emit('live-status', {
        isLive: isLiveStreaming,
        activeInstance: activeIndex
    });
}

// OBS-Status prüfen (Datei-Änderungszeit)
function getObsStatus() {
    const hlsPath = '/tmp/hls/stream.m3u8';
    try {
        const stats = fs.statSync(hlsPath);
        const now = Date.now();
        if (now - stats.mtimeMs < 5000) { // Datei wurde in den letzten 5 Sekunden geändert
            return 'LIVE (Daten von OBS)';
        } else {
            return 'Kein Signal (keine neuen Daten)';
        }
    } catch (e) {
        return 'Kein Signal (Datei fehlt)';
    }
}

// Aktuelle Lautstärke abfragen
function getCurrentVolume(callback) {
    // ffmpeg liest 1 Sekunde Audio und gibt die Lautstärke aus
    const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-i', '/tmp/hls/stream.m3u8',
        '-t', '1',
        '-vn',
        '-af', 'volumedetect',
        '-f', 'null', '-'
    ]);
    let stderr = '';
    ffmpeg.stderr.on('data', d => stderr += d.toString());
    ffmpeg.on('close', () => {
        // Suche nach "mean_volume" oder "max_volume"
        const meanMatch = stderr.match(/mean_volume: ([\-\d\.]+) dB/);
        const maxMatch = stderr.match(/max_volume: ([\-\d\.]+) dB/);
        let mean = meanMatch ? meanMatch[1] : null;
        let max = maxMatch ? maxMatch[1] : null;
        callback({ mean, max });
    });
}

function getStreamInfo(callback) {
    const ffprobe = spawn('ffprobe', [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=codec_name,bit_rate',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        '/tmp/hls/stream.m3u8'
    ]);
    let audioData = '';
    ffprobe.stdout.on('data', d => audioData += d.toString());
    ffprobe.on('close', () => {
        // Audio: codec_name\nbit_rate\n
        const [audioCodec, audioBitrate] = audioData.trim().split('\n');
        // Jetzt Video
        const ffprobe2 = spawn('ffprobe', [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=bit_rate',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            '/tmp/hls/stream.m3u8'
        ]);
        let videoData = '';
        ffprobe2.stdout.on('data', d => videoData += d.toString());
        ffprobe2.on('close', () => {
            // Video: bit_rate\n
            const videoBitrate = videoData.trim();
            // Fix: Nur umrechnen, wenn Wert numerisch ist
            function safeKbps(val) {
                const n = Number(val);
                return Number.isFinite(n) && n > 0 ? Math.round(n / 1000) + ' kbps' : 'unbekannt';
            }
            callback({
                audioCodec: audioCodec || 'unbekannt',
                audioBitrate: safeKbps(audioBitrate),
                videoBitrate: safeKbps(videoBitrate)
            });
        });
    });
}

// Socket.IO Event-Handling
ioServer.on('connection', (client) => {
    client.emit('live-status', {
        isLive: isLiveStreaming,
        activeInstance: activeIndex
    });

    client.on('command', (cmd) => {
        if (cmd === 'nginx-hls') {
            stopNginxHlsToTwitch();
            setTimeout(() => startNginxHlsToTwitch(), 1000);
        } else if (cmd === 'stop-live') {
            stopNginxHlsToTwitch();
            broadcastLiveStatus();
        } else if (cmd === 'stop-obs-hls') {
            stopNginxHlsToTwitch();
            stopBlackscreenToTwitch();
            stopBlackscreenInstance();
            cleanHlsDirs();
            startBlackscreenInstance();
            setTimeout(() => startBlackscreenToTwitch(), 1500);
            broadcastLiveStatus();
        } else if (cmd === 'switch-nginx-hls') {
            // Blackscreen-Prozesse stoppen und auf nginx-HLS zu Twitch umschalten
            stopBlackscreenToTwitch();
            stopBlackscreenInstance();
            stopNginxHlsToTwitch();
            setTimeout(() => startNginxHlsToTwitch(), 1000);
            broadcastLiveStatus();
        } else if (cmd === 'q') {
            stopNginxHlsToTwitch();
            stopBlackscreenInstance();
            process.exit(0);
        }
    });

    client.on('get-live-status', () => {
        client.emit('live-status', {
            isLive: isLiveStreaming,
            activeInstance: activeIndex
        });
    });

    client.on('get-obs-status', () => {
        client.emit('obs-status', getObsStatus());
    });

    client.on('get-volume', () => {
        getCurrentVolume((vol) => {
            client.emit('volume', vol);
        });
    });

    client.on('get-stream-info', () => {
        getStreamInfo((info) => {
            client.emit('stream-info', info);
        });
    });
});

// Statische HTML-Datei bereitstellen
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="de">
        <head>
            <meta charset="UTF-8">
            <title>OBS - HLS | Broadcasts</title>
            <link href="https://fonts.googleapis.com/css?family=Roboto:500&display=swap" rel="stylesheet">
            <style>
                body {
                    font-family: 'Roboto', Arial, sans-serif;
                    font-weight: 500;
                }
            </style>
        </head>
        <body>
            <h1>OBS - HLS | Broadcasts</h1>
            <button id="nginxBtn" onclick="startNginxHls()" style="background-color: #44aa44; color: white; padding: 10px 20px; font-size: 16px; font-weight: bold;">nginx-HLS zu Twitch</button>
            <button id="switchNginxBtn" onclick="switchToNginxHls()" style="background-color: #228B22; color: white; padding: 10px 20px; font-size: 16px; font-weight: bold; margin-left: 10px;">Switch zu nginx-HLS zu Twitch</button>
            <button id="stopBtn" onclick="stopLive()" style="background-color: #ff4444; color: white; padding: 10px 20px; font-size: 16px; font-weight: bold; margin-left: 10px;">STOP Stream</button>
            <button id="stopObsBtn" onclick="stopObsHls()" style="background-color: #888; color: white; padding: 10px 20px; font-size: 16px; font-weight: bold; margin-left: 10px;">STOP OBS-HLS</button>
            <div id="liveStatus" style="margin-top:20px;">Not streaming</div>
            <div id="obsStatus" style="margin-top:10px; color: #555;">OBS-Status: unbekannt</div>
            <div id="volumeStatus" style="margin-top:10px; color: #555;">Volume: unbekannt</div>
            <div id="streamInfo" style="margin-top:10px; color: #555;">Stream-Info: unbekannt</div>
            <br>
            <button onclick="quit()">Quit</button>
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                let isLive = false;
                socket.on('connect', () => {
                    document.getElementById('liveStatus').style.color = 'black';
                });
                socket.on('disconnect', () => {
                    document.getElementById('liveStatus').style.color = 'red';
                    document.getElementById('liveStatus').textContent = 'Connection lost - reconnecting...';
                });
                socket.on('reconnect', () => {
                    document.getElementById('liveStatus').style.color = 'black';
                });
                function startNginxHls() {
                    socket.emit('command', 'nginx-hls');
                }
                function stopLive() {
                    socket.emit('command', 'stop-live');
                }
                function stopObsHls() {
                    socket.emit('command', 'stop-obs-hls');
                }
                function quit() {
                    socket.emit('command', 'q');
                }
                function switchToNginxHls() {
                    socket.emit('command', 'switch-nginx-hls');
                }
                socket.on('live-status', (status) => {
                    isLive = status.isLive;
                    const nginxBtn = document.getElementById('nginxBtn');
                    const stopBtn = document.getElementById('stopBtn');
                    const stopObsBtn = document.getElementById('stopObsBtn');
                    const statusDiv = document.getElementById('liveStatus');
                    if (isLive) {
                        nginxBtn.disabled = true;
                        stopBtn.disabled = false;
                        stopObsBtn.disabled = false;
                        if (status.activeInstance === 2) {
                            nginxBtn.style.backgroundColor = '#ffaa00';
                            statusDiv.textContent = 'nginx-HLS wird zu Twitch gestreamt!';
                        }
                    } else {
                        nginxBtn.disabled = false;
                        stopBtn.disabled = true;
                        stopObsBtn.disabled = false;
                        nginxBtn.style.backgroundColor = '#ffaa00';
                        statusDiv.textContent = 'Not streaming';
                    }
                });
                // OBS-Status abfragen
                function pollObsStatus() {
                    socket.emit('get-obs-status');
                }
                socket.on('obs-status', (msg) => {
                    const obsDiv = document.getElementById('obsStatus');
                    obsDiv.textContent = 'OBS-Status: ' + msg;
                });
                // Lautstärke-Status abfragen
                function pollVolumeStatus() {
                    socket.emit('get-volume');
                }
                socket.on('volume', (vol) => {
                    const volumeDiv = document.getElementById('volumeStatus');
                    volumeDiv.textContent = 'Volume: ' + (vol.mean !== null ? vol.mean + ' dB' : 'unbekannt');
                });
                function pollStreamInfo() {
                    socket.emit('get-stream-info');
                }
                socket.on('stream-info', (info) => {
                    const infoDiv = document.getElementById('streamInfo');
                    infoDiv.textContent = \`Audio: \${info.audioCodec}, Audio-Bitrate: \${info.audioBitrate}, Video-Bitrate: \${info.videoBitrate}\`;
                });
                setInterval(pollObsStatus, 3000); // alle 3 Sekunden prüfen
                setInterval(pollVolumeStatus, 5000); // alle 5 Sekunden prüfen
                setInterval(pollStreamInfo, 7000); // alle 7 Sekunden prüfen
                pollObsStatus();
                pollVolumeStatus();
                pollStreamInfo();
                socket.emit('get-live-status');
            </script>
        </body>
        </html>
    `);
});

// Server starten
server.listen(3000, () => {
    console.log('Web-Interface läuft auf http://localhost:3000');
});