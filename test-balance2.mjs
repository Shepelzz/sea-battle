// Точечная проверка двух правок: пассивная рыбалка и урон линкора по порту.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { SHIP_TYPES, PORT_HP, PORT_INCOME } from './server/ships.js';

let ok = 0, fail = 0;
const check = (n, c, extra='') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

function freshGame() {
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0, seed: 12345 });
  addPlayer(g, 'A', 'Алиса');
  addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  g.ships = g.ships.filter(s => s.owner !== -1); // убираем пиратов, чтобы не мешали
  return g;
}

// === 1. Пассивная рыбалка ===
{
  const g = freshGame();
  const zone = g.map.fishZones[0];
  // баркас Боба (игрок 1) в рыбной зоне
  g.ships.push({ id: 'bk1', owner: 1, type: 'barkas', x: zone.x, y: zone.y, hp: SHIP_TYPES.barkas.hp });
  const before = g.players[1].gold;
  applyAction(g, 'A', { type: 'skip' }); // ход Алисы → переходит к Бобу, Бобу капает доход
  const delta = g.players[1].gold - before;
  check('баркас в зоне: пассивный доход = порт + рыбалка',
    delta === PORT_INCOME + SHIP_TYPES.barkas.fishing, `(Δ=${delta}, ждали ${PORT_INCOME + SHIP_TYPES.barkas.fishing})`);

  // второй круг — снова капает (доход повторяется каждый ход)
  const before2 = g.players[1].gold;
  applyAction(g, 'B', { type: 'skip' }); // Боб → Алиса
  applyAction(g, 'A', { type: 'skip' }); // Алиса → Боб (снова доход Бобу)
  check('доход капает каждый ход', g.players[1].gold - before2 === PORT_INCOME + SHIP_TYPES.barkas.fishing,
    `(Δ=${g.players[1].gold - before2})`);
}

// === 2. Баркас ВНЕ зоны — только доход порта, без рыбалки ===
{
  const g = freshGame();
  g.ships.push({ id: 'bk2', owner: 1, type: 'barkas', x: 30, y: 30, hp: SHIP_TYPES.barkas.hp }); // в углу, не в зоне
  const before = g.players[1].gold;
  applyAction(g, 'A', { type: 'skip' });
  check('баркас вне зоны: только доход порта', g.players[1].gold - before === PORT_INCOME,
    `(Δ=${g.players[1].gold - before})`);
}

// === 3. collect больше не ловит рыбу (только клад) ===
{
  const g = freshGame();
  const zone = g.map.fishZones[0];
  g.ships.push({ id: 'bk3', owner: 0, type: 'barkas', x: zone.x, y: zone.y, hp: SHIP_TYPES.barkas.hp });
  // у Алисы баркас в зоне, но рядом нет нелутанного острова → collect должен отклониться
  // (уберём досягаемость островов: оставим баркас в зоне, острова далеко от всех её кораблей)
  const r = applyAction(g, 'A', { type: 'collect' });
  check('collect только за рыбу — отклонён (рыбалка пассивна)', r.ok === false, `(${r.error || 'ok'})`);
}

// === 4. Урон линкора по порту = round(65*1.5)=98, и база НЕ падает с 3-4 тычков ===
{
  const g = freshGame();
  const base = g.map.bases[1];
  // линкор Алисы вплотную к порту Боба
  g.ships.push({ id: 'lk', owner: 0, type: 'linkor', x: base.x + base.radius + 20, y: base.y, hp: 280 });
  const start = g.players[1].portHp;
  const expected = Math.round(SHIP_TYPES.linkor.dmg * SHIP_TYPES.linkor.portBonus);
  applyAction(g, 'A', { type: 'attack', shipId: 'lk', targetType: 'port', targetId: 1 });
  const oneShot = start - g.players[1].portHp;
  check('один залп линкора по порту', oneShot === expected, `(−${oneShot}, ждали −${expected})`);

  // сколько всего залпов нужно, чтобы свалить полный порт
  const g2 = freshGame();
  const base2 = g2.map.bases[1];
  g2.ships.push({ id: 'lk2', owner: 0, type: 'linkor', x: base2.x + base2.radius + 20, y: base2.y, hp: 9999 });
  let shots = 0;
  while (g2.players[1].alive && shots < 20) {
    const rr = applyAction(g2, 'A', { type: 'attack', shipId: 'lk2', targetType: 'port', targetId: 1 });
    if (!rr.ok) break;
    shots++;
    if (g2.players[1].alive) applyAction(g2, 'B', { type: 'skip' }); // вернуть ход Алисе
  }
  const need = Math.ceil(PORT_HP / expected);
  check('линкор валит порт за ' + shots + ' залпов (не 3-4)', shots >= 5 && shots === need,
    `(нужно ${shots}, расчёт ${need}, было бы при ×2: ${Math.ceil(PORT_HP / (SHIP_TYPES.linkor.dmg*2))})`);
}

console.log(`\nИтого: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
