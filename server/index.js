'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const hdhr = require('./hdhr');
const auth = require('./auth');
const chat = require('./chat');
const { StreamManager, HLS_ROOT } = require('./stream');

const PORT = Number(process.env.PORT || 8080);
const STATE_BROADCAST_MS = 10000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const HLSJS_PATH = path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js');

const app = express();
app.disable('x-powered-by');
// Trust reverse proxies on private networks (Nginx Proxy Manager etc.) so req.ip / req.secure are right.
app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '16kb' }));

const streams = new StreamManager();

async function tune(number, user) {
  if (number === undefined || number === null || number === '') throw new Error('channel is required');
  const channel = await hdhr.findChannel(number);
  const changed = !streams.channel || streams.channel.url !== channel.url;
  streams.tune(channel);
  if (changed && user) postSystem(user, `tuned to ${channel.number} ${channel.name}`);
  return channel;
}

// ---- Auth: public routes -----------------------------------------------------
app.get('/login', (req, res) => {
  if (auth.userFromRequest(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

app.get('/api/auth/status', (req, res) => {
  const user = auth.userFromRequest(req);
  res.json({ setupRequired: !auth.hasUsers(), user: user ? auth.publicUser(user) : null });
});

app.post('/api/auth/setup', (req, res) => {
  if (auth.hasUsers()) return res.status(403).json({ error: 'Setup is already complete' });
  try {
    const { username, password } = req.body || {};
    const user = auth.createUser({ username, password, admin: true });
    auth.setSessionCookie(req, res, user);
    console.log(`[auth] admin account "${user.username}" created`);
    res.json({ user: auth.publicUser(user) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  if (!auth.loginAllowed(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username, password } = req.body || {};
  const user = auth.checkLogin(username, password);
  if (!user) {
    auth.recordFailure(req.ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  auth.clearFailures(req.ip);
  auth.setSessionCookie(req, res, user);
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// The player page itself: send people to the login (or first-run setup) page.
app.get(['/', '/index.html'], (req, res) => {
  if (!auth.userFromRequest(req)) return res.redirect('/login');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Everything below needs a session.
app.use(['/api', '/hls'], auth.requireAuth);

// ---- Auth: signed-in routes ---------------------------------------------------
app.get('/api/auth/me', (req, res) => res.json({ user: auth.publicUser(req.user) }));

app.post('/api/auth/password', (req, res) => {
  const { current, next } = req.body || {};
  if (!auth.verifyPassword(String(current || ''), req.user.hash)) return res.status(400).json({ error: 'Current password is wrong' });
  try {
    auth.setPassword(req.user, next);
    auth.setSessionCookie(req, res, req.user); // keep this session alive after the version bump
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/users', auth.requireAdmin, (req, res) => res.json(auth.list()));

app.post('/api/users', auth.requireAdmin, (req, res) => {
  try {
    const { username, password, admin } = req.body || {};
    const user = auth.createUser({ username, password, admin: !!admin });
    res.json(auth.publicUser(user));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users/:id/password', auth.requireAdmin, (req, res) => {
  const user = auth.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'No such user' });
  try {
    auth.setPassword(user, (req.body || {}).password);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/:id', auth.requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete yourself' });
  try {
    auth.deleteUser(req.params.id);
    for (const client of wss.clients) {
      if (client.user && client.user.id === req.params.id) client.close(4001, 'account removed');
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- TV API ------------------------------------------------------------------
app.get('/api/channels', async (req, res) => {
  try {
    const channels = await hdhr.getLineup(req.query.refresh === '1');
    res.json(channels.map(({ number, name, hd }) => ({ number, name, hd })));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/state', (req, res) => res.json(streams.state()));

app.post('/api/tune', async (req, res) => {
  try {
    await tune(req.body && req.body.channel, req.user);
    res.json(streams.state());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/stop', (req, res) => {
  stopStream(req.user);
  res.json(streams.state());
});

function stopStream(user) {
  if (streams.channel && user) postSystem(user, 'stopped the stream');
  streams.stop();
}

// ---- HLS output --------------------------------------------------------------
app.use(
  '/hls',
  (req, res, next) => {
    // Playlists change every segment; segment names are unique per stream so they can be cached.
    res.set('Cache-Control', req.path.endsWith('.m3u8') ? 'no-store' : 'private, max-age=300');
    next();
  },
  express.static(HLS_ROOT, { etag: false, lastModified: false, index: false, dotfiles: 'ignore' })
);

// ---- Static assets (no secrets in here, so no auth needed) ---------------------
app.get('/vendor/hls.min.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(HLSJS_PATH);
});
app.use(express.static(PUBLIC_DIR, { index: false, etag: true }));

// ---- WebSocket: state broadcast, clock sync, channel changes, chat --------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if ((req.url || '').split('?')[0] !== '/ws') {
    socket.destroy();
    return;
  }
  const user = auth.userFromRequest(req);
  if (!user) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = user;
    wss.emit('connection', ws, req);
  });
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

function presence() {
  const names = new Set();
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN && client.user) names.add(client.user.username);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function broadcastPresence() {
  broadcast({ type: 'presence', users: presence() });
}

function postSystem(user, text) {
  const message = chat.add({ user: user.username, text, system: true });
  if (message) broadcast({ type: 'chat', message });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { type: 'state', state: streams.state() });
  send(ws, { type: 'chat_history', messages: chat.recent(100) });
  broadcastPresence();

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'ping') {
      // Clients use this to estimate the server clock offset (NTP-style).
      send(ws, { type: 'pong', clientTime: msg.clientTime, serverTime: Date.now() });
    } else if (msg.type === 'tune') {
      try {
        await tune(msg.channel, ws.user);
      } catch (err) {
        send(ws, { type: 'error', message: err.message });
      }
    } else if (msg.type === 'stop') {
      stopStream(ws.user);
    } else if (msg.type === 'chat') {
      const message = chat.add({ user: ws.user.username, text: msg.text });
      if (message) broadcast({ type: 'chat', message });
    }
  });

  ws.on('close', broadcastPresence);
});

streams.on('state', (state) => broadcast({ type: 'state', state }));

// Periodic state push doubles as an application-level keepalive; ws-level ping prunes dead sockets.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.isAlive === false) {
      client.terminate();
      continue;
    }
    client.isAlive = false;
    client.ping();
  }
  broadcast({ type: 'state', state: streams.state() });
}, STATE_BROADCAST_MS);

server.listen(PORT, () => {
  console.log(`DynamicTV listening on http://0.0.0.0:${PORT}`);
  if (!auth.hasUsers()) console.log('[auth] no users yet: open the web UI to create the admin account');
  hdhr
    .getLineup()
    .then((channels) => {
      console.log(`[hdhr] ${channels.length} channels available`);
      const autoTune = (process.env.AUTO_TUNE || '').trim();
      if (autoTune) return tune(autoTune, null);
    })
    .catch((err) => console.error(`[hdhr] ${err.message}`));
});

function shutdown() {
  console.log('shutting down');
  clearInterval(heartbeat);
  streams.stop();
  for (const client of wss.clients) client.close();
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
