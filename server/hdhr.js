'use strict';
// HDHomeRun discovery and channel lineup.
//
// With HDHR_HOST set we talk to the tuner directly. Without it we ask SiliconDust's
// discovery service, which returns the tuners it has seen from this public IP
// (UDP broadcast discovery does not work from inside a bridged container).

const HDHR_HOST = (process.env.HDHR_HOST || '').trim();
const DEMO_CHANNEL = process.env.DEMO_CHANNEL === '1' || process.env.DEMO_CHANNEL === 'true';
const LINEUP_TTL_MS = 10 * 60 * 1000;

async function getJson(url, timeoutMs = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${url} timed out`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function discover() {
  if (HDHR_HOST) {
    const base = `http://${HDHR_HOST}`;
    const info = await getJson(`${base}/discover.json`);
    return {
      baseUrl: info.BaseURL || base,
      lineupUrl: info.LineupURL || `${base}/lineup.json`,
      info,
    };
  }
  const devices = await getJson('https://ipv4-api.hdhomerun.com/discover');
  const dev = (Array.isArray(devices) ? devices : []).find((d) => d.LineupURL);
  if (!dev) throw new Error('No HDHomeRun found via auto-discovery. Set HDHR_HOST to its IP address.');
  return { baseUrl: dev.BaseURL, lineupUrl: dev.LineupURL, info: dev };
}

const DEMO = {
  number: 'demo',
  name: 'Test pattern',
  hd: true,
  url: 'demo',
  demo: true,
};

let cache = { at: 0, channels: [] };

async function getLineup(force = false) {
  if (!force && cache.channels.length && Date.now() - cache.at < LINEUP_TTL_MS) return cache.channels;
  let channels = [];
  try {
    const { lineupUrl } = await discover();
    const raw = await getJson(lineupUrl);
    channels = (Array.isArray(raw) ? raw : [])
      .filter((c) => c.URL && !Number(c.DRM))
      .map((c) => ({
        number: String(c.GuideNumber),
        name: c.GuideName || String(c.GuideNumber),
        hd: !!Number(c.HD),
        url: c.URL,
      }));
  } catch (err) {
    if (!DEMO_CHANNEL) throw err;
    console.warn(`[hdhr] lineup unavailable (${err.message}); serving demo channel only`);
  }
  if (DEMO_CHANNEL) channels.push(DEMO);
  cache = { at: Date.now(), channels };
  return channels;
}

async function findChannel(number) {
  const wanted = String(number);
  let channels = await getLineup();
  let ch = channels.find((c) => c.number === wanted);
  if (!ch) {
    channels = await getLineup(true);
    ch = channels.find((c) => c.number === wanted);
  }
  if (!ch) throw new Error(`Unknown channel "${wanted}"`);
  return ch;
}

module.exports = { discover, getLineup, findChannel };
