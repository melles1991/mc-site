'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const seed = require('./catalog/defaults.json');
const FILE = path.resolve(__dirname, process.env.HOMECRAFT_WORLD_CATALOG_FILE || 'data/world-catalog.json');
const itemId = value => /^[a-z0-9_.-]+:[a-z0-9_/.-]+$/.test(String(value || '')) ? String(value) : '';
const text = (v, n = 128) => String(v || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, n);
const number = (v, fallback, min, max) => Number.isFinite(Number(v)) ? Math.max(min, Math.min(max, Number(v))) : fallback;
const integer = (v, fallback = 1, max = 64) => Math.trunc(number(v, fallback, 1, max));
const labels = seed.labels;
function label(v) { const key = text(v); return labels[key.replace(/^lang:/, '')] || key; }
function parseTrade(raw) {
  const fields = {};
  if (typeof raw !== 'string' || raw.length > 1600) return null;
  for (const field of raw.replace(/;/g, ',').split(',')) {
    const eq = field.indexOf('='); if (eq > 0) fields[field.slice(0, eq).trim().toLowerCase()] = field.slice(eq + 1).trim();
  }
  const sell = itemId(fields.sell), buy = itemId(fields.buy);
  if (!sell || !buy) return null;
  const costs = [{ itemId: buy, count: integer(fields.buycount) }];
  if (itemId(fields.buy2)) costs.push({ itemId: itemId(fields.buy2), count: integer(fields.buy2count) });
  return { itemId: sell, count: integer(fields.sellcount), costs, name: label(fields.namekey || fields.name || ''), nameKey: text(fields.namekey),
    role: text(fields.role || 'any', 32), limit: Math.trunc(number(fields.limit, 0, 0, 9999)), reset: text(fields.reset || 'never', 32),
    enchants: text(fields.ench || '', 512), extraDamage: number(fields.damage, 0, 0, 16) };
}
function normalizeNpcs(raw) {
  const list = [], seen = new Set();
  for (const v of Array.isArray(raw) ? raw.slice(0, 64) : []) {
    if (!v || typeof v !== 'object' || !/^[a-z0-9_-]{1,64}$/.test(String(v.id || '')) || seen.has(v.id)) continue;
    seen.add(v.id);
    const pos = v.position || v;
    const coordinates = [pos.x, pos.y, pos.z].map(Number);
    const validPosition = [pos.x, pos.y, pos.z].every(x => x !== null && x !== undefined && x !== '')
      && coordinates.every(Number.isFinite) && Math.abs(coordinates[0]) <= 30000000 && Math.abs(coordinates[2]) <= 30000000
      && coordinates[1] >= -4096 && coordinates[1] <= 4096 && itemId(pos.dimension);
    const trades = (Array.isArray(v.trades) ? v.trades : String(v.trades || '').split('~')).slice(0, 66).map(parseTrade).filter(Boolean);
    list.push({ id: v.id, name: label(v.name) || v.id, kind: v.kind === 'system' ? 'system' : 'trader', enabled: v.enabled === true,
      position: validPosition ? { x: coordinates[0], y: coordinates[1], z: coordinates[2], dimension: pos.dimension } : null, trades });
  }
  return list;
}
let cached = null, stamp = -1;
function runtime() {
  try {
    const stat = fs.statSync(FILE); if (stat.mtimeMs !== stamp) { const value = JSON.parse(fs.readFileSync(FILE, 'utf8')); cached = { updatedAt: value.updatedAt, npcs: normalizeNpcs(value.npcs) }; stamp = stat.mtimeMs; }
    return cached;
  } catch { return null; }
}
function syncWorld(body) {
  if (!body || !Array.isArray(body.npcs)) throw new Error('Потрібен масив npcs');
  const state = { schemaVersion: 1, updatedAt: new Date().toISOString(), npcs: normalizeNpcs(body.npcs) };
  // Persist only bounded public NPC metadata, never the request object or credentials.
  // Trade normalization stays at the read boundary; store original validated-size specs for round-tripping.
  const rawById = new Map();
  for (const v of body.npcs.slice(0, 64)) if (v && typeof v.id === 'string' && !rawById.has(v.id)) rawById.set(v.id, v);
  const stored = { ...state, npcs: state.npcs.map(n => ({ ...n, trades: (Array.isArray(rawById.get(n.id)?.trades) ? rawById.get(n.id).trades : String(rawById.get(n.id)?.trades || '').split('~')).filter(v => typeof v === 'string' && v.length <= 1600 && parseTrade(v)).slice(0, 66) })) };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp-' + crypto.randomBytes(6).toString('hex');
  try { fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 }); fs.renameSync(tmp, FILE); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  cached = state; stamp = fs.statSync(FILE).mtimeMs;
  return { updatedAt: state.updatedAt, npcCount: state.npcs.length };
}
function category(id) {
  if (/(sword|bow|trident|mace|arrow)$/.test(id)) return 'weapons';
  if (/(helmet|chestplate|leggings|boots|shield|armor|elytra)$/.test(id)) return 'armor';
  if (/(pickaxe|axe|shovel|hoe|shears|fishing_rod)$/.test(id)) return 'tools';
  if (/(bread|potato|chicken|cod|salmon|mutton|porkchop|beef|pie|apple|carrot|slice|soup|stew|honey_bottle)$/.test(id)) return 'food';
  return 'supplies';
}
function readCatalog() {
  const live = runtime(), npcs = live ? live.npcs : normalizeNpcs(seed.traders);
  const stale = !!live && Date.now() - Date.parse(live.updatedAt) > 180000;
  const items = new Map(seed.items.map(v => [v.itemId, { ...v, id: v.itemId, custom: true, offers: [] }]));
  const traders = npcs.map(n => ({ ...n, enabled: live ? n.enabled : null, source: live ? 'server' : 'defaults', stale, trades: undefined, offerCount: n.trades.length }));
  for (const npc of npcs) for (const offer of npc.trades) {
    const base = seed.items.find(v => v.itemId === offer.itemId);
    const id = base ? base.itemId : offer.itemId + '--' + crypto.createHash('sha1').update(JSON.stringify([offer.name, offer.enchants, offer.extraDamage])).digest('hex').slice(0, 10);
    if (!items.has(id)) items.set(id, { id, itemId: offer.itemId, name: offer.name || labels[offer.itemId] || offer.itemId.split(':')[1].replace(/_/g, ' '), category: category(offer.itemId), description: '', icon: '/assets/items/'+category(offer.itemId)+'.svg', custom: !!offer.name || !!offer.enchants || offer.extraDamage > 0, recipe: null, enchants: offer.enchants, extraDamage: offer.extraDamage, offers: [] });
    items.get(id).offers.push({ ...offer, traderId: npc.id, traderName: npc.name, active: live ? npc.enabled : null });
  }
  return { schemaVersion: 1, source: live ? 'server' : 'defaults', updatedAt: live?.updatedAt || null, stale, items: Array.from(items.values()), traders,
    labels: Object.fromEntries(Object.entries(labels).filter(([k]) => k.startsWith('minecraft:'))) };
}
function readNpcs() {
  const catalog = readCatalog();
  return { source: catalog.source, updatedAt: catalog.updatedAt, stale: catalog.stale,
    npcs: catalog.traders.filter(n => n.enabled === true && n.position).map(n => ({ ...n, offers: catalog.items.flatMap(i => i.offers.filter(o => o.traderId === n.id).map(o => ({ name: i.name, itemId: i.itemId, count: o.count, costs: o.costs }))).slice(0, 66) })) };
}
module.exports = { readCatalog, syncWorld, readNpcs, normalizeNpcs, parseTrade };
