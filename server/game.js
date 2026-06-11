// Игровая логика: создание игры, лобби, валидация и применение ходов.
import { generateMap, spawnPoints } from './mapgen.js';
import {
  SHIP_TYPES, START_FLEET, START_GOLD, PORT_HP,
  SHIP_COLLISION_DIST, LOOT_REACH,
  PIRATE, PIRATE_DESPAWN_CHANCE, PIRATE_SPAWN_CHANCE, PIRATE_MOVE_CHANCE
} from './ships.js';

const COLORS = ['#c0392b', '#2980b9', '#27ae60', '#8e44ad'];
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

export function addPlayer(game, playerId, nick) {
  const existing = game.players.find(p => p.id === playerId);
  if (existing) { existing.nick = nick; return { ok: true, rejoined: true }; }
  if (game.status !== 'lobby') return { ok: false, error: 'Игра уже началась' };
  if (game.players.length >= game.config.maxPlayers) return { ok: false, error: 'Все слоты заняты' };
  game.players.push({
    id: playerId, nick,
    color: COLORS[game.players.length],
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
  for (let i = 0; i < game.players.length; i++) spawnPirate(game, true);
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

function spawnPirate(game, silent = false) {
  const spot = randomWaterSpot(game);
  if (!spot) return;
  game.ships.push({
    id: 'p' + (shipSeq++) + '_' + Math.random().toString(36).slice(2, 6),
    owner: -1, type: 'pirate',
    x: spot.x, y: spot.y,
    hp: PIRATE.hp,
    bounty: (8 + Math.floor(Math.random() * 19)) * 10 // 80..260 золота
  });
  if (!silent) pushLog(game, '🏴‍☠️ На горизонте появился пиратский корабль!');
}

// Пираты живут своей жизнью между ходами игроков.
function movePirates(game) {
  const maxPirates = game.players.length;
  for (const pir of [...game.ships.filter(s => s.owner === -1)]) {
    if (Math.random() < PIRATE_DESPAWN_CHANCE) {
      game.ships = game.ships.filter(s => s.id !== pir.id);
      pushLog(game, '🌫 Пиратский корабль растворился в тумане…');
      continue;
    }
    if (Math.random() > PIRATE_MOVE_CHANCE) continue;
    const step = 30 + Math.random() * (PIRATE.move - 30);
    const startAng = Math.random() * Math.PI * 2;
    for (let i = 0; i < 8; i++) {
      const ang = startAng + (i / 8) * Math.PI * 2;
      const nx = Math.round(pir.x + Math.cos(ang) * step);
      const ny = Math.round(pir.y + Math.sin(ang) * step);
      if (!shipPlacementBlocked(game, nx, ny, pir.id)) { pir.x = nx; pir.y = ny; break; }
    }
  }
  if (game.ships.filter(s => s.owner === -1).length < maxPirates &&
      Math.random() < PIRATE_SPAWN_CHANCE) {
    spawnPirate(game);
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
}

function shipPlacementBlocked(game, x, y, ignoreShipId) {
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
  if (ship.owner === -1) {
    killer.gold += ship.bounty;
    killer.stats.shipsSunk++;
    killer.stats.goldCollected += ship.bounty;
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
    pushLog(game, `💥 ${SHIP_TYPES[ship.type].name} игрока ${owner.nick} потоплен! ${killer.nick} лутает ${plunder} золота с обломков`, 'battle');
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

// Добровольная сдача (или выход из лобби).
export function leaveGame(game, playerId) {
  if (game.status === 'lobby') {
    const idx = game.players.findIndex(p => p.id === playerId);
    if (idx === -1) return { ok: false, error: 'Вы не участник' };
    const [left] = game.players.splice(idx, 1);
    // освобождаем цвета по порядку
    const COLORS_ALL = COLORS;
    game.players.forEach((p, i) => { p.color = COLORS_ALL[i]; });
    pushLog(game, `🚪 ${left.nick} покинул лобби`);
    return { ok: true };
  }
  if (game.status !== 'active') return { ok: false, error: 'Игра уже завершена' };
  const idx = game.players.findIndex(p => p.id === playerId);
  if (idx === -1) return { ok: false, error: 'Вы не участник' };
  if (!game.players[idx].alive) return { ok: false, error: 'Вы уже выбыли' };
  const wasTheirTurn = game.turn.idx === idx;
  eliminatePlayer(game, idx, null);
  if (game.status === 'active' && wasTheirTurn) advanceTurn(game);
  return { ok: true };
}

// «Поторопить» AFK-игрока: письмо + жёсткие 10 минут на ход.
export const NUDGE_MS = 10 * 60 * 1000;
export function nudge(game, playerId) {
  if (game.status !== 'active') return { ok: false, error: 'Игра не активна' };
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
  const pIdx = game.players.findIndex(p => p.id === playerId);
  if (pIdx === -1) return { ok: false, error: 'Вы не участник игры' };
  if (pIdx !== game.turn.idx) return { ok: false, error: 'Сейчас не ваш ход' };
  const player = game.players[pIdx];

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
      // Рыбалка: каждый баркас в рыбном месте приносит улов.
      for (const s of game.ships.filter(s => s.owner === pIdx && SHIP_TYPES[s.type].fishing > 0)) {
        const zone = game.map.fishZones.find(z => dist(s.x, s.y, z.x, z.y) <= z.radius);
        if (zone) { gained += SHIP_TYPES[s.type].fishing; notes.push('🐟 улов'); }
      }
      // Лут с островов: любой корабль, дотянувшийся до острова.
      for (const isl of game.map.lootIslands.filter(i => !i.looted)) {
        const reach = game.ships.some(s => s.owner === pIdx &&
          dist(s.x, s.y, isl.x, isl.y) <= isl.radius + LOOT_REACH);
        if (reach) {
          isl.looted = true;
          gained += isl.loot;
          notes.push(`🏝 клад ${isl.loot}`);
        }
      }
      if (!gained) return { ok: false, error: 'Нечего собирать: нет баркасов в рыбных местах и кораблей у нелутанных островов' };
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
        const targetName = target.owner === -1
          ? 'пиратскому кораблю'
          : `${SHIP_TYPES[target.type].name} игрока ${game.players[target.owner].nick}`;
        pushLog(game, `🔥 ${player.nick}: ${st.name} бьёт по ${targetName} (−${st.dmg} HP)`, 'battle');
        if (target.hp <= 0) sinkShip(game, target, player);
      } else if (action.targetType === 'port') {
        const targetIdx = action.targetId;
        const victim = game.players[targetIdx];
        if (!victim || targetIdx === pIdx || !victim.alive) return { ok: false, error: 'Неверная цель' };
        const base = game.map.bases[targetIdx];
        if (dist(ship.x, ship.y, base.x, base.y) > st.fireRange + base.radius * 0.5)
          return { ok: false, error: 'Порт вне дальности стрельбы' };
        victim.portHp -= st.dmg;
        player.stats.shotsFired++;
        player.stats.damageDealt += st.dmg;
        pushLog(game, `🔥 ${player.nick} обстреливает порт игрока ${victim.nick} (−${st.dmg} HP, осталось ${Math.max(0, victim.portHp)})`, 'battle');
        if (victim.portHp <= 0) {
          victim.portHp = 0;
          eliminatePlayer(game, targetIdx, player);
        }
      } else {
        return { ok: false, error: 'Неизвестная цель' };
      }
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
  for (let ring = 0; ring < 4; ring++) {
    const r = base.radius + 45 + ring * 34;
    for (let i = 0; i < 14; i++) {
      const ang = (i / 14) * Math.PI * 2;
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
  pushLog(game, `⏰ Время вышло — ход игрока ${currentPlayer(game).nick} пропущен`);
  advanceTurn(game);
  return true;
}

// Состояние для отправки клиентам (без приватных данных).
export function publicState(game) {
  return {
    id: game.id,
    status: game.status,
    config: game.config,
    map: game.map,
    players: game.players.map(p => ({
      id: p.id, nick: p.nick, color: p.color, gold: p.gold,
      portHp: p.portHp, alive: p.alive, placement: p.placement,
      stats: p.stats
    })),
    ships: game.ships,
    turn: game.turn,
    log: game.log,
    winner: game.winner,
    shipTypes: { ...SHIP_TYPES, pirate: PIRATE }
  };
}
