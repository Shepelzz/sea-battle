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

// Ошибка в редакторе — снимок ответа сервера, а не вечная истина: «слишком много партий»
// перестаёт быть правдой, как только игрок закроет лишнюю. Гасим её на каждом действии,
// после которого сообщение может врать: смена экрана, новая попытка, закрытие партии.
const EDITOR_ERRORS = ['#createError', '#hotseatError', '#botError'];
function clearEditorErrors() {
  EDITOR_ERRORS.forEach(sel => { const el = $(sel); if (el) el.textContent = ''; });
}

// --- выбор режима ---
function showMode(mode) {
  clearEditorErrors();
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
// Закрытие партии (своё лобби в списке или «моя игра») — одно и то же действие с одним ответом.
function finishGame(id) {
  socket.emit('game:finish', { gameId: id, token: getToken() }, res => {
    if (!res || !res.ok) return alert((res && errText(res)) || t('lobby.failed'));
    clearEditorErrors();   // партий стало меньше — старое «слишком много» больше не про нас
  });
}
function renderLobbies(list) {
  const box = $('#lobbiesList');
  if (!list.length) {
    box.innerHTML = `<p class="muted">${t('lobby.empty')}</p>`;
    return;
  }
  box.innerHTML = list.map(l => {
    const full = l.players >= l.max;
    const canEnter = !full || l.mine;                         // в полное лобби можно вернуться, если оно твоё
    const label = t(l.mine ? 'lobby.return' : (full ? 'lobby.full' : 'lobby.enter'));
    return `<div class="lobby-item ${full ? 'full' : ''}">
      <div class="info">
        <div class="host">🏴‍☠️ ${escapeHtml(l.host)}${l.isHost ? ' · ' + t('lobby.yours') : ''}</div>
        <div class="meta">👤 ${l.players}/${l.max}${(l.tags && l.tags.length) ? ' · ' + l.tags.map(x => escapeHtml(tr(x.k, x.p))).join(' · ') : ''}</div>
      </div>
      <button class="small primary" data-join="${l.id}" ${canEnter ? '' : 'disabled'}>${label}</button>
      ${l.isHost ? `<button class="small danger lobby-x" data-closelobby="${l.id}" title="${t('lobby.closeTitle')}">✕</button>` : ''}
    </div>`;
  }).join('');
  box.querySelectorAll('[data-join]').forEach(b =>
    b.addEventListener('click', () => { location.href = '/game/' + b.dataset.join; }));
  box.querySelectorAll('[data-closelobby]').forEach(b =>
    b.addEventListener('click', () => {
      if (!confirm(t('lobby.closeConfirm'))) return;
      finishGame(b.dataset.closelobby);
    }));
}
// «Мои игры» — секция сверху браузера: активные игры, в которых я участвую (онлайн и оффлайн)
function renderMyGames(list) {
  const box = $('#myGamesList');
  if (!box) return;
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3 class="browse-h">${t('lobby.myGames')}</h3>` + list.map(g => {
    // ник — чужой текст, а строка уходит в innerHTML: экранируем сами (см. шапку i18n.js)
    const turn = g.myTurn ? `<b>${t('lobby.myTurn')}</b>` : t('lobby.turnOf', { nick: escapeHtml(tr(g.turnNick)) });
    const kind = t(g.online ? 'lobby.kindOnline' : (g.hotseat ? 'lobby.kindHotseat' : 'lobby.kindBots'));
    const opp = (g.opponents && g.opponents.length) ? ' · ' + g.opponents.map(n => escapeHtml(tr(n))).join(', ') : '';
    return `<div class="lobby-item mygame ${g.myTurn ? 'myturn' : ''}">
      <div class="info">
        <div class="host">${escapeHtml(tr(g.mode))} · ${kind}</div>
        <div class="meta">${turn}${opp}</div>
      </div>
      <button class="small primary" data-resume="${g.id}">${t('lobby.enter')}</button>
      ${g.canFinish ? `<button class="small danger" data-finish="${g.id}">${t('lobby.finish')}</button>` : ''}
    </div>`;
  }).join('') + '<div class="browse-sep"></div>';
  box.querySelectorAll('[data-resume]').forEach(b =>
    b.addEventListener('click', () => { location.href = '/game/' + b.dataset.resume; }));
  box.querySelectorAll('[data-finish]').forEach(b =>
    b.addEventListener('click', () => {
      if (!confirm(t('lobby.finishConfirm'))) return;
      finishGame(b.dataset.finish);
    }));
}
// Бейдж на кнопке «найти игру»: сколько МОИХ штук ждёт внутри.
// Считаем и начатые партии, и незакрытые лобби — своё и те, куда я уже зашёл. Раньше в счёт
// шли только начатые (`myGameSummary` отсеивает всё, кроме status='active'), и открытое лобби
// в цифре не появлялось вовсе, хотя в списке под кнопкой оно есть.
// Пересечься эти два списка не могут: игра либо ещё лобби, либо уже активна.
function updateLobbyBadge(n) {
  const b = $('#lobbyBadge');
  if (!b) return;
  b.textContent = n > 0 ? String(n) : '';
  b.classList.toggle('hidden', !(n > 0));
}
// данные браузера приходят как { lobbies, myGames } (старый формат — просто массив лобби)
let lastBrowse = null;
function renderBrowse(data) {
  lastBrowse = data;
  const lobbies = Array.isArray(data) ? data : ((data && data.lobbies) || []);
  const myGames = Array.isArray(data) ? [] : ((data && data.myGames) || []);
  renderMyGames(myGames);
  renderLobbies(lobbies);
  updateLobbyBadge(myGames.length + lobbies.filter(l => l.mine).length);
}
socket.on('lobbyList', renderBrowse);
// Подписка на ленту лобби/«моих игр» — на КАЖДОМ (пере)подключении: и при загрузке (бейдж с числом игр),
// и после логина (там сокет переподключаем, чтобы сервер по новой сессионной куке пересчитал, что «моё»).
function subscribeBrowse() { socket.emit('lobbies:subscribe', { token: getToken() }, renderBrowse); }
socket.on('connect', subscribeBrowse);
if (socket.connected) subscribeBrowse();

$('#browseLobbiesBtn').addEventListener('click', () => {
  $('#lobbiesOverlay').classList.remove('hidden');
  socket.emit('lobbies:subscribe', { token: getToken() }, renderBrowse); // подтянуть свежие данные
});
$('#lobbiesClose').addEventListener('click', () => {
  $('#lobbiesOverlay').classList.add('hidden'); // не отписываемся — бейдж должен обновляться и дальше
});

// --- хотсит: поля имён по числу игроков ---
function renderHotseatNames() {
  const n = +$('#hotseatCount').value;
  const old = [...document.querySelectorAll('#hotseatNames input.hs-name')].map(i => i.value);
  hotseatColors = defaultColors(n, hotseatColors);
  // плейсхолдеры имён по номеру игрока: ключи перечислены явно, чтобы их видел test-i18n.mjs
  const namePh = [t('home.hsPh1'), t('home.hsPh2'), t('home.hsPh3'), t('home.hsPh4')];
  $('#hotseatNames').innerHTML = Array.from({ length: n }, (_, i) => `
    <label>${t('home.playerN', { n: i + 1 })}</label>
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap">
      <input type="text" class="hs-name" maxlength="20" placeholder="${namePh[i]}…" value="${old[i] ? old[i].replace(/"/g, '&quot;') : ''}" style="flex:1; min-width:150px">
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
  clearEditorErrors();
  const nicks = [...document.querySelectorAll('#hotseatNames input.hs-name')].map(i => i.value.trim());
  if (nicks.some(n => !n)) { $('#hotseatError').textContent = t('home.errNames'); return; }
  if (new Set(nicks).size !== nicks.length) { $('#hotseatError').textContent = t('home.errDupNames'); return; }
  $('#hotseatBtn').disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getToken(), mode: 'hotseat', nicks, colors: hotseatColors, multiMove: $('#hotseatMulti').checked, gameMode: $('#hotseatMode').dataset.mode })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(errText(data) || t('home.errServer'));
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
  // Язык вошедшего живёт в профиле — второй такой же переключатель в шапке не нужен.
  // Гостю профиль недоступен, ему переключатель в шапке оставляем.
  const topLang = document.querySelector('.top-bar [data-lang-switch]');
  if (topLang) topLang.classList.toggle('hidden', !!me.loggedIn);
  if (me.loggedIn) {
    const ava = me.avatar
      ? `<span class="ava"><img src="${escapeHtml(me.avatar)}" alt="" referrerpolicy="no-referrer"></span>`
      : '<span class="ava">👤</span>';
    // Профиль (смена ника, язык, статистика, выход) открывается кликом по ВСЕЙ таблетке —
    // и по аватарке, и по пустому месту внутри рамки, а не только по буквам ника.
    // Обработчик вешаем свойством, а не addEventListener: бейдж перерисовывается (смена языка,
    // сохранение ника), и слушатели бы копились.
    box.innerHTML = `${ava}<span class="who" title="${escapeHtml(me.email || '')}">${escapeHtml(me.nick || t('common.player'))}</span>`;
    box.classList.add('clickable');
    box.onclick = openProfile;
  } else {
    box.innerHTML = `<button class="small primary" id="badgeLogin" type="button">${t('common.login')}</button>`;
    box.classList.remove('clickable');
    box.onclick = null;          // у гостя внутри своя кнопка входа — таблетка кликом не занята
    $('#badgeLogin').addEventListener('click', () => openLogin(null));
  }
}

// язык сменили на лету — перерисовываем свою динамику (разметку обновит сам i18n.js)
window.addEventListener('sb:lang', () => {
  renderBadge();
  if (!$('#profileOverlay').classList.contains('hidden')) renderProfile();
  renderHotseatNames();
  if (lastBrowse) renderBrowse(lastBrowse);
});

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
    if (!r.ok) { $('#loginError').textContent = errText(data) || t('home.errLogin'); return; }
    me = { loggedIn: true, nick: data.nick, email: data.email, avatar: data.avatar, lang: data.lang };
    // у аккаунта свой язык — он главнее того, что выбрал гость на этом устройстве.
    // persist:false: значение и так пришло из профиля, писать его обратно незачем.
    if (data.lang) SBI18n.set(data.lang, { persist: false });
    // аккаунт — источник правды: применяем его сохранённый ник везде
    localStorage.setItem('sb_nick', data.nick);
    $('#nick').value = data.nick;
    $('#botNick').value = data.nick;
    renderBadge();
    // вошли без перезагрузки: переподключаем сокет, чтобы в рукопожатии была сессионная кука —
    // сервер увидит аккаунт и пересчитает «мои» лобби/игры (иначе список как у гостя до рефреша).
    socket.disconnect(); socket.connect();
    const act = pendingAction;
    closeLogin();
    if (act) act();   // продолжить то, ради чего входили (онлайн/лобби)
  } catch { $('#loginError').textContent = t('home.errNet'); }
}

// ====== Профиль капитана ======
// Открывается по нику в бейдже. Ник и язык меняются отсюда, не заходя в партию; статистику
// считает сервер (/api/profile), клиент только раскладывает по строчкам.
let profileData = null;
const fmtNum = n => Number(n || 0).toLocaleString(SBI18n.lang());
const fmtDate = ts => ts ? new Date(ts).toLocaleDateString(SBI18n.lang()) : '—';

async function openProfile() {
  $('#profileOverlay').classList.remove('hidden');
  $('#profileBody').innerHTML = `<p class="muted">${t('profile.loading')}</p>`;
  try {
    const r = await fetch('/api/profile');
    profileData = r.ok ? await r.json() : null;
  } catch { profileData = null; }
  if (!profileData) { $('#profileBody').innerHTML = `<p class="error">${t('home.errNet')}</p>`; return; }
  renderProfile();
}
function closeProfile() { $('#profileOverlay').classList.add('hidden'); }

function renderProfile() {
  const d = profileData;
  if (!d) return;
  const s = d.stats || {}, rk = s.ranked || {};
  const row = (label, value) => `<div class="pf-row"><span>${label}</span><b>${value}</b></div>`;
  const ava = d.avatar
    ? `<span class="ava"><img src="${escapeHtml(d.avatar)}" alt="" referrerpolicy="no-referrer"></span>`
    : '<span class="ava">👤</span>';
  // Пусто — так и пишем. Таблица из нулей выглядит как поломка, а не как «ты ещё не играл».
  const stats = s.games
    ? row(t('profile.games'), fmtNum(s.games))
      + row(t('profile.ranked'), fmtNum(rk.games))
      + row(t('profile.wins'), `${fmtNum(s.wins)} (${Math.round(s.wins / s.games * 100)}%)`)
      + row(t('profile.sunk'), fmtNum(s.sunk))
      + row(t('profile.lost'), fmtNum(s.lost))
      + row(t('profile.damage'), fmtNum(s.damage))
      + row(t('profile.gold'), '💰 ' + fmtNum(s.gold))
      + row(t('profile.rank'), rk.place
          ? t('profile.rankVal', { place: rk.place, total: rk.total, points: rk.points })
          : t('profile.noRank'))
      + row(t('profile.last'), fmtDate(s.lastAt))
    : `<p class="muted">${t('profile.empty')}</p>`;

  $('#profileBody').innerHTML = `
    <div class="pf-head">${ava}
      <div class="pf-who">
        <b id="pfWhoNick">${escapeHtml(d.nick || t('common.player'))}</b>
        ${d.email ? `<span class="muted">${escapeHtml(d.email)}</span>` : ''}
      </div>
    </div>
    <label for="pfNick">${t('profile.nick')}</label>
    <div class="pf-nick">
      <input type="text" id="pfNick" maxlength="20" value="${escapeHtml(d.nick || '')}">
      <button class="small primary" id="pfSave" type="button">${t('profile.save')}</button>
    </div>
    <p class="pf-msg" id="pfMsg"></p>
    <div class="pf-row"><span>${t('profile.lang')}</span><span data-lang-switch="full"></span></div>
    <label class="fog-toggle pf-mail" title="${escapeHtml(t('profile.mailHint'))}">
      <input type="checkbox" id="pfMail"${d.mailNudge ? ' checked' : ''}>
      <span>${t('profile.mail')}</span>
    </label>
    <p class="muted pf-note" style="margin:0">${t('profile.mailHint')}</p>
    <h3 class="pf-h">${t('profile.stats')}</h3>
    ${stats}
    <p class="muted pf-note">${t('profile.rankedNote')}</p>
    <div class="pf-foot">
      <span class="muted">${t('profile.since')} ${fmtDate(d.createdAt)}</span>
      <button class="small" id="pfLogout" type="button">${t('common.logout')}</button>
    </div>`;
  SBI18n.mount($('#profileBody [data-lang-switch]'));
  // Согласие сохраняем сразу по щелчку: отдельная кнопка «применить» для одного тумблера — лишняя.
  // Не сохранилось — возвращаем тумблер назад, чтобы он не врал про состояние на сервере.
  $('#pfMail').addEventListener('change', async e => {
    const on = e.target.checked;
    try {
      const r = await fetch('/api/profile/mail', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mailNudge: on })
      });
      if (!r.ok) throw new Error('save');
      profileData.mailNudge = on;
    } catch {
      e.target.checked = !on;
      const msg = $('#pfMsg'); msg.className = 'pf-msg error'; msg.textContent = t('home.errNet');
    }
  });
  $('#pfSave').addEventListener('click', saveNick);
  $('#pfNick').addEventListener('keydown', e => { if (e.key === 'Enter') saveNick(); });
  $('#pfLogout').addEventListener('click', doLogout);
}

async function saveNick() {
  const nick = ($('#pfNick').value || '').trim();
  const msg = $('#pfMsg');
  msg.className = 'pf-msg';
  if (!nick) { msg.classList.add('error'); msg.textContent = t('home.errNick'); return; }
  try {
    const r = await fetch('/api/profile/nick', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nick })
    });
    const data = await r.json();
    if (!r.ok) { msg.classList.add('error'); msg.textContent = errText(data) || t('home.errNet'); return; }
    // ник аккаунта — источник правды: подхватываем его везде, где он уже подставлен
    me.nick = profileData.nick = data.nick;
    localStorage.setItem('sb_nick', data.nick);
    $('#nick').value = data.nick;
    $('#botNick').value = data.nick;
    $('#pfWhoNick').textContent = data.nick;
    msg.classList.add('ok');
    msg.textContent = t('profile.saved');
    renderBadge();
    loadLeaderboard();   // в таблице под окном тоже должно стать новое имя, без перезагрузки
  } catch { msg.classList.add('error'); msg.textContent = t('home.errNet'); }
}

$('#profileClose').addEventListener('click', closeProfile);
$('#profileOverlay').addEventListener('click', e => { if (e.target.id === 'profileOverlay') closeProfile(); });

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
    // 🏷 версия сборки в подвале: номер из package.json + коммит и его дата
    const vEl = $('#buildVersion');
    if (vEl) {
      const v = cfg.version || {};
      // в подвале — только номер версии; сборка и дата остаются в /api/config и в логе сервера
      vEl.textContent = 'v' + (v.version || '?');
      vEl.title = v.build ? t('home.buildTitle', { build: v.build }) + (v.date ? ' · ' + v.date : '') : t('home.buildUnknown');
    }
    // селекторы игрового режима (из включённых на сервере) + показ описания выбранного
    const modes = (Array.isArray(cfg.modes) && cfg.modes.length ? cfg.modes : ['classic'])
      .map(key => ({ key, name: t(`mode.${key}.name`), desc: t(`mode.${key}.desc`) }));
    document.querySelectorAll('.mode-row .mode-dd').forEach(host => {
      // дуэль — только онлайн и против бота (строго 1на1); «на одном устройстве» её не предлагаем.
      const ms = host.id === 'hotseatMode' ? modes.filter(m => m.key !== 'duel') : modes;
      const desc = host.parentElement.querySelector('.mode-desc');
      // селектор количества участников: в дуэли строго 1на1 — прячем (онлайн: игроки, бот: противники)
      const countBox = host.id === 'onlineMode' ? $('#maxPlayersBox')
        : host.id === 'botMode' ? $('#botCountBox') : null;
      // ⚡ тумблер «Полный вперёд» (реалтайм, бета): доступен во всех режимах
      // (в «Развитии» мир идёт по времени, в дуэли закупка как обычно)
      const rtToggle = host.id === 'onlineMode' ? $('#onlineRealtime')
        : host.id === 'botMode' ? $('#botRealtime') : null;
      // «Ход тремя судами» несовместим с реалтаймом (там ходов нет вовсе):
      // включил «Полный вперёд» → тумблер хода гаснет и снимается, выключил → возвращается как был
      const multiToggle = host.id === 'onlineMode' ? $('#onlineMulti')
        : host.id === 'botMode' ? $('#botMulti') : null;
      const syncMulti = () => {
        if (!rtToggle || !multiToggle) return;
        const rtOn = rtToggle.checked;
        const row = multiToggle.closest('.fog-toggle');
        if (rtOn && !row.classList.contains('disabled')) {
          multiToggle.dataset.was = multiToggle.checked ? '1' : '';  // запомнить, как было
          multiToggle.checked = false;
          row.classList.add('disabled');
        } else if (!rtOn && row.classList.contains('disabled')) {
          multiToggle.checked = multiToggle.dataset.was !== '';      // вернуть как было
          row.classList.remove('disabled');
        }
      };
      rtToggle?.addEventListener('change', syncMulti);
      const apply = key => {
        if (desc) desc.textContent = (ms.find(m => m.key === key) || {}).desc || '';
        if (countBox) countBox.classList.toggle('hidden', key === 'duel');
      };
      const draw = () => renderModeDropdown(host, ms, host.dataset.mode, key => {
        host.dataset.mode = key; apply(key); draw();   // выбран режим — обновить кнопку, описание, селектор кол-ва
      });
      host.dataset.mode = ms[0].key;   // по умолчанию — первый режим (классический)
      draw(); apply(host.dataset.mode);
    });
    // авторизация
    GOOGLE_ID = cfg.googleClientId || null;
    if (GOOGLE_ID) initGoogle();
    await loadMe();
  } catch { renderBadge(); /* без сервера-конфига всё равно показываем что есть */ }
})();

// Создание онлайн-баттла. replace=true — «пересоздать»: сервер закроет уже открытое лобби
// и сделает новое. Ошибку показываем там, откуда пришли: из формы — под формой, из окна
// «лобби уже открыто» — в самом окне.
async function createOnline({ replace = false, errBox = '#createError' } = {}) {
  clearEditorErrors();
  const nick = $('#nick').value.trim();
  if (!nick) { $('#createError').textContent = t('home.errNickFirst'); return; }
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
        realtime: $('#onlineRealtime').checked, // ⚡ «Полный вперёд» (бета) — реалтайм без ходов
        gameMode: $('#onlineMode').dataset.mode,
        replace
      })
    });
    const data = await res.json();
    // редкий случай: cookie протухла между открытием редактора и созданием — попросим войти и повторим
    if (res.status === 401 && data.needAuth) { $('#createBtn').disabled = false; return openLogin(() => $('#createBtn').click()); }
    if (!res.ok) throw new Error(errText(data) || t('home.errServer'));
    // старое лобби ещё живо — спрашиваем, вернуться в него или пересоздать
    if (data.existing) { $('#createBtn').disabled = false; return openBusy(data); }
    location.href = '/game/' + data.gameId;
  } catch (e) {
    $(errBox).textContent = e.message;
    $('#createBtn').disabled = false;
  }
}
$('#createBtn').addEventListener('click', () => createOnline());

// --- окно «лобби уже открыто» ---
function openBusy(data) {
  $('#busyError').textContent = '';
  $('#busyText').textContent = t('home.busy.text', { players: data.players, max: data.max });
  $('#busyGo').onclick = () => { location.href = '/game/' + data.gameId; };
  $('#busyNew').onclick = () => { closeBusy(); createOnline({ replace: true, errBox: '#createError' }); };
  $('#busyOverlay').classList.remove('hidden');
}
function closeBusy() { $('#busyOverlay').classList.add('hidden'); }
$('#busyClose').addEventListener('click', closeBusy);
$('#busyOverlay').addEventListener('click', e => { if (e.target.id === 'busyOverlay') closeBusy(); });

// --- против компьютера ---
$('#botNick').value = localStorage.getItem('sb_nick') || '';
$('#botBtn').addEventListener('click', async () => {
  clearEditorErrors();
  const nick = $('#botNick').value.trim();
  if (!nick) { $('#botError').textContent = t('home.errNick'); return; }
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
        realtime: $('#botRealtime').checked, // ⚡ «Полный вперёд» (бета) — реалтайм без ходов
        gameMode: $('#botMode').dataset.mode
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(errText(data) || t('home.errServer'));
    location.href = '/game/' + data.gameId;
  } catch (e) {
    $('#botError').textContent = e.message;
    $('#botBtn').disabled = false;
  }
});

// Лидерборд берёт ник из таблицы players, поэтому после переименования он в базе уже новый —
// достаточно перечитать. Зовём и на старте, и после сохранения ника в профиле, иначе в таблице
// до перезагрузки страницы висит старое имя.
async function loadLeaderboard() {
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
}
loadLeaderboard();
