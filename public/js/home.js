// Главная: создание баттла + лидерборд.
const $ = s => document.querySelector(s);

function getToken() {
  let t = localStorage.getItem('sb_token');
  if (!t) { t = crypto.randomUUID(); localStorage.setItem('sb_token', t); }
  return t;
}

$('#nick').value = localStorage.getItem('sb_nick') || '';
setFavicon('menu');

// --- выбор цвета (палитра приходит с сервера) ---
let PALETTE = [];
let onlineColor = null;          // онлайн: цвет создателя
let botColor = null;             // боты: цвет игрока (ботам сервер даёт рандом из оставшихся)
let hotseatColors = [];          // хотсит: цвет каждого игрока

// распределить n цветов по умолчанию (разные), сохраняя уже выбранные
function defaultColors(n, existing = []) {
  const out = [];
  for (let i = 0; i < n; i++) {
    let c = existing[i];
    if (!c || out.includes(c)) c = PALETTE.find(x => !out.includes(x)) || PALETTE[i % PALETTE.length];
    out.push(c);
  }
  return out;
}
function renderOnlineColor() {
  if (!PALETTE.length) return;
  renderColorDropdown($('#onlineColors'), PALETTE, onlineColor, c => { onlineColor = c; renderOnlineColor(); });
}
function renderBotColor() {
  if (!PALETTE.length) return;
  renderColorDropdown($('#botColors'), PALETTE, botColor, c => { botColor = c; renderBotColor(); });
}

// --- выбор режима ---
function showMode(mode) {
  $('#modeBtns').classList.toggle('hidden', !!mode);
  $('#editorOnline').classList.toggle('hidden', mode !== 'online');
  $('#editorHotseat').classList.toggle('hidden', mode !== 'hotseat');
  $('#editorBot').classList.toggle('hidden', mode !== 'bot');
}
document.querySelectorAll('.mode-btn[data-mode]').forEach(b =>
  b.addEventListener('click', () => {
    // онлайн требует аккаунт — сначала вход, потом редактор; одиночка/хотсит открываются сразу
    if (b.dataset.mode === 'online') requireLogin(() => showMode('online'));
    else showMode(b.dataset.mode);
  }));
document.querySelectorAll('[data-back]').forEach(b =>
  b.addEventListener('click', () => showMode(null)));

// --- браузер открытых лобби ---
const socket = io();
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderLobbies(list) {
  const box = $('#lobbiesList');
  if (!list.length) {
    box.innerHTML = '<p class="muted">Пока нет открытых лобби. Создай свой через «🌐 Онлайн» — и он появится здесь у всех!</p>';
    return;
  }
  const timerTxt = t => t ? `⏱ ${t / 60} мин/ход` : 'без таймера';
  box.innerHTML = list.map(l => {
    const full = l.players >= l.max;
    return `<div class="lobby-item ${full ? 'full' : ''}">
      <div class="info">
        <div class="host">🏴‍☠️ ${escapeHtml(l.host)}</div>
        <div class="meta">👤 ${l.players}/${l.max} · ${timerTxt(l.turnTimer)}</div>
      </div>
      <button class="small primary" data-join="${l.id}" ${full ? 'disabled' : ''}>${full ? 'Полно' : 'Войти'}</button>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-join]').forEach(b =>
    b.addEventListener('click', () => { location.href = '/game/' + b.dataset.join; }));
}
socket.on('lobbyList', renderLobbies);

$('#browseLobbiesBtn').addEventListener('click', () => requireLogin(() => {
  $('#lobbiesOverlay').classList.remove('hidden');
  socket.emit('lobbies:subscribe', list => renderLobbies(list || []));
}));
$('#lobbiesClose').addEventListener('click', () => {
  $('#lobbiesOverlay').classList.add('hidden');
  socket.emit('lobbies:unsubscribe');
});

// --- хотсит: поля имён по числу игроков ---
function renderHotseatNames() {
  const n = +$('#hotseatCount').value;
  const old = [...document.querySelectorAll('#hotseatNames input.hs-name')].map(i => i.value);
  hotseatColors = defaultColors(n, hotseatColors);
  $('#hotseatNames').innerHTML = Array.from({ length: n }, (_, i) => `
    <label>Игрок ${i + 1}</label>
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
      <input type="text" class="hs-name" maxlength="20" placeholder="${['Капитан', 'Адмирал', 'Боцман', 'Юнга'][i]}…" value="${old[i] ? old[i].replace(/"/g, '&quot;') : ''}" style="flex:1; min-width:150px">
      <div data-hs="${i}"></div>
    </div>`).join('');
  [...document.querySelectorAll('#hotseatNames [data-hs]')].forEach((sw, i) => {
    const taken = new Set(hotseatColors.filter((_, j) => j !== i));
    renderColorDropdown(sw, PALETTE, hotseatColors[i], c => { hotseatColors[i] = c; renderHotseatNames(); }, taken);
  });
}
$('#hotseatCount').addEventListener('change', renderHotseatNames);
renderHotseatNames();

$('#hotseatBtn').addEventListener('click', async () => {
  const nicks = [...document.querySelectorAll('#hotseatNames input.hs-name')].map(i => i.value.trim());
  if (nicks.some(n => !n)) { $('#hotseatError').textContent = 'Впиши имена всех игроков!'; return; }
  if (new Set(nicks).size !== nicks.length) { $('#hotseatError').textContent = 'Имена не должны повторяться'; return; }
  $('#hotseatBtn').disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getToken(), mode: 'hotseat', nicks, colors: hotseatColors, multiMove: $('#hotseatMulti').checked, gameMode: $('#hotseatMode').value })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    // ник нужен для входа на страницу игры (в хотсите не показывается)
    if (!localStorage.getItem('sb_nick')) localStorage.setItem('sb_nick', nicks[0]);
    location.href = '/game/' + data.gameId;
  } catch (e) {
    $('#hotseatError').textContent = e.message;
    $('#hotseatBtn').disabled = false;
  }
});

// ====== Авторизация: бейдж входа + модал. Онлайн/лобби требуют аккаунт ======
// Личность хранится в httpOnly-cookie (ставит сервер) — в JS её нет; состояние знаем из /api/auth/me.
let GOOGLE_ID = null, googleReady = false, me = { loggedIn: false }, pendingAction = null;

function renderBadge() {
  const box = $('#authBadge');
  if (!GOOGLE_ID) { box.classList.add('hidden'); return; }   // вход не настроен на сервере — бейдж не нужен
  box.classList.remove('hidden');
  if (me.loggedIn) {
    const ava = me.avatar
      ? `<span class="ava"><img src="${escapeHtml(me.avatar)}" alt="" referrerpolicy="no-referrer"></span>`
      : '<span class="ava">👤</span>';
    box.innerHTML = `${ava}<span class="who" title="${escapeHtml(me.email || '')}">${escapeHtml(me.nick || 'игрок')}</span><button class="small" id="logoutBtn" type="button">Выйти</button>`;
    $('#logoutBtn').addEventListener('click', doLogout);
  } else {
    box.innerHTML = '<button class="small primary" id="badgeLogin" type="button">🔑 Войти</button>';
    $('#badgeLogin').addEventListener('click', () => openLogin(null));
  }
}

async function loadMe() {
  try { me = await (await fetch('/api/auth/me')).json(); } catch { me = { loggedIn: false }; }
  if (me.loggedIn && me.nick) {
    // вошёл → ник аккаунта главнее всего, что осталось в localStorage от прошлых сессий
    localStorage.setItem('sb_nick', me.nick);
    $('#nick').value = me.nick;
    $('#botNick').value = me.nick;
  }
  renderBadge();
}

function initGoogle() {
  if (googleReady || !GOOGLE_ID) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.onload = () => {
    googleReady = true;
    google.accounts.id.initialize({ client_id: GOOGLE_ID, callback: onGoogleCredential });
    if (!$('#loginOverlay').classList.contains('hidden')) renderLoginBtn();
  };
  document.head.appendChild(s);
}
function renderLoginBtn() {
  if (!googleReady) { initGoogle(); return; }   // скрипт ещё грузится — отрисуем по onload
  const box = $('#loginBtnBox'); box.innerHTML = '';
  google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', text: 'signin_with' });
}
function openLogin(action) {
  pendingAction = action || null;
  $('#loginError').textContent = '';
  $('#loginOverlay').classList.remove('hidden');
  renderLoginBtn();
}
function closeLogin() { $('#loginOverlay').classList.add('hidden'); pendingAction = null; }

async function onGoogleCredential(resp) {
  // Шлём только ЯВНО введённый ник (не из localStorage — там мог остаться ник прошлого аккаунта).
  const nick = ($('#nick').value || '').trim();
  try {
    const r = await fetch('/api/auth/google', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: resp.credential, nick })
    });
    const data = await r.json();
    if (!r.ok) { $('#loginError').textContent = data.error || 'Не удалось войти'; return; }
    me = { loggedIn: true, nick: data.nick, email: data.email, avatar: data.avatar };
    // аккаунт — источник правды: применяем его сохранённый ник везде
    localStorage.setItem('sb_nick', data.nick);
    $('#nick').value = data.nick;
    $('#botNick').value = data.nick;
    renderBadge();
    const act = pendingAction;
    closeLogin();
    if (act) act();   // продолжить то, ради чего входили (онлайн/лобби)
  } catch { $('#loginError').textContent = 'Сеть недоступна'; }
}

async function doLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* всё равно сбросим локально */ }
  try { if (googleReady) google.accounts.id.disableAutoSelect(); } catch { /* GSI не загружен */ }
  localStorage.removeItem('sb_nick');   // чтобы следующий вход не унаследовал ник прошлого аккаунта
  me = { loggedIn: false };
  location.reload();
}

// онлайн/лобби требуют аккаунт; без Google (локалка) или уже вошёл — просто продолжаем
function requireLogin(action) {
  if (!GOOGLE_ID || me.loggedIn) return action();
  openLogin(action);
}

$('#loginClose').addEventListener('click', closeLogin);
$('#loginOverlay').addEventListener('click', e => { if (e.target.id === 'loginOverlay') closeLogin(); });

// Конфиг сервера: палитра цветов + игровые режимы + (опц.) Google-вход.
(async () => {
  try {
    const cfg = await (await fetch('/api/config')).json();
    // палитра — рисуем пикеры цвета во всех редакторах
    PALETTE = Array.isArray(cfg.palette) && cfg.palette.length ? cfg.palette
      : ['#c0392b', '#2980b9', '#27ae60', '#8e44ad'];
    onlineColor = PALETTE[0];
    botColor = PALETTE[0];
    renderOnlineColor();
    renderBotColor();
    renderHotseatNames();
    // селекторы игрового режима (из включённых на сервере) + показ описания выбранного
    const modes = Array.isArray(cfg.modes) && cfg.modes.length ? cfg.modes : [{ key: 'classic', name: 'Классический', desc: '' }];
    document.querySelectorAll('.game-mode-sel').forEach(sel => {
      sel.innerHTML = modes.map(m => `<option value="${m.key}">${m.name}</option>`).join('');
      const desc = sel.parentElement.querySelector('.mode-desc');
      const upd = () => { if (desc) desc.textContent = (modes.find(m => m.key === sel.value) || {}).desc || ''; };
      sel.addEventListener('change', upd); upd();
    });
    // авторизация
    GOOGLE_ID = cfg.googleClientId || null;
    if (GOOGLE_ID) initGoogle();
    await loadMe();
  } catch { renderBadge(); /* без сервера-конфига всё равно показываем что есть */ }
})();

$('#createBtn').addEventListener('click', async () => {
  const nick = $('#nick').value.trim();
  if (!nick) { $('#createError').textContent = 'Сначала впиши ник!'; return; }
  localStorage.setItem('sb_nick', nick);
  $('#createBtn').disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: getToken(),
        nick,
        color: onlineColor,
        maxPlayers: +$('#maxPlayers').value,
        turnTimer: +$('#turnTimer').value,
        fog: $('#onlineFog').checked,
        multiMove: $('#onlineMulti').checked,
        gameMode: $('#onlineMode').value
      })
    });
    const data = await res.json();
    // редкий случай: cookie протухла между открытием редактора и созданием — попросим войти и повторим
    if (res.status === 401 && data.needAuth) { $('#createBtn').disabled = false; return openLogin(() => $('#createBtn').click()); }
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    location.href = '/game/' + data.gameId;
  } catch (e) {
    $('#createError').textContent = e.message;
    $('#createBtn').disabled = false;
  }
});

// --- против компьютера ---
$('#botNick').value = localStorage.getItem('sb_nick') || '';
$('#botBtn').addEventListener('click', async () => {
  const nick = $('#botNick').value.trim();
  if (!nick) { $('#botError').textContent = 'Впиши ник!'; return; }
  localStorage.setItem('sb_nick', nick);
  $('#botBtn').disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: getToken(),
        mode: 'bot',
        nick,
        bots: +$('#botCount').value,
        level: $('#botLevel').value,
        color: botColor,
        fog: $('#botFog').checked,
        multiMove: $('#botMulti').checked,
        gameMode: $('#botMode').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    location.href = '/game/' + data.gameId;
  } catch (e) {
    $('#botError').textContent = e.message;
    $('#botBtn').disabled = false;
  }
});

(async function loadLeaderboard() {
  try {
    const rows = await (await fetch('/api/leaderboard')).json();
    if (!rows.length) return;
    const medals = ['🥇', '🥈', '🥉'];
    $('#leaderboard tbody').innerHTML = rows.map((r, i) => `
      <tr>
        <td class="medal">${medals[i] || i + 1}</td>
        <td>${escapeHtml(r.nick)}</td>
        <td><b>${r.points}</b></td>
        <td>${r.wins}</td>
        <td>${r.games}</td>
        <td>${r.damage}</td>
        <td>${r.sunk}</td>
        <td>${r.gold}</td>
      </tr>`).join('');
  } catch { /* лидерборд не критичен */ }
})();
