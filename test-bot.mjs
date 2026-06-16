// Проверка поведения ботов: прикрытие кормящих рыбаков и выбор БЕЗОПАСНОЙ рыбной зоны
// (две жалобы: рыбак-смертник на круг + соло-атака без прикрытия).
import { createGame, addPlayer, startGame } from './server/game.js';
import { chooseBotAction } from './server/bot.js';
import { SHIP_TYPES } from './server/ships.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };
const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function setup() {
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0, seed: 4242 });
  addPlayer(g, 'p0', 'Я');
  addPlayer(g, 'p1', 'Враг');
  startGame(g, 'p0');
  g.ships = [];                                   // чистый стол
  g.map.lootIslands.forEach(i => (i.looted = true)); // лут не мешает оценкам
  g.players.forEach(p => (p.gold = 0));           // без денег — изолируем решения о движении/бое
  return g;
}
const put = (g, owner, type, x, y, hp) =>
  (g.ships.push({ id: `${owner}_${type}_${x}_${y}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp }), g.ships.at(-1));

// === 1. Прикрытие кормилицы: враг насел на наш баркас в зоне — боевой корабль идёт его бить ===
{
  const g = setup();
  const z = g.map.fishZones[0];
  const fisher = put(g, 0, 'barkas', z.x, z.y);                 // мой кормилец в зоне
  const enemy = put(g, 1, 'brig', z.x + 60, z.y);              // враг впритык к зоне
  const myBrig = put(g, 0, 'brig', z.x - 320, z.y);            // мой боевик в стороне (вне радиуса огня)
  const dBefore = D(myBrig, enemy);
  const a = chooseBotAction(g, 0, 'hard');
  // ждём: либо стреляем по врагу (если достаём), либо ДВИГАЕМ боевик НАВСТРЕЧУ врагу-обидчику
  const movesToEnemy = a.type === 'move' && a.shipId === myBrig.id &&
    Math.hypot(a.x - enemy.x, a.y - enemy.y) < dBefore;
  const shootsEnemy = a.type === 'attack' && a.targetId === enemy.id;
  check('боевой прикрывает кормящего баркаса', movesToEnemy || shootsEnemy, `(${a.type} ${a.shipId || a.targetId || ''})`);
}

// === 2. Рыбак выбирает БЕЗОПАСНУЮ зону, а не ближайшую под врагом ===
{
  const g = setup();
  const zNear = g.map.fishZones[0];               // ближе к рыбаку, но под огнём
  const zSafe = g.map.fishZones[1];               // дальше, зато чисто
  // делаем все зоны кроме zSafe опасными
  g.map.fishZones.forEach(z => { if (z !== zSafe) put(g, 1, 'brig', z.x + 40, z.y); });
  // рыбак стоит ВНЕ зон, ближе к опасной zNear
  const fisher = put(g, 0, 'barkas',
    Math.round((zNear.x * 2 + zSafe.x) / 3), Math.round((zNear.y * 2 + zSafe.y) / 3));
  const dNearBefore = D(fisher, zNear), dSafeBefore = D(fisher, zSafe);
  const a = chooseBotAction(g, 0, 'mid');
  const movesFisher = a.type === 'move' && a.shipId === fisher.id;
  const towardSafe = movesFisher && Math.hypot(a.x - zSafe.x, a.y - zSafe.y) < dSafeBefore;
  const notTowardNear = !movesFisher || Math.hypot(a.x - zNear.x, a.y - zNear.y) >= dNearBefore - 5;
  check('рыбак идёт в безопасную зону, а не в ближнюю опасную', towardSafe && notTowardNear,
    `(${a.type} → safeΔ ${Math.round(dSafeBefore)}→${movesFisher ? Math.round(Math.hypot(a.x - zSafe.x, a.y - zSafe.y)) : '—'})`);
}

// === 3. Рыбак под ударом без защитника отходит к базе (не кормит собой врага) ===
{
  const g = setup();
  const z = g.map.fishZones[0];
  const base = g.map.bases[0];
  const fisher = put(g, 0, 'barkas', z.x, z.y);   // в зоне
  put(g, 1, 'brig', z.x + 60, z.y);               // враг впритык, мой боевик далеко-отсутствует
  const dBaseBefore = D(fisher, base);
  const a = chooseBotAction(g, 0, 'mid');
  const retreats = a.type === 'move' && a.shipId === fisher.id &&
    Math.hypot(a.x - base.x, a.y - base.y) < dBaseBefore;
  check('рыбак без прикрытия отходит к базе', retreats, `(${a.type} ${a.shipId || ''})`);
}

console.log(`\nИтого: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
