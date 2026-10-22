#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const siteRoot = path.resolve(__dirname, '..');
const inputPack = path.resolve(process.argv[2] || path.join(siteRoot, 'data', 'server-resource-packs', 'homecraft-resource-pack.zip'));
const outRoot = path.join(siteRoot, 'public', 'assets', 'map-blocks');
const outTextures = path.join(outRoot, 'textures');
const tempRoot = path.join(siteRoot, '.tmp-map-atlas');
const namespace = 'minecraft';

function rmrf(dir) { fs.rmSync(dir, { recursive: true, force: true }); }
function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function exists(file) { try { return fs.existsSync(file); } catch { return false; } }
function normSlash(value) { return String(value || '').replace(/\\/g, '/'); }
function stripExt(file) { return file.replace(/\.json$/i, ''); }

function extractZip(zip, dest) {
  rmrf(dest);
  mkdir(dest);
  let result;
  if (process.platform === 'win32') {
    result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath ${JSON.stringify(zip)} -DestinationPath ${JSON.stringify(dest)} -Force`], { stdio: 'inherit' });
  } else {
    result = spawnSync('unzip', ['-q', zip, '-d', dest], { stdio: 'inherit' });
  }
  if (result.error || result.status !== 0) {
    throw new Error('Не вдалося розпакувати resource pack. Перевір шлях до zip або встановлений unzip/PowerShell.');
  }
}

function listFiles(dir, ext, out = []) {
  if (!exists(dir)) return out;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) listFiles(full, ext, out);
    else if (item.isFile() && item.name.toLowerCase().endsWith(ext)) out.push(full);
  }
  return out;
}

function texturePathFromRef(ref) {
  if (!ref || typeof ref !== 'string') return null;
  let value = ref.trim();
  if (!value) return null;
  if (!value.includes(':')) value = `${namespace}:${value}`;
  const [ns, id] = value.split(':', 2);
  if (!id) return null;
  return { ns, id: id.replace(/^textures\//, '').replace(/\.png$/i, '') };
}

function modelFileFor(modelId) {
  let value = String(modelId || '').trim();
  if (!value) return null;
  if (!value.includes(':')) value = `${namespace}:${value}`;
  const [ns, id] = value.split(':', 2);
  if (!id) return null;
  return path.join(tempRoot, 'assets', ns, 'models', `${id}.json`);
}

function textureFileFor(textureRef) {
  const ref = texturePathFromRef(textureRef);
  if (!ref) return null;
  return path.join(tempRoot, 'assets', ref.ns, 'textures', `${ref.id}.png`);
}

const modelCache = new Map();
function readModel(modelId, depth = 0) {
  if (!modelId || depth > 12) return null;
  const key = String(modelId);
  if (modelCache.has(key)) return modelCache.get(key);
  const file = modelFileFor(modelId);
  const model = file ? readJson(file) : null;
  if (!model) { modelCache.set(key, null); return null; }

  let textures = { ...(model.textures || {}) };
  let parent = null;
  if (model.parent) parent = readModel(model.parent, depth + 1);
  if (parent && parent.textures) textures = { ...parent.textures, ...textures };

  const merged = { ...model, textures, parentModel: parent };
  modelCache.set(key, merged);
  return merged;
}

function resolveTextureRef(textures, value, safety = 0) {
  if (!value || safety > 16) return null;
  if (typeof value !== 'string') return null;
  if (value.startsWith('#')) {
    const key = value.slice(1);
    return resolveTextureRef(textures, textures?.[key], safety + 1);
  }
  return value;
}

function findTopTexture(model) {
  if (!model || !model.textures) return null;
  const textures = model.textures;
  const preferred = ['up', 'top', 'all', 'end', 'texture', 'side', 'north', 'particle'];
  for (const key of preferred) {
    const resolved = resolveTextureRef(textures, textures[key]);
    if (resolved && textureFileFor(resolved) && exists(textureFileFor(resolved))) return resolved;
  }
  for (const value of Object.values(textures)) {
    const resolved = resolveTextureRef(textures, value);
    if (resolved && textureFileFor(resolved) && exists(textureFileFor(resolved))) return resolved;
  }
  return null;
}

function candidateModelsFromBlockstate(blockstate) {
  const models = [];
  if (!blockstate || typeof blockstate !== 'object') return models;
  if (blockstate.variants && typeof blockstate.variants === 'object') {
    for (const variant of Object.values(blockstate.variants)) {
      if (Array.isArray(variant)) {
        for (const entry of variant) if (entry?.model) models.push(entry.model);
      } else if (variant?.model) {
        models.push(variant.model);
      }
    }
  }
  if (Array.isArray(blockstate.multipart)) {
    for (const part of blockstate.multipart) {
      const apply = part?.apply;
      if (Array.isArray(apply)) for (const entry of apply) if (entry?.model) models.push(entry.model);
      else if (apply?.model) models.push(apply.model);
    }
  }
  return [...new Set(models)];
}

function relativeOutTexture(textureRef) {
  const ref = texturePathFromRef(textureRef);
  return ref ? normSlash(path.join('textures', ref.ns, `${ref.id}.png`)) : null;
}

function copyTexture(textureRef) {
  const src = textureFileFor(textureRef);
  if (!src || !exists(src)) return null;
  const ref = texturePathFromRef(textureRef);
  const rel = relativeOutTexture(textureRef);
  const dest = path.join(outRoot, rel);
  mkdir(path.dirname(dest));
  fs.copyFileSync(src, dest);
  return rel;
}


function addTextureNameHeuristics(blocks) {
  const textureDir = path.join(tempRoot, 'assets', namespace, 'textures', 'block');
  const files = listFiles(textureDir, '.png');
  const priority = new Map();
  const priorities = { exact: 80, top: 100, end: 90, still: 95, side: 30, generic: 20 };

  function setCandidate(blockName, textureRef, kind) {
    if (!/^[a-z0-9_./-]+$/.test(blockName)) return;
    const blockId = `${namespace}:${blockName}`;
    const score = priorities[kind] || 1;
    const current = priority.get(blockId) || 0;
    if (blocks[blockId] && current >= score) return;
    const rel = copyTexture(textureRef);
    if (!rel) return;
    blocks[blockId] = rel;
    priority.set(blockId, score);
  }

  for (const file of files) {
    const rel = normSlash(path.relative(textureDir, file));
    const name = rel.replace(/\.png$/i, '');
    const ref = `${namespace}:block/${name}`;

    setCandidate(name, ref, 'exact');
    if (name.endsWith('_top')) setCandidate(name.slice(0, -4), ref, 'top');
    if (name.endsWith('_end')) setCandidate(name.slice(0, -4), ref, 'end');
    if (name.endsWith('_still')) setCandidate(name.slice(0, -6), ref, 'still');
    if (name.endsWith('_side')) setCandidate(name.slice(0, -5), ref, 'side');
    if (name.endsWith('_front')) setCandidate(name.slice(0, -6), ref, 'side');
    if (name.endsWith('_bottom')) setCandidate(name.slice(0, -7), ref, 'side');
  }
}

function main() {
  if (!exists(inputPack)) throw new Error(`Resource pack не знайдено: ${inputPack}`);
  extractZip(inputPack, tempRoot);
  rmrf(outRoot);
  mkdir(outTextures);

  const blockstatesDir = path.join(tempRoot, 'assets', namespace, 'blockstates');
  const blocks = {};
  let copied = 0;

  for (const file of listFiles(blockstatesDir, '.json')) {
    const rel = normSlash(path.relative(blockstatesDir, file));
    const blockName = stripExt(rel);
    const blockId = `${namespace}:${blockName}`;
    const blockstate = readJson(file);
    const models = candidateModelsFromBlockstate(blockstate);
    let chosen = null;
    for (const modelId of models) {
      const model = readModel(modelId);
      chosen = findTopTexture(model);
      if (chosen) break;
    }
    if (!chosen) {
      const direct = `minecraft:block/${blockName}`;
      if (exists(textureFileFor(direct))) chosen = direct;
    }
    const relTexture = chosen ? copyTexture(chosen) : null;
    if (relTexture) {
      blocks[blockId] = relTexture;
      copied++;
    }
  }

  // Many resource packs override textures without shipping blockstate/model JSON.
  // Add convention-based mappings so the web map can still use the real pack pixels.
  addTextureNameHeuristics(blocks);

  // A few vanilla water/lava-like blocks use animated still textures and may not be resolved from simple models.
  const aliases = {
    'minecraft:water': 'minecraft:block/water_still',
    'minecraft:lava': 'minecraft:block/lava_still',
    // Mature/recognizable agriculture textures for readable web-map rendering.
    'minecraft:wheat': 'minecraft:block/wheat_stage7',
    'minecraft:carrots': 'minecraft:block/carrots_stage3',
    'minecraft:potatoes': 'minecraft:block/potatoes_stage3',
    'minecraft:beetroots': 'minecraft:block/beetroots_stage3',
    'minecraft:sugar_cane': 'minecraft:block/sugar_cane',
    'minecraft:cactus': 'minecraft:block/cactus_top',
    'minecraft:bamboo': 'minecraft:block/bamboo_stalk',
    'minecraft:pumpkin': 'minecraft:block/pumpkin_top',
    'minecraft:melon': 'minecraft:block/melon_top',
    'minecraft:farmland': 'minecraft:block/farmland_moist',
    'minecraft:hay_block': 'minecraft:block/hay_block_top',
    'minecraft:composter': 'minecraft:block/composter_top'
  };
  for (const [blockId, tex] of Object.entries(aliases)) {
    const rel = copyTexture(tex);
    if (rel) blocks[blockId] = rel;
  }

  const atlas = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: path.basename(inputPack),
    base: '/assets/map-blocks/',
    note: 'Generated locally from the server resource pack. Do not commit copyrighted vanilla assets unless you have rights to distribute them.',
    blocks
  };
  fs.writeFileSync(path.join(outRoot, 'block-atlas.json'), JSON.stringify(atlas, null, 2));
  rmrf(tempRoot);
  console.log(`[Home Craft] Map texture atlas ready: ${Object.keys(blocks).length} block texture mappings`);
  console.log(`[Home Craft] Output: ${path.join(outRoot, 'block-atlas.json')}`);
}

try { main(); }
catch (error) { console.error('[Home Craft] Atlas build failed:', error.message); process.exit(1); }
