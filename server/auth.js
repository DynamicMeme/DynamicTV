'use strict';
// Users, passwords and sessions. No external dependencies: scrypt for password hashing and
// HMAC-signed cookie tokens for sessions. Everything persists under DATA_DIR.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret');
const COOKIE = 'dtv_session';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {
    /* first run */
  }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
}
const SECRET = loadSecret();

// ---- User store --------------------------------------------------------------
let users = [];

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    users = Array.isArray(parsed.users) ? parsed.users : [];
  } catch {
    users = [];
  }
}

function save() {
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}
load();

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored || '').split(':');
  if (!saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

function publicUser(u) {
  return { id: u.id, username: u.username, admin: !!u.admin, createdAt: u.createdAt };
}

function validUsername(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_.-]{2,24}$/.test(name);
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= 6 && pw.length <= 200;
}

function hasUsers() {
  return users.length > 0;
}

function list() {
  return users.map(publicUser);
}

function findById(id) {
  return users.find((u) => u.id === id) || null;
}

function findByName(name) {
  const wanted = String(name || '').toLowerCase();
  return users.find((u) => u.username.toLowerCase() === wanted) || null;
}

function createUser({ username, password, admin = false }) {
  if (!validUsername(username)) throw new Error('Username must be 2-24 letters, numbers, dots, dashes or underscores');
  if (!validPassword(password)) throw new Error('Password must be at least 6 characters');
  if (findByName(username)) throw new Error('That username is already taken');
  const user = {
    id: crypto.randomBytes(8).toString('hex'),
    username,
    admin: !!admin,
    hash: hashPassword(password),
    tokenVersion: 1,
    createdAt: Date.now(),
  };
  users.push(user);
  save();
  return user;
}

function setPassword(user, password) {
  if (!validPassword(password)) throw new Error('Password must be at least 6 characters');
  user.hash = hashPassword(password);
  user.tokenVersion += 1; // signs every existing session for this user out
  save();
}

function deleteUser(id) {
  const user = findById(id);
  if (!user) throw new Error('No such user');
  if (user.admin && users.filter((u) => u.admin).length === 1) throw new Error('Cannot delete the last admin');
  users = users.filter((u) => u.id !== id);
  save();
}

function checkLogin(username, password) {
  const user = findByName(username);
  if (!user) {
    // Burn the same time as a real check so usernames cannot be probed by timing.
    crypto.scryptSync(String(password || ''), Buffer.alloc(16), 64);
    return null;
  }
  return verifyPassword(String(password || ''), user.hash) ? user : null;
}

// ---- Session tokens ----------------------------------------------------------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || !payload.uid || !payload.exp || payload.exp < Date.now()) return null;
  const user = findById(payload.uid);
  if (!user || user.tokenVersion !== payload.v) return null;
  return user;
}

function issueToken(user) {
  return sign({ uid: user.id, v: user.tokenVersion, exp: Date.now() + SESSION_MS });
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

function userFromRequest(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function isSecure(req) {
  return !!(req.secure || req.headers['x-forwarded-proto'] === 'https');
}

function setSessionCookie(req, res, user) {
  res.cookie(COOKIE, issueToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecure(req),
    maxAge: SESSION_MS,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

// ---- Login rate limiting (per client IP) --------------------------------------
const attempts = new Map();

function loginAllowed(ip) {
  const a = attempts.get(ip);
  if (!a || a.resetAt < Date.now()) return true;
  return a.count < MAX_LOGIN_ATTEMPTS;
}

function recordFailure(ip) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.resetAt < now) attempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else a.count += 1;
}

function clearFailures(ip) {
  attempts.delete(ip);
}

// ---- Express middleware --------------------------------------------------------
function requireAuth(req, res, next) {
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

module.exports = {
  DATA_DIR,
  hasUsers,
  list,
  findById,
  findByName,
  createUser,
  setPassword,
  deleteUser,
  checkLogin,
  verifyPassword,
  publicUser,
  userFromRequest,
  setSessionCookie,
  clearSessionCookie,
  loginAllowed,
  recordFailure,
  clearFailures,
  requireAuth,
  requireAdmin,
};
