// Клиент игры: лобби, canvas-карта «на листке в клетку», ходы по WebSocket.
const $ = s => document.querySelector(s);
const gameId = location.pathname.split('/').pop();
const canvas = $('#map');
const ctx = canvas.getContext('2d');

let state = null;          // последнее состояние с сервера
let myId = null;
let spectator = false;
let selectedShipId = null;
let mode = 'idle';         // idle | move | attack
let hoverPt = null;        // позиция курсора в координатах карты
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
    $('#nickOverlay').classList.add('hidden');
  });
}

socket.on('connect', () => {
  const nick = localStorage.getItem('sb_nick');
  if (nick) join(nick);
  else $('#nickOverlay').classList.remove('hidden');
});

// Кнопка Google в окне ника (если сервер настроен и гость ещё не вошёл).
(async () => {
  try {
    const cfg = await (await fetch('/api/config')).json();
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
  Sound.onState(prev, s, myIdx());
});

// ============ АНИМАЦИИ ============
let effects = [];          // активные эффекты {kind, ..., start, dur}
const animPos = new Map(); // shipId → промежуточная позиция на время «плавания»
let rafOn = false;

function addEffect(e) {
  effects.push({ ...e, start: performance.now() + (e.delay || 0) });
  if (!rafOn) { rafOn = true; requestAnimationFrame(animTick); }
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
  render();
  if (effects.length) requestAnimationFrame(animTick);
  else { rafOn = false; animPos.clear(); render(); }
}

function playEvents(events) {
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
      headings.set(ev.shipId, Math.atan2(ev.ty - cy, ev.tx - cx)); // курс на финише
      if (!String(ev.shipId).startsWith('p')) Sound.playAt('move', delay); // пираты — без плеска
      addEffect({
        kind: 'sail', shipId: ev.shipId, fx: ev.fx, fy: ev.fy, cx, cy, tx: ev.tx, ty: ev.ty,
        moveDur: FX.sail.moveDur, dur: FX.sail.moveDur + FX.sail.wakeFade, delay
      });
    } else if (ev.type === 'shot') {
      Sound.playAt('shot', delay);
      addEffect({ kind: 'shell', fx: ev.fx, fy: ev.fy, tx: ev.tx, ty: ev.ty, dur: FX.shell.dur, delay });
      Sound.playAt('hit', delay + FX.shell.dur - 20);
      addEffect({ kind: 'boom', x: ev.tx, y: ev.ty, big: false, dur: FX.boom.durSmall, delay: delay + FX.shell.dur - 20 });
      delay += FX.shell.dur + 140;
    } else if (ev.type === 'explosion') {
      // потопленный корабль ещё виден, пока к нему летит ядро
      if (ev.ship && delay > 0) {
        addEffect({ kind: 'ghost', shipId: ev.shipId, ship: ev.ship, x: ev.x, y: ev.y, dur: delay });
      }
      Sound.playAt('wreck', delay);
      addEffect({ kind: 'boom', x: ev.x, y: ev.y, big: !!ev.big, dur: FX.boom.durBig, delay });
      delay += 350;
    } else if (ev.type === 'gold') {
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
    }
  }
}

// --- helpers ---
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const myIdx = () => state ? state.players.findIndex(p => p.id === myId) : -1;
const isMyTurn = () => state && state.status === 'active' && myIdx() === state.turn.idx && state.players[myIdx()]?.alive;
const ST = t => state.shipTypes[t];

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

function sendAction(action) {
  socket.emit('action', action, res => {
    if (!res.ok) toast(res.error);
    else {
      basket = {};
      deselect();
      $('#shopOverlay').classList.add('hidden');
      // на телефоне после хода сворачиваем меню — карта снова на весь экран
      if (window.matchMedia('(max-width: 900px)').matches && !$('#panel').classList.contains('collapsed')) {
        $('#panelToggle').click();
      }
    }
  });
}

function deselect() {
  selectedShipId = null;
  mode = 'idle';
  $('#shipActions').classList.add('hidden');
  if (state) render();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============ ОТРИСОВКА ============
let view = { scale: 1, ox: 0, oy: 0 };
// камера: пользовательский зум (пинч/колесо) и панорама (драг)
const cam = { z: 1, px: 0, py: 0 };

function resize() {
  const wrap = $('#mapWrap');
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

function clampCam() {
  cam.z = Math.min(5, Math.max(1, cam.z));
  if (!state?.map) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const fit = Math.min(w / state.map.w, h / state.map.h) * 0.97;
  const s = fit * cam.z;
  const baseOx = (w - state.map.w * s) / 2;
  const baseOy = (h - state.map.h * s) / 2;
  // двигать можно как угодно, но минимум KEEP px карты всегда на экране —
  // чтобы было за что «ухватиться» и вернуть её
  const KEEP = 80;
  cam.px = Math.min(w - KEEP - baseOx, Math.max(KEEP - state.map.w * s - baseOx, cam.px));
  cam.py = Math.min(h - KEEP - baseOy, Math.max(KEEP - state.map.h * s - baseOy, cam.py));
}

function computeView() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const fit = Math.min(w / state.map.w, h / state.map.h) * 0.97;
  view.scale = fit * cam.z;
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
    ctx.beginPath();
    ctx.arc(sx(z.x), sy(z.y), z.radius * view.scale, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,170,210,.16)';
    ctx.fill();
    dashedCircle(z.x, z.y, z.radius, 'rgba(80,130,180,.6)');
    ctx.font = `${Math.max(14, 22 * view.scale)}px serif`;
    ctx.textAlign = 'center';
    ctx.fillText('🐟', sx(z.x), sy(z.y) + 6);
  }

  // лут-острова
  for (const isl of m.lootIslands) {
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

  // базы
  m.bases.forEach((b, i) => {
    const p = state.players[i];
    if (!p) return;
    drawPolygon(b.x, b.y, b.shape, p.alive ? '#e8d9a8' : '#d8d3c2', '#8a7a45');
    // флаг цвета игрока
    ctx.beginPath();
    ctx.moveTo(sx(b.x), sy(b.y) - 26 * view.scale);
    ctx.lineTo(sx(b.x), sy(b.y) + 4);
    ctx.strokeStyle = '#2b3a55';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx(b.x), sy(b.y) - 26 * view.scale);
    ctx.lineTo(sx(b.x) + 16, sy(b.y) - 20 * view.scale);
    ctx.lineTo(sx(b.x), sy(b.y) - 14 * view.scale);
    ctx.closePath();
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.font = `bold ${Math.max(12, 15 * view.scale)}px Neucha, cursive`;
    ctx.fillStyle = '#2b3a55';
    ctx.textAlign = 'center';
    ctx.fillText(p.nick, sx(b.x), sy(b.y + b.radius) + 16);
    if (p.alive) hpBar(sx(b.x), sy(b.y + b.radius) + 22, 56, p.portHp / 300, '#27ae60');
    else { ctx.font = `${20 * view.scale + 8}px serif`; ctx.fillText('💀', sx(b.x), sy(b.y) + 6); }
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

  // корабли
  for (const s of state.ships) {
    drawShip(s, s.id === selectedShipId);
  }
  // тонущие: уже исчезли из состояния, но ядро ещё летит
  const nowGhost = performance.now();
  for (const e of effects) {
    if (e.kind === 'ghost' && nowGhost >= e.start && nowGhost < e.start + e.dur) {
      drawShip({ id: e.shipId, owner: e.ship.owner, type: e.ship.type, x: e.x, y: e.y, hp: 1, bounty: e.ship.bounty }, false);
    }
  }

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
  }

  drawEffects();
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
  const L = (SHIP_LEN[s.type] || 46) * k;
  const W = L * 0.36;
  const hull = isPirate ? '#33363c' : p.color;

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
    ctx.fillText('🏴‍☠️', px, py - L * 0.5);
    ctx.font = `bold ${Math.max(9, 14 * k)}px Neucha, cursive`;
    ctx.fillStyle = '#2b3a55';
    ctx.fillText(`💰${s.bounty}`, px, py + L * 0.62 + 16 * k);
  }

  hpBar(px, py + L * 0.42 + 4, Math.max(16, L * 0.9), s.hp / st.hp, '#27ae60');
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
  pointers.set(e.pointerId, evPos(e));
  if (pointers.size === 1) {
    const p = evPos(e);
    // палец «ездит» сильнее мыши — порог тапа больше
    drag = { x: p.x, y: p.y, moved: false, threshold: e.pointerType === 'mouse' ? 6 : 18 };
  } else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    drag = null;
  }
});

canvas.addEventListener('pointermove', e => {
  if (!state || !state.map) return;
  const p = evPos(e);

  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);

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

  // наведение для «линейки» (мышь)
  hoverPt = toMap(p.x, p.y);
  if (mode === 'move') render();
});

function endPointer(e) {
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
    toast('Выбери цель: вражеский корабль или порт');
    return;
  }

  // выбор своего корабля
  if (clickedShip && clickedShip.owner === myIdx() && isMyTurn()) {
    selectedShipId = clickedShip.id;
    mode = 'idle';
    Sound.play('click');
    $('#shipActions').classList.remove('hidden');
    $('#shipActionsTitle').textContent = ST(clickedShip.type).icon + ' ' + ST(clickedShip.type).name;
    // «Собрать» — если корабль дотягивается до клада или рыбачит в рыбном месте
    $('#btnCollectHere').classList.toggle('hidden', !canShipCollect(clickedShip));
    render();
  } else {
    deselect();
  }
}

function canShipCollect(ship) {
  const st = ST(ship.type);
  if (st.fishing > 0 &&
      state.map.fishZones.some(z => dist(ship.x, ship.y, z.x, z.y) <= z.radius)) return true;
  return state.map.lootIslands.some(i => !i.looted &&
    dist(ship.x, ship.y, i.x, i.y) <= i.radius + (state.lootReach || 55));
}

$('#btnMove').addEventListener('click', () => { mode = 'move'; Sound.play('click'); render(); });
$('#btnFire').addEventListener('click', () => { mode = 'attack'; Sound.play('click'); render(); });
$('#btnCancel').addEventListener('click', deselect);

// звук и сворачивание панели
Sound.armAutostart();
$('#muteBtn').textContent = Sound.muted ? '🔇' : '🔊';
$('#muteBtn').addEventListener('click', () => {
  $('#muteBtn').textContent = Sound.toggleMute() ? '🔇' : '🔊';
});
$('#panelToggle').addEventListener('click', () => {
  const collapsed = $('#panel').classList.toggle('collapsed');
  $('#panelToggle').textContent = collapsed ? '☰' : '✕';
});
// на телефоне меню по умолчанию свёрнуто — карта на весь экран
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
  if (!confirm('Точно спустить флаг? Твой флот утонет, а ты выбываешь из баттла.')) return;
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

  // баннер хода
  const banner = $('#turnBanner');
  if (state.status === 'lobby') banner.textContent = '⏳ Сбор флота…';
  else if (state.status === 'finished') banner.textContent = '🏁 Баттл окончен';
  else if (isMyTurn()) banner.textContent = '🔥 Твой ход!';
  else banner.textContent = `Ход: ${current?.nick ?? '…'} (№${state.turn.number})`;
  banner.classList.toggle('my-turn', isMyTurn());

  // игроки
  $('#playersList').innerHTML = state.players.map((p, i) => `
    <div class="player-row ${p.alive ? '' : 'dead'} ${state.status === 'active' && i === state.turn.idx ? 'current' : ''}">
      <span class="dot" style="background:${p.color}"></span>
      <span>${escapeHtml(p.nick)}${p.id === myId ? ' (ты)' : ''}</span>
      <span class="gold">💰${p.gold} · 🏠${p.portHp}</span>
    </div>`).join('');

  // золото в шапке панели
  $('#myGold').textContent = me && state.status !== 'lobby' ? `💰${me.gold}` : '';

  // мои действия
  const showActions = !spectator && state.status === 'active' && me?.alive;
  $('#actionsRow').classList.toggle('hidden', !showActions);
  $('#btnSurrender').classList.toggle('hidden', !showActions);
  if (showActions) {
    $('#btnShop').disabled = !isMyTurn();
    $('#btnSkip').disabled = !isMyTurn();
    $('#btnNudge').classList.toggle('hidden', isMyTurn() || state.turn.nudged);
    $('#hint').textContent = isMyTurn()
      ? 'Одно действие за ход: купить, собрать, передвинуть один корабль или выстрелить.'
      : `Ждём ход игрока ${current?.nick}…`;
    if (!$('#shopOverlay').classList.contains('hidden')) renderShop();
  } else {
    $('#shopOverlay').classList.add('hidden');
  }

  // журнал (новые сверху за счёт column-reverse)
  $('#log').innerHTML = state.log.map(l =>
    `<div class="${l.type}">${escapeHtml(l.text)}</div>`).join('');
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
        ${st.fishing ? `<span title="Улов за сбор в рыбном месте">🐟 +${st.fishing}</span>` : ''}
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
    $('#inviteUrl').textContent = location.href;
    $('#lobbySlots').innerHTML = Array.from({ length: cfg.maxPlayers }, (_, i) => {
      const p = state.players[i];
      return p
        ? `<div class="slot filled"><span class="dot" style="background:${p.color}"></span>${escapeHtml(p.nick)}</div>`
        : `<div class="slot">пусто…</div>`;
    }).join('');
    const isCreator = state.players[0]?.id === myId;
    const canStart = isCreator && state.players.length >= 2;
    $('#startBtn').classList.toggle('hidden', !isCreator);
    $('#startBtn').disabled = !canStart;
    $('#lobbyWait').textContent = isCreator
      ? (state.players.length < 2 ? 'Нужен ещё хотя бы один игрок'
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

resize();
