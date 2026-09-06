'use strict';
// One shared "session": a single ffmpeg process transcoding the current channel to HLS.
// Every ffmpeg run gets its own directory + streamId so clients can tell a fresh stream
// (channel change, crash restart) apart from the one they are already playing.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const HLS_ROOT = process.env.HLS_ROOT || '/tmp/hls';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const SEGMENT_SECONDS = Number(process.env.SEGMENT_SECONDS || 2);
const LIST_SIZE = Number(process.env.HLS_LIST_SIZE || 30);
const VIDEO_HEIGHT = Number(process.env.VIDEO_HEIGHT || 720);
const VIDEO_BITRATE = process.env.VIDEO_BITRATE || '4000k';
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '128k';
const X264_PRESET = process.env.X264_PRESET || 'veryfast';
const X264_CRF = process.env.X264_CRF || '23';
const VIDEO_ARGS_OVERRIDE = (process.env.FFMPEG_VIDEO_ARGS || '').trim();
const TARGET_LATENCY = Number(process.env.TARGET_LATENCY || 6);
const LIVE_AFTER_SEGMENTS = 2; // playlist must hold this many segments before clients are told to play

function doubleRate(rate) {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(rate);
  if (!m) return rate;
  return `${Number(m[1]) * 2}${m[2]}`;
}

function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function videoArgs() {
  if (VIDEO_ARGS_OVERRIDE) return splitArgs(VIDEO_ARGS_OVERRIDE);
  // Broadcast TV is usually interlaced (1080i / 480i); yadif only touches frames flagged interlaced.
  const vf = ['yadif=mode=send_frame:parity=auto:deint=interlaced'];
  if (VIDEO_HEIGHT > 0) vf.push(`scale=-2:${VIDEO_HEIGHT}`);
  return [
    '-vf', vf.join(','),
    '-c:v', 'libx264',
    '-preset', X264_PRESET,
    '-crf', X264_CRF,
    '-maxrate', VIDEO_BITRATE,
    '-bufsize', doubleRate(VIDEO_BITRATE),
    '-profile:v', 'high',
    '-level', '4.1',
    '-pix_fmt', 'yuv420p',
    '-sc_threshold', '0',
  ];
}

function inputArgs(channel) {
  if (channel.demo) {
    return [
      '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
      '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:beep_factor=4:sample_rate=48000',
      '-map', '0:v:0', '-map', '1:a:0',
    ];
  }
  return [
    '-fflags', '+genpts+discardcorrupt',
    '-analyzeduration', '3000000',
    '-probesize', '6000000',
    '-i', channel.url,
    '-map', '0:v:0', '-map', '0:a:0?',
  ];
}

function buildArgs(channel, dir) {
  return [
    '-hide_banner', '-loglevel', 'warning', '-nostats',
    ...inputArgs(channel),
    '-sn', '-dn',
    ...videoArgs(),
    // Keyframe on every segment boundary regardless of the source frame rate.
    '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
    '-c:a', 'aac', '-ac', '2', '-b:a', AUDIO_BITRATE,
    '-af', 'aresample=async=1',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SECONDS),
    '-hls_list_size', String(LIST_SIZE),
    // program_date_time is what lets every device map playback position to wall-clock time.
    '-hls_flags', 'delete_segments+program_date_time+independent_segments+temp_file',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'stream.m3u8'),
  ];
}

class StreamManager extends EventEmitter {
  constructor() {
    super();
    fs.rmSync(HLS_ROOT, { recursive: true, force: true });
    fs.mkdirSync(HLS_ROOT, { recursive: true });
    this.channel = null;
    this.run = null;
    this.error = null;
    this.restarts = 0;
    this.restartTimer = null;
  }

  state() {
    return {
      channel: this.channel ? { number: this.channel.number, name: this.channel.name } : null,
      streamId: this.run ? this.run.id : null,
      status: this.run ? this.run.status : (this.channel ? 'error' : 'idle'),
      error: this.error,
      startedAt: this.run ? this.run.startedAt : null,
      targetLatency: TARGET_LATENCY,
      segmentSeconds: SEGMENT_SECONDS,
      serverTime: Date.now(),
    };
  }

  emitState() {
    this.emit('state', this.state());
  }

  tune(channel) {
    // Re-tuning the channel that is already running is a no-op (keeps everyone in sync).
    if (this.channel && this.run && this.channel.url === channel.url) {
      this.emitState();
      return;
    }
    clearTimeout(this.restartTimer);
    this.channel = channel;
    this.error = null;
    this.restarts = 0;
    this.startRun();
  }

  stop() {
    clearTimeout(this.restartTimer);
    this.channel = null;
    this.error = null;
    this.killRun();
    this.emitState();
  }

  killRun() {
    const run = this.run;
    this.run = null;
    if (!run) return;
    run.stopping = true;
    clearInterval(run.timer);
    if (run.proc && run.proc.exitCode === null && !run.proc.killed) {
      run.proc.kill('SIGTERM');
      setTimeout(() => {
        if (run.proc.exitCode === null) run.proc.kill('SIGKILL');
      }, 3000).unref();
    }
    setTimeout(() => fs.rm(run.dir, { recursive: true, force: true }, () => {}), 5000).unref();
  }

  startRun() {
    this.killRun();
    const id = crypto.randomBytes(6).toString('hex');
    const dir = path.join(HLS_ROOT, id);
    fs.mkdirSync(dir, { recursive: true });
    const args = buildArgs(this.channel, dir);
    console.log(`[ffmpeg ${id}] tuning ${this.channel.number} ${this.channel.name}`);
    if (process.env.LOG_FFMPEG_ARGS) console.log(`[ffmpeg ${id}] ${FFMPEG} ${args.join(' ')}`);

    const run = {
      id,
      dir,
      status: 'starting',
      startedAt: Date.now(),
      stderr: [],
      stopping: false,
      handled: false,
      timer: null,
      proc: null,
    };
    this.run = run;

    let proc;
    try {
      proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      run.stderr.push(err.message);
      this.onExit(run, -1, null);
      return;
    }
    run.proc = proc;

    proc.stderr.on('data', (chunk) => {
      for (const raw of chunk.toString().split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        run.stderr.push(line);
        if (run.stderr.length > 20) run.stderr.shift();
        console.log(`[ffmpeg ${id}] ${line}`);
      }
    });
    proc.on('error', (err) => {
      run.stderr.push(err.message);
      this.onExit(run, -1, null);
    });
    proc.on('exit', (code, signal) => this.onExit(run, code, signal));

    run.timer = setInterval(() => this.checkLive(run), 500);
    this.emitState();
  }

  checkLive(run) {
    if (run.status !== 'starting') {
      clearInterval(run.timer);
      return;
    }
    let playlist;
    try {
      playlist = fs.readFileSync(path.join(run.dir, 'stream.m3u8'), 'utf8');
    } catch {
      return;
    }
    const segments = (playlist.match(/#EXTINF/g) || []).length;
    if (segments >= LIVE_AFTER_SEGMENTS) {
      clearInterval(run.timer);
      run.status = 'live';
      this.restarts = 0;
      this.error = null;
      console.log(`[ffmpeg ${run.id}] live after ${((Date.now() - run.startedAt) / 1000).toFixed(1)}s`);
      this.emitState();
    }
  }

  onExit(run, code, signal) {
    if (run.handled) return;
    run.handled = true;
    clearInterval(run.timer);
    if (run.stopping || this.run !== run) return; // we killed it on purpose
    this.run = null;
    const tail = run.stderr.slice(-3).join(' | ');
    this.error = `ffmpeg exited (${signal || code})${tail ? ': ' + tail : ''}`;
    console.error(`[ffmpeg ${run.id}] ${this.error}`);
    setTimeout(() => fs.rm(run.dir, { recursive: true, force: true }, () => {}), 5000).unref();

    this.restarts += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(this.restarts, 5));
    console.log(`[ffmpeg] restarting in ${delay / 1000}s (attempt ${this.restarts})`);
    this.emitState();
    this.restartTimer = setTimeout(() => {
      if (this.channel) this.startRun();
    }, delay);
  }
}

module.exports = { StreamManager, HLS_ROOT, TARGET_LATENCY };
