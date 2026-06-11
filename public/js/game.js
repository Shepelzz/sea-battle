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
  state = s;
  // сброс выбора, если корабль исчез или ход не наш
  if (selectedShipId && !state.ships.find(x => x.id === selectedShipId)) deselect();
  if (!isMyTurn()) deselect();
  render();
});

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
    else { basket = {}; deselect(); }
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

function resize() {
  const wrap = $('#mapWrap');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = wrap.clientWidth * dpr;
  canvas.height = wrap.clientHeight * dpr;
  canvas.style.width = wrap.clientWidth + 'px';
  canvas.style.height = wrap.clientHeight + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (state) render();
}
window.addEventListener('resize', resize);

function computeView() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  view.scale = Math.min(w / state.map.w, h / state.map.h) * 0.97;
  view.ox = (w - state.map.w * view.scale) / 2;
  view.oy = (h - state.map.h * view.scale) / 2;
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
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

  // лист: фон + клетка (1 клетка = 40 ед.)
  ctx.fillStyle = '#fdfbf3';
  ctx.fillRect(sx(0), sy(0), m.w * view.scale, m.h * view.scale);
  ctx.strokeStyle = 'rgba(116,160,199,.35)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= m.w; x += 40) {
    ctx.beginPath(); ctx.moveTo(sx(x), sy(0)); ctx.lineTo(sx(x), sy(m.h)); ctx.stroke();
  }
  for (let y = 0; y <= m.h; y += 40) {
    ctx.beginPath(); ctx.moveTo(sx(0), sy(y)); ctx.lineTo(sx(m.w), sy(y)); ctx.stroke();
  }
  // рамка листа
  ctx.strokeStyle = '#6b6f76';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(sx(0), sy(0), m.w * view.scale, m.h * view.scale);

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

  // корабли
  for (const s of state.ships) {
    drawShip(s, s.id === selectedShipId);
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
    // призрак корабля
    ctx.globalAlpha = 0.45;
    drawShip({ ...sel, x: hoverPt.x, y: hoverPt.y }, false);
    ctx.globalAlpha = 1;
    // подпись расстояния в клетках
    const mx = (sx(sel.x) + sx(hoverPt.x)) / 2, my = (sy(sel.y) + sy(hoverPt.y)) / 2;
    ctx.font = 'bold 14px Neucha, cursive';
    ctx.fillStyle = ok ? '#2b3a55' : '#c0392b';
    ctx.textAlign = 'center';
    ctx.fillText(`${(d / 40).toFixed(1)} кл.`, mx, my - 8);
  }
}

function drawShip(s, selected) {
  const isPirate = s.owner === -1;
  const p = isPirate ? null : state.players[s.owner];
  const st = ST(s.type);
  const px = sx(s.x), py = sy(s.y);
  const size = Math.max(9, (10 + st.hp / 28) * view.scale * 1.6);
  const hullColor = isPirate ? '#33363c' : p.color;

  if (selected) {
    ctx.beginPath();
    ctx.arc(px, py, size + 6, 0, Math.PI * 2);
    ctx.strokeStyle = '#2b3a55';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // корпус — «нарисованная» лодочка
  ctx.beginPath();
  ctx.moveTo(px - size, py);
  ctx.quadraticCurveTo(px, py + size * 1.1, px + size, py);
  ctx.lineTo(px + size * 0.7, py - size * 0.45);
  ctx.lineTo(px - size * 0.7, py - size * 0.45);
  ctx.closePath();
  ctx.fillStyle = hullColor;
  ctx.fill();
  ctx.strokeStyle = '#2b3a55';
  ctx.lineWidth = 1.4;
  ctx.stroke();
  // мачта с парусом
  ctx.beginPath();
  ctx.moveTo(px, py - size * 0.45);
  ctx.lineTo(px, py - size * 1.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px, py - size * 1.5);
  ctx.quadraticCurveTo(px + size * 0.9, py - size * 1.1, px, py - size * 0.5);
  ctx.closePath();
  ctx.fillStyle = isPirate ? '#33363c' : '#fdfbf3';
  ctx.fill();
  ctx.stroke();

  if (isPirate) {
    ctx.font = `${Math.max(10, 13 * view.scale * 1.6)}px serif`;
    ctx.textAlign = 'center';
    ctx.fillText('🏴‍☠️', px, py - size * 1.55);
    ctx.font = `bold ${Math.max(10, 12 * view.scale * 1.6)}px Neucha, cursive`;
    ctx.fillStyle = '#2b3a55';
    ctx.fillText(`💰${s.bounty}`, px, py + size * 0.6 + 22);
  }

  hpBar(px, py + size * 0.6 + 4, size * 2, s.hp / st.hp, '#27ae60');
}

// ============ ВЗАИМОДЕЙСТВИЕ С КАРТОЙ ============
canvas.addEventListener('mousemove', e => {
  if (!state || !state.map) return;
  const r = canvas.getBoundingClientRect();
  hoverPt = toMap(e.clientX - r.left, e.clientY - r.top);
  if (mode === 'move') render();
});

canvas.addEventListener('click', e => {
  if (!state || !state.map || state.status !== 'active') return;
  const r = canvas.getBoundingClientRect();
  const pt = toMap(e.clientX - r.left, e.clientY - r.top);

  const clickedShip = state.ships.find(s => dist(pt.x, pt.y, s.x, s.y) < 26);

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
    $('#shipActions').classList.remove('hidden');
    $('#shipActionsTitle').textContent = ST(clickedShip.type).icon + ' ' + ST(clickedShip.type).name;
    render();
  } else {
    deselect();
  }
});

$('#btnMove').addEventListener('click', () => { mode = 'move'; render(); });
$('#btnFire').addEventListener('click', () => { mode = 'attack'; render(); });
$('#btnCancel').addEventListener('click', deselect);

$('#btnCollect').addEventListener('click', () => sendAction({ type: 'collect' }));
$('#btnSkip').addEventListener('click', () => sendAction({ type: 'skip' }));
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

  // мои действия
  const showActions = !spectator && state.status === 'active' && me?.alive;
  $('#myActions').classList.toggle('hidden', !showActions);
  $('#shopBox').classList.toggle('hidden', !showActions);
  if (showActions) {
    $('#btnCollect').disabled = !isMyTurn();
    $('#btnSkip').disabled = !isMyTurn();
    $('#btnBuy').disabled = !isMyTurn();
    $('#btnNudge').classList.toggle('hidden', isMyTurn() || state.turn.nudged);
    $('#hint').textContent = isMyTurn()
      ? 'Одно действие за ход: купить, собрать, передвинуть один корабль или выстрелить.'
      : `Ждём ход игрока ${current?.nick}…`;
    renderShop(me);
  }

  // журнал (новые сверху за счёт column-reverse)
  $('#log').innerHTML = state.log.map(l =>
    `<div class="${l.type}">${escapeHtml(l.text)}</div>`).join('');
}

function renderShop(me) {
  const total = Object.entries(basket).reduce((s, [t, n]) => s + ST(t).price * n, 0);
  $('#shopList').innerHTML = Object.entries(state.shipTypes).filter(([, st]) => !st.npc).map(([t, st]) => `
    <div class="shop-item" title="${st.desc}">
      <span class="nm">${st.icon} ${st.name} <span class="muted">· ${st.price}з · ${st.hp}хп · ${st.dmg}дмг${st.fishing ? ' · 🐟' : ''}</span></span>
      <button class="small" data-shop="${t}" data-d="-1">−</button>
      <span class="cnt">${basket[t] || 0}</span>
      <button class="small" data-shop="${t}" data-d="1">+</button>
    </div>`).join('');
  $('#shopTotal').textContent = total ? `Итого: ${total} из ${me.gold} зол.` : `В казне: ${me.gold} зол.`;
  $('#shopTotal').style.color = total > me.gold ? '#c0392b' : '';
  document.querySelectorAll('[data-shop]').forEach(b => b.addEventListener('click', () => {
    const t = b.dataset.shop;
    basket[t] = Math.max(0, (basket[t] || 0) + (+b.dataset.d));
    if (!basket[t]) delete basket[t];
    renderShop(me);
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
