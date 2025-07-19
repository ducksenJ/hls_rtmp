const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

if (process.argv.length < 3) {
    console.error('Usage: node instance_1.js <YouTube-Link>');
    process.exit(1);
}

const ytLink = process.argv[2];
const hlsDir = path.join(__dirname, 'hls', 'stream1');
const hlsPlaylist = path.join(hlsDir, 'playlist.m3u8');

if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, { recursive: true });

const ytdlp = spawn('yt-dlp', [
    '-f', 'bestvideo[height<=720]+bestaudio/best',
    '-o', '-',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout', '10',
    '--retries', '1',
    '--live-from-start',
    ytLink
]);

const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-i', 'pipe:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-b:v', '1500k',
    '-maxrate', '1500k',
    '-bufsize', '3000k',
    '-r', '30',
    '-pix_fmt', 'yuv420p',
    '-g', '60',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-f', 'hls',
    '-hls_time', '1',
    '-hls_list_size', '6',
    '-hls_flags', 'program_date_time',
    '-hls_segment_filename', path.join(hlsDir, 'segment_%03d.ts'),
    '-hls_allow_cache', '1',
    '-hls_segment_type', 'mpegts',
    hlsPlaylist
]);

ytdlp.stdout.pipe(ffmpeg.stdin);

ytdlp.stderr.on('data', d => process.stderr.write(`[yt-dlp] ${d}`));
ffmpeg.stderr.on('data', d => process.stderr.write(`[ffmpeg] ${d}`));

ytdlp.on('close', code => {
    console.log(`yt-dlp exited with code ${code}`);
    ffmpeg.stdin.end();
});
ffmpeg.on('close', code => {
    console.log(`ffmpeg exited with code ${code}`);
    process.exit(code);
});