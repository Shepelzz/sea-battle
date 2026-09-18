// 📜 ЖУРНАЛ ПАРТИИ: приватность, сводка доходов и точность формулировок.
//
// Журнал — общий на партию, но не всё в нём общее: сводка заработка помечена адресатом и
// уходит только ему (соперник не должен читать чужую экономику). Раньше каждое начисление
// падало отдельной строкой И ВСЕМ — этот набор следит, чтобы так больше не было.
import {
  createGame, addPlayer, startGame, applyAction, publicState, earn, flushEarnings
} from './server/game.js';
import { SHIP_TYPES, OUTPOST_LEVELS, PORT_INCOME } from './server/config.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`);

function newGame({ fog = false, multiMove = true } = {}) {
  const g = createGame('log', { maxPlayers: 2, turnTimer: 0, seed: 3 });
  g.config.fog = fog;
  g.config.multiMove = multiMove;
  addPlayer(g, 'p0', 'P0');
  addPlayer(g, 'p1', 'P1');
  startGame(g, 'p0');
  g.wind = { ang: 0, str: 0, targetAng: 0, targetStr: 0 };
  banishPirates(g);
  return g;
}
const put = (g, owner, type, x, y) =>
  (g.ships.push({ id: `${owner}_${type}_${g.ships.length}`, owner, type, x, y, hp: SHIP_TYPES[type].hp }), g.ships.at(-1));
const rows = (g, pid) => publicState(g, pid).log;
// детерминизм: пиратов — в дальний угол и «вечными». Случайный пират рядом со сценой считается
// боевым контактом и не даёт собрать строй (см. shipInContact) — проверки плавали.
const banishPirates = g => {
  for (const p of g.ships.filter(s => s.owner === -1)) { p.x = 30; p.y = 30; p.bornTurn = 1e9; delete p.dest; }
};
const keys = (g, pid) => rows(g, pid).map(l => l.k);

// ═══════════════ Сводка доходов: одна строка и только своему ═══════════════
{
  const g = newGame();
  earn(g, g.players[0], 35, 'fishing');
  earn(g, g.players[0], 6, 'port');
  earn(g, g.players[0], 20, 'outpost');
  earn(g, g.players[0], 5, 'fishing');          // та же статья — складывается
  flushEarnings(g, 0);

  const mine = rows(g, 'p0').filter(l => l.k === 'log.income');
  check('доход сводится в ОДНУ запись', mine.length === 1, `записей: ${mine.length}`);
  eq('итог посчитан', mine[0]?.p.total, 66);
  eq('статьи сложены и перечислены', mine[0]?.p.parts,
    [{ k: 'income.fishing', v: 40 }, { k: 'income.port', v: 6 }, { k: 'income.outpost', v: 20 }]);
  eq('запись помечена адресатом', mine[0]?.to, 'p0');
  eq('тип записи — не debug, а gold', mine[0]?.type, 'gold');

  check('соперник сводку НЕ видит', !keys(g, 'p1').includes('log.income'));
  check('зритель без pid тоже не видит', !keys(g, undefined).includes('log.income'));

  flushEarnings(g, 0);
  eq('пустой сброс ничего не пишет', rows(g, 'p0').filter(l => l.k === 'log.income').length, 1);
}

// ═══════════════ Копится за ход, а не сыпется по начислению ═══════════════
{
  const g = newGame();
  const before = g.log.length;
  earn(g, g.players[0], 6, 'port');
  earn(g, g.players[0], 5, 'fishing');
  eq('до конца хода в журнале пусто', g.log.length, before);
  check('накопленное лежит на игроке', !!g.players[0].earned);
}

// ═══════════════ Надбавка порта видна в журнале отдельной статьёй ═══════════════
// Иначе непонятно, почему без флота капает больше: в сводке должно быть «порт +6, надбавка +9».
{
  const g = newGame();
  g.ships = g.ships.filter(s => s.owner !== 1);          // у второго не осталось ни судна
  applyAction(g, 'p0', { type: 'skip' });                // → ход p1: порт платит ему с надбавкой
  applyAction(g, 'p1', { type: 'skip' });                // ход p1 закончился → сводка ушла ему
  const line = rows(g, 'p1').find(l => l.k === 'log.income');
  check('сводка дохода пришла', !!line);
  const by = Object.fromEntries((line?.p.parts || []).map(x => [x.k, x.v]));
  eq('базовый доход порта показан отдельно', by['income.port'], PORT_INCOME);
  check('надбавка показана отдельной статьёй', by['income.support'] > 0, JSON.stringify(by));
  eq('сумма статей = итогу', (by['income.port'] || 0) + (by['income.support'] || 0), line?.p.total);

  // а у игрока с флотом надбавки нет вовсе — лишней статьи в журнале быть не должно
  const g2 = newGame();
  applyAction(g2, 'p0', { type: 'skip' });
  applyAction(g2, 'p1', { type: 'skip' });
  const line2 = rows(g2, 'p1').find(l => l.k === 'log.income');
  const by2 = Object.fromEntries((line2?.p.parts || []).map(x => [x.k, x.v]));
  eq('со стартовым флотом — только порт', Object.keys(by2), ['income.port']);
}

// ═══════════════ Ход: судно названо даже под туманом ═══════════════
for (const fog of [false, true]) {
  const g = newGame({ fog });
  const sh = g.ships.find(s => s.owner === 0 && s.type === 'shkhuna');
  const r = applyAction(g, 'p0', { type: 'move', shipId: sh.id, x: sh.x + 40, y: sh.y });
  check(`ход принят (туман: ${fog})`, r.ok, r.error || '');
  const last = g.log.filter(l => String(l.k).startsWith('log.move')).at(-1);
  check(`ход: класс судна назван (туман: ${fog})`, last?.p?.ship === 'ship.shkhuna.name', JSON.stringify(last?.p));
}

// ═══════════════ Строй: «боевых судов» только когда все боевые ═══════════════
{
  const convoy = (g, lead, mates, x, y) =>
    applyAction(g, 'p0', { type: 'convoy', shipId: lead.id, ships: mates.map(s => s.id), x, y });

  const g1 = newGame();
  const a = put(g1, 0, 'fregat', 600, 600), b = put(g1, 0, 'brig', 650, 600);
  put(g1, 0, 'shkhuna', 300, 300);                 // запасной, чтобы ход не закрылся
  check('строй из фрегата и брига прошёл', convoy(g1, a, [b], 640, 640).ok);
  eq('весь строй боевой → своя формулировка', g1.log.at(-1).k, 'log.convoyWar');
  eq('число судов в строю', g1.log.at(-1).p.count, 2);

  const g2 = newGame();
  const c = put(g2, 0, 'fregat', 600, 600), d = put(g2, 0, 'barkas', 650, 600);
  put(g2, 0, 'shkhuna', 300, 300);
  check('строй с баркасом прошёл', convoy(g2, c, [d], 640, 640).ok);
  eq('есть невоенное судно → обычная формулировка', g2.log.at(-1).k, 'log.convoy');

  const g3 = newGame();
  const e = put(g3, 0, 'fregat', 600, 600), f = put(g3, 0, 'repair', 650, 600);
  put(g3, 0, 'shkhuna', 300, 300);
  check('строй с ремонтником прошёл', convoy(g3, e, [f], 640, 640).ok);
  eq('ремонтник не боевой → обычная формулировка', g3.log.at(-1).k, 'log.convoy');
}

// ═══════════════ Аванпост: постройка и улучшение звучат по-разному ═══════════════
for (const fog of [false, true]) {
  const g = newGame({ fog });
  const isl = g.map.lootIslands[0];
  isl.looted = true;
  g.players[0].gold = 5000;
  const sh = put(g, 0, 'brig', isl.x + isl.radius + 10, isl.y);

  const r1 = applyAction(g, 'p0', { type: 'outpost', shipId: sh.id, islandId: 0 });
  check(`аванпост построен (туман: ${fog})`, r1.ok, r1.error || '');
  const built = g.log.at(-1).k;

  g.turn.actedShips = [];                         // тем же судном — следующий уровень
  const r2 = applyAction(g, 'p0', { type: 'outpost', shipId: sh.id, islandId: 0 });
  check(`аванпост улучшен (туман: ${fog})`, r2.ok, r2.error || '');
  const upped = g.log.at(-1).k;

  check(`стройка и улучшение — РАЗНЫЕ записи (туман: ${fog})`, built !== upped, `${built} ≠ ${upped}`);
  eq(`улучшение называет уровень (туман: ${fog})`, g.log.at(-1).p.building, 'outpost.1.name');
}

console.log(`\nИтого журнал: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
