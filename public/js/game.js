// Клиент игры: лобби, canvas-карта «на листке в клетку», ходы по WebSocket.
const $ = s => document.querySelector(s);
const gameId = location.pathname.split('/').pop();
const canvas = $('#map');
const ctx = canvas.getContext('2d');

let state = null;          // последнее состояние с сервера
let myId = null;
let spectator = false;
let hotseatOwner = false;  // режим «на одном устройстве»: ходим за всех
let selectedShipId = null;
let mode = 'idle';         // idle | move | attack
let hoverPt = null;        // позиция курсора в координатах карты
let aim = null;            // тач-прицел хода: {sel, finger:{x,y}, dest:{x,y}, clamped}
const AIM_RATIO = 2 / 3;   // крестик на 2/3 пути от корабля до пальца (меньше тянуть пальцем на телефоне)
const AIM_GRAB_PX = 42;    // радиус зоны захвата корабля для drag-aim (экранные px)
const AIM_CANCEL_DIST = 32; // палец вернулся ~на корабль (мировые ед.) → ход/залп отменяется
let moveDemo = null;       // обучающая анимация жеста (тач, до первого хода игрока): {t0}
const IS_COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches); // сенсорный экран?
const hasMovedOnce = () => localStorage.getItem('sb_moved') === '1';
let basket = {};           // корзина верфи: {type: count}
let finishShown = false;
let lastEventSeq = -1;     // защита от повторного проигрывания анимаций

// --- identity ---
// Гостевой токен (для одиночки/хотсита). Аккаунт-сессия — в httpOnly-cookie (ставит сервер).
function getToken() {
  let t = localStorage.getItem('sb_token');
  if (!t) { t = crypto.randomUUID(); localStorage.setItem('sb_token', t); }
  return t;
}

let GOOGLE_ID = null, googleReady = false, me = { loggedIn: false };
let authRetried = false;   // одноразовый ре-коннект сокета после входа (старое рукопожатие было без cookie)
let bootDone = false, socketUp = false;   // авто-join только когда известны и сокет, и конфиг+аккаунт
let CHEATS_ON = false;   // тестовый режим (читы); приходит из /api/config — иначе «/» не открывает консоль
// 🐞 Отладка (флаг SB_DEBUG на сервере): консоль решений бота + инструменты над картой.
let DEBUG_ON = false;
let debugTool = null;    // null | 'move' | 'heal' | 'pirate' | 'ship' — что делает следующий клик
let debugFog = null;     // null — как в партии, 'on' — надеть туман, 'off' — снять
let debugEyes = false;   // рисовать «глазами бота»: обзор, угроза дому, общая цель
let botEyes = null;      // последние мысли бота (приходят с botlog)
let debugPick = null;    // выбранный корабль для переноса

const socket = io();

function join(nick) {
  socket.emit('join', { gameId, token: getToken(), nick }, res => {
    if (!res.ok) {
      // Вошли, но это соединение установлено ДО входа — его рукопожатие без cookie сессии.
      // Переподключаемся один раз: новое рукопожатие понесёт cookie, и сервер увидит аккаунт.
      if (res.needAuth && me.loggedIn && !authRetried) {
        authRetried = true;
        if (socket.connected) socket.disconnect();
        socket.connect();                       // обработчик 'connect' сам повторит join
        return;
      }
      showJoin(!!res.needAuth);
      if (!res.needAuth) $('#nickError').textContent = res.error || '';
      return;
    }
    authRetried = false;
    myId = res.playerId;
    spectator = res.spectator;
    hotseatOwner = !!res.hotseatOwner;
    $('#nickOverlay').classList.add('hidden');
  });
}

// окно входа в баттл; needAuth=true → онлайн-игра требует аккаунт
function showJoin(needAuth) {
  $('#nickOverlay').classList.remove('hidden');
  const showGoogle = !!GOOGLE_ID && !me.loggedIn;
  $('#googleAuthBox').classList.toggle('hidden', !showGoogle);
  // Жёстко прячем ручной ввод только когда вход нужен и мы ещё НЕ вошли — иначе не оставляем пустое окно.
  const lockToAuth = needAuth && !me.loggedIn;
  $('#nickInput').classList.toggle('hidden', lockToAuth);
  $('#nickBtn').classList.toggle('hidden', lockToAuth);
  $('#joinHint').textContent = !needAuth ? ''
    : (me.loggedIn
        ? 'Не удалось подтвердить сессию. Обнови страницу (⌘R / Ctrl+R) — должно пустить.'
        : 'Это онлайн-баттл — войди через Google, чтобы присоединиться. Статистика привяжется к аккаунту.');
  if (showGoogle) renderGoogleBtn();
}

socket.on('connect', () => { socketUp = true; tryAutoJoin(); });
// Авто-вход в игру — только когда знаем сокет + конфиг + аккаунт (/api/auth/me). Иначе зашли бы под
// устаревшим ником из localStorage и затёрли бы ник аккаунта на сервере (он апдейтит ник при join).
function tryAutoJoin() {
  if (!socketUp || !bootDone) return;
  const nick = localStorage.getItem('sb_nick');
  if (nick) join(nick);
  else showJoin(false);
}

function initGoogle() {
  if (googleReady || !GOOGLE_ID) return;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.onload = () => {
    googleReady = true;
    google.accounts.id.initialize({ client_id: GOOGLE_ID, callback: onGoogleCredential });
    if (!$('#nickOverlay').classList.contains('hidden')) renderGoogleBtn();
  };
  document.head.appendChild(s);
}
function renderGoogleBtn() {
  if (!googleReady) { initGoogle(); return; }
  const box = $('#googleBtn'); if (!box) return;
  box.innerHTML = '';
  google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', text: 'signin_with' });
}
async function onGoogleCredential(resp) {
  const nick = ($('#nickInput').value || '').trim();   // только явно введённый, не из localStorage
  try {
    const r = await fetch('/api/auth/google', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: resp.credential, nick })
    });
    const data = await r.json();
    if (!r.ok) { $('#nickError').textContent = data.error || 'Не удалось войти'; return; }
    me = { loggedIn: true, nick: data.nick, email: data.email, avatar: data.avatar };
    localStorage.setItem('sb_nick', data.nick);
    // Сокет подключался ДО входа (рукопожатие без cookie). Переподключаемся, чтобы сервер увидел
    // сессию; обработчик 'connect' сам сделает join — уже с cookie.
    authRetried = false;
    if (socket.connected) socket.disconnect();
    socket.connect();
  } catch { $('#nickError').textContent = 'Сеть недоступна'; }
}

// Конфиг сервера (читы + Google) и кто я.
(async () => {
  try {
    const cfg = await (await fetch('/api/config')).json();
    CHEATS_ON = cfg.cheats === true;
    DEBUG_ON = cfg.debug === true;
    if (DEBUG_ON) initDebug();
    GOOGLE_ID = cfg.googleClientId || null;
    if (state) render();                        // конфиг пришёл асинхронно — обновить (кнопка чата)
    if (GOOGLE_ID) {
      initGoogle();
      try { me = await (await fetch('/api/auth/me')).json(); } catch { /* не вошёл */ }
      if (me.loggedIn && me.nick) localStorage.setItem('sb_nick', me.nick); // аккаунт — источник правды
    }
  } catch { /* без Google тоже работаем */ }
  bootDone = true;
  tryAutoJoin();   // теперь знаем аккаунт → заходим под его ником (или показываем окно входа)
})();

$('#nickBtn').addEventListener('click', () => {
  const nick = $('#nickInput').value.trim();
  if (!nick) { $('#nickError').textContent = 'Впиши ник!'; return; }
  localStorage.setItem('sb_nick', nick);
  authRetried = false;                          // ручная попытка — даём свежий ре-коннект при нужде
  join(nick);
});
$('#nickInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#nickBtn').click(); });

socket.on('state', s => {
  const prev = state;
  state = s;
  // ⛈️ шторм: синхронизируем часы с сервером (перезарядки) и держим аним-цикл живым (движение непрерывно)
  if (s.rt) { rtSkew = s.rt.now - Date.now(); if (s.status === 'active') ensureAnimLoop(); }
  // сброс выбора, если корабль исчез или ход не наш
  if (selectedShipId && !state.ships.find(x => x.id === selectedShipId)) deselect();
  if (!isMyTurn()) deselect();
  // анимации событий хода (не проигрываем историю при первом входе)
  if (s.eventSeq !== lastEventSeq) {
    if (lastEventSeq >= 0 && s.events?.length) playEvents(s.events);
    lastEventSeq = s.eventSeq;
  }
  // первый вход в активную игру — камера на свою базу (а не на пустой центр карты)
  if (!centeredOnce && state.status === 'active' && state.map?.bases) {
    centerOnMyBase();
    centeredOnce = true;
  }
  render();
  if (selectedShipId) updateActionButtons(); // синхронизировать кнопки выбранного корабля с новым состоянием (борта залпа)
  updateOutpostPanel(); // ⛺ открытая панель аванпоста: обновить hp/золото, закрыть если снесли
  maybeMovesToast(prev, s); // «осталось N ходов» после моего суб-хода (режим ход-тремя-судами)
  updatePeaceBanner(prev, s); // баннер мирного времени (режим «Развитие»)
  updatePauseUI(s); // ⏸ пауза реалтайма: кнопка + оверлей
  if (anyBurning()) ensureAnimLoop(); // низкое HP базы → запустить анимацию огня/дыма
  Sound.onState(prev, s, myIdx());
  updateTab();
  // первый раз в активной игре и ты участник — показываем обучение (⛈️ шторм-бета — без тутора: там свой ритм)
  if (s.status === 'active' && s.map && !spectator && myIdx() >= 0 && !s.rt) Tutorial.start();
});

// иконка и заголовок вкладки сигналят, чей ход (видно из соседней вкладки)
let tabKey = '';
function updateTab() {
  if (!state) return;
  // favicon-канвас перерисовывать только на смену статуса/хода, а не на каждый broadcast (в RT — 4 раза/с)
  const key = state.status + '|' + (state.turn?.idx ?? '') + '|' + (state.rt ? 'rt' : '');
  if (key === tabKey) return;
  tabKey = key;
  if (state.status === 'lobby') {
    setFavicon('lobby'); document.title = '⏳ Лобби — Морской бой';
  } else if (state.status === 'finished') {
    setFavicon('over'); document.title = '🏁 Баттл окончен — Морской бой';
  } else if (state.status === 'active' && state.rt) {
    setFavicon('myturn'); document.title = '⚡ Полный вперёд — Морской бой';
  } else if (state.status === 'active' && !spectator && isMyTurn()) {
    setFavicon('myturn'); document.title = '🟢 Твой ход! — Морской бой';
  } else if (state.status === 'active') {
    setFavicon('wait');
    const cur = state.players[state.turn.idx]?.nick ?? '…';
    document.title = `🔴 Ход: ${cur} — Морской бой`;
  }
}

// ============ АНИМАЦИИ ============
let effects = [];          // активные эффекты {kind, ..., start, dur}
const animPos = new Map(); // shipId → промежуточная позиция на время «плавания»
let rafOn = false;
let lastFrameT = performance.now();

function addEffect(e) {
  effects.push({ ...e, start: performance.now() + (e.delay || 0) });
  ensureAnimLoop();
}
// единый цикл анимации крутится, пока есть эффекты ИЛИ горящие базы
function ensureAnimLoop() {
  if (!rafOn) { rafOn = true; lastFrameT = performance.now(); requestAnimationFrame(animTick); }
}

// Путь хода — квадратичная Безье: корабль выходит из старой позиции по
// СТАРОМУ курсу и плавно доворачивает на новый. Касательная = текущий курс.
function bezPt(e, t) {
  const u = 1 - t;
  return {
    x: u * u * e.fx + 2 * u * t * e.cx + t * t * e.tx,
    y: u * u * e.fy + 2 * u * t * e.cy + t * t * e.ty
  };
}
function bezAng(e, t) {
  const dx = 2 * (1 - t) * (e.cx - e.fx) + 2 * t * (e.tx - e.cx);
  const dy = 2 * (1 - t) * (e.cy - e.fy) + 2 * t * (e.ty - e.cy);
  return Math.atan2(dy, dx);
}

function animTick(now) {
  // 120Гц-дисплеи (ProMotion/новые телефоны): rAF стучит чаще, чем нужно — держим ~60 кадров/с.
  // Полкадра CPU/GC в подарок, а глазу разницы нет: движение и так сглаживание 4Гц-снапшотов.
  if (now - lastFrameT < 15) { requestAnimationFrame(animTick); return; }
  const dt = Math.min(0.05, (now - lastFrameT) / 1000); lastFrameT = now;
  // ⚡ реалтайм: корабли скользят к серверным позициям и ПЛАВНО доворачивают нос
  // (стейт ~4 Гц → экспоненциальное сглаживание координат и угла)
  if (state?.rt && state.ships) {
    const seen = new Set();
    for (const s of state.ships) {
      seen.add(s.id);
      const p = rtPos.get(s.id);
      if (!p) rtPos.set(s.id, { x: s.x, y: s.y, ...(typeof s.heading === 'number' ? { ang: s.heading } : {}) });
      else {
        const k = Math.min(1, dt * 6);
        p.x += (s.x - p.x) * k; p.y += (s.y - p.y) * k;
        if (typeof s.heading === 'number')
          p.ang = p.ang === undefined ? s.heading : p.ang + angNorm(s.heading - p.ang) * Math.min(1, dt * 8);
      }
    }
    for (const id of rtPos.keys()) if (!seen.has(id)) rtPos.delete(id); // потонувшие — прибрать
  }
  animPos.clear();
  for (const e of effects) {
    if (e.kind !== 'sail') continue;
    if (now < e.start) { animPos.set(e.shipId, { x: e.fx, y: e.fy }); continue; }
    const p = Math.min(1, (now - e.start) / e.moveDur);
    if (p >= 1) continue; // приплыл — позиция из состояния, след дорисовывается
    const k = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // ease-in-out
    const pt = bezPt(e, k);
    // ориентация по касательной к кривой, но в конце плавно доворачиваем точно на КУРС ХОДА
    // (= ship.heading на сервере, на нём же строятся борта залпа) — без рывка в момент прибытия
    let ang = bezAng(e, k);
    const settle = k < 0.7 ? 0 : (k - 0.7) / 0.3;
    if (settle) ang += angNorm(Math.atan2(e.ty - e.fy, e.tx - e.fx) - ang) * settle;
    animPos.set(e.shipId, { x: pt.x, y: pt.y, ang });
  }
  effects = effects.filter(e => now < e.start + e.dur);
  if (fogFade.length) fogFade = fogFade.filter(f => now - f.born < f.hold + f.fade); // отсев догоревших затуханий тумана
  updateBaseFires(dt);
  render(true); // каждый кадр — только канвас (DOM не трогаем, иначе магазин пересобирается 60 раз/сек)
  // ⛈️ шторм: пока партия активна, цикл живёт всегда — корабли движутся непрерывно
  if (effects.length || anyBurning() || fogFade.length || (state?.rt && state.status === 'active')) requestAnimationFrame(animTick);
  else { rafOn = false; animPos.clear(); render(); } // анимация кончилась — финальный полный рендер (DOM тоже)
}

// геометрия залпа в анимации: разнос стволов вдоль борта и вынос наружу к фальшборту (мировые ед.)
const BS_SPACING = 12, BS_BEAM = 9;

// выстрел любой пушки — один общий сэмпл «cannon»; пока он не подгрузился — старый синтез «shot» как запас
function fireSound(ev, delayMs, opts) {
  if (Sound.hasSample('cannon')) Sound.playSample('cannon', { delay: Math.max(0, delayMs) / 1000, ...opts });
  else Sound.playAt('shot', delayMs);
}

function playEvents(events) {
  // туман войны: события вне зоны видимости не анимируем и не озвучиваем (иначе видно бой в тумане)
  const fog = fogActive();
  const vis = fog ? visionCircles() : null;
  // место гибели МОЕГО корабля держим видимым на эту серию событий — чтобы показать смертельный выстрел и взрыв
  if (fog) for (const ev of events) {
    if (ev.type === 'explosion' && ev.ship && ev.ship.owner === myIdx()) {
      const st = ST(ev.ship.type), r = st ? Math.max(st.move, st.fireRange) * FOG_SHIP_MULT : 180;
      vis.push({ x: ev.x, y: ev.y, r });
    }
  }
  const hidden = (x, y) => fog && !fogVisible(x, y, vis);
  let delay = 0;
  for (const ev of events) {
    if (ev.type === 'move') {
      // изгиб пути: выходим по прошлому курсу, доворачиваем на цель
      const straight = Math.atan2(ev.ty - ev.fy, ev.tx - ev.fx);
      const prevAng = headings.get(ev.shipId) ?? straight;
      const d = Math.hypot(ev.tx - ev.fx, ev.ty - ev.fy);
      const lead = Math.min(d * 0.45, FX.sail.lead);
      const cx = ev.fx + Math.cos(prevAng) * lead;
      const cy = ev.fy + Math.sin(prevAng) * lead;
      headings.set(ev.shipId, straight); // курс на финише = НАПРАВЛЕНИЕ ХОДА (как ship.heading на сервере — чтоб борта залпа совпадали); трекаем всегда
      if (hidden(ev.fx, ev.fy) && hidden(ev.tx, ev.ty)) continue;
      if (!String(ev.shipId).startsWith('p')) Sound.playAt('move', delay); // пираты — без плеска
      addEffect({
        kind: 'sail', shipId: ev.shipId, fx: ev.fx, fy: ev.fy, cx, cy, tx: ev.tx, ty: ev.ty,
        moveDur: FX.sail.moveDur, dur: FX.sail.moveDur + FX.sail.wakeFade, delay
      });
      delay += FX.sail.moveDur; // следующие события (ход/выстрел пирата) ждут, пока лодка доплывёт
    } else if (ev.type === 'shot' && ev.auto) {
      // скорострельная очередь авианосца: трассер летит ПРЯМО (без дуги), звук автомата, плотный темп
      if (hidden(ev.fx, ev.fy) && hidden(ev.tx, ev.ty)) continue;
      const TR = 150; // время полёта трассера, мс
      Sound.playAt('autoshot', delay);
      addEffect({ kind: 'tracer', fx: ev.fx, fy: ev.fy, tx: ev.tx, ty: ev.ty, dur: TR, delay });
      const impact = delay + TR - 8;
      addEffect({ kind: 'spark', x: ev.tx, y: ev.ty, dur: 240, delay: impact });
      if (ev.dmg) addEffect({ kind: 'dmg', x: ev.tx, y: ev.ty, amount: ev.dmg, dur: 950, delay: impact });
      delay += 85; // следующий снаряд почти сразу — очередь
    } else if (ev.type === 'shot') {
      if (hidden(ev.fx, ev.fy) && hidden(ev.tx, ev.ty)) continue;
      fireSound(ev, delay, { vol: 0.95 });   // одиночный выстрел (мортира/пират/форт)
      addEffect({ kind: 'shell', fx: ev.fx, fy: ev.fy, tx: ev.tx, ty: ev.ty, dur: FX.shell.dur, delay });
      const impact = delay + FX.shell.dur - 20;
      Sound.playAt('hit', impact);
      addEffect({ kind: 'boom', x: ev.tx, y: ev.ty, big: false, dur: FX.boom.durSmall, delay: impact });
      if (ev.dmg) addEffect({ kind: 'dmg', x: ev.tx, y: ev.ty, amount: ev.dmg, dur: 1300, delay: impact });
      delay += FX.shell.dur + 140;
    } else if (ev.type === 'volley') {
      // 💥 БОРТОВОЙ ЗАЛП — визуально: маленькие ЯДРА вылетают из стволов по всей длине борта.
      // Пушки палят ВРАЗНОБОЙ (у каждой свой случайный момент), крайние стволы чуть доворачивают
      // наружу — «трапеция» наведения. В борт врага не целятся: урон считает сервер (ev.hits).
      if (hidden(ev.fx, ev.fy) && ev.hits.every(h => hidden(h.tx, h.ty))) continue;
      const showSpray = !hidden(ev.fx, ev.fy);      // ядра рисуем только если виден сам стрелявший
      // число выстрелов по классу стрелявшего: бриг и меньше — 3, фрегат — 4, линкор/король моря — 6
      const VOLLEY_SHOTS = { shkhuna: 3, brig: 3, fregat: 4, linkor: 6, carrier: 6 };
      const N = ev.full ? Math.max(1, ev.cannons || 6) : (VOLLEY_SHOTS[ev.shipType] || ev.cannons || 3);
      const TR = 170;                                // полёт ядра, мс
      const SPLAY = 0.22;                            // доворот крайних стволов наружу, рад (~13° на краю) — трапеция
      const ax = Math.cos(ev.sideDir - Math.PI / 2), ay = Math.sin(ev.sideDir - Math.PI / 2); // вдоль корпуса
      const ox = Math.cos(ev.sideDir), oy = Math.sin(ev.sideDir);                              // наружу (борт)
      const shots = [];
      for (let i = 0; i < N; i++) {
        let mx, my, dir;
        if (ev.full) {                                // чит-авианосец: стволы кольцом, ядро радиально
          const a = (i / N) * Math.PI * 2;
          mx = ev.fx + Math.cos(a) * BS_BEAM; my = ev.fy + Math.sin(a) * BS_BEAM; dir = a;
        } else {
          const off = (i - (N - 1) / 2) * BS_SPACING * 0.6; // стволы кучнее — центральные ~60% борта
          mx = ev.fx + ax * off + ox * BS_BEAM;
          my = ev.fy + ay * off + oy * BS_BEAM;
          const edge = N > 1 ? (i - (N - 1) / 2) / ((N - 1) / 2) : 0; // -1..+1 от центра к краям
          dir = ev.sideDir - edge * SPLAY;            // центр — прямо, края веером наружу (трапеция)
        }
        const reach = 150 + Math.random() * 60;
        shots.push({ mx, my, dir, tx: mx + Math.cos(dir) * reach, ty: my + Math.sin(dir) * reach });
      }
      // ВРАЗНОБОЙ + РАЗНЫМИ ЦИКЛАМИ: окна независимы, чтобы расширение звука не растягивало визуал.
      const VIS_WINDOW = 90 + N * 35;                    // визуал кучно по времени (вспышки/ядра)
      const SOUND_WINDOW = 170 + N * 70;                 // звук — интервалы ещё шире, раскат длиннее
      let last = delay;
      if (showSpray) {
        for (const s of shots) {                          // визуальный цикл: дульная вспышка + ядро
          const tv = delay + Math.random() * VIS_WINDOW;
          addEffect({ kind: 'ball', fx: s.mx, fy: s.my, tx: s.tx, ty: s.ty, dur: TR, delay: tv });
          addEffect({
            kind: 'muzzle', x: s.mx, y: s.my, dir: s.dir, dur: 640, delay: tv,
            puffs: Array.from({ length: 2 }, () => ({
              a: (Math.random() - 0.5) * 0.55, spd: 20 + Math.random() * 16,
              r0: 3 + Math.random() * 2, r1: 11 + Math.random() * 6, t0: Math.random() * 0.12
            }))
          });
          last = Math.max(last, tv + TR);
        }
        for (let i = 0; i < N; i++) {                      // звуковой цикл: свои (чуть бóльшие) паузы
          const ts = delay + Math.random() * SOUND_WINDOW;
          fireSound(ev, ts, { vol: 0.5, rate: 0.93 + Math.random() * 0.14, pan: (Math.random() * 2 - 1) * 0.5 });
        }
      }
      // урон засчитан сервером — «−N» и буханье показываем на реальных целях, вразнобой во время залпа
      const span = Math.max(1, last - delay);
      for (const h of ev.hits) {
        if (hidden(h.tx, h.ty)) continue;
        const impact = delay + span * (0.35 + Math.random() * 0.5);
        Sound.playAt('hit', impact);
        addEffect({ kind: 'boom', x: h.tx, y: h.ty, big: false, dur: FX.boom.durSmall, delay: impact });
        addEffect({ kind: 'dmg', x: h.tx, y: h.ty, amount: h.dmg, dur: 1300, delay: impact });
      }
      delay = last + 220;                            // конец очереди + хвост
    } else if (ev.type === 'repair') {
      // ремонт: жёлтый «луч» от ремонтника к цели + всплывающее зелёное «+N»
      if (hidden(ev.fx, ev.fy) && hidden(ev.tx, ev.ty)) continue;
      const TR = 240;
      addEffect({ kind: 'beam', fx: ev.fx, fy: ev.fy, tx: ev.tx, ty: ev.ty, dur: TR, delay });
      const impact = delay + TR - 20;
      if (ev.heal) addEffect({ kind: 'heal', x: ev.tx, y: ev.ty, amount: ev.heal, dur: 1200, delay: impact });
      delay += TR + 120;
    } else if (ev.type === 'explosion') {
      if (hidden(ev.x, ev.y)) continue;
      // потопленный корабль ещё виден, пока к нему летит ядро
      if (ev.ship && delay > 0) {
        addEffect({ kind: 'ghost', shipId: ev.shipId, ship: ev.ship, x: ev.x, y: ev.y, dur: delay });
      }
      Sound.playAt('wreck', delay);
      addEffect({ kind: 'boom', x: ev.x, y: ev.y, big: !!ev.big, dur: FX.boom.durBig, delay });
      // обломки досок + дым на месте затонувшего корабля (сразу после исчезновения)
      addEffect({
        kind: 'wreckage', x: ev.x, y: ev.y, dur: 1700, delay,
        planks: Array.from({ length: ev.big ? 8 : 6 }, () => ({
          ang: Math.random() * Math.PI * 2, dist: 8 + Math.random() * 24,
          rot: Math.random() * Math.PI, len: 7 + Math.random() * 8
        })),
        smoke: Array.from({ length: ev.big ? 6 : 4 }, () => ({
          dx: (Math.random() - 0.5) * 22, t0: Math.random() * 0.2,
          r: 7 + Math.random() * 9, rise: 28 + Math.random() * 34
        }))
      });
      // мой корабль утонул → держим видимость до конца анимации, затем туман плавно затягивает место
      if (fog && ev.ship && ev.ship.owner === myIdx()) {
        const st = ST(ev.ship.type), r = st ? Math.max(st.move, st.fireRange) * FOG_SHIP_MULT : 180;
        fogFade.push({ x: ev.x, y: ev.y, r, born: performance.now(), hold: delay + FX.boom.durBig, fade: 1300 });
        ensureAnimLoop();
      }
      delay += 350;
    } else if (ev.type === 'gold') {
      if (hidden(ev.x, ev.y)) continue;
      Sound.playAt('coin', delay);
      addEffect({ kind: 'gold', x: ev.x, y: ev.y, amount: ev.amount, dur: FX.gold.dur, delay });
      delay += 180;
    }
  }
}

// отрисовка эффектов поверх карты
// under=true — слой под кораблями (пенный след), иначе — поверх (ядра, взрывы, золото)
function drawEffects(under = false) {
  const now = performance.now();
  for (const e of effects) {
    if (now < e.start) continue;
    if (under !== (e.kind === 'sail')) continue;
    const p = Math.min(1, (now - e.start) / e.dur);
    if (e.kind === 'sail') {
      // пенный след за кормой: вдоль пройденной дуги, тает после прибытия
      const moveP = Math.min(1, (now - e.start) / e.moveDur);
      const k = moveP < 0.5 ? 2 * moveP * moveP : 1 - Math.pow(-2 * moveP + 2, 2) / 2;
      const fade = moveP < 1 ? 1 : 1 - (now - e.start - e.moveDur) / (e.dur - e.moveDur);
      const steps = 16;
      ctx.lineCap = 'round';
      for (let i = 1; i <= steps; i++) {
        const a = bezPt(e, k * (i - 1) / steps);
        const b = bezPt(e, k * i / steps);
        const fresh = i / steps; // у кормы — ярче и шире
        ctx.beginPath();
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(sx(b.x), sy(b.y));
        ctx.strokeStyle = `rgba(120,170,210,${(FX.sail.wakeAlpha * fresh + 0.08) * fade})`;
        ctx.lineWidth = Math.max(1.5, FX.sail.wakeWidth * view.scale) * (0.35 + 0.65 * fresh);
        ctx.stroke();
        // белая пена по центру
        ctx.beginPath();
        ctx.moveTo(sx(a.x), sy(a.y));
        ctx.lineTo(sx(b.x), sy(b.y));
        ctx.strokeStyle = `rgba(255,255,255,${0.5 * fresh * fade})`;
        ctx.lineWidth = Math.max(0.8, FX.sail.foamWidth * view.scale) * fresh;
        ctx.stroke();
      }
    } else if (e.kind === 'shell') {
      // ядро летит по дуге
      const x = e.fx + (e.tx - e.fx) * p;
      const y = e.fy + (e.ty - e.fy) * p - Math.sin(p * Math.PI) * FX.shell.arc;
      ctx.beginPath();
      ctx.arc(sx(x), sy(y), Math.max(2.5, FX.shell.size * view.scale), 0, Math.PI * 2);
      ctx.fillStyle = '#2b3a55';
      ctx.fill();
    } else if (e.kind === 'tracer') {
      // трассер очереди: летит ПО ПРЯМОЙ, яркий короткий след + светящаяся голова
      const x = e.fx + (e.tx - e.fx) * p, y = e.fy + (e.ty - e.fy) * p;
      const ang = Math.atan2(e.ty - e.fy, e.tx - e.fx);
      const len = 12 * view.scale;
      ctx.strokeStyle = 'rgba(255,200,70,.9)';
      ctx.lineWidth = Math.max(1.5, 2.4 * view.scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx(x - Math.cos(ang) * len / view.scale), sy(y - Math.sin(ang) * len / view.scale));
      ctx.lineTo(sx(x), sy(y));
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(sx(x), sy(y), Math.max(1.6, 2.4 * view.scale), 0, Math.PI * 2);
      ctx.fillStyle = '#fff3c0';
      ctx.fill();
    } else if (e.kind === 'ball') {
      // ядро бортового залпа: маленькая тёмная чугунная сфера, летит прямо
      const x = e.fx + (e.tx - e.fx) * p, y = e.fy + (e.ty - e.fy) * p;
      const r = Math.max(1.6, 2.3 * view.scale);
      ctx.beginPath(); ctx.arc(sx(x), sy(y), r, 0, Math.PI * 2);
      ctx.fillStyle = '#2b3a55'; ctx.fill();
      ctx.beginPath(); ctx.arc(sx(x) - r * 0.3, sy(y) - r * 0.3, r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.45)'; ctx.fill();      // блик на ядре
    } else if (e.kind === 'spark') {
      // искра попадания очереди — быстрая жёлтая вспышка (вместо «бума» ядра)
      const r = (4 + 7 * p) * view.scale;
      ctx.globalAlpha = 1 - p;
      ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd24a'; ctx.fill();
      ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), r * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff7d8'; ctx.fill();
      ctx.globalAlpha = 1;
    } else if (e.kind === 'boom') {
      const r = (e.big ? FX.boom.big : FX.boom.small) * (0.35 + 0.65 * p) * view.scale;
      ctx.globalAlpha = 1 - p;
      ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), r, 0, Math.PI * 2);
      ctx.fillStyle = '#e67e22'; ctx.fill();
      ctx.beginPath(); ctx.arc(sx(e.x), sy(e.y), r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = '#f1c40f'; ctx.fill();
      ctx.strokeStyle = '#c0392b';
      ctx.lineWidth = 2;
      for (let i = 0; i < FX.boom.shards; i++) {
        const a = (i / FX.boom.shards) * Math.PI * 2 + (e.big ? 0.4 : 0);
        ctx.beginPath();
        ctx.moveTo(sx(e.x) + Math.cos(a) * r * 1.1, sy(e.y) + Math.sin(a) * r * 1.1);
        ctx.lineTo(sx(e.x) + Math.cos(a) * r * 1.4, sy(e.y) + Math.sin(a) * r * 1.4);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    } else if (e.kind === 'wreckage') {
      const k = view.scale;
      const drift = 1 - Math.pow(1 - p, 2); // обломки разлетаются и оседают
      // дым поднимается и тает
      for (const s of e.smoke) {
        const sp = Math.max(0, (p - s.t0) / (1 - s.t0));
        if (sp <= 0) continue;
        ctx.globalAlpha = (1 - sp) * 0.5;
        ctx.beginPath();
        ctx.arc(sx(e.x + s.dx), sy(e.y) - s.rise * sp * k, s.r * (0.6 + sp) * k, 0, Math.PI * 2);
        ctx.fillStyle = '#6b6f76';
        ctx.fill();
      }
      // доски-обломки на воде
      ctx.globalAlpha = p > 0.6 ? (1 - p) / 0.4 : 1;
      ctx.strokeStyle = '#6b4a25';
      ctx.lineWidth = Math.max(2, 3.5 * k);
      ctx.lineCap = 'round';
      for (const pl of e.planks) {
        const cx = sx(e.x + Math.cos(pl.ang) * pl.dist * drift);
        const cy = sy(e.y + Math.sin(pl.ang) * pl.dist * drift);
        const half = pl.len * k;
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(pl.rot) * half, cy - Math.sin(pl.rot) * half);
        ctx.lineTo(cx + Math.cos(pl.rot) * half, cy + Math.sin(pl.rot) * half);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
    } else if (e.kind === 'gold') {
      // «+N» всплывает вверх, слегка растёт и тает
      const gx = sx(e.x);
      const gy = sy(e.y) - 26 * view.scale - FX.gold.rise * p;
      const scale = 1 + FX.gold.grow * p;
      ctx.globalAlpha = p < 0.12 ? p / 0.12 : Math.max(0, 1 - Math.max(0, (p - 0.5) / 0.5));
      ctx.font = `bold ${Math.max(14, FX.gold.font * view.scale) * scale}px Neucha, cursive`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = '#fdfbf3';
      ctx.fillStyle = '#a87900';
      ctx.strokeText(`+${e.amount} 💰`, gx, gy);
      ctx.fillText(`+${e.amount} 💰`, gx, gy);
      ctx.globalAlpha = 1;
    } else if (e.kind === 'dmg') {
      // «−N» всплывает над подбитой целью, красным и чуть мельче золота
      const dx = sx(e.x);
      const dy = sy(e.y) - 30 * view.scale - 42 * p;
      const scale = 1 + 0.35 * p;
      ctx.globalAlpha = p < 0.12 ? p / 0.12 : Math.max(0, 1 - Math.max(0, (p - 0.45) / 0.55));
      ctx.font = `bold ${Math.max(12, 14 * view.scale) * scale}px Neucha, cursive`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fdfbf3';
      ctx.fillStyle = '#c0392b';
      ctx.strokeText(`−${e.amount}`, dx, dy);
      ctx.fillText(`−${e.amount}`, dx, dy);
      ctx.globalAlpha = 1;
    } else if (e.kind === 'beam') {
      // жёлтый ремонтный луч: тянется от ремонтника к цели и гаснет
      const headP = Math.min(1, p * 1.7);
      const hx = e.fx + (e.tx - e.fx) * headP, hy = e.fy + (e.ty - e.fy) * headP;
      ctx.strokeStyle = `rgba(244,194,10,${0.85 * (1 - p)})`;
      ctx.lineWidth = Math.max(2, 3.2 * view.scale);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sx(e.fx), sy(e.fy));
      ctx.lineTo(sx(hx), sy(hy));
      ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.globalAlpha = 1 - p; // вспышка у цели
      ctx.beginPath(); ctx.arc(sx(e.tx), sy(e.ty), Math.max(2, (3 + 4 * p) * view.scale), 0, Math.PI * 2);
      ctx.fillStyle = '#fff3c0'; ctx.fill();
      ctx.globalAlpha = 1;
    } else if (e.kind === 'heal') {
      // «+N» всплывает над починенной целью, зелёным
      const dx = sx(e.x);
      const dy = sy(e.y) - 30 * view.scale - 42 * p;
      const scale = 1 + 0.35 * p;
      ctx.globalAlpha = p < 0.12 ? p / 0.12 : Math.max(0, 1 - Math.max(0, (p - 0.45) / 0.55));
      ctx.font = `bold ${Math.max(12, 14 * view.scale) * scale}px Neucha, cursive`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#fdfbf3';
      ctx.fillStyle = '#2e9e4f';
      ctx.strokeText(`+${e.amount}`, dx, dy);
      ctx.fillText(`+${e.amount}`, dx, dy);
      ctx.globalAlpha = 1;
    } else if (e.kind === 'muzzle') {
      // дымок у ствола: яркая дульная вспышка → серое пороховое облачко, дрейфует наружу и тает
      const k = view.scale, ox = Math.cos(e.dir), oy = Math.sin(e.dir);
      if (p < 0.22) { // вспышка у дула (первая пятая часть жизни)
        const fp = p / 0.22, fr = (6 + 7 * fp) * k;
        const fxs = sx(e.x + ox * 3), fys = sy(e.y + oy * 3);
        const g = ctx.createRadialGradient(fxs, fys, 0, fxs, fys, fr);
        g.addColorStop(0, `rgba(255,247,216,${1 - fp})`);
        g.addColorStop(0.5, `rgba(255,200,80,${0.8 * (1 - fp)})`);
        g.addColorStop(1, 'rgba(255,150,40,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(fxs, fys, fr, 0, Math.PI * 2); ctx.fill();
      }
      for (const pf of e.puffs) { // пороховые клубы — растут и дрейфуют наружу
        const sp = Math.max(0, (p - pf.t0) / (1 - pf.t0));
        if (sp <= 0) continue;
        const da = e.dir + pf.a;
        const cx = sx(e.x + Math.cos(da) * pf.spd * sp);
        const cy = sy(e.y + Math.sin(da) * pf.spd * sp);
        const r = (pf.r0 + (pf.r1 - pf.r0) * sp) * k;
        ctx.globalAlpha = (sp < 0.2 ? sp / 0.2 : (1 - sp)) * 0.5;
        ctx.fillStyle = '#cfd3d9';
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
}

// --- helpers ---
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const myIdx = () => {
  if (!state) return -1;
  if (state.config?.hotseat && hotseatOwner) return state.turn.idx; // ходим за текущего
  return state.players.findIndex(p => p.id === myId);
};
const isMyTurn = () => {
  if (!state || state.status !== 'active') return false;
  if (state.rt) return !spectator && myIdx() >= 0 && !!state.players[myIdx()]?.alive; // ⛈️ шторм: действуй когда хочешь
  return myIdx() === state.turn.idx && !!state.players[myIdx()]?.alive;
};
const ST = t => state.shipTypes[t];

// ── ⛈️ «Шторм» (реалтайм): без очереди ходов, стрельба по перезарядке ──
const isRT = () => !!state?.rt;         // сервер прислал rt-блок → реалтайм-партия
let rtSkew = 0;                          // серверные часы − наши (для честного отсчёта перезарядок)
// ⏸ на паузе «сейчас» замирает в моменте постановки — отсчёты перезарядок не тикают
const rtNow = () => state?.rt?.pausedAt || (Date.now() + rtSkew);
const cdLeft = (ship, key) => Math.max(0, (ship?.cd?.[key] || 0) - rtNow()); // мс до готовности орудия
const rtPos = new Map();                 // сглаженные позиции кораблей (стейт приходит ~4 Гц — скользим между)

// ── 🌬 ВЕТЕР (во всех режимах): множитель дальности/скорости для курса a ──
// r(θ) = move × (1 + k·сила·cos(θ − ветер)) → контур хода — «капля», вытянутая по ветру
const windK = a => 1 + (state?.windK ?? 0.35) * (state?.wind?.str || 0) * Math.cos(a - (state?.wind?.ang || 0));

// ── режим «ход тремя судами» ──
const movesPerTurn = () => state?.movesPerTurn || 1;          // бюджет ходов кораблями за ход
const multiMoveOn = () => movesPerTurn() > 1;                 // включён ли многоходовый режим
const movesUsed = () => state?.turn?.moves || 0;              // сколько уже сходило в этом ходу
const movesLeft = () => Math.max(0, movesPerTurn() - movesUsed());
const shipActed = id => !state?.rt && (state?.turn?.actedShips || []).includes(id); // корабль уже ходил в этом ходу (в шторме ходов нет)

// Нотифы-СТЕК сверху: новый добавляется СВЕРХУ и оттесняет прежние вниз, у каждого свой таймер
// (не накладываются друг на друга). kind: 'err' (красный) | 'info' (бумажный).
// Повтор того же сообщения подряд — продлеваем существующий, не плодим дубликаты.
function pushToast(msg, kind, ms = 2600) {
  const box = $('#toasts');
  if (!box) return;
  const top = box.firstElementChild;
  if (top && top.dataset.msg === msg && top.classList.contains(kind)) {
    clearTimeout(top._t);
    top._t = setTimeout(() => fadeToast(top), ms);
    return;
  }
  const el = document.createElement('div');
  el.className = 'toast-item ' + kind;
  el.textContent = msg;
  el.dataset.msg = msg;
  el.addEventListener('click', () => { clearTimeout(el._t); fadeToast(el); }); // тап по сообщению — закрыть принудительно
  box.insertBefore(el, box.firstChild);            // новый — сверху, прежние уходят вниз
  requestAnimationFrame(() => el.classList.add('show'));
  el._t = setTimeout(() => fadeToast(el), ms);
  while (box.children.length > 4) box.lastElementChild.remove(); // не копим бесконечно
}
function fadeToast(el) {
  el.classList.remove('show');
  setTimeout(() => el.remove(), 300);              // дать доиграть затуханию
}
function toast(msg) { pushToast(msg, 'err'); }
// Информационный нотиф (в т.ч. «осталось N ходов») — бумажный стикер в том же стеке.
function hudToast(msg, ms = 2600) { pushToast(msg, 'info', ms); }

// После моего суб-хода в режиме «ход тремя судами» — подсказать, сколько ходов осталось:
// иначе после постановки корабля «на якорь» неочевидно, что ход продолжается.
function maybeMovesToast(prev, s) {
  if (!multiMoveOn() || spectator || !isMyTurn()) return;
  if (!prev || prev.turn.idx !== s.turn.idx || prev.turn.number !== s.turn.number) return; // смена хода, а не суб-ход
  if ((s.turn.moves || 0) <= (prev.turn.moves || 0)) return; // ходов не прибавилось — действие не моё
  const left = movesLeft();
  if (left > 0) hudToast(`⚓ Осталось ходов: ${left} — ходи дальше или «Завершить ход»`);
}

// Баннер мирного времени (режим «Развитие»): сверху карты, ненавязчиво. Тает, когда мир кончился.
function updatePeaceBanner(prev, s) {
  const el = $('#peaceBanner');
  if (!el) return;
  const pc = s?.peace;
  const show = s?.status === 'active' && pc && pc.active && pc.until > 0;
  el.classList.toggle('hidden', !show);
  if (show) {
    if (pc.leftMs != null) { // ⚡ реалтайм: мир по времени — обратный отсчёт (обновляется тиками стейта)
      const sec = Math.ceil(pc.leftMs / 1000);
      el.textContent = `🕊 Мирное время — до войны ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    } else {
      const left = Math.max(1, pc.until - pc.round + 1);
      const word = left === 1 ? 'раунд' : left < 5 ? 'раунда' : 'раундов';
      el.textContent = `🕊 Мирное время — до войны ${left} ${word}`;
    }
  } else if (prev?.peace?.active && pc && !pc.active) {
    hudToast('⚔️ Мирное время кончилось — война!', 4000); // разовый сигнал на старте войны
  }
}

// ⏸ Пауза реалтайма: кнопка в шапке (только участникам активной RT-партии) + оверлей поверх карты.
// Ставит любой живой игрок, снимает тоже ЛЮБОЙ (кнопкой или «Продолжить» на оверлее).
function updatePauseUI(s) {
  const btn = $('#pauseBtn'), ov = $('#pauseOverlay');
  if (!btn || !ov) return;
  const rtActive = s?.status === 'active' && s.rt && !spectator && myIdx() >= 0 && s.players[myIdx()]?.alive;
  btn.classList.toggle('hidden', !rtActive);
  const paused = !!(rtActive && s.rt.pausedAt);
  btn.textContent = paused ? '▶️' : '⏸';
  btn.title = paused ? 'Продолжить' : 'Пауза';
  ov.classList.toggle('hidden', !paused);
  if (paused) {
    const who = s.players[s.rt.pausedBy]?.nick || '?';
    $('#pauseWho').textContent = `⏸ Пауза — игру остановил ${who}`;
  }
}

// Записка-стикер над кораблём «на якоре» (уже ходил). screenX/screenY — экранные px (под mapWrap).
let shipNoteTimer = null;
function showShipNote(screenX, screenY, text) {
  const el = $('#shipNote');
  if (!el) return;
  el.textContent = text;
  el.style.left = screenX + 'px';
  el.style.top = screenY + 'px';
  el.classList.add('show');
}
function hideShipNote() {
  clearTimeout(shipNoteTimer);
  $('#shipNote')?.classList.remove('show');
}

function sendAction(action) {
  socket.emit('action', action, res => {
    if (!res.ok) errToast(res.error);
    else {
      if (action.type === 'move') localStorage.setItem('sb_moved', '1'); // сходил — демо больше не нужно
      basket = {};
      deselect();
      $('#shopOverlay').classList.add('hidden');
      // на телефоне после хода сворачиваем меню — карта снова на весь экран.
      // В многоходовом режиме НЕ сворачиваем: ход продолжается, игрок водит следующие суда.
      if (!multiMoveOn() && window.matchMedia('(max-width: 900px)').matches && !$('#panel').classList.contains('collapsed')) {
        $('#panelToggle').click();
      }
    }
  });
}

function deselect() {
  selectedShipId = null;
  mode = 'idle';
  aim = null;
  hoverPt = null;
  moveDemo = null;
  hideShipNote();
  $('#shipActions').classList.add('hidden');
  if (state) render();
}

// нотиф об ошибке. На сенсоре снимаем выделение, чтобы панель экшенов (она сверху на
// мобиле) ушла и красный нотиф показался на её месте, а не поверх неё.
function errToast(msg) {
  if (IS_COARSE && selectedShipId) deselect();
  else if (state) render();
  toast(msg);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============ ОТРИСОВКА ============
let view = { scale: 1, ox: 0, oy: 0 };
// камера: пользовательский зум (пинч/колесо) и панорама (драг)
const cam = { z: 1, px: 0, py: 0 };
let centeredOnce = false;   // при первом входе в активную игру центрируем камеру на своей базе

// на мобиле снизу — свёрнутая панель; карта должна жить НАД ней, а не под.
function desiredMapBottom() {
  if (!window.matchMedia('(max-width: 900px)').matches) return '';
  const panel = $('#panel');
  // когда панель свёрнута — резервируем её высоту; раскрытая панель временно
  // перекрывает карту (это осознанное действие игрока), оставляем прежнее
  if (panel.classList.contains('collapsed')) return panel.offsetHeight + 'px';
  return $('#mapWrap').style.bottom || '';
}

function resize() {
  const wrap = $('#mapWrap');
  wrap.style.bottom = desiredMapBottom();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  clampCam(); // поворот экрана/смена размеров не должны «терять» карту
  if (state) render();
}
window.addEventListener('resize', resize);

// «cover»: поле всегда заполняет экран целиком, за края заглянуть нельзя.
// По короткой стороне — впритык, по длинной — скролл в пределах поля.
function coverFit() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  return Math.max(w / state.map.w, h / state.map.h);
}

function clampCam() {
  cam.z = Math.min(5, Math.max(1, cam.z));
  if (!state?.map) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const s = coverFit() * cam.z;
  // поле всегда покрывает вьюпорт; панорама — в пределах перекрытия, без зазоров
  const maxX = Math.max(0, (state.map.w * s - w) / 2);
  const maxY = Math.max(0, (state.map.h * s - h) / 2);
  cam.px = Math.min(maxX, Math.max(-maxX, cam.px));
  cam.py = Math.min(maxY, Math.max(-maxY, cam.py));
}

function computeView() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  view.scale = coverFit() * cam.z;
  view.ox = (w - state.map.w * view.scale) / 2 + cam.px;
  view.oy = (h - state.map.h * view.scale) / 2 + cam.py;
}

// Центрируем камеру на базе игрока (своей; в хотсите — чей сейчас ход). Чтобы при входе в игру
// сразу видеть свой флот, а не пустой центр карты — особенно заметно на узких мобильных экранах.
function centerOnMyBase() {
  if (!state?.map?.bases) return;
  let idx = myIdx();
  if (idx < 0) idx = hotseatOwner ? (state.turn?.idx ?? 0) : -1; // зритель — не центрируем
  const b = idx >= 0 ? state.map.bases[idx] : null;
  if (!b) return;
  const s = coverFit() * cam.z;
  cam.px = s * (state.map.w / 2 - b.x);   // сдвиг панорамы, чтобы база оказалась в центре вьюпорта
  cam.py = s * (state.map.h / 2 - b.y);
  clampCam();                              // не вылезаем за край поля
}

// зум к точке экрана (курсор/центр пинча остаётся на месте)
function zoomAt(cx, cy, factor) {
  if (!state?.map) return;
  const before = toMap(cx, cy);
  cam.z *= factor;
  clampCam();
  computeView();
  cam.px += cx - sx(before.x);
  cam.py += cy - sy(before.y);
  clampCam();
  render();
}
const sx = x => x * view.scale + view.ox;
const sy = y => y * view.scale + view.oy;
const toMap = (px, py) => ({ x: (px - view.ox) / view.scale, y: (py - view.oy) / view.scale });

function drawPolygon(cx, cy, shape, fill, stroke) {
  ctx.beginPath();
  shape.forEach(([dx, dy], i) => {
    const x = sx(cx + dx), y = sy(cy + dy);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.stroke();
}

function dashedCircle(cx, cy, r, color, width = 1.5) {
  ctx.beginPath();
  ctx.setLineDash([7, 6]);
  ctx.arc(sx(cx), sy(cy), r * view.scale, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
  ctx.setLineDash([]);
}

function hpBar(px, py, w, frac, color) {
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.fillRect(px - w / 2, py, w, 5);
  ctx.fillStyle = frac > 0.4 ? color : '#c0392b';
  ctx.fillRect(px - w / 2, py, w * Math.max(0, frac), 5);
  ctx.strokeStyle = '#2b3a55';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(px - w / 2, py, w, 5);
}
// жёлтая шкала запаса ремонта — как HP-полоска, только жёлтая (заполнение = остаток зарядов / макс)
function chargeBar(px, py, w, n, max) {
  const frac = Math.max(0, Math.min(1, n / max));
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.fillRect(px - w / 2, py, w, 5);
  ctx.fillStyle = '#f4c20a';
  ctx.fillRect(px - w / 2, py, w * frac, 5);
  ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = 0.8;
  ctx.strokeRect(px - w / 2, py, w, 5);
}

// Отрисовка базы (вынесено, чтобы рисовать врагов и в норме, и сквозь туман).
// hpFrac=null → шкала HP не показывается (база ещё не разведана); dim → тускло (под туманом).
// Палитры порта-форта (камень — живой; серый — выбывший)
const FORT_STONE = { wall: '#d8c89e', court: '#f1e9cf', keep: '#ece0bb', edge: '#8a7a45' };
const FORT_DEAD = { wall: '#cbc7b8', court: '#e4e0d4', keep: '#dcd8cc', edge: '#9a937f' };

// Бастионный ПЯТИУГОЛЬНИК (экранные точки): 5 угловых бастионов-наконечников + прямые куртины между ними.
function fortShape(X, Y, R, { rot = -Math.PI / 2, depth = 0.18, flank = 0.3, N = 5 } = {}) {
  const step = Math.PI * 2 / N;
  const V = k => [X + Math.cos(rot + k * step) * R, Y + Math.sin(rot + k * step) * R];
  const lerp = (a, b, t) => ({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t });
  const pts = [];
  for (let k = 0; k < N; k++) {
    const vk = V(k), vp = V((k - 1 + N) % N), vn = V((k + 1) % N), a = rot + k * step;
    pts.push(lerp(vk, vp, flank));                                                       // плечо к пред. углу
    pts.push({ x: X + Math.cos(a) * R * (1 + depth), y: Y + Math.sin(a) * R * (1 + depth) }); // остриё бастиона
    pts.push(lerp(vk, vn, flank));                                                       // плечо к след. углу → прямая куртина
  }
  return pts;
}
function regPentPts(X, Y, R, rot = -Math.PI / 2, N = 5) {
  const step = Math.PI * 2 / N, pts = [];
  for (let k = 0; k < N; k++) pts.push({ x: X + Math.cos(rot + k * step) * R, y: Y + Math.sin(rot + k * step) * R });
  return pts;
}
function tracePoly(pts) { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); }

// Порт-форт «с цитаделью»: внешний бастионный вал + плац + домики + внутренняя цитадель + пушки + флаг игрока.
function drawFort(X, Y, R, accent, pal, withFlag) {
  const lw = Math.max(0.9, R * 0.034), inkw = Math.max(0.7, R * 0.018);
  const outer = fortShape(X, Y, R, { depth: 0.18, flank: 0.3 });
  ctx.save(); ctx.translate(R * 0.04, R * 0.08); tracePoly(outer); ctx.fillStyle = 'rgba(43,58,85,.16)'; ctx.fill(); ctx.restore(); // тень
  tracePoly(outer); ctx.fillStyle = pal.wall; ctx.fill();
  tracePoly(outer); ctx.strokeStyle = pal.edge; ctx.lineWidth = lw; ctx.lineJoin = 'round'; ctx.stroke();
  tracePoly(outer); ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = inkw; ctx.stroke();
  const court = regPentPts(X, Y, R * 0.66);                                     // плац
  tracePoly(court); ctx.fillStyle = pal.court; ctx.fill();
  tracePoly(court); ctx.strokeStyle = pal.edge; ctx.lineWidth = inkw; ctx.stroke();
  ctx.fillStyle = pal.edge;                                                     // домики во дворе
  for (const [dx, dy] of [[-0.4, 0.12], [0.4, 0.12], [-0.26, 0.4], [0.26, 0.4]])
    ctx.fillRect(X + dx * R - R * 0.07, Y + dy * R - R * 0.05, R * 0.14, R * 0.1);
  const cit = fortShape(X, Y, R * 0.34, { depth: 0.22, flank: 0.28 });          // внутренняя цитадель
  tracePoly(cit); ctx.fillStyle = pal.keep; ctx.fill();
  tracePoly(cit); ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = inkw; ctx.stroke();
  ctx.fillStyle = '#2b3a55';                                                    // пушки на остриях бастионов
  for (let k = 0; k < 5; k++) {
    const a = -Math.PI / 2 + k * (Math.PI * 2 / 5), r = R * 1.18 * 0.9;
    ctx.beginPath(); ctx.arc(X + Math.cos(a) * r, Y + Math.sin(a) * r, Math.max(1.4, R * 0.028), 0, Math.PI * 2); ctx.fill();
  }
  if (withFlag) {                                                               // флаг цвета игрока над цитаделью
    const fh = R * 0.42;
    ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = Math.max(1.4, R * 0.03); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(X, Y + R * 0.04); ctx.lineTo(X, Y - fh); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X, Y - fh); ctx.lineTo(X + R * 0.26, Y - fh + R * 0.09); ctx.lineTo(X, Y - fh + R * 0.18); ctx.closePath();
    ctx.fillStyle = accent; ctx.fill(); ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = Math.max(0.6, R * 0.012); ctx.stroke();
    ctx.lineCap = 'butt';
  }
}

function drawBase(b, i, { alive, hpFrac, dim }) {
  if (b.noPort) return; // дуэль: баз и фортов нет — b лишь невидимый якорь спавна флота
  const p = state.players[i];
  ctx.globalAlpha = dim ? 0.4 : 1;
  // ОСТРОВ-основание (бледнее камня форта, чтобы форт читался поверх) — форт ПОМЕНЬШЕ, остров виден по краям
  drawPolygon(b.x, b.y, b.shape, alive ? '#eee6cd' : '#e0dbcb', '#9a8a55');
  // форт МЕНЬШЕ острова: остриё бастиона = R*1.18 ≈ 0.64·b.radius, а остров в самом узком месте ~0.69·b.radius → не вылезает
  drawFort(sx(b.x), sy(b.y), b.radius * view.scale * 0.54, p.color, alive ? FORT_STONE : FORT_DEAD, alive);
  ctx.font = `bold ${Math.max(12, 15 * view.scale)}px Neucha, cursive`;
  ctx.fillStyle = '#2b3a55'; ctx.textAlign = 'center';
  ctx.fillText(p.nick, sx(b.x), sy(b.y + b.radius) + 16);
  ctx.globalAlpha = 1;
  if (alive && hpFrac != null) hpBar(sx(b.x), sy(b.y + b.radius) + 22, 56, hpFrac, '#27ae60');
  else if (!alive) { ctx.font = `${20 * view.scale + 8}px serif`; ctx.fillText('💀', sx(b.x), sy(b.y) + 6); }
}

// ===== Туман войны — чисто клиентский визуал (см. config.fog) =====
let fogGameId = null, fogLayer = null, fogLayerCtx = null;
const fogCells = new Set();   // исследованные клетки карты (показ островов/зон)
const fogLastSeen = {};       // i → {portHp, alive} на момент последней видимости базы врага
let fogFade = [];             // затухающая видимость от потопленных МОИХ кораблей {x,y,r,born,hold,fade}
let fogRevealed = false;      // туман снят по команде сервера (клиентский визуал тестового режима)
let tutReveal = null;         // туториал: ОДИН локальный кружок видимости вокруг показываемой цели — НЕ разведывает карту
const FOG_CELL = 48, FOG_SHIP_MULT = 1.3, FOG_BASE_EXTRA = 200;

function fogActive() {
  // 🐞 отладка перебивает настройку партии в обе стороны: 'off' — снять, 'on' — надеть туман
  // даже там, где партия создавалась без него (иначе кнопку нельзя было использовать вовсе).
  if (debugFog === 'off') return false;
  if (debugFog === 'on') return state?.status === 'active' && state.players[myIdx()]?.alive;
  if (fogRevealed) return false; // туман снят командой
  return !!(state?.config?.fog) && !state.config.hotseat
    && state.status === 'active' && state.players[myIdx()]?.alive;
}
function fogResetMem() {
  fogCells.clear();
  for (const k in fogLastSeen) delete fogLastSeen[k];
  fogFade = [];
}
let visMemo = null, visMemoT = 0;
function visionCircles() {
  // мемо на кадр: зовётся из рендера, штурвала, огня баз — по 3-4 раза за кадр 60 раз/с;
  // без кэша это лишние массивы каждый вызов (GC-дрожь). 8мс — внутри одного кадра.
  const nowT = performance.now();
  if (visMemo && nowT - visMemoT < 8) return visMemo;
  const me = myIdx(), circles = [], m = state.map;
  const base = m.bases[me];
  if (base) circles.push({ x: base.x, y: base.y, r: base.radius + FOG_BASE_EXTRA });
  // затухающая видимость от только что потопленных МОИХ кораблей — туман закрывается плавно после анимации
  const now = performance.now();
  for (const f of fogFade) {
    const t = now - f.born;
    if (t <= f.hold) circles.push({ x: f.x, y: f.y, r: f.r });
    else if (t < f.hold + f.fade) { const k = 1 - (t - f.hold) / f.fade; circles.push({ x: f.x, y: f.y, r: f.r * k * k }); }
  }
  for (const s of state.ships) if (s.owner === me) {
    const st = ST(s.type);
    const pos = animPos.get(s.id) || (state.rt && rtPos.get(s.id)) || s; // «плавание»/шторм — туман плавно едет за лодкой
    circles.push({ x: pos.x, y: pos.y, r: Math.max(st.move, st.fireRange) * FOG_SHIP_MULT });
  }
  // ⛺ дозор моих аванпостов: снимают туман вокруг своего острова
  for (const isl of state.map.lootIslands || []) {
    if (isl.outpost?.owner === me) circles.push({ x: isl.x, y: isl.y, r: state.outposts?.radius || 240 });
  }
  visMemo = circles; visMemoT = nowT;
  return circles;
}
const fogVisible = (x, y, circles) => circles.some(c => Math.hypot(x - c.x, y - c.y) <= c.r);
const fogExploredAt = (x, y) => fogCells.has(((x / FOG_CELL) | 0) + ',' + ((y / FOG_CELL) | 0));

let fogUpdT = 0;
function fogUpdate(circles) {
  if (fogGameId !== state.id) { fogGameId = state.id; fogResetMem(); } // новая игра — забыть разведанное
  // память разведки — не чаще ~7 раз/с: клеточный проход по кругам обзора со строковыми ключами
  // на каждом кадре давал тысячи временных строк в секунду (GC-дрожь), а корабли за 150мс
  // проходят пару пикселей — разведка не отстаёт.
  const nowT = performance.now();
  if (nowT - fogUpdT < 150) return;
  fogUpdT = nowT;
  for (const c of circles) {                     // отметить клетки разведанными (острова/зоны остаются видны)
    for (let gx = c.x - c.r; gx <= c.x + c.r; gx += FOG_CELL)
      for (let gy = c.y - c.r; gy <= c.y + c.r; gy += FOG_CELL)
        if (Math.hypot(gx - c.x, gy - c.y) <= c.r)
          fogCells.add(((gx / FOG_CELL) | 0) + ',' + ((gy / FOG_CELL) | 0));
  }
  state.map.bases.forEach((b, i) => {            // запомнить HP/статус видимых баз врага
    if (i === myIdx()) return;
    if (fogVisible(b.x, b.y, circles)) {
      const p = state.players[i]; if (p) fogLastSeen[i] = { portHp: p.portHp, alive: p.alive };
    }
  });
}

function drawFogOverlay(circles) {
  if (!canvas.width || !canvas.height) return; // вкладка в фоне: канвас 0×0 — drawImage упадёт
  const cw = canvas.clientWidth, ch = canvas.clientHeight, m = state.map;
  const dpr = window.devicePixelRatio || 1;
  if (!fogLayer || fogLayer.width !== canvas.width || fogLayer.height !== canvas.height) {
    fogLayer = document.createElement('canvas');
    fogLayer.width = canvas.width; fogLayer.height = canvas.height;
    fogLayerCtx = fogLayer.getContext('2d');
  }
  const f = fogLayerCtx;
  f.setTransform(dpr, 0, 0, dpr, 0, 0);
  f.clearRect(0, 0, cw, ch);
  f.fillStyle = 'rgba(150,160,178,0.46)';                       // единый ЛЁГКИЙ туман по всей карте
  f.fillRect(sx(0), sy(0), m.w * view.scale, m.h * view.scale);
  f.globalCompositeOperation = 'destination-out';
  for (const c of circles) {                                    // текущая видимость — чисто, с мягким краем
    const cx = sx(c.x), cy = sy(c.y), cr = c.r * view.scale;
    const g = f.createRadialGradient(cx, cy, cr * 0.6, cx, cy, cr);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    f.fillStyle = g; f.beginPath(); f.arc(cx, cy, cr, 0, Math.PI * 2); f.fill();
  }
  f.globalCompositeOperation = 'source-over';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);                           // композитим 1:1 в device-пикселях
  ctx.drawImage(fogLayer, 0, 0);
  ctx.restore();
}

// ===== Горящая база: дым/огонь при низком HP (визуал; под туманом — только если база видна) =====
const baseFx = new Map();   // i → {smoke, fire, embers, sAcc, fAcc, eAcc}
let fireGameId = null;
// очаги (в мировых координатах относительно центра базы) — НИЖЕ флага, чтобы не перекрывать его цвет
const FIRE_EMIT = [{ dx: 0, dy: 14 }, { dx: -22, dy: 20 }, { dx: 20, dy: 22 }];
const rndf = (a, b) => a + Math.random() * (b - a);

function fireTier(frac) { if (frac >= 0.8) return 0; if (frac >= 0.7) return 1; if (frac >= 0.6) return 2; return 3; }

// Базы, которые сейчас должны гореть: живые, видимые (под туманом — своя или в зоне видимости), HP < 80%.
let burnMemo = null, burnMemoT = 0;
function burningBases() {
  if (!state?.map || state.status !== 'active') return [];
  const nowT = performance.now();               // мемо на кадр: anyBurning/updateBaseFires/drawBaseFires зовут по 3 раза
  if (burnMemo && nowT - burnMemoT < 8) return burnMemo;
  const fog = fogActive(), vis = fog ? visionCircles() : null, res = [];
  state.map.bases.forEach((b, i) => {
    const p = state.players[i]; if (!p || !p.alive) return;
    if (fog && i !== myIdx() && !fogVisible(b.x, b.y, vis)) return; // не разведано — огня не видно
    const frac = (p.portHp || 0) / (state.portMax || 840);
    const tier = fireTier(frac); if (!tier) return;
    res.push({ i, b, tier, sev: Math.max(0, Math.min(1, (0.6 - frac) / 0.6)) });
  });
  burnMemo = res; burnMemoT = nowT;
  return res;
}
function anyBurning() {
  if (burningBases().length) return true;
  for (const fx of baseFx.values()) if (fx.smoke.length || fx.fire.length || fx.embers.length) return true;
  return false;
}

function spawnBaseFx(fx, b, tier, sev, dt) {
  const em = FIRE_EMIT.map(e => ({ x: b.x + e.dx, y: b.y + e.dy }));
  // ДЫМ
  let rate, srcs;
  if (tier === 1) { rate = 7; srcs = [em[0]]; }            // лёгкий — одна струйка
  else if (tier === 2) { rate = 15; srcs = em; }            // 3 очага
  else { rate = 22 + sev * 16; srcs = em; }                 // густой над огнём
  fx.sAcc += rate * dt;
  while (fx.sAcc >= 1) {
    fx.sAcc -= 1;
    const e = srcs[(Math.random() * srcs.length) | 0], life = rndf(1.6, 2.8);
    fx.smoke.push({ x: e.x + rndf(-5, 5), y: e.y + rndf(-3, 3), vx: rndf(-6, 6), vy: rndf(-22, -36),
      r0: rndf(5, 9), grow: rndf(12, 20), life, max: life, sway: rndf(0, 6.28), swaySpd: rndf(1, 2.2),
      dark: tier === 3 ? rndf(0.35, 0.55) : rndf(0.18, 0.3) });
  }
  if (tier < 3) return;
  // ОГОНЬ + угли — только тир 3, скромный подъём (флаг выше — остаётся виден)
  fx.fAcc += (32 + sev * 44) * dt;
  while (fx.fAcc >= 1) {
    fx.fAcc -= 1;
    const e = em[(Math.random() * em.length) | 0], life = rndf(0.32, 0.58);
    fx.fire.push({ x: e.x + rndf(-8, 8), y: e.y + rndf(-2, 4), vx: rndf(-9, 9), vy: rndf(-42, -68),
      r0: rndf(6, 12) * (0.8 + sev * 0.5), life, max: life, sway: rndf(0, 6.28) });
  }
  fx.eAcc += (9 + sev * 20) * dt;
  while (fx.eAcc >= 1) {
    fx.eAcc -= 1;
    const e = em[(Math.random() * em.length) | 0], life = rndf(0.6, 1.15);
    fx.embers.push({ x: e.x + rndf(-9, 9), y: e.y, vx: rndf(-12, 12), vy: rndf(-58, -100),
      r: rndf(1, 2.1), life, max: life, sway: rndf(0, 6.28) });
  }
}
function stepParts(arr, dt) {
  const now = performance.now() / 1000;
  for (const p of arr) {
    p.life -= dt;
    p.x += (p.vx + Math.sin(p.sway + now * (p.swaySpd || 3)) * 7) * dt;
    p.y += p.vy * dt;
    p.vy *= (1 - 0.6 * dt);
  }
  return arr.filter(p => p.life > 0);
}
function updateBaseFires(dt) {
  if (fireGameId !== state?.id) { fireGameId = state?.id; baseFx.clear(); }
  if (!state?.map) return;
  const burning = burningBases(), burnSet = new Set(burning.map(x => x.i));
  for (const { i, b, tier, sev } of burning) {
    let fx = baseFx.get(i);
    if (!fx) { fx = { smoke: [], fire: [], embers: [], sAcc: 0, fAcc: 0, eAcc: 0 }; baseFx.set(i, fx); }
    spawnBaseFx(fx, b, tier, sev, dt);
  }
  for (const [i, fx] of baseFx) {
    fx.smoke = stepParts(fx.smoke, dt); fx.fire = stepParts(fx.fire, dt); fx.embers = stepParts(fx.embers, dt);
    if (!burnSet.has(i) && !fx.smoke.length && !fx.fire.length && !fx.embers.length) baseFx.delete(i);
  }
}
function drawBaseFires() {
  if (!baseFx.size) return;
  const k = view.scale;
  const glow = new Map(burningBases().filter(x => x.tier === 3).map(x => [x.i, x.sev]));
  for (const [i, fx] of baseFx) {
    const b = state.map.bases[i]; if (!b) continue;
    // свечение под огнём
    const sev = glow.get(i);
    if (sev != null) {
      const flick = 0.85 + Math.sin(performance.now() / 90) * 0.1 + Math.random() * 0.05;
      const r = (52 + sev * 38) * flick * k, cx = sx(b.x), cy = sy(b.y + 16);
      const g = ctx.createRadialGradient(cx, cy, 4, cx, cy, r);
      g.addColorStop(0, `rgba(255,150,40,${0.3 * Math.max(0.3, sev)})`); g.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.29); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
    // дым
    for (const p of fx.smoke) {
      const kk = p.life / p.max, age = 1 - kk, r = (p.r0 + p.grow * age) * k;
      const a = Math.min(1, kk * 1.4) * 0.5, sh = Math.round(70 + age * 70);
      const g = ctx.createRadialGradient(sx(p.x), sy(p.y), 0, sx(p.x), sy(p.y), r);
      g.addColorStop(0, `rgba(${sh},${sh},${sh + 6},${a * p.dark * 2})`); g.addColorStop(1, `rgba(${sh},${sh},${sh + 6},0)`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), r, 0, 6.29); ctx.fill();
    }
    // огонь + угли
    ctx.globalCompositeOperation = 'lighter';
    for (const p of fx.fire) {
      const kk = p.life / p.max, age = 1 - kk, r = Math.max(0.5, p.r0 * (1 - age * 0.7) * k);
      const g = ctx.createRadialGradient(sx(p.x), sy(p.y), 0, sx(p.x), sy(p.y), r);
      g.addColorStop(0, `rgba(255,245,200,${0.9 * kk})`); g.addColorStop(0.4, `rgba(255,170,40,${0.8 * kk})`);
      g.addColorStop(1, 'rgba(200,40,20,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), r, 0, 6.29); ctx.fill();
    }
    for (const p of fx.embers) {
      const kk = p.life / p.max;
      ctx.fillStyle = `rgba(255,${180 + (Math.random() * 60 | 0)},80,${kk})`;
      ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), p.r * k, 0, 6.29); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

function render(canvasOnly) {
  if (!state) return;
  // DOM (сайдбар/магазин/оверлеи) перерисовываем ТОЛЬКО на смену состояния и по UI-событиям —
  // НЕ на каждом кадре анимации. Иначе пока крутится аним-цикл (горящие базы/эффекты), renderShop
  // переписывал #shopList.innerHTML 60 раз/сек → кнопки магазина пересоздавались и не кликались
  // (ни клика, ни :hover). Кадровый путь (animTick) зовёт render(true) — только канвас.
  if (!canvasOnly) {
    renderSidebar();
    renderOverlays();
  }
  if (!state.map) { // лобби — карты ещё нет
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    return;
  }
  computeView();
  const m = state.map;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  ctx.clearRect(0, 0, cw, ch);

  // туман войны: круги видимости (база + мои корабли) и обновление разведанного
  const fog = fogActive();
  let vis = fog ? visionCircles() : [];
  if (fog) fogUpdate(vis);                     // разведанное копится ТОЛЬКО от настоящего обзора
  if (fog && tutReveal) vis = [...vis, tutReveal]; // туториал: локально открыть зону у цели — КОПИЕЙ (visionCircles мемоизирован, кэш не трогаем)

  // лист: фон и клетка до краёв экрана — сетка продолжается за границами карты
  ctx.fillStyle = '#fdfbf3';
  ctx.fillRect(0, 0, cw, ch);
  ctx.strokeStyle = 'rgba(116,160,199,.35)';
  ctx.lineWidth = 1;
  const gridX0 = Math.floor(toMap(0, 0).x / 40) * 40;
  const gridX1 = Math.ceil(toMap(cw, ch).x / 40) * 40;
  const gridY0 = Math.floor(toMap(0, 0).y / 40) * 40;
  const gridY1 = Math.ceil(toMap(cw, ch).y / 40) * 40;
  ctx.beginPath(); // вся клетка ОДНИМ путём и одним stroke — не десятки отдельных
  for (let x = gridX0; x <= gridX1; x += 40) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), ch); }
  for (let y = gridY0; y <= gridY1; y += 40) { ctx.moveTo(0, sy(y)); ctx.lineTo(cw, sy(y)); }
  ctx.stroke();
  // (граница игрового поля убрана — сетка просто продолжается за краями карты)

  // рыбные места
  for (const z of m.fishZones) {
    if (fog && !fogExploredAt(z.x, z.y) && !fogVisible(z.x, z.y, vis)) continue; // под туманом — пока не разведано (или подсвечено туториалом)
    const cap = z.cap || 4; // лимит судов зависит от размера зоны (см. fishZoneCap на сервере)
    ctx.beginPath();
    ctx.arc(sx(z.x), sy(z.y), z.radius * view.scale, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,170,210,.16)';
    ctx.fill();
    dashedCircle(z.x, z.y, z.radius, 'rgba(80,130,180,.6)');
    ctx.font = `${Math.max(14, 22 * view.scale)}px serif`;
    ctx.textAlign = 'center';
    ctx.fillText('🐟', sx(z.x), sy(z.y) + 6);
    // счётчик занятых рыбацких мест — мелким шрифтом, тем же синим, что и зона
    const taken = state.ships.filter(s => ST(s.type).fishing > 0 &&
      Math.hypot(s.x - z.x, s.y - z.y) <= z.radius).length;
    ctx.font = `${Math.max(10, 12 * view.scale)}px Neucha, cursive`;
    ctx.fillStyle = 'rgba(80,130,180,.85)';
    ctx.fillText(`${Math.min(taken, cap)}/${cap}`, sx(z.x), sy(z.y) + 20);
  }

  // лут-острова (⛺ с аванпостом — постройка, флаг владельца, радиус перков, HP если побит)
  for (const isl of m.lootIslands) {
    if (fog && !fogExploredAt(isl.x, isl.y) && !fogVisible(isl.x, isl.y, vis)) continue; // под туманом — пока не разведано (или подсвечено туториалом)
    const op = isl.outpost;
    ctx.globalAlpha = isl.looted && !op ? 0.45 : 1;
    drawPolygon(isl.x, isl.y, isl.shape, '#e8d9a8', '#8a7a45');
    ctx.font = `${Math.max(12, 18 * view.scale)}px serif`;
    ctx.textAlign = 'center';
    if (op) {
      const def = (state.outposts?.levels || [])[op.level - 1] || { icon: '⛺', hp: 120 };
      const col = state.players[op.owner]?.color || '#666';
      if (op.owner === myIdx()) // радиус перков — только своих (чужие не палим детально)
        dashedCircle(isl.x, isl.y, state.outposts?.radius || 240, col + '66', 1.2);
      ctx.fillText(def.icon, sx(isl.x), sy(isl.y) + 5);
      // флажок владельца над постройкой
      const fx0 = sx(isl.x) + 10 * view.scale, fy0 = sy(isl.y) - 16 * view.scale;
      ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(fx0, fy0); ctx.lineTo(fx0, fy0 - 12 * view.scale); ctx.stroke();
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(fx0, fy0 - 12 * view.scale);
      ctx.lineTo(fx0 + 10 * view.scale, fy0 - 9 * view.scale);
      ctx.lineTo(fx0, fy0 - 6 * view.scale);
      ctx.closePath(); ctx.fill();
      if (op.hp < def.hp) { // постройка под обстрелом — полоска прочности
        const w = 34 * view.scale, x0 = sx(isl.x) - w / 2, y0 = sy(isl.y - isl.radius) - 10;
        ctx.fillStyle = 'rgba(43,58,85,.25)'; ctx.fillRect(x0, y0, w, 4);
        ctx.fillStyle = '#c0392b'; ctx.fillRect(x0, y0, w * Math.max(0, op.hp / def.hp), 4);
      }
    } else {
      ctx.fillText(isl.looted ? '✖' : '💰', sx(isl.x), sy(isl.y) + 5);
    }
    if (!isl.looted) {
      ctx.font = `bold ${Math.max(11, 14 * view.scale)}px Neucha, cursive`;
      ctx.fillStyle = '#2b3a55';
      ctx.fillText(isl.loot, sx(isl.x), sy(isl.y + isl.radius) + 14);
    }
    ctx.globalAlpha = 1;
  }

  // базы (под туманом вражеские рисуем ПОСЛЕ оверлея — см. ниже)
  const portMax = state.portMax || 840;
  m.bases.forEach((b, i) => {
    const p = state.players[i];
    if (!p) return;
    if (fog && i !== myIdx()) return; // враги — сквозь туман, отдельным проходом
    drawBase(b, i, { alive: p.alive, hpFrac: p.portHp / portMax, dim: false });
  });

  // подсветки выбранного корабля
  const sel = selectedShipId && state.ships.find(s => s.id === selectedShipId);
  if (sel) {
    const st = ST(sel.type);
    // ⚡ реалтайм: лимита дистанции нет — контур хода не рисуем (корабль доплывёт сам);
    // пошагово: 🌬 КАПЛЕВИДНЫЙ контур дальности — вытянут по ветру, поджат против
    if ((mode === 'move' || mode === 'idle') && !state.rt) drawMoveContour(sel, st.move);
    if (st.repairer) {
      // ремонтник: жёлтый радиус ремонта (чуть меньше хода), в режиме «Чинить» и при выборе
      if (mode === 'repair' || mode === 'idle') dashedCircle(sel.x, sel.y, st.fireRange, 'rgba(244,194,10,.85)', 1.6);
    } else if (mode === 'broadside' && canBroadside(sel)) {
      drawBroadsideSectors(sel);                 // 💥 сектора-трапеции бортов (наводимый — красный)
    } else if ((mode === 'attack' || mode === 'idle') && (canBroadside(sel) || canMortar(sel))) {
      // радиус мортиры/подсказка — только у тех, кто вообще умеет стрелять (баркас — нет)
      dashedCircle(sel.x, sel.y, st.fireRange, 'rgba(192,57,43,.75)', 1.6);
    }
  }

  // пенные следы — под кораблями
  drawEffects(true);

  // ⛈️ шторм: пунктирный курс СВОИХ кораблей к точке назначения (у врагов приказы не показываем)
  if (state.rt) for (const s of state.ships) {
    if (s.owner !== myIdx() || !s.dest) continue;
    const p = rtPos.get(s.id) || s;
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(43,58,85,.45)';
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(sx(p.x), sy(p.y)); ctx.lineTo(sx(s.dest.x), sy(s.dest.y)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(sx(s.dest.x), sy(s.dest.y), 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(43,58,85,.55)'; ctx.fill();
  }

  // корабли (под туманом чужие/пиратов видно только в зоне видимости)
  for (const s of state.ships) {
    if (fog && s.owner !== myIdx() && !fogVisible(s.x, s.y, vis)) continue;
    // уже сходивший в этом ходу свой корабль — тусклый, с якорьком (режим «ход тремя судами»)
    const acted = s.owner === myIdx() && isMyTurn() && shipActed(s.id);
    if (acted) ctx.globalAlpha = 0.42;
    drawShip(s, s.id === selectedShipId);
    if (acted) {
      ctx.globalAlpha = 0.95;
      ctx.font = `${Math.max(11, 14 * view.scale)}px serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#2b3a55';
      ctx.fillText('⚓', sx(s.x), sy(s.y) - ((SHIP_LEN[s.type] || 46) * 0.5 + 14) * view.scale);
      ctx.globalAlpha = 1;
    }
  }
  // тонущие: уже исчезли из состояния, но ядро ещё летит
  const nowGhost = performance.now();
  for (const e of effects) {
    if (e.kind === 'ghost' && nowGhost >= e.start && nowGhost < e.start + e.dur) {
      if (fog && e.ship.owner !== myIdx() && !fogVisible(e.x, e.y, vis)) continue;
      drawShip({ id: e.shipId, owner: e.ship.owner, type: e.ship.type, x: e.x, y: e.y, hp: 1, bounty: e.ship.bounty, boss: e.ship.boss }, false);
    }
  }

  // 🐞 ГЛАЗАМИ БОТА: что он видит и о чём думает — рисуем ДО тумана, чтобы не затянуло дымкой
  if (DEBUG_ON && debugEyes && botEyes) drawBotEyes();

  // ТУМАН: затягиваем карту и проявляем вражеские базы сквозь дымку (тускло/последнее виденное)
  if (fog) {
    drawFogOverlay(vis);
    m.bases.forEach((b, i) => {
      if (i === myIdx()) return;
      const p = state.players[i]; if (!p) return;
      if (fogVisible(b.x, b.y, vis)) {                 // в зоне видимости — живые данные
        drawBase(b, i, { alive: p.alive, hpFrac: p.portHp / portMax, dim: false });
      } else {                                         // вне — тускло, статус/HP на момент последней разведки
        const seen = fogLastSeen[i];
        drawBase(b, i, { alive: seen ? seen.alive : true, hpFrac: seen ? seen.portHp / portMax : null, dim: true });
      }
    });
  }

  // 🕊 «Развитие», мирное время: пунктирная светло-серая граница вокруг ЧУЖИХ баз —
  // ближе подходить нельзя. Рисуем только пока идёт мир; как peace.active станет false — исчезнет сама.
  // ⚡ Реалтайм: запрет на подход там не действует (движение свободное) — пунктир не рисуем, чтоб не врал.
  if (state.peace?.active && state.peace.keepout > 0 && !state.rt) {
    for (let i = 0; i < m.bases.length; i++) {
      if (i === myIdx() || !state.players[i]?.alive) continue;
      dashedCircle(m.bases[i].x, m.bases[i].y, state.peace.keepout, 'rgba(158,162,168,.6)', 1.4);
    }
  }

  // дым/огонь горящих баз — поверх островов и тумана
  drawBaseFires();

  // цели в режиме атаки
  if (sel && mode === 'attack') {
    const st = ST(sel.type);
    for (const s of state.ships) {
      if (s.owner !== sel.owner && dist(sel.x, sel.y, s.x, s.y) <= st.fireRange)
        dashedCircle(s.x, s.y, 22, '#c0392b', 2);
    }
    m.bases.forEach((b, i) => {
      const p = state.players[i];
      if (p && p.alive && i !== sel.owner && dist(sel.x, sel.y, b.x, b.y) <= st.fireRange + b.radius * 0.5)
        dashedCircle(b.x, b.y, b.radius + 10, '#c0392b', 2);
    });
    for (const isl of m.lootIslands || []) { // ⛺ чужие аванпосты в радиусе мортиры — тоже цели
      if (isl.outpost && isl.outpost.owner !== sel.owner && dist(sel.x, sel.y, isl.x, isl.y) <= st.fireRange + isl.radius * 0.5)
        dashedCircle(isl.x, isl.y, isl.radius + 8, '#c0392b', 2);
    }
  }

  // цели бортового залпа — вражеские суда в наводимом секторе (красные кольца)
  if (sel && mode === 'broadside') drawBroadsideTargets(sel);

  // цели в режиме ремонта — свои ПОДБИТЫЕ корабли в радиусе (жёлтым)
  if (sel && mode === 'repair') {
    const st = ST(sel.type);
    for (const s of state.ships) {
      if (s.id !== sel.id && s.owner === sel.owner && s.hp < (s.maxHp || ST(s.type).hp) &&
          dist(sel.x, sel.y, s.x, s.y) <= st.fireRange)
        dashedCircle(s.x, s.y, 22, '#f4c20a', 2);
    }
  }

  // «линейка» при перемещении
  if (sel && mode === 'move' && hoverPt) {
    const st = ST(sel.type);
    const d = dist(sel.x, sel.y, hoverPt.x, hoverPt.y);
    // ⚡ реалтайм: дистанция не ограничена; пошагово — 🌬 дальность по курсу (капля ветра)
    const ok = state.rt ? true : d <= st.move * windK(Math.atan2(hoverPt.y - sel.y, hoverPt.x - sel.x));
    ctx.beginPath();
    ctx.setLineDash([4, 5]);
    ctx.moveTo(sx(sel.x), sy(sel.y));
    ctx.lineTo(sx(hoverPt.x), sy(hoverPt.y));
    ctx.strokeStyle = ok ? '#6b6f76' : '#c0392b';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
    // призрак корабля — носом в сторону хода
    ctx.globalAlpha = 0.45;
    drawShip({
      ...sel, x: hoverPt.x, y: hoverPt.y,
      _headingOverride: Math.atan2(hoverPt.y - sel.y, hoverPt.x - sel.x)
    }, false);
    ctx.globalAlpha = 1;
    // подпись: расстояние в клетках, либо «отмена», если палец вернулся на корабль
    const mx = (sx(sel.x) + sx(hoverPt.x)) / 2, my = (sy(sel.y) + sy(hoverPt.y)) / 2;
    ctx.font = 'bold 14px Neucha, cursive';
    ctx.textAlign = 'center';
    if (aim && aim.cancel) {
      ctx.fillStyle = '#9aa0a8';
      ctx.fillText('↩ отмена', sx(sel.x), sy(sel.y) - 24);
    } else {
      ctx.fillStyle = ok ? '#2b3a55' : '#c0392b';
      ctx.fillText(`${(d / 40).toFixed(1)} кл.`, mx, my - 8);
    }

    // тач-прицел: крестик-цель + маркер пальца с тонкой линией (палец не закрывает цель).
    // ⚡ в реалтайме крестик ПОД пальцем — маркер пальца не нужен (совпал бы с крестиком)
    if (aim && aim.dest) {
      drawCrosshair(sx(hoverPt.x), sy(hoverPt.y), aim.cancel ? '#9aa0a8' : aim.clamped ? '#c0392b' : '#2b3a55');
      if (aim.finger && !state.rt) {
        ctx.beginPath();
        ctx.setLineDash([2, 4]);
        ctx.moveTo(sx(hoverPt.x), sy(hoverPt.y));
        ctx.lineTo(sx(aim.finger.x), sy(aim.finger.y));
        ctx.strokeStyle = 'rgba(43,58,85,.35)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(sx(aim.finger.x), sy(aim.finger.y), 13, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(46,204,113,.26)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(39,174,96,.8)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  // обучающая демо-анимация жеста (тач, до первого хода) — поверх сцены, когда не целимся
  if (moveDemo && sel && mode === 'idle' && !aim) drawMoveDemo(sel); // демо жеста — в покое у штурвала

  drawEffects();
  drawCommandWheel(); // 🎛 штурвал выбранного корабля — поверх всего
  if (state.wind && state.status === 'active') drawWindCompass(); // 🌬 компас ветра — во всех режимах
  updateMoveHint();
}

// 🧭 Контур дальности хода с учётом ветра: r(θ) = move·windK(θ) — «капля», вытянутая по ветру.
// При штиле (str=0) это прежний ровный круг — стиль и пунктир сохранены.
function drawMoveContour(sel, move) {
  ctx.beginPath();
  ctx.setLineDash([6, 6]);
  const N = 64;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = move * windK(a);
    const x = sx(sel.x + Math.cos(a) * r), y = sy(sel.y + Math.sin(a) * r);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = 'rgba(107,111,118,.8)';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.setLineDash([]);
}

// 🌬 Компас ветра (все режимы): кружок в правом-верхнем углу карты, стрелка = куда дует,
// длина стрелки = сила. По ветру плывёшь дальше/быстрее, против — меньше/медленнее.
function drawWindCompass() {
  const w = state.wind;
  const cx = canvas.clientWidth - 52, cy = 52, R = 26;
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#fdfbf3'; ctx.fill();
  ctx.lineWidth = 1.6; ctx.strokeStyle = '#2b3a55'; ctx.stroke();
  const len = 8 + 14 * (w.str ?? 0.5);
  const dx = Math.cos(w.ang), dy = Math.sin(w.ang);
  const hx = cx + dx * len, hy = cy + dy * len;
  ctx.beginPath();
  ctx.moveTo(cx - dx * len, cy - dy * len);
  ctx.lineTo(hx, hy);
  ctx.lineWidth = 2.4; ctx.strokeStyle = '#2980b9'; ctx.stroke();
  ctx.beginPath(); // наконечник
  ctx.moveTo(hx, hy); ctx.lineTo(hx - Math.cos(w.ang - 0.5) * 8, hy - Math.sin(w.ang - 0.5) * 8);
  ctx.moveTo(hx, hy); ctx.lineTo(hx - Math.cos(w.ang + 0.5) * 8, hy - Math.sin(w.ang + 0.5) * 8);
  ctx.stroke();
  ctx.font = '12px Neucha, cursive';
  ctx.fillStyle = '#2b3a55';
  ctx.textAlign = 'center';
  ctx.fillText('🌬 ветер', cx, cy + R + 14);
  ctx.restore();
}

// мелкая ненавязчивая подпись под панелью действий (тач, режимы «Плыть» / «Залп»)
function updateMoveHint() {
  const el = $('#moveHint');
  if (!el) return;
  // единый жест: ход = потяг от корабля (подсказываем в покое), залп = тап в сторону цели
  const showMove = IS_COARSE && mode === 'idle' && selectedShipId && !hasMovedOnce();
  const showBroad = IS_COARSE && mode === 'broadside' && selectedShipId;
  if (showBroad) el.textContent = 'тапни в сторону цели — залп с этого борта';
  else if (showMove) el.textContent = 'потяни от корабля, чтобы плыть';
  el.classList.toggle('hidden', !(showMove || showBroad));
}

// демо: «палец тянет корабль» — цикл, пока игрок не сходит хоть раз
function startMoveDemo() {
  if (moveDemo || !IS_COARSE || hasMovedOnce()) return;
  moveDemo = { t0: performance.now() };
  requestAnimationFrame(demoTick);
}
function stopMoveDemo() { if (moveDemo) { moveDemo = null; if (state) render(); } }
function demoTick() {
  if (!moveDemo) return;
  if (mode !== 'move' || !selectedShipId || aim) { moveDemo = null; render(); return; }
  render();
  requestAnimationFrame(demoTick);
}

function drawMoveDemo(sel) {
  const cx = sx(sel.x), cy = sy(sel.y);
  const range = ST(sel.type).move * view.scale;          // радиус хода в экранных px
  const W = canvas.clientWidth, H = canvas.clientHeight;
  // направление демо — к центру экрана (чтобы жест влез); запас если корабль у центра
  let dir = Math.atan2(H / 2 - cy, W / 2 - cx);
  if (Math.hypot(W / 2 - cx, H / 2 - cy) < 40) dir = 0.6;
  const maxFinger = range * 1.25;                         // докуда «уводим палец»

  const ph = ((performance.now() - moveDemo.t0) % 2400) / 2400;
  let prog, alpha = 1;
  if (ph < 0.12) prog = 0;                                // «прижал палец»
  else if (ph < 0.62) { const u = (ph - 0.12) / 0.5; prog = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; }
  else if (ph < 0.85) prog = 1;                           // держим
  else { prog = 1; alpha = 1 - (ph - 0.85) / 0.15; }      // затухание перед циклом

  const fx = cx + Math.cos(dir) * maxFinger * prog, fy = cy + Math.sin(dir) * maxFinger * prog;
  const dx = cx + Math.cos(dir) * maxFinger * prog * AIM_RATIO, dy = cy + Math.sin(dir) * maxFinger * prog * AIM_RATIO;

  ctx.save();
  ctx.globalAlpha = alpha;
  // пульс «нажми здесь» в начале фазы
  if (ph < 0.22) {
    const pr = 14 + (ph / 0.22) * 26;
    ctx.beginPath(); ctx.arc(cx, cy, pr, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(39,174,96,${0.5 * (1 - ph / 0.22)})`;
    ctx.lineWidth = 2; ctx.stroke();
  }
  if (prog > 0.02) {
    // луч до крестика
    ctx.beginPath(); ctx.setLineDash([4, 5]);
    ctx.moveTo(cx, cy); ctx.lineTo(dx, dy);
    ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    drawCrosshair(dx, dy, '#2b3a55');
    // тонкая линия крестик→палец
    ctx.beginPath(); ctx.setLineDash([2, 4]);
    ctx.moveTo(dx, dy); ctx.lineTo(fx, fy);
    ctx.strokeStyle = 'rgba(43,58,85,.35)'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
  }
  // «палец»
  ctx.beginPath(); ctx.arc(fx, fy, 15, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(46,204,113,.32)'; ctx.fill();
  ctx.strokeStyle = 'rgba(39,174,96,.9)'; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.font = '20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('👆', fx, fy + 2);
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
}

function drawCrosshair(x, y, col) {
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 15, y); ctx.lineTo(x - 4, y);
  ctx.moveTo(x + 4, y); ctx.lineTo(x + 15, y);
  ctx.moveTo(x, y - 15); ctx.lineTo(x, y - 4);
  ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 15);
  ctx.stroke();
}

// Размеры корпусов в ЕДИНИЦАХ КАРТЫ — масштабируются строго одинаково,
// пропорции классов не меняются при зуме (никаких min-капов на размер).
const SHIP_LEN = { barkas: 34, shkhuna: 42, brig: 50, fregat: 60, linkor: 72, pirate: 50, carrier: 132, repair: 44 };
const SHIP_MASTS = { barkas: 0, shkhuna: 1, brig: 2, fregat: 3, linkor: 3, pirate: 2, repair: 0 };
const headings = new Map(); // shipId → направление носа (по последнему ходу)

function currentHeading(s) {
  if (s._headingOverride !== undefined) return s._headingOverride;
  if (headings.has(s.id)) return headings.get(s.id);
  if (typeof s.heading === 'number') return s.heading; // пираты приходят с курсом
  // по умолчанию нос смотрит к центру карты
  return Math.atan2(state.map.h / 2 - s.y, state.map.w / 2 - s.x);
}

// Чит-авианосец рисуется НЕ как парусник: большая серая лётная палуба с разметкой ВПП,
// надстройкой-«островом» и самолётиками. Цвет игрока — только акцентами (флаг, кормовая полоса).
function drawCarrier(s, p, px, py, pos, k, selected) {
  const L = SHIP_LEN.carrier * k;                 // намного длиннее линкора (132 против 72)
  const hw = L * 0.2;                              // половина ширины — широкий «беамистый» корпус
  const bow = L * 0.5, stern = -L * 0.5;
  const ang = pos.ang !== undefined ? pos.ang : currentHeading(s);
  const col = p ? p.color : '#8a8f98';

  if (selected) {
    ctx.beginPath();
    ctx.arc(px, py, L * 0.58, 0, Math.PI * 2);
    ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(ang);

  // корпус (тёмно-серый, нос заострён)
  ctx.beginPath();
  ctx.moveTo(stern, -hw * 0.78);
  ctx.lineTo(bow * 0.72, -hw);
  ctx.lineTo(bow, -hw * 0.28);
  ctx.lineTo(bow, hw * 0.28);
  ctx.lineTo(bow * 0.72, hw);
  ctx.lineTo(stern, hw * 0.78);
  ctx.closePath();
  ctx.fillStyle = '#565c66';
  ctx.fill();
  ctx.strokeStyle = '#2b3a55';
  ctx.lineWidth = Math.max(1, 1.8 * k);
  ctx.stroke();

  // лётная палуба (светло-серая, чуть уже корпуса)
  ctx.beginPath();
  ctx.moveTo(stern + L * 0.03, -hw * 0.64);
  ctx.lineTo(bow * 0.66, -hw * 0.82);
  ctx.lineTo(bow * 0.9, 0);
  ctx.lineTo(bow * 0.66, hw * 0.82);
  ctx.lineTo(stern + L * 0.03, hw * 0.64);
  ctx.closePath();
  ctx.fillStyle = '#878e98';
  ctx.fill();

  // разметка ВПП: осевая (пунктир) + угловая палуба
  ctx.strokeStyle = 'rgba(255,255,255,.88)';
  ctx.lineWidth = Math.max(1, 1.8 * k);
  ctx.setLineDash([6 * k, 5 * k]);
  ctx.beginPath(); ctx.moveTo(stern + L * 0.08, 0); ctx.lineTo(bow * 0.78, 0); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(stern + L * 0.12, hw * 0.12); ctx.lineTo(bow * 0.64, -hw * 0.55); ctx.stroke();
  ctx.setLineDash([]);

  // кормовая полоса цвета игрока (акцент)
  ctx.strokeStyle = col; ctx.lineWidth = Math.max(2, 3.5 * k);
  ctx.beginPath(); ctx.moveTo(stern + L * 0.035, -hw * 0.58); ctx.lineTo(stern + L * 0.035, hw * 0.58); ctx.stroke();

  // самолётики (тёмные «крестики», носом к корме корабля)
  ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = Math.max(1, 1.3 * k); ctx.lineCap = 'round';
  const plane = (cx, cy) => {
    ctx.beginPath();
    ctx.moveTo(cx - 4 * k, cy); ctx.lineTo(cx + 4 * k, cy);              // фюзеляж
    ctx.moveTo(cx + 0.5 * k, cy); ctx.lineTo(cx - 1.5 * k, cy - 3.2 * k); // крылья
    ctx.moveTo(cx + 0.5 * k, cy); ctx.lineTo(cx - 1.5 * k, cy + 3.2 * k);
    ctx.moveTo(cx - 4 * k, cy); ctx.lineTo(cx - 5.4 * k, cy - 1.8 * k);   // хвост
    ctx.moveTo(cx - 4 * k, cy); ctx.lineTo(cx - 5.4 * k, cy + 1.8 * k);
    ctx.stroke();
  };
  for (const [fx, fy] of [[0.2, -0.42], [0.38, -0.42], [0.2, 0.3], [0.56, -0.38]]) plane(stern + L * fx, hw * fy);
  ctx.lineCap = 'butt';

  // надстройка-«остров» по правому борту (тёмно-серый блок) + полоса цвета игрока
  const iw = L * 0.13, ih = hw * 0.95, ix = bow * 0.08 - iw / 2, iy = hw * 0.6 - ih / 2;
  ctx.fillStyle = '#3c424b';
  ctx.fillRect(ix, iy, iw, ih);
  ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = Math.max(.8, 1.2 * k); ctx.strokeRect(ix, iy, iw, ih);
  ctx.fillStyle = col;                                   // цветной «флаг»-полоса на острове
  ctx.fillRect(ix, iy + ih * 0.32, iw, Math.max(2, ih * 0.22));

  ctx.restore();

  hpBar(px, py + L * 0.4 + 4, Math.max(22, L * 0.62), s.hp / (s.maxHp || 1400), '#27ae60');
}

// Ремонтник: силуэт как у обычного корабля, только чуть УГЛОВАТЕЕ (прямые грани вместо плавных)
// и компактный; опознаётся жёлтым ремонтным крестом на палубе. Корпус — цвета игрока, как у всех.
function drawRepairShip(s, p, px, py, pos, k, selected) {
  const L = (SHIP_LEN.repair || 44) * k;
  const W = L * 0.40;            // лишь немного шире обычного — корабельный силуэт, не баржа
  const hull = p ? p.color : '#33363c';

  if (selected) {
    ctx.beginPath();
    ctx.arc(px, py, L * 0.72, 0, Math.PI * 2);
    ctx.strokeStyle = '#2b3a55';
    ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(pos.ang !== undefined ? pos.ang : currentHeading(s));

  // корпус — угловатый: прямые борта, гранёный (чуть тупой) нос, слегка заострённая корма
  ctx.beginPath();
  ctx.moveTo(-L / 2, 0);                       // корма
  ctx.lineTo(-L / 2 + L * 0.14, -W / 2);
  ctx.lineTo(L / 2 - L * 0.18, -W / 2);        // прямой левый борт
  ctx.lineTo(L / 2 + L * 0.05, 0);             // гранёный нос
  ctx.lineTo(L / 2 - L * 0.18, W / 2);
  ctx.lineTo(-L / 2 + L * 0.14, W / 2);        // прямой правый борт
  ctx.closePath();
  ctx.fillStyle = hull; ctx.fill();
  ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = Math.max(0.8, 1.6 * k); ctx.stroke();

  // палуба — светлая, тоже угловатая, уже корпуса
  ctx.beginPath();
  ctx.moveTo(-L / 2 + L * 0.14, 0);
  ctx.lineTo(-L / 2 + L * 0.2, -W * 0.28);
  ctx.lineTo(L / 2 - L * 0.22, -W * 0.28);
  ctx.lineTo(L / 2 - L * 0.1, 0);
  ctx.lineTo(L / 2 - L * 0.22, W * 0.28);
  ctx.lineTo(-L / 2 + L * 0.2, W * 0.28);
  ctx.closePath();
  ctx.fillStyle = '#e8d9a8'; ctx.fill();
  ctx.lineWidth = Math.max(0.6, 1 * k); ctx.stroke();

  // одна мачта (как у шхуны), ближе к корме — чтобы силуэт читался «кораблём»
  const mx = -L * 0.16;
  ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = Math.max(1, 2 * k);
  ctx.beginPath(); ctx.moveTo(mx, -W / 2 - W * 0.35); ctx.lineTo(mx, W / 2 + W * 0.35); ctx.stroke();
  ctx.beginPath(); ctx.arc(mx, 0, Math.max(1.2, W * 0.15), 0, Math.PI * 2); ctx.fillStyle = '#2b3a55'; ctx.fill();

  // жёлтый ремонтный крест на палубе (опознавательный знак), ближе к носу
  const cs = Math.max(3, L * 0.18), ct = cs * 0.34, cx = L * 0.14;
  ctx.fillStyle = '#f4c20a';
  ctx.fillRect(cx - ct / 2, -cs / 2, ct, cs);
  ctx.fillRect(cx - cs / 2, -ct / 2, cs, ct);
  ctx.strokeStyle = '#8a6d00'; ctx.lineWidth = Math.max(0.5, 0.8 * k);
  ctx.strokeRect(cx - ct / 2, -cs / 2, ct, cs);
  ctx.strokeRect(cx - cs / 2, -ct / 2, cs, ct);

  // вымпел цвета игрока на корме (как у всех кораблей)
  ctx.beginPath();
  ctx.moveTo(-L / 2 - 1, 0);
  ctx.lineTo(-L / 2 - L * 0.2, -W * 0.3);
  ctx.lineTo(-L / 2 - L * 0.2, W * 0.3);
  ctx.closePath();
  ctx.fillStyle = hull; ctx.fill();

  ctx.restore();
  const bw = Math.max(16, L * 0.9);
  hpBar(px, py + L * 0.42 + 4, bw, s.hp / (s.maxHp || ST(s.type).hp), '#27ae60');
  // жёлтая шкала запаса ремонта под полоской HP
  const cmax = state.repairChargesMax || 8;
  chargeBar(px, py + L * 0.42 + 11, bw, s.repairCharges ?? cmax, cmax);
}

function drawShip(s, selected) {
  const isPirate = s.owner === -1;
  const p = isPirate ? null : state.players[s.owner];
  const st = ST(s.type);
  const pos = animPos.get(s.id) || (state.rt && rtPos.get(s.id)) || s; // анимация → сглаженная (шторм) → серверная
  const px = sx(pos.x), py = sy(pos.y);
  const k = view.scale;
  if (s.type === 'carrier') { drawCarrier(s, p, px, py, pos, k, selected); return; } // чит-авианосец — своя отрисовка
  if (s.type === 'repair') { drawRepairShip(s, p, px, py, pos, k, selected); return; } // ремонтник — квадратный корпус с жёлтым крестом
  const L = (SHIP_LEN[s.type] || 46) * k * (s.boss ? 1.5 : 1); // босс крупнее
  const W = L * 0.36;
  const hull = isPirate ? (s.boss ? '#1c1c22' : '#33363c') : p.color;

  if (selected) {
    ctx.beginPath();
    ctx.arc(px, py, L * 0.72, 0, Math.PI * 2);
    ctx.strokeStyle = '#2b3a55';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(pos.ang !== undefined ? pos.ang : currentHeading(s));

  // корпус: остроносый, нос — по направлению движения
  ctx.beginPath();
  ctx.moveTo(-L / 2, 0);
  ctx.quadraticCurveTo(-L / 2 + L * 0.12, -W / 2, 0, -W / 2);
  ctx.quadraticCurveTo(L / 2 - L * 0.06, -W / 2 + 2 * k, L / 2 + L * 0.11, 0);
  ctx.quadraticCurveTo(L / 2 - L * 0.06, W / 2 - 2 * k, 0, W / 2);
  ctx.quadraticCurveTo(-L / 2 + L * 0.12, W / 2, -L / 2, 0);
  ctx.closePath();
  ctx.fillStyle = hull;
  ctx.fill();
  ctx.strokeStyle = '#2b3a55';
  ctx.lineWidth = Math.max(0.8, 1.6 * k);
  ctx.stroke();

  // палуба
  ctx.beginPath();
  ctx.moveTo(-L / 2 + L * 0.09, 0);
  ctx.quadraticCurveTo(0, -W / 2 + W * 0.3, L / 2 - L * 0.03, 0);
  ctx.quadraticCurveTo(0, W / 2 - W * 0.3, -L / 2 + L * 0.09, 0);
  ctx.closePath();
  ctx.fillStyle = '#e8d9a8';
  ctx.fill();
  ctx.lineWidth = Math.max(0.6, 1 * k);
  ctx.stroke();

  const masts = SHIP_MASTS[s.type] ?? 1;
  if (!masts) {
    // баркас: банки-перекладины и сеть за кормой
    ctx.strokeStyle = '#2b3a55';
    for (let i = -1; i <= 1; i++) {
      ctx.beginPath();
      ctx.moveTo(i * L / 5, -W / 2 + W * 0.18);
      ctx.lineTo(i * L / 5, W / 2 - W * 0.18);
      ctx.stroke();
    }
    if (s.netting) {
      // 🎣 СЕТЬ РАЗВЁРНУТА: рыбак в зоне И в лимите — реально ловит (флаг netting с сервера).
      // Веер-купол за кормой: дуги + радиальные нити + поплавки, слегка «дышит» (в реалтайме анимируется).
      const ph = (Date.now() / 1100) % (Math.PI * 2);
      const R = L * (0.62 + Math.sin(ph) * 0.04);
      const a0 = Math.PI * 0.62, a1 = Math.PI * 1.38; // раскрыт назад (корма = −x)
      ctx.save();
      ctx.translate(-L / 2 - L * 0.06, 0);
      ctx.rotate(Math.sin(ph * 0.7) * 0.05); // лёгкое покачивание купола
      ctx.strokeStyle = 'rgba(43,58,85,.55)';
      ctx.lineWidth = Math.max(0.5, 0.9 * k);
      for (const rr of [R, R * 0.66, R * 0.34]) { // ячеистость: три дуги купола
        ctx.beginPath();
        ctx.arc(0, 0, rr, a0, a1);
        ctx.stroke();
      }
      for (let i = 0; i <= 4; i++) { // радиальные нити от кормы к внешней дуге
        const a = a0 + (a1 - a0) * (i / 4);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * R * 0.12, Math.sin(a) * R * 0.12);
        ctx.lineTo(Math.cos(a) * R, Math.sin(a) * R);
        ctx.stroke();
      }
      ctx.fillStyle = '#2b3a55'; // поплавки на внешней дуге
      for (let i = 0; i <= 3; i++) {
        const a = a0 + (a1 - a0) * (i / 3);
        ctx.beginPath();
        ctx.arc(Math.cos(a) * R, Math.sin(a) * R, Math.max(0.8, 1.3 * k), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    } else {
      // сеть сложена на корме (не ловит: плывёт, ждёт места или зона переполнена)
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = 'rgba(43,58,85,.7)';
      ctx.beginPath();
      ctx.arc(-L / 2 - L * 0.18, W * 0.18, L * 0.14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  } else {
    // мачты с реями
    const mastXs = masts === 1 ? [0] : masts === 2 ? [-L / 6, L / 6] : [-L / 4, 0, L / 4];
    for (const mx of mastXs) {
      ctx.strokeStyle = '#2b3a55';
      ctx.lineWidth = Math.max(1, 2 * k);
      ctx.beginPath();
      ctx.moveTo(mx, -W / 2 - W * 0.42);
      ctx.lineTo(mx, W / 2 + W * 0.42);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(mx, 0, Math.max(1.2, W * 0.16), 0, Math.PI * 2);
      ctx.fillStyle = '#2b3a55';
      ctx.fill();
    }
    // пушки по бортам
    const guns = s.type === 'linkor' ? 4 : s.type === 'fregat' ? 3 : 2;
    ctx.lineWidth = Math.max(0.8, 1.6 * k);
    ctx.strokeStyle = '#2b3a55';
    for (let i = 0; i < guns; i++) {
      const gx = -L / 3 + (i + 0.5) * (L / 1.5 / guns);
      ctx.beginPath(); ctx.moveTo(gx, -W / 2); ctx.lineTo(gx, -W / 2 - W * 0.3); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(gx, W / 2); ctx.lineTo(gx, W / 2 + W * 0.3); ctx.stroke();
    }
  }

  // вымпел на корме
  ctx.beginPath();
  ctx.moveTo(-L / 2 - 1, 0);
  ctx.lineTo(-L / 2 - L * 0.2, -W * 0.3);
  ctx.lineTo(-L / 2 - L * 0.2, W * 0.3);
  ctx.closePath();
  ctx.fillStyle = isPirate ? '#111' : p.color;
  ctx.fill();

  ctx.restore();

  if (isPirate) {
    ctx.font = `${Math.max(9, 16 * k)}px serif`;
    ctx.textAlign = 'center';
    ctx.fillText(s.boss ? '👑🏴‍☠️' : '🏴‍☠️', px, py - L * 0.5);
    ctx.font = `bold ${Math.max(9, 14 * k)}px Neucha, cursive`;
    ctx.fillStyle = s.boss ? '#a87900' : '#2b3a55';
    ctx.fillText(`💰${s.bounty}`, px, py + L * 0.62 + 16 * k);
  }

  hpBar(px, py + L * 0.42 + 4, Math.max(16, L * 0.9), s.hp / (s.maxHp || st.hp), '#27ae60');
}

// ============ ВЗАИМОДЕЙСТВИЕ С КАРТОЙ ============
// Пойнтеры: тап = действие, драг = панорама, пинч/колесо = зум.
const pointers = new Map();
let drag = null; // {x, y, moved}
let pinchDist = 0;

const evPos = e => {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
};

canvas.addEventListener('pointerdown', e => {
  // тач: без preventDefault браузер параллельно шлёт «мышиные» события-двойники и запускает
  // выделение/long-press — в эмуляции мобилы (DevTools) жесты от этого дёргаются и «не нажимаются»
  e.preventDefault();
  // новый ПЕРВИЧНЫЙ палец при «забытых» указателях: pointercancel в эмуляции доходит не всегда,
  // фантом в pointers превращает каждый одиночный жест в «пинч» (карта перестаёт двигаться) — чистим.
  // Вместе с фантомом гасим и его прицел: иначе новый жест «дотянет» чужой aim и корабль уплывёт
  if (e.isPrimary && pointers.size) { pointers.clear(); drag = null; pinchDist = 0; aim = null; hoverPt = null; }
  try { canvas.setPointerCapture(e.pointerId); } catch { /* синтетические события */ }
  hideShipNote(); // тап/драг убирает записку (на тапе по «якорному» кораблю покажется заново)
  pointers.set(e.pointerId, evPos(e));
  if (DEBUG_ON && debugTool && pointers.size === 1) {   // 🐞 инструмент забирает клик себе
    const sp = evPos(e);
    const w = toMap(sp.x, sp.y);
    debugClick(w.x, w.y);
    return;
  }
  if (pointers.size === 1) {
    const p = evPos(e);
    // 🎛 ЕДИНЫЙ ЖЕСТ ДВИЖЕНИЯ (мышь И тач, из ЛЮБОГО режима): указатель лёг на свой корабль →
    // тянем шлейф курса с крестиком, а не панораму. Тап без тяги = выбор (штурвал). Тяга из режима
    // стрельбы ОТМЕНЯЕТ её и переключает на ход. Мышке хват поуже — она точнее пальца.
    if (state && isMyTurn()) {
      const grabR = e.pointerType === 'touch' ? AIM_GRAB_PX : 30;
      const sel = selectedShipId && state.ships.find(s => s.id === selectedShipId);
      // корабль, уже сходивший в этом ходу, не «хватаем» прицелом (drag → панорама)
      const onSel = sel && !shipActed(sel.id) && dist(p.x, p.y, sx(sel.x), sy(sel.y)) <= grabR;
      const own = onSel ? sel
        : state.ships.find(s => s.owner === myIdx() && !shipActed(s.id) && dist(p.x, p.y, sx(s.x), sy(s.y)) <= grabR);
      if (own) { aim = { sel: own, armed: false, startX: p.x, startY: p.y }; return; }
    }
    // палец «ездит» сильнее мыши — порог тапа больше
    drag = { x: p.x, y: p.y, moved: false, threshold: e.pointerType === 'mouse' ? 6 : 18 };
  } else if (pointers.size === 2) {
    aim = null; hoverPt = null; // второй палец → пинч, прицел отменяем
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    drag = null;
  }
});

// тач-прицел: цель = точка на «середине» пути до пальца (AIM_RATIO), но не дальше радиуса хода
function updateAim(screenPt) {
  const sel = aim.sel;
  const f = toMap(screenPt.x, screenPt.y);
  aim.finger = f;
  const dx = f.x - sel.x, dy = f.y - sel.y;
  const fd = Math.hypot(dx, dy);
  // ⚡ реалтайм: тянуть можно куда угодно; пошагово — 🌬 дальность по курсу (капля ветра)
  const range = state?.rt ? Infinity : ST(sel.type).move * windK(Math.atan2(dy, dx));
  aim.cancel = fd < AIM_CANCEL_DIST;   // вернул палец почти на корабль → ход отменим (передумал)
  if (fd < 1) { aim.dest = { x: sel.x, y: sel.y }; aim.clamped = false; }
  else {
    // ⚡ реалтайм: крестик ПОД ПАЛЬЦЕМ (дальности нет — «середина пути» только укорачивала жест);
    // пошагово — на AIM_RATIO пути (палец не закрывает цель, а дальше круга всё равно нельзя)
    const len = fd * (state?.rt ? 1 : AIM_RATIO);
    aim.clamped = len > range;     // вышла за контур хода — ход недопустим
    const k = len / fd;
    aim.dest = { x: sel.x + dx * k, y: sel.y + dy * k };
  }
  hoverPt = aim.dest; // рендер «линейки» сам красит красным, если точка вне радиуса
}

canvas.addEventListener('pointermove', e => {
  if (!state || !state.map) return;
  const p = evPos(e);

  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

  if (aim && pointers.size === 1) { // тянем шлейф курса (единый жест движения)
    if (!aim.armed) {
      if (Math.hypot(p.x - aim.startX, p.y - aim.startY) <= 12) return; // ещё не потянул
      // взводим ход: тяга из режима стрельбы ОТМЕНЯЕТ её (mode='move' включает отрисовку шлейфа)
      aim.armed = true; selectedShipId = aim.sel.id; mode = 'move'; moveDemo = null;
    }
    updateAim(p);
    if (!rafOn) render(); // в RT аним-цикл перерисует сам — не дублируем кадры на каждый move-эвент
    return;
  }

  if (pointers.size === 2) { // пинч-зум
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDist > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinchDist);
    pinchDist = d;
    return;
  }

  if (drag && pointers.size === 1) {
    const dx = p.x - drag.x, dy = p.y - drag.y;
    if (drag.moved || Math.hypot(dx, dy) > drag.threshold) {
      drag.moved = true;
      cam.px += dx;
      cam.py += dy;
      clampCam();
      drag.x = p.x;
      drag.y = p.y;
      if (!rafOn) render(); // в RT кадр и так на подходе (аним-цикл) — пан не дублирует рендер
      return;
    }
  }

  // наведение для «линейки» — только мышь (на тач курса-наведения нет, есть drag-aim)
  if (e.pointerType === 'mouse') {
    hoverPt = toMap(p.x, p.y);
    // записка-стикер над сходившим своим кораблём при наведении мышью
    const overActed = isMyTurn() && state.ships.find(s =>
      s.owner === myIdx() && shipActed(s.id) && dist(p.x, p.y, sx(s.x), sy(s.y)) <= 28);
    if (overActed) showShipNote(sx(overActed.x), sy(overActed.y) - 16, '⚓ Уже ходил');
    else hideShipNote();
    // «линейка» хода / прицел залпа за курсором: в RT аним-цикл и так перерисует ближайшим
    // кадром — прямой render на каждый mousemove (до 120 Гц) там лишний, кадры удваивались
    if ((mode === 'move' || mode === 'broadside') && !rafOn) render();
  }
});

function endPointer(e) {
  // завершение тач-прицела: отпустил палец — корабль плывёт к крестику
  if (aim && e.type === 'pointerup') {
    const a = aim;
    aim = null; hoverPt = null;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) { drag = null; pinchDist = 0; }
    if (!a.armed) { handleTap({ x: a.startX, y: a.startY }, e.pointerType === 'touch'); return; } // не потянул → выбор/подсказка
    mode = 'idle'; // жест завершён — из «хода» возвращаемся в покой (штурвал/прицел не залипают)
    if (a.cancel) { deselect(); render(); return; } // вернул указатель на корабль — передумал: отмена и штурвал закрыт
    if (a.clamped) { errToast('🚫 Слишком далеко — точка вне круга хода'); return; } // вне радиуса — без хода
    if (a.dest && dist(a.sel.x, a.sel.y, a.dest.x, a.dest.y) > 4) {
      sendAction({ type: 'move', shipId: a.sel.id, x: Math.round(a.dest.x), y: Math.round(a.dest.y) });
    } else {
      render(); // почти не сдвинул — просто убрать прицел
    }
    return;
  }
  if (aim) { aim = null; hoverPt = null; } // pointercancel при активном прицеле

  const wasTap = drag && !drag.moved && pointers.size === 1 && e.type === 'pointerup';
  pointers.delete(e.pointerId);
  if (pointers.size === 1) {
    // пинч закончился — оставшийся палец продолжает панораму (без случайного тапа)
    const [p] = [...pointers.values()];
    drag = { x: p.x, y: p.y, moved: true, threshold: 0 };
    pinchDist = 0;
  } else if (pointers.size === 0) {
    drag = null;
    pinchDist = 0;
  }
  if (wasTap) handleTap(evPos(e), e.pointerType === 'touch');
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
// ПКМ на десктопе = «отмена»: сбрасывает прицел/шлейф и закрывает штурвал.
// Заодно глушим контекст-меню (long-press на сенсоре рвал жест).
canvas.addEventListener('contextmenu', e => {
  e.preventDefault();
  if (aim) { aim = null; hoverPt = null; }
  deselect();
  render();
});

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const p = evPos(e);
  zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

function handleTap(pos, isTouch) {
  if (!state || !state.map || state.status !== 'active') return;
  const pt = toMap(pos.x, pos.y);
  // радиус попадания — с гарантией в ЭКРАННЫХ px: на отзумленной карте (мобила, cover-fit)
  // чисто мировой радиус скукоживался до ~15px — пальцем в корабль было не попасть
  const tapR = Math.max(isTouch ? 34 : 26, (isTouch ? 30 : 16) / view.scale);

  // 🎛 штурвал: тап по иконке кольца (кольцо видно только в покое — скрытые иконки тапы не ловят)
  if (WHEEL_UI && selectedShipId && isMyTurn() && mode === 'idle') {
    const wsel = state.ships.find(s => s.id === selectedShipId);
    if (wsel && wsel.owner === myIdx()) {
      const hit = wheelHit(wsel, pos.x, pos.y);
      if (hit) {
        if (hit.off) errToast(hit.offMsg || (hit.cdMs > 0 ? `⏳ Перезарядка: ${Math.ceil(hit.cdMs / 1000)}с` : '⚓ Сейчас недоступно'));
        else { Sound.play('click'); hit.go(); }
        return;
      }
    }
  }

  const clickedShip = state.ships.find(s => dist(pt.x, pt.y, s.x, s.y) < tapR);

  if (mode === 'broadside' && selectedShipId && !(clickedShip && clickedShip.owner === myIdx())) {
    // залп в сторону точки прицела (сервер сам определит борт и сектор); тап по СВОЕМУ кораблю
    // проваливается ниже — перевыбор (штурвал важнее недонаведённого залпа)
    sendAction({ type: 'broadside', shipId: selectedShipId, tx: pt.x, ty: pt.y });
    mode = 'idle'; // залп ушёл — штурвал возвращается (кулдаун виден на иконке борта)
    render();
    return;
  }

  if (mode === 'attack' && selectedShipId && !(clickedShip && clickedShip.owner === myIdx())) {
    const asel = state.ships.find(s => s.id === selectedShipId);
    if (clickedShip && clickedShip.owner !== myIdx()) {
      sendAction({ type: 'attack', shipId: selectedShipId, targetType: 'ship', targetId: clickedShip.id });
      mode = 'idle'; render();
      return;
    }
    const baseIdx = state.map.bases.findIndex(b => dist(pt.x, pt.y, b.x, b.y) < b.radius + 12);
    if (baseIdx >= 0 && baseIdx !== myIdx() && state.players[baseIdx]?.alive) {
      sendAction({ type: 'attack', shipId: selectedShipId, targetType: 'port', targetId: baseIdx });
      mode = 'idle'; render();
      return;
    }
    // ⛺ чужой аванпост на острове — цель мортиры (только она и разрушает постройки)
    const opIdx = (state.map.lootIslands || []).findIndex(i =>
      i.outpost && i.outpost.owner !== myIdx() && dist(pt.x, pt.y, i.x, i.y) < i.radius + 12);
    if (opIdx >= 0) {
      sendAction({ type: 'attack', shipId: selectedShipId, targetType: 'outpost', targetId: opIdx });
      mode = 'idle'; render();
      return;
    }
    // тап мимо целей (или вне радиуса) — передумал: тихо закрываем прицел и штурвал
    deselect();
    return;
  }

  if (mode === 'repair' && selectedShipId) {
    if (clickedShip && clickedShip.owner === myIdx() && clickedShip.id !== selectedShipId) {
      sendAction({ type: 'repair', shipId: selectedShipId, targetId: clickedShip.id });
      mode = 'idle'; render();
      return;
    }
    if (!clickedShip) { deselect(); return; } // мимо своих — передумал (тап по своему провалится в выбор)
  }

  // выбор своего корабля — из ЛЮБОГО режима (тап по кораблю всегда открывает штурвал)
  if (clickedShip && clickedShip.owner === myIdx() && isMyTurn()) {
    if (shipActed(clickedShip.id)) { // уже ходил — показываем записку (на тач сама исчезнет)
      showShipNote(sx(clickedShip.x), sy(clickedShip.y) - 16, '⚓ Уже ходил');
      if (isTouch) { clearTimeout(shipNoteTimer); shipNoteTimer = setTimeout(hideShipNote, 2200); }
      return;
    }
    closeOutpostPanel(); // корабль и аванпост не толкаются
    selectedShipId = clickedShip.id;
    mode = 'idle';
    Sound.play('click');
    wheelBornAt = performance.now(); // 🎛 штурвал раскрывается вокруг корабля
    startMoveDemo(); // сенсор, до первого хода: демка «потяни от корабля» (внутри сама решит, надо ли)
    if (!WHEEL_UI) {
      $('#shipActions').classList.remove('hidden');
      positionActionBar(clickedShip); // панель — на противоположной кораблю половине экрана
      $('#shipActionsTitle').textContent = ST(clickedShip.type).icon + ' ' + ST(clickedShip.type).name;
    }
    updateActionButtons();
    render();
    return;
  }
  // ⛺ тап по СВОЕМУ аванпосту → панель постройки (уровень, перки, улучшение)
  const opIdx = (state.map.lootIslands || []).findIndex(i =>
    i.outpost && i.outpost.owner === myIdx() && dist(pt.x, pt.y, i.x, i.y) < i.radius + tapR);
  if (opIdx >= 0 && !spectator) {
    Sound.play('click');
    openOutpostPanel(opIdx);
    return;
  }
  closeOutpostPanel();
  deselect();
}

// На мобиле панель действий ставим на половину экрана, ПРОТИВОПОЛОЖНУЮ кораблю —
// чтобы не перекрывать его и путь к нему. Корабль в нижней половине → панель сверху, и наоборот.
function positionActionBar(ship) {
  const bar = $('#shipActions');
  if (!matchMedia('(max-width: 900px)').matches) { bar.classList.remove('at-bottom'); return; }
  const shipInLowerHalf = sy(ship.y) > canvas.clientHeight / 2;
  bar.classList.toggle('at-bottom', !shipInLowerHalf);
}

function canShipCollect(ship) {
  // рыбалка теперь пассивная (капает в начале хода) — «Собрать» только для клада с островов
  return state.map.lootIslands.some(i => !i.looted &&
    dist(ship.x, ship.y, i.x, i.y) <= i.radius + (state.lootReach || 55));
}
// ⛺ остров рядом, где можно ПОСТРОИТЬ аванпост (первая постройка — кораблём;
// апгрейды — кликом по самому аванпосту, см. openOutpostPanel)
function outpostIslandAt(ship) {
  const reach = state.outposts?.reach || 70;
  const idx = (state.map.lootIslands || []).findIndex(i => i.looted && !i.outpost &&
    dist(ship.x, ship.y, i.x, i.y) <= i.radius + reach);
  return idx >= 0 ? idx : -1;
}

// ⛺ ПАНЕЛЬ АВАНПОСТА: клик по своему аванпосту → уровень, перки словами, кнопка «Улучшить».
let outpostPanelIdx = null; // какой остров открыт (обновляется каждым стейтом, закрывается если снесли)
function perkText(def) {
  const parts = [`💰 +${def.income} золота/ход`];
  if (def.heal) parts.push(`🛟 чинит твои корабли рядом (+${Math.round(def.heal * 100)}% прочности/ход)`);
  if (def.gun) parts.push(`💥 пушка: −${def.gun} HP врагу/пирату рядом`);
  parts.push('👁 дозор: снимает туман вокруг');
  return parts.join(' · ');
}
function openOutpostPanel(idx) {
  outpostPanelIdx = idx;
  deselect(); // панель корабля и аванпоста не толкаются
  updateOutpostPanel();
}
function closeOutpostPanel() {
  outpostPanelIdx = null;
  $('#outpostPanel').classList.add('hidden');
}
function updateOutpostPanel() {
  if (outpostPanelIdx === null) return;
  const isl = state.map.lootIslands?.[outpostPanelIdx];
  const op = isl?.outpost;
  if (!op || op.owner !== myIdx()) { closeOutpostPanel(); return; } // снесли/чужой — закрыть
  const lv = state.outposts?.levels || [];
  const def = lv[op.level - 1], next = lv[op.level];
  $('#outpostPanel').classList.remove('hidden');
  $('#outpostTitle').textContent = `${def.icon} ${def.name}${op.hp < def.hp ? ` · 🏚${op.hp}/${def.hp}` : ''}`;
  $('#outpostPerks').textContent = perkText(def);
  const btn = $('#btnOutpostUp'), hint = $('#outpostNext');
  btn.classList.toggle('hidden', !next);
  hint.classList.toggle('hidden', !next);
  if (next) {
    const gold = state.players[myIdx()]?.gold ?? 0;
    btn.textContent = `⬆ ${next.icon} ${next.name} (${next.price})`;
    btn.disabled = gold < next.price || (!isRT() && !isMyTurn());
    hint.textContent = `даст: ${perkText(next)}`;
  }
}
$('#btnOutpostUp').addEventListener('click', () => {
  if (outpostPanelIdx !== null) sendAction({ type: 'outpost', islandId: outpostPanelIdx });
});
$('#outpostClose').addEventListener('click', closeOutpostPanel);
// ремонтник с неполным запасом материалов, стоящий у СВОЕЙ базы — может «Пополнить»
function repairChargesMax() { return state.repairChargesMax || 8; }
function canShipRecharge(ship) {
  if (!ST(ship.type).repairer || (ship.repairCharges ?? repairChargesMax()) >= repairChargesMax()) return false;
  const base = state.map.bases[myIdx()];
  return !!base && dist(ship.x, ship.y, base.x, base.y) <= base.radius + (state.repairDockReach || 60);
}

// у корабля есть бортовые пушки (залп)
function canBroadside(ship) { return !!(state.broadside?.cannons?.[ship.type]); }
// мортира — у фрегата/линкора (+ чит-авианосец)
function canMortar(ship) { return (state.broadside?.mortarShips || []).includes(ship.type) || !!ST(ship.type).cheat; }
const broadsideHalfArc = () => state.broadside?.halfArc || 0.8; // ~46°: борт средней ширины
// какие борта корабль уже отстрелял в этом ходу (⛈️ шторм: борта на перезарядке)
const firedSides = id => {
  if (isRT()) {
    const s = state.ships.find(x => x.id === id);
    return ['port', 'starboard'].filter(sd => cdLeft(s, sd === 'port' ? 'p' : 's') > 0);
  }
  return (state.turn?.broadsideSides || {})[id] || [];
};

// Кнопки выбранного корабля: видимость по способностям + блокировка по экономике хода.
// Начал залп (один борт) → ход/мортира/сбор серые, но залп активен для 2-го борта. Оба борта/ход/мортира → корабль отстрелялся.
function updateActionButtons() {
  const sel = selectedShipId && state?.ships.find(s => s.id === selectedShipId);
  if (!sel || sel.owner !== myIdx()) return;
  if (shipActed(sel.id)) { deselect(); return; } // полностью отстрелялся — снять выбор
  const st = ST(sel.type);
  const noCharges = st.repairer && (sel.repairCharges ?? repairChargesMax()) <= 0; // ремонтник без материалов
  $('#btnFire').classList.toggle('hidden', !canMortar(sel));     // 🎯 Мортира — фрегат/линкор
  $('#btnRepair').classList.toggle('hidden', !st.repairer);      // 🛟 Чинить
  $('#btnBroadside').classList.toggle('hidden', !canBroadside(sel)); // 💥 Залп
  $('#btnCollectHere').classList.toggle('hidden', !canShipCollect(sel));
  // ⛺ построить/прокачать аванпост на залутанном острове рядом (цена след. уровня на кнопке)
  const opIdx = outpostIslandAt(sel);
  const opBtn = $('#btnOutpost');
  opBtn.classList.toggle('hidden', opIdx < 0);
  if (opIdx >= 0) {
    const isl = state.map.lootIslands[opIdx];
    const def = (state.outposts?.levels || [])[isl.outpost?.level || 0];
    const gold = state.players[myIdx()]?.gold ?? 0;
    opBtn.textContent = `${def.icon} ${def.name} (${def.price})`;
    opBtn.dataset.island = opIdx;
    opBtn.disabled = gold < def.price;
  }
  $('#btnRecharge').classList.toggle('hidden', !canShipRecharge(sel)); // 🔧 Пополнить (у базы)
  $('#rechargeNote').classList.toggle('hidden', !noCharges);     // заметка «нет материалов — на базу»
  if (isRT()) {
    // ⛈️ шторм: всё разрешено всегда, орудия — по перезарядке; кнопки показывают отсчёт в секундах
    const bs = Math.min(cdLeft(sel, 'p'), cdLeft(sel, 's')); // хоть один борт готов?
    const mCd = cdLeft(sel, 'm'), rCd = cdLeft(sel, 'r');
    $('#btnMove').disabled = false;
    $('#btnFire').disabled = mCd > 0;
    $('#btnFire').textContent = mCd > 0 ? `🎯 ${Math.ceil(mCd / 1000)}с…` : '🎯 Мортира';
    $('#btnBroadside').disabled = bs > 0;
    $('#btnBroadside').textContent = bs > 0 ? `💥 ${Math.ceil(bs / 1000)}с…` : '💥 Залп';
    $('#btnRepair').disabled = rCd > 0 || noCharges;
    $('#btnRepair').textContent = rCd > 0 ? `🛟 ${Math.ceil(rCd / 1000)}с…` : '🛟 Чинить';
    $('#btnCollectHere').disabled = false;
    $('#btnRecharge').disabled = false;
    return;
  }
  $('#btnFire').textContent = '🎯 Мортира';                      // вернуть подписи после шторма
  $('#btnBroadside').textContent = '💥 Залп';
  $('#btnRepair').textContent = '🛟 Чинить';
  const fired = firedSides(sel.id), committed = fired.length > 0;
  $('#btnMove').disabled = committed;
  $('#btnFire').disabled = committed;
  $('#btnRepair').disabled = committed || noCharges;             // чинить нечем без материалов
  $('#btnCollectHere').disabled = committed;
  if (committed) $('#btnOutpost').disabled = true;               // начал залп — строить уже нельзя
  $('#btnRecharge').disabled = committed;
  $('#btnBroadside').disabled = fired.length >= 2;               // оба борта отстреляны
}
// ⛈️ шторм: отсчёт перезарядок на кнопках выбранного корабля тикает раз в полсекунды
setInterval(() => { if (isRT() && selectedShipId) updateActionButtons(); }, 500);

// ═══════════ 🎛 ШТУРВАЛ — радиальное командное кольцо у корабля (вместо панели действий) ═══════════
// Управление там, где взгляд: тап по своему кораблю раскрывает кольцо иконок ВОКРУГ него — не надо
// тянуться к краю экрана, поле ничем не закрыто. Борта 💥 сидят АНАТОМИЧЕСКИ на бортах корпуса
// (вращаются с курсом — «жми на борт, который стреляет»), перезарядка — дугой прямо на иконке,
// контекстные действия (🏝 клад, ⛺ аванпост, 🔧 порох) появляются только когда реально доступны.
// Реестр собирается в wheelActions() — новое действие = одна запись, кольцо раскладывает само.
// Быстрый откат на старую нижнюю панель: WHEEL_UI = false.
const WHEEL_UI = true;
let wheelBornAt = 0;                              // момент раскрытия — для анимации
const wheelR = () => (IS_COARSE ? 84 : 66);       // радиус кольца, ЭКРАННЫЕ px (не зависит от зума)
const wheelIconR = () => (IS_COARSE ? 24 : 18);

// Реестр действий выбранного корабля (доступность = та же логика, что у старых кнопок)
function wheelActions(sel) {
  const st = ST(sel.type);
  const rt = isRT();
  const fired = firedSides(sel.id);
  const committed = !rt && fired.length > 0;      // начал залп → прочие действия хода закрыты
  const noCharges = st.repairer && (sel.repairCharges ?? repairChargesMax()) <= 0;
  const acts = [];
  // «плыть» — БЕЗ иконки: движение единым жестом на всех платформах (потяни от корабля — шлейф курса)
  // Боевые иконки видны ВСЕГДА (сканов целей нет — они дёргали кадры и прятали кнопки в бою):
  // залп — ОДНА иконка, борт выбирается наведением уже в режиме прицела.
  if (canBroadside(sel)) {
    const cd = rt ? Math.min(cdLeft(sel, 'p'), cdLeft(sel, 's')) : 0; // готов хотя бы один борт
    const bothUsed = !rt && fired.length >= 2;
    acts.push({
      key: 'broadside', icon: '💥', label: 'залп',
      cdMs: cd, cdMax: state.rt?.cds?.broadside || 1,
      off: bothUsed || cd > 0, offMsg: bothUsed ? '💥 Оба борта уже стреляли в этом ходу' : null,
      go: () => { mode = 'broadside'; render(); }
    });
  }
  if (canMortar(sel)) acts.push({
    key: 'mortar', icon: '🎯', label: 'мортира',
    cdMs: rt ? cdLeft(sel, 'm') : 0, cdMax: state.rt?.cds?.mortar || 1, off: committed || (rt && cdLeft(sel, 'm') > 0),
    offMsg: committed ? '💥 Корабль даёт залп — мортира в этом ходу закрыта' : null,
    go: () => { mode = 'attack'; render(); }
  });
  if (st.repairer) acts.push({
    key: 'repair', icon: '🛟', label: noCharges ? 'нет материалов' : 'чинить',
    cdMs: rt ? cdLeft(sel, 'r') : 0, cdMax: state.rt?.cds?.repair || 1,
    off: committed || noCharges || (rt && cdLeft(sel, 'r') > 0),
    offMsg: noCharges ? '🔧 Материалы кончились — пополни у своей базы' : null,
    go: () => { mode = 'repair'; render(); }
  });
  if (canShipCollect(sel)) acts.push({ key: 'collect', icon: '💰', label: 'собрать', off: committed,
    go: () => sendAction({ type: 'collect' }) });
  const opIdx = outpostIslandAt(sel);
  if (opIdx >= 0) {
    const isl = state.map.lootIslands[opIdx];
    const def = (state.outposts?.levels || [])[isl.outpost?.level || 0];
    const gold = state.players[myIdx()]?.gold ?? 0;
    acts.push({ key: 'outpost', icon: def.icon, label: `${def.name} · ${def.price}`,
      off: committed || gold < def.price, offMsg: gold < def.price ? `Не хватает золота (нужно ${def.price})` : null,
      go: () => sendAction({ type: 'outpost', shipId: sel.id, islandId: opIdx }) });
  }
  if (canShipRecharge(sel)) acts.push({ key: 'recharge', icon: '🔧', label: 'порох', off: committed,
    go: () => sendAction({ type: 'recharge', shipId: sel.id }) });
  return acts;
}

// Раскладка: иконки ВЕЕРОМ В ВЕРХНЕЙ ЧАСТИ кольца, НЕ зависят от курса корабля — кнопки не
// «уплывают» при развороте, в них легко попадать в бою. Всегда в кадре: у края экрана слот
// смещается по кольцу (зазор между иконками ослабляется ступенями, но иконка в кадре обязана быть).
function wheelLayout(sel) {
  const pos = animPos.get(sel.id) || (state.rt && rtPos.get(sel.id)) || sel;
  const cx = sx(pos.x), cy = sy(pos.y);
  const R = wheelR(), Ic = wheelIconR();
  const acts = wheelActions(sel);
  const placed = [];
  const bw = canvas.clientWidth, bh = canvas.clientHeight;
  const clampAng = a0 => {
    for (const sep of [0.85, 0.6, 0.4, 0.22]) {
      for (let k = 0; k <= 20; k++) for (const sgn of [1, -1]) {
        const a = a0 + sgn * k * 0.26;
        const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
        const m = Ic + 12;
        if (x > m && x < bw - m && y > m && y < bh - m &&
            !placed.some(p => Math.abs(angNorm(p.ang - a)) < sep)) return a;
      }
    }
    return a0;
  };
  // верхняя дуга: центр, потом симметрично в стороны (экранные углы: -90° = вверх)
  const slots = [-Math.PI / 2, -Math.PI / 2 - 0.72, -Math.PI / 2 + 0.72, -Math.PI / 2 - 1.44, -Math.PI / 2 + 1.44, Math.PI / 2];
  let si = 0;
  for (const a of acts) placed.push({ act: a, ang: clampAng(slots[si++ % slots.length]) });
  return { cx, cy, R, Ic, icons: placed.map(p => ({ ...p, x: cx + Math.cos(p.ang) * R, y: cy + Math.sin(p.ang) * R })) };
}

// иконка кольца под экранной точкой (px, py — экранные координаты тапа)
function wheelHit(sel, px, py) {
  const L = wheelLayout(sel);
  const w = L.icons.find(i => Math.hypot(px - i.x, py - i.y) <= L.Ic + 8);
  return w ? { ...w.act } : null;
}

// какому режиму соответствует иконка — для подсветки активного
const WHEEL_MODE = { move: 'move', broadside: 'broadside', mortar: 'attack', repair: 'repair' };

function drawCommandWheel() {
  if (!WHEEL_UI || !selectedShipId || !state) return;
  if (mode !== 'idle') return;                     // выбрал борт/мортиру/ремонт → кольцо прячется, не мешает прицелу
  const sel = state.ships.find(s => s.id === selectedShipId);
  if (!sel || sel.owner !== myIdx() || !isMyTurn()) return;
  if (aim && aim.armed) return;                    // ведём шлейф хода — кольцо не мешает
  const k = Math.min(1, (performance.now() - wheelBornAt) / 130);
  const L = wheelLayout(sel);
  const R = L.R * (0.7 + 0.3 * k);
  ctx.save();
  ctx.globalAlpha = k;
  // само кольцо НЕ рисуем — вокруг корабля и так круги хода/стрельбы, пунктир перегружал область
  for (const w of L.icons) {
    const wx = L.cx + Math.cos(w.ang) * R, wy = L.cy + Math.sin(w.ang) * R;
    const hot = WHEEL_MODE[w.act.key] === mode && mode !== 'idle';
    ctx.beginPath(); ctx.arc(wx, wy, L.Ic, 0, Math.PI * 2);
    ctx.fillStyle = hot ? '#fff3c6' : w.act.off ? 'rgba(235,232,222,.92)' : 'rgba(253,251,243,.95)';
    ctx.fill();
    ctx.strokeStyle = hot ? '#8a7a45' : '#2b3a55'; ctx.lineWidth = hot ? 2.4 : 1.5; ctx.stroke();
    if (w.act.cdMs > 0) {                          // «пузо» перезарядки на кнопке
      const frac = 1 - w.act.cdMs / w.act.cdMax;
      ctx.beginPath(); ctx.moveTo(wx, wy);
      ctx.arc(wx, wy, L.Ic - 2, -Math.PI / 2, -Math.PI / 2 + Math.max(0.05, frac) * Math.PI * 2);
      ctx.closePath(); ctx.fillStyle = 'rgba(46,125,91,.22)'; ctx.fill();
    }
    ctx.font = `${Math.round(L.Ic * 1.05)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.globalAlpha = w.act.off ? k * 0.45 : k;
    ctx.fillText(w.act.icon, wx, wy + 1);
    ctx.globalAlpha = k;
    // подпись — радиально снаружи (или секунды перезарядки)
    ctx.font = 'bold 11px Neucha, cursive'; ctx.fillStyle = 'rgba(43,58,85,.8)';
    const lx = wx + Math.cos(w.ang) * (L.Ic + 12), ly = wy + Math.sin(w.ang) * (L.Ic + 12) + 4;
    ctx.fillText(w.act.cdMs > 0 ? `${Math.ceil(w.act.cdMs / 1000)}с` : w.act.label, lx, ly);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();
  // раскрытие: в пошаговом режиме нет anim-цикла — догоним анимацию парой кадров
  if (k < 1 && !state.rt) requestAnimationFrame(() => render());
}

// ─── Прицел бортового залпа ───
const angNorm = a => Math.atan2(Math.sin(a), Math.cos(a));
function broadsideDirs(sel) {
  const h = currentHeading(sel);
  return { port: angNorm(h - Math.PI / 2), starboard: angNorm(h + Math.PI / 2) };
}
// куда целится мышь (hoverPt) → ближний борт (или null, если нет наведения)
function broadsideAimedSide(sel) {
  if (!hoverPt) return null;
  const a = Math.atan2(hoverPt.y - sel.y, hoverPt.x - sel.x);
  const d = broadsideDirs(sel);
  return Math.abs(angNorm(a - d.port)) <= Math.abs(angNorm(a - d.starboard)) ? 'port' : 'starboard';
}
// сектор-трапеция борта (заливка) — под кораблями
function drawBroadsideSectors(sel) {
  const dirs = broadsideDirs(sel), r = ST(sel.type).fireRange * view.scale, ha = broadsideHalfArc();
  const fired = firedSides(sel.id), aimed = broadsideAimedSide(sel);
  const X = sx(sel.x), Y = sy(sel.y);
  for (const name of ['port', 'starboard']) {
    if (fired.includes(name)) continue;            // этот борт уже отстрелял
    const dir = dirs[name], isAim = aimed === name;
    ctx.beginPath(); ctx.moveTo(X, Y); ctx.arc(X, Y, r, dir - ha, dir + ha); ctx.closePath();
    ctx.fillStyle = isAim ? 'rgba(192,57,43,0.20)' : 'rgba(110,116,124,0.13)'; ctx.fill();
    ctx.strokeStyle = isAim ? 'rgba(192,57,43,0.85)' : 'rgba(110,116,124,0.55)';
    ctx.lineWidth = 1.6; ctx.setLineDash([4, 3]); ctx.stroke(); ctx.setLineDash([]);
  }
}
// красные кольца на вражеских судах в наводимом секторе — поверх кораблей
function drawBroadsideTargets(sel) {
  const aimed = broadsideAimedSide(sel);
  if (!aimed) return;
  const dir = broadsideDirs(sel)[aimed], r = ST(sel.type).fireRange, ha = broadsideHalfArc();
  for (const s of state.ships) {
    if (s.owner === sel.owner) continue;
    if (s.owner >= 0 && state.players[s.owner] && !state.players[s.owner].alive) continue;
    if (dist(sel.x, sel.y, s.x, s.y) > r) continue;
    if (Math.abs(angNorm(Math.atan2(s.y - sel.y, s.x - sel.x) - dir)) > ha) continue;
    dashedCircle(s.x, s.y, 22, '#c0392b', 2);
  }
}

$('#btnMove').addEventListener('click', () => {
  mode = 'move'; Sound.play('click');
  startMoveDemo();   // на сенсоре до первого хода — показать демо-жест (потом не докучаем)
  render();
});
$('#btnFire').addEventListener('click', () => { mode = 'attack'; Sound.play('click'); render(); });   // 🎯 Мортира
$('#btnRepair').addEventListener('click', () => { mode = 'repair'; Sound.play('click'); render(); });
$('#btnBroadside').addEventListener('click', () => { mode = 'broadside'; Sound.play('click'); render(); }); // 💥 Залп — режим наведения
$('#btnCancel').addEventListener('click', deselect);

// звук и сворачивание панели
Sound.armAutostart();
// выстрел пушки — общий сэмпл: предзагружаем, чтобы первый выстрел не был немым
Sound.loadSample('cannon', '/sounds/cannon_fire.wav').catch(() => {});
// рамка «твой ход» гаснет, как только игрок очнулся: повёл мышью/пальцем, тапнул или нажал клавишу
// (renderSidebar поднимет её снова на старте следующего моего хода — см. turnFrameShownFor)
let turnFrameShownFor = null;
['pointerdown', 'pointermove', 'keydown', 'wheel'].forEach(ev =>
  window.addEventListener(ev, () => $('#turnFrame')?.classList.remove('on'), { passive: true }));
$('#muteBtn').textContent = Sound.muted ? '🔇' : '🔊';
$('#muteBtn').addEventListener('click', () => {
  $('#muteBtn').textContent = Sound.toggleMute() ? '🔇' : '🔊';
});
// инфобаза (вики + тумблер обучения)
function openInfo() {
  // таблица флота из актуальных характеристик
  if (state?.shipTypes) {
    $('#infoFleet').innerHTML = Object.entries(state.shipTypes)
      .filter(([, st]) => !st.npc && !st.cheat)
      .map(([type, st]) => {
        const cannons = state.broadside?.cannons?.[type];
        const isMortar = (state.broadside?.mortarShips || []).includes(type);
        const mm = state.broadside?.mortarShipMult ?? 0.5;
        const extra = [
          isMortar ? `🎯 мортира ${Math.round(st.dmg * mm)}, порт ${Math.round(st.dmg * (st.portBonus || 1))}` : '',
          st.fishing ? `🐟 +${st.fishing}` : '',
          st.healFrac ? `🛟 +${Math.round(st.healFrac * 100)}% HP` : '',
          st.repairer ? `🔧 ${repairChargesMax()} ремонтов` : ''
        ].filter(Boolean).join(' · ');
        const power = st.repairer ? '🛟 ремонт' : (cannons ? `💥 залп до ${st.dmg}` : `⚔️${st.dmg}`);
        return `<div class="info-fleet-row">
          <span class="nm">${st.icon} ${st.name}</span>
          <span class="st">${st.price}з · ❤️${st.hp} · ${power} · 🎯${(st.fireRange / 40).toFixed(1)} · 🧭${(st.move / 40).toFixed(1)}${extra ? ' · ' + extra : ''}</span>
        </div>`;
      }).join('');
  }
  // карточка «Ход» — вариант под режим партии (одно действие / ход тремя судами)
  $('#wikiTurnSingle')?.classList.toggle('hidden', multiMoveOn());
  $('#wikiTurnMulti')?.classList.toggle('hidden', !multiMoveOn());
  $('#tutToggle').checked = localStorage.getItem('sb_tut_done') !== '1';
  // если подсказки в этом матче уже показывали — переключатель блокируем (повтор запрещён, анти-грифинг),
  // тултипом объясняем и отсылаем к инфобазе ниже
  const seenThisMatch = !!(state && localStorage.getItem('sb_tut_seen:' + state.id));
  $('#tutToggle').disabled = seenThisMatch;
  $('#tutToggleLabel').classList.toggle('disabled', seenThisMatch);
  $('#tutToggleLabel').title = seenThisMatch
    ? 'Подсказки в этом матче уже показаны — заново не включить. Вся нужная информация — в инфобазе ниже 👇'
    : '';
  $('#infoOverlay').classList.remove('hidden');
}
$('#infoBtn').addEventListener('click', openInfo);
$('#infoClose').addEventListener('click', () => $('#infoOverlay').classList.add('hidden'));
$('#tutToggle').addEventListener('change', e => {
  // вкл — обучение покажется в начале следующей игры; выкл — больше не показываем
  if (e.target.checked) { localStorage.removeItem('sb_tut_done'); localStorage.removeItem('sb_moved'); }
  else localStorage.setItem('sb_tut_done', '1');
});
$('#panelToggle').addEventListener('click', () => {
  const collapsed = $('#panel').classList.toggle('collapsed');
  $('#panelToggle').textContent = collapsed ? '☰' : '✕';
  resize(); // карта занимает область над свёрнутой панелью
});
// 🏠 на главную из активного баттла — это НЕ форфейт: игра живёт на сервере,
// вернуться можно через «Мои игры». (disconnect на сервере — no-op, флот не тонет.)
$('#homeBtn')?.addEventListener('click', () => { location.href = '/'; });
// на телефоне меню по умолчанию свёрнуто — карта на весь экран над панелью
if (window.matchMedia('(max-width: 900px)').matches) {
  $('#panel').classList.add('collapsed');
}

$('#btnCollectHere').addEventListener('click', () => sendAction({ type: 'collect' }));
// ⛺ построить/прокачать аванпост на острове рядом (индекс острова кладёт updateActionButtons)
$('#btnOutpost').addEventListener('click', () =>
  sendAction({ type: 'outpost', shipId: selectedShipId, islandId: +$('#btnOutpost').dataset.island }));
$('#btnRecharge').addEventListener('click', () => sendAction({ type: 'recharge', shipId: selectedShipId })); // 🔧 пополнить материалы у базы
$('#btnSkip').addEventListener('click', () => sendAction({ type: 'skip' }));
// ⏸ пауза реалтайма: кнопка в шапке и «Продолжить» на оверлее шлют один и тот же тумблер
$('#pauseBtn')?.addEventListener('click', () => sendAction({ type: 'rtPause' }));
$('#pauseResumeBtn')?.addEventListener('click', () => sendAction({ type: 'rtPause' }));
$('#btnShop').addEventListener('click', () => {
  basket = {};
  renderShop();
  $('#shopOverlay').classList.remove('hidden');
  Sound.play('click');
});
$('#shopClose').addEventListener('click', () => $('#shopOverlay').classList.add('hidden'));
$('#btnNudge').addEventListener('click', () => {
  socket.emit('nudge', res => {
    if (!res.ok) toast(res.error);
    else toast(res.emailSent ? '📯 Письмо отправлено, у игрока 10 минут' : '📯 У игрока 10 минут на ход');
  });
});
$('#btnSurrender').addEventListener('click', () => {
  const q = state?.config?.hotseat
    ? `${state.players[state.turn.idx]?.nick} спускает флаг? Флот утонет, игрок выбывает.`
    : 'Точно спустить флаг? Твой флот утонет, а ты выбываешь из баттла.';
  if (!confirm(q)) return;
  socket.emit('leave', res => { if (!res.ok) toast(res.error); });
});
$('#leaveLobbyBtn').addEventListener('click', () => {
  socket.emit('leave', res => {
    if (!res.ok) toast(res.error);
    else location.href = '/';
  });
});
// свернуть лобби: уходим на главную, лобби продолжает ждать — можно вернуться (через «найти игру») как хост
$('#lobbyMinimize')?.addEventListener('click', () => { location.href = '/'; });
// хост закрыл лобби (вышел совсем) — всех участников на главную
socket.on('lobbyClosed', () => { location.href = '/'; });
$('#btnBuy').addEventListener('click', () => {
  const ships = Object.entries(basket).flatMap(([t, n]) => Array(n).fill(t));
  if (!ships.length) { toast('Корзина пуста — добавь корабли «+»'); return; }
  // дуэль, фаза закупки — это стартовый сбор флота (buyFleet), иначе обычная докупка (buy)
  sendAction({ type: state.phase === 'buy' ? 'buyFleet' : 'buy', ships });
});

// ============ САЙДБАР ============
let lastLogSig = null; // подпись журнала: перерисовка только на новые записи (см. ниже)
function renderSidebar() {
  const me = state.players[myIdx()];
  const current = state.players[state.turn.idx];

  // баннер хода (в режиме «ход тремя судами» — счётчик оставшихся ходов кораблями)
  const banner = $('#turnBanner');
  const showMoves = multiMoveOn() && state.status === 'active' && (isMyTurn() || state.config?.hotseat);
  const movesTag = showMoves ? ` ⚓${movesLeft()}/${movesPerTurn()}` : '';
  if (state.status === 'lobby') banner.textContent = '⏳ Сбор флота…';
  else if (state.phase === 'buy') banner.textContent = me?.ready ? '⏳ Ждём, пока соперник соберёт флот…' : '🛒 Собери флот — на всё золото!';
  else if (state.status === 'finished') banner.textContent = '🏁 Баттл окончен';
  else if (state.rt) banner.textContent = '⚡ Полный вперёд — реалтайм, жми и плыви!'; // ходов нет — только море и перезарядки
  else if (state.config?.hotseat) banner.textContent = `✏️ Ходит: ${current?.nick} (№${state.turn.number})${movesTag}`;
  else if (isMyTurn()) banner.textContent = `🔥 Твой ход!${movesTag}`;
  else banner.textContent = `Ход: ${current?.nick ?? '…'} (№${state.turn.number})`;
  banner.classList.toggle('my-turn', isMyTurn() && !state.config?.hotseat && !state.rt);
  // красная рамка «твой ход»: поднимаем на старте КАЖДОГО моего хода; гаснет, когда игрок «очнулся»
  // (повёл мышью / тапнул / нажал клавишу — слушатели в инициализации). В хотсите/шторме не нужна.
  {
    const fr = $('#turnFrame'), mine = isMyTurn() && !state.config?.hotseat && !state.rt;
    if (!mine) { turnFrameShownFor = null; fr?.classList.remove('on'); }
    else {
      const key = state.turn.number + ':' + state.turn.idx;       // новый «мой ход» → снова показать
      if (key !== turnFrameShownFor) { turnFrameShownFor = key; fr?.classList.add('on'); }
    }
  }

  // приватность: чьи цифры (золото/HP порта) видно
  // онлайн/боты — только свои; хотсит — только у того, чей ход; в конце — все
  const canSee = i => state.status === 'finished' || DEBUG_ON ||
    (state.config?.hotseat ? i === state.turn.idx : state.players[i].id === myId);

  // игроки
  $('#playersList').innerHTML = state.players.map((p, i) => {
    const show = state.status !== 'lobby' && canSee(i);
    const stats = show ? `💰${p.gold} · 🏠${p.portHp}` : '';
    // под туманом статус врага — на момент последней разведки (не крестим вслепую)
    const aliveShown = (fogActive() && i !== myIdx()) ? (fogLastSeen[i]?.alive ?? true) : p.alive;
    return `<div class="player-row ${aliveShown ? '' : 'dead'} ${state.status === 'active' && i === state.turn.idx ? 'current' : ''}">
      <span class="dot" style="background:${p.color}"></span>
      <span>${p.isBot ? '🤖 ' : ''}${escapeHtml(p.nick)}${p.id === myId ? ' (ты)' : ''}</span>
      <span class="gold">${stats}</span>
    </div>`;
  }).join('');

  // мои действия
  const showActions = !spectator && state.status === 'active' && me?.alive;
  $('#actionsRow').classList.toggle('hidden', !showActions);
  $('#btnSurrender').classList.toggle('hidden', !showActions);
  $('#chatBtn').classList.toggle('hidden', !canUseChat()); // кнопка чата (видна в тестовом режиме)
  if (showActions) {
    $('#btnShop').disabled = !isMyTurn();
    // в многоходовом режиме «Пропустить» превращается в «Завершить ход» (когда уже что-то сходило)
    const finishing = multiMoveOn() && movesUsed() > 0;
    const btnSkip = $('#btnSkip');
    btnSkip.classList.toggle('hidden', !!state.rt);   // ⛈️ шторм: ходов нет — нечего пропускать
    btnSkip.disabled = !isMyTurn();
    btnSkip.textContent = finishing ? '✅ Завершить ход' : '⏭ Пропустить';
    btnSkip.classList.toggle('primary', finishing && isMyTurn());
    $('#btnNudge').classList.toggle('hidden',
      !!state.rt || isMyTurn() || state.turn.nudged || !!state.players[state.turn.idx]?.isBot);
    $('#hint').textContent = state.rt
      ? '⚡ Полный вперёд (бета): без ходов! Корабли плывут к точке сами (кликай куда угодно), залп и мортира стреляют по перезарядке.'
      : isMyTurn()
        ? (multiMoveOn()
            ? `Ход тремя судами: до ${movesPerTurn()} действий за ход — двигай и стреляй разными кораблями, собирай добычу, покупай (осталось ${movesLeft()}). Закончил раньше — «Завершить ход».`
            : 'Одно действие за ход: купить, собрать, передвинуть один корабль или выстрелить.')
        : `Ждём ход игрока ${current?.nick}…`;
    if (!$('#shopOverlay').classList.contains('hidden')) renderShop();
  } else {
    $('#shopOverlay').classList.add('hidden');
  }

  // журнал: новые сообщения сверху (массив log — старые→новые, разворачиваем).
  // innerHTML переписывается целиком → скролл сам встаёт наверх, к самым свежим.
  // ⚡ реалтайм: перерисовываем ТОЛЬКО на новые записи — иначе тик 4 раза/сек сбрасывал скролл читающему
  const logSig = state.id + ':' + state.log.length + ':' + (state.log[state.log.length - 1]?.t || 0);
  if (logSig !== lastLogSig) {
    lastLogSig = logSig;
    $('#log').innerHTML = [...state.log].reverse().map(l =>
      `<div class="${l.type}">${escapeHtml(l.text)}</div>`).join('');
    $('#log').scrollTop = 0;
  }

  // высота свёрнутой панели могла измениться (баннер хода, кнопки) — подвинуть карту
  if ($('#mapWrap').style.bottom !== desiredMapBottom()) resize();
}

// ⚡ Реалтайм шлёт стейт ~4 раза/сек, и renderShop дёргался на каждый тик: кнопки «+/−»
// пересоздавались ПОД КУРСОРОМ (hover слетал, клики проглатывались). Пересобираем DOM верфи
// ТОЛЬКО когда изменились её данные (золото/корзина/фаза/очередь хода) — подпись ниже.
let shopSig = null;
function renderShop() {
  const me = state.players[myIdx()];
  if (!me) return;
  const sig = JSON.stringify([state.id, me.gold, basket, state.phase, state.duel, isMyTurn()]);
  if (sig === shopSig) return; // данные не менялись — не трогаем кнопки под пальцем/курсором
  shopSig = sig;
  // в фазе стартовой закупки дуэли — показываем правила вместо обычной подписи
  $('#duelRules')?.classList.toggle('hidden', state.phase !== 'buy');
  $('#shopDesc')?.classList.toggle('hidden', state.phase === 'buy');
  const total = Object.entries(basket).reduce((s, [t, n]) => s + ST(t).price * n, 0);
  $('#shopGold').textContent = `💰 ${me.gold}`;
  $('#shopList').innerHTML = Object.entries(state.shipTypes).filter(([, st]) => !st.npc && !st.cheat && (!state.duel || !st.fishing)).map(([t, st]) => {
    const cantAddMore = total + st.price > me.gold;
    return `
    <div class="ship-card ${cantAddMore && !basket[t] ? 'unaffordable' : ''}" title="${st.desc}">
      <div class="head"><span>${st.icon}</span><span class="nm">${st.name}</span><span class="price">${st.price} зол.</span></div>
      <div class="stats">
        <span title="Прочность">❤️ ${st.hp}</span>
        ${st.repairer
          ? `<span title="Ремонт союзника за действие: доля его макс. HP">🛟 +${Math.round(st.healFrac * 100)}% HP</span>`
          : `<span title="Урон за выстрел">⚔️ ${st.dmg}</span>`}
        <span title="${st.repairer ? 'Радиус ремонта' : 'Дальность стрельбы'}">🎯 ${(st.fireRange / 40).toFixed(1)} кл.</span>
        <span title="Дальность хода">🧭 ${(st.move / 40).toFixed(1)} кл.</span>
        ${st.fishing ? `<span title="Доход за каждый ход в рыбном месте">🐟 +${st.fishing}/ход</span>` : ''}
        ${st.portBonus ? `<span title="Урон по порту ×${st.portBonus}">🏰 ×${st.portBonus}</span>` : ''}
      </div>
      <div class="qty">
        <button class="small" data-shop="${t}" data-d="-1" ${!basket[t] ? 'disabled' : ''}>−</button>
        <span class="cnt">${basket[t] || 0}</span>
        <button class="small" data-shop="${t}" data-d="1" ${cantAddMore ? 'disabled' : ''}>+</button>
      </div>
    </div>`;
  }).join('');
  if (state.phase === 'buy') {            // ДУЭЛЬ: стартовая закупка — «скупись на всё», кнопка «В бой!»
    const remaining = me.gold - total;
    const fullSpent = total > 0 && total <= me.gold && remaining < state.minShipPrice;
    $('#shopTotal').textContent = total
      ? (fullSpent ? `Флот на ${total} зол. — в бой!` : `Осталось ${remaining} зол. — скупись на всё (мин. корабль ${state.minShipPrice})`)
      : `Собери флот на все ${me.gold} зол.`;
    $('#shopTotal').style.color = total > me.gold ? '#c0392b' : '';
    $('#btnBuy').disabled = !fullSpent;
    $('#btnBuy').textContent = '⚔️ В бой!';
  } else {
    $('#shopTotal').textContent = total ? `Итого: ${total} из ${me.gold} зол.` : 'Выбери корабли кнопкой «+»';
    $('#shopTotal').style.color = total > me.gold ? '#c0392b' : '';
    $('#btnBuy').disabled = !total || total > me.gold || !isMyTurn();
    $('#btnBuy').textContent = total ? `Купить за ${total} зол.` : 'Купить';
  }
  document.querySelectorAll('[data-shop]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.shop;
    basket[t] = Math.max(0, (basket[t] || 0) + (+b.dataset.d));
    if (!basket[t]) delete basket[t];
    renderShop();
  }));
}

// ============ ОВЕРЛЕИ ============
function renderOverlays() {
  // ДУЭЛЬ: стартовая закупка флота — авто-открытая верфь (закрыть нельзя, пока не собрал), затем бой
  const buyPhase = state.status === 'active' && state.phase === 'buy';
  const meBuy = state.players[myIdx()];
  const buying = buyPhase && meBuy && !meBuy.ready && myIdx() >= 0 && !spectator;
  $('#shopClose').classList.toggle('hidden', buying);
  if (buying) {
    if ($('#shopOverlay').classList.contains('hidden')) basket = {};
    $('#shopOverlay').classList.remove('hidden');
    renderShop();
  } else if (buyPhase) {
    $('#shopOverlay').classList.add('hidden'); // флот собран — ждём соперника (баннер в сайдбаре)
  }

  // лобби
  const inLobby = state.status === 'lobby';
  $('#lobbyOverlay').classList.toggle('hidden', !inLobby || $('#nickOverlay').classList.contains('hidden') === false);
  if (inLobby) {
    const cfg = state.config;
    const lobParts = [
      state.modeName || 'Классический',
      `${cfg.maxPlayers} игрока`,
      cfg.turnTimer ? `таймер ${cfg.turnTimer} сек/ход` : 'без таймера'
    ];
    if (!state.duel) {                                  // в дуэли правила фиксированы — туман/ход тремя судами не показываем
      lobParts.push(cfg.fog ? 'туман войны' : 'без тумана');
      lobParts.push(cfg.multiMove ? 'ход тремя судами' : 'по одному действию');
    }
    $('#lobbyConfig').textContent = lobParts.join(' · ');
    // показываем текущий ник (не перетираем, пока игрок печатает)
    const me = state.players.find(p => p.id === myId);
    if (me?.nick && document.activeElement !== $('#lobbyNick')) $('#lobbyNick').value = me.nick;
    // выбор цвета: занятые другими — приглушены; клик шлёт setColor
    if (me && state.palette) {
      const taken = new Set(state.players.filter(p => p.id !== myId).map(p => p.color));
      renderColorDropdown($('#lobbyColors'), state.palette, me.color,
        c => socket.emit('setColor', { color: c }, r => { if (!r.ok) $('#lobbyError').textContent = r.error; }),
        taken);
    } else { $('#lobbyColors').innerHTML = ''; }
    $('#inviteUrl').textContent = location.href;
    const isCreator = (state.hostPid || state.players[0]?.id) === myId;
    $('#lobbySlots').innerHTML = Array.from({ length: cfg.maxPlayers }, (_, i) => {
      const p = state.players[i];
      if (!p) return `<div class="slot">пусто…</div>`;
      const dot = `<span class="dot" style="background:${p.color}"></span>`;
      if (p.isBot) {
        const rm = isCreator ? `<button class="small slot-x" data-rmbot="${p.id}" title="Убрать бота">✖</button>` : '';
        return `<div class="slot filled">${dot}🤖 ${escapeHtml(p.nick)}${rm}</div>`;
      }
      return `<div class="slot filled">${dot}${escapeHtml(p.nick)}${p.id === myId ? ' (ты)' : ''}</div>`;
    }).join('');
    // управление ботами (только создатель): боты ≤ половины слотов
    const botCount = state.players.filter(p => p.isBot).length;
    const botLimit = Math.floor(cfg.maxPlayers / 2);
    const canAddBot = isCreator && botCount < botLimit && state.players.length < cfg.maxPlayers;
    $('#lobbyBots').classList.toggle('hidden', !isCreator || state.duel); // в дуэли ботов не добавляют (1 на 1)
    $('#addBotBtn').disabled = !canAddBot;
    $('#botHint').textContent = `боты: ${botCount}/${botLimit}` + (botCount >= botLimit ? ' (лимит)' : '');
    const humans = state.players.filter(p => !p.isBot).length;
    const canStart = isCreator && humans >= 2;
    $('#startBtn').classList.toggle('hidden', !isCreator);
    $('#startBtn').disabled = !canStart;
    $('#lobbyWait').textContent = isCreator
      ? (humans < 2 ? 'Нужен ещё хотя бы один живой игрок (с ботами — это одиночный режим)'
        : state.players.length < state.config.maxPlayers ? `Можно ждать ещё ${state.config.maxPlayers - state.players.length} или начинать`
        : 'Все на борту!')
      : 'Ждём, пока создатель начнёт игру…';
  }

  // финал
  if (state.status === 'finished' && !finishShown) {
    finishShown = true;
    const winner = state.players[state.winner];
    $('#finishTitle').textContent = `👑 Победитель — ${winner?.nick}!`;
    const medals = ['🥇', '🥈', '🥉', '4.'];
    const sorted = [...state.players].sort((a, b) => (a.placement || 9) - (b.placement || 9));
    $('#finishTable').innerHTML = sorted.map(p => `
      <tr>
        <td class="medal">${medals[(p.placement || 4) - 1]}</td>
        <td><span class="dot" style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${p.color}"></span> ${escapeHtml(p.nick)}</td>
        <td>${p.stats.damageDealt}</td>
        <td>${p.stats.shipsSunk}</td>
        <td>${p.stats.shipsLost}</td>
        <td>${p.stats.goldCollected}</td>
      </tr>`).join('');
    $('#finishOverlay').classList.remove('hidden');
  }
}

$('#copyBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(location.href);
  $('#copyBtn').textContent = '✔';
  setTimeout(() => { $('#copyBtn').textContent = '📋'; }, 1500);
});
$('#startBtn').addEventListener('click', () => {
  socket.emit('start', res => { if (!res.ok) $('#lobbyError').textContent = res.error; });
});
// добавить бота в лобби
$('#addBotBtn').addEventListener('click', () => {
  socket.emit('addBot', { level: $('#botLevelSel').value }, res => {
    if (!res.ok) $('#lobbyError').textContent = res.error;
  });
});
// убрать бота (делегирование — кнопки ✖ перерисовываются)
$('#lobbySlots').addEventListener('click', e => {
  const b = e.target.closest('[data-rmbot]');
  if (b) socket.emit('removeBot', { botId: b.dataset.rmbot }, res => {
    if (!res.ok) $('#lobbyError').textContent = res.error;
  });
});
// смена своего ника прямо в лобби/игре — принимаем по уводу фокуса (blur) или Enter. Сервер обновит
// у игрока, запишет в БД и разошлёт всем. Шлём только если ник реально изменился (без лишних запросов).
let lastSentNick = null;
function saveLobbyNick() {
  const n = $('#lobbyNick').value.trim();
  if (!n) { $('#lobbyError').textContent = 'Ник не может быть пустым'; return; }
  const cur = state?.players?.find(p => p.id === myId)?.nick;
  if (n === cur || n === lastSentNick) return;   // ничего не поменялось — сервер не дёргаем
  lastSentNick = n;
  localStorage.setItem('sb_nick', n);
  if (me.loggedIn) me.nick = n;                  // синхронизируем локальное состояние аккаунта
  $('#lobbyError').textContent = '';
  socket.emit('setNick', { nick: n }, r => { if (!r.ok) { $('#lobbyError').textContent = r.error; lastSentNick = null; } });
}
$('#lobbyNickSave').addEventListener('click', saveLobbyNick);
$('#lobbyNick').addEventListener('blur', saveLobbyNick);                       // увёл фокус — приняли
$('#lobbyNick').addEventListener('keydown', e => { if (e.key === 'Enter') $('#lobbyNick').blur(); }); // Enter = снять фокус → blur сохранит
$('#finishClose').addEventListener('click', () => $('#finishOverlay').classList.add('hidden'));

// таймер хода
setInterval(() => {
  if (!state || state.status !== 'active' || !state.turn.deadline) {
    $('#timerRow').textContent = '';
    return;
  }
  const left = Math.max(0, Math.ceil((state.turn.deadline - Date.now()) / 1000));
  $('#timerRow').textContent = `⏱ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} до конца хода`;
}, 400);

// ============ ОБУЧЕНИЕ (подсказки на первой игре) ============
const Tutorial = (() => {
  let steps = [], idx = 0, active = false, repositionTimer = null;
  let panelForced = false;     // мобила: панель временно открыта нами ради шага про баланс
  const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
  const canvasRect = () => canvas.getBoundingClientRect();
  // свернуть/развернуть боковую панель (как кнопка ☰) — нужно на мобиле, где меню по умолчанию закрыто
  function setPanelCollapsed(collapsed) {
    const panel = $('#panel');
    if (!panel || panel.classList.contains('collapsed') === collapsed) return;
    panel.classList.toggle('collapsed', collapsed);
    $('#panelToggle').textContent = collapsed ? '☰' : '✕';
    resize();
  }
  // на телефоне цель внутри панели (баланс игроков) при свёрнутом меню не видна —
  // открываем панель на время такого шага и возвращаем как было на следующем/последнем.
  function syncPanel() {
    if (!isMobile()) return;
    const wantOpen = !!steps[idx]?.panel;
    if (wantOpen && !panelForced && $('#panel')?.classList.contains('collapsed')) {
      setPanelCollapsed(false); panelForced = true;
    } else if (!wantOpen && panelForced) {
      setPanelCollapsed(true); panelForced = false;
    }
  }
  // прямоугольник цели в координатах экрана: el — селектор DOM, либо canvas-точка {x,y,r}
  function targetRect(t) {
    if (!t) return null;
    if (t.sel) {
      const el = $(t.sel);
      if (!el || el.offsetParent === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left - 6, y: r.top - 6, w: r.width + 12, h: r.height + 12 };
    }
    if (t.world && state?.map) {
      const cr = canvasRect();
      const px = cr.left + sx(t.world.x), py = cr.top + sy(t.world.y);
      const rad = (t.world.r || 40) * view.scale + 16;
      // вне видимой области — не подсвечиваем
      if (px < cr.left - 40 || px > cr.right + 40 || py < cr.top - 40 || py > cr.bottom + 40) return null;
      return { x: px - rad, y: py - rad, w: rad * 2, h: rad * 2 };
    }
    return null;
  }

  function place() {
    if (!active) return;
    const step = steps[idx];
    const ring = $('#coachRing'), card = $('#coachCard');
    const rect = targetRect(step.target);
    if (rect) {
      ring.classList.remove('center');
      ring.style.left = rect.x + 'px';
      ring.style.top = rect.y + 'px';
      ring.style.width = rect.w + 'px';
      ring.style.height = rect.h + 'px';
    } else {
      ring.classList.add('center'); // нет видимой цели — просто затемняем
    }
    // карточку — рядом с целью (снизу/сверху), иначе по центру
    const cw = Math.min(320, window.innerWidth - 24), ch = card.offsetHeight || 120;
    let left, top;
    if (rect) {
      left = Math.min(Math.max(12, rect.x + rect.w / 2 - cw / 2), window.innerWidth - cw - 12);
      top = rect.y + rect.h + 14;
      if (top + ch > window.innerHeight - 12) top = Math.max(12, rect.y - ch - 14);
    } else {
      left = window.innerWidth / 2 - cw / 2;
      top = window.innerHeight / 2 - ch / 2;
    }
    card.style.left = left + 'px';
    card.style.top = top + 'px';
    card.style.maxWidth = cw + 'px';
    $('#coachText').innerHTML = step.text;
    $('#coachStep').textContent = `${idx + 1} / ${steps.length}`;
    $('#coachNext').textContent = idx === steps.length - 1 ? '⚓ В бой!' : 'Далее →';
  }

  function show() {
    syncPanel();   // мобила: открыть/закрыть панель под текущий шаг (баланс — внутри неё)
    // туториал-подсветка: ОДИН локальный кружок видимости вокруг цели (только reveal-шаги: рыба/клад/пират).
    // Остальная карта — под туманом, позиции врага не палятся.
    const st = steps[idx], w = st?.reveal && st.target?.world;
    tutReveal = w ? { x: w.x, y: w.y, r: Math.max((w.r || 40) + 90, 170) } : null;
    if (state) render();
    place();
  }
  function next() {
    if (idx >= steps.length - 1) return finish();
    idx++;
    show();
  }
  function finish() {
    active = false;
    clearInterval(repositionTimer);
    if (panelForced) { setPanelCollapsed(true); panelForced = false; } // вернуть панель свёрнутой (мобила)
    $('#coach').classList.add('hidden');
    tutReveal = null; if (state) render();          // убрать туториал-подсветку
    localStorage.setItem('sb_tut_done', '1');
  }

  function start() {
    if (active || localStorage.getItem('sb_tut_done')) return;
    // анти-грифинг: подсказки в одном матче показываем РАЗ. Иначе переключателем можно было бы
    // запускать их снова и «разведывать» туман через reveal-шаги. Ключ привязан к id матча.
    if (state && localStorage.getItem('sb_tut_seen:' + state.id)) return;
    const me = state.players[state.players.findIndex(p => p.id === myId)];
    const myBase = state.map.bases[myIdx()] || state.map.bases[0];
    const myShip = state.ships.find(s => s.owner === myIdx());
    const heavyShip = state.ships.find(s => s.owner === myIdx() && canBroadside(s)) || myShip;
    const enemyBase = state.map.bases.find((b, i) => i !== myIdx());
    // рыбное место и остров с кладом — БЛИЖАЙШИЕ к базе смотрящего (его «домашние», не подглядываем в чужие воды)
    const nearestTo = (arr) => (arr && arr.length)
      ? arr.reduce((a, b) => dist(myBase.x, myBase.y, b.x, b.y) < dist(myBase.x, myBase.y, a.x, a.y) ? b : a)
      : null;
    const loot = nearestTo(state.map.lootIslands.filter(i => !i.looted));
    const fish = nearestTo(state.map.fishZones);
    const pirate = state.ships.find(s => s.owner === -1);

    steps = [
      { text: '⚓ <b>Привет, капитан!</b> Несколько коротких подсказок — и в бой. Это «морской бой на листке в клетку».' },
      { text: 'Это твой <b>порт и флот</b>. Порт приносит немного золота каждый ход и <b>огрызается</b> 🏰 по тому, кто его атакует. Разобьют порт — ты выбываешь, береги его!',
        target: { world: { x: myBase.x, y: myBase.y, r: myBase.radius } } },
      { text: multiMoveOn()
          ? 'Ходите <b>по очереди</b>. За ход — до <b>трёх действий</b>: двигай и стреляй <b>разными</b> кораблями (одним — раз за ход), собирай добычу, покупай в верфи. Готов раньше — жми <b>«✅ Завершить ход»</b>.'
          : 'Ходите <b>по очереди</b>. За ход — только <b>одно</b> действие: поплыть, выстрелить, собрать добычу или сходить в верфь.',
        target: { sel: '#turnBanner' } },
      { text: 'Нажми на свой корабль → <b>«Плыть»</b> (в пределах контура; 🌬 по ветру он вытянут — уплывёшь дальше!) или <b>«💥 Залп»</b>. Главная атака — <b>бортовой залп</b>: бьёт только В БОРТ (повернись бортом к врагу!), наводишь как ход. Чем ближе цель к борту — тем больнее.',
        target: heavyShip ? { world: { x: heavyShip.x, y: heavyShip.y, r: 26 } } : null },
      { text: 'За борт стреляешь раз в ход, но можно дать залп <b>и левым, и правым</b> бортом (это одно действие). А <b>фрегат и линкор</b> вдобавок имеют <b>🎯 Мортиру</b> — прицельный выстрел по одной цели, в т.ч. по <b>порту</b> (осада).',
        target: heavyShip ? { world: { x: heavyShip.x, y: heavyShip.y, r: 26 } } : null },
      { text: 'В <b>Верфи</b> покупаешь корабли за золото 💰: шустрые шхуны и бриги, мощные фрегаты, рыбацкие баркасы — и <b>линкор</b>, который бьёт по портам сильнее всех 🏰.',
        target: { sel: '#btnShop' } },
      { text: 'Тут твой <b>баланс</b> — <b>золото</b> 💰. Зарабатывай его рыбалкой, кладами и потоплением врагов, а трать в <b>Верфи</b> на новые корабли.',
        target: { sel: '#playersList' }, panel: true },
      fish && { text: 'Поставь <b>баркас</b> в эту <b>🐟-рыбную зону</b> — он будет сам приносить золото каждый ход, и действие на это не тратится.',
                target: { world: { x: fish.x, y: fish.y, r: fish.radius } }, reveal: true },
      loot && { text: 'А это <b>остров с кладом</b> 💰 — подведи любой корабль вплотную и жми <b>«Собрать»</b>, чтобы забрать золото.',
                target: { world: { x: loot.x, y: loot.y, r: loot.radius } }, reveal: true },
      { text: 'По морю бродят <b>пираты</b> 🏴‍☠️ — потопи и забери награду. А жирный <b>👑-босс</b> несёт большой куш! Но осторожно: пираты огрызаются в ответ.',
        target: pirate ? { world: { x: pirate.x, y: pirate.y, r: 30 } } : null, reveal: true },
      { text: 'Цель — <b>разбить порт соперника</b>. Подведи флот и расстреляй его базу. Удачи, капитан! 🏴‍☠️',
        target: enemyBase ? { world: { x: enemyBase.x, y: enemyBase.y, r: enemyBase.radius } } : null }
    ].filter(Boolean);   // шаги про рыбу/клад выпадают, если их объектов нет на карте
    idx = 0;
    active = true;
    if (state) localStorage.setItem('sb_tut_seen:' + state.id, '1'); // в этом матче подсказки уже показаны — повтор заблокирован
    $('#coach').classList.remove('hidden');
    show();
    repositionTimer = setInterval(place, 150); // следим за панорамой/зумом/сворачиванием
  }

  $('#coachNext').addEventListener('click', next);
  $('#coachSkip').addEventListener('click', finish);
  return { start, get active() { return active; } };
})();

// ============ СТРОКА ВВОДА / ЧАТ ============
// Открывается «/» (десктоп). Введённый текст уходит на сервер: распознанную команду он применит
// сам (список — только на сервере), любой другой текст разойдётся всем игрокам как сообщение.
function openChatBar() {
  const inp = $('#chatInput');
  $('#chatBar').classList.add('show');
  inp.value = '';
  setTimeout(() => inp.focus(), 0); // фокус после завершения клика/тапа — иначе фокус «отскакивает» и бар закрывается
}
function closeChatBar() {
  $('#chatBar').classList.remove('show');
  $('#chatInput').blur();
}
// доступна ли строка ввода/чат сейчас (тестовый режим + я живой участник активной игры)
const canUseChat = () => CHEATS_ON && !!state && state.status === 'active' && !spectator && myIdx() >= 0;
// десктоп — по «/»; мобила — по кнопке 💬 в шапке панели (там клавиши «/» нет)
$('#chatBtn').addEventListener('click', () => { if (canUseChat()) openChatBar(); });
document.addEventListener('keydown', e => {
  if (e.key !== '/' || IS_COARSE || !canUseChat()) return;
  const ae = document.activeElement;
  if (ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) return;  // печатаем в поле — не мешаем
  e.preventDefault();
  openChatBar();
});
$('#chatInput').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape') return closeChatBar();
  if (e.key !== 'Enter') return;
  const text = e.target.value.trim();
  closeChatBar();
  if (!text) return;
  socket.emit('msg', { text }, res => {
    if (!res) return;
    if (res.ok) {
      if (res.msg) hudToast(res.msg);                                    // ответ команды (если был)
      if (res.effect === 'toggleFog') { fogRevealed = !fogRevealed; if (state) render(); }
    } else if (res.msg) {
      toast(res.msg);
    }
  });
});
$('#chatInput').addEventListener('blur', closeChatBar);

// входящее сообщение — нотиф сверху (в стиле «осталось ходов»), исчезает через 4 сек.
// hudToast пишет через textContent — разметка из текста не исполнится (безопасно).
socket.on('chat', ({ author, text }) => hudToast(`💬 ${author}: ${text}`, 4000));

resize();


// ═══════════════════════ 🐞 ОТЛАДКА ═══════════════════════
// Включается флагом SB_DEBUG на сервере. Две вещи: консоль решений бота под картой (видно,
// ПОЧЕМУ он сходил именно так) и инструменты над картой, чтобы воспроизводить ситуации из
// живой партии, не переигрывая её заново.
function initDebug() {
  $('#debugBar').classList.remove('hidden');
  $('#debugConsole').classList.remove('hidden');
  document.body.classList.add('debug-on');       // поджимаем страницу, чтобы консоль не накрыла карту

  // Перетаскивание верхней границы: высота живёт в CSS-переменной, её же читает padding тела.
  const setH = px => document.documentElement.style.setProperty('--dbg-h',
    Math.max(26, Math.min(window.innerHeight * 0.8, px)) + 'px');
  let dragFrom = null;
  $('#debugResize').addEventListener('pointerdown', e => {
    dragFrom = { y: e.clientY, h: $('#debugConsole').offsetHeight };
    e.target.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  $('#debugResize').addEventListener('pointermove', e => {
    if (dragFrom) setH(dragFrom.h + (dragFrom.y - e.clientY));   // тянем вверх — консоль растёт
  });
  const stopDrag = () => { dragFrom = null; if (state) render(); };
  $('#debugResize').addEventListener('pointerup', stopDrag);
  $('#debugResize').addEventListener('pointercancel', stopDrag);

  const tools = { dbgMove: 'move', dbgHeal: 'heal', dbgPirate: 'pirate', dbgShip: 'ship' };
  const hints = {
    move: 'ткни в свой или чужой корабль, затем в точку, куда его поставить',
    heal: 'ткни в корабль — восстановит прочность',
    pirate: 'ткни в воду — там появится пират',
    ship: 'выбери тип и хозяина, затем ткни в воду'
  };
  const setTool = t => {
    debugTool = debugTool === t ? null : t;
    debugPick = null;
    for (const id of Object.keys(tools)) $('#' + id).classList.toggle('armed', tools[id] === debugTool);
    $('#dbgPirateKind').classList.toggle('hidden', debugTool !== 'pirate');   // выбор размера — только при взведённом пирате
    $('#dbgShipType').classList.toggle('hidden', debugTool !== 'ship');
    $('#dbgShipOwner').classList.toggle('hidden', debugTool !== 'ship');
    if (debugTool === 'ship') fillShipPickers();
    $('#dbgHint').textContent = debugTool ? hints[debugTool] : '';
    render();
  };
  for (const [id, tool] of Object.entries(tools)) $('#' + id).addEventListener('click', () => setTool(tool));

  // Туман — клиентский визуал, поэтому переключаем его целиком тут. Три состояния по кругу:
  // «как в партии» → принудительно СНЯТЬ → принудительно НАДЕТЬ. Третье нужно для партий,
  // созданных без тумана: раньше кнопка в них не делала ничего.
  $('#dbgFog').addEventListener('click', () => {
    debugFog = debugFog === null ? 'off' : debugFog === 'off' ? 'on' : null;
    fogRevealed = false;
    $('#dbgFog').classList.toggle('armed', debugFog !== null);
    $('#dbgFog').textContent = debugFog === 'off' ? '🌫 туман: снят'
      : debugFog === 'on' ? '🌫 туман: надет' : '🌫 туман';
    debugLine('туман: ' + (debugFog === 'off' ? 'снят принудительно'
      : debugFog === 'on' ? 'надет принудительно' : 'как в настройках партии'));
    if (state) render();
  });

  $('#dbgEyes').addEventListener('click', () => {
    debugEyes = !debugEyes;
    $('#dbgEyes').classList.toggle('armed', debugEyes);
    debugLine(debugEyes ? 'показываю глазами бота: обзор, тревога у базы, цель флота' : 'наложение снято');
    if (state) render();
  });
  $('#dbgGold').addEventListener('click', () => socket.emit('debug', { kind: 'gold', amount: 500 }, r => {
    if (!r?.ok) debugLine('❌ ' + (r?.error || 'не вышло'));
  }));
  $('#debugClear').addEventListener('click', () => { $('#debugLog').innerHTML = ''; debugRows = 0; $('#debugCount').textContent = ''; });

  socket.on('botlog', m => { debugLine(m.text); if (m.eyes) { botEyes = m.eyes; if (debugEyes && state) render(); } });
  debugLine('режим отладки включён (SB_DEBUG=1)');
}

// Списки для спавна: типы берём из стейта (там же, откуда их читает верфь), владельцев — из игроков.
function fillShipPickers() {
  const types = $('#dbgShipType'), owners = $('#dbgShipOwner');
  if (!state) return;
  if (!types.options.length) {
    types.innerHTML = Object.entries(state.shipTypes || {})
      .filter(([k, st]) => !st.npc && k !== 'pirate')
      .map(([k, st]) => `<option value="${k}">${st.icon || ''} ${escapeHtml(st.name)}</option>`).join('');
  }
  const want = state.players.map((p, i) => `${i}:${p.nick}`).join('|');
  if (owners.dataset.key !== want) {
    owners.dataset.key = want;
    owners.innerHTML = state.players
      .map((p, i) => `<option value="${i}">${escapeHtml(p.nick)}${p.isBot ? ' 🤖' : ''}</option>`).join('');
  }
}

let debugRows = 0;
function debugLine(text) {
  const box = $('#debugLog');
  if (!box) return;
  const at = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML = `<span class="t">${at}</span>  ${escapeHtml(text)}`;
  box.appendChild(row);
  while (box.children.length > 400) box.removeChild(box.firstChild);   // не растим вкладку бесконечно
  debugRows++;
  $('#debugCount').textContent = debugRows + ' записей';
  if ($('#debugFollow')?.checked) box.scrollTop = box.scrollHeight;
}

// Клик по карте в режиме инструмента. Корабль ищем по ближайшему к точке — как и обычный выбор.
function debugClick(x, y) {
  const near = (state?.ships || [])
    .map(s => ({ s, d: Math.hypot(s.x - x, s.y - y) }))
    .sort((a, b) => a.d - b.d)[0];
  const hit = near && near.d < 34 ? near.s : null;
  const send = (op, note) => socket.emit('debug', op, r => debugLine(r?.ok ? '🐞 ' + note : '❌ ' + (r?.error || 'не вышло')));

  if (debugTool === 'heal') {
    if (!hit) return debugLine('🐞 лечить: мимо корабля');
    return send({ kind: 'heal', shipId: hit.id }, `вылечен ${ST(hit.type)?.name || hit.type}`);
  }
  if (debugTool === 'ship') {
    const type = $('#dbgShipType').value, owner = +$('#dbgShipOwner').value;
    return send({ kind: 'ship', type, owner, x, y },
      `поставлен ${ST(type)?.name || type} игроку ${state.players[owner]?.nick}`);
  }
  if (debugTool === 'pirate') {
    const boss = $('#dbgPirateKind').value === 'boss';
    return send({ kind: 'pirate', x, y, boss }, boss ? 'подсажен БОСС' : 'подсажен пират');
  }
  if (debugTool === 'move') {
    if (!debugPick) {
      if (!hit) return debugLine('🐞 перенести: сначала ткни в корабль');
      debugPick = hit.id;
      $('#dbgHint').textContent = 'теперь ткни, куда его поставить';
      return debugLine('🐞 взят ' + (ST(hit.type)?.name || hit.type));
    }
    const id = debugPick;
    debugPick = null;
    $('#dbgHint').textContent = 'ткни в корабль, затем в точку';
    return send({ kind: 'move', shipId: id, x, y }, 'корабль перенесён');
  }
}


// 🐞 Наложение «глазами бота»: круги обзора его кораблей (по тем же правилам, что у человека),
// зона тревоги вокруг его порта с балансом «угроза против прикрытия» и цель, по которой он
// сосредоточил огонь. Нужно, чтобы видеть не последствия решений, а их основания.
function drawBotEyes() {
  const e = botEyes;
  if (!state || !e) return;
  ctx.save();
  ctx.setLineDash([6, 5]);

  // обзор каждого корабля бота
  ctx.strokeStyle = 'rgba(41, 128, 185, .5)';
  ctx.lineWidth = 1.5;
  for (const c of e.vision || []) {
    ctx.beginPath();
    ctx.arc(sx(c.x), sy(c.y), c.r * view.scale, 0, Math.PI * 2);
    ctx.stroke();
  }

  // зона тревоги у его базы: красная, если прикрытия не хватает, зелёная, если хватает
  const base = state.map.bases?.[e.pIdx];
  if (base && e.homeReach) {
    const deficit = (e.homeThreat || 0) - (e.homeGuard || 0);
    ctx.strokeStyle = deficit > 0 ? 'rgba(192, 57, 43, .85)' : 'rgba(39, 174, 96, .6)';
    ctx.lineWidth = 2;
    const bx = sx(base.x), by = sy(base.y);
    ctx.beginPath();
    ctx.arc(bx, by, e.homeReach * view.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = deficit > 0 ? '#c0392b' : '#27ae60';
    ctx.textAlign = 'center';
    ctx.fillText(`угроза ${e.homeThreat || 0} · прикрытие ${e.homeGuard || 0}` +
      (e.defenceUrgency ? ` · тревога ${Math.round(e.defenceUrgency)}` : ''), bx, by - e.homeReach * view.scale - 6);
    ctx.setLineDash([6, 5]);
  }

  // общая цель флота (сосредоточенный огонь)
  const focus = e.focusId && state.ships.find(s => s.id === e.focusId);
  if (focus) {
    const fx = sx(focus.x), fy = sy(focus.y);
    ctx.setLineDash([]);
    ctx.strokeStyle = '#e67e22';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(fx, fy, 22 * view.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#e67e22';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('цель флота', fx, fy - 26 * view.scale);
  }

  // кого бот выбрал жертвой (чей порт ломает)
  const victimBase = e.victimIdx != null && state.map.bases?.[e.victimIdx];
  if (victimBase) {
    const vx = sx(victimBase.x), vy = sy(victimBase.y);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#8e44ad';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(vx, vy, (victimBase.radius + 16) * view.scale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#8e44ad';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('жертва', vx, vy - (victimBase.radius + 22) * view.scale);
  }
  ctx.restore();
}
