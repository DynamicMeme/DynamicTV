'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const hdhr = require('./hdhr');
const { StreamManager, HLS_ROOT } = require('./stream');

const PORT = Number(process.env.PORT || 8080);
const STATE_BROADCAST_MS = 10000;

const app = express();
app.disable('x-powered-by');
app.use(express.json());

const streams = new StreamManager();

async function tune(number) {
  if (number === undefined || number === null || number === '') throw new Error('channel is required');
  const channel = await hdhr.findChannel(number);
  streams.tune(channel);
}

// ---- REST API ----------------------------------------------------------------
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
    await tune(req.body && req.body.channel);
    res.json(streams.state());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/stop', (req, res) => {
  streams.stop();
  res.json(streams.state());
});

// ---- HLS output --------------------------------------------------------------
app.use(
  '/hls',
  (req, res, next) => {
    // Playlists change every segment; segment names are unique per stream so they can be cached.
    res.set('Cache-Control', req.path.endsWith('.m3u8') ? 'no-store' : 'public, max-age=300');
    next();
  },
  express.static(HLS_ROOT, { etag: false, lastModified: false, index: false, dotfiles: 'ignore' })
);

// ---- Static player -----------------------------------------------------------
const HLSJS_PATH = path.join(__dirname, '..', 'node_modules', 'hls.js', 'dist', 'hls.min.js');
app.get('/vendor/hls.min.js', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(HLSJS_PATH);
});
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true }));

// ---- WebSocket: state broadcast, clock sync, channel changes ------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj) {
  const payload = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  send(ws, { type: 'state', state: streams.state() });

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
        await tune(msg.channel);
      } catch (err) {
        send(ws, { type: 'error', message: err.message });
      }
    } else if (msg.type === 'stop') {
      streams.stop();
    }
  });
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
  hdhr
    .getLineup()
    .then((channels) => {
      console.log(`[hdhr] ${channels.length} channels available`);
      const auto = (process.env.AUTO_TUNE || '').trim();
      if (auto) return tune(auto);
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
