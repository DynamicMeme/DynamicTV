(() => {
  'use strict';

  const video = document.getElementById('video');
  const tapBtn = document.getElementById('tap');
  const messageEl = document.getElementById('message');
  const statusEl = document.getElementById('status');
  const syncEl = document.getElementById('sync');
  const nowEl = document.getElementById('now-playing');
  const channelsEl = document.getElementById('channels');
  const stopBtn = document.getElementById('stop');
  const refreshBtn = document.getElementById('refresh');

  // ---- Sync tuning -----------------------------------------------------------
  // Every device plays at (server clock - targetLatency). Small drift is corrected by nudging
  // playbackRate; big drift by seeking. Because the reference is wall-clock time carried in the
  // HLS playlist, devices agree on the position without talking to each other.
  const RATE_MIN = 0.9;
  const RATE_MAX = 1.1;
  const RATE_GAIN = 0.15; // playbackRate change per second of error
  const DEADBAND = 0.1; // seconds of error we ignore
  const SEEK_THRESHOLD = 2.5; // seconds of error beyond which we jump instead of nudge
  const LIVE_GUARD = 1.0; // never play closer than this to the newest segment
  const TICK_MS = 500;

  let state = null;
  let targetLatency = 6;
  let playerStreamId = null;
  let mode = null; // 'native' | 'hlsjs'
  let hls = null;
  let holding = false; // we paused ourselves while waiting for the shared timeline to reach the stream
  let clockOffset = 0; // serverTime - clientTime (ms)
  let clockSamples = [];
  let ws = null;
  let wsBackoff = 1000;
  let channels = [];

  const serverNow = () => Date.now() + clockOffset;

  // ---- UI helpers ------------------------------------------------------------
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'pill' + (cls ? ' ' + cls : '');
  }

  function setSync(text, cls) {
    syncEl.textContent = text;
    syncEl.className = 'sync' + (cls ? ' ' + cls : '');
  }

  function showMessage(text) {
    if (!text) {
      messageEl.hidden = true;
      return;
    }
    messageEl.textContent = text;
    messageEl.hidden = false;
  }

  function renderChannels() {
    channelsEl.innerHTML = '';
    if (!channels.length) {
      channelsEl.innerHTML = '<div class="hint">No channels found.</div>';
      return;
    }
    for (const ch of channels) {
      const btn = document.createElement('button');
      btn.className = 'channel';
      btn.dataset.number = ch.number;
      btn.innerHTML =
        `<span class="num">${escapeHtml(ch.number)}${ch.hd ? '<span class="hd">HD</span>' : ''}</span>` +
        `<span class="name">${escapeHtml(ch.name)}</span>`;
      btn.addEventListener('click', () => tune(ch.number));
      channelsEl.appendChild(btn);
    }
    highlightChannel();
  }

  function highlightChannel() {
    const current = state && state.channel ? state.channel.number : null;
    for (const el of channelsEl.querySelectorAll('.channel')) {
      el.classList.toggle('active', el.dataset.number === current);
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadChannels(refresh) {
    try {
      const res = await fetch('/api/channels' + (refresh ? '?refresh=1' : ''));
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || res.statusText);
      channels = body;
      renderChannels();
    } catch (err) {
      channelsEl.innerHTML = `<div class="hint">Could not load lineup: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ---- WebSocket -------------------------------------------------------------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      wsBackoff = 1000;
      clockSamples = [];
      ping();
      setTimeout(ping, 300);
      setTimeout(ping, 800);
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        const now = Date.now();
        const rtt = now - msg.clientTime;
        const offset = msg.serverTime - (msg.clientTime + rtt / 2);
        clockSamples.push({ rtt, offset });
        clockSamples = clockSamples.slice(-10);
        clockOffset = clockSamples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
      } else if (msg.type === 'state') {
        applyState(msg.state);
      } else if (msg.type === 'error') {
        showMessage(msg.message);
        setTimeout(() => showMessage(''), 4000);
      }
    };

    ws.onclose = () => {
      setStatus('disconnected', 'err');
      setTimeout(connect, wsBackoff);
      wsBackoff = Math.min(wsBackoff * 2, 15000);
    };
    ws.onerror = () => ws.close();
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  function ping() {
    wsSend({ type: 'ping', clientTime: Date.now() });
  }
  setInterval(ping, 5000);

  function tune(number) {
    if (!wsSend({ type: 'tune', channel: number })) {
      fetch('/api/tune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: number }) });
    }
  }

  stopBtn.addEventListener('click', () => {
    if (!wsSend({ type: 'stop' })) fetch('/api/stop', { method: 'POST' });
  });
  refreshBtn.addEventListener('click', () => loadChannels(true));

  // ---- State -> player -------------------------------------------------------
  function applyState(s) {
    state = s;
    if (typeof s.targetLatency === 'number') targetLatency = s.targetLatency;
    nowEl.textContent = s.channel ? `${s.channel.number}  ${s.channel.name}` : 'Not tuned';
    highlightChannel();

    if (!s.channel) {
      unload();
      setStatus('idle');
      showMessage('Pick a channel to start the shared stream.');
      return;
    }

    if (s.status === 'live') {
      setStatus('live', 'live');
      if (s.streamId !== playerStreamId) {
        showMessage('');
        load(s.streamId);
      }
    } else if (s.status === 'starting') {
      setStatus('tuning…', 'warn');
      if (playerStreamId && s.streamId !== playerStreamId) unload();
      showMessage(`Tuning to ${s.channel.number} ${s.channel.name}…`);
    } else {
      setStatus('stream error', 'err');
      unload();
      showMessage(`Stream failed, retrying… ${s.error || ''}`);
    }
  }

  function unload() {
    playerStreamId = null;
    holding = false;
    if (hls) {
      hls.destroy();
      hls = null;
    }
    video.removeAttribute('src');
    video.load();
    mode = null;
    video.playbackRate = 1;
    setSync('');
    tapBtn.hidden = true;
  }

  function load(streamId) {
    unload();
    playerStreamId = streamId;
    const url = `/hls/${streamId}/stream.m3u8`;

    // Safari (macOS/iOS) plays HLS natively and exposes getStartDate(); everything else uses hls.js.
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      mode = 'native';
      video.src = url;
      video.load();
    } else if (window.Hls && Hls.isSupported()) {
      mode = 'hlsjs';
      hls = new Hls({
        liveSyncDuration: targetLatency,
        liveDurationInfinity: true,
        backBufferLength: 30,
        maxLiveSyncPlaybackRate: 1, // we do our own rate control
        enableWorker: true,
      });
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          const id = playerStreamId;
          setTimeout(() => {
            if (state && state.status === 'live' && state.streamId === id) load(id);
          }, 2000);
        }
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      setStatus('unsupported', 'err');
      showMessage('This browser cannot play HLS video.');
      return;
    }
    tryPlay();
  }

  function tryPlay() {
    const p = video.play();
    if (p && p.catch) {
      p.then(() => { tapBtn.hidden = true; }).catch(() => { tapBtn.hidden = false; });
    }
  }
  tapBtn.addEventListener('click', () => {
    tapBtn.hidden = true;
    tryPlay();
  });

  // ---- Sync loop -------------------------------------------------------------
  // Returns { start, end, epoch } where media time t corresponds to wall-clock epoch + t*1000.
  function getRange() {
    if (mode === 'hlsjs') {
      if (!hls || !hls.levels || !hls.levels.length) return null;
      const level = hls.levels[hls.currentLevel >= 0 ? hls.currentLevel : 0];
      const d = level && level.details;
      if (!d || !d.fragments || !d.fragments.length) return null;
      const first = d.fragments[0];
      const last = d.fragments[d.fragments.length - 1];
      if (first.programDateTime == null) return null;
      return {
        start: first.start,
        end: last.start + last.duration,
        epoch: first.programDateTime - first.start * 1000,
      };
    }
    if (mode === 'native') {
      if (typeof video.getStartDate !== 'function' || !video.seekable.length) return null;
      const sd = video.getStartDate();
      if (!sd || isNaN(sd.getTime())) return null;
      return {
        start: video.seekable.start(0),
        end: video.seekable.end(video.seekable.length - 1),
        epoch: sd.getTime(),
      };
    }
    return null;
  }

  function syncTick() {
    if (!playerStreamId || !state || state.status !== 'live') return;
    const r = getRange();
    if (!r || video.readyState < 1) {
      setSync('buffering…');
      return;
    }

    const desiredDate = serverNow() - targetLatency * 1000;
    let target = (desiredDate - r.epoch) / 1000;
    let capped = false;
    if (target > r.end - LIVE_GUARD) {
      target = r.end - LIVE_GUARD; // encoder is behind wall-clock: play as close to live as we safely can
      capped = true;
    }

    if (target < r.start + 0.25) {
      // The shared timeline has not reached this stream's first segment yet (just tuned). Hold.
      if (!video.paused) video.pause();
      holding = true;
      video.playbackRate = 1;
      setSync('waiting for sync point…', 'warn');
      return;
    }

    if (holding) {
      holding = false;
      video.currentTime = target;
      tryPlay();
      return;
    }

    if (video.paused) {
      setSync('paused — press play to rejoin in sync');
      return;
    }

    const err = video.currentTime - target; // >0: ahead of the shared timeline, <0: behind
    if (Math.abs(err) > SEEK_THRESHOLD) {
      video.currentTime = target;
      video.playbackRate = 1;
      setSync('re-syncing…', 'warn');
      return;
    }

    const rate = Math.abs(err) < DEADBAND ? 1 : clamp(1 - err * RATE_GAIN, RATE_MIN, RATE_MAX);
    if (Math.abs(video.playbackRate - rate) > 0.005) video.playbackRate = rate;

    const inSync = Math.abs(err) < 0.3;
    const sign = err >= 0 ? '+' : '−';
    setSync(
      `${inSync ? 'in sync' : 'syncing'} · offset ${sign}${Math.abs(err).toFixed(2)}s · ` +
        `target ${targetLatency}s behind live${capped ? ' (encoder lagging)' : ''}${rate !== 1 ? ` · rate ${rate.toFixed(2)}×` : ''}`,
      inSync ? 'ok' : 'warn'
    );
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  setInterval(syncTick, TICK_MS);

  // Coming back to a backgrounded tab: re-sync right away rather than waiting for the next tick.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      ping();
      syncTick();
    }
  });

  // ---- Boot ------------------------------------------------------------------
  connect();
  loadChannels(false);
})();
