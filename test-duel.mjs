// Тесты режима «Дуэль»: маленькая карта без баз/островов, стартовая закупка флота на всё золото,
// победа по уничтожению флота, нет дохода за ход, гейт фаз buy→battle.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { duelFleetPlan } from './server/bot.js';
import { SHIP_TYPES, cheapestShipPrice, isDuel } from './server/config.js';

let ok = 0, fail = 0;
const eq = (n, g, w) => { JSON.stringify(g) === JSON.stringify(w) ? ok++ : (fail++, console.error(`✗ ${n}: got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`)); };
const yes = (n, c) => { c ? ok++ : (fail++, console.error(`✗ ${n}: ожидалось true`)); };
const no = (n, c) => { !c ? ok++ : (fail++, console.error(`✗ ${n}: ожидалось false`)); };

function newDuel(level) {
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0, multiMove: true });
  g.config.mode = 'duel';
  addPlayer(g, 'p0', 'A'); addPlayer(g, 'p1', 'B');
  if (level) { g.players[1].isBot = true; g.players[1].botLevel = level; }
  startGame(g, 'p0');
  return g;
}

// === цена самого дешёвого корабля: дуэль исключает баркас ===
eq('cheapest классика = 60 (баркас)', cheapestShipPrice(false), 60);
eq('cheapest дуэль = 110 (шхуна)', cheapestShipPrice(true), 110);

// === старт дуэли ===
const g = newDuel();
yes('isDuel', isDuel(g));
eq('фаза buy', g.phase, 'buy');
eq('кораблей у игроков 0', g.ships.filter(s => s.owner >= 0).length, 0);
eq('золото 4000', g.players[0].gold, 4000);
yes('карта меньше обычной', g.map.w < 1600 && g.map.h < 1200);
yes('нет островов и рыбозон', g.map.lootIslands.length === 0 && g.map.fishZones.length === 0);
yes('базы — невидимые якоря noPort', g.map.bases.every(b => b.noPort));
yes('игроки не готовы', g.players.every(p => !p.ready));

// === правило «скупись на всё» ===
no('недозакуп (остался ≥110) отклонён', applyAction(g, 'p0', { type: 'buyFleet', ships: ['linkor'] }).ok);
no('баркас в дуэли запрещён', applyAction(g, 'p0', { type: 'buyFleet', ships: Array(66).fill('barkas') }).ok);
no('авианосец (чит) запрещён', applyAction(g, 'p0', { type: 'buyFleet', ships: ['carrier'] }).ok);
no('перерасход отклонён', applyAction(g, 'p0', { type: 'buyFleet', ships: Array(9).fill('linkor') }).ok); // 4500 > 4000
yes('p0 всё ещё не готов', !g.players[0].ready);

// === полная закупка p0 (8 линкоров = 4000) ===
const buy0 = applyAction(g, 'p0', { type: 'buyFleet', ships: Array(8).fill('linkor') });
yes('полная закупка ок', buy0.ok);
yes('p0 готов', g.players[0].ready);
eq('p0 золото 0', g.players[0].gold, 0);
eq('p0: 8 кораблей', g.ships.filter(s => s.owner === 0).length, 8);
yes('флот p0 слева', g.ships.filter(s => s.owner === 0).every(s => s.x < g.map.w / 2));
const xs = g.ships.filter(s => s.owner === 0).map(s => `${s.x},${s.y}`);
eq('флот стоит в ряд (все позиции разные)', new Set(xs).size, 8);
no('повторная закупка отклонена', applyAction(g, 'p0', { type: 'buyFleet', ships: Array(8).fill('linkor') }).ok);

// === «в бой» при ОСТАТКЕ < самого дешёвого корабля (НЕ обязательно в ноль) ===
{
  const gp = newDuel();  // 4000 золота, мин. корабль в дуэли = шхуна 110
  no('остаток 150 (≥110) — отклонён', applyAction(gp, 'p0', { type: 'buyFleet', ships: Array(35).fill('shkhuna') }).ok); // 3850, остаток 150
  yes('остаток 40 (<110) — пускает в бой', applyAction(gp, 'p0', { type: 'buyFleet', ships: Array(36).fill('shkhuna') }).ok); // 3960, остаток 40
  yes('p0 готов после частичной закупки', gp.players[0].ready);
  eq('p0: остаток золота 40', gp.players[0].gold, 40);
}

// === гейт фаз: в закупке нельзя ходить/пропускать ===
no('skip в фазе buy отклонён', applyAction(g, 'p0', { type: 'skip' }).ok);
eq('всё ещё buy (p1 не готов)', g.phase, 'buy');

// === p1 закупается → бой ===
applyAction(g, 'p1', { type: 'buyFleet', ships: Array(8).fill('linkor') });
eq('оба готовы → battle', g.phase, 'battle');
yes('флот p1 справа', g.ships.filter(s => s.owner === 1).every(s => s.x > g.map.w / 2));
eq('бой: ход игрока 0', g.turn.idx, 0);

// === нет дохода за ход ===
const goldB = g.players[1].gold;
applyAction(g, 'p0', { type: 'skip' });
eq('нет дохода за ход', g.players[1].gold, goldB);

// === нельзя бить по «порту» (баз нет) ===
{
  const ship = g.ships.find(s => s.owner === 1);
  g.turn.idx = 1; g.turn.moves = 0; g.turn.actedShips = [];
  no('атака по порту отклонена', applyAction(g, 'p1', { type: 'attack', shipId: ship.id, targetType: 'port', targetId: 0 }).ok);
}

// === победа по уничтожению флота ===
{
  const g2 = newDuel();
  applyAction(g2, 'p0', { type: 'buyFleet', ships: Array(8).fill('linkor') });
  applyAction(g2, 'p1', { type: 'buyFleet', ships: Array(8).fill('linkor') });
  g2.turn.idx = 0; g2.turn.moves = 0; g2.turn.actedShips = []; g2.turn.broadsideSides = {};
  const shooter = g2.ships.find(s => s.owner === 0);
  g2.ships = g2.ships.filter(s => s.owner === 0);            // оставим у p1 один корабль
  g2.ships.push({ id: 'last', owner: 1, type: 'shkhuna', x: shooter.x + 60, y: shooter.y, hp: 1 });
  const kill = applyAction(g2, 'p0', { type: 'attack', shipId: shooter.id, targetType: 'ship', targetId: 'last' });
  yes('добивающий выстрел ок', kill.ok);
  no('p1 жив', g2.players[1].alive);
  eq('победитель — p0', g2.winner, 0);
  eq('игра завершена', g2.status, 'finished');
}

// === дуэль: за потопление ВРАЖЕСКОГО судна золота нет, за пирата — есть ===
{
  const g3 = newDuel();
  applyAction(g3, 'p0', { type: 'buyFleet', ships: Array(8).fill('linkor') });
  applyAction(g3, 'p1', { type: 'buyFleet', ships: Array(8).fill('linkor') });
  g3.turn.idx = 0; g3.turn.moves = 0; g3.turn.actedShips = []; g3.turn.broadsideSides = {};
  const shooter = g3.ships.find(s => s.owner === 0);
  g3.ships = g3.ships.filter(s => s.owner === 0);
  g3.ships.push({ id: 'v1', owner: 1, type: 'shkhuna', x: shooter.x + 60, y: shooter.y, hp: 1 });
  g3.ships.push({ id: 'v2', owner: 1, type: 'shkhuna', x: shooter.x + 700, y: shooter.y + 600, hp: 60 }); // второй — далеко, чтобы p1 не выбыл
  const goldBefore = g3.players[0].gold, sunkBefore = g3.players[0].stats.shipsSunk;
  applyAction(g3, 'p0', { type: 'attack', shipId: shooter.id, targetType: 'ship', targetId: 'v1' });
  eq('дуэль: нет золота за вражеский корабль', g3.players[0].gold, goldBefore);
  eq('дуэль: счётчик потопленных вырос', g3.players[0].stats.shipsSunk, sunkBefore + 1);
  yes('p1 ещё в игре (остался корабль)', g3.players[1].alive);
  // пират рядом — за него золото даётся
  g3.turn.idx = 0; g3.turn.moves = 0; g3.turn.actedShips = []; g3.turn.broadsideSides = {};
  g3.ships.push({ id: 'pir', owner: -1, type: 'pirate', x: shooter.x + 60, y: shooter.y, hp: 1, bounty: 150 });
  const goldB2 = g3.players[0].gold;
  applyAction(g3, 'p0', { type: 'attack', shipId: shooter.id, targetType: 'ship', targetId: 'pir' });
  eq('дуэль: за пирата золото даётся', g3.players[0].gold, goldB2 + 150);
}

// === бот: умная закупка (микс, полный расход, без баркаса/чита) ===
for (const lvl of ['easy', 'mid', 'hard']) {
  const gb = newDuel();
  const plan = duelFleetPlan(gb, 0, lvl);
  const cost = plan.reduce((s, t) => s + SHIP_TYPES[t].price, 0);
  const types = new Set(plan);
  yes(`бот ${lvl}: флот не одного типа`, types.size >= 2);
  yes(`бот ${lvl}: без баркаса/чита`, plan.every(t => !SHIP_TYPES[t].fishing && !SHIP_TYPES[t].cheat));
  yes(`бот ${lvl}: полный расход (<110)`, 4000 - cost < cheapestShipPrice(true));
  yes(`бот ${lvl}: проходит buyFleet`, applyAction(gb, 'p0', { type: 'buyFleet', ships: plan }).ok);
}

console.log(fail ? `\n❌ test-duel: провалено ${fail}, прошло ${ok}` : `\n✅ test-duel: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
