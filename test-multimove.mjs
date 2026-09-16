// Режим «ход тремя судами»: за ход можно подвигать до MOVES_PER_TURN РАЗНЫХ кораблей.
// Тесты фиксируют: классика не сломана (одно действие = конец хода), бюджет ходов,
// запрет ходить одним кораблём дважды, досрочное завершение, «бесплатные» покупка/сбор,
// сброс счётчиков на новом ходу, выдачу movesPerTurn клиенту и учёт сходивших ботом.
import { createGame, addPlayer, startGame, applyAction, publicState } from './server/game.js';
import { chooseBotAction } from './server/bot.js';
import { SHIP_TYPES, movesBudget, MOVES_PER_TURN, SHIP_ACTIONS, CONVOY_MAX, convoyCost, shipRank } from './server/config.js';

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
eq('SHIP_ACTIONS', [...SHIP_ACTIONS].sort(), ['attack', 'broadside', 'move', 'outpost', 'recharge', 'repair']);

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
  put(g, 0, 'shkhuna', 600, 600);   // второй корабль (вне досягаемости клада): чтобы ход не закрылся авто-логикой
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
  put(g, 0, 'shkhuna', 600, 600);                           // второй корабль: чтобы ход не закрылся авто-логикой после первого хода
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

// === Многоход: АВТО-завершение хода, когда больше нечем ходить (под конец партии судов мало) ===
{ // один корабль, нет золота → после его единственного действия ход закрывается сам, без «Завершить»
  const g = setup(true);
  const s1 = put(g, 0, 'shkhuna', 700, 600);
  put(g, 1, 'shkhuna', 1200, 600);
  const r = applyAction(g, 'A', { type: 'move', shipId: s1.id, x: 715, y: 600 });
  check('авто-конец: ход одним кораблём прошёл', r.ok, JSON.stringify(r));
  eq('авто-конец: 1 корабль без золота → ход сам перешёл к Бобу', g.turn.idx, 1);
  eq('авто-конец: счётчики сброшены', [g.turn.moves, g.turn.actedShips], [0, []]);
}
{ // два корабля, нет золота → ход закрывается после второго (а не висит до полного бюджета 3)
  const g = setup(true);
  const s1 = put(g, 0, 'shkhuna', 700, 600);
  const s2 = put(g, 0, 'shkhuna', 800, 600);
  put(g, 1, 'shkhuna', 1200, 600);
  applyAction(g, 'A', { type: 'move', shipId: s1.id, x: 715, y: 600 });
  eq('авто-конец: после 1-го из 2 кораблей ход ещё открыт', g.turn.idx, 0);
  applyAction(g, 'A', { type: 'move', shipId: s2.id, x: 815, y: 600 });
  eq('авто-конец: после 2-го (последнего) корабля ход сам закрылся', g.turn.idx, 1);
}
{ // один корабль, НО хватает золота на корабль → ход НЕ закрывается (можно докупиться в верфи)
  const g = setup(true);
  const s1 = put(g, 0, 'shkhuna', 700, 600);
  put(g, 1, 'shkhuna', 1200, 600);
  g.players[0].gold = SHIP_TYPES.barkas.price;   // ровно на самый дешёвый корабль
  applyAction(g, 'A', { type: 'move', shipId: s1.id, x: 715, y: 600 });
  eq('авто-конец: 1 корабль, но есть на верфь → ход остаётся открытым', g.turn.idx, 0);
}
{ // три корабля — авто-логика не закрывает ход раньше времени (как и было: до бюджета 3)
  const g = setup(true);
  const s1 = put(g, 0, 'shkhuna', 700, 600);
  const s2 = put(g, 0, 'shkhuna', 800, 600);
  put(g, 0, 'shkhuna', 900, 600);
  put(g, 1, 'shkhuna', 1200, 600);
  applyAction(g, 'A', { type: 'move', shipId: s1.id, x: 715, y: 600 });
  applyAction(g, 'A', { type: 'move', shipId: s2.id, x: 815, y: 600 });
  eq('авто-конец: при 3 кораблях после 2 ходов ход ещё открыт', g.turn.idx, 0);
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

// ═══════════ ⛵ КОНВОЙ: ход строем ═══════════
// Спокойная вода (штиль) — чтобы дальности в тестах не гуляли от ветра.
const calm = g => (g.wind = { ang: 0, str: 0 }, g);
const convoy = (g, lead, mates, x, y) =>
  applyAction(g, 'A', { type: 'convoy', shipId: lead.id, ships: mates.map(s => s.id), x, y });

// === строй идёт весь, сохраняет расстановку и съедает манёвр за каждое судно ===
{
  const g = calm(setup(true));
  const a = put(g, 0, 'shkhuna', 700, 600);
  const b = put(g, 0, 'shkhuna', 740, 600);
  const c = put(g, 0, 'shkhuna', 700, 640);
  put(g, 0, 'brig', 500, 500);                       // запасной — иначе ход закроется «нечем ходить»
  const r = convoy(g, a, [b, c], 800, 600);
  check('конвой: ход принят', r.ok, r.error);
  eq('конвой: флагман сдвинулся', [a.x, a.y], [800, 600]);
  eq('конвой: второй повторил смещение', [b.x, b.y], [840, 600]);
  eq('конвой: третий повторил смещение', [c.x, c.y], [800, 640]);
  eq('конвой: весь строй — один манёвр', g.turn.moves, convoyCost(3));
  eq('конвой: ход НЕ закрылся — осталось чем действовать', g.turn.idx, 0);
  check('конвой: все трое помечены сходившими',
    [a, b, c].every(s => g.turn.actedShips.includes(s.id)), JSON.stringify(g.turn.actedShips));
}

// === цена строя — одна на всех: перебросил эскадру и ещё стреляешь ===
{
  const g = calm(setup(true));
  const a = put(g, 0, 'shkhuna', 700, 600);
  const b = put(g, 0, 'shkhuna', 740, 600);
  const c = put(g, 0, 'shkhuna', 700, 640);
  const gun = put(g, 0, 'fregat', 900, 900);
  const foe = put(g, 1, 'shkhuna', 1000, 900);       // цель для оставшегося манёвра
  check('конвой: строй прошёл', convoy(g, a, [b, c], 800, 600).ok);
  const shot = applyAction(g, 'A', { type: 'attack', shipId: gun.id, targetType: 'ship', targetId: foe.id });
  check('конвой: после строя ещё можно стрелять', shot.ok, shot.error);
  check('конвой: выстрел дошёл', foe.hp < SHIP_TYPES.shkhuna.hp, String(foe.hp));
}

// === строй из двух оставляет манёвры (в запасе есть чем ходить) ===
{
  const g = calm(setup(true));
  const a = put(g, 0, 'shkhuna', 700, 600);
  const b = put(g, 0, 'shkhuna', 740, 600);
  put(g, 0, 'brig', 500, 500);                       // запасной — иначе ход закроется «нечем ходить»
  const r = convoy(g, a, [b], 800, 600);
  check('конвой(2): принят', r.ok, r.error);
  eq('конвой(2): цена по формуле', g.turn.moves, convoyCost(2));
  eq('конвой(2): ход НЕ закрылся', g.turn.idx, 0);
  check('конвой(2): оба помечены сходившими',
    [a, b].every(s => g.turn.actedShips.includes(s.id)), JSON.stringify(g.turn.actedShips));
}

// === строй идёт по САМОМУ МЕДЛЕННОМУ ===
{
  // флагманом идёт линкор (он же старший, он же самый медленный — ход 90 против 135 у брига)
  const g = calm(setup(true));
  const link = put(g, 0, 'linkor', 740, 660);
  const brig = put(g, 0, 'brig', 700, 600);
  const far = convoy(g, link, [brig], 740 + 120, 660);
  check('конвой: дальше медленного — отказ', !far.ok, far.error);
  eq('конвой: отказ ничего не сдвинул', [link.x, link.y, brig.x, brig.y], [740, 660, 700, 600]);
  const near = convoy(g, link, [brig], 740 + 85, 660);
  check('конвой: в пределах медленного — идёт', near.ok, near.error);
  eq('конвой: бриг повторил смещение линкора', [brig.x, brig.y], [785, 600]);
}

// === враг в зоне обстрела — строй не собрать (эскадрой от боя не удрать) ===
{
  const g = calm(setup(true));
  const a = put(g, 0, 'shkhuna', 700, 600);          // fireRange 110
  const b = put(g, 0, 'shkhuna', 740, 600);
  put(g, 1, 'brig', 800, 600);                       // fireRange 140 — контакт
  const r = convoy(g, a, [b], 600, 600);
  check('конвой: в боевом контакте — отказ', !r.ok, r.error);
  check('конвой: причина названа', /враг/i.test(r.error || ''), r.error);
}
{
  const g = calm(setup(true));
  const a = put(g, 0, 'shkhuna', 700, 600);
  const b = put(g, 0, 'shkhuna', 740, 600);
  put(g, -1, 'pirate', 820, 600, 80);                // пират тоже враг (fireRange 130)
  const r = convoy(g, a, [b], 600, 600);
  check('конвой: пират рядом — отказ', !r.ok, r.error);
}

// === старшинство: флагман не может быть младше ведомых ===
// Без этого рыбацкий баркас (ход 180 — самый широкий радиус набора) уводил бы за собой фрегаты.
{
  const g = calm(setup(true));
  const bark = put(g, 0, 'barkas', 700, 600);
  const freg = put(g, 0, 'fregat', 760, 600);
  put(g, 0, 'shkhuna', 500, 500);                    // запасной, чтобы ход не закрылся «нечем ходить»
  const r = convoy(g, bark, [freg], 760, 640);
  check('строй: баркас не поведёт фрегат', !r.ok, r.error);
  check('строй: в отказе названы оба судна',
    /баркас/i.test(r.error || '') && /фрегат/i.test(r.error || ''), r.error);
  eq('строй: отказ никого не сдвинул', [bark.x, bark.y, freg.x, freg.y], [700, 600, 760, 600]);
  // а старший ведёт младшего как ни в чём не бывало
  const ok2 = convoy(g, freg, [bark], 820, 600);
  check('строй: фрегат ведёт баркас', ok2.ok, ok2.error);
  eq('строй: баркас повторил смещение флагмана', [bark.x, bark.y], [760, 600]);
}
// равный ранг — свои ведут своих
{
  const g = calm(setup(true));
  const a = put(g, 0, 'brig', 700, 600);
  const b = put(g, 0, 'brig', 740, 600);
  put(g, 0, 'shkhuna', 500, 500);
  check('строй: равные по рангу идут вместе', convoy(g, a, [b], 760, 600).ok);
}
// сама мера старшинства
eq('ранг: баркас младше шхуны', shipRank('barkas') < shipRank('shkhuna'), true);
eq('ранг: шхуна младше брига', shipRank('shkhuna') < shipRank('brig'), true);
eq('ранг: бриг младше фрегата', shipRank('brig') < shipRank('fregat'), true);
eq('ранг: фрегат младше линкора', shipRank('fregat') < shipRank('linkor'), true);
eq('ранг: неизвестный тип не старше никого', shipRank('неттакого'), 0);

// === набор только из соседей флагмана ===
{
  const g = calm(setup(true));
  const a = put(g, 0, 'shkhuna', 700, 600);          // move 170 — радиус набора
  const far = put(g, 0, 'shkhuna', 700, 800);        // 200 > 170
  const r = convoy(g, a, [far], 740, 600);
  check('конвой: далёкое судно в строй не берут', !r.ok, r.error);
}

// === чужие, сходившие, мало манёвров, классика, одиночка ===
{
  const g = calm(setup(true));
  const a = put(g, 0, 'shkhuna', 700, 600);
  const b = put(g, 0, 'shkhuna', 740, 600);
  const c = put(g, 0, 'shkhuna', 700, 640);
  const foe = put(g, 1, 'shkhuna', 760, 640);
  check('конвой: чужой корабль в строю — отказ', !convoy(g, a, [foe], 760, 600).ok);
  check('конвой: одно судно — отказ', !convoy(g, a, [], 760, 600).ok);
  g.turn.moves = 1; g.turn.actedShips = [b.id];
  check('конвой: сходившее судно в строю — отказ', !convoy(g, a, [b], 760, 600).ok);
  // бюджет выбран под ноль — строй не влезает (цена берётся из convoyCost, а не зашита в тест)
  g.turn.moves = movesBudget(g.config) - convoyCost(CONVOY_MAX) + 1; g.turn.actedShips = [];
  const r = convoy(g, a, [b, c], 760, 600);
  check('конвой: не влезает в остаток хода — отказ', !r.ok, r.error);
  check('конвой: в отказе видно, сколько осталось', /осталось/.test(r.error || ''), r.error);
}
{
  const g = calm(setup(false));                      // классика: один манёвр за ход
  const a = put(g, 0, 'shkhuna', 700, 600);
  const b = put(g, 0, 'shkhuna', 740, 600);
  check('конвой: в классике запрещён', !convoy(g, a, [b], 800, 600).ok);
}

// === сосед по строю не блокирует сам себя, а остров — блокирует ===
{
  const g = calm(setup(true));
  const a = put(g, 0, 'shkhuna', 700, 600);
  const b = put(g, 0, 'shkhuna', 730, 600);          // 30 px — почти вплотную (лимит 26)
  const r = convoy(g, a, [b], 730, 600);             // флагман встаёт РОВНО на место соседа
  check('конвой: сосед по строю не мешает (строй жёсткий)', r.ok, r.error);
  eq('конвой: строй сохранил дистанцию', [b.x, b.y], [760, 600]);
}
{
  const g = calm(setup(true));
  g.map.lootIslands = [{ x: 800, y: 660, radius: 40, loot: 100, shape: [[0, 0]], looted: false }];
  const a = put(g, 0, 'shkhuna', 700, 600);
  const b = put(g, 0, 'shkhuna', 700, 660);          // ему на острова
  const r = convoy(g, a, [b], 800, 600);
  check('конвой: судно упирается в остров — отказ всему строю', !r.ok, r.error);
  eq('конвой: неудачный строй никого не сдвинул', [a.x, a.y, b.x, b.y], [700, 600, 700, 660]);
}

console.log(`\nИтого ход-тремя-судами: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
