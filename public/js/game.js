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
const AIM_RATIO = 0.5;     // крестик ставим на «середине» пути от корабля до пальца
const AIM_GRAB_PX = 42;    // радиус зоны захвата корабля для drag-aim (экранные px)
let moveDemo = null;       // обучающая анимация жеста (тач, до первого хода игрока): {t0}
const IS_COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches); // сенсорный экран?
const hasMovedOnce = () => localStorage.getItem('sb_moved') === '1';
let basket = {};           // корзина верфи: {type: count}
let finishShown = false;
let lastEventSeq = -1;     // защита от повторного проигрывания анимаций

// --- identity ---
function getToken() {
  let t = localStorage.getItem('sb_token');
  if (!t) { t = crypto.randomUUID(); localStorage.setItem('sb_token', t); }
  return t;
}

const socket = io();

function join(nick) {
  socket.emit('join', {
    gameId, token: getToken(),
    session: localStorage.getItem('sb_session') || undefined,
    nick
  }, res => {
    if (!res.ok) {
      $('#nickOverlay').classList.remove('hidden');
      $('#nickError').textContent = res.error;
      return;
    }
    myId = res.playerId;
    spectator = res.spectator;
    hotseatOwner = !!res.hotseatOwner;
    $('#nickOverlay').classList.add('hidden');
  });
}

socket.on('connect', () => {
  const nick = localStorage.getItem('sb_nick');
  if (nick) join(nick);
  else $('#nickOverlay').classList.remove('hidden');
});

let BROADSIDE_ON = true; // приходит из /api/config; если залп выключен — прячем кнопку/вики/тутор

// Кнопка Google в окне ника (если сервер настроен и гость ещё не вошёл).
(async () => {
  try {
    const cfg = await (await fetch('/api/config')).json();
    BROADSIDE_ON = cfg.broadside !== false;     // флаг залпа — до любых ранних выходов
    applyBroadsideFlag();
    if (!cfg.googleClientId || localStorage.getItem('sb_session')) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => {
      $('#googleAuthBox').classList.remove('hidden');
      google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: async resp => {
          const r = await fetch('/api/auth/google', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential: resp.credential, nick: $('#nickInput').value.trim() })
          });
          const data = await r.json();
          if (!r.ok) { $('#nickError').textContent = data.error; return; }
          localStorage.setItem('sb_session', data.session);
          localStorage.setItem('sb_nick', data.nick);
          join(data.nick);
        }
      });
      google.accounts.id.renderButton($('#googleBtn'), { theme: 'outline', size: 'large', text: 'signin_with' });
    };
    document.head.appendChild(s);
  } catch { /* без Google тоже работаем */ }
})();

$('#nickBtn').addEventListener('click', () => {
  const nick = $('#nickInput').value.trim();
  if (!nick) { $('#nickError').textContent = 'Впиши ник!'; return; }
  localStorage.setItem('sb_nick', nick);
  join(nick);
});
$('#nickInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#nickBtn').click(); });

socket.on('state', s => {
  const prev = state;
  state = s;
  // сброс выбора, если корабль исчез или ход не наш
  if (selectedShipId && !state.ships.find(x => x.id === selectedShipId)) deselect();
  if (!isMyTurn()) deselect();
  // анимации событий хода (не проигрываем историю при первом входе)
  if (s.eventSeq !== lastEventSeq) {
    if (lastEventSeq >= 0 && s.events?.length) playEvents(s.events);
    lastEventSeq = s.eventSeq;
  }
  render();
  maybeMovesToast(prev, s); // «осталось N ходов» после моего суб-хода (режим ход-тремя-судами)
  if (anyBurning()) ensureAnimLoop(); // низкое HP базы → запустить анимацию огня/дыма
  Sound.onState(prev, s, myIdx());
  updateTab();
  // первый раз в активной игре и ты участник — показываем обучение
  if (s.status === 'active' && s.map && !spectator && myIdx() >= 0) Tutorial.start();
});

// иконка и заголовок вкладки сигналят, чей ход (видно из соседней вкладки)
function updateTab() {
  if (!state) return;
  if (state.status === 'lobby') {
    setFavicon('lobby'); document.title = '⏳ Лобби — Морской бой';
  } else if (state.status === 'finished') {
    setFavicon('over'); document.title = '🏁 Баттл окончен — Морской бой';
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
  const dt = Math.min(0.05, (now - lastFrameT) / 1000); lastFrameT = now;
  animPos.clear();
  for (const e of effects) {
    if (e.kind !== 'sail') continue;
    if (now < e.start) { animPos.set(e.shipId, { x: e.fx, y: e.fy }); continue; }
    const p = Math.min(1, (now - e.start) / e.moveDur);
    if (p >= 1) continue; // приплыл — позиция из состояния, след дорисовывается
    const k = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // ease-in-out
    const pt = bezPt(e, k);
    animPos.set(e.shipId, { x: pt.x, y: pt.y, ang: bezAng(e, k) });
  }
  effects = effects.filter(e => now < e.start + e.dur);
  if (fogFade.length) fogFade = fogFade.filter(f => now - f.born < f.hold + f.fade); // отсев догоревших затуханий тумана
  updateBaseFires(dt);
  render();
  if (effects.length || anyBurning() || fogFade.length) requestAnimationFrame(animTick);
  else { rafOn = false; animPos.clear(); render(); }
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
      headings.set(ev.shipId, Math.atan2(ev.ty - cy, ev.tx - cx)); // курс на финише (трекаем всегда)
      if (hidden(ev.fx, ev.fy) && hidden(ev.tx, ev.ty)) continue;
      if (!String(ev.shipId).startsWith('p')) Sound.playAt('move', delay); // пираты — без плеска
      addEffect({
        kind: 'sail', shipId: ev.shipId, fx: ev.fx, fy: ev.fy, cx, cy, tx: ev.tx, ty: ev.ty,
        moveDur: FX.sail.moveDur, dur: FX.sail.moveDur + FX.sail.wakeFade, delay
      });
      delay += FX.sail.moveDur; // следующие события (ход/выстрел пирата) ждут, пока лодка доплывёт
    } else if (ev.type === 'shot') {
      if (hidden(ev.fx, ev.fy) && hidden(ev.tx, ev.ty)) continue;
      Sound.playAt('shot', delay);
      addEffect({ kind: 'shell', fx: ev.fx, fy: ev.fy, tx: ev.tx, ty: ev.ty, dur: FX.shell.dur, delay });
      const impact = delay + FX.shell.dur - 20;
      Sound.playAt('hit', impact);
      addEffect({ kind: 'boom', x: ev.tx, y: ev.ty, big: false, dur: FX.boom.durSmall, delay: impact });
      if (ev.dmg) addEffect({ kind: 'dmg', x: ev.tx, y: ev.ty, amount: ev.dmg, dur: 1300, delay: impact });
      delay += FX.shell.dur + 140;
    } else if (ev.type === 'broadside') {
      if (hidden(ev.fx, ev.fy)) continue;
      // залп: один звук, все ядра летят разом, взрывы и красные цифры вместе
      Sound.playAt('shot', delay);
      const impact = delay + FX.shell.dur - 20;
      Sound.playAt('hit', impact);
      for (const h of ev.hits) {
        addEffect({ kind: 'shell', fx: ev.fx, fy: ev.fy, tx: h.tx, ty: h.ty, dur: FX.shell.dur, delay });
        addEffect({ kind: 'boom', x: h.tx, y: h.ty, big: false, dur: FX.boom.durSmall, delay: impact });
        addEffect({ kind: 'dmg', x: h.tx, y: h.ty, amount: h.dmg, dur: 1300, delay: impact });
      }
      delay += FX.shell.dur + 220;
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
const isMyTurn = () => state && state.status === 'active' && myIdx() === state.turn.idx && state.players[myIdx()]?.alive;
const ST = t => state.shipTypes[t];

// ── режим «ход тремя судами» ──
const movesPerTurn = () => state?.movesPerTurn || 1;          // бюджет ходов кораблями за ход
const multiMoveOn = () => movesPerTurn() > 1;                 // включён ли многоходовый режим
const movesUsed = () => state?.turn?.moves || 0;              // сколько уже сходило в этом ходу
const movesLeft = () => Math.max(0, movesPerTurn() - movesUsed());
const shipActed = id => (state?.turn?.actedShips || []).includes(id); // корабль уже ходил в этом ходу

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

// Информационный нотиф сверху экрана (в т.ч. «осталось N ходов») — сам растворяется.
function hudToast(msg, ms = 2600) {
  const el = $('#hudToast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// После моего суб-хода в режиме «ход тремя судами» — подсказать, сколько ходов осталось:
// иначе после постановки корабля «на якорь» неочевидно, что ход продолжается.
function maybeMovesToast(prev, s) {
  if (!multiMoveOn() || spectator || !isMyTurn()) return;
  if (!prev || prev.turn.idx !== s.turn.idx || prev.turn.number !== s.turn.number) return; // смена хода, а не суб-ход
  if ((s.turn.moves || 0) <= (prev.turn.moves || 0)) return; // ходов не прибавилось — действие не моё
  const left = movesLeft();
  if (left > 0) hudToast(`⚓ Осталось ходов: ${left} — ходи дальше или «Завершить ход»`);
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

// Отрисовка базы (вынесено, чтобы рисовать врагов и в норме, и сквозь туман).
// hpFrac=null → шкала HP не показывается (база ещё не разведана); dim → тускло (под туманом).
function drawBase(b, i, { alive, hpFrac, dim }) {
  const p = state.players[i];
  ctx.globalAlpha = dim ? 0.4 : 1;
  drawPolygon(b.x, b.y, b.shape, alive ? '#e8d9a8' : '#d8d3c2', '#8a7a45');
  ctx.beginPath();
  ctx.moveTo(sx(b.x), sy(b.y) - 26 * view.scale);
  ctx.lineTo(sx(b.x), sy(b.y) + 4);
  ctx.strokeStyle = '#2b3a55'; ctx.lineWidth = 2; ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx(b.x), sy(b.y) - 26 * view.scale);
  ctx.lineTo(sx(b.x) + 16, sy(b.y) - 20 * view.scale);
  ctx.lineTo(sx(b.x), sy(b.y) - 14 * view.scale);
  ctx.closePath();
  ctx.fillStyle = p.color; ctx.fill();
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
const FOG_CELL = 48, FOG_SHIP_MULT = 1.3, FOG_BASE_EXTRA = 200;

function fogActive() {
  return !!(state?.config?.fog) && !state.config.hotseat
    && state.status === 'active' && state.players[myIdx()]?.alive;
}
function fogResetMem() {
  fogCells.clear();
  for (const k in fogLastSeen) delete fogLastSeen[k];
  fogFade = [];
}
function visionCircles() {
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
    const pos = animPos.get(s.id) || s; // во время «плавания» — промежуточная позиция: туман плавно едет за лодкой
    circles.push({ x: pos.x, y: pos.y, r: Math.max(st.move, st.fireRange) * FOG_SHIP_MULT });
  }
  return circles;
}
const fogVisible = (x, y, circles) => circles.some(c => Math.hypot(x - c.x, y - c.y) <= c.r);
const fogExploredAt = (x, y) => fogCells.has(((x / FOG_CELL) | 0) + ',' + ((y / FOG_CELL) | 0));

function fogUpdate(circles) {
  if (fogGameId !== state.id) { fogGameId = state.id; fogResetMem(); } // новая игра — забыть разведанное
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
function burningBases() {
  if (!state?.map || state.status !== 'active') return [];
  const fog = fogActive(), vis = fog ? visionCircles() : null, res = [];
  state.map.bases.forEach((b, i) => {
    const p = state.players[i]; if (!p || !p.alive) return;
    if (fog && i !== myIdx() && !fogVisible(b.x, b.y, vis)) return; // не разведано — огня не видно
    const frac = (p.portHp || 0) / (state.portMax || 840);
    const tier = fireTier(frac); if (!tier) return;
    res.push({ i, b, tier, sev: Math.max(0, Math.min(1, (0.6 - frac) / 0.6)) });
  });
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

function render() {
  if (!state) return;
  renderSidebar();
  renderOverlays();
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
  const vis = fog ? visionCircles() : [];
  if (fog) fogUpdate(vis);

  // лист: фон и клетка до краёв экрана — сетка продолжается за границами карты
  ctx.fillStyle = '#fdfbf3';
  ctx.fillRect(0, 0, cw, ch);
  ctx.strokeStyle = 'rgba(116,160,199,.35)';
  ctx.lineWidth = 1;
  const gridX0 = Math.floor(toMap(0, 0).x / 40) * 40;
  const gridX1 = Math.ceil(toMap(cw, ch).x / 40) * 40;
  const gridY0 = Math.floor(toMap(0, 0).y / 40) * 40;
  const gridY1 = Math.ceil(toMap(cw, ch).y / 40) * 40;
  for (let x = gridX0; x <= gridX1; x += 40) {
    ctx.beginPath(); ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), ch); ctx.stroke();
  }
  for (let y = gridY0; y <= gridY1; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, sy(y)); ctx.lineTo(cw, sy(y)); ctx.stroke();
  }
  // граница игрового поля — пунктир, «начерчено по линейке»
  ctx.strokeStyle = '#6b6f76';
  ctx.lineWidth = 2.5;
  ctx.setLineDash([12, 8]);
  ctx.strokeRect(sx(0), sy(0), m.w * view.scale, m.h * view.scale);
  ctx.setLineDash([]);

  // рыбные места
  for (const z of m.fishZones) {
    if (fog && !fogExploredAt(z.x, z.y)) continue; // под туманом — пока не разведано
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

  // лут-острова
  for (const isl of m.lootIslands) {
    if (fog && !fogExploredAt(isl.x, isl.y)) continue; // под туманом — пока не разведано
    ctx.globalAlpha = isl.looted ? 0.45 : 1;
    drawPolygon(isl.x, isl.y, isl.shape, '#e8d9a8', '#8a7a45');
    ctx.font = `${Math.max(12, 18 * view.scale)}px serif`;
    ctx.textAlign = 'center';
    ctx.fillText(isl.looted ? '✖' : '💰', sx(isl.x), sy(isl.y) + 5);
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
    if (mode === 'move' || mode === 'idle') dashedCircle(sel.x, sel.y, st.move, 'rgba(107,111,118,.8)', 1.6);
    if (mode === 'attack' || mode === 'idle') dashedCircle(sel.x, sel.y, st.fireRange, 'rgba(192,57,43,.75)', 1.6);
  }

  // пенные следы — под кораблями
  drawEffects(true);

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
      drawShip({ id: e.shipId, owner: e.ship.owner, type: e.ship.type, x: e.x, y: e.y, hp: 1, bounty: e.ship.bounty }, false);
    }
  }

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
  }

  // «линейка» при перемещении
  if (sel && mode === 'move' && hoverPt) {
    const st = ST(sel.type);
    const d = dist(sel.x, sel.y, hoverPt.x, hoverPt.y);
    const ok = d <= st.move;
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
    // подпись расстояния в клетках
    const mx = (sx(sel.x) + sx(hoverPt.x)) / 2, my = (sy(sel.y) + sy(hoverPt.y)) / 2;
    ctx.font = 'bold 14px Neucha, cursive';
    ctx.fillStyle = ok ? '#2b3a55' : '#c0392b';
    ctx.textAlign = 'center';
    ctx.fillText(`${(d / 40).toFixed(1)} кл.`, mx, my - 8);

    // тач-прицел: крестик-цель + маркер пальца с тонкой линией (палец не закрывает цель)
    if (aim && aim.dest) {
      drawCrosshair(sx(hoverPt.x), sy(hoverPt.y), aim.clamped ? '#c0392b' : '#2b3a55');
      if (aim.finger) {
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
  if (moveDemo && sel && mode === 'move' && !aim) drawMoveDemo(sel);

  drawEffects();
  updateMoveHint();
}

// мелкая ненавязчивая подпись под панелью действий (тач, режим «Плыть»)
function updateMoveHint() {
  const el = $('#moveHint');
  if (!el) return;
  el.classList.toggle('hidden', !(IS_COARSE && mode === 'move' && selectedShipId));
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
const SHIP_LEN = { barkas: 34, shkhuna: 42, brig: 50, fregat: 60, linkor: 72, pirate: 50 };
const SHIP_MASTS = { barkas: 0, shkhuna: 1, brig: 2, fregat: 3, linkor: 3, pirate: 2 };
const headings = new Map(); // shipId → направление носа (по последнему ходу)

function currentHeading(s) {
  if (s._headingOverride !== undefined) return s._headingOverride;
  if (headings.has(s.id)) return headings.get(s.id);
  if (typeof s.heading === 'number') return s.heading; // пираты приходят с курсом
  // по умолчанию нос смотрит к центру карты
  return Math.atan2(state.map.h / 2 - s.y, state.map.w / 2 - s.x);
}

function drawShip(s, selected) {
  const isPirate = s.owner === -1;
  const p = isPirate ? null : state.players[s.owner];
  const st = ST(s.type);
  const pos = animPos.get(s.id) || s; // во время анимации — промежуточная позиция
  const px = sx(pos.x), py = sy(pos.y);
  const k = view.scale;
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
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(43,58,85,.7)';
    ctx.beginPath();
    ctx.arc(-L / 2 - L * 0.18, W * 0.18, L * 0.14, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
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
  try { canvas.setPointerCapture(e.pointerId); } catch { /* синтетические события */ }
  hideShipNote(); // тап/драг убирает записку (на тапе по «якорному» кораблю покажется заново)
  pointers.set(e.pointerId, evPos(e));
  if (pointers.size === 1) {
    const p = evPos(e);
    // ТАЧ-ПРИЦЕЛ: палец лёг на свой корабль → тянем луч с крестиком, а не панораму.
    // В режиме «Плыть» по выбранному кораблю целимся сразу; иначе по любому своему кораблю
    // «взводим» — тап просто выберет, а перетаскивание авто-активирует «Плыть». Мышь — как раньше.
    if (e.pointerType === 'touch' && state && isMyTurn() && (mode === 'move' || mode === 'idle')) {
      const sel = selectedShipId && state.ships.find(s => s.id === selectedShipId);
      // корабль, уже сходивший в этом ходу, не «хватаем» прицелом (drag → панорама)
      const onSel = sel && !shipActed(sel.id) && dist(p.x, p.y, sx(sel.x), sy(sel.y)) <= AIM_GRAB_PX;
      if (mode === 'move' && onSel) {
        aim = { sel, armed: true, startX: p.x, startY: p.y };
        moveDemo = null;
        updateAim(p);
        render();
        return;
      }
      const own = onSel ? sel
        : state.ships.find(s => s.owner === myIdx() && !shipActed(s.id) && dist(p.x, p.y, sx(s.x), sy(s.y)) <= AIM_GRAB_PX);
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
  const range = ST(sel.type).move;
  if (fd < 1) { aim.dest = { x: sel.x, y: sel.y }; aim.clamped = false; }
  else {
    const len = fd * AIM_RATIO;    // крестик на «середине» пути до пальца
    aim.clamped = len > range;     // середина вышла за круг хода — ход недопустим
    const k = len / fd;
    aim.dest = { x: sel.x + dx * k, y: sel.y + dy * k }; // истинная середина (может быть вне круга)
  }
  hoverPt = aim.dest; // рендер «линейки» сам красит красным, если точка вне радиуса
}

canvas.addEventListener('pointermove', e => {
  if (!state || !state.map) return;
  const p = evPos(e);

  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

  if (aim && pointers.size === 1) { // тянем тач-прицел
    if (!aim.armed) {
      if (Math.hypot(p.x - aim.startX, p.y - aim.startY) <= 12) return; // ещё не потянул
      aim.armed = true; selectedShipId = aim.sel.id; mode = 'move'; moveDemo = null; // авто-«Плыть»
    }
    updateAim(p);
    render();
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
      render();
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
    if (mode === 'move') render();
  }
});

function endPointer(e) {
  // завершение тач-прицела: отпустил палец — корабль плывёт к крестику
  if (aim && e.type === 'pointerup') {
    const a = aim;
    aim = null; hoverPt = null;
    pointers.delete(e.pointerId);
    if (pointers.size === 0) { drag = null; pinchDist = 0; }
    if (!a.armed) { handleTap({ x: a.startX, y: a.startY }, true); return; } // не потянул → выбор корабля
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

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const p = evPos(e);
  zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

function handleTap(pos, isTouch) {
  if (!state || !state.map || state.status !== 'active') return;
  const pt = toMap(pos.x, pos.y);
  const tapR = isTouch ? 34 : 26;

  const clickedShip = state.ships.find(s => dist(pt.x, pt.y, s.x, s.y) < tapR);

  if (mode === 'move' && selectedShipId) {
    // на тач курс прокладывается только перетаскиванием от корабля (тык-в-точку убран —
    // он путал). Мышь — как раньше, тык до пикселя.
    if (isTouch) { startMoveDemo(); return; } // напомним жест демкой (если ещё не научился)
    sendAction({ type: 'move', shipId: selectedShipId, x: pt.x, y: pt.y });
    return;
  }

  if (mode === 'attack' && selectedShipId) {
    if (clickedShip && clickedShip.owner !== myIdx()) {
      sendAction({ type: 'attack', shipId: selectedShipId, targetType: 'ship', targetId: clickedShip.id });
      return;
    }
    const baseIdx = state.map.bases.findIndex(b => dist(pt.x, pt.y, b.x, b.y) < b.radius + 12);
    if (baseIdx >= 0 && baseIdx !== myIdx() && state.players[baseIdx]?.alive) {
      sendAction({ type: 'attack', shipId: selectedShipId, targetType: 'port', targetId: baseIdx });
      return;
    }
    errToast('Выбери цель: вражеский корабль или порт');
    return;
  }

  // выбор своего корабля
  if (clickedShip && clickedShip.owner === myIdx() && isMyTurn()) {
    if (shipActed(clickedShip.id)) { // уже ходил — показываем записку (на тач сама исчезнет)
      showShipNote(sx(clickedShip.x), sy(clickedShip.y) - 16, '⚓ Уже ходил');
      if (isTouch) { clearTimeout(shipNoteTimer); shipNoteTimer = setTimeout(hideShipNote, 2200); }
      return;
    }
    selectedShipId = clickedShip.id;
    mode = 'idle';
    Sound.play('click');
    $('#shipActions').classList.remove('hidden');
    positionActionBar(clickedShip); // панель — на противоположной кораблю половине экрана
    $('#shipActionsTitle').textContent = ST(clickedShip.type).icon + ' ' + ST(clickedShip.type).name;
    // «Собрать» — если корабль дотягивается до клада (рыбалка теперь капает сама)
    $('#btnCollectHere').classList.toggle('hidden', !canShipCollect(clickedShip));
    // «Залп» — тяжёлый корабль и в радиусе 2+ вражеских кораблей
    $('#btnBroadside').classList.toggle('hidden', !canBroadside(clickedShip));
    render();
  } else {
    deselect();
  }
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

// Залп выключен в конфиге — прячем его карточку в вики (тутор-шаг фильтруется при сборке шагов).
function applyBroadsideFlag() {
  if (BROADSIDE_ON) return;
  document.getElementById('wikiBroadside')?.classList.add('hidden');
}

function canBroadside(ship) {
  if (!BROADSIDE_ON) return false;
  const st = ST(ship.type);
  if (!st.broadside) return false;
  const me = myIdx();
  const inRange = state.ships.filter(t =>
    t.owner !== me && !(t.owner >= 0 && !state.players[t.owner]?.alive) &&
    (t.owner === -1 || !ST(t.type).fishing) &&
    dist(ship.x, ship.y, t.x, t.y) <= st.fireRange);
  return inRange.length >= 2;
}

$('#btnMove').addEventListener('click', () => {
  mode = 'move'; Sound.play('click');
  startMoveDemo();   // на сенсоре до первого хода — показать демо-жест (потом не докучаем)
  render();
});
$('#btnFire').addEventListener('click', () => { mode = 'attack'; Sound.play('click'); render(); });
$('#btnBroadside').addEventListener('click', () => { if (selectedShipId) sendAction({ type: 'broadside', shipId: selectedShipId }); });
$('#btnCancel').addEventListener('click', deselect);

// звук и сворачивание панели
Sound.armAutostart();
$('#muteBtn').textContent = Sound.muted ? '🔇' : '🔊';
$('#muteBtn').addEventListener('click', () => {
  $('#muteBtn').textContent = Sound.toggleMute() ? '🔇' : '🔊';
});
// инфобаза (вики + тумблер обучения)
function openInfo() {
  // таблица флота из актуальных характеристик
  if (state?.shipTypes) {
    $('#infoFleet').innerHTML = Object.entries(state.shipTypes)
      .filter(([, st]) => !st.npc)
      .map(([, st]) => {
        const extra = [
          st.fishing ? `🐟 +${st.fishing}` : '',
          st.portBonus ? `🏰 ×${st.portBonus}` : '',
          (st.broadside && BROADSIDE_ON) ? '💥 залп' : ''
        ].filter(Boolean).join(' · ');
        return `<div class="info-fleet-row">
          <span class="nm">${st.icon} ${st.name}</span>
          <span class="st">${st.price}з · ❤️${st.hp} · ⚔️${st.dmg} · 🎯${(st.fireRange / 40).toFixed(1)} · 🧭${(st.move / 40).toFixed(1)}${extra ? ' · ' + extra : ''}</span>
        </div>`;
      }).join('');
  }
  // карточка «Ход» — вариант под режим партии (одно действие / ход тремя судами)
  $('#wikiTurnSingle')?.classList.toggle('hidden', multiMoveOn());
  $('#wikiTurnMulti')?.classList.toggle('hidden', !multiMoveOn());
  $('#tutToggle').checked = localStorage.getItem('sb_tut_done') !== '1';
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
// на телефоне меню по умолчанию свёрнуто — карта на весь экран над панелью
if (window.matchMedia('(max-width: 900px)').matches) {
  $('#panel').classList.add('collapsed');
}

$('#btnCollectHere').addEventListener('click', () => sendAction({ type: 'collect' }));
$('#btnSkip').addEventListener('click', () => sendAction({ type: 'skip' }));
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
$('#btnBuy').addEventListener('click', () => {
  const ships = Object.entries(basket).flatMap(([t, n]) => Array(n).fill(t));
  if (!ships.length) { toast('Корзина пуста — добавь корабли «+»'); return; }
  sendAction({ type: 'buy', ships });
});

// ============ САЙДБАР ============
function renderSidebar() {
  const me = state.players[myIdx()];
  const current = state.players[state.turn.idx];

  // баннер хода (в режиме «ход тремя судами» — счётчик оставшихся ходов кораблями)
  const banner = $('#turnBanner');
  const showMoves = multiMoveOn() && state.status === 'active' && (isMyTurn() || state.config?.hotseat);
  const movesTag = showMoves ? ` ⚓${movesLeft()}/${movesPerTurn()}` : '';
  if (state.status === 'lobby') banner.textContent = '⏳ Сбор флота…';
  else if (state.status === 'finished') banner.textContent = '🏁 Баттл окончен';
  else if (state.config?.hotseat) banner.textContent = `✏️ Ходит: ${current?.nick} (№${state.turn.number})${movesTag}`;
  else if (isMyTurn()) banner.textContent = `🔥 Твой ход!${movesTag}`;
  else banner.textContent = `Ход: ${current?.nick ?? '…'} (№${state.turn.number})`;
  banner.classList.toggle('my-turn', isMyTurn() && !state.config?.hotseat);

  // приватность: чьи цифры (золото/HP порта) видно
  // онлайн/боты — только свои; хотсит — только у того, чей ход; в конце — все
  const canSee = i => state.status === 'finished' ||
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
  if (showActions) {
    $('#btnShop').disabled = !isMyTurn();
    // в многоходовом режиме «Пропустить» превращается в «Завершить ход» (когда уже что-то сходило)
    const finishing = multiMoveOn() && movesUsed() > 0;
    const btnSkip = $('#btnSkip');
    btnSkip.disabled = !isMyTurn();
    btnSkip.textContent = finishing ? '✅ Завершить ход' : '⏭ Пропустить';
    btnSkip.classList.toggle('primary', finishing && isMyTurn());
    $('#btnNudge').classList.toggle('hidden',
      isMyTurn() || state.turn.nudged || !!state.players[state.turn.idx]?.isBot);
    $('#hint').textContent = isMyTurn()
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
  $('#log').innerHTML = [...state.log].reverse().map(l =>
    `<div class="${l.type}">${escapeHtml(l.text)}</div>`).join('');
  $('#log').scrollTop = 0;

  // высота свёрнутой панели могла измениться (баннер хода, кнопки) — подвинуть карту
  if ($('#mapWrap').style.bottom !== desiredMapBottom()) resize();
}

function renderShop() {
  const me = state.players[myIdx()];
  if (!me) return;
  const total = Object.entries(basket).reduce((s, [t, n]) => s + ST(t).price * n, 0);
  $('#shopGold').textContent = `💰 ${me.gold}`;
  $('#shopList').innerHTML = Object.entries(state.shipTypes).filter(([, st]) => !st.npc).map(([t, st]) => {
    const cantAddMore = total + st.price > me.gold;
    return `
    <div class="ship-card ${cantAddMore && !basket[t] ? 'unaffordable' : ''}" title="${st.desc}">
      <div class="head"><span>${st.icon}</span><span class="nm">${st.name}</span><span class="price">${st.price} зол.</span></div>
      <div class="stats">
        <span title="Прочность">❤️ ${st.hp}</span>
        <span title="Урон за выстрел">⚔️ ${st.dmg}</span>
        <span title="Дальность стрельбы">🎯 ${(st.fireRange / 40).toFixed(1)} кл.</span>
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
  $('#shopTotal').textContent = total ? `Итого: ${total} из ${me.gold} зол.` : 'Выбери корабли кнопкой «+»';
  $('#shopTotal').style.color = total > me.gold ? '#c0392b' : '';
  $('#btnBuy').disabled = !total || total > me.gold || !isMyTurn();
  $('#btnBuy').textContent = total ? `Купить за ${total} зол.` : 'Купить';
  document.querySelectorAll('[data-shop]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.shop;
    basket[t] = Math.max(0, (basket[t] || 0) + (+b.dataset.d));
    if (!basket[t]) delete basket[t];
    renderShop();
  }));
}

// ============ ОВЕРЛЕИ ============
function renderOverlays() {
  // лобби
  const inLobby = state.status === 'lobby';
  $('#lobbyOverlay').classList.toggle('hidden', !inLobby || $('#nickOverlay').classList.contains('hidden') === false);
  if (inLobby) {
    const cfg = state.config;
    $('#lobbyConfig').textContent =
      `${cfg.maxPlayers} игрока · ${cfg.turnTimer ? 'таймер ' + cfg.turnTimer + ' сек/ход' : 'без таймера'}`;
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
    const isCreator = state.players[0]?.id === myId;
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
    $('#lobbyBots').classList.toggle('hidden', !isCreator);
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
// смена своего ника прямо в лобби — перезаходим с тем же токеном, ник обновится у всех
function saveLobbyNick() {
  const n = $('#lobbyNick').value.trim();
  if (!n) { $('#lobbyError').textContent = 'Ник не может быть пустым'; return; }
  localStorage.setItem('sb_nick', n);
  $('#lobbyError').textContent = '';
  join(n);
  $('#lobbyNick').blur();
}
$('#lobbyNickSave').addEventListener('click', saveLobbyNick);
$('#lobbyNick').addEventListener('keydown', e => { if (e.key === 'Enter') saveLobbyNick(); });
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
  const canvasRect = () => canvas.getBoundingClientRect();
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

  function show() { place(); }
  function next() {
    if (idx >= steps.length - 1) return finish();
    idx++;
    show();
  }
  function finish() {
    active = false;
    clearInterval(repositionTimer);
    $('#coach').classList.add('hidden');
    localStorage.setItem('sb_tut_done', '1');
  }

  function start() {
    if (active || localStorage.getItem('sb_tut_done')) return;
    const me = state.players[state.players.findIndex(p => p.id === myId)];
    const myBase = state.map.bases[myIdx()] || state.map.bases[0];
    const myShip = state.ships.find(s => s.owner === myIdx());
    const heavyShip = state.ships.find(s => s.owner === myIdx() && ST(s.type).broadside) || myShip;
    const enemyBase = state.map.bases.find((b, i) => i !== myIdx());
    const loot = state.map.lootIslands.find(i => !i.looted);
    const fish = state.map.fishZones[0];
    const pirate = state.ships.find(s => s.owner === -1);

    steps = [
      { text: '⚓ <b>Привет, капитан!</b> Несколько коротких подсказок — и в бой. Это «морской бой на листке в клетку».' },
      { text: 'Это твой <b>порт и флот</b>. Порт приносит немного золота каждый ход и <b>огрызается</b> 🏰 по тому, кто его атакует. Разобьют порт — ты выбываешь, береги его!',
        target: { world: { x: myBase.x, y: myBase.y, r: myBase.radius } } },
      { text: multiMoveOn()
          ? 'Ходите <b>по очереди</b>. За ход — до <b>трёх действий</b>: двигай и стреляй <b>разными</b> кораблями (одним — раз за ход), собирай добычу, покупай в верфи. Готов раньше — жми <b>«✅ Завершить ход»</b>.'
          : 'Ходите <b>по очереди</b>. За ход — только <b>одно</b> действие: поплыть, выстрелить, собрать добычу или сходить в верфь.',
        target: { sel: '#turnBanner' } },
      { text: 'Нажми на свой корабль → выбери <b>«Плыть»</b> (в пределах круга дальности) или <b>«Стрелять»</b> по врагу в радиусе огня.',
        target: myShip ? { world: { x: myShip.x, y: myShip.y, r: 26 } } : null },
      ...(BROADSIDE_ON ? [{ text: 'Фрегат и линкор умеют <b>💥 Залп</b>: бьют по <b>всем вражеским боевым кораблям</b> в радиусе разом (на 20% слабее). Незаменимо против стаи. Рыбацкие баркасы залп не трогает.',
        target: heavyShip ? { world: { x: heavyShip.x, y: heavyShip.y, r: 26 } } : null }] : []),
      { text: 'В <b>Верфи</b> покупаешь корабли за золото 💰: шустрые шхуны и бриги, мощные фрегаты, рыбацкие баркасы — и <b>линкор</b>, который бьёт по портам сильнее всех 🏰.',
        target: { sel: '#btnShop' } },
      loot
        ? { text: 'Поставь <b>баркас</b> в 🐟-зону — и он будет сам приносить золото каждый ход, без траты действия. А чтобы забрать <b>клад</b> 💰, подплыви вплотную к острову и жми <b>«Собрать»</b>.',
            target: { world: { x: loot.x, y: loot.y, r: loot.radius } } }
        : { text: 'Поставь <b>баркас</b> в 🐟-зону — он сам приносит золото каждый ход, действие на это не тратится. Острова с кладом 💰 лутаются кнопкой <b>«Собрать»</b>.',
            target: fish ? { world: { x: fish.x, y: fish.y, r: fish.radius } } : null },
      { text: 'По морю бродят <b>пираты</b> 🏴‍☠️ — потопи и забери награду. А жирный <b>👑-босс</b> несёт большой куш! Но осторожно: пираты огрызаются в ответ.',
        target: pirate ? { world: { x: pirate.x, y: pirate.y, r: 30 } } : null },
      { text: 'Цель — <b>разбить порт соперника</b>. Подведи флот и расстреляй его базу. Удачи, капитан! 🏴‍☠️',
        target: enemyBase ? { world: { x: enemyBase.x, y: enemyBase.y, r: enemyBase.radius } } : null }
    ];
    idx = 0;
    active = true;
    $('#coach').classList.remove('hidden');
    show();
    repositionTimer = setInterval(place, 150); // следим за панорамой/зумом/сворачиванием
  }

  $('#coachNext').addEventListener('click', next);
  $('#coachSkip').addEventListener('click', finish);
  return { start, get active() { return active; } };
})();

resize();
