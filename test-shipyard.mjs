// Верфь: покупка НЕ должна отклоняться «нет места», пока у базы физически есть вода.
// Регресс на баг «к концу партии (разросшийся флот за непотопляемым авианосцем) не купить флот,
// хотя денег хватает» — раньше перебор спавна был всего 5 колец × 14 секторов = 70 точек у базы.
import { createGame, addPlayer, startGame, applyAction, spawnCheatShip } from './server/game.js';
import { START_GOLD } from './server/ships.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

function game2(multiMove = true) {
  const g = createGame('y', { maxPlayers: 2, turnTimer: 0, seed: 7, multiMove });
  addPlayer(g, 'a', 'A'); addPlayer(g, 'b', 'B');
  startGame(g, 'a');
  return g;
}
const buyAsFirstAction = (g, ships) => {
  g.turn.idx = 0; g.turn.moves = 0; g.turn.actedShips = [];
  return applyAction(g, 'a', { type: 'buy', ships });
};

// === 1. Разросшийся флот + авианосец: 120 покупок подряд — НИ ОДНОГО «нет места» ===
{
  const g = game2();
  g.ships = g.ships.filter(s => s.owner === 0); // оставим только флот игрока 0
  spawnCheatShip(g, 0, 'carrier');              // непотопляемый авианосец у базы (как в той партии)
  g.players[0].gold = 1e9;
  let bought = 0, noRoom = 0;
  for (let i = 0; i < 120; i++) {
    const r = buyAsFirstAction(g, ['barkas']);
    if (r.ok) bought++;
    else if (r.error === 'Возле порта нет места для новых кораблей') noRoom++;
  }
  check('120 покупок подряд проходят (флот разросся)', bought === 120, `(куплено ${bought}/120)`);
  check('ни одного отказа «нет места»', noRoom === 0, `(отказов ${noRoom})`);
}

// === 2. Покупку при деньгах не блокирует ничего, кроме реальной нехватки золота ===
{
  const g = game2();
  g.players[0].gold = 50; // дешевле барки (60) — не хватает
  check('мало золота → честный отказ', buyAsFirstAction(g, ['barkas']).error === 'Не хватает золота');
  g.players[0].gold = 60;
  check('ровно на барку → покупка проходит', buyAsFirstAction(g, ['barkas']).ok === true);
}

// === 3. Совместимость: на пустой базе первый корабль встаёт в прежнюю ближнюю «центровую» точку ===
{
  const g = game2(false); // классика — не важно для расстановки
  g.ships = g.ships.filter(s => s.owner !== 0);
  g.players[0].gold = START_GOLD;
  const base = g.map.bases[0];
  const toCenter = Math.atan2(g.map.h / 2 - base.y, g.map.w / 2 - base.x);
  const r0 = base.radius + 45; // SPAWN_FAN_R0
  const expX = Math.round(base.x + Math.cos(toCenter) * r0);
  const expY = Math.round(base.y + Math.sin(toCenter) * r0);
  buyAsFirstAction(g, ['shkhuna']);
  const s = g.ships.find(x => x.owner === 0);
  check('первый корабль — в прежней ближней центр-направленной точке', s.x === expX && s.y === expY, `(${s.x},${s.y} vs ${expX},${expY})`);
}

console.log(`\nИтого верфь: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
