'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const net = require('net');
const zlib = require('zlib');
const { URL } = require('url');
const { CharacterRegistry, IdentityError, validNick, validUuid } = require('./character-registry');
const { connectionFile } = require('./connection-export');
const { validSecret } = require('./site-bootstrap');
const worldCatalog = require('./world-catalog');

function loadDotEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    console.warn('[Home Craft] Failed to load .env:', error.message);
  }
}

loadDotEnvFile(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || process.env.HOMECRAFT_SITE_HOST || '0.0.0.0';
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || process.env.HOMECRAFT_PUBLIC_SITE_URL || `http://${detectLanIp()}:${PORT}`;
const SITE_STARTED_AT = Date.now();
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
// Runtime requirements shipped with the 26.3 source release.
const MINECRAFT_RUNTIME = Object.freeze({
  minecraft: '26.3',
  neoforge: '26.3.0.97',
  minimumNeoForge: '26.3.0.97',
  neoForgeRange: '[26.3.0.97,26.4)',
  java: 25,
  installerUrl: 'https://maven.neoforged.net/releases/net/neoforged/neoforge/26.3.0.97/neoforge-26.3.0.97-installer.jar'
});
const RUNTIME_LABEL = `Minecraft ${MINECRAFT_RUNTIME.minecraft} / NeoForge ${MINECRAFT_RUNTIME.neoforge}`;

const LEGACY_DB_FILE = path.join(DATA_DIR, 'db.json');
const USERS_DB_FILE = path.resolve(ROOT, process.env.HOMECRAFT_USERS_DB_FILE || path.join('data', 'users.json'));
const RUNTIME_DB_FILE = path.resolve(ROOT, process.env.HOMECRAFT_RUNTIME_DB_FILE || path.join('data', 'runtime.json'));
const CHARACTER_DB_FILE = path.resolve(ROOT, process.env.HOMECRAFT_CHARACTERS_DB_FILE || path.join('data', 'characters.json'));
const characterRegistry = new CharacterRegistry(CHARACTER_DB_FILE);
const SERVER_SECRET = process.env.SERVER_SECRET || process.env.HOMECRAFT_SERVER_SECRET || 'change-this-secret-before-public-use';
const COOKIE_SECURE = PUBLIC_SITE_URL.startsWith('https://') || String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
const TRUST_PROXY = String(process.env.HOMECRAFT_TRUST_PROXY || 'false').toLowerCase() === 'true';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const RESET_TTL_MS = 30 * 60 * 1000;
const RESET_REQUEST_INTERVAL_MS = 10 * 60 * 1000;
const SMTP_HOST = String(process.env.HOMECRAFT_SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.HOMECRAFT_SMTP_PORT || 587);
const SMTP_USER = String(process.env.HOMECRAFT_SMTP_USER || '').trim();
const SMTP_PASSWORD = String(process.env.HOMECRAFT_SMTP_PASSWORD || '');
const SMTP_FROM = String(process.env.HOMECRAFT_SMTP_FROM || '').trim();
const SMTP_READY = Boolean(SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASSWORD && /^\S+@\S+\.\S+$/.test(SMTP_FROM));
let smtpTransport = null;
const passwordResetMailInFlight = new Set();
function passwordResetUrl(token) {
  const base = new URL(PUBLIC_SITE_URL);
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(base.hostname)) {
    throw new Error('Password reset requires HTTPS');
  }
  // Fragment never reaches HTTP access logs and referrer headers.
  return `${base.origin}/reset-password#token=${encodeURIComponent(token)}`;
}
async function sendAccountEmail(to, subject, text) {
  if (!SMTP_READY) throw new Error('SMTP is not configured');
  if (!smtpTransport) {
    const nodemailer = require('nodemailer');
    smtpTransport = nodemailer.createTransport({
      host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
      requireTLS: SMTP_PORT !== 465,
      auth: { user: SMTP_USER, pass: SMTP_PASSWORD },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000
    });
  }
  return smtpTransport.sendMail({from: SMTP_FROM, to, subject, text});
}

const MC_SESSION_TTL_MS = 1000 * 60 * 20;
const SERVER_HEARTBEAT_TTL_MS = Number(process.env.HOMECRAFT_SERVER_HEARTBEAT_TTL_MS || 90_000);
const MC_PING_ENABLED = String(process.env.HOMECRAFT_MC_PING_ENABLED || 'true').toLowerCase() !== 'false';
const MC_PING_TIMEOUT_MS = Number(process.env.HOMECRAFT_MC_PING_TIMEOUT_MS || 1500);
const MC_PING_CACHE_MS = Number(process.env.HOMECRAFT_MC_PING_CACHE_MS || 5000);
const MC_PING_PROTOCOL = Number(process.env.HOMECRAFT_MC_PROTOCOL || -1);
const MC_TCP_FALLBACK_ENABLED = String(process.env.HOMECRAFT_MC_TCP_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';
let mcPingCache = { at: 0, result: null };
const SERVER_DISPLAY_NAME = process.env.HOMECRAFT_SERVER_NAME || process.env.SERVER_DISPLAY_NAME || 'Home Craft';
const AUTO_WHITELIST = String(process.env.HOMECRAFT_AUTO_WHITELIST || 'true').toLowerCase() !== 'false';
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = Number(process.env.HOMECRAFT_MAX_UPLOAD_BYTES || 1024 * 1024);
const UPLOADS_DIR = path.resolve(ROOT, process.env.HOMECRAFT_UPLOADS_DIR || path.join('data', 'uploads'));
const ASSETS_DB_FILE = path.resolve(ROOT, process.env.HOMECRAFT_ASSETS_DB_FILE || path.join('data', 'assets.json'));
const USER_UPLOADS_DIR = path.join(UPLOADS_DIR, 'users');
const LOG_DIR = path.resolve(ROOT, process.env.HOMECRAFT_LOG_DIR || 'logs');
const LOG_LEVEL = String(process.env.HOMECRAFT_LOG_LEVEL || 'info').toLowerCase();
const RESOURCE_PACKS_DIR = path.resolve(ROOT, process.env.HOMECRAFT_RESOURCE_PACK_DIR || path.join('data', 'server-resource-packs'));
const RESOURCE_PACK_FILE_NAME = String(process.env.HOMECRAFT_RESOURCE_PACK_FILE || 'homecraft-resource-pack.zip').replace(/[^a-zA-Z0-9._-]/g, '') || 'homecraft-resource-pack.zip';
const RESOURCE_PACK_MANIFEST_FILE = path.join(RESOURCE_PACKS_DIR, 'manifest.json');
const RESOURCE_PACK_REQUIRE = String(process.env.HOMECRAFT_RESOURCE_PACK_REQUIRE || 'false').toLowerCase() === 'true';
const RESOURCE_PACK_PROMPT_TEXT = process.env.HOMECRAFT_RESOURCE_PACK_PROMPT || 'Home Craft рекомендує встановити серверний ресурс-пак.';
const TARGET_RESOURCE_PACK_FORMAT = Object.freeze([97, 1]);
let resourcePackValidationCache = { filePath: '', mtimeMs: -1, size: -1, status: null };
let resourcePackHashCache = { filePath: '', mtimeMs: -1, size: -1, sha1: '' };
const MAX_RESOURCE_PACK_BYTES = Number(process.env.HOMECRAFT_MAX_RESOURCE_PACK_BYTES || 128 * 1024 * 1024);
const SERVER_MODS_DIR = path.resolve(ROOT, process.env.HOMECRAFT_SERVER_MODS_DIR || process.env.HOMECRAFT_MODS_DIR || (process.env.HOMECRAFT_MC_DIR ? path.join(process.env.HOMECRAFT_MC_DIR, 'mods') : path.join('..', 'mods')));
function parseEnvList(value) {
  return String(value || '').split(/[;,]/).map(v => v.trim().toLowerCase()).filter(Boolean);
}
const CLIENT_MODS_MODE = String(process.env.HOMECRAFT_CLIENT_MODS_MODE || 'auto').trim().toLowerCase() === 'manual' ? 'manual' : 'auto';
const CLIENT_MODS_INCLUDE = parseEnvList(process.env.HOMECRAFT_CLIENT_MODS_INCLUDE || 'homecraftauth,homecraft-auth,homecraftguild,homecraft-guild,homecraftspawnprotection,homecraft-spawn-protection,spawnprotection,spawn-protection');
const CLIENT_MODS_EXCLUDE = parseEnvList(process.env.HOMECRAFT_CLIENT_MODS_EXCLUDE || 'homecraftmap,homecraft-map,server-only,dedicated-server');
const CLIENT_MODS_PROJECT_PREFIXES = parseEnvList(process.env.HOMECRAFT_CLIENT_MODS_PROJECT_PREFIXES || 'homecraft,home-craft');
// Strict download allowlist: only Home Craft JARs that we build and that must exist on the client.
// Keep this list exact so dependencies, libraries and server-only bridge mods never appear on /download.
const CLIENT_MODS_REQUIRED_IDS = parseEnvList(process.env.HOMECRAFT_CLIENT_MODS_REQUIRED_IDS || 'homecraftauth,homecraftguild,homecraftspawnprotection');
const CLIENT_MODS_REQUIRE_CLIENT_SIDE = String(process.env.HOMECRAFT_CLIENT_MODS_REQUIRE_CLIENT_SIDE || 'true').toLowerCase() !== 'false';
const CLIENT_MODS_CACHE_MS = Number(process.env.HOMECRAFT_CLIENT_MODS_CACHE_MS || 5000);
let clientModsCache = { at: 0, result: null };
const ADMIN_EMAILS = new Set(String(process.env.HOMECRAFT_ADMIN_EMAILS || process.env.HOMECRAFT_ADMIN_EMAIL || '').split(/[;,]/).map(v => v.trim().toLowerCase()).filter(Boolean));
const ADMIN_LOGINS = new Set(String(process.env.HOMECRAFT_ADMIN_LOGINS || process.env.HOMECRAFT_ADMIN_LOGIN || '').split(/[;,]/).map(v => normalizeLogin(v)).filter(Boolean));

const MAP_STATE_FILE = path.resolve(ROOT, process.env.HOMECRAFT_MAP_STATE_FILE || path.join('data', 'map-state.json'));
const GUILD_TERRITORIES_FILE = path.resolve(ROOT, process.env.HOMECRAFT_GUILD_TERRITORIES_FILE || path.join('data', 'guild-territories.json'));
const GUILD_TALENTS_FILE = path.resolve(ROOT, process.env.HOMECRAFT_GUILD_TALENTS_FILE || path.join('data', 'guild-talents.json'));
const MAP_HEARTBEAT_TTL_MS = Number(process.env.HOMECRAFT_MAP_HEARTBEAT_TTL_MS || 25_000);
const MAP_DEFAULT_SPAWN_RADIUS = Number(process.env.HOMECRAFT_MAP_SPAWN_RADIUS || process.env.HOMECRAFT_SPAWN_SAFE_RADIUS || 96);
const MAP_DEFAULT_SPAWN_X = Number(process.env.HOMECRAFT_MAP_SPAWN_X || process.env.HOMECRAFT_SPAWN_X || 3656);
const MAP_DEFAULT_SPAWN_Y = Number(process.env.HOMECRAFT_MAP_SPAWN_Y || process.env.HOMECRAFT_SPAWN_Y || 63);
const MAP_DEFAULT_SPAWN_Z = Number(process.env.HOMECRAFT_MAP_SPAWN_Z || process.env.HOMECRAFT_SPAWN_Z || 3852);
const MAP_DEFAULT_SPAWN_DIMENSION = process.env.HOMECRAFT_MAP_SPAWN_DIMENSION || process.env.HOMECRAFT_SPAWN_DIMENSION || 'minecraft:overworld';
const MAP_PUBLIC_MAX_TILES = Math.max(64, Math.min(2400, Number(process.env.HOMECRAFT_MAP_PUBLIC_MAX_TILES || 1200)));
const MAP_PUBLIC_DELTA_MAX_TILES = Math.max(32, Math.min(MAP_PUBLIC_MAX_TILES, Number(process.env.HOMECRAFT_MAP_PUBLIC_DELTA_MAX_TILES || 256)));

const rateMap = new Map();

function detectLanIp() {
  try {
    const nets = os.networkInterfaces();
    const candidates = [];
    for (const list of Object.values(nets)) {
      for (const net of list || []) {
        if (net.family !== 'IPv4' || net.internal) continue;
        if (net.address.startsWith('169.254.')) continue;
        candidates.push(net.address);
      }
    }
    return candidates.find(ip => ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) || candidates[0] || 'localhost';
  } catch {
    return 'localhost';
  }
}

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

let lastLogCleanupDay = '';
function appendBoundedLog(file, text) {
  const limit = 2 * 1024 * 1024;
  if (fs.existsSync(file) && fs.statSync(file).size + Buffer.byteLength(text) + 1 > limit) {
    const previous = file + '.1';
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
    fs.renameSync(file, previous);
  }
  fs.appendFileSync(file, text + '\n', 'utf8');
}
function cleanupOldLogs(day) {
  if (lastLogCleanupDay === day) return;
  lastLogCleanupDay = day;
  const cutoff = Date.now() - 7 * 86400000;
  for (const name of fs.readdirSync(LOG_DIR)) {
    const match = name.match(/^site-(\d{4}-\d{2}-\d{2})\.log(?:\.1)?$/);
    if (match && Date.parse(match[1] + 'T00:00:00Z') < cutoff) fs.unlinkSync(path.join(LOG_DIR, name));
  }
}

function logLine(level, message, meta = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const current = levels[LOG_LEVEL] || 20;
  const value = levels[level] || 20;
  if (value < current) return;
  const safeMeta = { ...meta };
  for (const key of ['password', 'password2', 'token', 'sessionToken', 'serverSecret', 'authorization', 'cookie']) {
    if (safeMeta[key] !== undefined) safeMeta[key] = '[redacted]';
  }
  const entry = {
    at: new Date().toISOString(),
    level,
    message,
    ...safeMeta
  };
  const text = JSON.stringify(entry);
  const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN]' : level === 'debug' ? '[DEBUG]' : '[INFO]';
  if (level === 'error') console.error(prefix, message, safeMeta);
  else if (level === 'warn') console.warn(prefix, message, safeMeta);
  else console.log(prefix, message, safeMeta);
  try {
    ensureLogDir();
    const day = new Date().toISOString().slice(0, 10);
    cleanupOldLogs(day);
    appendBoundedLog(path.join(LOG_DIR, `site-${day}.log`), text);
    appendBoundedLog(path.join(LOG_DIR, 'site.log'), text);
  } catch (error) {
    console.warn('[Home Craft] Failed to write log:', error.message);
  }
}

function requestId() {
  return crypto.randomBytes(6).toString('hex');
}

function clientIp(req) {
  // Do not trust an arbitrary X-Forwarded-For sent by a direct internet client.
  // Only enable behind a trusted reverse proxy which OVERWRITES that header.
  const direct = String(req.socket.remoteAddress || 'unknown');
  if (!TRUST_PROXY) return direct;
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return net.isIP(forwarded) ? forwarded : direct;
}

function describeBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return { bytes: 0, firstBytesHex: '' };
  return { bytes: buffer.length, firstBytesHex: buffer.slice(0, 16).toString('hex') };
}

function readRecentLogLines(limit = 200) {
  try {
    const file = path.join(LOG_DIR, 'site.log');
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    return text.trim().split(/\n/).slice(-Math.max(1, Math.min(1000, Number(limit) || 200))).map(line => {
      try { return JSON.parse(line); } catch { return { raw: line }; }
    });
  } catch (error) {
    return [{ level: 'error', message: 'Failed to read logs', error: error.message }];
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function normalizeUploadedPngBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) return buffer;
  let data = buffer;
  const start = data.indexOf(PNG_SIGNATURE);
  if (start > 0) data = data.slice(start);
  if (start < 0) return data;
  const marker = Buffer.from([0x49, 0x45, 0x4e, 0x44]); // IEND
  const iend = data.indexOf(marker, 8);
  if (iend > -1 && data.length >= iend + 8) data = data.slice(0, iend + 8);
  return data;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.zip': 'application/zip'
};


function getMinecraftHost() {
  return process.env.HOMECRAFT_MC_HOST || process.env.MINECRAFT_HOST || `${detectLanIp()}:25565`;
}

function parseMinecraftHost(input) {
  let raw = String(input || '').trim();
  if (!raw) raw = `${detectLanIp()}:25565`;
  raw = raw.replace(/^minecraft:\/\//i, '');
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return { host: u.hostname || '127.0.0.1', port: Number(u.port || 25565) || 25565, display: `${u.hostname}:${Number(u.port || 25565) || 25565}` };
    } catch {}
  }
  let host = raw;
  let port = 25565;
  const bracket = raw.match(/^\[([^\]]+)](?::(\d+))?$/);
  if (bracket) {
    host = bracket[1];
    port = Number(bracket[2] || 25565) || 25565;
  } else {
    const idx = raw.lastIndexOf(':');
    if (idx > -1 && raw.indexOf(':') === idx) {
      const maybePort = Number(raw.slice(idx + 1));
      if (Number.isFinite(maybePort) && maybePort > 0) {
        host = raw.slice(0, idx);
        port = maybePort;
      }
    }
  }
  if (!host || host === '0.0.0.0') host = '127.0.0.1';
  return { host, port, display: `${host}:${port}` };
}

function writeVarInt(value) {
  let v = value >>> 0;
  const out = [];
  do {
    let temp = v & 0x7F;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    out.push(temp);
  } while (v !== 0);
  return Buffer.from(out);
}

function readVarInt(buffer, offset = 0) {
  let numRead = 0;
  let result = 0;
  let read;
  do {
    if (offset + numRead >= buffer.length) return null;
    read = buffer[offset + numRead];
    const value = read & 0x7F;
    result |= value << (7 * numRead);
    numRead++;
    if (numRead > 5) throw new Error('VarInt too big');
  } while ((read & 0x80) !== 0);
  return { value: result, size: numRead };
}

function makeString(value) {
  const b = Buffer.from(String(value), 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

function makePacket(parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function decodeStatusResponse(buffer) {
  const packetLen = readVarInt(buffer, 0);
  if (!packetLen) return null;
  let offset = packetLen.size;
  const packetId = readVarInt(buffer, offset);
  if (!packetId) return null;
  offset += packetId.size;
  const strLen = readVarInt(buffer, offset);
  if (!strLen) return null;
  offset += strLen.size;
  const jsonRaw = buffer.slice(offset, offset + strLen.value).toString('utf8');
  return JSON.parse(jsonRaw);
}

function extractMotdText(value) {
  if (!value) return SERVER_DISPLAY_NAME;
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  if (Array.isArray(value.extra)) return value.extra.map(extractMotdText).join('').trim() || SERVER_DISPLAY_NAME;
  return SERVER_DISPLAY_NAME;
}

function pingMinecraftServer(hostValue = getMinecraftHost()) {
  if (!MC_PING_ENABLED) return Promise.resolve({ online: false, error: 'minecraft-ping-disabled' });
  const now = Date.now();
  if (mcPingCache.result && now - mcPingCache.at < MC_PING_CACHE_MS) return Promise.resolve(mcPingCache.result);
  const target = parseMinecraftHost(hostValue);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let chunks = [];
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const finalResult = { ...result, host: target.display, checkedAt: new Date().toISOString() };
      mcPingCache = { at: Date.now(), result: finalResult };
      resolve(finalResult);
    };
    const timer = setTimeout(() => finish({ online: false, error: 'minecraft-ping-timeout' }), MC_PING_TIMEOUT_MS);
    socket.on('connect', () => {
      try {
        const protocol = Number.isFinite(MC_PING_PROTOCOL) ? MC_PING_PROTOCOL : -1;
        const handshake = makePacket([
          writeVarInt(0),
          writeVarInt(protocol),
          makeString(target.host),
          Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
          writeVarInt(1)
        ]);
        const request = makePacket([writeVarInt(0)]);
        socket.write(Buffer.concat([handshake, request]));
      } catch (error) {
        finish({ online: false, error: error.message });
      }
    });
    socket.on('data', chunk => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      try {
        const packetLen = readVarInt(buffer, 0);
        if (!packetLen) return;
        if (buffer.length < packetLen.size + packetLen.value) return;
        const data = decodeStatusResponse(buffer);
        const players = data?.players || {};
        const version = data?.version || {};
        const sample = Array.isArray(players.sample) ? players.sample.map(p => ({ name: p.name, uuid: p.id })).filter(p => p.name) : [];
        finish({
          online: true,
          playersOnline: Math.max(0, Number(players.online || 0)),
          playersMax: Math.max(1, Number(players.max || 1)),
          version: String(version.name || RUNTIME_LABEL),
          motd: extractMotdText(data?.description),
          players: sample,
          source: 'minecraft-status-ping'
        });
      } catch (error) {
        finish({ online: false, error: error.message });
      }
    });
    socket.on('error', error => finish({ online: false, error: error.code || error.message }));
  });
}

function tcpProbeMinecraftServer(hostValue = getMinecraftHost()) {
  if (!MC_TCP_FALLBACK_ENABLED) return Promise.resolve({ online: false, error: 'tcp-fallback-disabled' });
  const target = parseMinecraftHost(hostValue);
  return new Promise(resolve => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...result, host: target.display, checkedAt: new Date().toISOString(), source: 'minecraft-tcp-probe' });
    };
    const timer = setTimeout(() => finish({ online: false, error: 'minecraft-tcp-timeout' }), MC_PING_TIMEOUT_MS);
    socket.on('connect', () => finish({ online: true, playersOnline: 0, playersMax: 100, version: RUNTIME_LABEL, motd: SERVER_DISPLAY_NAME, players: [] }));
    socket.on('error', error => finish({ online: false, error: error.code || error.message }));
  });
}

async function getLiveServerStatus(db) {
  const heartbeatStatus = publicServerStatus(db.serverStatus);
  if (heartbeatStatus.online) return heartbeatStatus;
  let ping = await pingMinecraftServer(getMinecraftHost()).catch(error => ({ online: false, error: error.message }));
  if (!ping.online) {
    const tcp = await tcpProbeMinecraftServer(getMinecraftHost()).catch(error => ({ online: false, error: error.message }));
    if (!tcp.online) {
      return { ...heartbeatStatus, minecraftPing: ping, tcpProbe: tcp, checkedAt: new Date().toISOString() };
    }
    ping = { ...tcp, minecraftStatusPing: ping };
  }
  const pingPlayers = normalizePlayers(ping.players || []);
  return {
    ...heartbeatStatus,
    online: true,
    stale: false,
    staleReason: null,
    source: ping.source || 'minecraft-status-ping',
    motd: ping.motd || heartbeatStatus.motd,
    version: ping.version || heartbeatStatus.version,
    host: ping.host || heartbeatStatus.host,
    playersOnline: Math.max(0, Number(ping.playersOnline || 0)),
    playersMax: Math.max(1, Number(ping.playersMax || heartbeatStatus.playersMax || 100)),
    authenticatedCount: 0,
    pendingAuthCount: 0,
    players: pingPlayers,
    minecraftPing: ping,
    checkedAt: new Date().toISOString()
  };
}

function defaultServerStatus() {
  return {
    online: false,
    playersOnline: 0,
    playersMax: 100,
    authenticatedCount: 0,
    pendingAuthCount: 0,
    version: RUNTIME_LABEL,
    motd: SERVER_DISPLAY_NAME,
    host: getMinecraftHost(),
    players: [],
    lastUpdatedAt: null,
    lastOnlineAt: null,
    lastOfflineAt: null,
    source: 'site-default'
  };
}

function normalizePlayerName(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_\-А-Яа-яІіЇїЄєҐґ ]/g, '').slice(0, 32);
}

function normalizePlayerEntry(player) {
  if (typeof player === 'string') {
    const name = normalizePlayerName(player);
    return name ? { name, authenticated: null, pending: null } : null;
  }
  if (!player || typeof player !== 'object') return null;
  const name = normalizePlayerName(player.name || player.nick || player.minecraftNick || player.username);
  if (!name) return null;
  return {
    name,
    uuid: String(player.uuid || player.minecraftUuid || '').trim().slice(0, 64) || null,
    authenticated: typeof player.authenticated === 'boolean' ? player.authenticated : null,
    pending: typeof player.pending === 'boolean' ? player.pending : null,
    dimension: String(player.dimension || '').trim().slice(0, 64) || null
  };
}

function normalizePlayers(players) {
  if (!Array.isArray(players)) return [];
  const seen = new Set();
  const out = [];
  for (const item of players) {
    const entry = normalizePlayerEntry(item);
    if (!entry) continue;
    const key = (entry.uuid || entry.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= 200) break;
  }
  return out;
}

function publicServerStatus(raw = {}) {
  const base = { ...defaultServerStatus(), ...raw };
  const updatedAt = base.lastUpdatedAt ? Date.parse(base.lastUpdatedAt) : 0;
  const heartbeatAgeMs = updatedAt ? Date.now() - updatedAt : null;
  const heartbeatBeforeSiteStart = updatedAt > 0 && updatedAt < SITE_STARTED_AT;
  const heartbeatMissing = !updatedAt;
  const heartbeatExpired = updatedAt > 0 && heartbeatAgeMs > SERVER_HEARTBEAT_TTL_MS;
  const stale = heartbeatMissing || heartbeatExpired || heartbeatBeforeSiteStart;
  const online = Boolean(base.online) && !stale;
  const players = online ? normalizePlayers(base.players) : [];
  const rawPlayersOnline = Number(base.playersOnline);
  const playersOnline = online ? Math.max(0, Number.isFinite(rawPlayersOnline) ? rawPlayersOnline : players.length) : 0;
  const authenticatedCount = online ? Math.max(0, Number(base.authenticatedCount ?? players.filter(p => p.authenticated === true).length) || 0) : 0;
  const pendingAuthCount = online ? Math.max(0, Number(base.pendingAuthCount ?? players.filter(p => p.pending === true).length) || 0) : 0;
  return {
    ...base,
    online,
    stale,
    staleReason: online ? null : (heartbeatMissing ? 'no-heartbeat' : heartbeatBeforeSiteStart ? 'site-restarted-waiting-server-heartbeat' : heartbeatExpired ? 'heartbeat-expired' : 'offline-pushed'),
    heartbeatAgeMs,
    heartbeatTtlMs: SERVER_HEARTBEAT_TTL_MS,
    siteStartedAt: new Date(SITE_STARTED_AT).toISOString(),
    playersOnline,
    playersMax: Math.max(1, Number(base.playersMax || 100)),
    authenticatedCount,
    pendingAuthCount,
    players,
    checkedAt: new Date().toISOString()
  };
}


function safeMapNumber(value, fallback = 0, min = -30000000, max = 30000000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n * 100) / 100));
}

function normalizeDimensionId(value, fallback = 'minecraft:overworld') {
  const raw = String(value || fallback).trim().toLowerCase().replace(/[^a-z0-9_:\/.\-]/g, '');
  return raw || fallback;
}

function normalizeMapSpawn(spawn = {}) {
  return {
    x: safeMapNumber(spawn.x, MAP_DEFAULT_SPAWN_X),
    y: safeMapNumber(spawn.y, MAP_DEFAULT_SPAWN_Y, -2048, 4096),
    z: safeMapNumber(spawn.z, MAP_DEFAULT_SPAWN_Z),
    dimension: normalizeDimensionId(spawn.dimension, MAP_DEFAULT_SPAWN_DIMENSION),
    radius: Math.max(0, Math.min(5000, Math.round(Number(spawn.radius ?? MAP_DEFAULT_SPAWN_RADIUS) || MAP_DEFAULT_SPAWN_RADIUS)))
  };
}

function normalizeMapPlayer(player) {
  if (!player || typeof player !== 'object') return null;
  const name = normalizePlayerName(player.name || player.nick || player.minecraftNick || player.username);
  if (!name) return null;
  return {
    name,
    uuid: String(player.uuid || player.minecraftUuid || '').trim().slice(0, 64) || null,
    x: safeMapNumber(player.x, 0),
    y: safeMapNumber(player.y, 64, -2048, 4096),
    z: safeMapNumber(player.z, 0),
    yaw: safeMapNumber(player.yaw, 0, -360, 360),
    dimension: normalizeDimensionId(player.dimension),
    authenticated: typeof player.authenticated === 'boolean' ? player.authenticated : null,
    pending: typeof player.pending === 'boolean' ? player.pending : null,
    updatedAt: player.updatedAt ? String(player.updatedAt).slice(0, 64) : null
  };
}

function normalizeMapPlayers(players) {
  if (!Array.isArray(players)) return [];
  const seen = new Set();
  const out = [];
  for (const item of players) {
    const player = normalizeMapPlayer(item);
    if (!player) continue;
    const key = (player.uuid || player.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(player);
    if (out.length >= 200) break;
  }
  return out;
}


function normalizeMapTile(tile) {
  if (!tile || typeof tile !== 'object') return null;
  const size = Math.max(4, Math.min(64, Math.round(Number(tile.size || 16) || 16)));
  const data = String(tile.data || '').slice(0, size * size);
  const palette = Array.isArray(tile.palette)
    ? tile.palette
        .map(v => String(v || '').trim().toLowerCase())
        .filter(v => /^#[0-9a-f]{6}$/.test(v) || /^minecraft:[a-z0-9_./-]+$/.test(v))
        .slice(0, 62)
    : [];
  if (data.length < size * size || !palette.length) return null;
  return {
    tx: Math.max(-2000000, Math.min(2000000, Math.round(Number(tile.tx ?? tile.x ?? 0) || 0))),
    tz: Math.max(-2000000, Math.min(2000000, Math.round(Number(tile.tz ?? tile.z ?? 0) || 0))),
    size,
    dimension: normalizeDimensionId(tile.dimension),
    palette,
    data,
    updatedAt: tile.updatedAt ? String(tile.updatedAt).slice(0, 64) : new Date().toISOString()
  };
}

function mapTileKey(tile) {
  return `${tile.dimension}:${tile.size}:${tile.tx}:${tile.tz}`;
}

function normalizeMapTiles(tiles) {
  if (!Array.isArray(tiles)) return [];
  const byKey = new Map();
  for (const item of tiles) {
    const tile = normalizeMapTile(item);
    if (!tile) continue;
    byKey.set(mapTileKey(tile), tile);
    if (byKey.size >= MAP_PUBLIC_MAX_TILES) break;
  }
  return Array.from(byKey.values());
}

function mergeMapTiles(previousTiles, incomingTiles, clearTiles = false) {
  const byKey = new Map();
  if (!clearTiles) {
    for (const tile of normalizeMapTiles(previousTiles)) byKey.set(mapTileKey(tile), tile);
  }
  for (const tile of normalizeMapTiles(incomingTiles)) byKey.set(mapTileKey(tile), tile);
  const merged = Array.from(byKey.values());
  merged.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return merged.slice(0, MAP_PUBLIC_MAX_TILES);
}


function normalizeGuildTerritory(raw = {}) {
  const type = String(raw.type || '').toUpperCase() === 'GUILD' ? 'GUILD' : 'PERSONAL';
  const size = Math.max(8, Math.min(512, Math.round(Number(raw.size || (type === 'GUILD' ? 64 : 48)) || 48)));
  const x = Math.round(Number(raw.x || 0) || 0);
  const z = Math.round(Number(raw.z || 0) || 0);
  const half = Math.floor(size / 2);
  return {
    id: String(raw.id || `${type.toLowerCase()}-${x}-${z}`).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64),
    type,
    ownerName: String(raw.ownerName || '').slice(0, 32),
    guildName: String(raw.guildName || '').slice(0, 48),
    dimension: String(raw.dimension || 'minecraft:overworld').slice(0, 64),
    x,
    y: Math.round(Number(raw.y || 64) || 64),
    z,
    size,
    minX: x - half,
    maxX: x + half - 1,
    minZ: z - half,
    maxZ: z + half - 1,
    createdAt: raw.createdAt || null
  };
}

function normalizeGuildTerritoryState(raw = {}) {
  const list = Array.isArray(raw.territories) ? raw.territories : [];
  return {
    schemaVersion: 1,
    source: String(raw.source || 'homecraft-guild-site').slice(0, 64),
    updatedAt: raw.updatedAt || null,
    territories: list.map(normalizeGuildTerritory).filter(t => t.id).slice(0, 512)
  };
}

function readGuildTerritories() {
  ensureDb();
  return normalizeGuildTerritoryState(readJsonFile(GUILD_TERRITORIES_FILE, { schemaVersion: 1, source: 'site-default', updatedAt: null, territories: [] }));
}

function writeGuildTerritories(state) {
  ensureDb();
  writeJsonFile(GUILD_TERRITORIES_FILE, normalizeGuildTerritoryState(state));
}

// The game server is authoritative. This file is not in /public and is only written via server-secret sync.
function normalizeGuildTalentsState(raw = {}) {
  const sourceGuilds = Array.isArray(raw.guilds) ? raw.guilds : (Array.isArray(raw) ? raw : []);
  const guilds = sourceGuilds.slice(0, 512).map(g => {
    if (!g || typeof g !== 'object' || Array.isArray(g)) return null;
    const guildId = String(g.guildId || '').slice(0, 72);
    if (!/^[a-zA-Z0-9_-]{1,72}$/.test(guildId)) return null;
    const ranks = {};
    for (const [id, rank] of Object.entries(g.ranks && typeof g.ranks === 'object' && !Array.isArray(g.ranks) ? g.ranks : {}).slice(0, 48)) {
      if (/^[a-z0-9_]{1,72}$/.test(id) && Number.isInteger(rank) && rank >= 0 && rank <= 3) ranks[id] = rank;
    }
    const memberUuids = [...new Set((Array.isArray(g.memberUuids) ? g.memberUuids : []).slice(0, 200)
      .map(v => String(v || '').toLowerCase()).filter(v => /^[0-9a-f]{8}-[0-9a-f-]{27,36}$/.test(v)))];
    const level = Math.max(1, Math.min(10, Number(g.level) || 1));
    const total = Math.max(0, Math.min(24, Number(g.total) || 0));
    const spent = Math.max(0, Math.min(100, Number(g.spent) || 0));
    // New servers report two authoritative talent pools; retain old fields for compatibility.
    const memberTotal = Math.max(0, Math.min(12, Number(g.memberTotal ?? total / 2) || 0));
    const golemTotal = Math.max(0, Math.min(12, Number(g.golemTotal ?? total / 2) || 0));
    const memberSpent = Math.max(0, Math.min(100, Number(g.memberSpent ?? 0) || 0));
    const golemSpent = Math.max(0, Math.min(100, Number(g.golemSpent ?? 0) || 0));
    return {
      guildId, guildName: String(g.guildName || '').slice(0, 64), level, version: Math.max(1, Math.min(3, Math.trunc(Number(g.version) || 1))),
      revision: Math.max(0, Number(g.revision) || 0), total, spent,
      memberTotal, memberSpent, memberAvailable: Math.max(0, memberTotal-memberSpent),
      golemTotal, golemSpent, golemAvailable: Math.max(0, golemTotal-golemSpent),
      migrationPending: Boolean(g.migrationPending),
      integrityError: Boolean(g.integrityError),
      freeReallocationAvailable: Boolean(g.freeReallocationAvailable),
      lastResetAt: Number.isFinite(Number(g.lastResetAt)) ? Math.max(0, Math.trunc(Number(g.lastResetAt))) : 0,
      ranks, memberUuids
    };
  }).filter(Boolean);
  return { schemaVersion: 1, updatedAt: raw.updatedAt || null, guilds };
}

function readGuildTalents() {
  ensureDb();
  return normalizeGuildTalentsState(readJsonFile(GUILD_TALENTS_FILE, { guilds: [] }));
}

function writeGuildTalents(state) {
  ensureDb();
  writeJsonFile(GUILD_TALENTS_FILE, normalizeGuildTalentsState(state));
}

function memberGuildTalents(user) {
  if (!user?.minecraftUuid || String(user.minecraftVerifiedUuid || '').toLowerCase() !== String(user.minecraftUuid).toLowerCase()) return null;
  const uuid = String(user.minecraftUuid).toLowerCase();
  const guild = readGuildTalents().guilds.find(g => g.memberUuids.includes(uuid));
  if (!guild) return null;
  const { memberUuids, ...safe } = guild;
  return safe;
}

function defaultMapState() {
  return {
    schemaVersion: 2,
    online: false,
    source: 'site-default',
    worldName: 'Світ',
    serverTime: 0,
    spawn: normalizeMapSpawn({ x: MAP_DEFAULT_SPAWN_X, y: MAP_DEFAULT_SPAWN_Y, z: MAP_DEFAULT_SPAWN_Z, dimension: MAP_DEFAULT_SPAWN_DIMENSION, radius: MAP_DEFAULT_SPAWN_RADIUS }),
    players: [],
    tiles: [],
    territories: [],
    lastUpdatedAt: null,
    lastOnlineAt: null,
    lastOfflineAt: null
  };
}

function normalizeMapState(raw = {}) {
  const incoming = raw || {};
  const base = { ...defaultMapState(), ...incoming };
  const schemaVersion = Number(base.schemaVersion || 0) === 2 ? 2 : 2;
  const tiles = Number(incoming.schemaVersion || 0) === 2 ? normalizeMapTiles(base.tiles) : [];
  return {
    ...base,
    schemaVersion,
    online: Boolean(base.online),
    source: String(base.source || 'unknown').slice(0, 64),
    worldName: String(base.worldName || 'Світ').replace(/[^A-Za-z0-9_\- А-Яа-яІіЇїЄєҐґ]/g, '').slice(0, 64) || 'Світ',
    serverTime: Math.max(0, Math.floor(Number(base.serverTime || 0) || 0)),
    spawn: normalizeMapSpawn(base.spawn),
    players: normalizeMapPlayers(base.players),
    tiles,
    territories: normalizeGuildTerritoryState(base).territories,
    lastUpdatedAt: base.lastUpdatedAt || null,
    lastOnlineAt: base.lastOnlineAt || null,
    lastOfflineAt: base.lastOfflineAt || null
  };
}

function readMapState() {
  ensureDb();
  return normalizeMapState(readJsonFile(MAP_STATE_FILE, defaultMapState()));
}

function writeMapState(state) {
  ensureDb();
  writeJsonFile(MAP_STATE_FILE, normalizeMapState(state));
}

function parseMapBoundsParam(value) {
  const parts = String(value || '').split(',').map(v => Number(v));
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) return null;
  const minX = Math.max(-2000000, Math.min(2000000, Math.min(parts[0], parts[2])));
  const minZ = Math.max(-2000000, Math.min(2000000, Math.min(parts[1], parts[3])));
  const maxX = Math.max(-2000000, Math.min(2000000, Math.max(parts[0], parts[2])));
  const maxZ = Math.max(-2000000, Math.min(2000000, Math.max(parts[1], parts[3])));
  if ((maxX - minX) > 12000 || (maxZ - minZ) > 12000) return null;
  return { minX, minZ, maxX, maxZ };
}

function tileIntersectsBounds(tile, bounds) {
  if (!bounds) return true;
  const x0 = tile.tx * tile.size;
  const z0 = tile.tz * tile.size;
  const x1 = x0 + tile.size;
  const z1 = z0 + tile.size;
  return x1 >= bounds.minX && x0 <= bounds.maxX && z1 >= bounds.minZ && z0 <= bounds.maxZ;
}

function mapTileTimestamp(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tileCursorFor(tiles) {
  let cursor = '';
  let cursorTime = 0;
  for (const tile of tiles || []) {
    const stamp = String(tile.updatedAt || '');
    const stampTime = mapTileTimestamp(stamp);
    if (stamp && stampTime >= cursorTime) {
      cursor = stamp;
      cursorTime = stampTime;
    }
  }
  return cursor;
}

function publicMapState(raw = {}, options = {}) {
  const base = normalizeMapState(raw);
  const updatedAt = base.lastUpdatedAt ? Date.parse(base.lastUpdatedAt) : 0;
  const heartbeatAgeMs = updatedAt ? Date.now() - updatedAt : null;
  const stale = !updatedAt || heartbeatAgeMs > MAP_HEARTBEAT_TTL_MS;
  const online = Boolean(base.online) && !stale;
  const players = online ? normalizeMapPlayers(base.players) : [];
  const allTiles = normalizeMapTiles(base.tiles);
  const sinceRaw = String(options.since || '').trim();
  const sinceTime = sinceRaw ? mapTileTimestamp(sinceRaw) : 0;
  const bounds = parseMapBoundsParam(options.bounds);
  const wantsDelta = options.mode === 'delta' && Number.isFinite(sinceTime) && sinceTime > 0;
  const maxTiles = wantsDelta ? MAP_PUBLIC_DELTA_MAX_TILES : MAP_PUBLIC_MAX_TILES;
  let tiles = allTiles;
  if (wantsDelta) {
    tiles = tiles.filter(tile => {
      const tileTime = mapTileTimestamp(tile.updatedAt || '');
      return tileTime > sinceTime && tileIntersectsBounds(tile, bounds);
    });
  }
  tiles = tiles.slice(0, maxTiles);

  return {
    ...base,
    online,
    stale,
    staleReason: online ? null : (!updatedAt ? 'no-map-heartbeat' : 'map-heartbeat-expired'),
    heartbeatAgeMs,
    heartbeatTtlMs: MAP_HEARTBEAT_TTL_MS,
    playerCount: players.length,
    players,
    tiles,
    tileMode: wantsDelta ? 'delta' : 'full',
    tileCount: allTiles.length,
    tileCursor: wantsDelta ? (tileCursorFor(tiles) || sinceRaw) : tileCursorFor(allTiles),
    serverTileCursor: tileCursorFor(allTiles),
    tileLimit: maxTiles,
    territories: readGuildTerritories().territories,
    npcState: worldCatalog.readNpcs(),
    checkedAt: new Date().toISOString()
  };
}

function markServerOfflineOnBoot() {
  try {
    const db = readDb();
    db.serverStatus = {
      ...defaultServerStatus(),
      ...db.serverStatus,
      online: false,
      playersOnline: 0,
      authenticatedCount: 0,
      pendingAuthCount: 0,
      players: [],
      host: getMinecraftHost(),
      lastUpdatedAt: null,
      lastOfflineAt: new Date().toISOString(),
      source: 'site-boot-reset'
    };
    writeDb(db);
  } catch (error) {
    console.warn('[Home Craft] Failed to reset server status on site boot:', error.message);
  }
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return structuredCloneJson(fallback);
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return structuredCloneJson(fallback);
    return JSON.parse(raw);
  } catch (error) {
    console.error(`[DB] Failed to read ${path.basename(filePath)}:`, error.message);
    return structuredCloneJson(fallback);
  }
}

function structuredCloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function writeJsonFile(filePath, data) {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function defaultRuntimeDb() {
  return {
    sessions: [],
    minecraftSessions: [],
    serverStatus: defaultServerStatus(),
    audit: [],
    passwordResets: []
  };
}

function migrateLegacyDbIfNeeded() {
  if (!fs.existsSync(LEGACY_DB_FILE)) return;
  const usersExists = fs.existsSync(USERS_DB_FILE);
  const runtimeExists = fs.existsSync(RUNTIME_DB_FILE);
  if (usersExists && runtimeExists) return;

  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_DB_FILE, 'utf8'));
    if (!usersExists) {
      writeJsonFile(USERS_DB_FILE, Array.isArray(legacy.users) ? legacy.users : []);
    }
    if (!runtimeExists) {
      writeJsonFile(RUNTIME_DB_FILE, {
        sessions: Array.isArray(legacy.sessions) ? legacy.sessions : [],
        minecraftSessions: Array.isArray(legacy.minecraftSessions) ? legacy.minecraftSessions : [],
        serverStatus: { ...defaultServerStatus(), ...(legacy.serverStatus || {}) },
        audit: Array.isArray(legacy.audit) ? legacy.audit : []
      });
    }
    console.log('[Home Craft] Migrated legacy data/db.json into users.json + runtime.json.');
  } catch (error) {
    console.warn('[Home Craft] Legacy db.json migration skipped:', error.message);
  }
}

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  migrateLegacyDbIfNeeded();
  if (!fs.existsSync(USERS_DB_FILE)) writeJsonFile(USERS_DB_FILE, []);
  if (!fs.existsSync(RUNTIME_DB_FILE)) writeJsonFile(RUNTIME_DB_FILE, defaultRuntimeDb());
  if (!fs.existsSync(ASSETS_DB_FILE)) writeJsonFile(ASSETS_DB_FILE, { users: {} });
  if (!fs.existsSync(MAP_STATE_FILE)) writeJsonFile(MAP_STATE_FILE, defaultMapState());
}


function readDb() {
  ensureDb();
  // Account corruption must not look like an empty installation.
  let users = JSON.parse(fs.readFileSync(USERS_DB_FILE, 'utf8'));
  if (!Array.isArray(users)) throw new IdentityError('Некоректна база акаунтів.', 503);
  const identity = characterRegistry.reconcile(users);
  if (!Array.isArray(identity.state.adminIds)) {
    // Pin configured admin aliases to existing account IDs during migration, never to a reusable name.
    identity.state.adminIds = users.filter(u => ADMIN_EMAILS.has(String(u.email || '').toLowerCase())
      || ADMIN_LOGINS.has(String(u.login || '').toLowerCase())).map(u => u.id);
    characterRegistry.save(identity.state);
  }
  const boot = applyAdminBootstrap(users, identity.state.adminIds);
  if (boot.changed || identity.usersChanged) writeJsonFile(USERS_DB_FILE, users);
  const revision = crypto.createHash('sha256').update(fs.readFileSync(USERS_DB_FILE)).digest('hex');
  const runtime = readJsonFile(RUNTIME_DB_FILE, defaultRuntimeDb());
  return {
    users, identities: identity.state, _usersRevision: revision,
    _runtimeRevision: crypto.createHash('sha256').update(fs.readFileSync(RUNTIME_DB_FILE)).digest('hex'),
    sessions: Array.isArray(runtime.sessions) ? runtime.sessions : [],
    minecraftSessions: Array.isArray(runtime.minecraftSessions) ? runtime.minecraftSessions : [],
    audit: Array.isArray(runtime.audit) ? runtime.audit : [],
    passwordResets: Array.isArray(runtime.passwordResets) ? runtime.passwordResets : [],
    serverStatus: { ...defaultServerStatus(), ...(runtime.serverStatus || {}) }
  };
}

function writeDb(db) {
  ensureDb();
  const revision = crypto.createHash('sha256').update(fs.readFileSync(USERS_DB_FILE)).digest('hex');
  const runtimeRevision = crypto.createHash('sha256').update(fs.readFileSync(RUNTIME_DB_FILE)).digest('hex');
  if (db._runtimeRevision !== runtimeRevision || db._usersRevision !== revision) throw new IdentityError('Дані змінилися під час запиту. Повтори дію.', 409);
  writeJsonFile(USERS_DB_FILE, Array.isArray(db.users) ? db.users : []);
  db._usersRevision = crypto.createHash('sha256').update(fs.readFileSync(USERS_DB_FILE)).digest('hex');
  writeJsonFile(RUNTIME_DB_FILE, {
    sessions: Array.isArray(db.sessions) ? db.sessions : [],
    minecraftSessions: Array.isArray(db.minecraftSessions) ? db.minecraftSessions : [],
    serverStatus: { ...defaultServerStatus(), ...(db.serverStatus || {}) },
    audit: Array.isArray(db.audit) ? db.audit : [],
    passwordResets: Array.isArray(db.passwordResets) ? db.passwordResets : []
  });
  db._runtimeRevision = crypto.createHash('sha256').update(fs.readFileSync(RUNTIME_DB_FILE)).digest('hex');
}

function applyAdminBootstrap(users, pinnedAdminIds = []) {
  let changed = false;
  for (const user of users) if (pinnedAdminIds.includes(user.id) && user.role !== 'admin') { user.role = 'admin'; changed = true; }
  return { users, changed };
}

function audit(db, type, payload = {}) {
  db.audit.push({
    id: crypto.randomUUID(),
    type,
    payload,
    at: new Date().toISOString()
  });
  if (db.audit.length > 500) db.audit = db.audit.slice(db.audit.length - 500);
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  res.end(body);
}

function json(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  res.end(JSON.stringify(data));
}

function notFound(res) {
  send(res, 404, 'Not found');
}

function parseCookies(header = '') {
  const out = {};
  for (const pair of header.split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    const val = pair.slice(index + 1).trim();
    if (key) { try { out[key] = decodeURIComponent(val); } catch { /* ignore malformed cookies */ } }
  }
  return out;
}

function sessionCookie(token) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  return `homecraft_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`;
}

function clearSessionCookie() {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  return [`homecraft_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`];
}


function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Тіло запиту завелике'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(buffer, contentType) {
  const match = String(contentType || '').match(/boundary=(?:(?:"([^"]+)")|([^;]+))/i);
  if (!match) throw new Error('Не знайдено межу multipart-запиту');
  const boundaryValue = String(match[1] || match[2] || '').trim();
  const boundary = Buffer.from(`--${boundaryValue}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    cursor += boundary.length;
    if (buffer.slice(cursor, cursor + 2).toString() === '--') break;
    if (buffer.slice(cursor, cursor + 2).toString() === '\r\n') cursor += 2;
    const next = buffer.indexOf(boundary, cursor);
    if (next === -1) break;
    let partEnd = next;
    if (partEnd >= 2 && buffer.slice(partEnd - 2, partEnd).toString() === '\r\n') partEnd -= 2;
    const part = buffer.slice(cursor, partEnd);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd > -1) {
      const headerText = part.slice(0, headerEnd).toString('utf8');
      const data = part.slice(headerEnd + 4);
      const headers = {};
      for (const line of headerText.split(/\r\n/)) {
        const index = line.indexOf(':');
        if (index > -1) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
      }
      const disposition = headers['content-disposition'] || '';
      const name = (disposition.match(/name="([^"]+)"/) || [])[1] || '';
      let filename = (disposition.match(/filename="([^"]*)"/) || [])[1] || '';
      const filenameStar = (disposition.match(/filename\*=UTF-8''([^;]+)/i) || [])[1];
      if (!filename && filenameStar) { try { filename = decodeURIComponent(filenameStar); } catch { filename = filenameStar; } }
      if (name) parts.push({ name, filename, contentType: headers['content-type'] || '', data });
    }
    cursor = next;
  }
  return parts;
}

function isPng(buffer) {
  return Buffer.isBuffer(buffer)
    && buffer.length > 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
}

function readPngSize(buffer) {
  if (!isPng(buffer)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function validMinecraftImageSize(kind, size) {
  if (!size) return false;
  if (kind === 'skin') {
    return (size.width === 64 && size.height === 64)
      || (size.width === 64 && size.height === 32)
      || (size.width === 128 && size.height === 128);
  }
  if (kind === 'cape') {
    return (size.width === 64 && size.height === 32)
      || (size.width === 64 && size.height === 64)
      || (size.width === 128 && size.height === 64);
  }
  return false;
}

function readAssetsDb() {
  return readJsonFile(ASSETS_DB_FILE, { users: {} });
}

function writeAssetsDb(data) {
  writeJsonFile(ASSETS_DB_FILE, data && typeof data === 'object' ? data : { users: {} });
}

function absolutePublicUrl(relativePath) {
  const base = String(PUBLIC_SITE_URL || '').replace(/\/+$/, '');
  const rel = String(relativePath || '').startsWith('/') ? relativePath : `/${relativePath}`;
  return `${base}${rel}`;
}

function absoluteAssetOrExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return absolutePublicUrl(raw);
}

function safeUserAssetId(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'unknown';
}

function saveUserPngAsset(user, kind, buffer, meta = {}) {
  if (!['skin', 'cape'].includes(kind)) throw new Error('Невідомий тип файлу');
  const original = buffer;
  buffer = normalizeUploadedPngBuffer(buffer);
  if (!isPng(buffer)) {
    logLine('warn', 'Upload rejected: not a PNG', {
      userId: user?.id,
      kind,
      filename: meta.filename || '',
      contentType: meta.contentType || '',
      ...describeBuffer(original)
    });
    throw new Error(`${kind === 'skin' ? 'Skin' : 'Cape'} файл має бути справжнім PNG, а не просто мати .png у назві`);
  }
  const size = readPngSize(buffer);
  if (!validMinecraftImageSize(kind, size)) {
    logLine('warn', 'Upload rejected: invalid PNG dimensions', {
      userId: user?.id,
      kind,
      filename: meta.filename || '',
      width: size?.width,
      height: size?.height,
      bytes: buffer.length
    });
    throw new Error(kind === 'skin'
      ? 'Скін має бути PNG 64x64, 64x32 або 128x128'
      : 'Плащ має бути PNG 64x32, 64x64 або 128x64');
  }
  const userId = safeUserAssetId(user.id);
  const dir = path.join(USER_UPLOADS_DIR, userId);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${kind}.png`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, buffer);
  const updatedAt = new Date().toISOString();
  const publicPath = `/uploads/users/${userId}/${fileName}?v=${Date.now()}`;
  const assets = readAssetsDb();
  if (!assets.users || typeof assets.users !== 'object') assets.users = {};
  if (!assets.users[user.id]) assets.users[user.id] = { userId: user.id };
  assets.users[user.id][kind] = {
    kind,
    publicPath,
    width: size.width,
    height: size.height,
    bytes: buffer.length,
    updatedAt
  };
  writeAssetsDb(assets);
  logLine('info', 'PNG asset saved', { userId: user.id, kind, filePath, width: size.width, height: size.height, bytes: buffer.length, filename: meta.filename || '' });
  return { publicPath, url: absolutePublicUrl(publicPath), width: size.width, height: size.height, bytes: buffer.length, updatedAt };
}

function safeUploadPath(urlPath) {
  const route = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/uploads\/?/, '');
  const requested = path.normalize(path.join(UPLOADS_DIR, route));
  if (!requested.startsWith(UPLOADS_DIR)) return null;
  return requested;
}

function serveUpload(req, res, urlPath) {
  const filePath = safeUploadPath(urlPath);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return notFound(res);
  if (path.extname(filePath).toLowerCase() !== '.png') return notFound(res);
  res.writeHead(200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  fs.createReadStream(filePath).pipe(res);
}

function resourcePackFilePath(fileName = RESOURCE_PACK_FILE_NAME) {
  const clean = String(fileName || '').replace(/[^a-zA-Z0-9._-]/g, '') || RESOURCE_PACK_FILE_NAME;
  return path.join(RESOURCE_PACKS_DIR, clean);
}

function isZip(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function fileSha1(filePath) {
  const hash = crypto.createHash('sha1');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex').toLowerCase();
}

function resourcePackCompatibility(filePath, stat) {
  if (resourcePackValidationCache.filePath === filePath &&
      resourcePackValidationCache.mtimeMs === stat.mtimeMs &&
      resourcePackValidationCache.size === stat.size && resourcePackValidationCache.status) {
    return resourcePackValidationCache.status;
  }
  const status = { compatible: false, formatMin: null, formatMax: null, compatibilityError: '' };
  try {
    const archive = readZipEntries(filePath);
    const metaEntry = archive.files && archive.files.get('pack.mcmeta');
    if (!metaEntry || metaEntry.compressedSize > 131072) throw new Error('ZIP pack.mcmeta missing or too large');
    const metadata = JSON.parse(archive.readEntryText('pack.mcmeta'));
    const pack = metadata && metadata.pack;
    const decodeFormat = raw => Number.isInteger(raw) ? [raw, 0] :
      (Array.isArray(raw) && raw.length === 2 && raw.every(Number.isInteger) ? raw : null);
    status.formatMin = decodeFormat(pack && pack.min_format);
    status.formatMax = decodeFormat(pack && pack.max_format);
    const compare = (left, right) => left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
    status.compatible = Boolean(status.formatMin && status.formatMax &&
      compare(status.formatMin, TARGET_RESOURCE_PACK_FORMAT) <= 0 &&
      compare(status.formatMax, TARGET_RESOURCE_PACK_FORMAT) >= 0);
    if (!status.compatible) status.compatibilityError = 'Resource pack не підтримує Minecraft 26.3 (формат 97.1). Оновіть pack.mcmeta та активи пакета.';
  } catch (error) {
    status.compatibilityError = `Не вдалося прочитати ресурс-пак: ${error.message}`;
  }
  resourcePackValidationCache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, status };
  if (!status.compatible) logLine('warn', 'Resource pack incompatible with Minecraft 26.3', { filePath, reason: status.compatibilityError });
  return status;
}

function resourcePackSha1Cached(filePath, stat) {
  if (resourcePackHashCache.filePath === filePath && resourcePackHashCache.mtimeMs === stat.mtimeMs &&
      resourcePackHashCache.size === stat.size) return resourcePackHashCache.sha1;
  const sha1 = fileSha1(filePath);
  resourcePackHashCache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, sha1 };
  return sha1;
}

function readResourcePackManifest() {
  const fallback = {
    enabled: false,
    fileName: RESOURCE_PACK_FILE_NAME,
    displayName: 'Home Craft Resource Pack',
    description: '',
    sha1: '',
    id: '',
    sizeBytes: 0,
    updatedAt: null,
    require: RESOURCE_PACK_REQUIRE,
    prompt: { text: RESOURCE_PACK_PROMPT_TEXT, color: 'gold' }
  };
  try {
    if (!fs.existsSync(RESOURCE_PACK_MANIFEST_FILE)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(RESOURCE_PACK_MANIFEST_FILE, 'utf8'));
    return { ...fallback, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (error) {
    logLine('warn', 'Failed to read resource pack manifest', { error: error.message });
    return fallback;
  }
}

function writeResourcePackManifest(manifest) {
  fs.mkdirSync(RESOURCE_PACKS_DIR, { recursive: true });
  writeJsonFile(RESOURCE_PACK_MANIFEST_FILE, manifest);
}

function ensureResourcePackManifest() {
  fs.mkdirSync(RESOURCE_PACKS_DIR, { recursive: true });
  const manifest = readResourcePackManifest();
  const fileName = String(manifest.fileName || RESOURCE_PACK_FILE_NAME).replace(/[^a-zA-Z0-9._-]/g, '') || RESOURCE_PACK_FILE_NAME;
  const filePath = resourcePackFilePath(fileName);
  if (!fs.existsSync(filePath)) {
    return { ...manifest, enabled: false, fileName, available: false, url: '', publicPath: '', serverProperties: null };
  }
  const stat = fs.statSync(filePath);
  const compatibility = resourcePackCompatibility(filePath, stat);
  const sha1 = resourcePackSha1Cached(filePath, stat);
  let changed = false;
  if (manifest.sha1 !== sha1) { manifest.sha1 = sha1; changed = true; }
  if (!manifest.id) { manifest.id = crypto.randomUUID(); changed = true; }
  if (manifest.sizeBytes !== stat.size) { manifest.sizeBytes = stat.size; changed = true; }
  if (!manifest.updatedAt) { manifest.updatedAt = new Date(stat.mtimeMs || Date.now()).toISOString(); changed = true; }
  if (typeof manifest.require !== 'boolean') { manifest.require = RESOURCE_PACK_REQUIRE; changed = true; }
  if (!manifest.prompt) { manifest.prompt = { text: RESOURCE_PACK_PROMPT_TEXT, color: 'gold' }; changed = true; }
  manifest.enabled = manifest.enabled !== false;
  manifest.fileName = fileName;
  manifest.available = true;
  if (changed) writeResourcePackManifest(manifest);
  const publicPath = `/server-resource-packs/${encodeURIComponent(fileName)}`;
  const url = absolutePublicUrl(publicPath);
  return {
    ...manifest,
    available: true,
    enabled: Boolean(manifest.enabled && compatibility.compatible),
    compatible: compatibility.compatible,
    compatibilityError: compatibility.compatibilityError,
    formatMin: compatibility.formatMin,
    formatMax: compatibility.formatMax,
    publicPath,
    url,
    serverProperties: compatibility.compatible && manifest.enabled ? {
      'resource-pack': url,
      'resource-pack-sha1': sha1,
      'resource-pack-id': manifest.id,
      'require-resource-pack': String(Boolean(manifest.require)),
      'resource-pack-prompt': typeof manifest.prompt === 'string' ? manifest.prompt : JSON.stringify(manifest.prompt || { text: RESOURCE_PACK_PROMPT_TEXT })
    } : null
  };
}

function saveResourcePackZip(buffer, meta = {}) {
  if (!isZip(buffer)) throw new Error('Resource pack має бути ZIP-файлом');
  fs.mkdirSync(RESOURCE_PACKS_DIR, { recursive: true });
  const fileName = RESOURCE_PACK_FILE_NAME;
  const filePath = resourcePackFilePath(fileName);
  const temporaryPath = path.join(RESOURCE_PACKS_DIR, `.upload-${crypto.randomBytes(8).toString('hex')}.zip`);
  try {
    fs.writeFileSync(temporaryPath, buffer, { flag: 'wx' });
    const compatibility = resourcePackCompatibility(temporaryPath, fs.statSync(temporaryPath));
    if (!compatibility.compatible) throw new Error(compatibility.compatibilityError);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch {}
  }
  fs.writeFileSync(filePath, buffer);
  resourcePackValidationCache = { filePath: '', mtimeMs: -1, size: -1, status: null };
  resourcePackHashCache = { filePath: '', mtimeMs: -1, size: -1, sha1: '' };
  const sha1 = fileSha1(filePath);
  const manifest = {
    enabled: true,
    fileName,
    displayName: String(meta.displayName || 'Home Craft Resource Pack').slice(0, 96),
    description: String(meta.description || '').slice(0, 240),
    sha1,
    id: crypto.randomUUID(),
    sizeBytes: buffer.length,
    updatedAt: new Date().toISOString(),
    originalFileName: String(meta.filename || '').slice(0, 180),
    require: typeof meta.require === 'boolean' ? meta.require : RESOURCE_PACK_REQUIRE,
    prompt: meta.prompt || { text: RESOURCE_PACK_PROMPT_TEXT, color: 'gold' }
  };
  writeResourcePackManifest(manifest);
  logLine('info', 'Resource pack saved', { filePath, sha1, sizeBytes: buffer.length, filename: meta.filename || '' });
  return ensureResourcePackManifest();
}

function safeResourcePackPath(urlPath) {
  const route = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/server-resource-packs\/?/, '');
  const clean = path.basename(route || RESOURCE_PACK_FILE_NAME).replace(/[^a-zA-Z0-9._-]/g, '');
  const requested = path.normalize(path.join(RESOURCE_PACKS_DIR, clean));
  if (!requested.startsWith(RESOURCE_PACKS_DIR)) return null;
  return requested;
}

function serveResourcePack(req, res, urlPath) {
  const filePath = safeResourcePackPath(urlPath);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return notFound(res);
  if (path.extname(filePath).toLowerCase() !== '.zip') return notFound(res);
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
    'Cache-Control': 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  fs.createReadStream(filePath).pipe(res);
}

function hasClientModPattern(fileName) {
  const lower = String(fileName || '').toLowerCase();
  return CLIENT_MODS_INCLUDE.some(pattern => pattern && lower.includes(pattern));
}

function hasExcludedClientModPattern(fileName) {
  const lower = String(fileName || '').toLowerCase();
  return CLIENT_MODS_EXCLUDE.some(pattern => pattern && lower.includes(pattern));
}

function isJarOrZipFile(fileName) {
  return /\.(jar|zip)$/i.test(String(fileName || ''));
}

function readZipEntries(filePath) {
  const buf = fs.readFileSync(filePath);
  const minEocd = 22;
  if (buf.length < minEocd) return { entries: [], files: new Map() };
  const searchStart = Math.max(0, buf.length - 0x10000 - minEocd);
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= searchStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { entries: [], files: new Map() };
  const total = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = [];
  const files = new Map();
  for (let i = 0; i < total && pos + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const fileNameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + fileNameLength).toString('utf8');
    const entry = { name, method, compressedSize, localHeaderOffset };
    entries.push(entry);
    files.set(name, entry);
    pos += 46 + fileNameLength + extraLength + commentLength;
  }
  function readEntryText(name) {
    const entry = files.get(name);
    if (!entry || entry.localHeaderOffset + 30 > buf.length) return '';
    const lp = entry.localHeaderOffset;
    if (buf.readUInt32LE(lp) !== 0x04034b50) return '';
    const fileNameLength = buf.readUInt16LE(lp + 26);
    const extraLength = buf.readUInt16LE(lp + 28);
    const dataStart = lp + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataStart < 0 || dataEnd > buf.length || dataEnd < dataStart) return '';
    const raw = buf.slice(dataStart, dataEnd);
    try {
      if (entry.method === 0) return raw.toString('utf8');
      if (entry.method === 8) return zlib.inflateRawSync(raw).toString('utf8');
    } catch (error) {
      logLine('debug', 'Failed to read ZIP entry', { filePath, name, error: error.message });
    }
    return '';
  }
  return { entries, files, readEntryText };
}

function readClientModMetadata(filePath) {
  let zip = { entries: [], readEntryText: () => '' };
  try { zip = readZipEntries(filePath); } catch (error) {
    return { entries: [], toml: '', error: error.message || 'JAR read failed' };
  }
  const entryNames = zip.entries.map(entry => entry.name);
  const tomlName = entryNames.find(name => /(^|\/)META-INF\/(neoforge\.mods\.toml|mods\.toml)$/i.test(name));
  const toml = tomlName ? zip.readEntryText(tomlName) : '';
  const value = key => {
    const re = new RegExp('^\\s*' + key + '\\s*=\\s*"([^"]*)"', 'mi');
    const match = toml.match(re);
    return match ? match[1] : '';
  };
  const dependencies = {};
  for (const table of toml.split(/(?=^\s*\[\[)/m)) {
    if (!/^\s*\[\[dependencies\.[^\]]+\]\]/.test(table)) continue;
    const id = table.match(/^\s*modId\s*=\s*"([^"]+)"/m)?.[1];
    const range = table.match(/^\s*versionRange\s*=\s*"([^"]+)"/m)?.[1];
    if (id && range) dependencies[id] = range;
  }
  const sideMatches = [...toml.matchAll(/^\s*side\s*=\s*"([^"]+)"/gmi)].map(m => String(m[1] || '').toUpperCase());
  const hasClientCode = entryNames.some(name => /(^|\/)client(\/|$)|(^|\/)renderer(\/|$)|Client[^/]*\.class$|Renderer[^/]*\.class$/i.test(name));
  const hasClientVisualAssets = entryNames.some(name => /^assets\/[^/]+\/(models|textures|blockstates|particles|atlases|sounds)\//i.test(name));
  const hasLanguageAssets = entryNames.some(name => /^assets\/[^/]+\/lang\//i.test(name));
  // Reject outdated Guild JARs that contain NPC/guild code but not Hearthstones.
  // Do not offer them to the launcher or download page: they silently lose icons/models.
  const guildModelAssets = [
    'items/hearthstone.json', 'items/guild_hearthstone.json',
    'models/item/hearthstone.json', 'models/item/guild_hearthstone.json',
    'models/item/hearthstone_hand.json', 'models/item/hearthstone_hand_active.json',
    'models/item/guild_hearthstone_hand.json', 'models/item/guild_hearthstone_hand_active.json',
    'textures/item/hearthstone.png', 'textures/item/guild_hearthstone.png'
  ];
  const hasEmbeddedHearthstones = [
    'ua/homecraft/guild/item/HomeCraftGuildItems.class',
    'ua/homecraft/guild/item/HearthstoneItem.class',
    'ua/homecraft/guild/server/GuildHearthstoneService.class',
    ...guildModelAssets.map(asset => 'assets/homecraftguild/' + asset)
  ].every(name => zip.files.has(name));
  return {
    minecraftRange: dependencies.minecraft || '',
    neoForgeRange: dependencies.neoforge || '',
    modId: value('modId'),
    displayName: value('displayName'),
    version: value('version'),
    description: value('description'),
    sides: [...new Set(sideMatches)],
    hasClientCode,
    hasClientVisualAssets,
    hasLanguageAssets,
    hasEmbeddedHearthstones,
    hasToml: Boolean(toml)
  };
}

// Minecraft release IDs are numeric. Fail closed for unknown formats or missing ranges.
function supportsMinecraftRange(range, version) {
  const numeric = value => /^\d+(?:\.\d+)*$/.test(value);
  const compare = (a, b) => {
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const delta = (left[i] || 0) - (right[i] || 0);
      if (delta) return Math.sign(delta);
    }
    return 0;
  };
  const text = String(range || '').trim();
  if (!numeric(version)) return false;
  const exact = text.match(/^\[(\d+(?:\.\d+)*)\]$/);
  if (exact) return compare(version, exact[1]) === 0;
  const interval = text.match(/^(\[|\()([^,]*),([^\]\)]*)(\]|\))$/);
  if (!interval) return false;
  const [, lowEdge, low, high, highEdge] = interval;
  if ((!low && !high) || (low && !numeric(low)) || (high && !numeric(high))) return false;
  return (!low || (lowEdge === '[' ? compare(version, low) >= 0 : compare(version, low) > 0))
    && (!high || (highEdge === ']' ? compare(version, high) <= 0 : compare(version, high) < 0));
}

function normalizeModToken(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function matchesModTokenList(tokenList, meta, fileName) {
  const lowerName = String(fileName || '').toLowerCase();
  const normalizedName = normalizeModToken(lowerName.replace(/\.(jar|zip)$/i, ''));
  const modId = String(meta?.modId || '').toLowerCase();
  const normalizedModId = normalizeModToken(modId);
  const displayName = String(meta?.displayName || '').toLowerCase();
  return tokenList.some(raw => {
    const token = String(raw || '').toLowerCase();
    const normalized = normalizeModToken(token);
    if (!normalized) return false;
    return modId === token
      || normalizedModId === normalized
      || normalizedName.startsWith(normalized)
      || lowerName.startsWith(token)
      || displayName.includes(token.replace(/-/g, ' '));
  });
}

function isHomeCraftOwnedClientMod(meta, fileName) {
  return matchesModTokenList(CLIENT_MODS_PROJECT_PREFIXES, meta, fileName);
}

function isRequiredHomeCraftClientBuild(meta, fileName) {
  if (!CLIENT_MODS_REQUIRED_IDS.length) return isHomeCraftOwnedClientMod(meta, fileName);
  return matchesModTokenList(CLIENT_MODS_REQUIRED_IDS, meta, fileName);
}

function classifyClientModFile(filePath, fileName) {
  const base = {
    allowed: false,
    reason: 'not-client-mod',
    reasonLabel: 'не клієнтський адон',
    clientRequirement: 'server-only',
    side: 'UNKNOWN',
    modId: '',
    displayName: fileName.replace(/\.(jar|zip)$/i, ''),
    version: '',
    hasClientCode: false,
    hasClientVisualAssets: false
  };

  if (!isJarOrZipFile(fileName)) return { ...base, reason: 'bad-extension', reasonLabel: 'не JAR/ZIP' };
  if (hasExcludedClientModPattern(fileName)) return { ...base, reason: 'excluded-by-config', reasonLabel: 'виключено в конфігу' };
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return { ...base, reason: 'missing-file', reasonLabel: 'файл не знайдено' };

  const meta = readClientModMetadata(filePath);
  const sides = Array.isArray(meta.sides) ? meta.sides : [];
  const side = sides.includes('CLIENT') ? 'CLIENT' : sides.includes('BOTH') ? 'BOTH' : sides.includes('SERVER') ? 'SERVER' : 'UNKNOWN';
  const hasManualInclude = hasClientModPattern(fileName) || (meta.modId && CLIENT_MODS_INCLUDE.includes(String(meta.modId).toLowerCase()));
  // Do not treat side=BOTH alone as enough. A dependency can be BOTH while the mod has no client code.
  // The download page must only show JARs that have a real client reason: GUI, client events, renderers or visual assets.
  const hasClientSide = sides.includes('CLIENT') || meta.hasClientCode || meta.hasClientVisualAssets;
  const serverOnly = sides.length > 0 && sides.every(v => v === 'SERVER') && !meta.hasClientCode && !meta.hasClientVisualAssets;

  const ownedHomeCraftMod = isHomeCraftOwnedClientMod(meta, fileName);
  const requiredHomeCraftBuild = isRequiredHomeCraftClientBuild(meta, fileName);
  const enriched = {
    ...base,
    side,
    modId: meta.modId || '',
    displayName: meta.displayName || base.displayName,
    version: meta.version || '',
    minecraftRange: meta.minecraftRange || '',
    neoForgeRange: meta.neoForgeRange || '',
    hasClientCode: Boolean(meta.hasClientCode),
    hasClientVisualAssets: Boolean(meta.hasClientVisualAssets),
    hasLanguageAssets: Boolean(meta.hasLanguageAssets),
    hasEmbeddedHearthstones: Boolean(meta.hasEmbeddedHearthstones),
    ownedHomeCraftMod,
    requiredHomeCraftBuild,
    hasClientSide: Boolean(hasClientSide),
    serverOnly: Boolean(serverOnly)
  };

  if (!ownedHomeCraftMod) {
    return { ...enriched, reason: 'external-mod', reasonLabel: 'не наш Home Craft адон', clientRequirement: 'external-or-dependency' };
  }

  if (!requiredHomeCraftBuild) {
    return { ...enriched, reason: 'not-our-built-client-addon', reasonLabel: 'не входить у наш список збірки', clientRequirement: 'not-required-client-mod' };
  }

  if (meta.modId === 'homecraftguild') {
    // v0.1.187 is the first release with verified compiled-client deployment to website/client-mods.
    // Reject older otherwise apparently valid JARs to prevent silent downgrades.
    const versionParts = String(meta.version || '').match(/^(\d+)\.(\d+)\.(\d+)(?:[-+.]|$)/);
    const versionCode = versionParts
      ? (Number(versionParts[1]) * 100000000 + Number(versionParts[2]) * 100000 + Number(versionParts[3]))
      : 0;
    if (versionCode < 100187) {
      return { ...enriched, reason: 'legacy-hearthstone-build',
        reasonLabel: 'старий Guild JAR: потрібен 0.1.187+ із ресурсами для клієнта та синхронізацією з сайтом',
        clientRequirement: 'outdated-build' };
    }
  }
  if (meta.modId === 'homecraftguild' && !meta.hasEmbeddedHearthstones) {
    return { ...enriched, reason: 'missing-hearthstone-assets',
      reasonLabel: 'застарілий Guild JAR: немає класів, іконок або 3D-моделей Hearthstone',
      clientRequirement: 'outdated-build' };
  }

  if (!supportsMinecraftRange(meta.minecraftRange, MINECRAFT_RUNTIME.minecraft)) {
    return { ...enriched, reason: 'incompatible-minecraft', reasonLabel: 'потрібна збірка для Minecraft ' + MINECRAFT_RUNTIME.minecraft };
  }

  if (serverOnly) {
    return { ...enriched, reason: 'server-only-metadata', reasonLabel: 'server-only metadata / тільки сервер', clientRequirement: 'server-only' };
  }

  if (CLIENT_MODS_REQUIRE_CLIENT_SIDE && !hasClientSide) {
    return { ...enriched, reason: 'no-client-side-detected', reasonLabel: 'немає client/render/assets', clientRequirement: 'server-or-unknown' };
  }

  if (CLIENT_MODS_MODE === 'manual' && !hasManualInclude) {
    return { ...enriched, reason: 'not-in-manual-include', reasonLabel: 'немає в allowlist' };
  }

  const reason = hasManualInclude ? 'required-build-client-side' : 'auto-required-build-client-side';
  const reasonLabel = meta.hasClientCode
    ? 'client-код'
    : meta.hasClientVisualAssets
      ? 'client assets / клієнтські assets'
      : sides.includes('CLIENT')
        ? 'side=CLIENT'
        : 'клієнтська частина';
  return { ...enriched, allowed: true, reason, reasonLabel, clientRequirement: 'required-client-mod' };
}

function isAllowedClientModFile(filePath, fileName) {
  return classifyClientModFile(filePath, fileName).allowed;
}

function clientModPublicPath(fileName) {
  return `/client-mods/${encodeURIComponent(fileName)}`;
}

function listClientMods() {
  const now = Date.now();
  if (clientModsCache.result && now - clientModsCache.at < CLIENT_MODS_CACHE_MS) return clientModsCache.result;
  const result = {
    runtime: MINECRAFT_RUNTIME,
    modsDir: SERVER_MODS_DIR,
    mode: CLIENT_MODS_MODE,
    include: CLIENT_MODS_INCLUDE,
    exclude: CLIENT_MODS_EXCLUDE,
    requiredIds: CLIENT_MODS_REQUIRED_IDS,
    requireClientSide: CLIENT_MODS_REQUIRE_CLIENT_SIDE,
    updatedAt: new Date().toISOString(),
    files: [],
    skipped: []
  };
  try {
    if (!fs.existsSync(SERVER_MODS_DIR) || !fs.statSync(SERVER_MODS_DIR).isDirectory()) {
      result.available = false;
      result.error = 'Папку mods не знайдено';
    } else {
      result.available = true;
      const files = [];
      const skipped = [];
      for (const fileName of fs.readdirSync(SERVER_MODS_DIR)) {
        if (!isJarOrZipFile(fileName)) continue;
        const filePath = path.join(SERVER_MODS_DIR, fileName);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) continue;
        const info = classifyClientModFile(filePath, fileName);
        const item = {
          fileName,
          displayName: info.displayName || fileName.replace(/\.(jar|zip)$/i, ''),
          modId: info.modId || '',
          version: info.version || '',
          minecraftRange: info.minecraftRange || '',
          neoForgeRange: info.neoForgeRange || '',
          side: info.side || 'UNKNOWN',
          reason: info.reason,
          reasonLabel: info.reasonLabel,
          clientRequirement: info.clientRequirement,
          ownedHomeCraftMod: Boolean(info.ownedHomeCraftMod),
          requiredHomeCraftBuild: Boolean(info.requiredHomeCraftBuild),
          hasClientSide: Boolean(info.hasClientSide),
          serverOnly: Boolean(info.serverOnly),
          hasClientCode: Boolean(info.hasClientCode),
          hasClientVisualAssets: Boolean(info.hasClientVisualAssets),
          sizeBytes: stat.size,
          updatedAt: new Date(stat.mtimeMs || Date.now()).toISOString()
        };
        if (info.allowed) {
          files.push({ ...item, publicPath: clientModPublicPath(fileName), url: absolutePublicUrl(clientModPublicPath(fileName)) });
        } else {
          skipped.push(item);
        }
      }
      const counts = new Map();
      for (const file of files) counts.set(file.modId, (counts.get(file.modId) || 0) + 1);
      result.conflicts = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
      for (const file of files.filter(item => counts.get(item.modId) > 1)) {
        skipped.push({ ...file, publicPath: undefined, url: undefined, reason: 'duplicate-mod-id', reasonLabel: 'декілька JAR одного мода: залиште одну версію на сервері' });
      }
      result.files = files.filter(item => counts.get(item.modId) === 1).sort((a, b) => a.displayName.localeCompare(b.displayName, 'uk'));
      result.skipped = skipped.sort((a, b) => a.fileName.localeCompare(b.fileName, 'uk'));
    }
  } catch (error) {
    result.available = false;
    result.error = error.message || 'Не вдалося прочитати папку mods';
  }
  result.missingIds = CLIENT_MODS_REQUIRED_IDS.filter(id => !result.files.some(file => file.modId === id));
  result.ready = result.available === true && result.missingIds.length === 0;
  clientModsCache = { at: now, result };
  return result;
}

// Public, read-only update manifest. The client only installs three explicitly
// allowlisted HomeCraft client modules. A hash detects incomplete/corrupt downloads;
// HTTPS is still required to authenticate the publishing server.
const launcherHashCache = new Map();
function cachedLauncherSha256(filePath) {
  const stat = fs.statSync(filePath);
  const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
  const cached = launcherHashCache.get(filePath);
  if (cached && cached.key === key) return cached.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  launcherHashCache.set(filePath, { key, hash });
  if (launcherHashCache.size > 64) {
    for (const old of launcherHashCache.keys()) {
      if (old !== filePath) launcherHashCache.delete(old);
      if (launcherHashCache.size <= 32) break;
    }
  }
  return hash;
}
function clientLauncherManifest() {
  const listing = listClientMods();
  const allowed = new Set(['homecraftauth', 'homecraftguild', 'homecraftspawnprotection']);
  const files = listing.files.filter(file => allowed.has(file.modId));
  return {
    schemaVersion: 1,
    product: 'homecraft',
    minecraft: MINECRAFT_RUNTIME.minecraft,
    neoforge: MINECRAFT_RUNTIME.neoforge,
    neoforgeRange: MINECRAFT_RUNTIME.neoForgeRange,
    ready: Boolean(listing.ready && files.length === 3),
    requiredIds: [...allowed],
    files: files.map(file => ({
      id: file.modId,
      name: file.displayName,
      version: file.version,
      filename: file.fileName,
      size: file.sizeBytes,
      sha256: cachedLauncherSha256(path.join(SERVER_MODS_DIR, file.fileName)),
      url: file.publicPath
    }))
  };
}

function safeClientModPath(urlPath) {
  const route = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/client-mods\/?/, '');
  const fileName = path.basename(route || '').replace(/[^a-zA-Z0-9._+ -]/g, '');
  if (!isJarOrZipFile(fileName) || hasExcludedClientModPattern(fileName)) return null;
  const requested = path.normalize(path.join(SERVER_MODS_DIR, fileName));
  const modsRoot = path.normalize(SERVER_MODS_DIR);
  if (requested !== modsRoot && !requested.startsWith(modsRoot + path.sep)) return null;
  if (!fs.existsSync(requested) || fs.statSync(requested).isDirectory()) return null;
  if (!listClientMods().files.some(file => file.fileName === fileName)) return null;
  return requested;
}

function serveClientMod(req, res, urlPath) {
  const filePath = safeClientModPath(urlPath);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return notFound(res);
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/java-archive',
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  fs.createReadStream(filePath).pipe(res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Тіло запиту завелике'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Некоректний JSON у запиті'));
      }
    });
    req.on('error', reject);
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeLogin(login) {
  return String(login || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32);
}

function findUserByLogin(db, value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw.includes('@')) return db.users.find(u => String(u.email || '').toLowerCase() === raw);
  return db.users.find(u => String(u.login || '').toLowerCase() === raw)
    || db.users.find(u => String(u.minecraftNick || '').toLowerCase() === raw && characterRegistry.active(db.identities, u));
}

function uniqueLogin(db, preferred, email) {
  let base = normalizeLogin(preferred) || normalizeLogin(String(email || '').split('@')[0]) || 'player';
  let candidate = base;
  let i = 2;
  while (db.users.some(u => String(u.login || '').toLowerCase() === candidate.toLowerCase())) {
    candidate = `${base}${i++}`.slice(0, 32);
  }
  return candidate;
}

function normalizeNick(nick) {
  return String(nick || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 8 && password.length <= 128;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [method, salt, hash] = String(stored || '').split('$');
    if (method !== 'scrypt' || !salt || !hash) return false;
    const actual = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function makeToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function offlineUuidFromNick(nick) {
  const bytes = crypto.createHash('md5').update(`OfflinePlayer:${nick}`, 'utf8').digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    login: user.login || normalizeLogin(user.displayName || user.email),
    displayName: user.displayName,
    role: user.role,
    minecraftNick: user.minecraftNick || null,
    minecraftUuid: user.minecraftUuid || null,
    minecraftCharacterId: user.minecraftCharacterId || null,
    skin: user.skin || { skinUrl: '', capeUrl: '', skinModel: 'classic', updatedAt: null, source: 'none' },
    isWhitelisted: Boolean(user.isWhitelisted),
    isBlocked: Boolean(user.isBlocked),
    createdAt: user.createdAt
  };
}


function createMinecraftGameSession(db, user, source = 'web') {
  if (!user?.minecraftNick || !user?.minecraftUuid) {
    return { error: 'Спочатку привʼяжи Minecraft нік' };
  }
  const identity = characterRegistry.active(db.identities, user);
  if (!identity) return { error: 'Персонаж видалений або його прив’язка не підтверджена.' };
  if (user.isBlocked || !user.isWhitelisted) {
    return { error: 'Немає whitelist-доступу або акаунт заблокований' };
  }
  const token = makeToken(24);
  const session = {
    token,
    userId: user.id,
    characterId: identity.id,
    minecraftNick: user.minecraftNick,
    minecraftUuid: user.minecraftUuid,
    source,
    createdAt: Date.now(),
    expiresAt: Date.now() + MC_SESSION_TTL_MS
  };
  db.minecraftSessions.push(session);
  audit(db, 'minecraft.session.start', { userId: user.id, nick: user.minecraftNick, source });
  return {
    token,
    expiresAt: new Date(session.expiresAt).toISOString(),
    minecraftNick: session.minecraftNick,
    minecraftUuid: session.minecraftUuid,
    user: publicUser(user)
  };
}

function findUserByMinecraft(db, nick, uuid) {
  const n = normalizeNick(nick);
  const u = String(uuid || '').trim().toLowerCase();
  return db.users.find(user => {
    if (!characterRegistry.active(db.identities, user)) return false;
    const nickOk = n && String(user.minecraftNick || '').toLowerCase() === n.toLowerCase();
    const uuidOk = u && String(user.minecraftUuid || '').toLowerCase() === u;
    return nickOk || uuidOk;
  });
}

function cleanupExpired(db) {
  const now = Date.now();
  db.sessions = db.sessions.filter(s => Number(s.expiresAt) > now);
  db.minecraftSessions = db.minecraftSessions.filter(s => Number(s.expiresAt) > now);
  db.passwordResets = (db.passwordResets || []).filter(t => Number(t.expiresAt) > now && (Number(t.createdAt) > now - 86400000));
}

function getAuth(req, db) {
  cleanupExpired(db);
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.homecraft_session;
  if (!token) return { user: null, session: null };
  const session = db.sessions.find(s => s.token === token && Number(s.expiresAt) > Date.now());
  if (!session) return { user: null, session: null };
  const user = db.users.find(u => u.id === session.userId);
  if (!user || user.isBlocked) return { user: null, session: null };
  return { user, session };
}

function getIp(req) {
  return clientIp(req);
}

function limited(req, bucket, max = 12, windowMs = 60_000) {
  const key = `${bucket}:${getIp(req)}`;
  const now = Date.now();
  if (rateMap.size > 10000) {
    for (const [key, state] of rateMap) if (state.reset < now) rateMap.delete(key);
    while (rateMap.size > 15000) rateMap.delete(rateMap.keys().next().value);
  }
  const state = rateMap.get(key) || { count: 0, reset: now + windowMs };
  if (state.reset < now) {
    state.count = 0;
    state.reset = now + windowMs;
  }
  state.count += 1;
  rateMap.set(key, state);
  return state.count > max;
}

function requireSecret(req) {
  const provided = req.headers['x-server-secret'] || req.headers['x-homecraft-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!provided || ['change-this-secret-before-public-use', 'generated-by-setup-homecraft-config'].includes(SERVER_SECRET) || SERVER_SECRET.length < 32) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(SERVER_SECRET));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function safeStaticPath(urlPath) {
  let route;
  try { route = decodeURIComponent(urlPath.split('?')[0]); }
  catch { return null; }
  if (route === '/') route = '/index.html';
  const cleanRoutes = new Set(['/support', '/map', '/status', '/login', '/register', '/forgot-password', '/reset-password', '/profile', '/download', '/admin', '/news', '/catalog']);
  if (cleanRoutes.has(route)) route = `${route}.html`;
  const requested = path.resolve(PUBLIC_DIR, '.' + route);
  const relative = path.relative(PUBLIC_DIR, requested);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some(part => part.startsWith('.'))) return null;
  return requested;
}

function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers
  });
  res.end(html);
}

function serveAdminPage(req, res) {
  const db = readDb();
  const auth = getAuth(req, db);
  if (!auth.user) {
    res.writeHead(302, { Location: '/login?next=/admin', 'Cache-Control': 'no-store' });
    res.end();
    return;
  }
  if (auth.user.role !== 'admin') {
    return sendHtml(res, 403, `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>403 — Home Craft</title><link rel="stylesheet" href="/styles.css?v=41"></head><body><main><section class="page-hero"><div class="container"><span class="season-pill">403</span><h1>Доступ заборонено</h1><p>Admin-панель доступна тільки користувачам з роллю admin.</p><div class="hero-actions"><a class="btn btn-primary" href="/profile">Профіль</a><a class="btn btn-outline" href="/">На головну</a></div></div></section></main><script src="/starfield.js?v=41"></script></body></html>`);
  }
  return serveStatic(req, res, '/admin.html');
}

function serveStatic(req, res, urlPath) {
  const filePath = safeStaticPath(urlPath);
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  const isPrivate = new Set(['login.html','register.html','forgot-password.html','reset-password.html','profile.html','admin.html','news.html']).has(path.basename(filePath));
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': isPrivate ? 'no-referrer' : 'strict-origin-when-cross-origin',
    ...(isPrivate ? { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } : {})
  };
  if (['.html', '.css', '.js'].includes(ext)) {
    headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
    headers['Pragma'] = 'no-cache';
  } else if (['.svg', '.png', '.jpg', '.webp'].includes(ext)) {
    headers['Cache-Control'] = 'public, max-age=3600';
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}


function normalizeUrlMaybe(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    return u.toString().slice(0, 512);
  } catch {
    return '';
  }
}

function normalizeSkinModel(value) {
  const model = String(value || '').trim().toLowerCase();
  return model === 'slim' ? 'slim' : 'classic';
}

function publicMinecraftProfile(user) {
  if (!user) return null;
  const skin = user.skin || { skinUrl: '', capeUrl: '', skinModel: 'classic', updatedAt: null, source: 'none' };
  return {
    minecraftNick: user.minecraftNick || null,
    minecraftUuid: user.minecraftUuid || null,
    isWhitelisted: Boolean(user.isWhitelisted),
    isBlocked: Boolean(user.isBlocked),
    skinUrl: absoluteAssetOrExternalUrl(skin.skinUrl || ''),
    capeUrl: absoluteAssetOrExternalUrl(skin.capeUrl || ''),
    skinModel: normalizeSkinModel(skin.skinModel),
    skin
  };
}

async function handleApi(req, res, pathname) {
  let db, auth;
  const method = req.method.toUpperCase();
  async function freshBody() {
    const body = await readBody(req);
    db = readDb(); cleanupExpired(db); auth = getAuth(req, db);
    return body;
  }
  try {
    db = readDb(); cleanupExpired(db); auth = getAuth(req, db);
    if (method === 'GET' && pathname === '/api/admin/minecraft/connection/status') {
      if (!auth.user || auth.user.role !== 'admin') return json(res, 403, { ok: false, error: 'Доступ лише для адміністратора' });
      res.setHeader('Cache-Control', 'no-store, private');
      const pushedAt = Date.parse(db.serverStatus.lastUpdatedAt || '');
      const recentPush = db.serverStatus.source === 'homecraft-neoforge-server'
        && db.serverStatus.online === true && Number.isFinite(pushedAt)
        && Date.now() - pushedAt >= 0 && Date.now() - pushedAt <= SERVER_HEARTBEAT_TTL_MS;
      return json(res, 200, {
        ok: true,
        siteUrl: process.env.PUBLIC_SITE_URL || process.env.HOMECRAFT_PUBLIC_SITE_URL || '',
        serverSecretConfigured: validSecret(SERVER_SECRET),
        minecraftHost: getMinecraftHost(),
        // Only a recent authenticated push establishes an active connection.
        minecraftPaired: recentPush,
        lastMinecraftPushAt: db.serverStatus.source === 'homecraft-neoforge-server' && Number.isFinite(pushedAt)
          ? db.serverStatus.lastUpdatedAt : null,
        nextStep: recentPush ? 'Сайт отримує статус від Minecraft-сервера.'
          : 'Завантажити приватний homecraft-connection.properties з адмінпанелі сайту, встановити у config/ Minecraft-сервера та перезапустити його.'
      });
    }

    if (method === 'GET' && pathname === '/api/admin/minecraft/connection') {
      if (!auth.user || auth.user.role !== 'admin') return json(res, 403, { ok: false, error: 'Доступ лише для адміністратора' });
      let text;
      try { text = connectionFile(process.env.PUBLIC_SITE_URL || process.env.HOMECRAFT_PUBLIC_SITE_URL, SERVER_SECRET, getMinecraftHost()); }
      catch (error) { return json(res, 409, { ok: false, error: error.message }); }
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': 'attachment; filename="homecraft-connection.properties"',
        'Cache-Control': 'no-store, private', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff'
      });
      return res.end(text);
    }

    if (method === 'GET' && pathname === '/api/server/status') {
      return json(res, 200, { ...await getLiveServerStatus(db), runtime: MINECRAFT_RUNTIME });
    }


    if (method === 'GET' && pathname === '/api/catalog') {
      return json(res, 200, { ok: true, ...worldCatalog.readCatalog() }, { 'Cache-Control': 'no-store' });
    }
    if (method === 'GET' && pathname === '/api/world/npcs') {
      return json(res, 200, { ok: true, ...worldCatalog.readNpcs() }, { 'Cache-Control': 'no-store' });
    }
    if (method === 'POST' && pathname === '/api/world/catalog/sync') {
      if (!requireSecret(req)) return json(res, 401, { ok: false, error: 'Некоректний serverSecret' });
      const body = await freshBody();
      try { return json(res, 200, { ok: true, ...worldCatalog.syncWorld(body) }); }
      catch (error) { return json(res, 400, { ok: false, error: error.message }); }
    }

    if (method === 'GET' && pathname === '/api/map/status') {
      const queryUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      return json(res, 200, { ok: true, map: publicMapState(readMapState(), {
        mode: queryUrl.searchParams.get('mode') || '',
        since: queryUrl.searchParams.get('since') || '',
        bounds: queryUrl.searchParams.get('bounds') || ''
      }) });
    }

    if (method === 'POST' && (pathname === '/api/map/update' || pathname === '/api/map/heartbeat')) {
      if (!requireSecret(req)) return json(res, 401, { ok: false, error: 'Некоректний serverSecret' });
      const body = await freshBody();
      const previous = readMapState();
      const isOnline = body.online !== false;
      const nowIso = new Date().toISOString();
      const next = normalizeMapState({
        ...previous,
        online: isOnline,
        source: body.source || 'homecraft-map-neoforge',
        worldName: body.worldName || previous.worldName,
        serverTime: body.serverTime ?? previous.serverTime,
        spawn: body.spawn || previous.spawn,
        players: isOnline ? normalizeMapPlayers(body.players) : [],
        tiles: mergeMapTiles(previous.tiles, body.tiles, body.clearTiles === true),
        lastUpdatedAt: nowIso,
        lastOnlineAt: isOnline ? nowIso : previous.lastOnlineAt || null,
        lastOfflineAt: isOnline ? previous.lastOfflineAt || null : nowIso
      });
      writeMapState(next);
      audit(db, isOnline ? 'map.update' : 'map.offline.push', { playerCount: next.players.length, source: next.source });
      writeDb(db);
      return json(res, 200, { ok: true, map: publicMapState(next) });
    }

    if (method === 'POST' && pathname === '/api/map/offline') {
      if (!requireSecret(req)) return json(res, 401, { ok: false, error: 'Некоректний serverSecret' });
      const previous = readMapState();
      const next = normalizeMapState({
        ...previous,
        online: false,
        players: [],
        lastUpdatedAt: new Date().toISOString(),
        lastOfflineAt: new Date().toISOString(),
        source: 'homecraft-map-offline-api'
      });
      writeMapState(next);
      audit(db, 'map.offline.manual', {});
      writeDb(db);
      return json(res, 200, { ok: true, map: publicMapState(next) });
    }


    if (method === 'POST' && pathname === '/api/guild/territories/update') {
      if (!requireSecret(req)) return json(res, 401, { ok: false, error: 'Некоректний serverSecret' });
      const body = await freshBody();
      const next = normalizeGuildTerritoryState({
        ...body,
        updatedAt: new Date().toISOString(),
        source: body.source || 'homecraft-guild-neoforge'
      });
      writeGuildTerritories(next);
      // Legacy guild mods send territory-only snapshots; preserve talent data on such requests.
      if (Array.isArray(body.guildTalents)) {
        writeGuildTalents({ updatedAt: new Date().toISOString(), guilds: body.guildTalents });
      }
      audit(db, 'guild.territories.update', { territoryCount: next.territories.length, source: next.source });
      writeDb(db);
      return json(res, 200, { ok: true, guildTerritories: next });
    }

    if (method === 'GET' && pathname === '/api/guild/territories') {
      return json(res, 200, { ok: true, guildTerritories: readGuildTerritories() });
    }

    if (method === 'GET' && pathname === '/api/guild/talents/me') {
      if (!auth.user) return json(res, 401, { ok: false, error: 'Потрібна авторизація' }, { 'Cache-Control': 'no-store' });
      if (!auth.user.minecraftUuid) return json(res, 200, { ok: true, guild: null, reason: 'minecraft_not_linked' }, { 'Cache-Control': 'no-store' });
      if (String(auth.user.minecraftVerifiedUuid || '').toLowerCase() !== String(auth.user.minecraftUuid).toLowerCase())
        return json(res, 200, { ok: true, guild: null, reason: 'minecraft_not_verified' }, { 'Cache-Control': 'no-store' });
      return json(res, 200, { ok: true, guild: memberGuildTalents(auth.user) }, { 'Cache-Control': 'no-store' });
    }

    if (method === 'GET' && pathname === '/api/site/config') {
      return json(res, 200, {
        ok: true,
        publicSiteUrl: PUBLIC_SITE_URL,
        host: HOST,
        port: PORT,
        autoWhitelist: AUTO_WHITELIST,
        serverHeartbeatTtlMs: SERVER_HEARTBEAT_TTL_MS,
        minecraftPingProtocol: MC_PING_PROTOCOL,
        minecraftTcpFallback: MC_TCP_FALLBACK_ENABLED,
        serverName: SERVER_DISPLAY_NAME,
        minecraftHost: getMinecraftHost(),
        resourcePack: ensureResourcePackManifest()
      });
    }


    if (method === 'GET' && pathname === '/api/resource-pack/status') {
      return json(res, 200, { ok: true, resourcePack: ensureResourcePackManifest() });
    }

    if (method === 'GET' && pathname === '/api/launcher/manifest') {
      const manifest = clientLauncherManifest();
      return json(res, manifest.ready ? 200 : 503, { ok: manifest.ready, ...manifest });
    }

    if (method === 'GET' && pathname === '/api/client-mods') {
      return json(res, 200, { ok: true, runtime: MINECRAFT_RUNTIME, clientMods: listClientMods() });
    }

    if (method === 'POST' && pathname === '/api/admin/resource-pack/upload') {
      if (!auth.user || auth.user.role !== 'admin') return json(res, 403, { ok: false, error: 'Доступ лише для адміністратора' });
      const raw = await readRawBody(req, MAX_RESOURCE_PACK_BYTES);
      const parts = parseMultipart(raw, req.headers['content-type'] || '');
      const packPart = parts.find(p => p.name === 'resourcePackFile' && p.filename && p.data.length > 0);
      const requirePart = parts.find(p => p.name === 'requireResourcePack');
      const promptPart = parts.find(p => p.name === 'resourcePackPrompt');
      if (!packPart) return json(res, 400, { ok: false, error: 'Додай resource pack ZIP файл' });
      if (!/\.zip$/i.test(packPart.filename || '') && !/zip/i.test(packPart.contentType || '')) return json(res, 400, { ok: false, error: 'Resource pack має бути .zip' });
      const requirePack = requirePart ? /^(true|1|yes|on)$/i.test(requirePart.data.toString('utf8').trim()) : RESOURCE_PACK_REQUIRE;
      const promptText = (promptPart ? promptPart.data.toString('utf8').trim() : RESOURCE_PACK_PROMPT_TEXT) || RESOURCE_PACK_PROMPT_TEXT;
      let pack;
      try {
        pack = saveResourcePackZip(packPart.data, {
          filename: packPart.filename,
          contentType: packPart.contentType,
          displayName: path.basename(packPart.filename || 'Home Craft Resource Pack', '.zip'),
          require: requirePack,
          prompt: { text: promptText, color: 'gold' }
        });
      } catch (error) {
        return json(res, 400, { ok: false, error: error.message || 'Некоректний ресурс-пак' });
      }
      audit(db, 'resourcepack.upload', { adminId: auth.user.id, sha1: pack.sha1, sizeBytes: pack.sizeBytes });
      writeDb(db);
      return json(res, 200, { ok: true, resourcePack: pack });
    }

    if (method === 'GET' && pathname === '/api/server/ping') {
      const ping = await pingMinecraftServer(getMinecraftHost()).catch(error => ({ online: false, error: error.message }));
      const tcpProbe = ping.online ? null : await tcpProbeMinecraftServer(getMinecraftHost()).catch(error => ({ online: false, error: error.message }));
      return json(res, 200, { ok: true, ping, tcpProbe });
    }

    if ((method === 'POST') && (pathname === '/api/server/online/push' || pathname === '/api/server/heartbeat')) {
      if (!requireSecret(req)) return json(res, 401, { ok: false, error: 'Некоректний serverSecret' });
      const body = await freshBody();
      const isOnline = body.online !== false;
      const nowIso = new Date().toISOString();
      const players = isOnline ? normalizePlayers(body.players) : [];
      const bodyPlayersOnline = Number(body.playersOnline);
      const playersOnline = isOnline
        ? Math.max(0, Number.isFinite(bodyPlayersOnline) ? bodyPlayersOnline : players.length)
        : 0;
      const playersMax = Math.max(1, Number(body.playersMax || body.maxPlayers || db.serverStatus.playersMax || 100));
      const authenticatedCount = isOnline ? Math.max(0, Number(body.authenticatedCount ?? players.filter(p => p.authenticated === true).length) || 0) : 0;
      const pendingAuthCount = isOnline ? Math.max(0, Number(body.pendingAuthCount ?? players.filter(p => p.pending === true).length) || 0) : 0;
      db.serverStatus = {
        ...defaultServerStatus(),
        ...db.serverStatus,
        online: isOnline,
        playersOnline,
        playersMax,
        authenticatedCount,
        pendingAuthCount,
        version: String(body.version || db.serverStatus.version || RUNTIME_LABEL).slice(0, 96),
        motd: String(body.motd || db.serverStatus.motd || SERVER_DISPLAY_NAME).slice(0, 128),
        host: String(body.host || db.serverStatus.host || getMinecraftHost()).slice(0, 96),
        players,
        lastUpdatedAt: nowIso,
        lastOnlineAt: isOnline ? nowIso : db.serverStatus.lastOnlineAt || null,
        lastOfflineAt: isOnline ? db.serverStatus.lastOfflineAt || null : nowIso,
        source: String(body.source || 'neoforge-server').slice(0, 64)
      };
      audit(db, isOnline ? 'server.online.push' : 'server.offline.push', { playersOnline, playersMax, authenticatedCount, pendingAuthCount });
      writeDb(db);
      return json(res, 200, { ok: true, status: publicServerStatus(db.serverStatus) });
    }

    if (method === 'POST' && pathname === '/api/server/offline') {
      if (!requireSecret(req)) return json(res, 401, { ok: false, error: 'Некоректний serverSecret' });
      db.serverStatus = {
        ...defaultServerStatus(),
        ...db.serverStatus,
        online: false,
        playersOnline: 0,
        authenticatedCount: 0,
        pendingAuthCount: 0,
        players: [],
        lastUpdatedAt: new Date().toISOString(),
        lastOfflineAt: new Date().toISOString(),
        source: 'server-offline-api'
      };
      audit(db, 'server.offline.manual', {});
      writeDb(db);
      return json(res, 200, { ok: true, status: publicServerStatus(db.serverStatus) });
    }

    if (method === 'POST' && pathname === '/api/auth/register') {
      if (limited(req, 'register', 6, 60_000)) return json(res, 429, { ok: false, error: 'Забагато спроб. Спробуй пізніше' });
      const body = await freshBody();
      const email = normalizeEmail(body.email);
      const login = normalizeLogin(body.login || body.username || body.displayName);
      const password = String(body.password || '');
      const passwordRepeat = String(body.passwordRepeat || '');
      const displayName = String(body.displayName || login || '').trim().slice(0, 32) || email.split('@')[0];
      if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { ok: false, error: 'Некоректний email' });
      if (!login || login.length < 3) return json(res, 400, { ok: false, error: 'Логін має містити мінімум 3 символи' });
      if (!validatePassword(password)) return json(res, 400, { ok: false, error: 'Пароль має містити мінімум 8 символів' });
      if (passwordRepeat && passwordRepeat !== password) return json(res, 400, { ok: false, error: 'Паролі не збігаються' });
      if (db.users.some(u => u.email === email)) return json(res, 409, { ok: false, error: 'Такий email уже існує' });
      if (login && db.users.some(u => String(u.login || '').toLowerCase() === login.toLowerCase())) return json(res, 409, { ok: false, error: 'Такий login уже зайнятий' });
      const user = {
        id: crypto.randomUUID(),
        email,
        login: uniqueLogin(db, login || displayName, email),
        displayName,
        passwordHash: hashPassword(password),
        role: characterRegistry.firstAdmin(db.identities, db.users) ? 'admin' : 'member',
        minecraftNick: null,
        minecraftUuid: null,
        skin: { skinUrl: '', capeUrl: '', skinModel: 'classic', updatedAt: null },
        isWhitelisted: AUTO_WHITELIST,
        isBlocked: false,
        createdAt: new Date().toISOString()
      };
      if (user.role === 'admin') user.isWhitelisted = true;
      const token = makeToken();
      db.users.push(user);
      db.sessions.push({ token, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
      audit(db, 'auth.register', { userId: user.id, email: user.email });
      writeDb(db);
      return json(res, 201, { ok: true, user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      if (limited(req, 'login', 10, 60_000)) return json(res, 429, { ok: false, error: 'Забагато спроб. Спробуй пізніше' });
      const body = await freshBody();
      const login = String(body.login || body.email || '').trim();
      const password = String(body.password || '');
      const user = findUserByLogin(db, login);
      if (!user || user.isBlocked || !verifyPassword(password, user.passwordHash)) {
        audit(db, 'auth.login.failed', { login, ip: getIp(req) });
        writeDb(db);
        return json(res, 401, { ok: false, error: 'Невірний email/login або пароль' });
      }
      if (!user.login) user.login = uniqueLogin(db, user.displayName || user.minecraftNick, user.email);
      const token = makeToken();
      db.sessions.push({ token, userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
      audit(db, 'auth.login', { userId: user.id });
      writeDb(db);
      return json(res, 200, { ok: true, user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token) });
    }

    if (method === 'POST' && pathname === '/api/auth/password/forgot') {
      if (limited(req, 'forgot', 5, 15 * 60_000)) return json(res, 429, { ok: false, error: 'Забагато запитів. Спробуй трохи пізніше.' });
      const body = await freshBody();
      const email = normalizeEmail(body.email);
      if (email.length > 254 || !/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { ok: false, error: 'Введи коректну електронну адресу.' });
      if (!SMTP_READY) return json(res, 503, { ok: false, error: 'Відновлення пароля тимчасово недоступне. Звернися до підтримки.' });
      const startedAt = Date.now();
      const generic = { ok: true, message: 'Якщо акаунт із такою адресою існує, ми надішлемо лист із подальшими кроками.' };
      const user = db.users.find(u => normalizeEmail(u.email) === email && !u.isBlocked);
      const previous = user && (db.passwordResets || []).find(t => t.userId === user.id);
      if (user && !passwordResetMailInFlight.has(user.id) && (!previous || Date.now() - previous.createdAt >= RESET_REQUEST_INTERVAL_MS)) {
        passwordResetMailInFlight.add(user.id);
        const token = makeToken(32);
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const resetLink = passwordResetUrl(token);  // Trusted origin only, not the HTTP Host header.
        try {
          await sendAccountEmail(user.email, 'Відновлення пароля Home Craft',
            `Вітаємо!\n\nДля зміни пароля Home Craft відкрий посилання:\n${resetLink}\n\nПосилання діє 30 хвилин та лише один раз. Якщо ти не запитував відновлення, просто проігноруй цей лист.\n`);
          db = readDb();
          db.passwordResets = (db.passwordResets || []).filter(t => t.userId !== user.id);
          db.passwordResets.push({ userId: user.id, tokenHash, createdAt: Date.now(), expiresAt: Date.now() + RESET_TTL_MS });
          audit(db, 'auth.password_reset.requested', { userId: user.id });
          writeDb(db);
        } catch (error) {
          // Never expose address, credentials or reset link to browser or logs.
          logLine('error', 'Password recovery mail delivery failed', { requestId: req.homecraftRequestId, code: error.code || 'MAIL_ERROR' });
        } finally {
          passwordResetMailInFlight.delete(user.id);
        }
      }
      const minimumDelay = 400 - (Date.now() - startedAt);
      if (minimumDelay > 0) await new Promise(resolve => setTimeout(resolve, minimumDelay));
      return json(res, 200, generic);
    }

    if (method === 'POST' && pathname === '/api/auth/password/reset') {
      if (limited(req, 'password-reset', 8, 15 * 60_000)) return json(res, 429, { ok: false, error: 'Забагато спроб. Повтори пізніше.' });
      const body = await freshBody();
      const token = String(body.token || '');
      const password = String(body.password || '');
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return json(res, 400, { ok: false, error: 'Посилання недійсне або термін його дії минув.' });
      if (!validatePassword(password)) return json(res, 400, { ok: false, error: 'Пароль повинен містити від 8 до 128 символів.' });
      if (password !== body.passwordRepeat) return json(res, 400, { ok: false, error: 'Паролі не збігаються.' });
      const hash = crypto.createHash('sha256').update(token).digest('hex');
      const reset = (db.passwordResets || []).find(t => t.tokenHash === hash && t.expiresAt > Date.now());
      const user = reset && db.users.find(u => u.id === reset.userId && !u.isBlocked);
      if (!user) return json(res, 400, { ok: false, error: 'Посилання недійсне або термін його дії минув.' });
      user.passwordHash = hashPassword(password);
      db.passwordResets = (db.passwordResets || []).filter(t => t.userId !== user.id);
      db.sessions = db.sessions.filter(session => session.userId !== user.id);
      db.minecraftSessions = db.minecraftSessions.filter(session => session.userId !== user.id);
      audit(db, 'auth.password_reset.completed', { userId: user.id });
      writeDb(db);
      try {
        await sendAccountEmail(user.email, 'Пароль Home Craft змінено',
          'Пароль до твого акаунта Home Craft було змінено. Усі попередні сеанси завершено. Якщо це робив не ти, звернися до адміністрації спільноти.');
      } catch (error) {
        logLine('warn', 'Password reset confirmation delivery failed', { requestId: req.homecraftRequestId, code: error.code || 'MAIL_ERROR' });
      }
      return json(res, 200, { ok: true, message: 'Пароль успішно змінено. Тепер увійди з новим паролем.' }, { 'Set-Cookie': clearSessionCookie() });
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      const cookies = parseCookies(req.headers.cookie || '');
      const currentSessionToken = cookies.homecraft_session;
      db.sessions = db.sessions.filter(s => s.token !== currentSessionToken);
      if (auth.user) audit(db, 'auth.logout', { userId: auth.user.id });
      writeDb(db);
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    }

    if (method === 'GET' && pathname === '/api/me') {
      return json(res, 200, { ok: true, user: publicUser(auth.user) });
    }

    if (method === 'POST' && pathname === '/api/minecraft/link') {
      const body = await freshBody();
      if (!auth.user) return json(res, 401, { ok: false, error: 'Потрібна авторизація' });
      const nick = validNick(String(body.minecraftNick || body.nick || '').trim());
      const uuid = String(body.minecraftUuid || body.uuid || offlineUuidFromNick(nick)).trim().toLowerCase();
      characterRegistry.claim(db.identities, auth.user, nick, uuid);
      audit(db, 'minecraft.link', { userId: auth.user.id, characterId: auth.user.minecraftCharacterId, nick, uuid });
      writeDb(db);
      return json(res, 200, { ok: true, user: publicUser(auth.user) });
    }

    if (method === 'POST' && pathname === '/api/minecraft/character/delete') {
      const body = await freshBody();
      if (!auth.user) return json(res, 401, { ok: false, error: 'Потрібна авторизація' });
      if (limited(req, 'mc-character-delete', 5, 60_000)) return json(res, 429, { ok: false, error: 'Забагато спроб' });
      if (!verifyPassword(String(body.password || ''), auth.user.passwordHash)) return json(res, 403, { ok: false, error: 'Невірний пароль' });
      if (!auth.user.minecraftNick || String(body.confirmNick || '') !== auth.user.minecraftNick)
        return json(res, 400, { ok: false, error: 'Для підтвердження введи точний нік персонажа.' });
      const id = auth.user.minecraftCharacterId;
      characterRegistry.retire(db.identities, auth.user);
      db.minecraftSessions = db.minecraftSessions.filter(s => s.userId !== auth.user.id);
      audit(db, 'minecraft.character.retired', { userId: auth.user.id, characterId: id });
      writeDb(db);
      return json(res, 200, { ok: true, user: publicUser(auth.user), message: 'Персонажа видалено. Його нік і UUID залишаються зарезервованими назавжди.' });
    }

    if (method === 'POST' && pathname === '/api/minecraft/skin/upload') {
      if (!auth.user) return json(res, 401, { ok: false, error: 'Потрібна авторизація' });
      if (limited(req, 'skin-upload', 12, 60_000)) return json(res, 429, { ok: false, error: 'Забагато завантажень. Спробуй пізніше' });
      const raw = await readRawBody(req, MAX_UPLOAD_BYTES);
      const parts = parseMultipart(raw, req.headers['content-type'] || '');
      logLine('info', 'Skin upload request parsed', {
        requestId: req.homecraftRequestId,
        userId: auth.user.id,
        parts: parts.map(p => ({ name: p.name, filename: p.filename || '', contentType: p.contentType || '', bytes: p.data?.length || 0, firstBytesHex: Buffer.isBuffer(p.data) ? p.data.slice(0, 8).toString('hex') : '' }))
      });
      const skinPart = parts.find(p => p.name === 'skinFile' && p.filename && p.data.length > 0);
      const capePart = parts.find(p => p.name === 'capeFile' && p.filename && p.data.length > 0);
      const modelPart = parts.find(p => p.name === 'skinModel');
      const skinModel = normalizeSkinModel(modelPart ? modelPart.data.toString('utf8') : auth.user.skin?.skinModel);
      if (!skinPart && !capePart) return json(res, 400, { ok: false, error: 'Додай skin або cape PNG файл' });
      const currentSkin = auth.user.skin || { skinUrl: '', capeUrl: '', skinModel: 'classic', updatedAt: null };
      const nextSkin = { ...currentSkin, skinModel, updatedAt: new Date().toISOString(), source: 'upload' };
      const uploaded = {};
      if (skinPart) {
        if (!/png/i.test(skinPart.contentType) && !/\.png$/i.test(skinPart.filename)) return json(res, 400, { ok: false, error: 'Skin має бути PNG' });
        const saved = saveUserPngAsset(auth.user, 'skin', skinPart.data, { filename: skinPart.filename, contentType: skinPart.contentType });
        nextSkin.skinUrl = saved.publicPath;
        nextSkin.skinFile = saved.publicPath;
        nextSkin.skinSize = { width: saved.width, height: saved.height, bytes: saved.bytes };
        uploaded.skin = saved;
      }
      if (capePart) {
        if (!/png/i.test(capePart.contentType) && !/\.png$/i.test(capePart.filename)) return json(res, 400, { ok: false, error: 'Cape має бути PNG' });
        const saved = saveUserPngAsset(auth.user, 'cape', capePart.data, { filename: capePart.filename, contentType: capePart.contentType });
        nextSkin.capeUrl = saved.publicPath;
        nextSkin.capeFile = saved.publicPath;
        nextSkin.capeSize = { width: saved.width, height: saved.height, bytes: saved.bytes };
        uploaded.cape = saved;
      }
      auth.user.skin = nextSkin;
      audit(db, 'minecraft.skin.upload', { userId: auth.user.id, nick: auth.user.minecraftNick, uploaded: Object.keys(uploaded) });
      writeDb(db);
      return json(res, 200, { ok: true, uploaded, user: publicUser(auth.user) });
    }

    if (method === 'POST' && pathname === '/api/minecraft/skin/clear') {
      if (!auth.user) return json(res, 401, { ok: false, error: 'Потрібна авторизація' });
      const body = await freshBody();
      const kind = String(body.kind || 'all').trim().toLowerCase();
      const currentSkin = auth.user.skin || { skinUrl: '', capeUrl: '', skinModel: 'classic', updatedAt: null };
      if (kind === 'skin' || kind === 'all') {
        currentSkin.skinUrl = '';
        currentSkin.skinFile = '';
        currentSkin.skinSize = null;
      }
      if (kind === 'cape' || kind === 'all') {
        currentSkin.capeUrl = '';
        currentSkin.capeFile = '';
        currentSkin.capeSize = null;
      }
      currentSkin.updatedAt = new Date().toISOString();
      auth.user.skin = currentSkin;
      audit(db, 'minecraft.skin.clear', { userId: auth.user.id, kind });
      writeDb(db);
      return json(res, 200, { ok: true, user: publicUser(auth.user) });
    }

    if (method === 'POST' && pathname === '/api/minecraft/skin/update') {
      if (!auth.user) return json(res, 401, { ok: false, error: 'Потрібна авторизація' });
      const body = await freshBody();
      const skinUrl = normalizeUrlMaybe(body.skinUrl);
      const capeUrl = normalizeUrlMaybe(body.capeUrl);
      const skinModel = normalizeSkinModel(body.skinModel);
      if (body.skinUrl && !skinUrl) return json(res, 400, { ok: false, error: 'Некоректне посилання на skin PNG' });
      if (body.capeUrl && !capeUrl) return json(res, 400, { ok: false, error: 'Некоректне посилання на cape PNG' });
      auth.user.skin = { skinUrl, capeUrl, skinModel, updatedAt: new Date().toISOString() };
      audit(db, 'minecraft.skin.update', { userId: auth.user.id, nick: auth.user.minecraftNick, skinModel });
      writeDb(db);
      return json(res, 200, { ok: true, user: publicUser(auth.user) });
    }

    if (method === 'GET' && pathname === '/api/minecraft/asset-proxy') {
      const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const target = parsed.searchParams.get('url') || '';
      if (!/^https?:\/\//i.test(target)) return json(res, 400, { ok: false, error: 'Bad image URL' });
      try {
        const upstream = await fetch(target, { redirect: 'follow', signal: AbortSignal.timeout(8000) });
        if (!upstream.ok) return json(res, 502, { ok: false, error: 'Image fetch failed' });
        const contentType = upstream.headers.get('content-type') || '';
        const arr = Buffer.from(await upstream.arrayBuffer());
        if (arr.length > MAX_UPLOAD_BYTES) return json(res, 413, { ok: false, error: 'Image too large' });
        if (!/png/i.test(contentType) && !isPng(arr)) return json(res, 415, { ok: false, error: 'Only PNG is allowed' });
        if (!isPng(arr)) return json(res, 415, { ok: false, error: 'Not a PNG' });
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=300',
          'X-Content-Type-Options': 'nosniff'
        });
        return res.end(arr);
      } catch (error) {
        logLine('warn', 'Asset proxy failed', { target, error: error.message });
        return json(res, 502, { ok: false, error: 'Image proxy failed' });
      }
    }

    if (method === 'GET' && pathname.startsWith('/api/minecraft/skin/')) {
      const id = decodeURIComponent(pathname.split('/').pop() || '');
      const user = findUserByMinecraft(db, id, id);
      if (!user) return json(res, 404, { ok: false, error: 'Minecraft profile not found' });
      return json(res, 200, { ok: true, profile: publicMinecraftProfile(user) });
    }

    if (method === 'GET' && pathname.startsWith('/api/minecraft/profile/')) {
      const id = decodeURIComponent(pathname.split('/').pop() || '');
      const user = findUserByMinecraft(db, id, id);
      if (!user) return json(res, 404, { ok: false, error: 'Minecraft profile not found' });
      return json(res, 200, { ok: true, profile: publicMinecraftProfile(user) });
    }

    if (method === 'POST' && pathname === '/api/minecraft/session/start') {
      if (!auth.user) return json(res, 401, { ok: false, error: 'Потрібна авторизація' });
      const game = createMinecraftGameSession(db, auth.user, 'web');
      if (game.error) return json(res, 400, { ok: false, error: game.error });
      writeDb(db);
      return json(res, 200, { ok: true, ...game });
    }

    if (method === 'POST' && pathname === '/api/minecraft/client/login') {
      if (limited(req, 'mc-client-login', 10, 60_000)) return json(res, 429, { ok: false, error: 'Забагато спроб. Спробуй пізніше' });
      const body = await freshBody();
      const login = String(body.login || body.email || '').trim();
      const password = String(body.password || '');
      const nick = validNick(String(body.minecraftNick || body.nick || '').trim());
      const uuid = String(body.minecraftUuid || body.uuid || '').trim();
      const user = findUserByLogin(db, login);
      if (!user || user.isBlocked || !verifyPassword(password, user.passwordHash)) {
        audit(db, 'minecraft.client.login.failed', { login, nick, ip: getIp(req) });
        writeDb(db);
        return json(res, 401, { ok: false, error: 'Невірний email/login або пароль' });
      }
      validNick(nick);
      const requestedUuid = (uuid || offlineUuidFromNick(nick)).toLowerCase();
      characterRegistry.claim(db.identities, user, nick, requestedUuid);
      if (!user.login) user.login = uniqueLogin(db, user.displayName || user.minecraftNick, user.email);
      const game = createMinecraftGameSession(db, user, 'neoforge-client');
      if (game.error) return json(res, 403, { ok: false, error: game.error, user: publicUser(user) });
      writeDb(db);
      return json(res, 200, { ok: true, ...game });
    }

    if (method === 'POST' && pathname === '/api/minecraft/client/register') {
      if (limited(req, 'mc-client-register', 5, 60_000)) return json(res, 429, { ok: false, error: 'Забагато спроб. Спробуй пізніше' });
      const body = await freshBody();
      const email = normalizeEmail(body.email);
      const login = normalizeLogin(body.login || body.username || body.displayName);
      const password = String(body.password || '');
      const displayName = String(body.displayName || login || '').trim().slice(0, 32) || email.split('@')[0];
      const nick = validNick(String(body.minecraftNick || body.nick || '').trim());
      const uuid = (String(body.minecraftUuid || body.uuid || '').trim() || (nick ? offlineUuidFromNick(nick) : '')).toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { ok: false, error: 'Некоректний email' });
      if (!login || login.length < 3) return json(res, 400, { ok: false, error: 'Логін має містити мінімум 3 символи' });
      if (!validatePassword(password)) return json(res, 400, { ok: false, error: 'Пароль має містити мінімум 8 символів' });
      if (nick.length < 3) return json(res, 400, { ok: false, error: 'Некоректний Minecraft нік' });
      if (db.users.some(u => u.email === email)) return json(res, 409, { ok: false, error: 'Такий email уже існує' });
      if (login && db.users.some(u => String(u.login || '').toLowerCase() === login.toLowerCase())) return json(res, 409, { ok: false, error: 'Такий login уже зайнятий' });
      if (db.users.some(u => String(u.minecraftNick || '').toLowerCase() === nick.toLowerCase())) return json(res, 409, { ok: false, error: 'Цей Minecraft нік уже привʼязаний' });
      if (uuid && db.users.some(u => String(u.minecraftUuid || '').toLowerCase() === uuid.toLowerCase())) return json(res, 409, { ok: false, error: 'Цей UUID уже привʼязаний' });
      const user = {
        id: crypto.randomUUID(), email, login: uniqueLogin(db, login || displayName, email), displayName, passwordHash: hashPassword(password),
        role: 'member', minecraftNick: null, minecraftUuid: null,
        skin: { skinUrl: '', capeUrl: '', skinModel: 'classic', updatedAt: null },
        isWhitelisted: AUTO_WHITELIST, isBlocked: false, createdAt: new Date().toISOString()
      };
      characterRegistry.claim(db.identities, user, nick, uuid);
      if (characterRegistry.firstAdmin(db.identities, db.users)) { user.role = 'admin'; user.isWhitelisted = true; }
      db.users.push(user);
      audit(db, 'minecraft.client.register', { userId: user.id, email, nick });
      const game = createMinecraftGameSession(db, user, 'neoforge-client-register');
      writeDb(db);
      return json(res, 201, { ok: true, ...game });
    }

    if (method === 'POST' && pathname === '/api/minecraft/session/end') {
      const body = await freshBody();
      const token = String(body.token || '').trim();
      db.minecraftSessions = db.minecraftSessions.filter(s => s.token !== token);
      writeDb(db);
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && pathname === '/api/minecraft/session/validate') {
      if (!requireSecret(req)) return json(res, 401, { ok: false, errorCode: 'SERVER_SECRET_INVALID', error: 'Некоректний serverSecret' });
      const body = await freshBody();
      const token = String(body.token || '').trim();
      const nick = String(body.minecraftNick || body.nick || '').trim();
      const uuid = String(body.minecraftUuid || body.uuid || '').trim();
      const session = db.minecraftSessions.find(s => s.token === token && Number(s.expiresAt) > Date.now());
      if (!session) return json(res, 401, { ok: false, allowed: false, errorCode: 'TOKEN_EXPIRED', error: 'Session expired or invalid' });
      const user = db.users.find(u => u.id === session.userId);
      const identity = characterRegistry.active(db.identities, user);
      const nickOk = identity && nick === identity.nick && session.minecraftNick === identity.nick;
      const uuidOk = validUuid(uuid) && identity && uuid.toLowerCase() === identity.uuid && String(session.minecraftUuid || '').toLowerCase() === identity.uuid;
      const allowed = Boolean(identity && session.characterId === identity.id && user && !user.isBlocked && user.isWhitelisted && nickOk && uuidOk);
      if (allowed) {
        db.minecraftSessions = db.minecraftSessions.filter(s => s.token !== token);
        // Only this server-secret-authenticated call may mark a profile as Minecraft-verified.
        if (uuid && String(user.minecraftUuid || '').toLowerCase() === uuid.toLowerCase()) {
          user.minecraftVerifiedUuid = uuid.toLowerCase();
          user.minecraftVerifiedAt = new Date().toISOString();
        }
      }
      audit(db, 'minecraft.session.validate', { userId: user?.id, nick, uuid, allowed });
      writeDb(db);
      const profile = allowed ? publicMinecraftProfile(user) : null;
      const role = allowed ? String(user?.role || 'member').toLowerCase() : 'guest';
      const minecraftPermissionLevel = role === 'admin' ? 4 : (role === 'moderator' || role === 'mod') ? 2 : 0;
      return json(res, allowed ? 200 : 403, {
        ok: allowed,
        allowed,
        ...(!allowed ? { errorCode: 'IDENTITY_NOT_ALLOWED' } : {}),
        accountId: allowed ? user.id : '',
        characterId: allowed ? identity.id : '',
        legacyVerified: allowed && identity.legacyVerified === true,
        message: allowed ? 'Авторизацію підтверджено' : 'Доступ не підтверджено',
        user: allowed ? publicUser(user) : null,
        profile,
        role,
        admin: role === 'admin',
        minecraftPermissionLevel,
        skinUrl: profile?.skinUrl || '',
        capeUrl: profile?.capeUrl || '',
        skinModel: profile?.skinModel || 'classic'
      });
    }

    if (method === 'POST' && pathname === '/api/minecraft/identities/check') {
      if (!requireSecret(req)) return json(res, 401, { ok: false, error: 'Некоректний serverSecret' });
      const body = await freshBody();
      if (!Array.isArray(body.claims) || body.claims.length > 1000) return json(res, 400, { ok: false, error: 'Некоректний список персонажів' });
      const revoked = [], retired = [];
      for (const claim of body.claims) {
        const user = db.users.find(u => u.id === claim.accountId);
        const identity = characterRegistry.active(db.identities, user);
        const replaced = !identity || identity.id !== claim.characterId || identity.uuid !== String(claim.uuid || '').toLowerCase() || identity.nick !== claim.nick;
        const role = String(user?.role || 'member').toLowerCase();
        const permission = role === 'admin' ? 4 : ['moderator', 'mod'].includes(role) ? 2 : 0;
        if (replaced || user.isBlocked || !user.isWhitelisted || claim.permissionLevel !== permission) revoked.push(String(claim.uuid || ''));
        if (replaced) retired.push(String(claim.uuid || ''));
      }
      return json(res, 200, { ok: true, revoked, retired });
    }

    if (method === 'GET' && pathname.startsWith('/api/minecraft/player/')) {
      if (!requireSecret(req)) return json(res, 401, { ok: false, error: 'Некоректний serverSecret' });
      const uuidOrNick = decodeURIComponent(pathname.split('/').pop() || '');
      const user = findUserByMinecraft(db, uuidOrNick, uuidOrNick);
      const allowed = Boolean(user && !user.isBlocked && user.isWhitelisted);
      return json(res, 200, { ok: true, allowed, user: allowed ? publicUser(user) : null });
    }


    if (method === 'GET' && pathname.startsWith('/api/minecraft/assets/')) {
      if (!requireSecret(req)) return json(res, 401, { ok: false, error: 'Некоректний serverSecret' });
      const id = decodeURIComponent(pathname.split('/').pop() || '');
      const user = findUserByMinecraft(db, id, id);
      if (!user) return json(res, 404, { ok: false, error: 'Minecraft profile not found' });
      return json(res, 200, { ok: true, profile: publicMinecraftProfile(user) });
    }

    if (method === 'GET' && pathname === '/api/admin/logs') {
      if (!auth.user || auth.user.role !== 'admin') return json(res, 403, { ok: false, error: 'Доступ лише для адміністратора' });
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const limit = Number(parsedUrl.searchParams.get('limit') || 200);
      return json(res, 200, { ok: true, logs: readRecentLogLines(limit) });
    }

    if (method === 'GET' && pathname === '/api/admin/users') {
      if (!auth.user || auth.user.role !== 'admin') return json(res, 403, { ok: false, error: 'Доступ лише для адміністратора' });
      return json(res, 200, { ok: true, users: db.users.map(publicUser) });
    }

    if (method === 'POST' && pathname === '/api/admin/user/update') {
      if (!auth.user || auth.user.role !== 'admin') return json(res, 403, { ok: false, error: 'Доступ лише для адміністратора' });
      const body = await freshBody();
      const user = db.users.find(u => u.id === body.id);
      if (!user) return json(res, 404, { ok: false, error: 'User not found' });
      if (typeof body.isWhitelisted === 'boolean') user.isWhitelisted = body.isWhitelisted;
      if (typeof body.isBlocked === 'boolean') user.isBlocked = body.isBlocked;
      if (['admin', 'moderator', 'member'].includes(body.role)) user.role = body.role;
      audit(db, 'admin.user.update', { adminId: auth.user.id, userId: user.id });
      writeDb(db);
      return json(res, 200, { ok: true, user: publicUser(user) });
    }

    return notFound(res);
  } catch (error) {
    logLine('error', 'API error', { requestId: req.homecraftRequestId, method, pathname, error: error.message, stack: error.stack });
    return json(res, error instanceof IdentityError ? error.status : 500, { ok: false, error: error instanceof IdentityError && error.status < 500 ? error.message : 'Не вдалося виконати дію. Спробуй пізніше.' });
  }
}

// Central headers apply to API, streaming downloads, error responses and HTML.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'sha256-pfFqfY2HBAoKt55AsFP4LwrZ9Axy3uPaSPRoHoZbF08='",
  "style-src 'self' 'unsafe-inline'", // inline grid positions in guild talents (scoped, validated values)
  "img-src 'self' data: blob: https:", // user-hosted skins/capes may use HTTPS
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'"
].join('; ');
function applySecurityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (PUBLIC_SITE_URL.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000'); // no includeSubDomains/preload until audited
  }
}
function browserOriginAllowed(req) {
  const supplied = req.headers.origin;
  if (!supplied) return true; // Minecraft/Java services do not send Origin
  try {
    const origin = new URL(String(supplied)).origin;
    const publicOrigin = new URL(PUBLIC_SITE_URL).origin;
    if (origin === publicOrigin) return true;
    // Localhost/LAN preview is permitted only when the configured origin is HTTP.
    return publicOrigin.startsWith('http://') && origin === `http://${req.headers.host}`;
  } catch { return false; }
}

const server = http.createServer((req, res) => {
  applySecurityHeaders(res);
  if (!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(req.method)) return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS' });
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && (req.headers['sec-fetch-site'] === 'cross-site' || !browserOriginAllowed(req))) return json(res, 403, { ok: false, error: 'Запит з іншого сайту заблоковано (Origin)' });
  req.homecraftRequestId = requestId();
  const started = Date.now();
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return send(res, 400, 'Bad Request'); }
  const finishLog = () => {
    const pathForLog = url.pathname.startsWith('/uploads/') ? '/uploads/*' : url.pathname;
    logLine(url.pathname.startsWith('/api/') ? 'info' : 'debug', 'HTTP request', {
      requestId: req.homecraftRequestId,
      method: req.method,
      path: pathForLog,
      status: res.statusCode,
      ms: Date.now() - started,
      ip: clientIp(req),
      userAgent: req.headers['user-agent'] || ''
    });
  };
  res.on('finish', finishLog);
  if (['GET','HEAD'].includes(req.method) && url.pathname === '/api/health/ready') return json(res, 200, { ok: true, ready: true });
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  // Canonicalize public pages rather than offering duplicate .html URLs.
  if (['GET','HEAD'].includes(req.method)) {
    const route = url.pathname.match(/^\/(index|support|map|status|login|register|forgot-password|reset-password|profile|download|news|catalog)\.html$/);
    if (route) {
      res.writeHead(301, { Location: (route[1] === 'index' ? '/' : '/' + route[1]) + url.search, 'Cache-Control': 'public, max-age=3600' });
      return res.end();
    }
  }
  if (!['GET','HEAD'].includes(req.method) && !url.pathname.startsWith('/api/')) return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
  if (url.pathname === '/admin' || url.pathname === '/admin.html') return serveAdminPage(req, res);
  if (url.pathname.startsWith('/uploads/')) return serveUpload(req, res, url.pathname);
  if (url.pathname.startsWith('/server-resource-packs/')) return serveResourcePack(req, res, url.pathname);
  if (url.pathname.startsWith('/client-mods/')) return serveClientMod(req, res, url.pathname);
  return serveStatic(req, res, url.pathname);
});

server.on('error', error => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`[Home Craft] ERROR: port ${PORT} is already in use on ${HOST}.`);
    console.error('[Home Craft] Stop old Node process or change PORT in SITE/.env.');
    process.exit(48);
  }
  console.error('[Home Craft] Помилка сервера:', error);
  process.exit(1);
});

ensureDb();
readDb(); // Durable migration before accepting clients.
markServerOfflineOnBoot();
server.listen(PORT, HOST, () => {
  logLine('info', 'Site started', { host: HOST, port: PORT, publicSiteUrl: PUBLIC_SITE_URL, dataDir: DATA_DIR, uploadsDir: UPLOADS_DIR, resourcePacksDir: RESOURCE_PACKS_DIR, serverModsDir: SERVER_MODS_DIR, logDir: LOG_DIR });
  ensureResourcePackManifest();
  listClientMods();
  console.log(`[Home Craft] Site wrapper running: http://${HOST}:${PORT}`);
  console.log(`[Home Craft] Local URL: http://localhost:${PORT}`);
  console.log(`[Home Craft] Public/LAN URL for clients: ${PUBLIC_SITE_URL}`);
  console.log('[Home Craft] API status: GET /api/server/status');
  if (SERVER_SECRET === 'change-this-secret-before-public-use') {
    console.warn('[Home Craft] WARNING: change SERVER_SECRET before public deployment.');
  }
});

// The combined launcher owns this listener and the Minecraft child process.
module.exports = { server };
