// ⚡ «Полный вперёд» (реалтайм, бета) + 🌬 ветер во всех режимах.
// Реалтайм: одновременные действия, движение по тикам, перезарядки, экономика по таймерам, бот.
// Ветер: множитель дальности по курсу (каплевидный контур), дрейф между ходами, валидация хода.
import { createGame, addPlayer, startGame, applyAction, publicState, terrainBlocked } from './server/game.js';
import {
  GAME_MODES, isRealtime, realtimeAllowed, RT, SHIP_TYPES, PORT_INCOME, PIRATE,
  WIND_STRENGTH, windMoveMult
} from './server/config.js';
const PIRATE_MOVE_EXPECT = PIRATE.move / RT.MOVE_SECONDS; // 80/5 = 16 px/с — скорость пирата
import { tickMovement, tickEconomy, tickWind, windMult, botThink, pirateThink } from './server/rt.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

const setWind = (g, ang, str) => { g.wind = { ang, str, targetAng: ang, targetStr: str }; };

function newGame({ realtime = false } = {}) {
  const g = createGame('st', { maxPlayers: 2, turnTimer: 0, seed: 7 });
  if (realtime) g.config.realtime = true;
  addPlayer(g, 'p0', 'P0');
  addPlayer(g, 'p1', 'P1');
  startGame(g, 'p0');
  setWind(g, 0, 0); // детерминизм: штиль, цель = текущее (дрейф ничего не меняет)
  if (realtime) g.rt = { nextIncome: 0, nextFish: 0, windShiftAt: Infinity, startedAt: 0 };
  return g;
}
const put = (g, owner, type, x, y, hp) =>
  (g.ships.push({ id: `${owner}_${type}_${x}_${y}_${Math.random().toString(36).slice(2, 5)}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp }), g.ships.at(-1));
// свободный горизонтальный коридор воды шириной w — чтобы движение не упёрлось в остров
function freeCorridor(g, w = 240) {
  for (let y = 250; y < 1000; y += 40)
    for (let x = 300; x < 1300 - w; x += 40) {
      let clear = true;
      for (let dx = -20; dx <= w + 20 && clear; dx += 10) if (terrainBlocked(g, x + dx, y)) clear = false;
      if (clear) return { x, y };
    }
  throw new Error('нет свободного коридора');
}
// чистая вода радиусом r вокруг точки — для тестов разворота (дуга не должна цеплять сушу)
function openWater(g, r = 70) {
  for (let y = 200; y < 1000; y += 30)
    for (let x = 250; x < 1350; x += 30) {
      let clear = !terrainBlocked(g, x, y);
      for (let a = 0; a < Math.PI * 2 && clear; a += Math.PI / 6)
        if (terrainBlocked(g, x + Math.cos(a) * r, y + Math.sin(a) * r)) clear = false;
      if (clear) return { x, y };
    }
  throw new Error('нет чистой воды');
}

// ═══════════════ Каркас: реалтайм — флаг конфига, не режим ═══════════════
check('storm-режима больше нет (реалтайм = тумблер)', !GAME_MODES.storm);
check('isRealtime по config.realtime', isRealtime({ config: { realtime: true } }) === true && isRealtime({ config: { mode: 'classic' } }) === false);
check('реалтайм совместим: классика и дезматч', realtimeAllowed('classic') && realtimeAllowed('deathmatch'));
check('реалтайм НЕсовместим: дуэль и развитие', !realtimeAllowed('duel') && !realtimeAllowed('develop'));

// ═══════════════ 🌬 Ветер: математика и публичное состояние ═══════════════
{
  check('windMoveMult: по ветру ×(1+K)', Math.abs(windMoveMult({ ang: 0, str: 1 }, 0) - (1 + WIND_STRENGTH)) < 1e-9);
  check('windMoveMult: против ×(1−K)', Math.abs(windMoveMult({ ang: 0, str: 1 }, Math.PI) - (1 - WIND_STRENGTH)) < 1e-9);
  check('windMoveMult: поперёк ≈ ×1', Math.abs(windMoveMult({ ang: 0, str: 1 }, Math.PI / 2) - 1) < 1e-9);
  check('windMoveMult: штиль = ×1 всюду', windMoveMult({ ang: 1.3, str: 0 }, 2.2) === 1);
  const g = newGame();
  const st = publicState(g, 'p0');
  check('publicState: wind и windK — во ВСЕХ режимах', !!st.wind && typeof st.wind.ang === 'number' && st.windK === WIND_STRENGTH);
  check('пошаговая партия: rt-блока нет', !st.rt);
  const g0 = createGame('w0', { maxPlayers: 2, turnTimer: 0, seed: 7 });
  check('новая партия: штиль на старте (сила растёт со временем)', g0.wind.str === 0 && typeof g0.wind.ang === 'number');
}

// ═══════════════ 🌬 Ветер: дрейф между ходами (пошагово) ═══════════════
{
  const g = newGame();
  g.wind = { ang: 0, str: 0, targetAng: Math.PI, targetStr: 1 }; // цель: развернуться и раздуться
  applyAction(g, 'p0', { type: 'skip' });   // advanceTurn → driftWind
  check('дрейф: сила подросла (≤ шага)', g.wind.str > 0 && g.wind.str <= 0.11, `(${g.wind.str.toFixed(2)})`);
  check('дрейф: направление довернуло к цели (≤ шага)', g.wind.ang > 0 && g.wind.ang <= 0.31, `(${g.wind.ang.toFixed(2)})`);
  const angAfter1 = g.wind.ang;
  applyAction(g, 'p1', { type: 'skip' });   // полный круг → новая цель (рандом), но текущее меняется плавно
  check('дрейф: плавный (второй шаг ≤ 0.3 рад)', Math.abs(g.wind.ang - angAfter1) <= 0.31, `(${(g.wind.ang - angAfter1).toFixed(2)})`);
}

// ═══════════════ 🌬 Ветер: валидация хода — каплевидная дальность ═══════════════
{
  const g = newGame();
  const c = freeCorridor(g);
  const sh = put(g, 0, 'shkhuna', c.x + 120, c.y); // move=170; в коридоре есть вода и на восток, и на запад
  setWind(g, 0, 1); // ветер строго на восток, сила 1: по ветру 170×1.35=229.5, против 170×0.65=110.5
  const far = applyAction(g, 'p0', { type: 'move', shipId: sh.id, x: sh.x - 130, y: sh.y }); // против ветра, 130 > 110.5
  check('против ветра дальше эффективной дальности — отказ', !far.ok && /ветра/.test(far.error), far.error || '');
  const okUp = applyAction(g, 'p0', { type: 'move', shipId: sh.id, x: sh.x - 100, y: sh.y }); // 100 < 110.5
  check('против ветра ближе — можно', okUp.ok, okUp.error || '');
  setWind(g, 0, 1); // дрейф после хода мог сдвинуть — вернём для чистоты
  const sh2 = put(g, 1, 'shkhuna', c.x + 60, c.y);
  const downwind = applyAction(g, 'p1', { type: 'move', shipId: sh2.id, x: sh2.x + 200, y: sh2.y }); // 200 > 170, но < 229.5
  check('по ветру ДАЛЬШЕ номинала — можно (капля вытянута)', downwind.ok, downwind.error || '');
}

// ═══════════════ ⚡ Реалтайм: старт и публичное состояние ═══════════════
{
  const g = newGame({ realtime: true });
  check('старт: карта и флоты на месте', g.status === 'active' && g.ships.filter(s => s.owner === 0).length === 3);
  const st = publicState(g, 'p0');
  check('publicState: rt-блок (часы/кулдауны) + общий wind', !!st.rt && typeof st.rt.now === 'number' && !!st.rt.cds && !!st.wind);
  check('реалтайм-онлайн НЕ идёт в рейтинг', (await import('./server/game.js')).isRanked({ config: { listed: true, realtime: true } }) === false);
  check('обычный онлайн — в рейтинге', (await import('./server/game.js')).isRanked({ config: { listed: true } }) === true);
}

// ═══════════════ ⚡ Реалтайм: одновременные действия, приказы ═══════════════
{
  const g = newGame({ realtime: true });
  const s0 = g.ships.find(s => s.owner === 0), s1 = g.ships.find(s => s.owner === 1);
  const r0 = applyAction(g, 'p0', { type: 'move', shipId: s0.id, x: s0.x + 100, y: s0.y });
  const r1 = applyAction(g, 'p1', { type: 'move', shipId: s1.id, x: s1.x - 100, y: s1.y });
  check('p0 и p1 действуют одновременно (нет «не ваш ход»)', r0.ok && r1.ok, JSON.stringify([r0, r1]));
  check('move = приказ (dest), не телепорт', !!s0.dest && Math.hypot(s0.dest.x - s0.x, s0.dest.y - s0.y) > 1);
  check('ход НЕ переключается (turn.number не растёт)', g.turn.number === 1, `(${g.turn.number})`);
  const r2 = applyAction(g, 'p0', { type: 'skip' });
  check('skip в реалтайме — тихий no-op', r2.ok && g.turn.number === 1);
}

// ═══════════════ ⚡ Реалтайм: движение по тикам, ветер, суша ═══════════════
{
  const g = newGame({ realtime: true });
  const c = freeCorridor(g);
  const sh = put(g, 0, 'shkhuna', c.x, c.y);
  applyAction(g, 'p0', { type: 'move', shipId: sh.id, x: c.x + 200, y: c.y });
  tickMovement(g, 1000); // 1 секунда, штиль
  const expected = SHIP_TYPES.shkhuna.move / RT.MOVE_SECONDS; // 170/5 = 34 px
  check('за 1с корабль прошёл move/MOVE_SECONDS', Math.abs((sh.x - c.x) - expected) < 1.5, `(${(sh.x - c.x).toFixed(1)} ≈ ${expected})`);
  for (let i = 0; i < 40; i++) tickMovement(g, 1000);
  check('дошёл до точки и встал', !sh.dest && Math.abs(sh.x - (c.x + 200)) < 3, `(${sh.x.toFixed(1)})`);
  setWind(g, 0, 1); // по ветру на восток
  applyAction(g, 'p0', { type: 'move', shipId: sh.id, x: sh.x - 150, y: c.y }); // плывём ПРОТИВ
  const x0 = sh.x;
  tickMovement(g, 1000);
  check('против ветра медленнее базовой', Math.abs(x0 - sh.x) < expected - 5, `(${(x0 - sh.x).toFixed(1)})`);
  check('windMult обёртка живёт на game.wind', Math.abs(windMult(g, 0) - (1 + WIND_STRENGTH)) < 1e-9);
  // в сушу не заплывает
  const isl = g.map.lootIslands[0];
  applyAction(g, 'p0', { type: 'move', shipId: sh.id, x: isl.x, y: isl.y });
  for (let i = 0; i < 120; i++) tickMovement(g, 500);
  check('у острова остановился, не на суше', !terrainBlocked(g, sh.x, sh.y));
  // смена ветра тиком
  g.rt.windShiftAt = 0;
  tickWind(g, Date.now(), 100);
  check('реалтайм: смена ветра выбирает новую цель', g.rt.windShiftAt > Date.now() - 1000 && typeof g.wind.targetAng === 'number');
}

// ═══════════════ ⚡ Реалтайм: траектория разворота (анти-флип бортов) ═══════════════
{
  const g = newGame({ realtime: true });
  const c = openWater(g);
  const lk = put(g, 0, 'linkor', c.x, c.y);
  lk.heading = 0; // нос на восток
  applyAction(g, 'p0', { type: 'move', shipId: lk.id, x: c.x - 220, y: c.y }); // приказ строго НАЗАД
  tickMovement(g, 500);
  const turned = Math.abs(lk.heading);
  check('доворот ограничен turnRate·dt (линкор 0.65 рад/с)', turned <= 0.65 * 0.5 + 1e-6 && turned > 0.2, `(${turned.toFixed(2)} рад за 0.5с)`);
  let t = 500;
  while (Math.abs(Math.abs(lk.heading) - Math.PI) > 0.15 && t < 12000) { tickMovement(g, 250); t += 250; }
  check('перекладка на другой борт — секунды, не мгновенно', t >= 3500 && t < 8000, `(${(t / 1000).toFixed(1)}с)`);
}

// ═══════════════ ⚡ Реалтайм: обход островов ═══════════════
{
  const g = newGame({ realtime: true });
  // остров с чистыми флангами: старт западнее, цель восточнее — раньше корабль просто упирался
  let start = null, dest = null;
  for (const i of g.map.lootIslands) {
    const s = { x: i.x - i.radius - 80, y: i.y }, d = { x: i.x + i.radius + 80, y: i.y };
    if (!terrainBlocked(g, s.x, s.y) && !terrainBlocked(g, d.x, d.y)) { start = s; dest = d; break; }
  }
  check('нашли остров для теста обхода', !!start);
  const sh = put(g, 0, 'shkhuna', start.x, start.y);
  sh.heading = 0;
  applyAction(g, 'p0', { type: 'move', shipId: sh.id, x: dest.x, y: dest.y });
  for (let i = 0; i < 600 && sh.dest; i++) tickMovement(g, 250); // до 2.5 мин симуляции (скорость ÷3)
  const left = Math.hypot(sh.x - dest.x, sh.y - dest.y);
  check('корабль ОБОШЁЛ остров и дошёл до цели', !sh.dest && left < 12, `(осталось ${left.toFixed(0)}px)`);
  check('и не стоит на суше', !terrainBlocked(g, sh.x, sh.y));
}

// ═══════════════ ⚡ Реалтайм: пираты — кулдаун пушки + непрерывное плавание ═══════════════
{
  const g = newGame({ realtime: true });
  const c = openWater(g);
  const pir = put(g, -1, 'pirate', c.x, c.y, 80);
  const prey = put(g, 0, 'shkhuna', c.x + 60, c.y); // в радиусе пиратской пушки (130)
  const now = Date.now();
  pirateThink(g, pir, now);
  check('пират выстрелил и взвёл перезарядку', prey.hp === 60 - 12 && pir.gunAt > now, `(hp ${prey.hp})`);
  pirateThink(g, pir, now + 1000);
  check('до конца перезарядки НЕ стреляет (нет пулемёта)', prey.hp === 48, `(hp ${prey.hp})`);
  pir.gunAt = 0;
  pirateThink(g, pir, now + 2000);
  check('после перезарядки — снова выстрел', prey.hp === 36, `(hp ${prey.hp})`);
  // движение: тот же tickMovement, что у кораблей (непрерывное, не телепорт-прыжки)
  pir.dest = { x: pir.x + 100, y: pir.y };
  pir.heading = 0;
  const px = pir.x;
  tickMovement(g, 1000);
  const step = PIRATE_MOVE_EXPECT;
  check('пират плывёт непрерывно (move/MOVE_SECONDS в сек)', Math.abs((pir.x - px) - step) < 1.5, `(${(pir.x - px).toFixed(1)} ≈ ${step})`);
}

// ═══════════════ 🏴‍☠️ Пиратский БОРТОВОЙ ЗАЛП: 2 снаряда у малого, 3 у босса ═══════════════
{
  const g = newGame({ realtime: true });
  const c = openWater(g);
  const pir = put(g, -1, 'pirate', c.x, c.y, 80);
  const prey1 = put(g, 0, 'shkhuna', c.x + 60, c.y);        // основная цель на востоке
  const prey2 = put(g, 0, 'brig', c.x + 70, c.y + 15);      // рядом, в том же секторе борта
  g.events = [];
  pirateThink(g, pir, Date.now());
  const ev = (g.events || []).find(e => e.type === 'volley' && e.shipType === 'pirate');
  check('обычный пират бьёт ЗАЛПОМ из 2 снарядов (событие volley)', !!ev && ev.cannons === 2, `(cannons ${ev?.cannons})`);
  check('залп накрывает ВСЕХ игроков в секторе борта', prey1.hp === 60 - 12 && prey2.hp === 110 - 12, `(hp ${prey1.hp}/${prey2.hp})`);
  check('пират развернулся бортом (цель на траверзе)', Math.abs(Math.abs(pir.heading - Math.atan2(prey1.y - c.y, prey1.x - c.x)) - Math.PI / 2) < 0.3);

  const boss = put(g, -1, 'pirate', c.x, c.y - 40, 220);
  boss.boss = true;
  g.events = [];
  pirateThink(g, boss, Date.now());
  const evB = (g.events || []).find(e => e.type === 'volley' && e.shipType === 'pirate');
  check('БОСС бьёт залпом из 3 снарядов (как фрегат)', !!evB && evB.cannons === 3, `(cannons ${evB?.cannons})`);
}

// ═══════════════ ⚡ Реалтайм: перезарядки ═══════════════
{
  const g = newGame({ realtime: true });
  const c = freeCorridor(g);
  const me = put(g, 0, 'brig', c.x + 100, c.y);
  me.heading = 0; // курс на восток → борта смотрят на север/юг
  const north = put(g, 1, 'shkhuna', c.x + 100, c.y - 80);
  const south = put(g, 1, 'shkhuna', c.x + 100, c.y + 80);
  const r1 = applyAction(g, 'p0', { type: 'broadside', shipId: me.id, tx: north.x, ty: north.y });
  check('залп борт №1 — ок', r1.ok, r1.error || '');
  const r2 = applyAction(g, 'p0', { type: 'broadside', shipId: me.id, tx: north.x, ty: north.y });
  check('тот же борт сразу — «перезаряжается»', !r2.ok && /перезаряжается/.test(r2.error), r2.error || '');
  const r3 = applyAction(g, 'p0', { type: 'broadside', shipId: me.id, tx: south.x, ty: south.y });
  check('другой борт — стреляет сразу (кулдауны независимы)', r3.ok, r3.error || '');
  me.cd = {};
  check('после перезарядки борт снова стреляет', applyAction(g, 'p0', { type: 'broadside', shipId: me.id, tx: north.x, ty: north.y }).ok);
  check('движение при перезарядке НЕ заблокировано', applyAction(g, 'p0', { type: 'move', shipId: me.id, x: me.x + 50, y: me.y }).ok);
  const fr = put(g, 0, 'fregat', c.x, c.y - 60);
  const m1 = applyAction(g, 'p0', { type: 'attack', shipId: fr.id, targetType: 'ship', targetId: north.id });
  const m2 = applyAction(g, 'p0', { type: 'attack', shipId: fr.id, targetType: 'ship', targetId: north.id });
  check('мортира: выстрел ок, повтор — «перезаряжается»', m1.ok && !m2.ok && /перезаряжается/.test(m2.error || ''), (m1.error || '') + ' / ' + (m2.error || ''));
}

// ═══════════════ ⚡ Реалтайм: экономика/лут/бот/финал ═══════════════
{
  const g = newGame({ realtime: true });
  const g0 = g.players[0].gold, g1 = g.players[1].gold;
  tickEconomy(g, Date.now());
  check('доход порта капнул обоим по таймеру', g.players[0].gold === g0 + PORT_INCOME && g.players[1].gold === g1 + PORT_INCOME);
  const zone = g.map.fishZones[0];
  put(g, 0, 'barkas', zone.x, zone.y);
  const before = g.players[0].gold;
  g.rt.nextFish = 0;
  tickEconomy(g, Date.now());
  check('рыбалка капает по таймеру', g.players[0].gold === before + SHIP_TYPES.barkas.fishing, `(${g.players[0].gold - before})`);

  const isl = g.map.lootIslands.find(i => !i.looted);
  put(g, 0, 'shkhuna', isl.x + isl.radius + 30, isl.y);
  const b2 = g.players[0].gold;
  check('клад собирается любым кораблём', applyAction(g, 'p0', { type: 'collect' }).ok && g.players[0].gold === b2 + isl.loot);

  g.players[1].isBot = true; g.players[1].botLevel = 'mid';
  botThink(g, 1, Date.now());
  check('бот раздал приказы движения', g.ships.filter(s => s.owner === 1 && s.dest).length >= 1);
  g.players[1].gold = 520;
  g.rt['nextBuy1'] = 0;
  const fleet = g.ships.filter(s => s.owner === 1).length;
  botThink(g, 1, Date.now());
  check('бот докупает флот по таймеру', g.ships.filter(s => s.owner === 1).length === fleet + 1);

  const lk = put(g, 0, 'linkor', g.map.bases[1].x - 150, g.map.bases[1].y);
  g.players[1].portHp = 5;
  const r = applyAction(g, 'p0', { type: 'attack', shipId: lk.id, targetType: 'port', targetId: 1 });
  check('порт добит — игра завершена', r.ok && g.status === 'finished' && g.winner !== null, r.error || g.status);
}

console.log(`\n⚡🌬 Полный вперёд + ветер: ${ok} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
