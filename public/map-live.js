(() => {
  'use strict';

  const canvas = document.getElementById('world-map-canvas');
  const wrap = document.getElementById('map-canvas-wrap');
  if (!canvas || !wrap) return;

  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const els = {
    liveDot: document.getElementById('map-live-dot'),
    liveTitle: document.getElementById('map-live-title'),
    liveSubtitle: document.getElementById('map-live-subtitle'),
    meta: document.getElementById('map-meta'),
    playerCount: document.getElementById('map-player-count'),
    playerList: document.getElementById('map-player-list'),
    spawnCoords: document.getElementById('map-spawn-coords'),
    spawnRadius: document.getElementById('map-spawn-radius'),
    renderCount: document.getElementById('map-render-count'),
    territoryCount: document.getElementById('map-territory-count'),
    renderSubtitle: document.getElementById('map-render-subtitle'),
    centerBtn: document.getElementById('map-center-btn'),
    zoomIn: document.getElementById('map-zoom-in'),
    zoomOut: document.getElementById('map-zoom-out'),
    reset: document.getElementById('map-reset')
  };

  const INDEX_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const TILE_CANVAS_CELL = 16;
  const MAX_CLIENT_TILES = 1200;
  const MAX_VISIBLE_TILES = 380;
  const MAX_TILE_BUILDS_PER_FRAME = 14;
  const MAX_TILE_BUILDS_IDLE = 40;
  const REFRESH_MS = 6000;
  const FULL_REFRESH_MS = 300000;
  const MAP_CLIENT_VERSION = 66;

  const tileCache = new Map();
  let tileList = [];
  const imageCache = new Map();
  const blockCanvasCache = new Map();
  const atlas = { loaded: false, loading: null, version: 0, blocks: {}, base: '/assets/map-blocks/' };
  const view = { centerX: 0, centerZ: 0, scale: 3.2, ready: false };
  let state = null;
  let dpr = 1;
  let width = 1;
  let height = 1;
  let dragging = false;
  let dragLast = null;
  let drawQueued = false;
  let loadingMap = false;
  let lastPlayersSignature = '';
  let lastInfoSignature = '';
  let lastTileCursor = '';
  let lastFullFetchAt = 0;
  let tileTouchClock = 0;
  let textureInvalidateTimer = 0;
  let needsAnotherDraw = false;

  const npcLayer = document.createElement('div'); npcLayer.className = 'map-npc-layer'; wrap.append(npcLayer);
  const npcTooltip = document.createElement('div'); npcTooltip.className = 'map-npc-tooltip'; npcTooltip.id = 'map-npc-tooltip'; npcTooltip.setAttribute('role','tooltip'); npcTooltip.hidden = true; wrap.append(npcTooltip);
  const npcButtons = new Map();
  let npcSignature = '', tooltipNpc = null, tooltipPinned = false, activeDimension = '', requestedNpc = new URLSearchParams(location.search).get('npc');
  const dimSelect = document.getElementById('map-dimension');
  const npcList = document.getElementById('map-npc-list');
  const npcToggle = document.getElementById('map-npcs-visible');
  const dimNames = {'minecraft:overworld':'Звичайний світ','minecraft:the_nether':'Незер','minecraft:the_end':'Енд'};
  const costText = offer => offer.costs.map(c=>`${c.count} ${c.itemId==='minecraft:emerald'?'смарагд.':c.itemId.split(':').pop().replace(/_/g,' ')}`).join(' + ');
  function focusNpc(npc) {
    if(npcToggle)npcToggle.checked=true;
    activeDimension = npc.position.dimension; if(dimSelect)dimSelect.value=activeDimension;
    view.centerX=npc.position.x; view.centerZ=npc.position.z; view.scale=Math.max(5,view.scale);
    tooltipPinned=true; tooltipNpc=npc.id; showNpcTooltip(npc); lastInfoSignature='';renderInfo(state||{});requestDraw();
  }
  function showNpcTooltip(npc) {
    tooltipNpc=npc.id;
    npcTooltip.innerHTML=`<span class="eyebrow">${npc.kind==='system'?'Гільдійний NPC':'Торговець'}</span><strong>${esc(npc.name)}</strong><small>X ${fmt(npc.position.x)} · Y ${fmt(npc.position.y)} · Z ${fmt(npc.position.z)}</small>${(npc.offers||[]).slice(0,3).map(o=>`<p><span>${esc(o.name)} ×${o.count}</span><b>${esc(costText(o))}</b></p>`).join('')}${npc.offerCount>3?`<small>Ще ${npc.offerCount-3} пропозицій у каталозі</small>`:''}${state?.npcState?.stale?'<small>Збережена позиція · очікуємо оновлення</small>':''}`;
    npcTooltip.hidden=false;positionNpcTooltip(npc);
  }
  function positionNpcTooltip(npc) {
    const p=worldToScreen(npc.position.x,npc.position.z);
    if(p.x<0||p.x>width||p.y<0||p.y>height||npc.position.dimension!==activeDimension){npcTooltip.hidden=true;return;}
    npcTooltip.style.left=clamp(p.x+20,8,Math.max(8,width-290))+'px';
    npcTooltip.style.top=clamp(p.y+18,8,Math.max(8,height-npcTooltip.offsetHeight-12))+'px';
  }
  function renderNpcs(map) {
    const npcs=Array.isArray(map.npcState?.npcs)?map.npcState.npcs:[];
    const dimensions=[...new Set([...Object.keys(dimNames),map.spawn?.dimension||'minecraft:overworld',...tileList.map(t=>t.dimension),...npcs.map(n=>n.position.dimension),...(map.players||[]).map(p=>p.dimension).filter(Boolean)])];
    if(!activeDimension)activeDimension=map.spawn?.dimension||'minecraft:overworld';
    if(dimSelect && dimSelect.dataset.options!==dimensions.join('|')){dimSelect.innerHTML=dimensions.map(d=>`<option value="${esc(d)}">${esc(dimNames[d]||d)}</option>`).join('');dimSelect.dataset.options=dimensions.join('|');dimSelect.value=activeDimension;}
    if(requestedNpc){const target=npcs.find(n=>n.id===requestedNpc);if(target){requestedNpc=null;focusNpc(target);}}
    const signature=JSON.stringify(npcs);
    if(signature!==npcSignature){
      npcSignature=signature;npcLayer.replaceChildren();npcButtons.clear();
      for(const npc of npcs){
        const button=document.createElement('button');button.type='button';button.className='map-npc-marker '+npc.kind;button.textContent=npc.kind==='system'?'⚑':'◇';button.setAttribute('aria-label',npc.name+' — '+(npc.kind==='system'?'гільдійний NPC':'торговець'));button.setAttribute('aria-describedby','map-npc-tooltip');
        button.addEventListener('pointerenter',()=>{if(!tooltipPinned)showNpcTooltip(npc);});
        button.addEventListener('pointerleave',()=>{if(!tooltipPinned)npcTooltip.hidden=true;});
        button.addEventListener('focus',()=>showNpcTooltip(npc));
        button.addEventListener('blur',()=>{if(!tooltipPinned)npcTooltip.hidden=true;});
        button.addEventListener('click',e=>{e.stopPropagation();if(tooltipPinned&&tooltipNpc===npc.id){tooltipPinned=false;tooltipNpc=null;npcTooltip.hidden=true;}else{tooltipPinned=true;showNpcTooltip(npc);}});
        npcLayer.append(button);npcButtons.set(npc.id,button);
      }
      if(npcList){npcList.innerHTML=npcs.length?npcs.map(n=>`<div class="map-npc-row"><button type="button" data-focus-npc="${esc(n.id)}"><strong>${esc(n.name)}</strong><small>${esc(dimNames[n.position.dimension]||n.position.dimension)} · ${n.offerCount} пропозицій</small></button>${n.offerCount?`<a href="/catalog?vendor=${encodeURIComponent(n.id)}" aria-label="Каталог: ${esc(n.name)}">↗</a>`:''}</div>`).join(''):'<p class="map-empty">Позиції NPC з’являться після синхронізації з ігровим сервером.</p>';}
      if(tooltipPinned){const current=npcs.find(n=>n.id===tooltipNpc);if(current)showNpcTooltip(current);else{tooltipPinned=false;tooltipNpc=null;npcTooltip.hidden=true;}}else npcTooltip.hidden=true;
    }
    for(const npc of npcs){const b=npcButtons.get(npc.id),p=worldToScreen(npc.position.x,npc.position.z);b.hidden=npcToggle?.checked===false||npc.position.dimension!==activeDimension||p.x<0||p.x>width||p.y<0||p.y>height;b.style.left=p.x+'px';b.style.top=p.y+'px';}
    if(tooltipNpc&&!npcTooltip.hidden){const npc=npcs.find(n=>n.id===tooltipNpc);if(npc&&npcToggle?.checked!==false)positionNpcTooltip(npc);else npcTooltip.hidden=true;}
    const note=document.getElementById('map-npc-note');if(note)note.textContent=map.npcState?.stale?'Збережені позиції · очікуємо оновлення':npcs.length?`${npcs.length} NPC · наведи курсор або торкнися мітки`:'Очікуємо першу синхронізацію NPC';
  }
  npcList?.addEventListener('click',e=>{const b=e.target.closest('[data-focus-npc]');if(b){const n=state?.npcState?.npcs?.find(n=>n.id===b.dataset.focusNpc);if(n)focusNpc(n);}});
  dimSelect?.addEventListener('change',()=>{activeDimension=dimSelect.value;tooltipPinned=false;npcTooltip.hidden=true;const first=state?.npcState?.npcs?.find(n=>n.position.dimension===activeDimension),tile=tileList.find(t=>t.dimension===activeDimension);view.centerX=first?.position.x??(tile?(tile.tx+.5)*tile.size:0);view.centerZ=first?.position.z??(tile?(tile.tz+.5)*tile.size:0);lastInfoSignature='';renderInfo(state||{});requestDraw();});
  npcToggle?.addEventListener('change',()=>{npcTooltip.hidden=true;requestDraw();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){tooltipPinned=false;tooltipNpc=null;npcTooltip.hidden=true;}});

  function fmt(value) {
    const n = Number(value);
    return Number.isFinite(n) ? String(Math.round(n)) : '0';
  }

  function esc(text) {
    return String(text || '').replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function cursorTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) {
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function newerCursor(a, b) {
    return cursorTime(a) >= cursorTime(b) ? a : b;
  }

  function requestDraw() {
    if (drawQueued) return;
    drawQueued = true;
    requestAnimationFrame(() => {
      drawQueued = false;
      draw();
    });
  }

  function scheduleTextureInvalidate() {
    if (textureInvalidateTimer) return;
    textureInvalidateTimer = window.setTimeout(() => {
      textureInvalidateTimer = 0;
      atlas.version++;
      blockCanvasCache.clear();
      requestDraw();
    }, 220);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const nextDpr = Math.min(window.devicePixelRatio || 1, 1.75);
    const nextWidth = Math.max(1, Math.floor(rect.width));
    const nextHeight = Math.max(1, Math.floor(rect.height));
    if (nextDpr === dpr && nextWidth === width && nextHeight === height) return;
    dpr = nextDpr;
    width = nextWidth;
    height = nextHeight;
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    requestDraw();
  }

  function screenToWorld(px, py) {
    return {
      x: view.centerX + (px - width / 2) / view.scale,
      z: view.centerZ + (py - height / 2) / view.scale
    };
  }

  function worldToScreen(x, z) {
    return {
      x: width / 2 + (x - view.centerX) * view.scale,
      y: height / 2 + (z - view.centerZ) * view.scale
    };
  }

  function resetView(map, keepZoom = false) {
    const spawn = map?.spawn || { x: 0, z: 0, radius: 96 };
    activeDimension=spawn.dimension||'minecraft:overworld';if(dimSelect)dimSelect.value=activeDimension;
    view.centerX = Number(spawn.x || 0);
    view.centerZ = Number(spawn.z || 0);
    if (!keepZoom) {
      const radius = Math.max(96, Number(spawn.radius || 96));
      const fit = Math.min(width, height) / Math.max(220, radius * 2.55);
      view.scale = clamp(fit, 1.35, 6.5);
    }
    view.ready = true;
    requestDraw();
  }

  function zoomAt(px, py, factor) {
    const before = screenToWorld(px, py);
    view.scale = clamp(view.scale * factor, 0.35, 20);
    const after = screenToWorld(px, py);
    view.centerX += before.x - after.x;
    view.centerZ += before.z - after.z;
    requestDraw();
  }

  function normalizePaletteValue(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
    if (/^minecraft:[a-z0-9_./-]+$/.test(raw)) return raw;
    return '';
  }

  function tileKey(tile) {
    const dimension = String(tile.dimension || 'minecraft:overworld');
    const size = Math.round(Number(tile.size || 16));
    const tx = Math.round(Number(tile.tx ?? tile.x ?? 0));
    const tz = Math.round(Number(tile.tz ?? tile.z ?? 0));
    return `${dimension}:${size}:${tx}:${tz}`;
  }

  function decodeTile(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const size = clamp(Math.round(Number(raw.size || 16)), 4, 64);
    const data = String(raw.data || '');
    const palette = Array.isArray(raw.palette)
      ? raw.palette.map(value => normalizePaletteValue(value)).filter(Boolean).slice(0, 62)
      : [];
    if (!palette.length || data.length < size * size) return null;
    const cells = new Array(size * size);
    for (let i = 0; i < size * size; i++) {
      const idx = INDEX_ALPHABET.indexOf(data[i]);
      cells[i] = palette[idx >= 0 ? idx : 0] || 'minecraft:unknown';
    }
    return {
      key: tileKey(raw),
      tx: Math.round(Number(raw.tx ?? raw.x ?? 0)),
      tz: Math.round(Number(raw.tz ?? raw.z ?? 0)),
      size,
      dimension: String(raw.dimension || 'minecraft:overworld'),
      updatedAt: String(raw.updatedAt || ''),
      cells,
      canvas: null,
      canvasVersion: -1,
      lastUsed: ++tileTouchClock
    };
  }

  function loadBlockAtlas() {
    if (atlas.loaded) return Promise.resolve(atlas);
    if (atlas.loading) return atlas.loading;
    atlas.loading = fetch('/assets/map-blocks/block-atlas.json', { cache: 'force-cache' })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (data && typeof data === 'object') {
          atlas.base = String(data.base || '/assets/map-blocks/');
          atlas.blocks = data.blocks && typeof data.blocks === 'object' ? data.blocks : {};
        }
        atlas.loaded = true;
        atlas.version++;
        blockCanvasCache.clear();
        requestDraw();
        return atlas;
      })
      .catch(() => {
        atlas.loaded = true;
        atlas.version++;
        blockCanvasCache.clear();
        return atlas;
      });
    return atlas.loading;
  }

  function atlasImageForBlock(blockId) {
    const path = atlas.blocks?.[blockId];
    if (!path) return null;
    let image = imageCache.get(path);
    if (!image) {
      image = new Image();
      image.decoding = 'async';
      image.loading = 'lazy';
      image.onload = scheduleTextureInvalidate;
      image.src = atlas.base + path;
      imageCache.set(path, image);
    }
    return image.complete && image.naturalWidth > 0 ? image : null;
  }

  function fallbackColorForBlock(blockId) {
    const s = String(blockId || '').toLowerCase();
    if (s.startsWith('#')) return s;
    if (s.includes('unexplored')) return '#101722';
    if (s.includes('water')) return '#2f67a6';
    if (s.includes('lava')) return '#d86a20';
    if (s.includes('wheat')) return '#c5a84b';
    if (s.includes('carrot') || s.includes('pumpkin')) return '#c87935';
    if (s.includes('potato') || s.includes('hay_block')) return '#bda85b';
    if (s.includes('beetroot')) return '#8c3e45';
    if (s.includes('sugar_cane') || s.includes('bamboo') || s.includes('cactus')) return '#5c9b45';
    if (s.includes('farmland')) return '#5e422d';
    if (s.includes('grass_block')) return '#5f8f3b';
    if (s.includes('leaves') || s.includes('azalea')) return '#3f7c36';
    if (s.includes('sand')) return '#d8c783';
    if (s.includes('snow')) return '#dce8ee';
    if (s.includes('ice')) return '#9ec7da';
    if (s.includes('dirt')) return '#72543a';
    if (s.includes('deepslate')) return '#343843';
    if (s.includes('stone') || s.includes('andesite') || s.includes('tuff')) return '#74787d';
    if (s.includes('log') || s.includes('stem')) return '#72522f';
    if (s.includes('planks') || s.includes('wood')) return '#9a6a38';
    return '#66715f';
  }

  function tintForBlock(blockId) {
    const s = String(blockId || '').toLowerCase();
    if (s.includes('water')) return '#3f76e4';
    if (s.includes('grass_block') || s.endsWith(':grass') || s.includes('short_grass') || s.includes('fern')) return '#79c05a';
    if (s.includes('leaves') || s.includes('azalea')) return '#59ae30';
    if (s.includes('vine') || s.includes('moss')) return '#6baa40';
    if (s.includes('sugar_cane') || s.includes('bamboo')) return '#75b84a';
    return null;
  }

  function drawTintedImage(context, image, tint, sx, sy, size) {
    context.save();
    context.beginPath();
    context.rect(sx, sy, size, size);
    context.clip();
    context.fillStyle = tint;
    context.fillRect(sx, sy, size, size);
    context.globalCompositeOperation = 'multiply';
    context.drawImage(image, sx, sy, size, size);
    context.globalCompositeOperation = 'source-over';
    context.restore();
  }

  function paintBlockTo(context, blockId, sx, sy, size) {
    const image = atlasImageForBlock(blockId);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.filter = 'none';
    context.fillStyle = fallbackColorForBlock(blockId);
    context.fillRect(sx, sy, size, size);
    if (image) {
      const tint = tintForBlock(blockId);
      if (tint) drawTintedImage(context, image, tint, sx, sy, size);
      else context.drawImage(image, sx, sy, size, size);
    }
  }

  function blockCanvasFor(blockId) {
    const key = `${atlas.version}:${blockId}`;
    let off = blockCanvasCache.get(key);
    if (off) return off;
    off = document.createElement('canvas');
    off.width = TILE_CANVAS_CELL;
    off.height = TILE_CANVAS_CELL;
    const c = off.getContext('2d', { alpha: true });
    c.imageSmoothingEnabled = false;
    paintBlockTo(c, blockId, 0, 0, TILE_CANVAS_CELL);
    blockCanvasCache.set(key, off);
    if (blockCanvasCache.size > 512) {
      const first = blockCanvasCache.keys().next().value;
      blockCanvasCache.delete(first);
    }
    return off;
  }

  function buildTileCanvas(tile) {
    if (tile.canvas && tile.canvasVersion === atlas.version) return tile.canvas;
    const px = tile.size * TILE_CANVAS_CELL;
    const off = tile.canvas || document.createElement('canvas');
    off.width = px;
    off.height = px;
    const c = off.getContext('2d', { alpha: true });
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, px, px);
    c.imageSmoothingEnabled = false;
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.filter = 'none';
    for (let z = 0; z < tile.size; z++) {
      for (let x = 0; x < tile.size; x++) {
        c.drawImage(blockCanvasFor(tile.cells[z * tile.size + x]), x * TILE_CANVAS_CELL, z * TILE_CANVAS_CELL);
      }
    }
    tile.canvas = off;
    tile.canvasVersion = atlas.version;
    return off;
  }

  function rebuildTileList() {
    tileList = Array.from(tileCache.values());
  }

  function trimTileCache() {
    if (tileCache.size <= MAX_CLIENT_TILES) return;
    const removeCount = tileCache.size - MAX_CLIENT_TILES;
    const removable = Array.from(tileCache.values()).sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
    for (let i = 0; i < removeCount; i++) tileCache.delete(removable[i].key);
    rebuildTileList();
  }

  function ingestTiles(map, fullSync = false) {
    const tiles = Array.isArray(map?.tiles) ? map.tiles : [];
    const resetTiles = map?.tilesReset === true || map?.clearTiles === true;
    if (resetTiles) {
      tileCache.clear();
      tileList = [];
    }
    let changed = false;
    for (const raw of tiles) {
      const decoded = decodeTile(raw);
      if (!decoded) continue;
      const prev = tileCache.get(decoded.key);
      if (prev && prev.updatedAt === decoded.updatedAt) {
        prev.lastUsed = ++tileTouchClock;
        continue;
      }
      tileCache.set(decoded.key, decoded);
      changed = true;
    }
    if (changed || resetTiles) rebuildTileList();
    trimTileCache();
  }

  function visibleWorldBounds(extra = 2) {
    return {
      minX: view.centerX - width / view.scale / 2 - extra,
      maxX: view.centerX + width / view.scale / 2 + extra,
      minZ: view.centerZ - height / view.scale / 2 - extra,
      maxZ: view.centerZ + height / view.scale / 2 + extra
    };
  }

  function drawBackground() {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#05070c';
    ctx.fillRect(0, 0, width, height);
  }

  function visibleTiles() {
    const bounds = visibleWorldBounds();
    const out = [];
    for (const tile of tileList) {
      if(tile.dimension!==activeDimension)continue;
      const x0 = tile.tx * tile.size;
      const z0 = tile.tz * tile.size;
      const x1 = x0 + tile.size;
      const z1 = z0 + tile.size;
      if (x1 >= bounds.minX && x0 <= bounds.maxX && z1 >= bounds.minZ && z0 <= bounds.maxZ) out.push(tile);
    }
    if (out.length <= MAX_VISIBLE_TILES) return out;
    out.sort((a, b) => {
      const ax = a.tx * a.size + a.size / 2 - view.centerX;
      const az = a.tz * a.size + a.size / 2 - view.centerZ;
      const bx = b.tx * b.size + b.size / 2 - view.centerX;
      const bz = b.tz * b.size + b.size / 2 - view.centerZ;
      return ax * ax + az * az - (bx * bx + bz * bz);
    });
    return out.slice(0, MAX_VISIBLE_TILES);
  }

  function drawTilePlaceholder(tile, x, y, size) {
    const first = tile.cells?.[0] || 'minecraft:unknown';
    ctx.fillStyle = fallbackColorForBlock(first);
    ctx.fillRect(x, y, size, size);
  }

  function drawTiles() {
    const visible = visibleTiles();
    if (!visible.length) {
      ctx.fillStyle = 'rgba(255,255,255,.035)';
      ctx.font = '700 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Очікуємо чанки, які прогрузять гравці...', width / 2, height / 2);
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,.32)';
      ctx.fillText('Досліджуй світ, щоб відкрити нові ділянки мапи.', width / 2, height / 2 + 18);
      ctx.textAlign = 'left';
      return;
    }

    const previousSmoothing = ctx.imageSmoothingEnabled;
    const buildBudgetLimit = dragging ? 0 : (document.hidden ? 0 : (view.scale < 0.75 ? 8 : MAX_TILE_BUILDS_PER_FRAME));
    let buildBudget = buildBudgetLimit;
    let staleLeft = 0;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.imageSmoothingEnabled = false;

    for (const tile of visible) {
      tile.lastUsed = ++tileTouchClock;
      const p = worldToScreen(tile.tx * tile.size, tile.tz * tile.size);
      const screenSize = Math.ceil(tile.size * view.scale);
      if (screenSize < 1) continue;
      const stale = !tile.canvas || tile.canvasVersion !== atlas.version;
      if (stale && buildBudget > 0) {
        buildTileCanvas(tile);
        buildBudget--;
      }
      if (tile.canvas && tile.canvasVersion === atlas.version) {
        ctx.drawImage(tile.canvas, Math.floor(p.x), Math.floor(p.y), screenSize, screenSize);
      } else {
        staleLeft++;
        drawTilePlaceholder(tile, Math.floor(p.x), Math.floor(p.y), screenSize);
      }
    }
    ctx.imageSmoothingEnabled = previousSmoothing;
    if (staleLeft > 0 && !dragging) needsAnotherDraw = true;

    if (view.scale >= 5.5 && visible.length < 240) {
      ctx.strokeStyle = 'rgba(0,0,0,.18)';
      ctx.lineWidth = 1;
      for (const tile of visible) {
        const x0 = tile.tx * tile.size;
        const z0 = tile.tz * tile.size;
        const a = worldToScreen(x0, z0);
        const b = worldToScreen(x0 + tile.size, z0 + tile.size);
        ctx.strokeRect(Math.floor(a.x), Math.floor(a.y), Math.ceil(b.x - a.x), Math.ceil(b.y - a.y));
      }
    }
  }

  function warmVisibleTilesIdle(deadline) {
    if (dragging || document.hidden) return;
    let budget = MAX_TILE_BUILDS_IDLE;
    for (const tile of visibleTiles()) {
      if (budget <= 0) break;
      if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() < 5) break;
      if (!tile.canvas || tile.canvasVersion !== atlas.version) {
        buildTileCanvas(tile);
        budget--;
      }
    }
    requestDraw();
  }

  function scheduleIdleWarmup() {
    const idle = window.requestIdleCallback || (fn => window.setTimeout(() => fn({ timeRemaining: () => 12 }), 80));
    idle(warmVisibleTilesIdle, { timeout: 700 });
  }

  function drawGrid() {
    if (view.scale < 0.42) return;
    const bounds = visibleWorldBounds();
    const rawStep = Math.max(16, Math.pow(2, Math.ceil(Math.log2((bounds.maxX - bounds.minX) / 10))));
    const step = Math.min(2048, rawStep);
    ctx.lineWidth = 1;
    ctx.strokeStyle = view.scale >= 6 ? 'rgba(255,255,255,.035)' : 'rgba(255,255,255,.018)';
    ctx.fillStyle = 'rgba(235,241,255,.24)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    for (let x = Math.floor(bounds.minX / step) * step; x <= bounds.maxX; x += step) {
      const a = worldToScreen(x, bounds.minZ);
      const b = worldToScreen(x, bounds.maxZ);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (view.scale > 0.75) ctx.fillText(String(Math.round(x)), a.x + 4, 16);
    }
    for (let z = Math.floor(bounds.minZ / step) * step; z <= bounds.maxZ; z += step) {
      const a = worldToScreen(bounds.minX, z);
      const b = worldToScreen(bounds.maxX, z);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (view.scale > 0.75) ctx.fillText(String(Math.round(z)), 10, a.y - 4);
    }
  }

  function drawSpawn(map) {
    const spawn = map.spawn || { x: 0, y: 64, z: 0, radius: 96 };
    if((spawn.dimension||'minecraft:overworld')!==activeDimension)return;
    const p = worldToScreen(spawn.x || 0, spawn.z || 0);
    const r = Math.max(4, (spawn.radius || 96) * view.scale);
    if (p.x + r >= -80 && p.x - r <= width + 80 && p.y + r >= -80 && p.y - r <= height + 80 && r < Math.max(width, height) * 3) {
      ctx.fillStyle = 'rgba(242,196,109,.045)';
      ctx.strokeStyle = 'rgba(242,196,109,.58)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (p.x < -40 || p.x > width + 40 || p.y < -40 || p.y > height + 40) return;
    ctx.fillStyle = '#f2c46d';
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,244,214,.96)';
    ctx.font = '800 12px system-ui, sans-serif';
    ctx.fillText('Спавн', p.x + 11, p.y - 10);
  }

  function drawTerritories(map) {
    const territories = Array.isArray(map.territories) ? map.territories : [];
    if (!territories.length) return;
    const bounds = visibleWorldBounds();
    ctx.save();
    ctx.lineWidth = 2;
    ctx.font = '800 12px system-ui, sans-serif';
    let labelsLeft = view.scale >= 1.1 ? 40 : 0;
    for (const t of territories) {
      if((t.dimension||'minecraft:overworld')!==activeDimension)continue;
      const minX = Number(t.minX ?? (Number(t.x || 0) - Number(t.size || 48) / 2));
      const minZ = Number(t.minZ ?? (Number(t.z || 0) - Number(t.size || 48) / 2));
      const maxX = Number(t.maxX ?? (Number(t.x || 0) + Number(t.size || 48) / 2));
      const maxZ = Number(t.maxZ ?? (Number(t.z || 0) + Number(t.size || 48) / 2));
      if (maxX < bounds.minX || minX > bounds.maxX || maxZ < bounds.minZ || minZ > bounds.maxZ) continue;
      const a = worldToScreen(minX, minZ);
      const b = worldToScreen(maxX + 1, maxZ + 1);
      const guild = String(t.type || '').toUpperCase() === 'GUILD';
      ctx.fillStyle = guild ? 'rgba(119,168,255,.085)' : 'rgba(242,196,109,.075)';
      ctx.strokeStyle = guild ? 'rgba(119,168,255,.82)' : 'rgba(242,196,109,.78)';
      ctx.setLineDash(guild ? [] : [8, 5]);
      ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.setLineDash([]);
      if (labelsLeft > 0 && Math.abs(b.x - a.x) > 46 && Math.abs(b.y - a.y) > 24) {
        labelsLeft--;
        const label = guild ? (t.guildName || 'Гільдія') : (t.ownerName || 'Приватна');
        ctx.fillStyle = 'rgba(5,8,14,.78)';
        const tw = ctx.measureText(label).width + 14;
        roundRect(ctx, a.x + 6, a.y + 6, tw, 22, 8); ctx.fill();
        ctx.fillStyle = guild ? '#cfe0ff' : '#ffe2a3';
        ctx.fillText(label, a.x + 13, a.y + 21);
      }
    }
    ctx.restore();
  }

  function drawPlayers(map) {
    const players = map.players || [];
    if (!players.length) return;
    for (const player of players) {
      if((player.dimension||map.spawn?.dimension||'minecraft:overworld')!==activeDimension)continue;
      const p = worldToScreen(player.x || 0, player.z || 0);
      if (p.x < -80 || p.x > width + 80 || p.y < -80 || p.y > height + 80) continue;
      const pending = player.pending === true;
      ctx.fillStyle = pending ? '#f08a8a' : '#77a8ff';
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();

      const yaw = Number(player.yaw || 0) * Math.PI / 180;
      ctx.strokeStyle = pending ? 'rgba(240,138,138,.85)' : 'rgba(119,168,255,.85)';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - Math.sin(yaw) * 18, p.y + Math.cos(yaw) * 18); ctx.stroke();

      if (view.scale < 0.58) continue;
      const name = String(player.name || 'Гравець');
      ctx.font = '800 12px system-ui, sans-serif';
      const textW = ctx.measureText(name).width + 14;
      const bx = p.x + 11;
      const by = p.y - 24;
      ctx.fillStyle = 'rgba(6,10,18,.80)';
      roundRect(ctx, bx, by, textW, 22, 8); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.94)';
      ctx.fillText(name, bx + 7, by + 15);
    }
  }

  function roundRect(context, x, y, w, h, r) {
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + w, y, x + w, y + h, r);
    context.arcTo(x + w, y + h, x, y + h, r);
    context.arcTo(x, y + h, x, y, r);
    context.arcTo(x, y, x + w, y, r);
    context.closePath();
  }

  function draw() {
    if (!ctx) return;
    needsAnotherDraw = false;
    ctx.clearRect(0, 0, width, height);
    drawBackground();
    const map = state || { spawn: { x: 0, z: 0, radius: 96 }, players: [] };
    drawTiles();
    drawGrid();
    drawSpawn(map);
    drawTerritories(map);
    drawPlayers(map);
    renderNpcs(map);
    if (needsAnotherDraw) requestAnimationFrame(scheduleIdleWarmup);
  }

  function signatureForInfo(map) {
    return [
      map.online ? '1' : '0',
      map.worldName || '',activeDimension,
      map.spawn?.x, map.spawn?.y, map.spawn?.z, map.spawn?.radius,
      map.players?.length || 0,
      tileCache.size,
      map.tileCount || 0,
      (map.territories || []).length
    ].join('|');
  }

  function renderInfo(map) {
    const sig = signatureForInfo(map);
    if (sig === lastInfoSignature) {
      renderPlayers(map.players || []);
      return;
    }
    lastInfoSignature = sig;
    const online = Boolean(map.online);
    els.liveDot?.classList.toggle('online', online);
    els.liveDot?.classList.toggle('offline', !online);
    if (els.liveTitle) els.liveTitle.textContent = online ? 'Мапа онлайн' : 'Мапа очікує сервер';
    if (els.liveSubtitle) els.liveSubtitle.textContent = online ? 'Світ і позиції оновлюються автоматично' : 'Сервер ще не надіслав координати';
    const serverTileCount = Number(map.tileCount || 0);
    if (els.meta) els.meta.textContent = `${map.worldName || 'Світ'} · ${dimNames[activeDimension] || activeDimension || 'minecraft:overworld'} · ${serverTileCount ? 'вид зверху' : 'очікуємо відкриті чанки'}`;
    if (els.playerCount) els.playerCount.textContent = `${map.players?.length || 0} гравців`;
    if (els.spawnCoords) els.spawnCoords.textContent = `X ${fmt(map.spawn?.x)} · Y ${fmt(map.spawn?.y)} · Z ${fmt(map.spawn?.z)}`;
    if (els.spawnRadius) els.spawnRadius.textContent = `Радіус: ${fmt(map.spawn?.radius || 0)} блоків`;
    if (els.renderCount) els.renderCount.textContent = `${tileCache.size}${serverTileCount && serverTileCount !== tileCache.size ? ` / ${serverTileCount}` : ''} ділянок`;
    if (els.renderSubtitle) els.renderSubtitle.textContent = tileCache.size ? 'Після першого завантаження сайт отримує тільки зміни' : (online && (map.players?.length || 0) ? 'Очікуємо відкриті ділянки світу' : 'Чекаємо відкриті гравцями чанки');
    if (els.territoryCount) els.territoryCount.textContent = String((map.territories || []).length || 0);
    renderPlayers(map.players || []);
  }

  function renderPlayers(players) {
    if (!els.playerList) return;
    const list = Array.isArray(players) ? players.slice(0, 100) : [];
    const sig = list.map(p => `${p.name}|${Math.round(Number(p.x || 0))}|${Math.round(Number(p.y || 0))}|${Math.round(Number(p.z || 0))}|${p.pending ? 1 : 0}|${p.authenticated ? 1 : 0}`).join(';');
    if (sig === lastPlayersSignature) return;
    lastPlayersSignature = sig;
    if (!list.length) {
      els.playerList.innerHTML = '<div class="map-empty">Гравців онлайн поки немає.</div>';
      return;
    }
    els.playerList.innerHTML = list.map(player => {
      const pending = player.pending === true;
      const badge = pending ? 'Очікує' : (player.authenticated === true ? 'Авторизований' : 'Онлайн');
      const initial = esc((player.name || '?').slice(0, 1).toUpperCase());
      return `<div class="map-player-card ${pending ? 'pending' : ''}"><div class="map-player-avatar">${initial}</div><div><div class="map-player-name"><span>${esc(player.name)}</span><em class="map-player-badge">${badge}</em></div><div class="map-player-coords">X ${fmt(player.x)} · Y ${fmt(player.y)} · Z ${fmt(player.z)}</div></div></div>`;
    }).join('');
  }

  function buildMapStatusUrl(forceFull = false) {
    const url = new URL('/api/map/status', window.location.origin);
    url.searchParams.set('v', String(MAP_CLIENT_VERSION));
    const full = forceFull || !lastTileCursor || !lastFullFetchAt || Date.now() - lastFullFetchAt > FULL_REFRESH_MS || tileCache.size === 0;
    if (!full) {
      const bounds = visibleWorldBounds(96);
      url.searchParams.set('mode', 'delta');
      url.searchParams.set('since', lastTileCursor);
      url.searchParams.set('bounds', `${Math.floor(bounds.minX)},${Math.floor(bounds.minZ)},${Math.ceil(bounds.maxX)},${Math.ceil(bounds.maxZ)}`);
    }
    return { url: url.pathname + url.search, full };
  }

  async function loadMap(forceFull = false) {
    if (loadingMap) return;
    loadingMap = true;
    try {
      const request = buildMapStatusUrl(forceFull);
      const response = await fetch(request.url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const map = data.map || null;
      state = map;
      const fullSync = request.full || map?.tileMode === 'full' || map?.tilesReset === true;
      ingestTiles(map, fullSync);
      if (fullSync) lastFullFetchAt = Date.now();
      if (map?.tileCursor) lastTileCursor = String(map.tileCursor);
      else if (Array.isArray(map?.tiles) && map.tiles.length) {
        lastTileCursor = map.tiles.reduce((best, tile) => newerCursor(String(tile.updatedAt || ''), best), lastTileCursor);
      }
      if (map && !fullSync && Number(map.tileCount || 0) < tileCache.size) {
        tileCache.clear();
        tileList = [];
        lastTileCursor = '';
        lastFullFetchAt = 0;
        window.setTimeout(() => loadMap(true), 0);
      }
      if (!view.ready && state) resetView(state);
      renderInfo(state || {});
      requestDraw();
      scheduleIdleWarmup();
    } catch (error) {
      if (els.liveTitle) els.liveTitle.textContent = 'Мапа недоступна';
      if (els.liveSubtitle) els.liveSubtitle.textContent = error.message || 'Помилка запиту';
      if (els.meta) els.meta.textContent = 'Не вдалося отримати дані мапи';
      requestDraw();
    } finally {
      loadingMap = false;
    }
  }

  wrap.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18;
    zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
  }, { passive: false });

  wrap.addEventListener('pointerdown', event => {
    if(event.target.closest('button,a,select,.map-npc-tooltip'))return;
    tooltipPinned=false;npcTooltip.hidden=true;
    dragging = true;
    dragLast = { x: event.clientX, y: event.clientY };
    wrap.classList.add('dragging');
    wrap.setPointerCapture?.(event.pointerId);
  });

  wrap.addEventListener('pointermove', event => {
    if (!dragging || !dragLast) return;
    const dx = event.clientX - dragLast.x;
    const dy = event.clientY - dragLast.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    view.centerX -= dx / view.scale;
    view.centerZ -= dy / view.scale;
    dragLast = { x: event.clientX, y: event.clientY };
    requestDraw();
  });

  function stopDrag(event) {
    if (!dragging) return;
    dragging = false;
    dragLast = null;
    wrap.classList.remove('dragging');
    if (event?.pointerId != null) wrap.releasePointerCapture?.(event.pointerId);
    scheduleIdleWarmup();
    requestDraw();
  }

  wrap.addEventListener('pointerup', stopDrag);
  wrap.addEventListener('pointercancel', stopDrag);
  wrap.addEventListener('pointerleave', stopDrag);

  els.centerBtn?.addEventListener('click', () => resetView(state || {}, true));
  els.reset?.addEventListener('click', () => resetView(state || {}, false));
  els.zoomIn?.addEventListener('click', () => zoomAt(width / 2, height / 2, 1.22));
  els.zoomOut?.addEventListener('click', () => zoomAt(width / 2, height / 2, 1 / 1.22));

  window.addEventListener('resize', resize, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadMap(false); });
  resize();
  loadBlockAtlas();
  loadMap(true);
  setInterval(() => { if (!document.hidden) loadMap(false); }, REFRESH_MS);
})();
