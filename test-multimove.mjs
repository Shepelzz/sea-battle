// Режим «ход тремя судами»: за ход можно подвигать до MOVES_PER_TURN РАЗНЫХ кораблей.
// Тесты фиксируют: классика не сломана (одно действие = конец хода), бюджет ходов,
// запрет ходить одним кораблём дважды, досрочное завершение, «бесплатные» покупка/сбор,
// сброс счётчиков на новом ходу, выдачу movesPerTurn клиенту и учёт сходивших ботом.
import { createGame, addPlayer, startGame, applyAction, publicState } from './server/game.js';
import { chooseBotAction } from './server/bot.js';
import { SHIP_TYPES, movesBudget, MOVES_PER_TURN, SHIP_ACTIONS } from './server/config.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++) : (fail++, console.error('✗', n, extra)); };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// Чистый стол: партия на 2 игроков, без лута-помех, без денег (если не нужно), корабли ставим руками.
function setup(multiMove = false) {
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0, seed: 4242 });
  addPlayer(g, 'A', 'Алиса');
  addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  g.config.multiMove = multiMove;
  g.ships = [];
  g.map.lootIslands = [];                 // лут не мешает ходить по центру карты
  g.players.forEach(p => (p.gold = 0));
  return g;
}
const put = (g, owner, type, x, y, hp) =>
  (g.ships.push({ id: `${owner}_${type}_${x}_${y}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp }), g.ships.at(-1));

// === movesBudget / константы ===
eq('MOVES_PER_TURN', MOVES_PER_TURN, 3);
eq('budget multiMove', movesBudget({ multiMove: true }), 3);
eq('budget classic', movesBudget({ multiMove: false }), 1);
eq('budget пустой конфиг', movesBudget({}), 1);
eq('budget null', movesBudget(null), 1);
eq('SHIP_ACTIONS', [...SHIP_ACTIONS].sort(), ['attack', 'broadside', 'move']);

// === Классика: ЛЮБОЕ действие завершает ход (поведение не меняется) ===
{
  const g = setup(false);
  const s1 = put(g, 0, 'shkhuna', 760, 600);
  put(g, 0, 'shkhuna', 900, 600);
  const r = applyAction(g, 'A', { type: 'move', shipId: s1.id, x: 780, y: 600 });
  check('классика: ход прошёл', r.ok, JSON.stringify(r));
  eq('классика: один ход = конец хода (idx→1)', g.turn.idx, 1);
}
{ // классика: покупка тоже завершает ход
  const g = setup(false);
  g.players[0].gold = 1000;
  const r = applyAction(g, 'A', { type: 'buy', ships: ['shkhuna'] });
  check('классика: покупка ок', r.ok, JSON.stringify(r));
  eq('классика: покупка = конец хода', g.turn.idx, 1);
}

// === Многоход: бюджет = 3 разными кораблями ===
{
  const g = setup(true);
  const s1 = put(g, 0, 'shkhuna', 700, 600);
  const s2 = put(g, 0, 'shkhuna', 800, 600);
  const s3 = put(g, 0, 'shkhuna', 900, 600);
  eq('многоход: movesPerTurn в state', publicState(g, 'A').movesPerTurn, 3);

  const r1 = applyAction(g, 'A', { type: 'move', shipId: s1.id, x: 715, y: 600 });
  check('многоход: ход 1 ок', r1.ok, JSON.stringify(r1));
  eq('после хода 1 — всё ещё ход Алисы', g.turn.idx, 0);
  eq('после хода 1 — moves=1', g.turn.moves, 1);
  check('после хода 1 — s1 помечен сходившим', g.turn.actedShips.includes(s1.id));

  applyAction(g, 'A', { type: 'move', shipId: s2.id, x: 815, y: 600 });
  eq('после хода 2 — moves=2, ход Алисы', [g.turn.idx, g.turn.moves], [0, 2]);

  applyAction(g, 'A', { type: 'move', shipId: s3.id, x: 915, y: 600 });
  eq('после хода 3 — бюджет исчерпан → ход Боба', g.turn.idx, 1);
  eq('новый ход — moves сброшен', g.turn.moves, 0);
  eq('новый ход — actedShips сброшен', g.turn.actedShips, []);
}

// === Многоход: одним кораблём дважды нельзя ===
{
  const g = setup(true);
  const s1 = put(g, 0, 'shkhuna', 700, 600);
  put(g, 0, 'shkhuna', 800, 600);
  applyAction(g, 'A', { type: 'move', shipId: s1.id, x: 715, y: 600 });
  const r = applyAction(g, 'A', { type: 'move', shipId: s1.id, x: 730, y: 600 });
  check('многоход: повтор тем же кораблём отклонён', !r.ok && /уже ходил/i.test(r.error || ''), JSON.stringify(r));
  eq('повтор не сменил ход и не сжёг слот', [g.turn.idx, g.turn.moves], [0, 1]);
}

// === Многоход: досрочное завершение (skip и endTurn) ===
for (const endType of ['skip', 'endTurn']) {
  const g = setup(true);
  const s1 = put(g, 0, 'shkhuna', 700, 600);
  put(g, 0, 'shkhuna', 800, 600);
  applyAction(g, 'A', { type: 'move', shipId: s1.id, x: 715, y: 600 });
  const r = applyAction(g, 'A', { type: endType });
  check(`многоход: ${endType} ок`, r.ok, JSON.stringify(r));
  eq(`многоход: ${endType} завершает ход досрочно`, g.turn.idx, 1);
  eq(`многоход: ${endType} сбросил moves`, g.turn.moves, 0);
}

// === Многоход: покупка и сбор ТРАТЯТ ход (один из трёх), но не завершают, пока есть бюджет ===
{
  const g = setup(true);
  g.players[0].gold = 1000;
  const s1 = put(g, 0, 'shkhuna', 700, 600);
  put(g, 0, 'shkhuna', 800, 600);
  const r = applyAction(g, 'A', { type: 'buy', ships: ['shkhuna'] });
  check('многоход: покупка ок', r.ok, JSON.stringify(r));
  eq('многоход: покупка тратит слот (moves=1)', g.turn.moves, 1);
  eq('многоход: покупка не завершает ход (бюджет не исчерпан)', g.turn.idx, 0);
  eq('многоход: корабль куплен', g.ships.filter(s => s.owner === 0).length, 3);
  // покупка НЕ помечает корабль сходившим — actedShips остаётся пустым
  eq('многоход: покупка не трогает actedShips', g.turn.actedShips, []);
  const rm = applyAction(g, 'A', { type: 'move', shipId: s1.id, x: s1.x + 15, y: s1.y });
  check('многоход: ход после покупки ок', rm.ok, JSON.stringify(rm));
  eq('многоход: после покупки+хода moves=2', g.turn.moves, 2);
  // третье действие (ещё покупка) исчерпывает бюджет → ход завершается
  applyAction(g, 'A', { type: 'buy', ships: ['shkhuna'] });
  eq('многоход: 3-е действие (покупка) завершает ход', g.turn.idx, 1);
}
{
  const g = setup(true);
  // подложим лут-остров и поставим к нему свой корабль
  g.map.lootIslands = [{ x: 800, y: 600, radius: 30, loot: 150, shape: [[0, 0]], looted: false }];
  put(g, 0, 'shkhuna', 800, 600);
  const r = applyAction(g, 'A', { type: 'collect' });
  check('многоход: сбор ок', r.ok, JSON.stringify(r));
  eq('многоход: сбор тратит слот (moves=1)', g.turn.moves, 1);
  eq('многоход: сбор не завершает ход (бюджет не исчерпан)', g.turn.idx, 0);
  eq('многоход: золото зачислено', g.players[0].gold, 150);
}

// === Многоход: НЕЛЬЗЯ походить кораблём, а потом им же собрать клад (дыра через collect) ===
{
  const g = setup(true);
  g.map.lootIslands = [{ x: 800, y: 600, radius: 30, loot: 150, shape: [[0, 0]], looted: false }];
  const s = put(g, 0, 'shkhuna', 800, 700);                 // не у острова
  applyAction(g, 'A', { type: 'move', shipId: s.id, x: 800, y: 660 }); // подошёл к острову (60 ед. ≤ reach 85)
  eq('подошедший корабль помечен сходившим', g.turn.actedShips.includes(s.id), true);
  const r = applyAction(g, 'A', { type: 'collect' });        // тем же кораблём собрать — нельзя
  check('сбор сходившим кораблём отклонён', !r.ok, JSON.stringify(r));
  eq('клад НЕ собран сходившим кораблём', g.map.lootIslands[0].looted, false);
  eq('сбор-отказ не сжёг слот (moves=1)', g.turn.moves, 1);
}
// === Многоход: сбор НЕходившим кораблём — ок, и этот корабль становится сходившим ===
{
  const g = setup(true);
  g.map.lootIslands = [{ x: 800, y: 600, radius: 30, loot: 150, shape: [[0, 0]], looted: false }];
  const s = put(g, 0, 'shkhuna', 730, 600);                 // уже у острова (70 ед. ≤ 85), не ходил
  const r = applyAction(g, 'A', { type: 'collect' });
  check('сбор неходившим — ок', r.ok, JSON.stringify(r));
  eq('клад собран', g.map.lootIslands[0].looted, true);
  eq('собравший корабль помечен сходившим', g.turn.actedShips.includes(s.id), true);
  const rm = applyAction(g, 'A', { type: 'move', shipId: s.id, x: 600, y: 600 });
  check('после сбора этим кораблём ходить нельзя', !rm.ok && /уже ходил/i.test(rm.error || ''), JSON.stringify(rm));
}

// === classic publicState отдаёт movesPerTurn=1 ===
{
  const g = setup(false);
  eq('классика: movesPerTurn=1 в state', publicState(g, 'A').movesPerTurn, 1);
}

// === Бот не берёт уже сходивший корабль ===
{
  const g = setup(true);
  const a1 = put(g, 0, 'brig', 700, 600);
  const a2 = put(g, 0, 'brig', 760, 600);
  put(g, 1, 'shkhuna', 700, 700); // враг в радиусе огня обоих бригов (fireRange 140)
  // помечаем a1 сходившим — бот должен работать оставшимися
  g.turn.moves = 1; g.turn.actedShips = [a1.id];
  const act = chooseBotAction(g, 0, 'hard');
  const usesActed = SHIP_ACTIONS.includes(act.type) && act.shipId === a1.id;
  check('бот: не использует сходивший корабль', !usesActed, JSON.stringify(act));
  check('бот: нашёл осмысленное действие оставшимся кораблём', act.type !== 'skip', JSON.stringify(act));
}

// === Бот не собирает клад кораблём, который уже ходил ===
{
  const g = setup(true);
  g.map.lootIslands = [{ x: 800, y: 600, radius: 30, loot: 200, shape: [[0, 0]], looted: false }];
  const s = put(g, 0, 'shkhuna', 760, 600); // стоит у жирного клада
  const a1 = chooseBotAction(g, 0, 'mid');
  check('бот собирает клад неходившим кораблём', a1.type === 'collect', JSON.stringify(a1));
  g.turn.moves = 1; g.turn.actedShips = [s.id]; // тот же корабль уже сходил
  const a2 = chooseBotAction(g, 0, 'mid');
  check('бот НЕ собирает клад сходившим кораблём', a2.type !== 'collect', JSON.stringify(a2));
}

console.log(`\nИтого ход-тремя-судами: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
