// Игровая логика: создание игры, лобби, валидация и применение ходов.
import { generateMap, spawnPoints, duelFleetSpots } from './mapgen.js';
import {
  SHIP_TYPES, START_FLEET, START_GOLD, PORT_HP, PORT_RETURN_DMG, PORT_INCOME,
  PORT_RETURN_LINKOR_MULT, PORT_NO_SHIP_INCOME_MULT,
  SHIP_COLLISION_DIST, LOOT_REACH, WRECK_LOOT_FRAC, TRIBUTE_FRAC,
  BROADSIDE_CANNONS, BROADSIDE_HALF_ARC, BROADSIDE_FALLOFF_MIN, BROADSIDE_SIDE_MIN, BROADSIDE_PORT_MULT, MORTAR_SHIPS, MORTAR_SHIP_MULT,
  FISH_ZONE_CAP, movesBudget, SHIP_ACTIONS, CHEATS_ENABLED, DEBUG_GOLD_LOG, REPAIR_CHARGES, REPAIR_DOCK_REACH,
  modeStartGold, modeOf, isPeace, modePeaceRounds, isDuel, isRealtime, RT, cheapestShipPrice, GAME_MODES, DEFAULT_MODE,
  WIND_STRENGTH, WIND_TURN_STEP, WIND_STR_STEP, windMoveMult, REALTIME_NAME,
  OUTPOST_LEVELS, OUTPOST_RADIUS, OUTPOST_BUILD_REACH,
  FISH_DRIFT_PER_TURN, FISH_HOME_RADIUS, FISH_MIN_GAP, FISH_BASE_GAP,
  MAP_EDGE_MARGIN, ISLAND_BLOCK_GAP, SPAWN_FAN_N, SPAWN_FAN_RINGS, SPAWN_FAN_R0, SPAWN_FAN_RING_STEP,
  PIRATE, PIRATE_MAX, PIRATE_ENGAGE_MULT, PIRATE_MIN_LIFETIME, PIRATE_STEP_MIN,
  PIRATE_DESPAWN_CHANCE, PIRATE_MOVE_CHANCE, PIRATE_BOSS_CHANCE, PIRATE_BOSS_HP,
  PIRATE_BOUNTY_MIN, PIRATE_BOUNTY_RAND, PIRATE_BOUNTY_STEP,
  PIRATE_BOSS_BOUNTY_MIN, PIRATE_BOSS_BOUNTY_RAND, PIRATE_BOSS_BOUNTY_STEP,
  PIRATE_WATER_MARGIN, PIRATE_WATER_SPAN, PIRATE_WATER_BASE_GAP
} from './config.js';

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
const SHIP_ACTION_SET = new Set(SHIP_ACTIONS); // действия, привязанные к конкретному кораблю

let shipSeq = 1;

function newStats() {
  // npc* — доля урона/потоплений/добычи, набитая на НПС (пираты + игроки-боты).
  // Общие статы остаются полными (рекап матча, сим-баланс), а в лидерборд (resultRows) идёт totals − npc.
  return { damageDealt: 0, shipsSunk: 0, shipsLost: 0, goldCollected: 0, shotsFired: 0,
           npcDamage: 0, npcSunk: 0, npcGold: 0 };
}

export function createGame(id, config) {
  return {
    id,
    status: 'lobby',
    config: {
      maxPlayers: Math.min(4, Math.max(2, config.maxPlayers || 2)),
      turnTimer: [0, 60, 120, 300].includes(config.turnTimer) ? config.turnTimer : 0,
      // переданный seed уважаем (тесты годами слали seed:7, а получали СЛУЧАЙНУЮ карту — флаки);
      // реальные партии seed не шлют → случайный, как и было
      seed: Number.isInteger(config.seed) ? config.seed : (Math.random() * 2 ** 31) | 0
    },
    map: null,
    players: [], // {id, nick, color, gold, portHp, alive, placement, stats, votedSkip}
    ships: [],
    // 🌬 ветер партии (во всех режимах): дует в ang, сила 0..1 — поднимается с нуля и меняется
    // между ходами (advanceTurn) или тиком реалтайма (rt.js). Контур хода вытянут по ветру.
    wind: { ang: Math.random() * Math.PI * 2, str: 0, targetAng: Math.random() * Math.PI * 2, targetStr: 0.3 + Math.random() * 0.7 },
    turn: { idx: 0, number: 0, round: 1, deadline: null, moves: 0, actedShips: [] },
    log: [],
    winner: null,
    hostPid: null,         // pid создателя онлайн-лобби (аккаунт): по нему опознаём хоста при возврате
    createdAt: Date.now()
  };
}

function pushLog(game, text, type = 'info') {
  game.log.push({ t: Date.now(), type, text });
  if (game.log.length > 80) game.log.splice(0, game.log.length - 80);
}

// Журнал при тумане войны — абстрактные события без деталей (что/где/сколько),
// чтобы не палить позиции и экономику. Без тумана — подробный текст.
function logEvent(game, detailed, abstract, type = 'info') {
  pushLog(game, game.config.fog ? abstract : detailed, type);
}

// 🐞 Дебаг-лог экономики (флаг DEBUG_GOLD_LOG в config.js): каждое начисление золота —
// в журнал партии. Пишет мимо тумана войны (доходы всех видны всем) — только для отладки.
export function debugGold(game, player, amount, reason) {
  if (!DEBUG_GOLD_LOG || !amount || !player) return;
  pushLog(game, `🐞 +${amount} зол. → ${player.nick}: ${reason}`, 'debug');
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
    gold: modeStartGold(game), portHp: PORT_HP, // дезматч даёт больше золота на старте (режим)
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

  const md = modeOf(game);
  // ── Дуэль: маленькая карта без баз/островов, стартового флота нет — игроки скупаются
  // в фазе 'buy' (на всё золото), затем начинается бой. Золото (startGold) уже выдано в addPlayer. ──
  if (md.duel) {
    game.map = generateMap(game.config.seed, game.players.length, { duel: true, mapScale: md.mapScale });
    game.players.forEach(p => { p.ready = false; });
    for (let i = 0; i < 2; i++) spawnPirate(game, true, false, i);
    game.status = 'active';
    game.phase = 'buy';
    game.turn = { idx: 0, number: 0, round: 1, deadline: null, nudged: false, moves: 0, actedShips: [] };
    pushLog(game, '🛒 Дуэль: соберите флот в верфи — на всё золото! — затем в бой', 'battle');
    return { ok: true };
  }

  // в «Развитии» — у каждой базы своя большая рыбозона и все зоны на 5 слотов (опции режима)
  game.map = generateMap(game.config.seed, game.players.length, { baseFishZone: !!md.baseFishZone, allFishZonesBig: !!md.allFishZonesBig });
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
  for (let i = 0; i < Math.min(PIRATE_MAX, game.players.length); i++) spawnPirate(game, true, false, i);
  game.status = 'active';
  game.turn = { idx: 0, number: 1, round: 1, deadline: turnDeadline(game), nudged: false, moves: 0, actedShips: [] };
  pushLog(game, `⚔️ Баттл начался! Первым ходит ${game.players[0].nick}`, 'battle');
  return { ok: true };
}

// --- пираты ---

function randomWaterSpot(game) {
  const m = game.map;
  for (let i = 0; i < 60; i++) {
    const x = Math.round(m.w * PIRATE_WATER_MARGIN + Math.random() * m.w * PIRATE_WATER_SPAN);
    const y = Math.round(m.h * PIRATE_WATER_MARGIN + Math.random() * m.h * PIRATE_WATER_SPAN);
    if (m.bases.some(b => dist(x, y, b.x, b.y) < b.radius + PIRATE_WATER_BASE_GAP)) continue;
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
      ? (PIRATE_BOSS_BOUNTY_MIN + Math.floor(Math.random() * PIRATE_BOSS_BOUNTY_RAND)) * PIRATE_BOSS_BOUNTY_STEP  // 400..800 — большой куш
      : (PIRATE_BOUNTY_MIN + Math.floor(Math.random() * PIRATE_BOUNTY_RAND)) * PIRATE_BOUNTY_STEP,                 // 150..350
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

const nearestShip = (pir, list) =>
  list.reduce((a, b) => dist(pir.x, pir.y, b.x, b.y) < dist(pir.x, pir.y, a.x, a.y) ? b : a);

// Действие пирата, если он ВОВЛЕЧЁН (рядом есть корабли): атака/преследование/бегство.
// Возвращает true, если пират занят боем — тогда он НЕ исчезает и не дрейфует просто так.
const isDamaged = s => s.hp < SHIP_TYPES[s.type].hp; // подбит — HP меньше полного

// 🏴‍☠️ БОРТОВОЙ ЗАЛП ПИРАТА (общий для пошагового pirateAct и реалтайм-pirateThink):
// пират разворачивается бортом к цели и бьёт ВСЕХ игроков в секторе борта (урон плоский,
// PIRATE.dmg каждому). Снарядов в залпе: у босса 3 (как у фрегата), у обычного — 2 (визуал клиента).
export function pirateVolley(game, pir, target) {
  const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
  const sideDir = Math.atan2(target.y - pir.y, target.x - pir.x);
  pir.heading = norm(sideDir - Math.PI / 2); // цель — на траверзе борта
  const hits = [];
  for (const s of game.ships) {
    if (s.owner < 0 || !game.players[s.owner]?.alive) continue; // пираты бьют только корабли игроков
    if (dist(pir.x, pir.y, s.x, s.y) > PIRATE.fireRange) continue;
    if (s !== target && Math.abs(norm(Math.atan2(s.y - pir.y, s.x - pir.x) - sideDir)) > BROADSIDE_HALF_ARC) continue;
    hits.push(s);
  }
  const evHits = hits.map(s => (s.hp -= PIRATE.dmg, { tx: s.x, ty: s.y, dmg: PIRATE.dmg }));
  pir.angryAt = target.owner;
  pushEvent(game, { type: 'volley', fx: pir.x, fy: pir.y, sideDir, cannons: pir.boss ? 3 : 2, full: false, shipType: 'pirate', hits: evHits });
  logEvent(game,
    `🏴‍☠️ ${pir.boss ? 'БОСС-пират даёт бортовой залп' : 'Пираты дают бортовой залп'} по ${hits.length} цел. (−${PIRATE.dmg} HP)`,
    `🏴‍☠️ Пираты дали залп по игроку ${game.players[target.owner].nick}`, 'battle');
  for (const s of [...hits]) if (s.hp <= 0) sinkShip(game, s, null);
  return hits.length;
}

function pirateAct(game, pir) {
  const D = PIRATE.dmg, FR = PIRATE.fireRange, MV = PIRATE.move;
  // теперь и рыбацкие баркасы — допустимая добыча: мелкий пират может пощипать баркас (одиночным выстрелом, не залпом)
  const all = game.ships.filter(s => s.owner >= 0 && game.players[s.owner]?.alive);
  if (!all.length) return false;

  // «вовлечён»: рядом корабль в зоне своего хода или огня (+20%) — пирату не дадут раствориться
  const engaged = all.some(s => {
    const st = SHIP_TYPES[s.type];
    return dist(pir.x, pir.y, s.x, s.y) <= Math.max(st.move, st.fireRange) * PIRATE_ENGAGE_MULT;
  });
  if (!engaged) return false; // свободен — обычная жизнь (дрейф/туман) снаружи

  // суммарный урон, который пират может схлопотать прямо сейчас (кто достаёт его огнём)
  const incoming = all.filter(s => SHIP_TYPES[s.type].dmg > 0 &&
    dist(pir.x, pir.y, s.x, s.y) <= SHIP_TYPES[s.type].fireRange)
    .reduce((sum, s) => sum + SHIP_TYPES[s.type].dmg, 0);

  // цели в радиусе огня пирата: добиваемые в приоритете; БОСС вдобавок целится в подбитых; иначе слабейшая по HP
  const inRange = all.filter(s => dist(pir.x, pir.y, s.x, s.y) <= FR);
  let target = null;
  const killable = inRange.filter(s => s.hp <= D);
  const wounded = inRange.filter(isDamaged);
  if (killable.length) target = killable.reduce((a, b) => a.hp < b.hp ? b : a); // добьём любого — берём пожирнее по HP
  else if (pir.boss && wounded.length) target = wounded.reduce((a, b) => a.hp < b.hp ? a : b); // босс рвёт подранков
  else if (inRange.length) target = inRange.reduce((a, b) => a.hp < b.hp ? a : b);

  if (target) {
    // ДЕРЁМСЯ если можем добить ОДНИМ залпом, либо переживём ответку. БОСС агрессивен — бьёт, не считаясь со сдачей.
    const willKill = target.hp <= D;
    if (willKill || pir.boss || pir.hp > incoming) {
      pirateVolley(game, pir, target); // 💥 бортовой залп: разворот бортом + все игроки в секторе
      return true;
    }
    // не добить и опасно — уходим от ближайшего корабля
    const t = nearestShip(pir, all);
    steerPirate(game, pir, MV, Math.atan2(pir.y - t.y, pir.x - t.x));
    return true;
  }

  // цели в радиусе огня нет. БОСС, завидев подбитого рядом, идёт НАВСТРЕЧУ добить (для него гон оправдан — он редок и зол).
  if (pir.boss) {
    const prey = all.filter(isDamaged);
    if (prey.length) {
      const p = nearestShip(pir, prey);
      steerPirate(game, pir, MV, Math.atan2(p.y - pir.y, p.x - pir.x));
      return true;
    }
  }
  // обычный пират не гоняется за флотом (иначе партия не сходится) → отходит от ближайшего. Бьёт лишь тех, кто сам зашёл в радиус.
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
    // не исчезать раньше 5 ходов с момента появления; и НИКОГДА не растворять ПОСЛЕДНЕГО пирата —
    // море не должно оставаться пустым (иначе «пиратов нет всю вторую половину игры»).
    const piratesLeft = game.ships.filter(s => s.owner === -1).length;
    if (piratesLeft > 1 && game.turn.number - (pir.bornTurn || 0) >= PIRATE_MIN_LIFETIME && Math.random() < PIRATE_DESPAWN_CHANCE) {
      game.ships = game.ships.filter(s => s.id !== pir.id);
      pushLog(game, '🌫 Пиратский корабль растворился в тумане…');
      continue;
    }
    if (Math.random() > PIRATE_MOVE_CHANCE) continue;
    const step = PIRATE_STEP_MIN + Math.random() * (PIRATE.move - PIRATE_STEP_MIN);
    steerPirate(game, pir, step, pir.heading ?? (pir.heading = Math.random() * Math.PI * 2));
  }
  // ПОПОЛНЕНИЕ ДО ПОЛНОГО СОСТАВА. На карте ВСЕГДА держим PIRATE_MAX пиратов: что растворилось
  // в тумане выше — тут же заменяем новым в другом месте (тот самый эффект «пропал тут — появился
  // там», который и нужен). Гарантированно, без рандома: раньше дозаспавн шёл лишь с шансом раз в
  // круг и навёрстывал ~6 кругов — игрок видел одного пирата всю половину партии. Теперь дыры нет.
  let refillGuard = PIRATE_MAX + 2; // предохранитель от зацикливания, если не нашлось воды
  while (game.ships.filter(s => s.owner === -1).length < PIRATE_MAX && refillGuard-- > 0) {
    const before = game.ships.length;
    spawnPirate(game, false, true, aliveIdx[Math.floor(Math.random() * aliveIdx.length)]);
    if (game.ships.length === before) break; // место не нашлось — попробуем в следующий ход
  }
}

function turnDeadline(game) {
  if (isRealtime(game)) return null; // ⚡ реалтайм: ходов нет — таймер хода не взводится никогда
  return game.config.turnTimer > 0 ? Date.now() + game.config.turnTimer * 1000 : null;
}

function currentPlayer(game) {
  return game.players[game.turn.idx];
}

// Все рыбацкие суда (любых владельцев), стоящие в зоне.
function fishOccupants(game, zone) {
  return game.ships
    .filter(s => SHIP_TYPES[s.type]?.fishing > 0 && dist(s.x, s.y, zone.x, zone.y) <= zone.radius);
}
// Доход капает только zone.cap судам — МЕСТА ПО ПОРЯДКУ ПРИХОДА («кто первый встал — того и рыба»):
// зона помнит очередь crew (id прибывших), ушедшие вычёркиваются, вернувшиеся встают в КОНЕЦ.
// (Раньше сортировали по id — опоздавший с «меньшим» id выталкивал давно кормящегося.)
function fishEarners(game, zone) {
  const occ = fishOccupants(game, zone);
  const here = new Set(occ.map(s => s.id));
  zone.crew = (zone.crew || []).filter(id => here.has(id));
  for (const s of occ) if (!zone.crew.includes(s.id)) zone.crew.push(s.id);
  const feed = new Set(zone.crew.slice(0, zone.cap || FISH_ZONE_CAP));
  return occ.filter(s => feed.has(s.id));
}

// 🐟 Миграция рыбных мест: зоны ОЧЕНЬ медленно блуждают вокруг родного места (якорь
// FISH_HOME_RADIUS), держа дистанцию от баз и чужих целей (FISH_MIN_GAP) — в кучу не съедутся.
// Пошагово зовётся из advanceTurn (шаг FISH_DRIFT_PER_TURN), в реалтайме — из тика (rt.js).
export function driftFishZones(game, step) {
  const m = game.map;
  if (!m?.fishZones?.length) return;
  for (const z of m.fishZones) {
    z.homeX ??= z.x; z.homeY ??= z.y; // якорь — место рождения зоны
    if (z.tx == null || dist(z.x, z.y, z.tx, z.ty) < 4) pickFishTarget(game, z);
    const a = Math.atan2(z.ty - z.y, z.tx - z.x);
    z.x += Math.cos(a) * step;
    z.y += Math.sin(a) * step;
  }
}
function pickFishTarget(game, z) {
  const m = game.map;
  for (let i = 0; i < 24; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * FISH_HOME_RADIUS;
    const tx = z.homeX + Math.cos(a) * r, ty = z.homeY + Math.sin(a) * r;
    if (tx < 80 || ty < 80 || tx > m.w - 80 || ty > m.h - 80) continue;                          // не к краю
    if (m.bases.some(b => dist(tx, ty, b.x, b.y) < b.radius + FISH_BASE_GAP)) continue;          // не к базам
    if (m.lootIslands.some(i2 => dist(tx, ty, i2.x, i2.y) < i2.radius + 40)) continue;           // не центром на остров
    if (m.fishZones.some(o => o !== z && dist(tx, ty, o.tx ?? o.x, o.ty ?? o.y) < FISH_MIN_GAP)) continue; // не в кучу
    z.tx = tx; z.ty = ty;
    return;
  }
  z.tx = z.homeX; z.ty = z.homeY; // подходящей воды не нашли — плывём домой
}

// 🌬 Пошаговый ветер: маленький шаг к целевому направлению/силе КАЖДУЮ смену хода (в свой ход
// ветер стабилен — планируй спокойно); новая цель — раз в круг. Формула дальности — windMoveMult.
function driftWind(game, newRound) {
  const w = (game.wind ??= { ang: 0, str: 0, targetAng: 0, targetStr: 0.5 }); // старые сейвы без ветра
  const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
  const clamp = (v, lim) => Math.max(-lim, Math.min(lim, v));
  w.ang = norm(w.ang + clamp(norm((w.targetAng ?? w.ang) - w.ang), WIND_TURN_STEP));
  w.str = Math.max(0, Math.min(1, w.str + clamp((w.targetStr ?? w.str) - w.str, WIND_STR_STEP)));
  if (newRound) { // раз в круг ветер задумывает новое направление/силу
    w.targetAng = Math.random() * Math.PI * 2;
    w.targetStr = 0.3 + Math.random() * 0.7;
  }
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
  // РАУНД = полный круг: счётчик растёт, когда ход вернулся к первому живому игроку (для мирного периода режима «Развитие»)
  const newRound = next === game.players.findIndex(p => p.alive);
  if (newRound) game.turn.round = (game.turn.round || 1) + 1;
  driftWind(game, newRound); // 🌬 ветер дрейфует между ходами (контур хода вытянут по ветру)
  driftFishZones(game, FISH_DRIFT_PER_TURN); // 🐟 рыбные места очень медленно мигрируют
  game.turn.deadline = turnDeadline(game);
  game.turn.nudged = false;
  game.turn.moves = 0;        // счётчик ходов кораблями этого хода (режим «ход тремя судами»)
  game.turn.actedShips = [];  // какие корабли уже сходили в этом ходу
  game.turn.broadsideSides = {}; // какими бортами уже дан залп в этом ходу (по кораблям)
  // Порт ВСЕГДА приносит немного золота в начале хода — БЕЗ каких-либо ограничений по числу ходов.
  // (Раньше доход срезался после players*80 ходов «для сходимости» — убрано: экономику не лимитируем,
  // иначе в долгой партии золото переставало капать и в верфи становилось нечего купить.)
  const np = game.players[next];
  if (np?.alive && !isDuel(game)) {   // в дуэли дохода за ход НЕТ (золото — только за пиратов)
    // порт без единого корабля приносит на 50% больше золота — игроку, потерявшему флот, легче встать на ноги.
    const hasShips = game.ships.some(s => s.owner === next);
    const income = hasShips ? PORT_INCOME : Math.round(PORT_INCOME * PORT_NO_SHIP_INCOME_MULT);
    np.gold += income;
    debugGold(game, np, income, hasShips ? 'доход порта' : 'доход порта (без флота, +50%)');
  }

  // пассивная рыбалка: каждый баркас игрока, стоящий в рыбном месте, сам приносит улов
  // в начале его хода — действие на это не тратится. Но место кормит не больше FISH_ZONE_CAP судов.
  if (np?.alive) {
    let catch_ = 0;
    for (const s of game.ships.filter(s => s.owner === next && SHIP_TYPES[s.type].fishing > 0)) {
      const zone = game.map.fishZones.find(z => dist(s.x, s.y, z.x, z.y) <= z.radius);
      if (zone && fishEarners(game, zone).some(o => o.id === s.id)) {
        catch_ += SHIP_TYPES[s.type].fishing;
        pushEvent(game, { type: 'gold', x: s.x, y: s.y, amount: SHIP_TYPES[s.type].fishing });
      }
    }
    if (catch_) {
      np.gold += catch_;
      np.stats.goldCollected += catch_;
      // нотиф про улов не пишем — это шум; остаётся всплывающее «+золото» на карте
      debugGold(game, np, catch_, 'рыбалка');
    }
  }

  // ⛺ АВАНПОСТЫ владельца — в начале его хода: доход, ремонт своих рядом, пушка форта.
  // (Реалтайм не ходит через advanceTurn — там те же перки крутит tickOutposts в rt.js.)
  if (np?.alive) applyOutpostPerks(game, next);
}

// Перки аванпостов игрока pIdx (общая логика пошагового хода и реалтайм-тика):
// доход с каждого аванпоста, фактория чинит свои корабли в радиусе, форт бьёт врага/пирата.
export function applyOutpostPerks(game, pIdx) {
  const p = game.players[pIdx];
  if (!p?.alive) return;
  for (const isl of game.map?.lootIslands || []) {
    const op = isl.outpost;
    if (!op || op.owner !== pIdx) continue;
    const lvl = OUTPOST_LEVELS[op.level - 1];
    p.gold += lvl.income;
    pushEvent(game, { type: 'gold', x: isl.x, y: isl.y, amount: lvl.income });
    debugGold(game, p, lvl.income, `аванпост ур.${op.level}`);
    if (lvl.heal) { // 🏪 фактория: латает свои корабли в радиусе (доля их МАКСИМАЛЬНОЙ прочности)
      for (const s of game.ships.filter(s => s.owner === pIdx && dist(s.x, s.y, isl.x, isl.y) <= OUTPOST_RADIUS)) {
        const maxHp = SHIP_TYPES[s.type].hp;
        const healed = Math.min(Math.round(maxHp * lvl.heal), maxHp - s.hp);
        if (healed > 0) { s.hp += healed; pushEvent(game, { type: 'repair', fx: isl.x, fy: isl.y, tx: s.x, ty: s.y, heal: healed }); }
      }
    }
    if (lvl.gun && !isPeace(game)) { // 🏰 форт: береговая пушка по ближайшему врагу/пирату в радиусе
      const foes = game.ships.filter(s => s.owner !== pIdx && (s.owner === -1 || game.players[s.owner]?.alive) &&
        dist(s.x, s.y, isl.x, isl.y) <= OUTPOST_RADIUS);
      if (foes.length) {
        const t = foes.reduce((a, b) => dist(a.x, a.y, isl.x, isl.y) < dist(b.x, b.y, isl.x, isl.y) ? a : b);
        t.hp -= lvl.gun;
        p.stats.damageDealt += lvl.gun;
        if (!isHumanFoe(game, t.owner)) p.stats.npcDamage += lvl.gun;
        pushEvent(game, { type: 'shot', fx: isl.x, fy: isl.y, tx: t.x, ty: t.y, dmg: lvl.gun });
        logEvent(game,
          `🏰 Форт игрока ${p.nick} бьёт по ${t.owner === -1 ? 'пиратам' : SHIP_TYPES[t.type].name + ' игрока ' + game.players[t.owner].nick} (−${lvl.gun} HP)`,
          `🏰 Форт игрока ${p.nick} дал залп`, 'battle');
        if (t.hp <= 0) sinkShip(game, t, p);
        else if (t.owner === -1) t.angryAt = pIdx;
      }
    }
  }
}

export function shipPlacementBlocked(game, x, y, ignoreShipId) {
  const m = game.map;
  if (x < MAP_EDGE_MARGIN || y < MAP_EDGE_MARGIN || x > m.w - MAP_EDGE_MARGIN || y > m.h - MAP_EDGE_MARGIN) return 'За краем карты';
  for (const b of m.bases) if (!b.noPort && dist(x, y, b.x, b.y) < b.radius + ISLAND_BLOCK_GAP) return 'Нельзя встать на остров';
  for (const o of m.lootIslands) if (dist(x, y, o.x, o.y) < o.radius + ISLAND_BLOCK_GAP) return 'Нельзя встать на остров';
  for (const s of game.ships) {
    if (s.id !== ignoreShipId && dist(x, y, s.x, s.y) < SHIP_COLLISION_DIST) return 'Слишком близко к другому кораблю';
  }
  return null;
}

// Бой против NPC (пиратов owner=-1 и игроков-ботов) в ЛИДЕРБОРД не идёт: статы (урон/потопления/
// добыча-с-убийств) копятся только за противников-людей. Игровое золото-валюта и рыбалка/лут — не статы, их не трогаем.
function isHumanFoe(game, ownerIdx) {
  return ownerIdx >= 0 && !game.players[ownerIdx]?.isBot;
}

function sinkShip(game, ship, killer) {
  game.ships = game.ships.filter(s => s.id !== ship.id);
  // ship-данные нужны клиенту: тонущий корабль рисуется, пока до него летит ядро
  pushEvent(game, {
    type: 'explosion', x: ship.x, y: ship.y, big: true,
    shipId: ship.id, ship: { type: ship.type, owner: ship.owner, bounty: ship.bounty, boss: !!ship.boss }
  });
  if (ship.owner === -1) {
    killer.gold += ship.bounty;
    killer.stats.shipsSunk++; killer.stats.goldCollected += ship.bounty;  // общий зачёт (рекап/сим)
    killer.stats.npcSunk++;   killer.stats.npcGold += ship.bounty;        // …но НПС → из лидерборда вычтется
    pushEvent(game, { type: 'gold', x: ship.x, y: ship.y, amount: ship.bounty });
    debugGold(game, killer, ship.bounty, 'награда за пирата');
    logEvent(game,
      `💥 Пиратский корабль потоплен! ${killer.nick} забирает награду ${ship.bounty} золота`,
      `💥 ${killer.nick} потопил пиратский корабль`, 'battle');
    return;
  }
  const owner = game.players[ship.owner];
  owner.stats.shipsLost++;
  const npcFoe = !isHumanFoe(game, ship.owner); // бот → потопление/добыча из лидерборда вычитаются
  if (killer && isDuel(game)) {
    // Дуэль: за потопление ВРАЖЕСКОГО судна золото НЕ даём (иначе экономика раздувается; золото — только за пиратов).
    killer.stats.shipsSunk++;
    if (npcFoe) killer.stats.npcSunk++;
    logEvent(game,
      `💥 ${SHIP_TYPES[ship.type].name} игрока ${owner.nick} потоплен! (${killer.nick})`,
      `💥 ${killer.nick} потопил корабль игрока ${owner.nick}`, 'battle');
  } else if (killer) {
    // реалтайм: лут скромнее (война не должна окупаться) — пошаговый баланс не трогаем
    const plunder = Math.round(SHIP_TYPES[ship.type].price * (isRealtime(game) ? RT.WRECK_LOOT_FRAC : WRECK_LOOT_FRAC));
    killer.gold += plunder;                    // лут-валюту даём всегда
    killer.stats.shipsSunk++; killer.stats.goldCollected += plunder;
    if (npcFoe) { killer.stats.npcSunk++; killer.stats.npcGold += plunder; }
    pushEvent(game, { type: 'gold', x: ship.x, y: ship.y, amount: plunder });
    debugGold(game, killer, plunder, `лут с обломков (${SHIP_TYPES[ship.type].name})`);
    logEvent(game,
      `💥 ${SHIP_TYPES[ship.type].name} игрока ${owner.nick} потоплен! ${killer.nick} лутает ${plunder} золота с обломков`,
      `💥 ${killer.nick} потопил корабль игрока ${owner.nick}`, 'battle');
  } else {
    logEvent(game,
      `💥 ${SHIP_TYPES[ship.type].name} игрока ${owner.nick} потоплен пиратами!`,
      `💥 Пираты потопили корабль игрока ${owner.nick}`, 'battle');
  }
  // Дуэль: флот игрока полностью уничтожен → он выбывает (баз нет; последний с флотом побеждает).
  if (isDuel(game) && owner.alive && !game.ships.some(s => s.owner === ship.owner)) {
    eliminatePlayer(game, ship.owner, killer || null);
  }
}

// killer = null означает добровольную сдачу.
function eliminatePlayer(game, victimIdx, killer) {
  const victim = game.players[victimIdx];
  victim.alive = false;
  victim.placement = game.players.filter(p => p.alive).length + 1;
  const duel = isDuel(game);
  if (killer) {
    const tribute = Math.floor(victim.gold * TRIBUTE_FRAC);
    victim.gold -= tribute;
    killer.gold += tribute;                       // дань-валюту забираем,
    killer.stats.goldCollected += tribute;
    debugGold(game, killer, tribute, `дань с игрока ${victim.nick}`);
    if (victim.isBot) killer.stats.npcGold += tribute; // дань с бота → из лидерборда вычтется
    const base = game.map.bases[victimIdx];
    if (base && !base.noPort) { // в дуэли порта/форта нет — взрыв уже сыгран на последнем корабле
      pushEvent(game, { type: 'explosion', x: base.x, y: base.y, big: true });
      pushEvent(game, { type: 'gold', x: base.x, y: base.y, amount: tribute });
    }
    logEvent(game,
      duel ? `🏴‍☠️ Флот игрока ${victim.nick} разбит! ${killer.nick} забирает остатки казны (${tribute}) и побеждает`
           : `🏴‍☠️ Порт игрока ${victim.nick} разрушен! ${killer.nick} забирает ${tribute} золота. ${victim.nick} выбывает`,
      duel ? `🏴‍☠️ ${killer.nick} разбил флот игрока ${victim.nick}`
           : `🏴‍☠️ ${killer.nick} разбил базу игрока ${victim.nick} — ${victim.nick} выбывает`, 'battle');
  } else {
    pushLog(game, `🏳️ ${victim.nick} ${duel ? 'теряет весь флот и' : 'спускает флаг и'} покидает баттл`, 'battle');
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

// В лидерборд (ranked) идут только онлайн-баттлы: игры с ботами и «на одном устройстве»
// не засчитываются — нельзя нафармить статистику. `listed` ставится лишь онлайн-играм.
// В рейтинг идут только онлайн-партии; ⚡ реалтайм пока БЕТА — лидерборд не трогает
export const isRanked = game => !!(game?.config?.listed) && !isRealtime(game);

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

// --- Время жизни ещё НЕ начатого онлайн-лобби до авто-удаления ---
// Неполное (заняты НЕ все места) — 6 часов; полностью укомплектованное (все места заняты, но игра не начата) — 24 часа.
export const LOBBY_TTL_PARTIAL_MS = 6 * 60 * 60 * 1000;
export const LOBBY_TTL_FULL_MS = 24 * 60 * 60 * 1000;
export function lobbyTtlMs(game) {
  const full = (game.players?.length || 0) >= (game.config?.maxPlayers || 0);
  return full ? LOBBY_TTL_FULL_MS : LOBBY_TTL_PARTIAL_MS;
}
export function lobbyExpired(game, now) {
  return game.status === 'lobby' && (now - (game.createdAt || 0)) >= lobbyTtlMs(game);
}

// --- Заброшенная игра (без активности GAME_STALE_MS) → авто-уборка сборщиком (и онлайн, и оффлайн) ---
export const GAME_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 дней
export function gameStale(game, now) {
  return (game.status === 'active' || game.status === 'finished')
    && (now - (game.updatedAt || game.createdAt || 0)) >= GAME_STALE_MS;
}

// Сводка одной игры для секции «Мои игры» в браузере лобби (или null, если игра не моя / не идёт).
// «Моя» = я среди игроков (онлайн/бот), хост лобби или владелец хотсита.
export function myGameSummary(game, viewerPid) {
  if (!viewerPid || game.status !== 'active') return null;
  const mine = game.players.some(p => p.id === viewerPid) || game.hostPid === viewerPid || game.hotseatOwner === viewerPid;
  if (!mine) return null;
  const online = !!game.config?.listed;
  const cur = game.players[game.turn?.idx];
  return {
    id: game.id,
    mode: GAME_MODES[game.config?.mode]?.name || GAME_MODES[DEFAULT_MODE]?.name || 'Игра',
    online, hotseat: !!game.config?.hotseat, bot: !!game.config?.botGame,
    canFinish: online ? game.hostPid === viewerPid : true,   // оффлайн — всегда моя; онлайн — только хост
    turnNick: cur?.nick || '',
    myTurn: game.config?.hotseat ? true : cur?.id === viewerPid,
    opponents: game.players.filter(p => p.id !== viewerPid).map(p => p.nick),
    createdAt: game.createdAt
  };
}

// Метки-ОТКЛОНЕНИЯ от стандарта для строки лобби в СПИСКЕ. Дефолты не пишем:
// классика · туман войны ВКЛ · ход тремя судами · без таймера. Пишем только то, что отличается.
export function lobbyTags(game) {
  const c = game.config || {}, tags = [];
  if (c.realtime) tags.push(REALTIME_NAME + ' βeta');                            // ⚡ реалтайм-партия
  if (c.mode && c.mode !== DEFAULT_MODE) tags.push(GAME_MODES[c.mode]?.name);   // режим ≠ классики
  if (c.turnTimer) tags.push(`таймер ${c.turnTimer / 60} мин`);                  // дефолт — без таймера
  if (!isDuel(game)) {                                                           // в дуэли туман/ход-3 неприменимы
    if (c.fog === false) tags.push('без тумана');                                // дефолт — туман ВКЛ
    if (c.multiMove === false && !c.realtime) tags.push('по одному ходу');       // дефолт — ход-3; в реалтайме ходов нет вовсе
  }
  return tags.filter(Boolean);
}

// «Поторопить» AFK-игрока: письмо + жёсткие 10 минут на ход.
export const NUDGE_MS = 10 * 60 * 1000;
export function nudge(game, playerId) {
  if (game.status !== 'active') return { ok: false, error: 'Игра не активна' };
  if (isRealtime(game)) return { ok: false, error: 'В реалтайме некого торопить — все ходят одновременно' };
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

// Дуэль, стартовая закупка флота: правило «скупись на всё» (после покупки остаток < цены самого
// дешёвого корабля, иначе reject), спавн купленного флота в ряд на своей стороне, флаг ready.
// Когда оба игрока готовы — переключаем в фазу боя 'battle' и стартуем ходы.
function duelBuyFleet(game, pIdx, action) {
  const player = game.players[pIdx];
  if (player.ready) return { ok: false, error: 'Флот уже собран — ждём соперника' };
  const list = Array.isArray(action.ships) ? action.ships : [];
  if (!list.length) return { ok: false, error: 'Собери флот: добавь корабли в верфи' };
  if (list.some(t => !SHIP_TYPES[t] || SHIP_TYPES[t].cheat || SHIP_TYPES[t].fishing || !(SHIP_TYPES[t].price > 0)))
    return { ok: false, error: 'Недопустимый корабль для дуэли' };
  const cost = list.reduce((sum, t) => sum + SHIP_TYPES[t].price, 0);
  if (cost > player.gold) return { ok: false, error: 'Не хватает золота' };
  if (player.gold - cost >= cheapestShipPrice(true))
    return { ok: false, error: 'Скупись на всё золото — ещё можно купить корабль' };
  const spots = duelFleetSpots(game.map, pIdx, list.length);
  list.forEach((type, i) => {
    game.ships.push({
      id: 's' + (shipSeq++) + '_' + Math.random().toString(36).slice(2, 6),
      owner: pIdx, type, x: spots[i].x, y: spots[i].y, hp: SHIP_TYPES[type].hp,
      ...(SHIP_TYPES[type].repairer ? { repairCharges: REPAIR_CHARGES } : {})
    });
  });
  player.gold -= cost;
  player.ready = true;
  pushLog(game, `⚓ ${player.nick} собрал флот (${list.length} суд., −${cost} зол.) — готов к бою`, 'battle');
  if (game.players.every(p => p.ready)) {  // оба готовы → бой
    game.phase = 'battle';
    game.turn = { idx: 0, number: 1, round: 1, deadline: turnDeadline(game), nudged: false, moves: 0, actedShips: [], broadsideSides: {} };
    pushLog(game, `⚔️ Флоты собраны — бой! Первым ходит ${game.players[0].nick}`, 'battle');
  }
  return { ok: true, bought: list.length };
}

// Остались ли у игрока ВОЗМОЖНЫЕ действия в этом ходу (режим «ход тремя судами»):
// есть ещё не ходивший корабль (он хотя бы доплывёт/выстрелит) ИЛИ хватает золота на корабль в верфи.
// Если ни того, ни другого — ждать ручного «Завершить ход» незачем, ход закроется сам.
// Это про конец партии: судов осталось 1–2, и бюджет в 3 действия физически не выбрать.
function playerHasAction(game, pIdx) {
  const acted = new Set(game.turn.actedShips || []);
  if (game.ships.some(s => s.owner === pIdx && !acted.has(s.id))) return true; // есть кем ходить
  return (game.players[pIdx]?.gold || 0) >= cheapestShipPrice(isDuel(game));    // или есть на что купить в верфи
}

// ═══ Реалтайм («Шторм»): перезарядки ═══
// Метки готовности лежат прямо на корабле: ship.cd = { p: ts, s: ts, m: ts, r: ts }
// (левый борт / правый борт / мортира / ремонт; ts — когда снова можно, Date.now()-мс).
// Корабль сериализуется в стейт целиком → клиент сам рисует отсчёт перезарядки.
export const rtReady = (ship, key) => !ship.cd || !ship.cd[key] || Date.now() >= ship.cd[key];
export const rtArm = (ship, key, ms) => { (ship.cd ??= {})[key] = Date.now() + ms; };

// ⏸ Снятие паузы: сдвинуть ВСЕ абсолютные часы партии на её длительность — мир «просыпается»
// ровно там, где заснул (кулдауны не перезарядились, доход не капнул, мирное время не утекло).
// nextCast/nextSave НЕ трогаем — это wall-clock темп рассылки/сейва, не игровое время.
export function rtShift(game, ms) {
  const r = game.rt;
  if (!r || !(ms > 0)) return;
  for (const k of Object.keys(r))
    if (k !== 'nextCast' && k !== 'nextSave' && k !== 'paused' && typeof r[k] === 'number' && r[k] > 1e12)
      r[k] += ms; // сдвигаем только timestamp-поля (startedAt, windShiftAt, nextIncome/Fish/Outpost/Bot/Buy*, …)
  for (const s of game.ships) {
    if (s.cd) for (const k of Object.keys(s.cd)) s.cd[k] += ms;
    if (s.rtNext) s.rtNext += ms;   // пиратские «мысли»
    if (s.gunAt) s.gunAt += ms;     // пиратская перезарядка
  }
}

// Реалтайм: столкновение с сушей/краем карты (чужие корабли НЕ мешают — в море разойдутся,
// иначе плывущие корабли вечно застревали бы друг в друге).
export function terrainBlocked(game, x, y) {
  const m = game.map;
  if (x < MAP_EDGE_MARGIN || y < MAP_EDGE_MARGIN || x > m.w - MAP_EDGE_MARGIN || y > m.h - MAP_EDGE_MARGIN) return true;
  for (const b of m.bases) if (!b.noPort && dist(x, y, b.x, b.y) < b.radius + ISLAND_BLOCK_GAP) return true;
  for (const o of m.lootIslands) if (dist(x, y, o.x, o.y) < o.radius + ISLAND_BLOCK_GAP) return true;
  return false;
}

// Применение хода. action.type: buy | collect | move | attack | skip | buyFleet (дуэль)
export function applyAction(game, playerId, action) {
  if (game.status !== 'active') return { ok: false, error: 'Игра не активна' };
  let pIdx = game.players.findIndex(p => p.id === playerId);
  // хотсит: владелец устройства ходит за того, чья очередь
  if (pIdx === -1 && game.config.hotseat && playerId === game.hotseatOwner) pIdx = game.turn.idx;
  if (pIdx === -1) return { ok: false, error: 'Вы не участник игры' };
  // Дуэль, фаза закупки: оба игрока скупаются ОДНОВРЕМЕННО (вне очереди ходов), затем начинается бой.
  if (game.phase === 'buy') {
    if (action.type !== 'buyFleet') return { ok: false, error: 'Идёт закупка — собери флот в верфи' };
    return duelBuyFleet(game, pIdx, action);
  }
  if (action.type === 'buyFleet') return { ok: false, error: 'Закупка флота уже завершена' };
  // ⛈️ Реалтайм («Шторм»): очереди ходов нет — действуешь когда хочешь, стрельба по перезарядке.
  // Кейсы ниже ветвятся по rt: движение = приказ «плыть» (тик в rt.js везёт), борта/мортира/ремонт
  // проверяют и взводят кулдауны вместо «уже ходил в этом ходу». События НЕ сбрасываются на каждое
  // действие — копятся и уходят пачкой в рассылке тика (rt.js двигает eventSeq).
  const rt = isRealtime(game);
  if (!rt && pIdx !== game.turn.idx) return { ok: false, error: 'Сейчас не ваш ход' };
  const player = game.players[pIdx];
  if (rt && !player.alive) return { ok: false, error: 'Ты выбыл из баттла' };
  // ⏸ пауза реалтайма: мир заморожен, приказы не принимаются — только снятие паузы (любым игроком)
  if (rt && game.rt?.paused && action.type !== 'rtPause')
    return { ok: false, error: '⏸ Игра на паузе' };
  // режим «ход тремя судами»: одним кораблём за ход ходить можно только раз
  if (!rt && SHIP_ACTION_SET.has(action.type) && (game.turn.actedShips || []).includes(action.shipId))
    return { ok: false, error: 'Этот корабль уже ходил' };
  if (!rt) freshEvents(game); // события этого хода для анимаций на клиенте

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
          owner: pIdx, type, x: spot.x, y: spot.y, hp: SHIP_TYPES[type].hp,
          ...(SHIP_TYPES[type].repairer ? { repairCharges: REPAIR_CHARGES } : {})
        });
        bought.push(SHIP_TYPES[type].name);
      }
      player.gold -= cost;
      logEvent(game,
        `🛠 ${player.nick} покупает: ${bought.join(', ')} (−${cost} зол.)`,
        `🛠 ${player.nick} сходил на верфь`);
      break;
    }

    case 'collect': {
      let gained = 0;
      const notes = [];
      // Рыбалка теперь пассивная (капает в advanceTurn). Тут — только клад с островов.
      // Клад берут лишь корабли, ещё НЕ ходившие в этом ходу: нельзя «походить кораблём,
      // а затем им же собрать клад» (каждый корабль — одно действие за ход). Собравшие корабли
      // помечаются сходившими. В классике actedShips пуст → как раньше, сбор любым кораблём.
      // Реалтайм: ходов нет — собирает любой корабль рядом (actedSet пуст).
      const actedSet = new Set(rt ? [] : (game.turn.actedShips || []));
      const reachers = new Set();
      for (const isl of game.map.lootIslands.filter(i => !i.looted)) {
        const ships = game.ships.filter(s => s.owner === pIdx && !actedSet.has(s.id) &&
          dist(s.x, s.y, isl.x, isl.y) <= isl.radius + LOOT_REACH);
        if (ships.length) {
          isl.looted = true;
          gained += isl.loot;
          notes.push(`🏝 клад ${isl.loot}`);
          pushEvent(game, { type: 'gold', x: isl.x, y: isl.y, amount: isl.loot });
          ships.forEach(s => reachers.add(s.id));
        }
      }
      if (!gained) return { ok: false, error: 'Нечего собирать: нет (ещё не ходивших) кораблей у нелутанных островов' };
      player.gold += gained;
      player.stats.goldCollected += gained;
      debugGold(game, player, gained, 'клад с острова');
      if (!rt) reachers.forEach(id => (game.turn.actedShips ??= []).push(id)); // собравшие — походили этим ходом
      logEvent(game,
        `💰 ${player.nick} собирает добычу: +${gained} зол. (${notes.join(', ')})`,
        `💰 ${player.nick} собирает добычу`);
      break;
    }

    case 'move': {
      const ship = game.ships.find(s => s.id === action.shipId);
      if (!ship || ship.owner !== pIdx) return { ok: false, error: 'Это не ваш корабль' };
      if (rt) { // реалтайм: приказ «плыть» — без лимита дистанции; корабль плывёт сам (тик rt.js, ветер влияет)
        const m = game.map;
        ship.dest = {
          x: Math.min(m.w - MAP_EDGE_MARGIN, Math.max(MAP_EDGE_MARGIN, Math.round(action.x))),
          y: Math.min(m.h - MAP_EDGE_MARGIN, Math.max(MAP_EDGE_MARGIN, Math.round(action.y)))
        };
        break;
      }
      if (game.turn.broadsideSides?.[ship.id]?.length) return { ok: false, error: 'Корабль уже даёт залп — добей вторым бортом или жди' };
      const x = Math.round(action.x), y = Math.round(action.y);
      // 🌬 дальность хода зависит от курса: по ветру дальше, против — меньше (каплевидный контур)
      const range = SHIP_TYPES[ship.type].move * windMoveMult(game.wind, Math.atan2(y - ship.y, x - ship.x));
      if (dist(ship.x, ship.y, x, y) > range + 0.5)
        return { ok: false, error: dist(ship.x, ship.y, x, y) <= SHIP_TYPES[ship.type].move + 0.5 ? '🌬 Против ветра так далеко не уплыть' : 'Слишком далеко: линейка не дотягивается' };
      const blocked = shipPlacementBlocked(game, x, y, ship.id);
      if (blocked) return { ok: false, error: blocked };
      if (dist(ship.x, ship.y, x, y) > 1) ship.heading = Math.atan2(y - ship.y, x - ship.x); // курс — для определения бортов залпа
      // мирное время («Развитие»): нельзя подходить к чужой базе ближе keepout
      if (isPeace(game)) {
        const keep = modeOf(game).peaceBaseKeepout || 0;
        if (keep && game.map.bases.some((b, bi) => bi !== pIdx && game.players[bi]?.alive && dist(x, y, b.x, b.y) < keep))
          return { ok: false, error: '🕊 Мирное время: к чужой базе подходить нельзя' };
      }
      pushEvent(game, { type: 'move', shipId: ship.id, fx: ship.x, fy: ship.y, tx: x, ty: y });
      ship.x = x; ship.y = y;
      logEvent(game,
        `🧭 ${player.nick} ведёт ${SHIP_TYPES[ship.type].name} на новую позицию`,
        `🧭 ${player.nick} сделал ход`);
      break;
    }

    case 'attack': {
      const ship = game.ships.find(s => s.id === action.shipId);
      if (!ship || ship.owner !== pIdx) return { ok: false, error: 'Это не ваш корабль' };
      const st = SHIP_TYPES[ship.type];
      // 🎯 МОРТИРА (прицельный одиночный выстрел) — только у фрегата/линкора (+ чит-авианосец)
      if (!MORTAR_SHIPS.includes(ship.type) && !st.cheat) return { ok: false, error: 'Мортира только у фрегата и линкора' };
      if (!rt && game.turn.broadsideSides?.[ship.id]?.length) return { ok: false, error: 'Корабль уже даёт залп — добей вторым бортом или жди' };
      if (rt && !rtReady(ship, 'm')) return { ok: false, error: '🎯 Мортира перезаряжается' };
      const volley = st.volley || 1; // авианосец (чит) бьёт залпом из нескольких снарядов подряд

      if (action.targetType === 'ship') {
        const target = game.ships.find(s => s.id === action.targetId);
        if (!target || target.owner === pIdx) return { ok: false, error: 'Неверная цель' };
        // мирное время: на игроков нападать нельзя (пиратов — можно)
        if (target.owner >= 0 && isPeace(game)) return { ok: false, error: '🕊 Мирное время: на игроков нападать нельзя' };
        if (dist(ship.x, ship.y, target.x, target.y) > st.fireRange + 0.5)
          return { ok: false, error: 'Цель вне дальности стрельбы' };
        const hit = Math.max(1, Math.round(st.dmg * MORTAR_SHIP_MULT)); // мортира по СУДАМ — половина (её дело осада, не размен в море)
        const total = hit * volley;
        target.hp -= total;
        player.stats.shotsFired++;
        player.stats.damageDealt += total;
        if (!isHumanFoe(game, target.owner)) player.stats.npcDamage += total; // урон по пирату/боту → из лидерборда вычтется
        for (let i = 0; i < volley; i++) // снаряды — клиент проигрывает их один за другим (auto=скорострельная очередь)
          pushEvent(game, { type: 'shot', fx: ship.x, fy: ship.y, tx: target.x, ty: target.y, dmg: hit, auto: volley > 1 });
        const targetName = target.owner === -1
          ? 'пиратскому кораблю'
          : `${SHIP_TYPES[target.type].name} игрока ${game.players[target.owner].nick}`;
        const abstractFoe = target.owner === -1 ? 'пиратов' : `флот игрока ${game.players[target.owner].nick}`;
        logEvent(game,
          `🔥 ${player.nick}: ${st.name} бьёт по ${targetName} (−${total} HP${volley > 1 ? ` залпом ×${volley}` : ''})`,
          `🔥 ${player.nick} напал на ${abstractFoe}`, 'battle');
        if (target.hp <= 0) sinkShip(game, target, player);
        else if (target.owner === -1) target.angryAt = pIdx; // пираты запоминают обидчика
      } else if (action.targetType === 'port') {
        if (isDuel(game)) return { ok: false, error: 'В дуэли баз нет — бей по кораблям' };
        const targetIdx = action.targetId;
        const victim = game.players[targetIdx];
        if (!victim || targetIdx === pIdx || !victim.alive) return { ok: false, error: 'Неверная цель' };
        if (isPeace(game)) return { ok: false, error: '🕊 Мирное время: базы трогать нельзя' };
        const base = game.map.bases[targetIdx];
        if (dist(ship.x, ship.y, base.x, base.y) > st.fireRange + base.radius * 0.5)
          return { ok: false, error: 'Порт вне дальности стрельбы' };
        const portDmg = Math.round(st.dmg * (st.portBonus || 1)); // линкор бьёт по порту сильнее (portBonus)
        const totalPort = portDmg * volley;
        victim.portHp -= totalPort;
        player.stats.shotsFired++;
        player.stats.damageDealt += totalPort;
        if (victim.isBot) player.stats.npcDamage += totalPort; // урон по базе бота → из лидерборда вычтется
        for (let i = 0; i < volley; i++)
          pushEvent(game, { type: 'shot', fx: ship.x, fy: ship.y, tx: base.x, ty: base.y, dmg: portDmg, auto: volley > 1 });
        logEvent(game,
          `🔥 ${player.nick} обстреливает порт игрока ${victim.nick} (−${totalPort} HP, осталось ${Math.max(0, victim.portHp)})`,
          `🔥 ${player.nick} напал на базу игрока ${victim.nick}`, 'battle');
        if (victim.portHp <= 0) {
          victim.portHp = 0;
          eliminatePlayer(game, targetIdx, player);
        } else {
          // порт огрызается: ответный залп по атакующему кораблю. Линкору — на 20% больнее (он осадный, ему и сдача жирнее).
          const retDmg = Math.round(PORT_RETURN_DMG * (ship.type === 'linkor' ? PORT_RETURN_LINKOR_MULT : 1));
          ship.hp -= retDmg;
          pushEvent(game, { type: 'shot', fx: base.x, fy: base.y, tx: ship.x, ty: ship.y, dmg: retDmg });
          logEvent(game,
            `🏰 Порт игрока ${victim.nick} огрызается по ${SHIP_TYPES[ship.type].name} (−${retDmg} HP)`,
            `🏰 База игрока ${victim.nick} даёт отпор`, 'battle');
          if (ship.hp <= 0) sinkShip(game, ship, victim); // защитник забирает обломки
        }
      } else if (action.targetType === 'outpost') {
        // 🎯 мортира — ЕДИНСТВЕННОЕ, что разрушает чужой аванпост (осада — дело тяжёлых)
        const isl = (game.map.lootIslands || [])[action.targetId];
        const op = isl?.outpost;
        if (!op || op.owner === pIdx) return { ok: false, error: 'Неверная цель' };
        if (isPeace(game)) return { ok: false, error: '🕊 Мирное время: чужие постройки трогать нельзя' };
        if (dist(ship.x, ship.y, isl.x, isl.y) > st.fireRange + isl.radius * 0.5)
          return { ok: false, error: 'Аванпост вне дальности стрельбы' };
        const total = st.dmg * volley; // по строению мортира бьёт полным уроном
        op.hp -= total;
        player.stats.shotsFired++;
        player.stats.damageDealt += total;
        if (game.players[op.owner]?.isBot) player.stats.npcDamage += total; // постройка бота → не в лидерборд
        for (let i = 0; i < volley; i++)
          pushEvent(game, { type: 'shot', fx: ship.x, fy: ship.y, tx: isl.x, ty: isl.y, dmg: st.dmg, auto: volley > 1 });
        const def = OUTPOST_LEVELS[op.level - 1];
        const victimNick = game.players[op.owner]?.nick || '?';
        if (op.hp <= 0) {
          isl.outpost = null; // остров снова ничей — можно строить заново
          pushEvent(game, { type: 'explosion', x: isl.x, y: isl.y, big: true });
          logEvent(game,
            `💥 ${player.nick} разрушает ${def.icon} ${def.name} игрока ${victimNick}!`,
            `💥 ${player.nick} разрушил чужую постройку`, 'battle');
        } else {
          logEvent(game,
            `🔥 ${player.nick}: ${st.name} бьёт по ${def.icon} ${def.name} игрока ${victimNick} (−${total} HP, осталось ${op.hp})`,
            `🔥 ${player.nick} обстреливает чужую постройку`, 'battle');
        }
      } else {
        return { ok: false, error: 'Неизвестная цель' };
      }
      if (rt) rtArm(ship, 'm', RT.CD_MORTAR_MS); // реалтайм: мортира ушла на перезарядку
      break;
    }

    case 'repair': {
      // Ремонтник латает ОДИН свой корабль в радиусе (как выстрел, но восстанавливает HP).
      const ship = game.ships.find(s => s.id === action.shipId);
      if (!ship || ship.owner !== pIdx) return { ok: false, error: 'Это не ваш корабль' };
      const st = SHIP_TYPES[ship.type];
      if (!st.repairer) return { ok: false, error: 'Этот корабль не умеет чинить' };
      if (rt && !rtReady(ship, 'r')) return { ok: false, error: '🛟 Ремонт перезаряжается' };
      if ((ship.repairCharges ?? REPAIR_CHARGES) <= 0) return { ok: false, error: 'Нет материалов — вернись на базу и пополни' };
      const target = game.ships.find(s => s.id === action.targetId);
      if (!target || target.owner !== pIdx) return { ok: false, error: 'Чинить можно только свои корабли' };
      if (target.id === ship.id) return { ok: false, error: 'Ремонтник не чинит сам себя' };
      if (dist(ship.x, ship.y, target.x, target.y) > st.fireRange + 0.5)
        return { ok: false, error: 'Цель вне радиуса ремонта' };
      const maxHp = SHIP_TYPES[target.type].hp;
      if (target.hp >= maxHp) return { ok: false, error: 'Этот корабль и так целёхонек' };
      // ремонт = доля от МАКСИМАЛЬНОГО HP цели (healFrac), не больше недостающего
      const healed = Math.min(Math.round(maxHp * st.healFrac), maxHp - target.hp);
      target.hp += healed;
      if (rt) rtArm(ship, 'r', RT.CD_REPAIR_MS); // реалтайм: ремонт на перезарядку
      ship.repairCharges = (ship.repairCharges ?? REPAIR_CHARGES) - 1; // потратили один заряд материалов (undefined=полный для старых сейвов)
      pushEvent(game, { type: 'repair', fx: ship.x, fy: ship.y, tx: target.x, ty: target.y, heal: healed });
      logEvent(game,
        `🛟 ${player.nick}: ${st.name} латает ${SHIP_TYPES[target.type].name} (+${healed} HP, осталось зарядов ${ship.repairCharges})`,
        `🛟 ${player.nick} ремонтирует свой флот`);
      break;
    }

    case 'recharge': {
      // 🔧 Ремонтник у СВОЕЙ базы пополняет запас материалов (как «собрать», но восстанавливает заряды ремонта).
      const ship = game.ships.find(s => s.id === action.shipId);
      if (!ship || ship.owner !== pIdx) return { ok: false, error: 'Это не ваш корабль' };
      const st = SHIP_TYPES[ship.type];
      if (!st.repairer) return { ok: false, error: 'Пополнять материалы умеет только ремонтник' };
      if ((ship.repairCharges ?? REPAIR_CHARGES) >= REPAIR_CHARGES) return { ok: false, error: 'Запас материалов уже полный' };
      const base = game.map.bases[pIdx];
      if (dist(ship.x, ship.y, base.x, base.y) > base.radius + REPAIR_DOCK_REACH)
        return { ok: false, error: 'Пополнить материалы можно только у своей базы' };
      ship.repairCharges = REPAIR_CHARGES;
      logEvent(game,
        `🔧 ${player.nick}: ${st.name} пополнил материалы на базе (зарядов ${REPAIR_CHARGES})`,
        `🔧 ${player.nick} пополняет ремонтника`);
      break;
    }

    case 'broadside': {
      // 💥 БОРТОВОЙ ЗАЛП: по КАЖДОЙ цели с борта dmg = st.dmg × angle(положение в секторе) × falloff(дистанция).
      const ship = game.ships.find(s => s.id === action.shipId);
      if (!ship || ship.owner !== pIdx) return { ok: false, error: 'Это не ваш корабль' };
      const st = SHIP_TYPES[ship.type];
      const cannons = BROADSIDE_CANNONS[ship.type] || 0;
      if (!cannons) return { ok: false, error: 'Этот корабль не даёт бортовой залп' };
      const cx = game.map.w / 2, cy = game.map.h / 2;
      const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
      const heading = (typeof ship.heading === 'number') ? ship.heading : Math.atan2(cy - ship.y, cx - ship.x);
      // прицел игрока → выбор борта (port/starboard); весь борт бьёт по ВСЕМ врагам с этой стороны в радиусе
      const aimAng = Math.atan2((action.ty ?? cy) - ship.y, (action.tx ?? cx) - ship.x);
      const portDir = norm(heading - Math.PI / 2), starDir = norm(heading + Math.PI / 2);
      const side = Math.abs(norm(aimAng - portDir)) <= Math.abs(norm(aimAng - starDir)) ? 'port' : 'starboard';
      const sideDir = side === 'port' ? portDir : starDir;
      // пошагово: борт стреляет раз в ход (учёт в turn.broadsideSides); реалтайм: у каждого борта свой кулдаун
      const sides = rt
        ? ['port', 'starboard'].filter(sd => !rtReady(ship, sd === 'port' ? 'p' : 's'))
        : ((game.turn.broadsideSides ||= {})[ship.id] ||= []);
      if (sides.includes(side)) return { ok: false, error: (side === 'port' ? 'Левый' : 'Правый') + ' борт ' + (rt ? 'перезаряжается' : 'уже стрелял в этом ходу') };
      const range = st.fireRange, full = !!st.cheat; // чит-авианосец — круговой залп (без сектора)
      const peace = isPeace(game);
      // цели-корабли с этого борта в радиусе — все, урон только по дистанции (ближе = больнее)
      const shipHits = [];
      for (const t of game.ships) {
        if (t.id === ship.id || t.owner === pIdx) continue;
        if (t.owner >= 0 && !game.players[t.owner]?.alive) continue;
        if (t.owner >= 0 && peace) continue; // мир: игроков не трогаем (пиратов — можно)
        const d = dist(ship.x, ship.y, t.x, t.y);
        if (d > range) continue;
        const off = norm(Math.atan2(t.y - ship.y, t.x - ship.x) - sideDir);
        if (!full && Math.abs(off) > BROADSIDE_HALF_ARC) continue; // не с этого борта (нос/корма)
        const falloff = 1 - (1 - BROADSIDE_FALLOFF_MIN) * (d / range);
        const angle = full ? 1 : 1 - (1 - BROADSIDE_SIDE_MIN) * Math.min(1, Math.abs(off) / BROADSIDE_HALF_ARC); // перпендикуляр=1.0 → края=SIDE_MIN
        shipHits.push({ t, dmg: Math.max(1, Math.round(st.dmg * angle * falloff)) });
      }
      // вражеский ПОРТ в секторе — символический урон (осада — мортирой), но порт огрызается как обычно
      let portHit = null;
      if (!peace && !isDuel(game)) for (let i = 0; i < game.players.length; i++) {
        if (i === pIdx || !game.players[i].alive) continue;
        const base = game.map.bases[i], d = dist(ship.x, ship.y, base.x, base.y);
        if (d > range + base.radius * 0.5) continue;
        const off = norm(Math.atan2(base.y - ship.y, base.x - ship.x) - sideDir);
        if (!full && Math.abs(off) > BROADSIDE_HALF_ARC) continue;
        const falloff = 1 - (1 - BROADSIDE_FALLOFF_MIN) * (Math.min(d, range) / range);
        const angle = full ? 1 : 1 - (1 - BROADSIDE_SIDE_MIN) * Math.min(1, Math.abs(off) / BROADSIDE_HALF_ARC);
        portHit = { i, base, dmg: Math.max(1, Math.round(st.dmg * angle * falloff * BROADSIDE_PORT_MULT)) };
        break;
      }
      if (!shipHits.length && !portHit) return { ok: false, error: 'С этого борта нет целей в радиусе' };
      // ПРИМЕНЯЕМ
      if (rt) rtArm(ship, side === 'port' ? 'p' : 's', RT.CD_BROADSIDE_MS); // борт на перезарядку
      else sides.push(side);
      ship.heading = heading;
      player.stats.shotsFired++;
      const evHits = [], toSink = [];
      for (const h of shipHits) {
        h.t.hp -= h.dmg;
        player.stats.damageDealt += h.dmg;
        if (!isHumanFoe(game, h.t.owner)) player.stats.npcDamage += h.dmg; // НПС → из лидерборда вычтется
        evHits.push({ tx: h.t.x, ty: h.t.y, dmg: h.dmg });
        if (h.t.hp <= 0) toSink.push(h.t); else if (h.t.owner === -1) h.t.angryAt = pIdx;
      }
      let counterFrom = null;
      if (portHit) {
        const victim = game.players[portHit.i];
        victim.portHp -= portHit.dmg;
        player.stats.damageDealt += portHit.dmg;
        if (victim.isBot) player.stats.npcDamage += portHit.dmg; // база бота → из лидерборда вычтется
        evHits.push({ tx: portHit.base.x, ty: portHit.base.y, dmg: portHit.dmg });
        if (victim.portHp <= 0) { victim.portHp = 0; eliminatePlayer(game, portHit.i, player); }
        else counterFrom = portHit.base;
      }
      pushEvent(game, { type: 'volley', fx: ship.x, fy: ship.y, sideDir, cannons, full, shipType: ship.type, hits: evHits });
      for (const t of toSink) sinkShip(game, t, player);
      if (counterFrom) { // порт устоял — огрызается по стрелявшему (как у мортиры)
        const retDmg = Math.round(PORT_RETURN_DMG * (ship.type === 'linkor' ? PORT_RETURN_LINKOR_MULT : 1));
        ship.hp -= retDmg;
        pushEvent(game, { type: 'shot', fx: counterFrom.x, fy: counterFrom.y, tx: ship.x, ty: ship.y, dmg: retDmg });
        if (ship.hp <= 0) sinkShip(game, ship, game.players[portHit.i]);
      }
      logEvent(game,
        `💥 ${player.nick}: ${st.name} — бортовой залп (${side === 'port' ? 'левый' : 'правый'} борт) по ${shipHits.length} цел.` + (toSink.length ? ` — потоплено ${toSink.length}!` : ''),
        `💥 ${player.nick} даёт бортовой залп`, 'battle');
      break;
    }

    case 'outpost': {
      // ⛺ аванпост на ЗАЛУТАННОМ острове. ПЕРВАЯ постройка — свой корабль вплотную (он привозит
      // гарнизон); АПГРЕЙД — кликом по самому аванпосту, корабль не нужен (гарнизон строит сам).
      const isl = (game.map.lootIslands || [])[action.islandId];
      if (!isl) return { ok: false, error: 'Остров не найден' };
      if (!isl.looted) return { ok: false, error: 'Сначала забери клад — аванпост ставят на залутанном острове' };
      if (isl.outpost && isl.outpost.owner !== pIdx)
        return { ok: false, error: 'Тут чужой аванпост — сначала разрушь его 🎯 мортирой' };
      if (!isl.outpost) { // первая постройка: нужен корабль-строитель у берега
        const ship = game.ships.find(s => s.id === action.shipId);
        if (!ship || ship.owner !== pIdx) return { ok: false, error: 'Это не ваш корабль' };
        if (!rt && game.turn.broadsideSides?.[ship.id]?.length) return { ok: false, error: 'Корабль уже даёт залп — добей вторым бортом или жди' };
        if (dist(ship.x, ship.y, isl.x, isl.y) > isl.radius + OUTPOST_BUILD_REACH)
          return { ok: false, error: 'Подведи корабль вплотную к острову' };
      }
      const level = (isl.outpost?.level || 0) + 1;
      if (level > OUTPOST_LEVELS.length) return { ok: false, error: 'Аванпост уже прокачан до предела' };
      const def = OUTPOST_LEVELS[level - 1];
      if (player.gold < def.price) return { ok: false, error: `Не хватает золота (нужно ${def.price})` };
      player.gold -= def.price;
      isl.outpost = { owner: pIdx, level, hp: def.hp }; // апгрейд заодно отстраивает до полной прочности
      logEvent(game,
        `${def.icon} ${player.nick} ${level === 1 ? 'ставит' : 'прокачивает до'}: ${def.name} (−${def.price} зол.)`,
        `⛺ ${player.nick} строит на острове`);
      break;
    }

    case 'rtPause': {
      // ⏸ пауза реалтайма: ставит любой живой участник, снимает ТОЖЕ ЛЮБОЙ (анти-грифинг:
      // вечной паузой не запереть — оппонент просто снимет). На время паузы тик спит (rt.js),
      // при снятии ВСЕ часы (кулдауны, доходы, мир, агро ботов, пираты) сдвигаются на её длительность.
      if (!rt) return { ok: false, error: 'Пауза — только в «Полном вперёд»' };
      const rts = (game.rt ??= {});
      if (!rts.paused) {
        rts.paused = { by: pIdx, at: Date.now() };
        pushLog(game, `⏸ ${player.nick} ставит игру на паузу`, 'battle');
      } else {
        rtShift(game, Date.now() - rts.paused.at);
        rts.paused = null;
        pushLog(game, `▶️ ${player.nick} снимает паузу — полный вперёд!`, 'battle');
      }
      break;
    }

    case 'skip':
    case 'endTurn':
      if (rt) break; // реалтайм: ходов нет — тихий no-op (страховка для старых кнопок/ботов)
      // в многоходовом режиме после сделанных ходов это «завершить ход», а не «пропустить»
      pushLog(game, game.turn.moves > 0
        ? `✅ ${player.nick} завершает ход`
        : `⏭ ${player.nick} пропускает ход`);
      break;

    default:
      return { ok: false, error: 'Неизвестное действие' };
  }

  if (rt) return { ok: true }; // реалтайм: без бюджета ходов/actedShips/advanceTurn — время течёт само (rt.js)

  // любое успешное действие (ход/выстрел/залп/покупка/сбор) тратит один из ходов;
  // ход конкретным кораблём вдобавок помечает его сходившим (нельзя дважды за ход).
  // Ход завершается, когда исчерпан бюджет, явно нажата «Завершить»/«Пропустить»,
  // либо включён классический режим (там любое действие = конец хода).
  // БОРТОВОЙ ЗАЛП: КАЖДЫЙ борт = отдельное действие (слот). После одного борта корабль может дать только
  // ДРУГОЙ борт (ход/мортира ему уже нельзя), после обоих бортов — отстрелялся. Так залп честно тратит ход.
  if (action.type !== 'skip' && action.type !== 'endTurn') {
    game.turn.moves = (game.turn.moves || 0) + 1;
    if (action.type === 'broadside') {
      if ((game.turn.broadsideSides?.[action.shipId] || []).length >= 2) (game.turn.actedShips ??= []).push(action.shipId);
    } else if (SHIP_ACTION_SET.has(action.type) && action.shipId) { // апгрейд аванпоста идёт без корабля
      (game.turn.actedShips ??= []).push(action.shipId);
    }
  }
  const endsTurn = action.type === 'skip' || action.type === 'endTurn'
    || !game.config.multiMove || game.turn.moves >= movesBudget(game.config)
    || !playerHasAction(game, pIdx);   // больше нечем ходить (под конец партии судов мало) → закрываем ход сам
  if (game.status === 'active' && endsTurn) advanceTurn(game);
  return { ok: true };
}

// Спавн корабля у базы игрока (для читов тестового режима). Возвращает корабль или null (нет места).
export function spawnCheatShip(game, pIdx, type) {
  if (!game.map || !game.players[pIdx]) return null;
  const def = SHIP_TYPES[type];
  if (!def) return null;
  const spot = findFreeSpotNearBase(game, game.map.bases[pIdx]);
  if (!spot) return null;
  const ship = {
    id: 's' + (shipSeq++) + '_' + Math.random().toString(36).slice(2, 6),
    owner: pIdx, type, x: spot.x, y: spot.y, hp: def.hp, maxHp: def.hp,
    ...(def.repairer ? { repairCharges: REPAIR_CHARGES } : {})
  };
  game.ships.push(ship);
  freshEvents(game); // тихо: без записи в журнал (фидбэк игроку — через ack чита)
  return ship;
}

function findFreeSpotNearBase(game, base) {
  // корабли встают со стороны базы, ОБРАЩЁННОЙ К ЦЕНТРУ карты (а не всегда на восток) —
  // иначе игроку в правом углу флот спавнило в угол, в стену. Перебор веером от направления
  // к центру: 0, ±шаг, ±2·шаг… — первое свободное место всегда на «центровой» стороне.
  //
  // ВАЖНО (фикс «верфь говорит нет места, хотя деньги есть»): раньше перебирались только 5 колец ×
  // 14 секторов = 70 точек у базы. У разросшегося флота (долгий стояк, особенно с непотопляемым
  // авианосцем; быстрая экономика «хода тремя судами») эти 70 точек кончались — и покупка
  // отклонялась, хотя золота хватало. Теперь кольца идут НАРУЖУ до края карты, а в дальних кольцах
  // секторов гуще (равномерный шаг по дуге) — место находится ВСЕГДА, пока физически есть вода.
  // Первые SPAWN_FAN_RINGS колец и их угловое разрешение НЕ изменены — расстановка обычных (некрупных)
  // флотов остаётся точно прежней; дальний поиск включается, лишь когда ближние точки заняты.
  const m = game.map;
  const cx = m.w / 2, cy = m.h / 2;
  const toCenter = Math.atan2(cy - base.y, cx - base.x);
  const maxR = Math.hypot(m.w, m.h); // дальше любой достижимой точки карты — предел расширения
  for (let ring = 0; ; ring++) {
    const r = base.radius + SPAWN_FAN_R0 + ring * SPAWN_FAN_RING_STEP;
    if (r > maxR) break;
    // ближние кольца — как раньше (N=SPAWN_FAN_N); дальше — гуще, чтобы плотный флот всё равно поместился
    const N = ring < SPAWN_FAN_RINGS
      ? SPAWN_FAN_N
      : Math.max(SPAWN_FAN_N, Math.round((2 * Math.PI * r) / (SHIP_COLLISION_DIST * 1.2)));
    const step = (Math.PI * 2) / N;
    for (let i = 0; i < N; i++) {
      const ang = toCenter + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * step;
      const x = Math.round(base.x + Math.cos(ang) * r);
      const y = Math.round(base.y + Math.sin(ang) * r);
      if (!shipPlacementBlocked(game, x, y, null)) return { x, y };
    }
  }
  return null; // вся вода вокруг базы до края карты занята — практически недостижимо
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
  // чит-корабли видны клиенту только в тестовом режиме (нужны для отрисовки спавна); иначе — ни следа
  const shipTypes = { ...SHIP_TYPES, pirate: PIRATE };
  if (!CHEATS_ENABLED) for (const k in shipTypes) if (shipTypes[k]?.cheat) delete shipTypes[k];
  return {
    id: game.id,
    status: game.status,
    hostPid: game.hostPid || game.players[0]?.id || null, // кто хост лобби (по аккаунту) — для роли «создатель» на клиенте
    config: game.config,
    map: game.map,
    players: game.players.map(p => ({
      id: p.id, nick: p.nick, color: p.color,
      gold: (reveal || p.id === viewerPid) ? p.gold : null,
      portHp: p.portHp, alive: p.alive, placement: p.placement,
      ready: p.ready || false,                 // дуэль: собрал ли флот в фазе закупки
      stats: p.stats, isBot: p.isBot || false
    })),
    // 🎣 кормящиеся рыбаки помечаются netting (клиент рисует развёрнутую сеть ТОЛЬКО у попавших
    // в лимит зоны — очередь crew живёт на сервере, клиенту её не восстановить)
    ships: (() => {
      const netting = new Set();
      for (const z of game.map?.fishZones || []) for (const f of fishEarners(game, z)) netting.add(f.id);
      return netting.size ? game.ships.map(s => netting.has(s.id) ? { ...s, netting: true } : s) : game.ships;
    })(),
    turn: game.turn,
    log: game.log,
    winner: game.winner,
    events: game.events || [],
    eventSeq: game.eventSeq || 0,
    lootReach: LOOT_REACH,
    // ⛺ аванпосты: уровни/радиус перков/дистанция стройки (для кнопки, отрисовки и вики)
    outposts: { levels: OUTPOST_LEVELS, radius: OUTPOST_RADIUS, reach: OUTPOST_BUILD_REACH },
    repairChargesMax: REPAIR_CHARGES,
    repairDockReach: REPAIR_DOCK_REACH,
    portMax: PORT_HP,
    movesPerTurn: movesBudget(game.config), // 3 в режиме «ход тремя судами», иначе 1
    palette: PALETTE,
    // режим партии + мирный период (для баннера и подсказок клиента)
    mode: game.config.mode || 'classic',
    // дуэль: фаза ('buy' закупка | 'battle' бой) + цена самого дешёвого корабля (для правила «скупись на всё»)
    duel: isDuel(game), phase: game.phase || null, minShipPrice: cheapestShipPrice(isDuel(game)),
    modeName: GAME_MODES[game.config?.mode]?.name || GAME_MODES[DEFAULT_MODE]?.name, // человекочитаемое имя режима для клиента
    peace: {
      active: isPeace(game), round: game.turn?.round || 1, until: modePeaceRounds(game), keepout: modeOf(game).peaceBaseKeepout || 0,
      // реалтайм: мир меряется временем — клиент показывает обратный отсчёт вместо раундов
      // (⏸ на паузе отсчёт замирает: «сейчас» = момент постановки паузы)
      ...(isRealtime(game) && modePeaceRounds(game)
        ? { leftMs: Math.max(0, (game.rt?.startedAt || Date.now()) + modePeaceRounds(game) * RT.PEACE_MS_PER_ROUND - (game.rt?.paused?.at || Date.now())) }
        : {})
    },
    // параметры боя для клиента (сектор залпа, пушки по классам, у кого мортира)
    broadside: { halfArc: BROADSIDE_HALF_ARC, cannons: BROADSIDE_CANNONS, mortarShips: MORTAR_SHIPS, mortarShipMult: MORTAR_SHIP_MULT },
    // 🌬 ветер — во всех режимах: направление/сила + коэффициент влияния (для каплевидного контура хода)
    wind: game.wind ? { ang: game.wind.ang, str: game.wind.str } : { ang: 0, str: 0 },
    windK: WIND_STRENGTH,
    // ⚡ реалтайм («Полный вперёд», бета): серверные часы (для отсчёта перезарядок) и тайминги
    ...(isRealtime(game) ? {
      rt: {
        now: Date.now(),
        cds: { broadside: RT.CD_BROADSIDE_MS, mortar: RT.CD_MORTAR_MS, repair: RT.CD_REPAIR_MS },
        moveSeconds: RT.MOVE_SECONDS,
        // ⏸ пауза: когда и кем поставлена (клиент морозит отсчёты и показывает оверлей)
        ...(game.rt?.paused ? { pausedAt: game.rt.paused.at, pausedBy: game.rt.paused.by } : {})
      }
    } : {}),
    shipTypes
  };
}

// ═══ Экспорт примитивов для реалтайм-движка (rt.js) ═══
// Движок живёт отдельным файлом, но переиспользует игровые кирпичи: события/журнал,
// потопление, пиратский ИИ и рыбные слоты — чтобы реалтайм не разъезжался с пошаговой игрой.
export { pushEvent, pushLog, logEvent, sinkShip, spawnPirate, pirateAct, steerPirate, fishEarners, dist };
