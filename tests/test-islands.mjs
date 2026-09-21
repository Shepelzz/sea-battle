// ⛺ Аванпосты на захваченных островах + 🐟 миграция рыбных мест (все режимы).
// Постройка/прокачка, перки (доход/дозор-данные/ремонт/пушка форта), разрушение мортирой,
// мирное время; дрейф рыбы: медленный, с якорем к дому, без съезжания в одну точку.
import {
  createGame, addPlayer, startGame, applyAction, publicState,
  driftFishZones, applyOutpostPerks, fishEarners
} from '../server/game.js';
import {
  OUTPOST_LEVELS, OUTPOST_RADIUS, OUTPOST_BUILD_REACH, RT_OUTPOST_MS,
  FISH_DRIFT_PER_TURN, FISH_HOME_RADIUS, PORT_INCOME, SHIP_TYPES
} from '../server/config.js';
import { tickOutposts, botThink } from '../server/rt.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

function newGame({ mode = 'classic', realtime = false, multiMove = true } = {}) {
  const g = createGame('isl', { maxPlayers: 2, turnTimer: 0, seed: 7 });
  g.config.mode = mode;
  if (realtime) g.config.realtime = true;
  g.config.multiMove = multiMove;
  addPlayer(g, 'p0', 'P0');
  addPlayer(g, 'p1', 'P1');
  startGame(g, 'p0');
  g.wind = { ang: 0, str: 0, targetAng: 0, targetStr: 0 }; // штиль — тестам движение не важно
  if (realtime) g.rt = { nextOutpost: 0 };
  return g;
}
const put = (g, owner, type, x, y, hp) =>
  (g.ships.push({ id: `${owner}_${type}_${Math.random().toString(36).slice(2, 6)}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp }), g.ships.at(-1));
const L1 = OUTPOST_LEVELS[0], L2 = OUTPOST_LEVELS[1], L3 = OUTPOST_LEVELS[2];
// детерминизм: пиратов — в дальний угол и «вечными» (удалять нельзя — movePirates гарантированно
// доспавнит новых в СЛУЧАЙНОМ месте; случайный пират рядом с сценой портил проверки форта)
const banishPirates = g => {
  for (const p of g.ships.filter(s => s.owner === -1)) { p.x = 30; p.y = 30; p.bornTurn = 1e9; delete p.dest; }
};

// ═══════════════ Постройка и прокачка ═══════════════
{
  const g = newGame();
  const isl = g.map.lootIslands[0], ii = 0;
  const sh = put(g, 0, 'shkhuna', isl.x + isl.radius + 30, isl.y);
  const far = put(g, 0, 'brig', isl.x + isl.radius + 300, isl.y);
  const r0 = applyAction(g, 'p0', { type: 'outpost', shipId: sh.id, islandId: ii });
  check('на НЕзалутанном острове строить нельзя', !r0.ok && r0.error === 'err.lootFirst', r0.error || '');
  isl.looted = true;
  const r1 = applyAction(g, 'p0', { type: 'outpost', shipId: far.id, islandId: ii });
  check('издалека строить нельзя', !r1.ok && r1.error === 'err.comeCloserToIsland', r1.error || '');
  g.players[0].gold = 100;
  const r2 = applyAction(g, 'p0', { type: 'outpost', shipId: sh.id, islandId: ii });
  check('без золота строить нельзя', !r2.ok && r2.error === 'err.noGoldFor', r2.error || '');
  g.players[0].gold = 1000;
  const rNoShip = applyAction(g, 'p0', { type: 'outpost', islandId: ii }); // первая постройка БЕЗ корабля
  check('первая постройка без корабля — нельзя', !rNoShip.ok && rNoShip.error === 'err.notYourShip', rNoShip.error || '');
  const r3 = applyAction(g, 'p0', { type: 'outpost', shipId: sh.id, islandId: ii });
  check('⛺ ур.1 построен, золото списано', r3.ok && isl.outpost?.level === 1 && isl.outpost.owner === 0 && g.players[0].gold === 1000 - L1.price);
  check('постройка = действие корабля (пометлен сходившим)', (g.turn.actedShips || []).includes(sh.id));
  const r4 = applyAction(g, 'p0', { type: 'outpost', islandId: ii }); // апгрейд — кликом по аванпосту, БЕЗ корабля
  check('🏪 апгрейд БЕЗ корабля (клик по аванпосту), hp отстроен', r4.ok && isl.outpost.level === 2 && isl.outpost.hp === L2.hp);
  check('апгрейд не пометил никого «сходившим»', (g.turn.actedShips || []).filter(x => !x).length === 0);
  check('доход растёт с уровнем: 3 → 8 → 12', L1.income < L2.income && L2.income < L3.income && L3.income === 12);
  applyAction(g, 'p0', { type: 'skip' }); // ход p1
  const foe = put(g, 1, 'shkhuna', isl.x + isl.radius + 30, isl.y - 10);
  const r5 = applyAction(g, 'p1', { type: 'outpost', shipId: foe.id, islandId: ii });
  check('на чужом аванпосте строить нельзя', !r5.ok && r5.error === 'err.enemyOutpost', r5.error || '');
}

// ═══════════════ Перки в начале хода владельца ═══════════════
{
  const g = newGame();
  banishPirates(g); // форт бьёт БЛИЖАЙШЕГО — случайный пират рядом сбивал детерминизм
  const isl = g.map.lootIslands[0];
  isl.looted = true;
  isl.outpost = { owner: 1, level: 3, hp: L3.hp }; // форт p1
  const hurt = put(g, 1, 'brig', isl.x + 100, isl.y, 60);        // свой побитый — в радиусе
  const foe = put(g, 0, 'shkhuna', isl.x + 120, isl.y + 30);     // враг — в радиусе
  const farFoe = put(g, 0, 'brig', isl.x + OUTPOST_RADIUS + 200, isl.y); // враг вне радиуса
  const g1 = g.players[1].gold;
  applyAction(g, 'p0', { type: 'skip' }); // → начало хода p1 → перки его аванпостов
  check('доход аванпоста капнул владельцу', g.players[1].gold === g1 + PORT_INCOME + L3.income, `(+${g.players[1].gold - g1})`);
  const healed = Math.round(SHIP_TYPES.brig.hp * L3.heal);
  check('фактория/форт чинит свой корабль в радиусе', hurt.hp === 60 + healed, `(hp ${hurt.hp})`);
  check('форт выстрелил по врагу в радиусе', foe.hp === SHIP_TYPES.shkhuna.hp - L3.gun, `(hp ${foe.hp})`);
  check('вне радиуса форт не достаёт', farFoe.hp === SHIP_TYPES.brig.hp);
}

// ═══════════════ Мирное время («Развитие»): форт молчит, чужое не разрушить ═══════════════
{
  const g = newGame({ mode: 'develop' });
  banishPirates(g); // пиратский залп по «жертве» портил проверку «форт молчит»
  const isl = g.map.lootIslands[0];
  isl.looted = true;
  isl.outpost = { owner: 1, level: 3, hp: L3.hp };
  const foe = put(g, 0, 'shkhuna', isl.x + 100, isl.y);
  const fr = put(g, 0, 'fregat', isl.x + 120, isl.y);
  const r = applyAction(g, 'p0', { type: 'attack', shipId: fr.id, targetType: 'outpost', targetId: 0 }); // пока ход p0
  check('мир: чужой аванпост мортирой не тронуть', !r.ok && /^err\.peace/.test(r.error), r.error || '');
  applyAction(g, 'p0', { type: 'skip' }); // → ход p1: перки его форта
  check('мир: форт НЕ стреляет', foe.hp === SHIP_TYPES.shkhuna.hp);
}

// ═══════════════ Разрушение мортирой ═══════════════
{
  const g = newGame();
  const isl = g.map.lootIslands[0];
  isl.looted = true;
  isl.outpost = { owner: 1, level: 1, hp: L1.hp };
  const fr = put(g, 0, 'fregat', isl.x + isl.radius + 60, isl.y);
  const far = put(g, 0, 'fregat', isl.x + 600, isl.y);
  const rFar = applyAction(g, 'p0', { type: 'attack', shipId: far.id, targetType: 'outpost', targetId: 0 });
  check('мортира: вне дальности — отказ', !rFar.ok && rFar.error === 'err.outpostOutOfRange', rFar.error || '');
  const r1 = applyAction(g, 'p0', { type: 'attack', shipId: fr.id, targetType: 'outpost', targetId: 0 });
  check('мортира бьёт аванпост полным уроном', r1.ok && isl.outpost.hp === L1.hp - SHIP_TYPES.fregat.dmg, `(hp ${isl.outpost?.hp})`);
  applyAction(g, 'p0', { type: 'skip' });
  applyAction(g, 'p1', { type: 'skip' });
  isl.outpost.hp = 10; // добьём следующим выстрелом
  const r2 = applyAction(g, 'p0', { type: 'attack', shipId: fr.id, targetType: 'outpost', targetId: 0 });
  check('добит → остров снова ничей', r2.ok && isl.outpost === null);
  check('взрыв на месте постройки (событие)', (g.events || []).some(e => e.type === 'explosion'));
  // и можно строить заново
  g.players[0].gold = 500;
  applyAction(g, 'p0', { type: 'skip' });
  applyAction(g, 'p1', { type: 'skip' });
  const sh = put(g, 0, 'shkhuna', isl.x + isl.radius + 20, isl.y);
  check('на месте руин строится новый', applyAction(g, 'p0', { type: 'outpost', shipId: sh.id, islandId: 0 }).ok && isl.outpost.owner === 0);
}

// ═══════════════ publicState + реалтайм-тик перков + бот строит ═══════════════
{
  const g = newGame({ realtime: true });
  const st = publicState(g, 'p0');
  check('publicState: конфиг аванпостов уехал клиенту', st.outposts?.levels?.length === 3 && st.outposts.radius === OUTPOST_RADIUS);
  const isl = g.map.lootIslands[0];
  isl.looted = true;
  isl.outpost = { owner: 0, level: 1, hp: L1.hp };
  const g0 = g.players[0].gold;
  tickOutposts(g, Date.now());
  check('реалтайм: доход по таймеру', g.players[0].gold === g0 + L1.income);
  tickOutposts(g, Date.now());
  check('реалтайм: до срока повторно не капает', g.players[0].gold === g0 + L1.income);
  check('таймер перевзведён на RT_OUTPOST_MS', g.rt.nextOutpost > Date.now() && g.rt.nextOutpost <= Date.now() + RT_OUTPOST_MS + 50);
  // бот: стоит у залутанного острова с запасом золота → строит
  const isl2 = g.map.lootIslands[1];
  isl2.looted = true;
  g.players[1].isBot = true; g.players[1].botLevel = 'mid';
  g.players[1].gold = L1.price + 300;
  put(g, 1, 'brig', isl2.x + isl2.radius + 20, isl2.y);
  botThink(g, 1, Date.now());
  check('реалтайм-бот строит аванпост', isl2.outpost?.owner === 1 && isl2.outpost.level === 1);
}

// ═══════════════ 🐟 Миграция рыбы ═══════════════
{
  const g = newGame();
  const z = g.map.fishZones[0];
  const x0 = z.x, y0 = z.y;
  driftFishZones(g, FISH_DRIFT_PER_TURN);
  const moved = Math.hypot(z.x - x0, z.y - y0);
  check('дрейф: за шаг ровно FISH_DRIFT_PER_TURN px (очень медленно)', Math.abs(moved - FISH_DRIFT_PER_TURN) < 0.01, `(${moved.toFixed(2)}px)`);
  check('якорь запомнен (родное место)', z.homeX === x0 && z.homeY === y0);
  // долгий дрейф: не уходит от дома дальше якоря и зоны не съезжаются в точку
  for (let i = 0; i < 1500; i++) driftFishZones(g, 5);
  const zs = g.map.fishZones;
  check('якорь держит: зона в пределах дома', zs.every(zz => Math.hypot(zz.x - zz.homeX, zz.y - zz.homeY) <= FISH_HOME_RADIUS + 10),
    `(макс ${Math.max(...zs.map(zz => Math.hypot(zz.x - zz.homeX, zz.y - zz.homeY))).toFixed(0)}px)`);
  let minPair = Infinity;
  for (let i = 0; i < zs.length; i++) for (let j = i + 1; j < zs.length; j++)
    minPair = Math.min(minPair, Math.hypot(zs[i].x - zs[j].x, zs[i].y - zs[j].y));
  check('зоны НЕ съехались в одну точку', minPair > 100, `(мин. дистанция ${minPair.toFixed(0)}px)`);
  // интеграция: смена хода двигает рыбу
  const g2 = newGame();
  const snap = g2.map.fishZones.map(zz => zz.x + ':' + zz.y);
  applyAction(g2, 'p0', { type: 'skip' });
  check('advanceTurn дрейфует рыбу', g2.map.fishZones.some((zz, i) => zz.x + ':' + zz.y !== snap[i]));
}

// ═══════════════ 🐟 «Кто первый встал — того и рыба» (очередь прихода, не id) ═══════════════
{
  const g = newGame();
  banishPirates(g);
  const z = g.map.fishZones[0];
  const cap = z.cap || 4;
  const first = put(g, 0, 'barkas', z.x, z.y);
  first.id = 'яяя_последний_по_алфавиту'; // при старой сортировке по id он бы вылетел первым
  fishEarners(g, z); // пришёл — застолбил место в очереди
  const late = [];
  for (let i = 0; i < cap; i++) { const b = put(g, 1, 'barkas', z.x + 10 + i * 8, z.y); b.id = 'aaa_ранний_ид_' + i; late.push(b); }
  let earn = fishEarners(g, z);
  check('первый пришедший кормится, хоть его id «старше» всех', earn.some(s => s.id === first.id));
  check(`опоздавший — за бортом (мест ${cap})`, !earn.some(s => s.id === late[cap - 1].id), earn.map(s => s.id).join(','));
  // ушёл — место потерял; вернулся — в КОНЕЦ очереди
  first.x += 1000;
  fishEarners(g, z);
  first.x -= 1000;
  earn = fishEarners(g, z);
  check('ушёл и вернулся → в конец очереди (зона полна — не кормится)', !earn.some(s => s.id === first.id));
  check('его место унаследовал следующий в очереди', earn.some(s => s.id === late[cap - 1].id));
}

// ═══════════════ 🎣 Стейт помечает кормящихся (netting) — сеть рисуем только им ═══════════════
{
  const g = newGame();
  banishPirates(g);
  const z = g.map.fishZones[0];
  const cap = z.cap || 4;
  const boats = [];
  for (let i = 0; i <= cap; i++) boats.push(put(g, 0, 'barkas', z.x + i * 8, z.y)); // cap+1 рыбаков
  const st = publicState(g, 'p0');
  const flags = boats.map(b => !!st.ships.find(s => s.id === b.id)?.netting);
  check(`netting у первых ${cap} (в лимите зоны)`, flags.slice(0, cap).every(Boolean), flags.join(','));
  check('лишнему (сверх лимита) сеть не положена', !flags[cap]);
  const brig = put(g, 0, 'brig', z.x, z.y + 12);
  check('боевой корабль в зоне — без netting', !publicState(g, 'p0').ships.find(s => s.id === brig.id)?.netting);
  check('сама игра флагом не замусорена (только копия в стейте)', !g.ships.some(s => s.netting));
}

console.log(`\n⛺🐟 Аванпосты + миграция: ${ok} ок, ${fail} провалов`);
process.exit(fail ? 1 : 0);
