// Игровая логика: создание игры, лобби, валидация и применение ходов.
import { generateMap, spawnPoints } from './mapgen.js';
import {
  SHIP_TYPES, START_FLEET, START_GOLD, PORT_HP, PORT_RETURN_DMG, PORT_INCOME,
  SHIP_COLLISION_DIST, LOOT_REACH, BROADSIDE_MULT,
  PIRATE, PIRATE_DESPAWN_CHANCE, PIRATE_SPAWN_CHANCE, PIRATE_MOVE_CHANCE,
  PIRATE_BOSS_CHANCE, PIRATE_BOSS_HP
} from './ships.js';

// Палитра цветов игроков (выбираются при старте; сервер гарантирует уникальность в партии).
export const PALETTE = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad', '#e67e22', '#16a085', '#d4ac0d', '#cb3e8f'];

// выбрать цвет: вернуть запрошенный, если он из палитры и не занят другим игроком; иначе — первый свободный
function pickColor(game, color, exceptId = null) {
  const taken = c => game.players.some(p => p.id !== exceptId && p.color === c);
  if (color && PALETTE.includes(color) && !taken(color)) return color;
  return PALETTE.find(c => !taken(c)) || PALETTE[game.players.length % PALETTE.length];
}

// случайный свободный цвет (для ботов — берётся из оставшихся после игроков)
export function randomFreeColor(game) {
  const used = new Set(game.players.map(p => p.color));
  const free = PALETTE.filter(c => !used.has(c));
  const pool = free.length ? free : PALETTE;
  return pool[Math.floor(Math.random() * pool.length)];
}
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

let shipSeq = 1;

function newStats() {
  return { damageDealt: 0, shipsSunk: 0, shipsLost: 0, goldCollected: 0, shotsFired: 0 };
}

export function createGame(id, config) {
  return {
    id,
    status: 'lobby',
    config: {
      maxPlayers: Math.min(4, Math.max(2, config.maxPlayers || 2)),
      turnTimer: [0, 60, 120, 300].includes(config.turnTimer) ? config.turnTimer : 0,
      seed: (Math.random() * 2 ** 31) | 0
    },
    map: null,
    players: [], // {id, nick, color, gold, portHp, alive, placement, stats, votedSkip}
    ships: [],
    turn: { idx: 0, number: 0, deadline: null },
    log: [],
    winner: null,
    createdAt: Date.now()
  };
}

function pushLog(game, text, type = 'info') {
  game.log.push({ t: Date.now(), type, text });
  if (game.log.length > 80) game.log.splice(0, game.log.length - 80);
}

// События последнего хода — клиент проигрывает по ним анимации
// (полёт ядра, взрывы, всплывающее «+золото», плавные перемещения).
function pushEvent(game, ev) {
  (game.events ??= []).push(ev);
}

// Начало новой серии событий: клиент проигрывает анимации только при смене eventSeq.
function freshEvents(game) {
  game.events = [];
  game.eventSeq = (game.eventSeq || 0) + 1;
}

export function addPlayer(game, playerId, nick, color = null) {
  const existing = game.players.find(p => p.id === playerId);
  if (existing) {
    existing.nick = nick;
    if (color) existing.color = pickColor(game, color, playerId); // смена цвета при перезаходе
    return { ok: true, rejoined: true };
  }
  if (game.status !== 'lobby') return { ok: false, error: 'Игра уже началась' };
  if (game.players.length >= game.config.maxPlayers) return { ok: false, error: 'Все слоты заняты' };
  game.players.push({
    id: playerId, nick,
    color: pickColor(game, color),
    gold: START_GOLD, portHp: PORT_HP,
    alive: true, placement: null,
    stats: newStats()
  });
  pushLog(game, `${nick} присоединился к баттлу (${game.players.length}/${game.config.maxPlayers})`);
  return { ok: true };
}

export function startGame(game, playerId) {
  if (game.status !== 'lobby') return { ok: false, error: 'Игра уже идёт' };
  if (game.players[0]?.id !== playerId) return { ok: false, error: 'Начать игру может только создатель' };
  if (game.players.length < 2) return { ok: false, error: 'Нужно минимум 2 игрока' };

  game.map = generateMap(game.config.seed, game.players.length);
  game.players.forEach((p, idx) => {
    const base = game.map.bases[idx];
    const pts = spawnPoints(game.map, base, START_FLEET.length);
    START_FLEET.forEach((type, i) => {
      game.ships.push({
        id: 's' + (shipSeq++) + '_' + Math.random().toString(36).slice(2, 6),
        owner: idx, type,
        x: pts[i].x, y: pts[i].y,
        hp: SHIP_TYPES[type].hp
      });
    });
  });
  for (let i = 0; i < Math.min(MAX_PIRATES, game.players.length); i++) spawnPirate(game, true, false, i);
  game.status = 'active';
  game.turn = { idx: 0, number: 1, deadline: turnDeadline(game), nudged: false };
  pushLog(game, `⚔️ Баттл начался! Первым ходит ${game.players[0].nick}`, 'battle');
  return { ok: true };
}

// --- пираты ---

function randomWaterSpot(game) {
  const m = game.map;
  for (let i = 0; i < 60; i++) {
    const x = Math.round(m.w * 0.1 + Math.random() * m.w * 0.8);
    const y = Math.round(m.h * 0.1 + Math.random() * m.h * 0.8);
    if (m.bases.some(b => dist(x, y, b.x, b.y) < b.radius + 280)) continue;
    if (shipPlacementBlocked(game, x, y, null)) continue;
    return { x, y };
  }
  return null;
}

function spawnPirate(game, silent = false, allowBoss = true, slot = null) {
  const spot = randomWaterSpot(game);
  if (!spot) return;
  const boss = allowBoss && Math.random() < PIRATE_BOSS_CHANCE;
  game.ships.push({
    id: 'p' + (shipSeq++) + '_' + Math.random().toString(36).slice(2, 6),
    owner: -1, type: 'pirate',
    x: spot.x, y: spot.y,
    hp: boss ? PIRATE_BOSS_HP : PIRATE.hp,
    maxHp: boss ? PIRATE_BOSS_HP : PIRATE.hp,
    boss,
    bounty: boss
      ? (40 + Math.floor(Math.random() * 41)) * 10  // 400..800 — большой куш
      : (15 + Math.floor(Math.random() * 21)) * 10, // 150..350
    heading: Math.random() * Math.PI * 2, // пираты идут по курсу, а не мечутся
    angryAt: null,
    turnSlot: slot != null ? slot : (game.turn?.idx ?? 0), // ходит раз в цикл — после хода этого игрока
    bornTurn: game.turn?.number ?? 0                       // для минимального срока жизни (5 ходов)
  });
  if (!silent) {
    pushLog(game, boss
      ? '👑🏴‍☠️ В водах объявился ПИРАТСКИЙ БОСС с богатой добычей!'
      : '🏴‍☠️ На горизонте появился пиратский корабль!', boss ? 'battle' : 'info');
  }
}

// Шаг пирата вдоль курса; если по курсу занято — довернуть туда, где чисто.
function steerPirate(game, pir, step, baseHeading) {
  const drifts = [
    (Math.random() - 0.5) * 0.3,                      // лёгкое отклонение
    0.6, -0.6, 1.1, -1.1, 1.7, -1.7, 2.4, -2.4, Math.PI // развороты, если упёрся
  ];
  for (const d of drifts) {
    const ang = baseHeading + d;
    const nx = Math.round(pir.x + Math.cos(ang) * step);
    const ny = Math.round(pir.y + Math.sin(ang) * step);
    if (!shipPlacementBlocked(game, nx, ny, pir.id)) {
      pushEvent(game, { type: 'move', shipId: pir.id, fx: pir.x, fy: pir.y, tx: nx, ty: ny });
      pir.x = nx; pir.y = ny;
      pir.heading = ang;
      return true;
    }
  }
  return false;
}

const MAX_PIRATES = 2; // не больше двух пиратов на карте одновременно

const nearestShip = (pir, list) =>
  list.reduce((a, b) => dist(pir.x, pir.y, b.x, b.y) < dist(pir.x, pir.y, a.x, a.y) ? b : a);

// Действие пирата, если он ВОВЛЕЧЁН (рядом есть корабли): атака/преследование/бегство.
// Возвращает true, если пират занят боем — тогда он НЕ исчезает и не дрейфует просто так.
function pirateAct(game, pir) {
  const D = PIRATE.dmg, FR = PIRATE.fireRange, MV = PIRATE.move;
  // рыбацкие баркасы пиратам не интересны — не атакуют, не «вовлекаются», не убегают от них
  const all = game.ships.filter(s => s.owner >= 0 && game.players[s.owner]?.alive && !SHIP_TYPES[s.type].fishing);
  if (!all.length) return false;

  // «вовлечён»: рядом корабль в зоне своего хода или огня (+20%) — пирату не дадут раствориться
  const engaged = all.some(s => {
    const st = SHIP_TYPES[s.type];
    return dist(pir.x, pir.y, s.x, s.y) <= Math.max(st.move, st.fireRange) * 1.2;
  });
  if (!engaged) return false; // свободен — обычная жизнь (дрейф/туман) снаружи

  // суммарный урон, который пират может схлопотать прямо сейчас (кто достаёт его огнём)
  const incoming = all.filter(s => SHIP_TYPES[s.type].dmg > 0 &&
    dist(pir.x, pir.y, s.x, s.y) <= SHIP_TYPES[s.type].fireRange)
    .reduce((sum, s) => sum + SHIP_TYPES[s.type].dmg, 0);

  // цели в радиусе огня пирата: добиваемые в приоритете, иначе слабейшая по HP
  const inRange = all.filter(s => dist(pir.x, pir.y, s.x, s.y) <= FR);
  let target = null;
  const killable = inRange.filter(s => s.hp <= D);
  if (killable.length) target = killable.reduce((a, b) => a.hp < b.hp ? b : a); // добьём любого — берём пожирнее (по награде неважно, по HP)
  else if (inRange.length) target = inRange.reduce((a, b) => a.hp < b.hp ? a : b);

  if (target) {
    // ДЕРЁМСЯ если можем добить ОДНИМ выстрелом или переживём ответный огонь окружения.
    // (раньше полумёртвый корабль мог «отпугнуть» пирата — теперь добиваемого он бьёт всегда)
    const willKill = target.hp <= D;
    if (willKill || pir.hp > incoming) {
      target.hp -= D;
      pir.angryAt = target.owner;
      pushEvent(game, { type: 'shot', fx: pir.x, fy: pir.y, tx: target.x, ty: target.y, dmg: D });
      pushLog(game, `🏴‍☠️ Пираты атакуют ${SHIP_TYPES[target.type].name} игрока ${game.players[target.owner].nick} (−${D} HP)`, 'battle');
      if (target.hp <= 0) sinkShip(game, target, null);
      return true;
    }
    // не добить и опасно — уходим от ближайшего корабля
    const t = nearestShip(pir, all);
    steerPirate(game, pir, MV, Math.atan2(pir.y - t.y, pir.x - t.x));
    return true;
  }

  // цели в радиусе огня нет, но рядом наседает корабль → отходим (не гоняемся за флотом —
  // иначе пираты вечно грызут и партия не сходится). Бьёт он тех, кто сам зашёл в радиус.
  const near = nearestShip(pir, all);
  steerPirate(game, pir, MV, Math.atan2(pir.y - near.y, pir.x - near.x));
  return true;
}

// Пираты живут своей жизнью. ВАЖНО: каждый пират ходит РАЗ В ЦИКЛ — только после хода
// «своего» игрока (turnSlot), иначе при 3-4 игроках он успевал бы 3-4 раза за круг.
function movePirates(game) {
  const cur = game.turn.idx; // игрок, чей ход только что закончился
  const aliveIdx = game.players.map((p, i) => (p.alive ? i : -1)).filter(i => i >= 0);
  for (const pir of [...game.ships.filter(s => s.owner === -1)]) {
    // привязка к выбывшему/несуществующему слоту → переякорить на текущего
    if (pir.turnSlot == null || !game.players[pir.turnSlot]?.alive) pir.turnSlot = cur;
    if (pir.turnSlot !== cur) continue; // не его слот в этом цикле — пропускаем

    if (pirateAct(game, pir)) continue; // вовлечён в бой/бегство — без исчезновения

    pir.angryAt = null;
    // не исчезать раньше 5 ходов с момента появления
    if (game.turn.number - (pir.bornTurn || 0) >= 5 && Math.random() < PIRATE_DESPAWN_CHANCE) {
      game.ships = game.ships.filter(s => s.id !== pir.id);
      pushLog(game, '🌫 Пиратский корабль растворился в тумане…');
      continue;
    }
    if (Math.random() > PIRATE_MOVE_CHANCE) continue;
    const step = 35 + Math.random() * (PIRATE.move - 35);
    steerPirate(game, pir, step, pir.heading ?? (pir.heading = Math.random() * Math.PI * 2));
  }
  // респаун раз в круг (когда отходил первый живой игрок), привязываем к случайному живому слоту
  if (cur === aliveIdx[0] &&
      game.ships.filter(s => s.owner === -1).length < MAX_PIRATES &&
      Math.random() < PIRATE_SPAWN_CHANCE) {
    spawnPirate(game, false, true, aliveIdx[Math.floor(Math.random() * aliveIdx.length)]);
  }
}

function turnDeadline(game) {
  return game.config.turnTimer > 0 ? Date.now() + game.config.turnTimer * 1000 : null;
}

function currentPlayer(game) {
  return game.players[game.turn.idx];
}

function advanceTurn(game) {
  movePirates(game);
  const n = game.players.length;
  let next = game.turn.idx;
  for (let i = 0; i < n; i++) {
    next = (next + 1) % n;
    if (game.players[next].alive) break;
  }
  game.turn.idx = next;
  game.turn.number++;
  game.turn.deadline = turnDeadline(game);
  game.turn.nudged = false;
  // порт приносит немного золота в начале хода — чтобы никто не застрял на нуле.
  // в аномально затянувшейся партии (дольше нормальной людской) доход выключаем —
  // «внезапная смерть», чтобы экономика истощалась и игра сходилась к финалу.
  const np = game.players[next];
  if (np?.alive && game.turn.number <= n * 80) np.gold += PORT_INCOME;

  // пассивная рыбалка: каждый баркас игрока, стоящий в рыбном месте, сам приносит улов
  // в начале его хода — действие на это не тратится.
  if (np?.alive) {
    let catch_ = 0;
    for (const s of game.ships.filter(s => s.owner === next && SHIP_TYPES[s.type].fishing > 0)) {
      if (game.map.fishZones.some(z => dist(s.x, s.y, z.x, z.y) <= z.radius)) {
        catch_ += SHIP_TYPES[s.type].fishing;
        pushEvent(game, { type: 'gold', x: s.x, y: s.y, amount: SHIP_TYPES[s.type].fishing });
      }
    }
    if (catch_) {
      np.gold += catch_;
      np.stats.goldCollected += catch_;
      pushLog(game, `🐟 Рыбаки ${np.nick} наловили рыбы: +${catch_} зол.`);
    }
  }
}

export function shipPlacementBlocked(game, x, y, ignoreShipId) {
  const m = game.map;
  if (x < 12 || y < 12 || x > m.w - 12 || y > m.h - 12) return 'За краем карты';
  for (const b of m.bases) if (dist(x, y, b.x, b.y) < b.radius + 14) return 'Нельзя встать на остров';
  for (const o of m.lootIslands) if (dist(x, y, o.x, o.y) < o.radius + 14) return 'Нельзя встать на остров';
  for (const s of game.ships) {
    if (s.id !== ignoreShipId && dist(x, y, s.x, s.y) < SHIP_COLLISION_DIST) return 'Слишком близко к другому кораблю';
  }
  return null;
}

function sinkShip(game, ship, killer) {
  game.ships = game.ships.filter(s => s.id !== ship.id);
  // ship-данные нужны клиенту: тонущий корабль рисуется, пока до него летит ядро
  pushEvent(game, {
    type: 'explosion', x: ship.x, y: ship.y, big: true,
    shipId: ship.id, ship: { type: ship.type, owner: ship.owner, bounty: ship.bounty }
  });
  if (ship.owner === -1) {
    killer.gold += ship.bounty;
    killer.stats.shipsSunk++;
    killer.stats.goldCollected += ship.bounty;
    pushEvent(game, { type: 'gold', x: ship.x, y: ship.y, amount: ship.bounty });
    pushLog(game, `💥 Пиратский корабль потоплен! ${killer.nick} забирает награду ${ship.bounty} золота`, 'battle');
    return;
  }
  const owner = game.players[ship.owner];
  owner.stats.shipsLost++;
  if (killer) {
    const plunder = Math.round(SHIP_TYPES[ship.type].price * 0.5);
    killer.gold += plunder;
    killer.stats.shipsSunk++;
    killer.stats.goldCollected += plunder;
    pushEvent(game, { type: 'gold', x: ship.x, y: ship.y, amount: plunder });
    pushLog(game, `💥 ${SHIP_TYPES[ship.type].name} игрока ${owner.nick} потоплен! ${killer.nick} лутает ${plunder} золота с обломков`, 'battle');
  } else {
    pushLog(game, `💥 ${SHIP_TYPES[ship.type].name} игрока ${owner.nick} потоплен пиратами!`, 'battle');
  }
}

// killer = null означает добровольную сдачу.
function eliminatePlayer(game, victimIdx, killer) {
  const victim = game.players[victimIdx];
  victim.alive = false;
  victim.placement = game.players.filter(p => p.alive).length + 1;
  if (killer) {
    const tribute = Math.floor(victim.gold / 2);
    victim.gold -= tribute;
    killer.gold += tribute;
    killer.stats.goldCollected += tribute;
    const base = game.map.bases[victimIdx];
    pushEvent(game, { type: 'explosion', x: base.x, y: base.y, big: true });
    pushEvent(game, { type: 'gold', x: base.x, y: base.y, amount: tribute });
    pushLog(game, `🏴‍☠️ Порт игрока ${victim.nick} разрушен! ${killer.nick} забирает ${tribute} золота. ${victim.nick} выбывает`, 'battle');
  } else {
    pushLog(game, `🏳️ ${victim.nick} спускает флаг и покидает баттл`, 'battle');
  }
  // Флот побеждённого уходит на дно вместе с портом.
  game.ships = game.ships.filter(s => s.owner !== victimIdx);

  const alive = game.players.filter(p => p.alive);
  if (alive.length === 1) {
    alive[0].placement = 1;
    game.winner = game.players.indexOf(alive[0]);
    game.status = 'finished';
    game.turn.deadline = null;
    pushLog(game, `👑 ${alive[0].nick} побеждает в баттле!`, 'battle');
  }
}

// Аварийное завершение партии: выбивает слабейших живых, пока не останется один —
// победитель. Используется, если авто-дорешка за ботов упёрлась в лимит ходов.
export function forceFinish(game) {
  const powerOf = i => game.ships.filter(s => s.owner === i)
    .reduce((a, x) => a + x.hp + SHIP_TYPES[x.type].dmg, 0) + (game.players[i].portHp || 0);
  let guard = 0;
  while (game.status === 'active' && game.players.filter(p => p.alive).length > 1 && guard++ < 8) {
    const weakest = game.players
      .map((p, i) => ({ i, alive: p.alive }))
      .filter(x => x.alive)
      .sort((a, b) => powerOf(a.i) - powerOf(b.i))[0];
    eliminatePlayer(game, weakest.i, null); // как сдача; при alive===1 объявит победителя
  }
}

// Смена цвета в лобби (валидируем: из палитры и не занят другим игроком).
export function setColor(game, playerId, color) {
  if (game.status !== 'lobby') return { ok: false, error: 'Цвет можно менять только в лобби' };
  const p = game.players.find(x => x.id === playerId);
  if (!p) return { ok: false, error: 'Вы не участник' };
  if (!PALETTE.includes(color)) return { ok: false, error: 'Неизвестный цвет' };
  if (game.players.some(x => x.id !== playerId && x.color === color)) return { ok: false, error: 'Цвет уже занят' };
  p.color = color;
  return { ok: true };
}

// Добровольная сдача (или выход из лобби).
export function leaveGame(game, playerId) {
  if (game.status === 'lobby') {
    const idx = game.players.findIndex(p => p.id === playerId);
    if (idx === -1) return { ok: false, error: 'Вы не участник' };
    const [left] = game.players.splice(idx, 1);
    // цвета НЕ переиндексируем — каждый сохраняет выбранный; освободившийся просто доступен снова
    pushLog(game, `🚪 ${left.nick} покинул лобби`);
    return { ok: true };
  }
  if (game.status !== 'active') return { ok: false, error: 'Игра уже завершена' };
  let idx = game.players.findIndex(p => p.id === playerId);
  // хотсит: «сдаться» сдаёт того, чей сейчас ход
  if (idx === -1 && game.config.hotseat && playerId === game.hotseatOwner) idx = game.turn.idx;
  if (idx === -1) return { ok: false, error: 'Вы не участник' };
  if (!game.players[idx].alive) return { ok: false, error: 'Вы уже выбыли' };
  const wasTheirTurn = game.turn.idx === idx;
  freshEvents(game);
  eliminatePlayer(game, idx, null);
  if (game.status === 'active' && wasTheirTurn) advanceTurn(game);
  return { ok: true };
}

// «Поторопить» AFK-игрока: письмо + жёсткие 10 минут на ход.
export const NUDGE_MS = 10 * 60 * 1000;
export function nudge(game, playerId) {
  if (game.status !== 'active') return { ok: false, error: 'Игра не активна' };
  if (game.config.hotseat) return { ok: false, error: 'В игре на одном устройстве это не нужно' };
  const requester = game.players.find(p => p.id === playerId);
  if (!requester || !requester.alive) return { ok: false, error: 'Вы не участник' };
  const targetIdx = game.turn.idx;
  if (game.players[targetIdx].id === playerId) return { ok: false, error: 'Сейчас ваш ход' };
  if (game.turn.nudged) return { ok: false, error: 'Игрока уже поторопили — таймер идёт' };
  if (game.turn.deadline && game.turn.deadline - Date.now() <= NUDGE_MS)
    return { ok: false, error: 'Таймер хода и так меньше 10 минут' };
  game.turn.nudged = true;
  game.turn.deadline = Date.now() + NUDGE_MS;
  pushLog(game, `📯 ${requester.nick} торопит игрока ${game.players[targetIdx].nick} — 10 минут на ход!`);
  return { ok: true, targetIdx };
}

// Применение хода. action.type: buy | collect | move | attack | skip
export function applyAction(game, playerId, action) {
  if (game.status !== 'active') return { ok: false, error: 'Игра не активна' };
  let pIdx = game.players.findIndex(p => p.id === playerId);
  // хотсит: владелец устройства ходит за того, чья очередь
  if (pIdx === -1 && game.config.hotseat && playerId === game.hotseatOwner) pIdx = game.turn.idx;
  if (pIdx === -1) return { ok: false, error: 'Вы не участник игры' };
  if (pIdx !== game.turn.idx) return { ok: false, error: 'Сейчас не ваш ход' };
  const player = game.players[pIdx];
  freshEvents(game); // события этого хода для анимаций на клиенте

  switch (action.type) {
    case 'buy': {
      const list = Array.isArray(action.ships) ? action.ships : [];
      if (!list.length) return { ok: false, error: 'Выберите корабли для покупки' };
      const cost = list.reduce((sum, t) => sum + (SHIP_TYPES[t]?.price ?? 1e9), 0);
      if (cost > player.gold) return { ok: false, error: 'Не хватает золота' };
      const base = game.map.bases[pIdx];
      const bought = [];
      for (const type of list) {
        const spot = findFreeSpotNearBase(game, base);
        if (!spot) return { ok: false, error: 'Возле порта нет места для новых кораблей' };
        game.ships.push({
          id: 's' + (shipSeq++) + '_' + Math.random().toString(36).slice(2, 6),
          owner: pIdx, type, x: spot.x, y: spot.y, hp: SHIP_TYPES[type].hp
        });
        bought.push(SHIP_TYPES[type].name);
      }
      player.gold -= cost;
      pushLog(game, `🛠 ${player.nick} покупает: ${bought.join(', ')} (−${cost} зол.)`);
      break;
    }

    case 'collect': {
      let gained = 0;
      const notes = [];
      // Рыбалка теперь пассивная (капает в advanceTurn). Тут — только клад с островов:
      // любой корабль, дотянувшийся до нелутанного острова.
      for (const isl of game.map.lootIslands.filter(i => !i.looted)) {
        const reach = game.ships.some(s => s.owner === pIdx &&
          dist(s.x, s.y, isl.x, isl.y) <= isl.radius + LOOT_REACH);
        if (reach) {
          isl.looted = true;
          gained += isl.loot;
          notes.push(`🏝 клад ${isl.loot}`);
          pushEvent(game, { type: 'gold', x: isl.x, y: isl.y, amount: isl.loot });
        }
      }
      if (!gained) return { ok: false, error: 'Нечего собирать: нет кораблей у нелутанных островов с кладом' };
      player.gold += gained;
      player.stats.goldCollected += gained;
      pushLog(game, `💰 ${player.nick} собирает добычу: +${gained} зол. (${notes.join(', ')})`);
      break;
    }

    case 'move': {
      const ship = game.ships.find(s => s.id === action.shipId);
      if (!ship || ship.owner !== pIdx) return { ok: false, error: 'Это не ваш корабль' };
      const x = Math.round(action.x), y = Math.round(action.y);
      const range = SHIP_TYPES[ship.type].move;
      if (dist(ship.x, ship.y, x, y) > range + 0.5) return { ok: false, error: 'Слишком далеко: линейка не дотягивается' };
      const blocked = shipPlacementBlocked(game, x, y, ship.id);
      if (blocked) return { ok: false, error: blocked };
      pushEvent(game, { type: 'move', shipId: ship.id, fx: ship.x, fy: ship.y, tx: x, ty: y });
      ship.x = x; ship.y = y;
      pushLog(game, `🧭 ${player.nick} ведёт ${SHIP_TYPES[ship.type].name} на новую позицию`);
      break;
    }

    case 'attack': {
      const ship = game.ships.find(s => s.id === action.shipId);
      if (!ship || ship.owner !== pIdx) return { ok: false, error: 'Это не ваш корабль' };
      const st = SHIP_TYPES[ship.type];

      if (action.targetType === 'ship') {
        const target = game.ships.find(s => s.id === action.targetId);
        if (!target || target.owner === pIdx) return { ok: false, error: 'Неверная цель' };
        if (dist(ship.x, ship.y, target.x, target.y) > st.fireRange + 0.5)
          return { ok: false, error: 'Цель вне дальности стрельбы' };
        target.hp -= st.dmg;
        player.stats.shotsFired++;
        player.stats.damageDealt += st.dmg;
        pushEvent(game, { type: 'shot', fx: ship.x, fy: ship.y, tx: target.x, ty: target.y, dmg: st.dmg });
        const targetName = target.owner === -1
          ? 'пиратскому кораблю'
          : `${SHIP_TYPES[target.type].name} игрока ${game.players[target.owner].nick}`;
        pushLog(game, `🔥 ${player.nick}: ${st.name} бьёт по ${targetName} (−${st.dmg} HP)`, 'battle');
        if (target.hp <= 0) sinkShip(game, target, player);
        else if (target.owner === -1) target.angryAt = pIdx; // пираты запоминают обидчика
      } else if (action.targetType === 'port') {
        const targetIdx = action.targetId;
        const victim = game.players[targetIdx];
        if (!victim || targetIdx === pIdx || !victim.alive) return { ok: false, error: 'Неверная цель' };
        const base = game.map.bases[targetIdx];
        if (dist(ship.x, ship.y, base.x, base.y) > st.fireRange + base.radius * 0.5)
          return { ok: false, error: 'Порт вне дальности стрельбы' };
        const portDmg = Math.round(st.dmg * (st.portBonus || 1)); // линкор бьёт по порту сильнее (portBonus)
        victim.portHp -= portDmg;
        player.stats.shotsFired++;
        player.stats.damageDealt += portDmg;
        pushEvent(game, { type: 'shot', fx: ship.x, fy: ship.y, tx: base.x, ty: base.y, dmg: portDmg });
        pushLog(game, `🔥 ${player.nick} обстреливает порт игрока ${victim.nick} (−${portDmg} HP, осталось ${Math.max(0, victim.portHp)})`, 'battle');
        if (victim.portHp <= 0) {
          victim.portHp = 0;
          eliminatePlayer(game, targetIdx, player);
        } else {
          // порт огрызается: ответный залп по атакующему кораблю
          ship.hp -= PORT_RETURN_DMG;
          pushEvent(game, { type: 'shot', fx: base.x, fy: base.y, tx: ship.x, ty: ship.y, dmg: PORT_RETURN_DMG });
          pushLog(game, `🏰 Порт игрока ${victim.nick} огрызается по ${SHIP_TYPES[ship.type].name} (−${PORT_RETURN_DMG} HP)`, 'battle');
          if (ship.hp <= 0) sinkShip(game, ship, victim); // защитник забирает обломки
        }
      } else {
        return { ok: false, error: 'Неизвестная цель' };
      }
      break;
    }

    case 'broadside': {
      const ship = game.ships.find(s => s.id === action.shipId);
      if (!ship || ship.owner !== pIdx) return { ok: false, error: 'Это не ваш корабль' };
      const st = SHIP_TYPES[ship.type];
      if (!st.broadside) return { ok: false, error: 'Этот корабль не умеет залп' };
      // только вражеские БОЕВЫЕ корабли в радиусе (рыбацкие баркасы залп не трогает; пираты — да)
      const targets = game.ships.filter(t =>
        t.owner !== pIdx &&
        !(t.owner >= 0 && !game.players[t.owner]?.alive) &&
        (t.owner === -1 || !SHIP_TYPES[t.type].fishing) &&
        dist(ship.x, ship.y, t.x, t.y) <= st.fireRange + 0.5);
      if (targets.length < 2) return { ok: false, error: 'Залп — когда в радиусе 2+ вражеских БОЕВЫХ корабля' };
      const dmg = Math.round(st.dmg * BROADSIDE_MULT);
      const hits = [];
      const toSink = [];
      for (const t of targets) {
        t.hp -= dmg;
        player.stats.damageDealt += dmg;
        hits.push({ tx: t.x, ty: t.y, dmg });
        if (t.hp <= 0) toSink.push(t);
        else if (t.owner === -1) t.angryAt = pIdx;
      }
      player.stats.shotsFired++;
      pushEvent(game, { type: 'broadside', fx: ship.x, fy: ship.y, hits });
      for (const t of toSink) sinkShip(game, t, player); // взрывы — после полёта залпа
      pushLog(game, `💥 ${player.nick}: ${st.name} даёт бортовой залп по ${targets.length} целям` +
        (toSink.length ? ` — потоплено ${toSink.length}!` : '') + ` (−${dmg} каждой)`, 'battle');
      break;
    }

    case 'skip':
      pushLog(game, `⏭ ${player.nick} пропускает ход`);
      break;

    default:
      return { ok: false, error: 'Неизвестное действие' };
  }

  if (game.status === 'active') advanceTurn(game);
  return { ok: true };
}

function findFreeSpotNearBase(game, base) {
  // корабли встают со стороны базы, ОБРАЩЁННОЙ К ЦЕНТРУ карты (а не всегда на восток) —
  // иначе игроку в правом углу флот спавнило в угол, в стену. Перебор веером от направления
  // к центру: 0, ±шаг, ±2·шаг… — первое свободное место всегда на «центровой» стороне.
  const cx = game.map.w / 2, cy = game.map.h / 2;
  const toCenter = Math.atan2(cy - base.y, cx - base.x);
  const N = 14, step = (Math.PI * 2) / N;
  for (let ring = 0; ring < 5; ring++) {
    const r = base.radius + 45 + ring * 34;
    for (let i = 0; i < N; i++) {
      const ang = toCenter + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * step;
      const x = Math.round(base.x + Math.cos(ang) * r);
      const y = Math.round(base.y + Math.sin(ang) * r);
      if (!shipPlacementBlocked(game, x, y, null)) return { x, y };
    }
  }
  return null;
}

// Автопропуск по таймеру.
export function timeoutTurn(game) {
  if (game.status !== 'active' || !game.turn.deadline) return false;
  if (Date.now() < game.turn.deadline) return false;
  freshEvents(game);
  pushLog(game, `⏰ Время вышло — ход игрока ${currentPlayer(game).nick} пропущен`);
  advanceTurn(game);
  return true;
}

// Состояние для отправки клиентам (без приватных данных).
// viewerPid — кому шлём: чужое золото скрываем (true-приватность). В хотсите
// все цифры идут владельцу, а на клиенте показывается только текущий игрок.
// На финале (баттл окончен) всё раскрываем — это итоговая таблица.
export function publicState(game, viewerPid) {
  const reveal = game.config.hotseat || game.status === 'finished';
  return {
    id: game.id,
    status: game.status,
    config: game.config,
    map: game.map,
    players: game.players.map(p => ({
      id: p.id, nick: p.nick, color: p.color,
      gold: (reveal || p.id === viewerPid) ? p.gold : null,
      portHp: p.portHp, alive: p.alive, placement: p.placement,
      stats: p.stats, isBot: p.isBot || false
    })),
    ships: game.ships,
    turn: game.turn,
    log: game.log,
    winner: game.winner,
    events: game.events || [],
    eventSeq: game.eventSeq || 0,
    lootReach: LOOT_REACH,
    portMax: PORT_HP,
    palette: PALETTE,
    shipTypes: { ...SHIP_TYPES, pirate: PIRATE }
  };
}
