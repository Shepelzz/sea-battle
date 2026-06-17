// Залп за флагом конфига. Тест проверяет ОБЕ ветки:
//  • флаг включён  → залп работает (2+ цели, каждой round(dmg*MULT)), бот вправе его выбирать;
//  • флаг выключен → ход 'broadside' отклоняется, цели не задеты, бот его НЕ предлагает.
// Пока флага нет (undefined) — трактуем как «включён», т.е. сейчас тест валидирует текущую механику.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { chooseBotAction } from './server/bot.js';
import { SHIP_TYPES, BROADSIDE_MULT } from './server/ships.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

// флаг достаём из config.js, если он уже есть; иначе считаем залп включённым (текущее поведение)
let ENABLED = true;
try { const m = await import('./server/config.js'); if (m.BROADSIDE_ENABLED === false) ENABLED = false; }
catch { /* config.js ещё нет — залп включён */ }

function scene() {
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0, seed: 99 });
  addPlayer(g, 'p0', 'Я'); addPlayer(g, 'p1', 'Враг');
  startGame(g, 'p0');
  g.ships = []; // чистый стол, ход у p0 (idx 0)
  const fregat = { id: 'FR', owner: 0, type: 'fregat', x: 800, y: 600, hp: SHIP_TYPES.fregat.hp };
  g.ships.push(fregat);
  const e1 = { id: 'E1', owner: 1, type: 'brig', x: 850, y: 600, hp: SHIP_TYPES.brig.hp };
  const e2 = { id: 'E2', owner: 1, type: 'brig', x: 760, y: 640, hp: SHIP_TYPES.brig.hp };
  g.ships.push(e1, e2);
  return { g, fregat, e1, e2 };
}

console.log(`(режим: залп ${ENABLED ? 'ВКЛЮЧЁН' : 'ВЫКЛЮЧЕН'})`);

// === поведение хода ===
{
  const { g, e1, e2 } = scene();
  const r = applyAction(g, 'p0', { type: 'broadside', shipId: 'FR' });
  if (ENABLED) {
    const dmg = Math.round(SHIP_TYPES.fregat.dmg * BROADSIDE_MULT);
    check('залп проходит', r.ok === true, `(${r.error || 'ok'})`);
    const a1 = g.ships.find(s => s.id === 'E1'), a2 = g.ships.find(s => s.id === 'E2');
    check('обе цели получили round(dmg*MULT)',
      a1 && a2 && a1.hp === SHIP_TYPES.brig.hp - dmg && a2.hp === SHIP_TYPES.brig.hp - dmg,
      `(${a1?.hp}/${a2?.hp}, ждали ${SHIP_TYPES.brig.hp - dmg})`);
  } else {
    check('залп отклонён флагом', r.ok === false, `(${r.error || 'ok'})`);
    const a1 = g.ships.find(s => s.id === 'E1'), a2 = g.ships.find(s => s.id === 'E2');
    check('цели не задеты', a1?.hp === SHIP_TYPES.brig.hp && a2?.hp === SHIP_TYPES.brig.hp,
      `(${a1?.hp}/${a2?.hp})`);
  }
}

// === одиночный выстрел работает в любом режиме (залп не должен ломать обычную стрельбу) ===
{
  const { g } = scene();
  const r = applyAction(g, 'p0', { type: 'attack', shipId: 'FR', targetType: 'ship', targetId: 'E1' });
  check('одиночный выстрел работает всегда', r.ok === true && g.ships.find(s => s.id === 'E1').hp === SHIP_TYPES.brig.hp - SHIP_TYPES.fregat.dmg,
    `(${r.error || 'ok'})`);
}

// === бот не предлагает залп, когда он выключен ===
{
  const { g } = scene();
  // добавим третьего слабого врага — соблазн для залпа максимальный
  g.ships.push({ id: 'E3', owner: 1, type: 'shkhuna', x: 820, y: 560, hp: 20 });
  const a = chooseBotAction(g, 0, 'hard');
  if (ENABLED) check('бот вправе выбирать залп (включён)', true, '(пропуск проверки)');
  else check('бот НЕ выбирает залп (выключен)', a.type !== 'broadside', `(выбрал ${a.type})`);
}

console.log(`\nИтого залп: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
