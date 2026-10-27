const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));


function ensureDownloadNavLink() {
  $$('.nav-links').forEach(nav => {
    if ($('a[href="/download"]', nav)) return;
    const link = document.createElement('a');
    link.href = '/download';
    link.textContent = 'Адони';
    link.dataset.navDownload = 'true';
    const mapLink = $('a[href="/map"]', nav);
    const statusLink = $('a[href="/status"]', nav);
    if (mapLink && mapLink.nextSibling) nav.insertBefore(link, mapLink.nextSibling);
    else if (statusLink) nav.insertBefore(link, statusLink);
    else nav.insertBefore(link, $('.js-auth-link', nav) || null);
  });
}

function setActiveNav() {
  const path = location.pathname === '/' ? '/' : location.pathname.replace(/\.html$/, '');
  $$('.nav-links a').forEach(link => {
    const href = new URL(link.href).pathname.replace(/\.html$/, '');
    link.classList.toggle('active', href === path || (path === '/' && href === '/'));
  });
}

async function api(path, options = {}) {
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers = isFormData ? { ...(options.headers || {}) } : { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const res = await fetch(path, { credentials: 'same-origin', headers, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function renderRuntime(runtime = {}) {
  const minecraft = runtime.minecraft || '26.3';
  const neoforge = runtime.neoforge || '26.3.0.97';
  $$('.js-required-minecraft').forEach(el => { el.textContent = minecraft; });
  $$('.js-required-neoforge').forEach(el => { el.textContent = neoforge; });
  $$('.js-required-java').forEach(el => { el.textContent = String(runtime.java || 25); });
  $$('.js-neoforge-installer').forEach(el => {
    if (runtime.installerUrl?.startsWith('https://maven.neoforged.net/')) el.href = runtime.installerUrl;
  });
}

async function refreshStatus() {
  try {
    const status = await api('/api/server/status');
    renderRuntime(status.runtime);
    const online = Boolean(status.online);
    const stale = Boolean(status.stale);
    const playersOnline = Number(status.playersOnline ?? 0);
    const playersMax = Number(status.playersMax ?? 100);
    const players = Array.isArray(status.players) ? status.players : [];
    const host = status.host || 'localhost:25565';
    const version = status.version || 'Minecraft 26.3';
    const lastSignal = status.lastUpdatedAt ? formatDateTime(status.lastUpdatedAt) : 'ще не було';
    const staleText = stale && status.staleReason ? ` · ${humanStaleReason(status.staleReason)}` : '';

    $$('.js-server-status').forEach(el => { el.textContent = online ? 'Онлайн' : 'Офлайн'; });
    $$('.js-server-dot').forEach(el => { el.classList.toggle('offline', !online); });
    $$('.js-online-count').forEach(el => { el.textContent = `${playersOnline}/${playersMax}`; });
    $$('.js-server-host').forEach(el => { el.textContent = host; });
    $$('[data-copy]').forEach(btn => { btn.dataset.copy = host; });
    $$('.js-server-version').forEach(el => { el.textContent = version; });

    const box = $('.js-status-card');
    if (box) {
      box.innerHTML = `
        <div class="status-card-head">
          <h2 class="status-card-title">Поточний стан</h2>
          <span class="badge ${online ? 'good' : 'bad'}">${online ? 'Онлайн' : 'Офлайн'}</span>
        </div>
        <div class="info-list">
          <div class="info-row"><span>Гравці</span><strong>${playersOnline}/${playersMax}</strong></div>
          
          
          <div class="info-row"><span>IP</span><strong>${escapeHtml(host)}</strong></div>
        </div>
      `;
    }

    const technical = $('.js-status-technical');
    if (technical) {
      const ping = status.minecraftPing;
      const pingText = ping ? (ping.online ? 'відповідає' : 'немає відповіді') : '—';
      technical.innerHTML = `
        <div class="info-row"><span>Версія</span><strong>${escapeHtml(version)}</strong></div>
        <div class="info-row"><span>IP</span><strong>${escapeHtml(host)}</strong></div>
        <div class="info-row"><span>Джерело</span><strong>${escapeHtml(humanSource(status.source))}</strong></div>
        <div class="info-row"><span>Оновлено</span><strong>${escapeHtml(lastSignal + staleText)}</strong></div>
        <div class="info-row"><span>Пінг</span><strong>${pingText}</strong></div>
      `;
    }

    renderPlayerList('.js-players-online', players, online ? 'Гравців зараз немає.' : 'Сервер офлайн.');
    renderPlayerList('.js-players-auth', players.filter(p => p && p.authenticated === true), 'Немає авторизованих гравців онлайн.');
    renderPlayerList('.js-players-pending', players.filter(p => p && p.pending === true), 'Ніхто не очікує входу.');
  } catch (error) {
    $$('.js-server-status').forEach(el => { el.textContent = 'Офлайн'; });
    $$('.js-server-dot').forEach(el => el.classList.add('offline'));
    $$('.js-online-count').forEach(el => { el.textContent = '0/100'; });
    const box = $('.js-status-card');
    if (box) box.innerHTML = `<div class="status-card-head"><h2 class="status-card-title">Поточний стан</h2><span class="badge bad">Офлайн</span></div><div class="muted-small">Статус тимчасово недоступний.</div>`;
  }
}

function renderPlayerList(selector, players, emptyText) {
  const root = $(selector);
  if (!root) return;
  if (!Array.isArray(players) || players.length === 0) {
    root.innerHTML = `<span class="muted-small">${escapeHtml(emptyText)}</span>`;
    return;
  }
  root.innerHTML = players.map(player => {
    const name = typeof player === 'string' ? player : player.name;
    const cls = player && player.pending ? 'pending' : player && player.authenticated ? 'good' : '';
    return `<span class="player-chip ${cls}">${escapeHtml(name || 'Гравець')}</span>`;
  }).join('');
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA', { dateStyle: 'short', timeStyle: 'medium' });
}

function humanSource(source) {
  const map = {
    'neoforge-server': 'мод сервера',
    'minecraft-status-ping': 'Minecraft ping',
    'server-offline-api': 'сервер повідомив про вимкнення',
    'site-default': 'очікуємо сервер',
    'site-boot-reset': 'сайт перезапущено'
  };
  return map[source] || source || 'сайт';
}

function humanStaleReason(reason) {
  const map = {
    'no-heartbeat': 'немає сигналу від сервера',
    'heartbeat-expired': 'сигнал застарів',
    'site-restarted-waiting-server-heartbeat': 'очікуємо сервер після перезапуску сайту',
    'offline-pushed': 'сервер вимкнувся',
    'minecraft-ping-online': 'працює через Minecraft ping'
  };
  return map[reason] || reason;
}


async function refreshResourcePackStatus() {
  const roots = $$('.js-resource-pack-card');
  if (!roots.length && !$('#resource-pack-admin')) return;
  try {
    const data = await api('/api/resource-pack/status');
    const rp = data.resourcePack || {};
    const available = Boolean(rp.available && rp.url && rp.sha1);
    $$('.js-resource-pack-name').forEach(el => { el.textContent = rp.displayName || 'Home Craft Resource Pack'; });
    $$('.js-resource-pack-url').forEach(el => { el.textContent = rp.url || '—'; if (el.tagName === 'A') el.href = rp.url || '#'; });
    $$('.js-resource-pack-sha1').forEach(el => { el.textContent = rp.sha1 || '—'; });
    $$('.js-resource-pack-id').forEach(el => { el.textContent = rp.id || '—'; });
    $$('.js-resource-pack-size').forEach(el => { el.textContent = rp.sizeBytes ? formatBytes(rp.sizeBytes) : '—'; });
    $$('.js-resource-pack-updated').forEach(el => { el.textContent = rp.updatedAt ? formatDateTime(rp.updatedAt) : '—'; });
    $$('.js-resource-pack-require').forEach(el => { el.textContent = rp.require ? 'Обовʼязковий' : 'Рекомендований'; });
    $$('.js-resource-pack-download').forEach(el => { el.href = available ? rp.url : '#'; el.classList.toggle('disabled', !available); });
    $$('.js-resource-pack-snippet').forEach(el => {
      const props = rp.serverProperties || {};
      el.textContent = available ? [
        `resource-pack=${props['resource-pack'] || rp.url}`,
        `resource-pack-sha1=${props['resource-pack-sha1'] || rp.sha1}`,
        `resource-pack-id=${props['resource-pack-id'] || rp.id}`,
        `require-resource-pack=${props['require-resource-pack'] || String(Boolean(rp.require))}`,
        `resource-pack-prompt=${props['resource-pack-prompt'] || ''}`
      ].join('\n') : 'Resource pack ще не встановлений.';
    });
  } catch (error) {
    $$('.js-resource-pack-card').forEach(root => {
      const box = root.querySelector('.js-resource-pack-error');
      if (box) box.textContent = error.message;
    });
  }
}

async function refreshClientMods() {
  const roots = $$('.js-client-mods-card');
  if (!roots.length) return;
  try {
    const data = await api('/api/client-mods');
    const cm = data.clientMods || {};
    renderRuntime(data.runtime || cm.runtime);
    const files = Array.isArray(cm.files) ? cm.files : [];
    $$('.js-client-mods-count').forEach(el => { el.textContent = String(files.length); });
    $$('.js-client-mods-dir').forEach(el => { el.textContent = cm.modsDir || '—'; });
    $$('.js-client-mods-updated').forEach(el => { el.textContent = cm.updatedAt ? formatDateTime(cm.updatedAt) : '—'; });
    $$('.js-client-mods-list').forEach(root => {
      if (!cm.available) {
        root.innerHTML = '<p class="muted-small">Моди тимчасово недоступні. Звернися до адміністратора в Discord.</p>';
        return;
      }
      if (!files.length) {
        root.innerHTML = '<p class="muted-small">Завантаження модів поки недоступне. Спробуй пізніше.</p>';
        return;
      }
      const incomplete = cm.ready === false
        ? '<p class="muted-small">Не всі 5 модів доступні. Відсутні: ' + escapeHtml((cm.missingIds || []).join(', ')) + '. Спробуй пізніше або звернися в Discord.</p>'
        : '';
      root.innerHTML = incomplete + files.map(file => {
        const version = file.version ? escapeHtml(String(file.version)) : '';
        const rawPath = String(file.publicPath || file.url || '');
        // Download links must stay on our own server; never trust arbitrary URLs from metadata.
        const downloadPath = /^\/client-mods\/[a-zA-Z0-9._%()-]+$/.test(rawPath) && !/%2f|%5c|\.\./i.test(rawPath) ? rawPath : '';
        if (!downloadPath) return '';
        return `
        <div class="download-file-row">
          <div>
            <strong>${escapeHtml(file.displayName || file.fileName)}</strong>
            <span class="muted-small">${version || 'Мод для Home Craft'}</span>
            <div class="download-file-tags"><span class="badge good">Для гри</span></div>
          </div>
          <div class="download-file-meta">
            <span>${formatBytes(file.sizeBytes)}</span>
            <a class="btn btn-outline btn-small" href="${escapeAttr(downloadPath)}" download>Завантажити файл</a>
          </div>
        </div>`;
      }).join('');
    });
  } catch (error) {
    $$('.js-client-mods-list').forEach(root => { root.innerHTML = '<p class="muted-small">Не вдалося завантажити список. Спробуй пізніше.</p>'; });
  }
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function syncAdminNav(user) {
  const isAdmin = user && user.role === 'admin';
  $$('.nav-links').forEach(nav => {
    let link = $('.js-admin-link', nav);
    if (isAdmin && !link) {
      link = document.createElement('a');
      link.className = 'js-admin-link';
      link.href = '/admin';
      link.textContent = 'Адмін';
      const authLink = $('.js-auth-link', nav);
      nav.insertBefore(link, authLink || null);
    }
    if (!isAdmin && link) link.remove();
  });
  setActiveNav();
}

async function refreshMe() {
  try {
    const data = await api('/api/me');
    const user = data.user;
    document.body.classList.toggle('is-auth', Boolean(user));
    document.body.classList.toggle('is-admin', Boolean(user && user.role === 'admin'));
    $$('.js-auth-link').forEach(el => {
      el.textContent = user ? 'Профіль' : 'Увійти';
      el.href = user ? '/profile' : '/login';
      el.style.display = 'inline-flex';
    });
    syncAdminNav(user);
    return user;
  } catch {
    document.body.classList.remove('is-auth', 'is-admin');
    syncAdminNav(null);
    return null;
  }
}

function bindCopyButtons() {
  $$('[data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const text = btn.dataset.copy || $('.js-server-host')?.textContent || '';
      try {
        await navigator.clipboard.writeText(text);
        const old = btn.innerHTML;
        btn.innerHTML = '✓';
        setTimeout(() => { btn.innerHTML = old; }, 1200);
      } catch {
        alert(text);
      }
    });
  });
}

function bindAuthForms() {
  const forgot = $('#forgot-password-form');
  if (forgot) forgot.addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('button[type="submit"]', forgot);
    const error = $('.form-error', forgot);
    const ok = $('.form-ok', forgot);
    error.textContent = ''; ok.textContent = ''; button.disabled = true;
    try {
      const { message } = await api('/api/auth/password/forgot', { method: 'POST', body: JSON.stringify({ email: $('#recovery-email').value.trim() }) });
      ok.textContent = message;
      forgot.reset();
    } catch (failure) { error.textContent = failure.message; }
    finally { button.disabled = false; }
  });
  const reset = $('#reset-password-form');
  if (reset) {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const resetToken = fragment.get('token') || '';
    // Never keep a recovery secret in visible location/history.
    history.replaceState(null, '', location.pathname);
    if (!/^[A-Za-z0-9_-]{43}$/.test(resetToken)) {
      $('.form-error', reset).textContent = 'Посилання недійсне або термін його дії минув. Запроси нове.';
      $('button[type="submit"]', reset).disabled = true;
    } else reset.addEventListener('submit', async event => {
      event.preventDefault();
      const button = $('button[type="submit"]', reset);
      const error = $('.form-error', reset);
      const ok = $('.form-ok', reset);
      error.textContent = ''; ok.textContent = '';
      const form = new FormData(reset);
      if (form.get('password') !== form.get('passwordRepeat')) { error.textContent = 'Паролі не збігаються.'; return; }
      button.disabled = true;
      try {
        const result = await api('/api/auth/password/reset', { method: 'POST', body: JSON.stringify({
          token: resetToken, password: form.get('password'), passwordRepeat: form.get('passwordRepeat')
        }) });
        reset.reset();
        ok.textContent = result.message;
        button.textContent = 'Пароль змінено';
        const link = document.createElement('a');
        link.href = '/login'; link.className = 'btn btn-outline'; link.textContent = 'Перейти до входу';
        reset.append(link);
      } catch (failure) { error.textContent = failure.message; button.disabled = false; }
    });
  }
  const login = $('#login-form');
  if (login) {
    login.addEventListener('submit', async event => {
      event.preventDefault();
      const error = $('.form-error', login);
      error.textContent = '';
      try {
        const form = new FormData(login);
        await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ login: form.get('login'), password: form.get('password') })
        });
        location.href = '/profile';
      } catch (e) {
        error.textContent = e.message;
      }
    });
  }
  const register = $('#register-form');
  if (register) {
    register.addEventListener('submit', async event => {
      event.preventDefault();
      const error = $('.form-error', register);
      error.textContent = '';
      try {
        const form = new FormData(register);
        if (form.get('passwordRepeat') && form.get('password') !== form.get('passwordRepeat')) {
          throw new Error('Паролі не збігаються');
        }
        await api('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ displayName: form.get('displayName'), login: form.get('login'), email: form.get('email'), password: form.get('password'), passwordRepeat: form.get('passwordRepeat') })
        });
        location.href = '/profile';
      } catch (e) {
        error.textContent = e.message;
      }
    });
  }
}

async function initProfile() {
  const root = $('#profile-root');
  if (!root) return;
  const user = await refreshMe();
  if (!user) {
    root.innerHTML = `<div class="card profile-card"><h3>Потрібна авторизація</h3><p>Увійди або створи акаунт, щоб привʼязати Minecraft нік.</p><div class="inline-actions"><a class="btn btn-primary" href="/login">Увійти</a><a class="btn btn-outline" href="/register">Реєстрація</a></div></div>`;
    return;
  }
  renderProfile(root, user);
  refreshGuildTalents();
}

function renderProfile(root, user) {
  const skin = user.skin || {};
  root.innerHTML = `
    <div class="card profile-card hc-account-card" id="account-summary">
      <div class="hc-account-top"><span class="hc-avatar" aria-hidden="true">${escapeHtml((user.displayName || user.login || 'H').slice(0,1).toUpperCase())}</span><div><span class="hc-overline">Твій профіль</span><h3>${escapeHtml(user.displayName || user.login || 'Гравець')}</h3><p>Керуй своїми даними та підключенням до гри.</p></div></div>
      <p>Тут можна керувати акаунтом і своїм персонажем у Home Craft.</p>
      <div class="info-list">
        <div class="info-row"><span>Email</span><strong>${escapeHtml(user.email)}</strong></div>
        <div class="info-row"><span>Логін</span><strong>${escapeHtml(user.login || user.displayName || '—')}</strong></div>
        <div class="info-row"><span>Тип акаунта</span><strong>${user.role === 'admin' ? 'Адміністратор' : 'Гравець'}</strong></div>
        <div class="info-row"><span>Minecraft нік</span><strong>${escapeHtml(user.minecraftNick || 'Не привʼязано')}</strong></div>
        
        <div class="info-row"><span>Доступ до сервера</span><strong><span class="badge ${user.isWhitelisted ? 'good' : 'bad'}">${user.isWhitelisted ? 'Активний' : 'Очікує'}</span></strong></div>
      </div>
      <div class="inline-actions"><button class="btn btn-soft btn-small" id="logout-btn">Вийти</button></div>
    </div>
    <div class="card profile-card hc-character-card" id="character-link">
      <span class="hc-overline">Твій персонаж</span><h3>${user.minecraftNick ? 'Minecraft привʼязано' : 'Привʼязати Minecraft'}</h3>
      <p>Нік персонажа залишиться закріпленим за твоїм акаунтом. Після видалення він буде недоступним для повторного використання.</p>
      <form class="form" id="minecraft-link-form">
        <div class="field"><label>Minecraft нік</label><input class="input" name="minecraftNick" value="${escapeAttr(user.minecraftNick || '')}" placeholder="Steve" maxlength="16" pattern="[A-Za-z0-9_]{3,16}" ${user.minecraftNick ? 'readonly' : ''} required></div>
        <input type="hidden" name="minecraftUuid" value="${escapeAttr(user.minecraftUuid || '')}">
        <div class="form-error"></div><div class="form-ok"></div>
        <button class="btn btn-primary" type="submit" ${user.minecraftNick ? 'disabled' : ''}>${user.minecraftNick ? 'Персонаж прив’язаний' : 'Створити прив’язку'}</button>
      </form>
      ${user.minecraftNick ? `<details class="character-delete"><summary>Видалити персонажа</summary>
      <p>Доступ до персонажа буде відкликано. Його нік і UUID залишаться зарезервованими назавжди. Старі речі, досвід і гільдія не передаються новому персонажу.</p>
      <form class="form" id="character-delete-form">
        <div class="field"><label>Для підтвердження введи нік ${escapeHtml(user.minecraftNick)}</label><input class="input" name="confirmNick" autocomplete="off" required></div>
        <div class="field"><label>Пароль акаунта</label><input class="input" name="password" type="password" autocomplete="current-password" required></div>
        <div class="form-error"></div><button class="btn btn-outline" type="submit">Назавжди видалити персонажа</button>
      </form></details>` : ''}
      <div class="command-box"><strong>Підтвердження входу в гру</strong><br><span id="mc-session-output">Отримай код входу для підтвердження персонажа у грі.</span></div>
      <div class="inline-actions"><button class="btn btn-outline btn-small" id="session-btn">Отримати код входу</button></div>
    </div>
    <div class="card profile-card asset-card" id="profile-skin-assets">
      <div class="card-title-row">
        <div>
          <span class="hc-overline">Налаштування вигляду</span>
          <h3>Зовнішність персонажа</h3>
        </div>
        <span class="badge good">Зображення PNG</span>
      </div>
      <p>Обери власний скін і плащ. Завантаж зображення або додай посилання на нього.</p>
      <div class="character-model-preview" id="character-model-preview">
        <div class="model-preview-head">
          <div>
            <strong>Попередній перегляд персонажа</strong>
            <span>Перевір, як виглядатиме персонаж спереду та ззаду.</span>
          </div>
          <span class="badge model-badge">${escapeHtml((skin.skinModel || 'classic').toUpperCase())}</span>
        </div>
        <div class="character-preview-grid">
          <section class="character-preview-card">
            <div class="character-preview-title">Спереду</div>
            <div class="character-preview-stage">
              <div class="character-preview-shadow"></div>
              <canvas class="character-preview-canvas mc-model-canvas" id="skin-model-front" width="260" height="380"></canvas>
            </div>
          </section>
          <section class="character-preview-card">
            <div class="character-preview-title">Ззаду</div>
            <div class="character-preview-stage">
              <div class="character-preview-shadow"></div>
              <canvas class="character-preview-canvas mc-model-canvas" id="skin-model-back" width="260" height="380"></canvas>
            </div>
          </section>
        </div>
        <div class="muted-small" id="skin-model-note">${skin.skinUrl ? 'Зовнішність оновлюється після завантаження.' : 'Додай скін, щоб побачити персонажа.'}</div>
      </div>
      <div class="skin-preview-grid">
        <div class="skin-preview-box">
          <span>Скін</span>
          ${skin.skinUrl ? `<img class="skin-preview-img" src="${escapeAttr(skin.skinUrl)}" alt="Скін">` : `<div class="skin-preview-empty">Скін не додано</div>`}
          ${skin.skinSize ? `<small>${escapeHtml(skin.skinSize.width)}x${escapeHtml(skin.skinSize.height)} · ${Math.round(Number(skin.skinSize.bytes || 0) / 1024)} КБ</small>` : ''}
        </div>
        <div class="skin-preview-box">
          <span>Плащ</span>
          ${skin.capeUrl ? `<img class="skin-preview-img cape" src="${escapeAttr(skin.capeUrl)}" alt="Плащ">` : `<div class="skin-preview-empty">Плащ не додано</div>`}
          ${skin.capeSize ? `<small>${escapeHtml(skin.capeSize.width)}x${escapeHtml(skin.capeSize.height)} · ${Math.round(Number(skin.capeSize.bytes || 0) / 1024)} КБ</small>` : ''}
        </div>
      </div>
      <div class="asset-actions-grid">
        <form class="form asset-form" id="skin-upload-form" enctype="multipart/form-data">
          <h4>Завантажити з комп'ютера</h4>
          <div class="field"><label>Skin PNG файл</label><input class="input file-input" type="file" name="skinFile" accept="image/png"></div>
          <div class="field"><label>Cape PNG файл</label><input class="input file-input" type="file" name="capeFile" accept="image/png"></div>
          <div class="field"><label>Модель</label><select class="input" name="skinModel"><option value="classic" ${skin.skinModel !== 'slim' ? 'selected' : ''}>Classic</option><option value="slim" ${skin.skinModel === 'slim' ? 'selected' : ''}>Slim</option></select></div>
          <div class="muted-small">Skin: 64x64 / 64x32 / 128x128 PNG. Cape: 64x32 / 64x64 / 128x64 PNG.</div>
          <div class="form-error"></div><div class="form-ok"></div>
          <button class="btn btn-primary" type="submit">Завантажити PNG</button>
        </form>
        <form class="form asset-form" id="skin-form">
          <h4>Вказати посилання</h4>
          <div class="field"><label>Skin PNG URL</label><input class="input" name="skinUrl" value="${escapeAttr(skin.skinUrl || '')}" placeholder="https://site/skin.png"></div>
          <div class="field"><label>Cape PNG URL</label><input class="input" name="capeUrl" value="${escapeAttr(skin.capeUrl || '')}" placeholder="https://site/cape.png"></div>
          <div class="field"><label>Модель</label><select class="input" name="skinModel"><option value="classic" ${skin.skinModel !== 'slim' ? 'selected' : ''}>Classic</option><option value="slim" ${skin.skinModel === 'slim' ? 'selected' : ''}>Slim</option></select></div>
          <div class="form-error"></div><div class="form-ok"></div>
          <div class="inline-actions"><button class="btn btn-outline" type="submit">Зберегти URL</button><button class="btn btn-soft" type="button" id="clear-skin-btn">Прибрати скін і плащ</button></div>
        </form>
      </div>
      
    </div>
    <div class="card profile-card hc-security-card" id="account-security"><span class="hc-overline">Доступ до акаунта</span><h3>Безпека акаунта</h3><p>Не передавай пароль іншим гравцям. Якщо забув його або хочеш відновити доступ, скористайся листом на свою пошту.</p><div class="hc-security-row"><div><strong>Електронна пошта</strong><p>${escapeHtml(user.email || 'Не вказано')}</p></div><a class="btn btn-outline btn-small" href="/forgot-password">Відновити пароль</a></div></div>
  `;
  requestAnimationFrame(() => renderMinecraftModelPreview(user));
  $('#logout-btn')?.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    location.href = '/';
  });
  $('#minecraft-link-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const error = $('.form-error', event.currentTarget);
    const ok = $('.form-ok', event.currentTarget);
    error.textContent = '';
    ok.textContent = '';
    try {
      const data = await api('/api/minecraft/link', {
        method: 'POST',
        body: JSON.stringify({ minecraftNick: form.get('minecraftNick'), minecraftUuid: form.get('minecraftUuid') })
      });
      ok.textContent = 'Привʼязку збережено.';
      renderProfile(root, data.user);
      refreshGuildTalents();
    } catch (e) {
      error.textContent = e.message;
    }
  });
  $('#character-delete-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const formEl = event.currentTarget, form = new FormData(formEl);
    const button = formEl.querySelector('button[type="submit"]');
    const error = $('.form-error', formEl); error.textContent = ''; button.disabled = true;
    try {
      const data = await api('/api/minecraft/character/delete', { method: 'POST', body: JSON.stringify({ confirmNick: form.get('confirmNick'), password: form.get('password') }) });
      renderProfile(root, data.user); refreshGuildTalents();
    } catch (failure) { error.textContent = failure.message; button.disabled = false; }
  });
  $('#skin-upload-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const error = $('.form-error', formEl);
    const ok = $('.form-ok', formEl);
    error.textContent = '';
    ok.textContent = '';
    try {
      const skinFile = formEl.querySelector('input[name="skinFile"]')?.files?.[0] || null;
      const capeFile = formEl.querySelector('input[name="capeFile"]')?.files?.[0] || null;
      const validPngFile = file => !file || (/\.png$/i.test(file.name) && (!file.type || /png/i.test(file.type)));
      if (!skinFile && !capeFile) throw new Error('Додай skin або cape PNG файл.');
      if (!validPngFile(skinFile)) throw new Error('Skin має бути PNG файлом.');
      if (!validPngFile(capeFile)) throw new Error('Cape має бути PNG файлом.');
      const data = await api('/api/minecraft/skin/upload', { method: 'POST', body: form });
      ok.textContent = 'Файли завантажено.';
      renderProfile(root, data.user);
      refreshGuildTalents();
    } catch (e) {
      error.textContent = e.message;
    }
  });
  $('#skin-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const error = $('.form-error', event.currentTarget);
    const ok = $('.form-ok', event.currentTarget);
    error.textContent = '';
    ok.textContent = '';
    try {
      const data = await api('/api/minecraft/skin/update', {
        method: 'POST',
        body: JSON.stringify({ skinUrl: form.get('skinUrl'), capeUrl: form.get('capeUrl'), skinModel: form.get('skinModel') })
      });
      ok.textContent = 'Скін збережено.';
      renderProfile(root, data.user);
      refreshGuildTalents();
    } catch (e) {
      error.textContent = e.message;
    }
  });
  $('#clear-skin-btn')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/minecraft/skin/clear', { method: 'POST', body: JSON.stringify({ kind: 'all' }) });
      renderProfile(root, data.user);
      refreshGuildTalents();
    } catch (e) {
      alert(e.message);
    }
  });
  $('#session-btn')?.addEventListener('click', async () => {
    try {
      const data = await api('/api/minecraft/session/start', { method: 'POST', body: '{}' });
      $('#mc-session-output').innerHTML = `<span class="kbd">${escapeHtml(data.token)}</span><br>Дійсний до ${new Date(data.expiresAt).toLocaleTimeString('uk-UA')}`;
    } catch (e) {
      $('#mc-session-output').textContent = e.message;
    }
  });
}

function normalizePreviewAssetUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    if (raw.startsWith('/uploads/')) return raw;
    if (raw.startsWith('/api/')) return raw;
    const url = new URL(raw, location.href);
    if (url.pathname.startsWith('/uploads/')) return `${url.pathname}${url.search}`;
    if (url.origin === location.origin) return `${url.pathname}${url.search}`;
    return `/api/minecraft/asset-proxy?url=${encodeURIComponent(url.href)}`;
  } catch {
    return raw;
  }
}

function loadPreviewImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image-load-failed: ${url}`));
    const normalized = normalizePreviewAssetUrl(url);
    if (!normalized) return reject(new Error('empty-image-url'));
    // Same-origin /uploads does not need CORS and is safer for canvas rendering.
    if (/^https?:\/\//i.test(normalized)) img.crossOrigin = 'anonymous';
    img.src = `${normalized}${normalized.includes('?') ? '&' : '?'}_hcpreview=${Date.now()}`;
  });
}

function makeDefaultSkinImage(model = 'classic') {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = false;
  const slim = model === 'slim';
  const armW = slim ? 3 : 4;
  function r(x, y, w, h, color) { c.fillStyle = color; c.fillRect(x, y, w, h); }
  // head base + overlay
  r(8, 8, 8, 8, '#c58b63'); r(24, 8, 8, 8, '#b77a55'); r(40, 8, 8, 8, 'rgba(64,40,26,.88)'); r(56, 8, 8, 8, 'rgba(52,32,20,.88)');
  r(10, 11, 2, 1, '#2b1b12'); r(14, 11, 2, 1, '#2b1b12'); r(11, 14, 4, 1, '#7f3e35');
  // torso
  r(20, 20, 8, 12, '#2f6bb2'); r(32, 20, 8, 12, '#275990'); r(20, 36, 8, 12, 'rgba(255,255,255,.05)');
  // arms
  r(44, 20, armW, 12, '#c58b63'); r(36, 52, armW, 12, '#c58b63'); r(52, 20, armW, 12, '#b77a55'); r(44, 52, armW, 12, '#b77a55');
  // legs
  r(4, 20, 4, 12, '#314d86'); r(20, 52, 4, 12, '#314d86'); r(12, 20, 4, 12, '#263e6e'); r(28, 52, 4, 12, '#263e6e');
  const img = new Image();
  img.src = canvas.toDataURL('image/png');
  return new Promise(resolve => { img.onload = () => resolve(img); });
}

async function renderMinecraftModelPreview(user) {
  const front = $('#skin-model-front');
  const back = $('#skin-model-back');
  const note = $('#skin-model-note');
  if (!front || !back) return;

  const skin = user?.skin || {};
  const model = skin.skinModel || 'classic';
  const skinUrl = skin.skinUrl || '';
  const capeUrl = skin.capeUrl || '';

  drawLoadingModel(front, 'Завантаження...');
  drawLoadingModel(back, 'Завантаження...');
  if (note) note.textContent = 'Завантаження skin/cape preview...';

  try {
    const img = skinUrl ? await loadPreviewImage(skinUrl) : await makeDefaultSkinImage(model);
    let cape = null;
    if (capeUrl) {
      try { cape = await loadPreviewImage(capeUrl); } catch (error) { console.warn('[HomeCraft] Плащ load failed', error); }
    }
    drawMinecraftModel(front, img, model, 'front', cape);
    drawMinecraftModel(back, img, model, 'back', cape);
    if (note) {
      note.textContent = skinUrl
        ? 'Preview зібрано з skin/cape Home Craft. Якщо файл оновився, натисни Ctrl+F5.'
        : 'Skin не заданий — показано базову модель. Додай PNG, щоб побачити власний вигляд.';
    }
  } catch (error) {
    console.warn('[HomeCraft] Скін render failed', error);
    drawEmptyModel(front, 'Skin не завантажився');
    drawEmptyModel(back, 'Skin не завантажився');
    if (note) note.textContent = 'Не вдалося завантажити skin PNG. Перевір, що URL відкривається у браузері або завантаж файл через сайт.';
  }
}

function drawLoadingModel(canvas, text) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = 'rgba(6, 10, 18, .22)';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,185,46,.92)';
  ctx.font = 'bold 15px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2);
}

function drawEmptyModel(canvas, text) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = 'rgba(6, 10, 18, .20)';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.18)';
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 16, w - 32, h - 32);
  ctx.fillStyle = 'rgba(175,193,214,.9)';
  ctx.font = 'bold 16px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, w / 2, h / 2);
}

function drawMinecraftModel(canvas, skinImg, model, side, capeImg) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;

  const slim = model === 'slim';
  const armW = slim ? 3 : 4;
  const modelWidthUnits = armW * 2 + 8;
  const modelHeightUnits = 32;
  const px = Math.max(7, Math.floor(Math.min((w * 0.78) / modelWidthUnits, (h * 0.84) / modelHeightUnits)));
  const totalModelW = modelWidthUnits * px;
  const totalModelH = modelHeightUnits * px;
  const left = Math.round((w - totalModelW) / 2);
  const top = Math.round(h - totalModelH - Math.max(18, h * 0.045));

  const scale = skinImg.width >= 128 ? 2 : 1;
  const legacy = skinImg.height <= 32 * scale;

  function skin(x, y, sw, sh, dx, dy, dw = sw, dh = sh) {
    try {
      ctx.drawImage(skinImg, x * scale, y * scale, sw * scale, sh * scale, Math.round(dx), Math.round(dy), Math.round(dw * px), Math.round(dh * px));
    } catch (error) { console.warn('[HomeCraft] draw skin failed', error); }
  }

  function cape(x, y, sw, sh, dx, dy, dw = sw, dh = sh) {
    if (!capeImg) return;
    const cs = capeImg.width >= 128 ? 2 : 1;
    try {
      ctx.drawImage(capeImg, x * cs, y * cs, sw * cs, sh * cs, Math.round(dx), Math.round(dy), Math.round(dw * px), Math.round(dh * px));
    } catch (error) { console.warn('[HomeCraft] draw cape failed', error); }
  }

  const headX = left + armW * px;
  const headY = top;
  const bodyX = headX;
  const bodyY = top + 8 * px;
  const armY = bodyY;
  const legY = bodyY + 12 * px;
  const rightArmX = left;
  const leftArmX = left + (armW + 8) * px;
  const rightLegX = bodyX;
  const leftLegX = bodyX + 4 * px;
  const capeX = bodyX - Math.round(px * 1.1);
  const capeY = bodyY - Math.round(px * 0.28);

  if (side === 'back' && capeImg) {
    cape(1, 1, 10, 16, capeX, capeY, 10.2, 16.8);
  }

  if (side === 'front') {
    if (capeImg) {
      cape(1, 1, 1, 16, rightArmX - Math.round(px * 0.42), capeY + px, 1, 15);
      cape(10, 1, 1, 16, leftArmX + armW * px + Math.round(px * 0.06), capeY + px, 1, 15);
    }
    skin(8, 8, 8, 8, headX, headY);
    skin(20, 20, 8, 12, bodyX, bodyY);
    skin(44, 20, armW, 12, rightArmX, armY, armW, 12);
    skin(36, legacy ? 20 : 52, armW, 12, leftArmX, armY, armW, 12);
    skin(4, 20, 4, 12, rightLegX, legY);
    skin(20, legacy ? 20 : 52, 4, 12, leftLegX, legY);
    if (!legacy) {
      skin(20, 36, 8, 12, bodyX, bodyY);
      skin(44, 36, armW, 12, rightArmX, armY, armW, 12);
      skin(52, 52, armW, 12, leftArmX, armY, armW, 12);
      skin(4, 36, 4, 12, rightLegX, legY);
      skin(4, 52, 4, 12, leftLegX, legY);
    }
    skin(40, 8, 8, 8, headX, headY);
  } else {
    skin(24, 8, 8, 8, headX, headY);
    skin(32, 20, 8, 12, bodyX, bodyY);
    skin(52, 20, armW, 12, rightArmX, armY, armW, 12);
    skin(44, legacy ? 20 : 52, armW, 12, leftArmX, armY, armW, 12);
    skin(12, 20, 4, 12, rightLegX, legY);
    skin(28, legacy ? 20 : 52, 4, 12, leftLegX, legY);
    if (!legacy) {
      skin(52, 36, armW, 12, rightArmX, armY, armW, 12);
      skin(60, 52, armW, 12, leftArmX, armY, armW, 12);
      skin(12, 36, 4, 12, rightLegX, legY);
      skin(12, 52, 4, 12, leftLegX, legY);
    }
    skin(56, 8, 8, 8, headX, headY);
  }
}

async function initAdmin() {
  const root = $('#admin-root');
  if (!root) return;
  try {
    const data = await api('/api/admin/users');
    const rows = data.users.map(u => `
      <tr>
        <td>${escapeHtml(u.displayName || u.email)}<br><small>${escapeHtml(u.email)}</small></td>
        <td>${escapeHtml(u.minecraftNick || '—')}<br><small>${escapeHtml(u.minecraftUuid || '')}</small></td>
        <td><span class="badge ${u.isWhitelisted ? 'good' : 'bad'}">${u.isWhitelisted ? 'Whitelist' : 'No access'}</span></td>
        <td><span class="badge ${u.isBlocked ? 'bad' : 'good'}">${u.isBlocked ? 'Blocked' : 'Active'}</span></td>
        <td>${escapeHtml(u.role)}</td>
        <td class="inline-actions">
          <button class="btn btn-outline btn-small" data-admin-action="whitelist" data-id="${escapeAttr(u.id)}" data-value="${!u.isWhitelisted}">${u.isWhitelisted ? 'Зняти WL' : 'Дати WL'}</button>
          <button class="btn btn-soft btn-small" data-admin-action="block" data-id="${escapeAttr(u.id)}" data-value="${!u.isBlocked}">${u.isBlocked ? 'Розблок' : 'Блок'}</button>
        </td>
      </tr>`).join('');
    root.innerHTML = `<div class="card admin-card"><h3>Користувачі</h3><p>Перший акаунт отримує права адміністратора. За замовчуванням нові акаунти автоматично додаються у whitelist, якщо HOMECRAFT_AUTO_WHITELIST=true.</p><div class="table-scroll" role="region" aria-label="Список користувачів" tabindex="0"><table class="user-table"><thead><tr><th>Акаунт</th><th>Minecraft</th><th>Доступ</th><th>Стан</th><th>Роль</th><th>Дії</th></tr></thead><tbody>${rows || '<tr><td colspan="6">Поки немає користувачів</td></tr>'}</tbody></table></div></div>
      <div class="card admin-card" id="minecraft-connection-admin">
        <h3>Підключення окремого Minecraft-сервера</h3>
        <p>Коли PUBLIC_SITE_URL налаштовано, завантаж файл і поклади його в папку config ігрового сервера. Після цього перезапусти Minecraft звичайною кнопкою панелі.</p>
        <button type="button" class="btn btn-primary" id="download-minecraft-connection">Завантажити файл підключення</button>
        <button type="button" class="btn btn-outline" id="check-minecraft-connection">Перевірити зв’язок</button>
        <p class="form-message" id="minecraft-connection-status" role="status" aria-live="polite"></p>
        <p class="form-message" id="minecraft-connection-message"></p>
        <p><small>Файл містить серверний секрет. Зберігай його лише в config свого Minecraft-сервера.</small></p>
      </div>
      <div class="card admin-card js-resource-pack-card" id="resource-pack-admin">
        <h3>Server resource pack</h3>
        <p>Завантаж ZIP ресурспаку. Сайт збере правильний direct URL, SHA1 і resource-pack-id для server.properties.</p>
        <form id="resource-pack-upload-form" class="profile-form">
          <label>Resource pack ZIP<input class="file-input" type="file" name="resourcePackFile" accept=".zip,application/zip" required></label>
          <label>Повідомлення в Minecraft<input name="resourcePackPrompt" placeholder="Home Craft рекомендує встановити серверний ресурс-пак."></label>
          <label class="checkbox-row"><input type="checkbox" name="requireResourcePack" value="true"> Робити обовʼязковим для входу</label>
          <button class="btn btn-primary" type="submit">Завантажити resource pack</button>
          <p class="form-message js-resource-pack-upload-message"></p>
        </form>
        <div class="info-list">
          <div class="info-row"><span>URL</span><strong class="js-resource-pack-url">—</strong></div>
          <div class="info-row"><span>SHA1</span><strong class="js-resource-pack-sha1">—</strong></div>
          <div class="info-row"><span>ID</span><strong class="js-resource-pack-id">—</strong></div>
          <div class="info-row"><span>Розмір</span><strong class="js-resource-pack-size">—</strong></div>
        </div>
        <pre class="command-box js-resource-pack-snippet">Завантаж статус...</pre>
      </div>`;
    $$('[data-admin-action]', root).forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const value = btn.dataset.value === 'true';
      const action = btn.dataset.adminAction;
      const payload = { id };
      if (action === 'whitelist') payload.isWhitelisted = value;
      if (action === 'block') payload.isBlocked = value;
      await api('/api/admin/user/update', { method: 'POST', body: JSON.stringify(payload) });
      initAdmin();
    }));
    const checkConnectionButton = $('#check-minecraft-connection', root);
    async function updateConnectionStatus() {
      const status = $('#minecraft-connection-status', root);
      if (!status || !checkConnectionButton) return;
      checkConnectionButton.disabled = true;
      status.textContent = 'Перевіряємо зв’язок із сервером…';
      try {
        const result = await api('/api/admin/minecraft/connection/status');
        status.textContent = result.minecraftPaired
          ? 'Зв’язок працює: сайт отримує статус Minecraft-сервера.'
          : result.serverSecretConfigured
            ? 'Немає свіжого статусу Minecraft. Перевір, чи сервер запущено. Після заміни файлу підключення перезапусти Minecraft-сервер.'
            : 'Серверний секрет сайту не налаштовано. Запусти сайт через npm start і завантаж новий файл підключення.';
      } catch (error) { status.textContent = 'Не вдалося перевірити зв’язок: ' + error.message; }
      finally { checkConnectionButton.disabled = false; }
    }
    checkConnectionButton?.addEventListener('click', updateConnectionStatus);
    void updateConnectionStatus();
    const connectionButton = $('#download-minecraft-connection', root);
    connectionButton?.addEventListener('click', async () => {
      const message = $('#minecraft-connection-message', root);
      connectionButton.disabled = true;
      message.textContent = 'Готуємо файл…';
      try {
        const response = await fetch('/api/admin/minecraft/connection', { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok) { const error = await response.json(); throw new Error(error.error || 'Не вдалося завантажити файл'); }
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = 'homecraft-connection.properties';
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        message.textContent = 'Поклади файл у config Minecraft-сервера та перезапусти Minecraft-сервер у панелі.';
      } catch (error) { message.textContent = error.message; }
      finally { connectionButton.disabled = false; }
    });
    const resourceForm = $('#resource-pack-upload-form', root);
    if (resourceForm) {
      resourceForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const msg = $('.js-resource-pack-upload-message', resourceForm);
        const file = resourceForm.resourcePackFile?.files?.[0];
        if (!file) { if (msg) msg.textContent = 'Обери ZIP файл.'; return; }
        if (!/\.zip$/i.test(file.name)) { if (msg) msg.textContent = 'Файл має бути .zip'; return; }
        const form = new FormData(resourceForm);
        if (msg) msg.textContent = 'Завантаження...';
        try {
          await api('/api/admin/resource-pack/upload', { method: 'POST', body: form });
          if (msg) msg.textContent = 'Resource pack оновлено. Скопіюй наведені параметри ресурспаку в server.properties через файловий менеджер панелі.';
          await refreshResourcePackStatus();
        } catch (error) {
          if (msg) msg.textContent = error.message;
        }
      });
    }
    refreshResourcePackStatus();
  } catch (e) {
    root.innerHTML = `<div class="card admin-card"><h3>Тільки для адміністратора</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

async function refreshGuildTalents() {
  const root = $('#guild-talents-profile');
  if (!root) return;
  try {
    const data = await api('/api/guild/talents/me');
    if (!data.guild) {
      root.innerHTML = `<div class="card"><h3>Таланти гільдії</h3><p class="muted-small">${data.reason === 'minecraft_not_linked' ? 'Привʼяжи Minecraft акаунт у профілі.' : data.reason === 'minecraft_not_verified' ? 'Увійди в Minecraft через HomeCraft Auth після привʼязки профілю, щоб підтвердити UUID.' : 'Поки немає синхронізованої гільдії для підтвердженого UUID.'}</p></div>`;
      return;
    }
    const guild = data.guild;
    if (!window.homecraftGuildCatalog) {
      const response = await fetch('/guild-talents-v2.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error('Каталог талантів недоступний');
      window.homecraftGuildCatalog = await response.json();
    }
    const nodes = window.homecraftGuildCatalog.talents || [];
    const trees = [['member', 'Учасники · 24 таланти'], ['golem', 'Големи · 24 таланти']];
    const rankMap = guild.ranks || {};
    const activeTree = window.homecraftGuildTree === 'golem' ? 'golem' : 'member';
    const original = nodes.filter(n => n.tree === activeTree).sort((a,b) =>
      a.tier - b.tier || a.position.row - b.position.row || a.position.column - b.position.column);
    const byId = new Map(original.map(node => [node.id, node]));
    // Match the server-authored five-column Classic grid, no auto-reflow.
    const layout = new Map(original.map(n => [n.id, {
      column: Number(n.position.column), row: Number(n.position.row)
    }]));
    const row = original.length ? Math.max(...original.map(n => n.position.row)) + 1 : 1;
    const routes = original.flatMap(n => (n.dependencies?.allOf || []).filter(id => layout.has(id))
      .filter(id => layout.get(id).column === layout.get(n.id).column)
      .map(id => {
        const a = layout.get(id), b = layout.get(n.id);
        const active = Number(rankMap[id] || 0) > 0;
        return `<line x1="${22+a.column*58}" y1="${38+a.row*52}" x2="${22+b.column*58}" y2="${4+b.row*52}" stroke="${active?'#8abf75':'#69654d'}" stroke-width="3"/>`;
      })).join('');
    const graphHeight = Math.max(52, row * 52);
    const connectorSvg = `<svg class="guild-talent-links" viewBox="0 0 276 ${graphHeight}" width="276" height="${graphHeight}" aria-hidden="true">${routes}</svg>`;
    const tierLabels = [2,3,4,5].map(tier => {
      const item = original.find(n => n.tier === tier);
      if (!item) return '';
      const position = layout.get(item.id);
      return `<div class="guild-talent-tier" style="top:${position.row*52-16}px">Ярус ${tier} · ${item.requirements?.minSpentInTree ?? 0} очок у гілці</div>`;
    }).join('');
    const content = original.map(n => {
      const rank = Math.max(0, Number(rankMap[n.id] || 0));
      const position = layout.get(n.id);
      const iconName = String(n.icon || '').split('/').pop().replace(/\.png$/i, '');
      const safeIcon = /^[a-z0-9_]+$/.test(iconName) ? iconName : 'unknown';
      const dependencies = [...(n.dependencies?.allOf || []), ...(n.dependencies?.anyOf || [])];
      const effects = (n.rankEffects || []).find(effect => effect.rank === rank)?.bonuses || {};
      const bonusLine = Object.entries(effects).map(([key, value]) => `${key}: ${value}`).join(', ');
      const prerequisiteNames = dependencies.map(id => byId.get(id)?.name || id).join(', ');
      const summary = [n.name, n.description, `Ранг ${rank}/${n.maxRank}`, n.effect,
        bonusLine ? `Поточні характеристики: ${bonusLine}` : '',
        `Рівень гільдії: ${n.requirements.minGuildLevel}`,
        dependencies.length ? `Потрібні таланти: ${prerequisiteNames}` : 'Без попередніх талантів'].filter(Boolean).join('\n');
      const linked = dependencies.length ? ' linked' : '';
      return `<div class="guild-talent-node ${rank ? 'learned' : 'locked'}${linked}" style="grid-column:${position.column+1};grid-row:${position.row+1}" tabindex="0" data-tip="${escapeAttr(summary)}"><img src="/assets/guild-talents/${safeIcon}.png" alt="" loading="lazy"><span>${rank}/${n.maxRank}</span></div>`;
    }).join('');
    const tabs = trees.map(([id,label]) => `<button type="button" class="guild-talent-tab ${id===activeTree?'selected':''}" data-guild-tree="${id}" aria-pressed="${id===activeTree}">${label}</button>`).join('');
    const activeSpent = activeTree === 'member' ? guild.memberSpent : guild.golemSpent;
    const activeTotal = activeTree === 'member' ? guild.memberTotal : guild.golemTotal;
    const treeHtml = `<div class="guild-talents-tabs">${tabs}</div><section class="guild-talent-tree guild-talent-classic"><h4>${activeTree==='member'?'Учасники':'Големи'} — 24 таланти · Очки ${activeSpent}/${activeTotal}</h4><div class="guild-talent-grid">${connectorSvg}${tierLabels}${content}</div></section>`;
    root.innerHTML = `<div class="card"><h3>Дерево талантів: ${escapeHtml(guild.guildName)}</h3><p class="muted-small">48 талантів: 24 для учасників · 24 для големів</p>
      <p>Рівень ${guild.level}/10 · Учасники: ${guild.memberSpent}/${guild.memberTotal} (вільні ${guild.memberAvailable}) · Големи: ${guild.golemSpent}/${guild.golemTotal} (вільні ${guild.golemAvailable}) · Ревізія ${guild.revision}</p>
      ${(guild.migrationPending || guild.integrityError) ? `<p class="form-error">${guild.migrationPending ? 'У грі доступне безкоштовне анулювання старих талантів та перехід на V2.' : 'Після оновлення дерева потрібно безкоштовно анулювати старий розподіл у Minecraft.'}</p>` : ''}
      ${guild.freeReallocationAvailable && !guild.migrationPending ? '<p class="muted-small">Доступний один безкоштовний перевибір старого розподілу. Відкрий дерево талантів у Minecraft як глава гільдії.</p>' : ''}
      <div class="guild-talents-trees">${treeHtml}</div>
      <p class="muted-small">Очки незалежні: до 12 у кожній гілці. У Minecraft глава гільдії може скинути лише поточну гілку (не змінюючи другу) або повністю перевибрати обидві. На сайті доступний тільки перегляд.</p></div>`;
  } catch (error) {
    root.innerHTML = `<div class="card"><h3>Таланти гільдії</h3><p class="form-error">Не вдалося отримати таланти: ${escapeHtml(error.message)}</p></div>`;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#96;'); }

ensureDownloadNavLink();
setActiveNav();
bindCopyButtons();
bindAuthForms();
refreshStatus();
refreshMe();
initProfile();
if ($('#guild-talents-profile')) {
  $('#guild-talents-profile').addEventListener('click', event => {
    const tab = event.target.closest('[data-guild-tree]');
    if (!tab || !['member','golem'].includes(tab.dataset.guildTree)) return;
    window.homecraftGuildTree = tab.dataset.guildTree;
    refreshGuildTalents();
  });
  setInterval(refreshGuildTalents, 30000);
}
initAdmin();
refreshResourcePackStatus();
refreshClientMods();
setInterval(refreshStatus, 15000);
