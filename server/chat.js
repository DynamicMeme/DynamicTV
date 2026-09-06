'use strict';
// Chat history: kept in memory, persisted to DATA_DIR/chat.json a moment after each change.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || '/data';
const CHAT_FILE = path.join(DATA_DIR, 'chat.json');
const MAX_MESSAGES = Number(process.env.CHAT_HISTORY || 300);
const MAX_TEXT = 500;

let messages = [];
let saveTimer = null;

try {
  const parsed = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8'));
  messages = Array.isArray(parsed.messages) ? parsed.messages.slice(-MAX_MESSAGES) : [];
} catch {
  messages = [];
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = `${CHAT_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ messages }));
      fs.renameSync(tmp, CHAT_FILE);
    } catch (err) {
      console.error(`[chat] could not save history: ${err.message}`);
    }
  }, 1000).unref();
}

function add({ user, text, system = false }) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
  if (!clean) return null;
  const message = { id: crypto.randomBytes(6).toString('hex'), user, text: clean, system: !!system, ts: Date.now() };
  messages.push(message);
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES);
  scheduleSave();
  return message;
}

function recent(count = 100) {
  return messages.slice(-count);
}

module.exports = { add, recent, MAX_TEXT };
