const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const hlsDir = path.join(__dirname, 'hls', 'stream3');
const hlsPlaylist = path.join(hlsDir, 'playlist.m3u8');

if (!fs.existsSync(hlsDir)) fs.mkdirSync(hlsDir, { recursive: true });

const ffmpeg = spawn('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=1280x720:r=30:d=3600',
    '-f', 'lavfi',
    '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
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

ffmpeg.stderr.on('data', d => process.stderr.write(`[ffmpeg blackscreen] ${d}`));
ffmpeg.on('close', code => {
    console.log(`ffmpeg (blackscreen) exited with code ${code}`);
    process.exit(code);
});