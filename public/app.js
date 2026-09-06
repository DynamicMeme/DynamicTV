(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const overlay = $('overlay');
  const overlaySpinner = $('overlay-spinner');
  const overlayIcon = $('overlay-icon');
  const overlayTitle = $('overlay-title');
  const overlayText = $('overlay-text');
  const tapBtn = $('tap');
  const toastEl = $('toast');
  const statusEl = $('status');
  const syncEl = $('sync');
  const syncText = $('sync-text');
  const syncDetail = $('sync-detail');
  const nowEl = $('now-playing');
  const npNumber = nowEl.querySelector('.np-number');
  const npName = nowEl.querySelector('.np-name');
  const liveDot = nowEl.querySelector('.live-dot');
  const channelsEl = $('channels');
  const searchEl = $('search');
  const stopBtn = $('stop');
  const refreshBtn = $('refresh');
  const chUpBtn = $('ch-up');
  const chDownBtn = $('ch-down');
  const fullscreenBtn = $('fullscreen');
  const userBtn = $('user-btn');
  const userMenu = $('user-menu');
  const avatarEl = $('avatar');
  const userNameEl = $('user-name');
  const chatLog = $('chat-log');
  const chatForm = $('chat-form');
  const chatInput = $('chat-input');
  const chatBadge = $('chat-badge');
  const presenceEl = $('presence');
  const passwordDialog = $('password-dialog');
  const usersDialog = $('users-dialog');

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
  const IS_IOS =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS with desktop UA

  let me = null;
  let state = null;
  let targetLatency = 6;
  let playerStreamId = null;
  let mode = null; // 'native' | 'hlsjs'
  let hls = null;
  let holding = false; // we paused ourselves while waiting for the shared timeline to reach the stream
  let needsInitialSeek = false; // jump to the shared position once after each load
  let clockOffset = 0; // serverTime - clientTime (ms)
  let clockSamples = [];
  let ws = null;
  let wsBackoff = 1000;
  let channels = [];
  let filter = '';
  let toastTimer = null;
  let activeTab = 'channels';
  let unread = 0;

  const serverNow = () => Date.now() + clockOffset;

  // ---- Helpers -----------------------------------------------------------------
  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (res.status === 401) {
      location.replace('/login');
      throw new Error('Not signed in');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || res.statusText);
    return body;
  }

  function postJson(path, data) {
    return api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'pill' + (cls ? ' ' + cls : '');
  }

  function setSync(text, cls, detail) {
    syncText.textContent = text;
    syncDetail.textContent = detail || '';
    syncEl.title = detail || '';
    syncEl.className = 'sync-chip' + (cls ? ' ' + cls : '');
  }

  function showOverlay({ title, text, spinner = false, icon = true, error = false } = {}) {
    overlayTitle.textContent = title || '';
    overlayText.textContent = text || '';
    overlaySpinner.hidden = !spinner;
    overlayIcon.hidden = !icon || spinner;
    overlay.classList.toggle('error', error);
    overlay.hidden = false;
  }

  function hideOverlay() {
    overlay.hidden = true;
    tapBtn.hidden = true;
  }

  function toast(text, ms = 3500) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms);
  }

  function isTyping(target) {
    return target && (target.matches('input, textarea, select, [contenteditable]') || target.closest('dialog[open]'));
  }

  // ---- User menu -----------------------------------------------------------------
  function renderUser() {
    if (!me) return;
    avatarEl.textContent = me.username.slice(0, 1).toUpperCase();
    userNameEl.textContent = me.username;
    $('menu-users').hidden = !me.admin;
  }

  function closeMenu() {
    userMenu.hidden = true;
    userBtn.setAttribute('aria-expanded', 'false');
  }

  userBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const open = userMenu.hidden;
    userMenu.hidden = !open;
    userBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (ev) => {
    if (!userMenu.hidden && !userMenu.contains(ev.target)) closeMenu();
  });

  $('menu-logout').addEventListener('click', async () => {
    closeMenu();
    try {
      await postJson('/api/auth/logout');
    } finally {
      location.replace('/login');
    }
  });

  $('menu-password').addEventListener('click', () => {
    closeMenu();
    openDialog(passwordDialog);
  });

  $('menu-users').addEventListener('click', () => {
    closeMenu();
    openDialog(usersDialog);
    loadUsers();
  });

  // ---- Dialogs -------------------------------------------------------------------
  function openDialog(dialog) {
    const err = dialog.querySelector('.form-error');
    if (err) err.hidden = true;
    for (const f of dialog.querySelectorAll('form')) f.reset();
    dialog.showModal();
  }

  for (const dialog of document.querySelectorAll('dialog')) {
    for (const btn of dialog.querySelectorAll('[data-close]')) btn.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) dialog.close(); // click on the backdrop
    });
  }

  function showFormError(form, text) {
    const err = form.querySelector('.form-error');
    err.textContent = text;
    err.hidden = false;
  }

  $('password-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const data = new FormData(form);
    if (data.get('next') !== data.get('confirm')) return showFormError(form, 'New passwords do not match');
    try {
      await postJson('/api/auth/password', { current: data.get('current'), next: data.get('next') });
      passwordDialog.close();
      toast('Password changed');
    } catch (err) {
      showFormError(form, err.message);
    }
  });

  async function loadUsers() {
    const list = $('users-list');
    list.innerHTML = '<div class="hint">Loading…</div>';
    try {
      const users = await api('/api/users');
      list.innerHTML = '';
      for (const u of users) {
        const row = document.createElement('div');
        row.className = 'user-row';
        row.innerHTML =
          `<span class="avatar small">${escapeHtml(u.username.slice(0, 1).toUpperCase())}</span>` +
          `<span class="user-row-name">${escapeHtml(u.username)}${u.admin ? '<span class="tag">admin</span>' : ''}${u.id === me.id ? '<span class="tag you">you</span>' : ''}</span>` +
          `<button class="btn text" data-act="reset">Reset password</button>` +
          (u.id === me.id ? '' : `<button class="btn text danger" data-act="delete">Remove</button>`);
        row.querySelector('[data-act="reset"]').addEventListener('click', async () => {
          const pw = prompt(`New password for ${u.username}:`);
          if (!pw) return;
          try {
            await postJson(`/api/users/${u.id}/password`, { password: pw });
            toast(`Password reset for ${u.username}`);
          } catch (err) {
            alert(err.message);
          }
        });
        const del = row.querySelector('[data-act="delete"]');
        if (del) {
          del.addEventListener('click', async () => {
            if (!confirm(`Remove ${u.username}?`)) return;
            try {
              await api(`/api/users/${u.id}`, { method: 'DELETE' });
              loadUsers();
            } catch (err) {
              alert(err.message);
            }
          });
        }
        list.appendChild(row);
      }
    } catch (err) {
      list.innerHTML = `<div class="form-error">${escapeHtml(err.message)}</div>`;
    }
  }

  $('add-user-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target;
    const data = new FormData(form);
    try {
      await postJson('/api/users', { username: data.get('username'), password: data.get('password'), admin: data.get('admin') === 'on' });
      form.reset();
      form.querySelector('.form-error').hidden = true;
      toast('User added');
      loadUsers();
    } catch (err) {
      showFormError(form, err.message);
    }
  });

  // ---- Sidebar tabs ----------------------------------------------------------------
  function selectTab(name) {
    activeTab = name;
    for (const tab of document.querySelectorAll('.tab')) {
      const on = tab.dataset.tab === name;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', String(on));
    }
    for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('active', panel.id === `panel-${name}`);
    if (name === 'chat') {
      unread = 0;
      updateBadge();
      scrollChat(true);
      if (matchMedia('(min-width: 960px)').matches) chatInput.focus();
    }
  }
  for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));

  function updateBadge() {
    chatBadge.hidden = unread === 0;
    chatBadge.textContent = unread > 99 ? '99+' : String(unread);
  }

  // ---- Chat ------------------------------------------------------------------------
  function fmtTime(ts) {
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function chatAtBottom() {
    return chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
  }

  function scrollChat(force) {
    if (force || chatAtBottom()) chatLog.scrollTop = chatLog.scrollHeight;
  }

  function appendChat(m) {
    const el = document.createElement('div');
    const mine = me && m.user === me.username;
    el.className = 'msg' + (m.system ? ' system' : '') + (mine ? ' mine' : '');
    el.innerHTML = m.system
      ? `<span class="who">${escapeHtml(m.user)}</span> ${escapeHtml(m.text)} <span class="time">${fmtTime(m.ts)}</span>`
      : `<div class="meta"><span class="who">${escapeHtml(m.user)}</span><span class="time">${fmtTime(m.ts)}</span></div><div class="text">${escapeHtml(m.text)}</div>`;
    chatLog.appendChild(el);
  }

  function renderChatHistory(list) {
    chatLog.innerHTML = '';
    for (const m of list) appendChat(m);
    scrollChat(true);
  }

  function onChatMessage(m) {
    const stick = chatAtBottom() || (me && m.user === me.username);
    appendChat(m);
    scrollChat(stick);
    if (!m.system && (activeTab !== 'chat' || document.hidden) && !(me && m.user === me.username)) {
      unread += 1;
      updateBadge();
    }
  }

  function renderPresence(users) {
    presenceEl.innerHTML = users.length
      ? `<span class="presence-label">Watching now</span>` + users.map((u) => `<span class="chip${me && u === me.username ? ' me' : ''}">${escapeHtml(u)}</span>`).join('')
      : '';
  }

  chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    if (wsSend({ type: 'chat', text })) chatInput.value = '';
    else toast('Not connected');
  });

  // ---- Channel list ----------------------------------------------------------
  function channelMatches(ch) {
    if (!filter) return true;
    return ch.number.toLowerCase().includes(filter) || ch.name.toLowerCase().includes(filter);
  }

  function groupKey(ch) {
    const major = ch.number.split(/[.-]/)[0];
    return /^\d+$/.test(major) ? major : ch.number;
  }

  function renderChannels() {
    channelsEl.innerHTML = '';
    const visible = channels.filter(channelMatches);
    if (!visible.length) {
      channelsEl.innerHTML = `<div class="empty">${channels.length ? 'No channels match.' : 'No channels found.'}</div>`;
      return;
    }

    const groups = new Map();
    for (const ch of visible) {
      const key = groupKey(ch);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ch);
    }

    for (const [key, list] of groups) {
      const group = document.createElement('div');
      group.className = 'group';
      const primary = list.find((c) => /^\d+[.-]1$/.test(c.number)) || list[0];
      const title = document.createElement('div');
      title.className = 'group-title';
      title.textContent = /^\d+$/.test(key) ? `${key} · ${primary.name}` : key;
      group.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'group-list';
      for (const ch of list) {
        const btn = document.createElement('button');
        btn.className = 'channel';
        btn.dataset.number = ch.number;
        btn.title = `${ch.number} ${ch.name}`;
        btn.innerHTML =
          `<span class="num">${escapeHtml(ch.number)}${ch.hd ? '<span class="hd">HD</span>' : ''}</span>` +
          `<span class="name">${escapeHtml(ch.name)}</span>` +
          `<span class="indicator"><i></i><i></i><i></i></span>`;
        btn.addEventListener('click', () => tune(ch.number));
        grid.appendChild(btn);
      }
      group.appendChild(grid);
      channelsEl.appendChild(group);
    }
    highlightChannel();
  }

  function highlightChannel() {
    const current = state && state.channel ? state.channel.number : null;
    const tuning = !!(state && state.status === 'starting');
    for (const el of channelsEl.querySelectorAll('.channel')) {
      const active = el.dataset.number === current;
      el.classList.toggle('active', active);
      el.classList.toggle('tuning', active && tuning);
    }
    const idx = channels.findIndex((c) => c.number === current);
    chUpBtn.disabled = !channels.length;
    chDownBtn.disabled = !channels.length;
    chUpBtn.dataset.target = channels.length ? channels[(idx + 1) % channels.length].number : '';
    chDownBtn.dataset.target = channels.length ? channels[(idx - 1 + channels.length) % channels.length].number : '';
  }

  async function loadChannels(refresh) {
    try {
      channels = await api('/api/channels' + (refresh ? '?refresh=1' : ''));
      renderChannels();
      if (refresh) toast(`Lineup refreshed: ${channels.length} channels`);
    } catch (err) {
      channelsEl.innerHTML = `<div class="empty">Could not load lineup: ${escapeHtml(err.message)}</div>`;
    }
  }

  searchEl.addEventListener('input', () => {
    filter = searchEl.value.trim().toLowerCase();
    renderChannels();
  });

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
      switch (msg.type) {
        case 'pong': {
          const now = Date.now();
          const rtt = now - msg.clientTime;
          const offset = msg.serverTime - (msg.clientTime + rtt / 2);
          clockSamples.push({ rtt, offset });
          clockSamples = clockSamples.slice(-10);
          clockOffset = clockSamples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
          break;
        }
        case 'state':
          applyState(msg.state);
          break;
        case 'chat_history':
          renderChatHistory(msg.messages || []);
          break;
        case 'chat':
          onChatMessage(msg.message);
          break;
        case 'presence':
          renderPresence(msg.users || []);
          break;
        case 'error':
          toast(msg.message);
          break;
        default:
          break;
      }
    };

    ws.onclose = (ev) => {
      setStatus('offline', 'err');
      renderPresence([]);
      if (ev.code === 4001) {
        location.replace('/login');
        return;
      }
      // If the session expired, api() bounces us to the login page instead of reconnecting forever.
      api('/api/auth/me').catch(() => {});
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
    if (!number) return;
    if (!wsSend({ type: 'tune', channel: number })) postJson('/api/tune', { channel: number }).catch((err) => toast(err.message));
  }

  function stop() {
    if (!wsSend({ type: 'stop' })) postJson('/api/stop').catch((err) => toast(err.message));
  }

  stopBtn.addEventListener('click', stop);
  refreshBtn.addEventListener('click', () => loadChannels(true));
  chUpBtn.addEventListener('click', () => tune(chUpBtn.dataset.target));
  chDownBtn.addEventListener('click', () => tune(chDownBtn.dataset.target));

  function toggleFullscreen() {
    const wrap = video.parentElement;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (wrap.requestFullscreen) {
      wrap.requestFullscreen();
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen(); // iOS
    }
  }
  fullscreenBtn.addEventListener('click', toggleFullscreen);

  document.addEventListener('keydown', (ev) => {
    if (isTyping(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    switch (ev.key) {
      case 'ArrowUp':
      case 'PageUp':
        tune(chUpBtn.dataset.target);
        break;
      case 'ArrowDown':
      case 'PageDown':
        tune(chDownBtn.dataset.target);
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      case 'm':
      case 'M':
        video.muted = !video.muted;
        break;
      case '/':
        selectTab('channels');
        searchEl.focus();
        break;
      case 'c':
      case 'C':
        selectTab('chat');
        chatInput.focus();
        break;
      default:
        return;
    }
    ev.preventDefault();
  });

  // ---- State -> player -------------------------------------------------------
  function applyState(s) {
    state = s;
    if (typeof s.targetLatency === 'number') targetLatency = s.targetLatency;
    npNumber.textContent = s.channel ? s.channel.number : '';
    npName.textContent = s.channel ? s.channel.name : 'Not tuned';
    liveDot.hidden = !(s.channel && s.status === 'live');
    highlightChannel();

    if (!s.channel) {
      unload();
      setStatus('idle');
      showOverlay({ title: 'Pick a channel', text: 'Everyone on the network watches the same stream, in sync.' });
      return;
    }

    if (s.status === 'live') {
      setStatus('live', 'live');
      if (s.streamId !== playerStreamId) load(s.streamId);
    } else if (s.status === 'starting') {
      setStatus('tuning', 'warn');
      if (playerStreamId && s.streamId !== playerStreamId) unload();
      showOverlay({ title: `Tuning to ${s.channel.number} ${s.channel.name}`, text: 'Starting the encoder…', spinner: true });
    } else {
      setStatus('error', 'err');
      unload();
      showOverlay({ title: 'Stream failed, retrying…', text: s.error || '', error: true });
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
    setSync('idle');
  }

  function load(streamId) {
    unload();
    playerStreamId = streamId;
    needsInitialSeek = true;
    const url = `/hls/${streamId}/stream.m3u8`;
    showOverlay({ title: 'Loading…', text: '', spinner: true });

    // iOS Safari plays HLS natively and exposes getStartDate() for wall-clock mapping. Everywhere
    // else we use hls.js: recent Chromium also claims native HLS support ("maybe") but has no
    // getStartDate() and, on desktop, did not start playback at all.
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl');
    const hlsjsOk = window.Hls && Hls.isSupported();
    if (nativeHls && (IS_IOS || !hlsjsOk)) {
      mode = 'native';
      video.src = url;
      video.load();
    } else if (hlsjsOk) {
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
          if (data.response && data.response.code === 401) {
            location.replace('/login');
            return;
          }
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
      showOverlay({ title: 'Unsupported browser', text: 'This browser cannot play HLS video.', error: true });
      return;
    }
    tryPlay();
  }

  function tryPlay() {
    const p = video.play();
    if (p && p.catch) {
      p.then(() => { tapBtn.hidden = true; }).catch(() => {
        showOverlay({ title: state && state.channel ? `${state.channel.number} ${state.channel.name}` : '', text: '', icon: false });
        tapBtn.hidden = false;
      });
    }
  }
  tapBtn.addEventListener('click', () => {
    tapBtn.hidden = true;
    tryPlay();
  });

  video.addEventListener('playing', () => {
    if (playerStreamId) hideOverlay();
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
      setSync('buffering', 'warn');
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
      setSync('waiting for sync point', 'warn');
      return;
    }

    if (holding) {
      holding = false;
      needsInitialSeek = false;
      video.currentTime = target;
      tryPlay();
      return;
    }

    if (video.paused) {
      setSync('paused', '', 'press play to rejoin in sync');
      return;
    }

    const err = video.currentTime - target; // >0: ahead of the shared timeline, <0: behind
    if (needsInitialSeek || Math.abs(err) > SEEK_THRESHOLD) {
      // First alignment after load jumps straight to the shared position; after that we only nudge.
      needsInitialSeek = false;
      video.currentTime = target;
      video.playbackRate = 1;
      setSync('syncing', 'warn');
      return;
    }

    const rate = Math.abs(err) < DEADBAND ? 1 : clamp(1 - err * RATE_GAIN, RATE_MIN, RATE_MAX);
    if (Math.abs(video.playbackRate - rate) > 0.005) video.playbackRate = rate;

    const inSync = Math.abs(err) < 0.3;
    const sign = err >= 0 ? '+' : '−';
    const detail =
      `${sign}${Math.abs(err).toFixed(2)}s · ${targetLatency}s behind live` +
      (capped ? ' · encoder lagging' : '') +
      (rate !== 1 ? ` · ${rate.toFixed(2)}×` : '');
    setSync(inSync ? 'in sync' : 'syncing', inSync ? 'ok' : 'warn', detail);
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
      if (activeTab === 'chat') {
        unread = 0;
        updateBadge();
      }
    }
  });

  // ---- Boot ------------------------------------------------------------------
  (async () => {
    try {
      me = (await api('/api/auth/me')).user;
    } catch {
      return; // api() already redirected to /login
    }
    renderUser();
    connect();
    loadChannels(false);
  })();

  // Debug hook for previewing the UI without a server.
  window.__dtv = {
    setChannels(list) {
      channels = list;
      renderChannels();
    },
    applyState,
    setUser(u) {
      me = u;
      renderUser();
    },
    chat(list) {
      renderChatHistory(list);
    },
    presence: renderPresence,
  };
})();
