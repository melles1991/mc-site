(() => {
  'use strict';
  const root = document.getElementById('catalog-grid'); if (!root) return;
  const $ = id => document.getElementById(id);
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const categories = {teleport:'Телепортація',guild:'Гільдія',weapons:'Зброя',armor:'Захист',tools:'Інструменти',food:'Їжа',supplies:'Ресурси'};
  const roles = {any:'Усі гравці',member:'Учасник гільдії',guild_member:'Учасник гільдії',guildmaster:'Майстер гільдії',guild_master:'Майстер гільдії',builder:'Будівельник',quartermaster:'Інтендант',warrior:'Воїн',farmer:'Фермер'};
  let data = null, page = 0, category = '', tab = 'items';
  const SIZE = 24;
  function name(id) { return data?.labels[id.replace(/^#/, '')] || id.replace(/^#/, '').split(':').pop().replace(/_/g,' '); }
  function cost(offer) { return offer.costs.map(c => `${c.count} ${c.itemId === 'minecraft:emerald' ? 'смарагд.' : name(c.itemId)}`).join(' + '); }
  function icon(item, cls = '') { return `<img class="catalog-icon ${cls}" src="${esc(item.icon)}" alt="" loading="lazy" width="96" height="96">`; }
  function price(item) {
    const all = item.offers || [], available = all.filter(o=>o.active!==false), offers = available.length ? available : all; if (!offers.length) return 'Виготовляється на верстаку';
    const offer = offers.find(o => o.costs.every(c => c.itemId === 'minecraft:emerald')) || offers[0];
    return `${esc(cost(offer))} <span>за ${offer.count} шт.${available.length?'':' · NPC неактивний'}</span>`;
  }
  function render() {
    if (!data) return;
    const query = $('catalog-search').value.toLocaleLowerCase('uk').trim(), vendor = $('catalog-vendor').value, craft = $('catalog-craft').value;
    $('catalog-vendor').closest('label').hidden=tab==='traders'; $('catalog-craft').closest('label').hidden=tab==='traders';
    $('catalog-search').closest('label').classList.toggle('trader-search-only',tab==='traders');
    $('catalog-items-panel').hidden = tab !== 'items'; $('catalog-traders-panel').hidden = tab !== 'traders';
    const matching = data.items.filter(i => (!category || i.category === category) && (!vendor || i.offers.some(o => o.traderId === vendor))
      && (!craft || (craft === 'recipe' ? !!i.recipe : !i.recipe))
      && (!query || [i.name,i.itemId,...i.offers.map(o=>o.traderName)].join(' ').toLocaleLowerCase('uk').includes(query)));
    const pages = Math.max(1,Math.ceil(matching.length/SIZE)); page = Math.min(page,pages-1);
    $('catalog-results').textContent = `${matching.length} предметів`;
    root.innerHTML = matching.slice(page*SIZE,(page+1)*SIZE).map(i => `<button type="button" class="item-card" data-item="${esc(i.id)}">${icon(i)}<span class="item-category">${esc(categories[i.category] || 'Предмет')}</span><strong>${esc(i.name)}</strong><span class="item-description">${esc(i.description || (i.enchants ? 'Спорядження із зачаруваннями' : 'У пропозиціях торговців'))}</span><span class="item-card-bottom"><span>${price(i)}</span><span class="item-arrow" aria-hidden="true">↗</span></span>${i.recipe ? '<span class="recipe-badge">Крафт</span>' : ''}</button>`).join('') || '<div class="catalog-empty"><h3>Нічого не знайшли</h3><p>Спробуй іншу назву або скинь фільтри.</p><button class="btn btn-outline" type="button" data-reset>Скинути фільтри</button></div>';
    $('catalog-page').textContent = `${page+1} / ${pages}`; $('catalog-prev').disabled = page===0; $('catalog-next').disabled = page>=pages-1;
    const traders = data.traders.filter(t=>!query || t.name.toLocaleLowerCase('uk').includes(query));
    $('catalog-traders').innerHTML = traders.map(t=>`<article class="trader-card"><span class="trader-symbol" aria-hidden="true">${t.kind==='system'?'⚑':'◇'}</span><span class="eyebrow">${t.kind==='system'?'Гільдійний NPC':'Торговець'}</span><h3>${esc(t.name)}</h3><p>${t.offerCount} пропозицій · ${t.enabled===null?'Базовий перелік':t.enabled?(t.position?'Розміщений у світі':'Активний · позиція недоступна'):'Неактивний'}</p><div class="inline-actions">${t.offerCount?`<button class="text-link" type="button" data-vendor="${esc(t.id)}">Предмети →</button>`:''}${t.enabled&&t.position?`<a class="text-link" href="/map?npc=${encodeURIComponent(t.id)}">На мапі ↗</a>`:''}</div></article>`).join('') || '<p class="catalog-empty">Торговців за цим запитом немає.</p>';
  }
  function recipeHtml(recipe) {
    if (!recipe) return '<div class="no-recipe"><span class="eyebrow">Отримання</span><h3>Шукай у торговця</h3><p>Окремого рецепта HomeCraft для цієї версії предмета немає. Рецепти звичайних предметів Minecraft тут не дублюються.</p></div>';
    const cells = recipe.pattern.flatMap(row=>[...row].map(char=>recipe.key[char] || null));
    const counts = new Map(); for (const id of cells) if(id) counts.set(id,(counts.get(id)||0)+1);
    return `<span class="eyebrow">Рецепт на верстаку</span><div class="crafting-row"><div class="crafting-grid" aria-label="Рецепт 3 на 3">${cells.map(id=>`<span class="crafting-cell" title="${esc(id ? name(id) : 'Порожньо')}" aria-label="${esc(id ? name(id) : 'Порожньо')}">${id?`<span class="ingredient-gem ${id.includes('lapis')?'lapis':id.includes('amethyst')?'amethyst':''}">${id.includes('banner')?'⚑':'◆'}</span>`:''}</span>`).join('')}</div><span class="crafting-arrow">→</span><div class="crafting-result"><strong>×${recipe.result.count}</strong><small>за один крафт</small></div></div><ul class="ingredient-list">${[...counts].map(([id,count])=>`<li><span>${esc(name(id))}</span><strong>×${count}</strong></li>`).join('')}</ul>`;
  }
  function openItem(id) {
    const item = data.items.find(i=>i.id===id); if(!item)return;
    $('item-dialog-title').textContent=item.name;
    $('item-dialog-content').innerHTML=`<div class="item-detail-lead">${icon(item)}<div><span class="eyebrow">${esc(categories[item.category] || 'Предмет')}</span><p>${esc(item.description || 'Предмет із торгового переліку HomeCraft.')}</p><code>${esc(item.itemId)}</code></div></div><div class="item-detail-columns"><section>${recipeHtml(item.recipe)}</section><section><span class="eyebrow">Ціни та торговці</span>${item.offers.map(o=>{const t=data.traders.find(t=>t.id===o.traderId);return `<article class="offer-row"><strong>${esc(o.traderName)}</strong><p>${esc(cost(o))} <span>→ ${o.count} шт.</span></p><small>${esc(roles[o.role]||o.role)}${o.limit?` · Ліміт: ${o.limit} покупок`:''}${o.reset&&o.reset!=='never'?` · ${esc(o.reset)}`:''}${o.active===false?' · NPC неактивний':''}</small>${t?.enabled&&t.position?`<a href="/map?npc=${encodeURIComponent(o.traderId)}">Показати на мапі ↗</a>`:''}</article>`}).join('')||'<p class="muted">Немає пропозиції торговця.</p>'}</section></div>${item.enchants||item.extraDamage?`<div class="item-enchants"><span class="eyebrow">Властивості</span>${item.enchants?`<p>${esc(item.enchants.replace(/\+/g,' · '))}</p>`:''}${item.extraDamage?`<p>Додаткова сила атаки: +${item.extraDamage}</p>`:''}</div>`:''}`;
    $('item-dialog').showModal();
  }
  function reset(){ $('catalog-search').value='';$('catalog-vendor').value='';$('catalog-craft').value='';category='';page=0;document.querySelectorAll('[data-category]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.category==='')));render(); }
  root.addEventListener('click',e=>{const b=e.target.closest('[data-item]');if(b)openItem(b.dataset.item);if(e.target.closest('[data-reset]'))reset();});
  $('catalog-traders').addEventListener('click',e=>{const b=e.target.closest('[data-vendor]');if(!b)return;tab='items';reset();$('catalog-vendor').value=b.dataset.vendor;page=0;setTabs();render();});
  function setTabs(){document.querySelectorAll('[data-tab]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.tab===tab)));}
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{tab=b.dataset.tab;setTabs();render();}));
  document.querySelectorAll('[data-category]').forEach(b=>b.addEventListener('click',()=>{category=b.dataset.category;page=0;document.querySelectorAll('[data-category]').forEach(n=>n.setAttribute('aria-pressed',String(n===b)));render();}));
  for(const id of ['catalog-search','catalog-vendor','catalog-craft']) $(id).addEventListener(id==='catalog-search'?'input':'change',()=>{page=0;render();});
  $('catalog-prev').addEventListener('click',()=>{page--;render();});$('catalog-next').addEventListener('click',()=>{page++;render();});
  $('item-dialog-close').addEventListener('click',()=>$('item-dialog').close());
  $('item-dialog').addEventListener('click',e=>{if(e.target===$('item-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  async function load(){
    $('catalog-status').textContent='Завантажуємо каталог…';$('catalog-retry').hidden=true;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
    try{const r=await fetch('/api/catalog',{cache:'no-store',signal:controller.signal});if(!r.ok)throw new Error('HTTP '+r.status);data=await r.json();
      $('catalog-total').textContent=data.items.length;$('catalog-recipes').textContent=data.items.filter(i=>i.recipe).length;$('catalog-merchants').textContent=data.traders.filter(t=>t.offerCount).length;
      $('catalog-status').textContent=data.source==='server'?(data.stale?'Збережені дані сервера · очікуємо оновлення':'Синхронізовано із сервером'):'Базові рецепти й ціни · позиції NPC з’являться після синхронізації сервера';
      $('catalog-vendor').innerHTML='<option value="">Усі торговці</option>'+data.traders.filter(t=>t.offerCount).map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
      render();const params=new URLSearchParams(location.search);if(params.get('vendor')){$('catalog-vendor').value=params.get('vendor');render();}if(params.get('item'))openItem(params.get('item'));
    }catch(e){$('catalog-status').textContent='Не вдалося завантажити каталог. Спробуй ще раз.';$('catalog-retry').hidden=false;root.innerHTML='';}finally{clearTimeout(timeout);}
  }
  $('catalog-retry').addEventListener('click',load);load();
})();
