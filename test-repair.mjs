// Корабль-ремонтник: действие 'repair' чинит союзный корабль в радиусе (жёлтый луч),
// сам не атакует, тратит один ход (как остальные). Прямые вызовы game.js.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { SHIP_TYPES, REPAIR_CHARGES, REPAIR_DOCK_REACH } from './server/ships.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

function setup(multiMove = true) {
  const g = createGame('r', { maxPlayers: 2, turnTimer: 0, seed: 4242 });
  g.config.multiMove = multiMove; // createGame не копирует multiMove — ставим явно (как в index.js)
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  g.ships = []; g.map.lootIslands = [];
  g.turn.idx = 0; g.turn.moves = 0; g.turn.actedShips = [];
  return g;
}
const put = (g, owner, type, x, y, hp) =>
  (g.ships.push({ id: `${owner}_${type}_${x}_${y}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp }), g.ships.at(-1));
const repair = (g, shipId, targetId) => applyAction(g, 'A', { type: 'repair', shipId, targetId });

// === Конфиг ремонтника ===
const R = SHIP_TYPES.repair;
check('repair.repairer=true', R.repairer === true);
check('repair не атакует (dmg 0)', R.dmg === 0);
check('repair.healFrac задан (доля макс. HP)', typeof R.healFrac === 'number' && R.healFrac > 0 && R.healFrac < 1, `(${R.healFrac})`);
check('радиус ремонта чуть меньше хода', R.fireRange < R.move, `(${R.fireRange} < ${R.move})`);
const healOf = type => Math.round(SHIP_TYPES[type].hp * R.healFrac); // ожидаемый ремонт для класса

// === Чинит подбитый союзный корабль в радиусе на долю его макс. HP ===
{
  const g = setup();
  const rep = put(g, 0, 'repair', 500, 500);
  const ally = put(g, 0, 'brig', 500, 560, 50);            // в радиусе (60 ≤ 115), подбит (50<110)
  const exp = healOf('brig');                              // round(110*0.15)=17
  const r = repair(g, rep.id, ally.id);
  check('ремонт прошёл', r.ok, JSON.stringify(r));
  check('HP восстановлено на долю макс. HP', ally.hp === 50 + exp, `(50→${ally.hp}, ожидалось +${exp})`);
  check('запушено событие repair с фактическим heal', g.events.some(e => e.type === 'repair' && e.heal === exp),
    JSON.stringify(g.events.filter(e => e.type === 'repair')));
}

// === Большой корабль чинится сильнее мелкого (доля от макс. HP, не фикс) ===
{
  check('ремонт линкора > ремонта шхуны (доля от HP)', healOf('linkor') > healOf('shkhuna'),
    `(линкор +${healOf('linkor')} vs шхуна +${healOf('shkhuna')})`);
}

// === Лечение не перехлёстывает максимум HP ===
{
  const g = setup();
  const rep = put(g, 0, 'repair', 500, 500);
  const ally = put(g, 0, 'shkhuna', 500, 540, 55);          // max 60, до полного не хватает heal
  repair(g, rep.id, ally.id);
  check('HP не превышает максимум', ally.hp === SHIP_TYPES.shkhuna.hp, `(→${ally.hp}, max ${SHIP_TYPES.shkhuna.hp})`);
}

// === Нельзя чинить целый корабль ===
{
  const g = setup();
  const rep = put(g, 0, 'repair', 500, 500);
  const ally = put(g, 0, 'brig', 500, 560);                // полный HP
  check('целый корабль чинить нельзя', repair(g, rep.id, ally.id).ok === false);
}

// === Нельзя чинить врага / себя / вне радиуса ===
{
  const g = setup();
  const rep = put(g, 0, 'repair', 500, 500);
  const foe = put(g, 1, 'brig', 500, 560, 50);
  check('врага чинить нельзя', repair(g, rep.id, foe.id).ok === false);
  check('сам себя чинить нельзя', repair(g, rep.id, rep.id).ok === false);
  const far = put(g, 0, 'brig', 500, 500 + R.fireRange + 40, 50); // за радиусом
  check('вне радиуса — нельзя', repair(g, rep.id, far.id).ok === false);
}

// === Ремонтник НЕ умеет стрелять ===
{
  const g = setup();
  const rep = put(g, 0, 'repair', 500, 500);
  const foe = put(g, 1, 'brig', 500, 560, 110);
  const r = applyAction(g, 'A', { type: 'attack', shipId: rep.id, targetType: 'ship', targetId: foe.id });
  check('ремонтник не атакует', r.ok === false, JSON.stringify(r));
  check('у врага HP не изменилось', foe.hp === 110, `(${foe.hp})`);
}

// === Ремонт тратит ход кораблём: дважды одним ремонтником за ход нельзя ===
{
  const g = setup(true); // ход тремя судами
  const rep = put(g, 0, 'repair', 500, 500);
  const a1 = put(g, 0, 'brig', 500, 560, 50);
  const a2 = put(g, 0, 'brig', 560, 500, 50);
  check('первый ремонт ок', repair(g, rep.id, a1.id).ok === true);
  check('ход засчитан (moves=1)', g.turn.moves === 1, `(${g.turn.moves})`);
  check('ремонтник помечен сходившим', (g.turn.actedShips || []).includes(rep.id));
  check('тем же ремонтником второй раз — нельзя', repair(g, rep.id, a2.id).ok === false);
}

// === Классика (multiMove off): ремонт завершает ход ===
{
  const g = setup(false);
  const rep = put(g, 0, 'repair', 500, 500);
  const ally = put(g, 0, 'brig', 500, 560, 50);
  repair(g, rep.id, ally.id);
  check('классика: после ремонта ход перешёл', g.turn.idx === 1, `(idx ${g.turn.idx})`);
}

// === Запас материалов: ремонт тратит заряд ===
{
  const g = setup();
  const rep = put(g, 0, 'repair', 500, 500); rep.repairCharges = 2;
  const a1 = put(g, 0, 'brig', 500, 560, 50);
  check('REPAIR_CHARGES задан', typeof REPAIR_CHARGES === 'number' && REPAIR_CHARGES > 0, `(${REPAIR_CHARGES})`);
  repair(g, rep.id, a1.id);
  check('ремонт тратит один заряд (2→1)', rep.repairCharges === 1, `(${rep.repairCharges})`);
}

// === Без материалов чинить нельзя; пополнить можно У СВОЕЙ базы ===
{
  const g = setup();
  const base = g.map.bases[0];
  const rep = put(g, 0, 'repair', base.x + base.radius + 20, base.y); rep.repairCharges = 0;
  const a1 = put(g, 0, 'brig', rep.x, rep.y + 50, 50);
  check('без материалов чинить нельзя', repair(g, rep.id, a1.id).ok === false, `(заряды ${rep.repairCharges})`);
  const r = applyAction(g, 'A', { type: 'recharge', shipId: rep.id });
  check('пополнить у базы — ок', r.ok, JSON.stringify(r));
  check('запас восстановлен до максимума', rep.repairCharges === REPAIR_CHARGES, `(${rep.repairCharges})`);
  check('пополнение тратит ход (acted + moves)', (g.turn.actedShips || []).includes(rep.id) && g.turn.moves === 1, `(moves ${g.turn.moves})`);
}

// === Пополнять вдали от базы / при полном запасе нельзя ===
{
  const g = setup();
  const rep = put(g, 0, 'repair', 500, 500); rep.repairCharges = 0; // далеко от базы
  check('пополнить вдали от базы нельзя', applyAction(g, 'A', { type: 'recharge', shipId: rep.id }).ok === false);

  const g2 = setup();
  const base = g2.map.bases[0];
  const rep2 = put(g2, 0, 'repair', base.x + base.radius + 20, base.y); // полный (undefined=полный)
  check('пополнять полный запас нельзя', applyAction(g2, 'A', { type: 'recharge', shipId: rep2.id }).ok === false);
}

// === Купленный ремонтник получает полный запас материалов ===
{
  const g = setup();
  g.players[0].gold = 9999;
  const r = applyAction(g, 'A', { type: 'buy', ships: ['repair'] });
  const bought = g.ships.find(s => s.owner === 0 && s.type === 'repair');
  check('купленный ремонтник имеет полный запас', r.ok && bought && bought.repairCharges === REPAIR_CHARGES, `(${bought?.repairCharges})`);
}

console.log(`\nИтого ремонтник: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
