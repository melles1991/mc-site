'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class IdentityError extends Error {
  constructor(message, status = 409) { super(message); this.status = status; }
}
const validUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
function validNick(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(value)) throw new IdentityError('Нік: 3–16 латинських літер, цифр або _.', 400);
  return value;
}
function atomicJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

/** Permanent ownership history, independent of users.json. One Node process owns this database. */
class CharacterRegistry {
  constructor(file) { this.file = file; this.marker = `${file}.initialized`; }
  load(users) {
    if (!fs.existsSync(this.file)) {
      if (fs.existsSync(this.marker)) throw new IdentityError('Реєстр персонажів відсутній. Вхід заблоковано до відновлення реєстру.', 503);
      this.save({ schema: 1, bootstrapped: users.length > 0, migrationComplete: false, characters: [] });
    }
    let state;
    try { state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch { throw new IdentityError('Реєстр персонажів пошкоджений. Автоматичне очищення заборонене.', 503); }
    if (state.schema !== 1 || !Array.isArray(state.characters) || typeof state.bootstrapped !== 'boolean' || typeof state.migrationComplete !== 'boolean')
      throw new IdentityError('Некоректний формат реєстру персонажів.', 503);
    if ('adminIds' in state && (!Array.isArray(state.adminIds) || state.adminIds.some(id => !validUuid(id))))
      throw new IdentityError('Пошкоджений реєстр адміністраторів.', 503);
    const names = new Set(), uuids = new Set(), ids = new Set();
    for (const c of state.characters) {
      if (!c || !validUuid(c.id) || !validUuid(c.ownerId) || !validUuid(c.uuid) || !/^[A-Za-z0-9_]{3,16}$/.test(c.nick)
          || typeof c.legacyVerified !== 'boolean' || !['active', 'retired'].includes(c.status) || names.has(c.nick.toLowerCase()) || uuids.has(c.uuid.toLowerCase()) || ids.has(c.id))
        throw new IdentityError('Конфлікт або пошкодження власників персонажів. Потрібне відновлення реєстру.', 503);
      names.add(c.nick.toLowerCase()); uuids.add(c.uuid.toLowerCase()); ids.add(c.id);
    }
    if (!fs.existsSync(this.marker)) fs.writeFileSync(this.marker, 'Permanent character ownership registry. Do not delete.\n', { mode: 0o600 });
    return state;
  }
  save(state) {
    atomicJson(this.file, state);
    if (!fs.existsSync(this.marker)) fs.writeFileSync(this.marker, 'Permanent character ownership registry. Do not delete.\n', { mode: 0o600 });
  }
  reconcile(users) {
    const accountIds = new Set();
    for (const user of users) {
      if (!user || !validUuid(user.id) || accountIds.has(user.id)) throw new IdentityError('Некоректні або повторні ID акаунтів.', 503);
      accountIds.add(user.id);
    }
    const liveNames = new Set(), liveUuids = new Set();
    for (const user of users) if (user.minecraftNick && user.minecraftUuid) {
      const n = String(user.minecraftNick).toLowerCase(), u = String(user.minecraftUuid).toLowerCase();
      if (liveNames.has(n) || liveUuids.has(u)) throw new IdentityError('Дублікати ніка або UUID у старій базі. Автоматична міграція заблокована.', 503);
      liveNames.add(n); liveUuids.add(u);
    }
    const state = this.load(users); let changed = false, usersChanged = false;
    const live = new Map(users.map(u => [u.id, u]));
    for (const c of state.characters) {
      const user = live.get(c.ownerId);
      if (c.status === 'active' && (!user || user.minecraftNick !== c.nick || String(user.minecraftUuid || '').toLowerCase() !== c.uuid
          || (user.minecraftCharacterId && user.minecraftCharacterId !== c.id))) {
        c.status = 'retired'; c.retiredAt = new Date().toISOString(); changed = true;
      }
    }
    for (const user of users) {
      if (!user.minecraftNick || !user.minecraftUuid) continue;
      const nick = validNick(user.minecraftNick), uuid = String(user.minecraftUuid).toLowerCase();
      if (!validUuid(uuid) || !validUuid(user.id)) throw new IdentityError('Некоректний UUID у старому профілі.', 503);
      let c = state.characters.find(c => c.nick.toLowerCase() === nick.toLowerCase() || c.uuid === uuid || c.id === user.minecraftCharacterId);
      if (c) {
        // Never recreate, reactivate or transfer a retired identity from editable user data.
        if (c.ownerId !== user.id || c.nick !== nick || c.uuid !== uuid || c.status !== 'active'
            || (user.minecraftCharacterId && user.minecraftCharacterId !== c.id)) continue;
      } else {
        if (state.migrationComplete) continue; // Imports are allowed only during the initial trusted migration.
        c = { id: crypto.randomUUID(), ownerId: user.id, nick, uuid, status: 'active', createdAt: new Date().toISOString(),
          legacyVerified: String(user.minecraftVerifiedUuid || '').toLowerCase() === uuid && Boolean(user.minecraftVerifiedAt) };
        state.characters.push(c); changed = true;
      }
      if (user.minecraftCharacterId !== c.id) { user.minecraftCharacterId = c.id; usersChanged = true; }
    }
    if (!state.migrationComplete) { state.migrationComplete = true; changed = true; }
    if (changed) this.save(state);
    return { state, usersChanged };
  }
  active(state, user) {
    if (!user || !user.minecraftCharacterId) return null;
    return state.characters.find(c => c.id === user.minecraftCharacterId && c.ownerId === user.id && c.status === 'active'
      && c.nick === user.minecraftNick && c.uuid === String(user.minecraftUuid || '').toLowerCase()) || null;
  }
  claim(state, user, nick, uuid) {
    validNick(nick); uuid = String(uuid || '').toLowerCase();
    if (!validUuid(uuid)) throw new IdentityError('Некоректний UUID персонажа.', 400);
    const current = this.active(state, user);
    if (current) {
      if (current.nick !== nick || current.uuid !== uuid) throw new IdentityError('Персонаж уже прив’язаний. Змінювати його нік або UUID через прив’язку заборонено.');
      return current;
    }
    if (user.minecraftCharacterId || user.minecraftNick || user.minecraftUuid)
      throw new IdentityError('Стара прив’язка недійсна. Спочатку видали її через керування персонажем.');
    if (state.characters.some(c => c.nick.toLowerCase() === nick.toLowerCase() || c.uuid === uuid))
      throw new IdentityError('Цей нік або UUID назавжди зарезервовано за іншим чи видаленим персонажем. Обери новий нік.');
    const c = { id: crypto.randomUUID(), ownerId: user.id, nick, uuid, status: 'active', createdAt: new Date().toISOString(), legacyVerified: false };
    state.characters.push(c); this.save(state);
    user.minecraftNick = nick; user.minecraftUuid = uuid; user.minecraftCharacterId = c.id;
    delete user.minecraftVerifiedUuid; delete user.minecraftVerifiedAt;
    return c;
  }
  retire(state, user) {
    for (const c of state.characters) if (c.ownerId === user.id && c.status === 'active') {
      c.status = 'retired'; c.retiredAt = new Date().toISOString();
    }
    this.save(state); // Tombstone is durable before the user loses the link.
    user.minecraftNick = null; user.minecraftUuid = null; user.minecraftCharacterId = null;
    delete user.minecraftVerifiedUuid; delete user.minecraftVerifiedAt;
    user.skin = { skinUrl: '', capeUrl: '', skinModel: 'classic', updatedAt: null };
  }
  firstAdmin(state, users) {
    if (state.bootstrapped || users.length) return false;
    state.bootstrapped = true; this.save(state); return true;
  }
}
module.exports = { CharacterRegistry, IdentityError, validNick, validUuid };
