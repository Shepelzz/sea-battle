// Игровая логика: создание игры, лобби, валидация и применение ходов.
import { generateMap, spawnPoints } from './mapgen.js';
import {
  SHIP_TYPES, START_FLEET, START_GOLD, PORT_HP,
  SHIP_COLLISION_DIST, LOOT_REACH
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
    stats: newStats(), votedSkip: false
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
  game.status = 'active';
  game.turn = { idx: 0, number: 1, deadline: turnDeadline(game) };
  pushLog(game, `⚔️ Баттл начался! Первым ходит ${game.players[0].nick}`, 'battle');
  return { ok: true };
}

function turnDeadline(game) {
  return game.config.turnTimer > 0 ? Date.now() + game.config.turnTimer * 1000 : null;
}

function currentPlayer(game) {
  return game.players[game.turn.idx];
}

function advanceTurn(game) {
  game.players.forEach(p => { p.votedSkip = false; });
  const n = game.players.length;
  let next = game.turn.idx;
  for (let i = 0; i < n; i++) {
    next = (next + 1) % n;
    if (game.players[next].alive) break;
  }
  game.turn.idx = next;
  game.turn.number++;
  game.turn.deadline = turnDeadline(game);
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

function eliminatePlayer(game, victimIdx, killer) {
  const victim = game.players[victimIdx];
  victim.alive = false;
  victim.placement = game.players.filter(p => p.alive).length + 1;
  const tribute = Math.floor(victim.gold / 2);
  victim.gold -= tribute;
  killer.gold += tribute;
  killer.stats.goldCollected += tribute;
  // Флот побеждённого уходит на дно вместе с портом.
  game.ships = game.ships.filter(s => s.owner !== victimIdx);
  pushLog(game, `🏴‍☠️ Порт игрока ${victim.nick} разрушен! ${killer.nick} забирает ${tribute} золота. ${victim.nick} выбывает`, 'battle');

  const alive = game.players.filter(p => p.alive);
  if (alive.length === 1) {
    alive[0].placement = 1;
    game.winner = game.players.indexOf(alive[0]);
    game.status = 'finished';
    game.turn.deadline = null;
    pushLog(game, `👑 ${alive[0].nick} побеждает в баттле!`, 'battle');
  }
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
        const victim = game.players[target.owner];
        pushLog(game, `🔥 ${player.nick}: ${st.name} бьёт по ${SHIP_TYPES[target.type].name} игрока ${victim.nick} (−${st.dmg} HP)`, 'battle');
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

// Голосование за пропуск хода AFK-игрока (когда таймер выключен).
export function voteSkip(game, playerId) {
  if (game.status !== 'active') return { ok: false, error: 'Игра не активна' };
  const voter = game.players.find(p => p.id === playerId);
  if (!voter || !voter.alive) return { ok: false, error: 'Вы не участник' };
  if (game.players[game.turn.idx].id === playerId) return { ok: false, error: 'Сейчас ваш ход — просто пропустите его' };
  voter.votedSkip = true;
  const others = game.players.filter((p, i) => p.alive && i !== game.turn.idx);
  const votes = others.filter(p => p.votedSkip).length;
  if (votes >= others.length) {
    pushLog(game, `⏭ Ход игрока ${currentPlayer(game).nick} пропущен голосованием`);
    advanceTurn(game);
  } else {
    pushLog(game, `🗳 ${voter.nick} голосует за пропуск хода (${votes}/${others.length})`);
  }
  return { ok: true };
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
      stats: p.stats, votedSkip: p.votedSkip
    })),
    ships: game.ships,
    turn: game.turn,
    log: game.log,
    winner: game.winner,
    shipTypes: SHIP_TYPES
  };
}
