// Проверка новой логики пиратов (прямые вызовы game.js).
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { PIRATE, PIRATE_MAX, SHIP_TYPES } from './server/ships.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function game2(nPlayers = 2) {
  const g = createGame('t', { maxPlayers: nPlayers, turnTimer: 0, seed: 7 });
  for (let i = 0; i < nPlayers; i++) addPlayer(g, 'p' + i, 'P' + i);
  startGame(g, 'p0');
  return g;
}
const clearPirates = g => { g.ships = g.ships.filter(s => s.owner !== -1); };
const addPirate = (g, x, y, hp = PIRATE.hp) => {
  const p = { id: 'PIR', owner: -1, type: 'pirate', x, y, hp, maxHp: PIRATE.hp, boss: false, bounty: 200, heading: 0, angryAt: null };
  g.ships.push(p); return p;
};
const addBoss = (g, x, y, hp = 220) => { const p = addPirate(g, x, y, hp); p.boss = true; p.maxHp = 220; return p; };
const myShip = (g, type, x, y, hp) => {
  const s = { id: 'S_' + type, owner: 0, type, x, y, hp: hp ?? SHIP_TYPES[type].hp };
  g.ships.push(s); return s;
};

// === 1. На старте максимум 2 пирата (даже при 4 игроках) ===
{
  const g = game2(4);
  check('старт: пиратов ≤ 2 при 4 игроках', g.ships.filter(s => s.owner === -1).length <= 2,
    `(${g.ships.filter(s => s.owner === -1).length})`);
}

// === 2. Добивание: полумёртвый корабль в радиусе огня — пират стреляет, а не бежит ===
{
  const g = game2(); clearPirates(g);
  const pir = addPirate(g, 500, 500);
  const victim = myShip(g, 'shkhuna', 500, 560, PIRATE.dmg - 2); // hp ниже урона пирата → добиваемый
  applyAction(g, 'p0', { type: 'skip' });                        // → advanceTurn → movePirates
  check('пират добивает корабль в радиусе (не убегает)', !g.ships.some(s => s.id === victim.id),
    '(жертва потоплена)');
}

// === 3. Инициатива: здоровый пират первым атакует НЕ добиваемую цель (раньше не был «зол») ===
{
  const g = game2(); clearPirates(g);
  const pir = addPirate(g, 400, 400);
  const victim = myShip(g, 'shkhuna', 400, 470, 50);            // 50 hp, не одним выстрелом
  const before = victim.hp;
  applyAction(g, 'p0', { type: 'skip' });
  const after = g.ships.find(s => s.id === victim.id)?.hp;
  check('пират сам инициирует бой (урон нанесён)', after === before - PIRATE.dmg, `(${before}→${after})`);
}

// === 4. Бой/бегство: потрёпанный пират в окружении сильных НЕ-добиваемых — убегает ===
// (бегство уводит пирата случайным дрейфом — проверяем статистически по N прогонам:
//  НИ РАЗУ не атакует, и в подавляющем большинстве отдаляется.)
{
  let attacked = 0, fledCount = 0, N = 30;
  for (let k = 0; k < N; k++) {
    const g = game2(); clearPirates(g);
    const pir = addPirate(g, 600, 600, 18);                     // мало hp
    const b1 = myShip(g, 'brig', 600, 690, 200);               // близко, дальнобойный, не добить
    const b2 = myShip(g, 'brig', 690, 600, 200);
    const dBefore = Math.min(dist(pir, b1), dist(pir, b2));
    applyAction(g, 'p0', { type: 'skip' });
    const pirNow = g.ships.find(s => s.id === 'PIR');
    if (b1.hp !== 200 || b2.hp !== 200) attacked++;
    if (pirNow && Math.min(dist(pirNow, b1), dist(pirNow, b2)) > dBefore) fledCount++;
  }
  check('слабый пират в окружении НИ РАЗУ не атакует', attacked === 0, `(атак ${attacked}/${N})`);
  check('…и в большинстве случаев отдаляется (убегает)', fledCount >= N * 0.7, `(убежал ${fledCount}/${N})`);
}

// === 5. Вовлечённый пират не исчезает (pirateAct перехватывает до despawn) ===
{
  let present = 0, runs = 40;
  for (let k = 0; k < runs; k++) {
    const g = game2(); clearPirates(g);
    addPirate(g, 500, 500);
    myShip(g, 'shkhuna', 500, 600, 60); // в зоне хода шхуны (*1.2) → вовлечён
    applyAction(g, 'p0', { type: 'skip' });
    if (g.ships.some(s => s.id === 'PIR')) present++;
  }
  check('вовлечённый пират ни разу не растворился', present === runs, `(${present}/${runs})`);
}

// === 6. Минимум 5 ходов жизни: молодой пират не исчезает, старый — может ===
{
  // молодой (age 0): не должен исчезать НИ РАЗУ
  let youngGone = 0, N = 60;
  for (let k = 0; k < N; k++) {
    const g = game2(); g.ships = []; // ни кораблей, ни других пиратов → не «вовлечён»
    const p = addPirate(g, g.map.w / 2, g.map.h / 2); p.turnSlot = 0; p.bornTurn = g.turn.number;
    applyAction(g, 'p0', { type: 'skip' });
    if (!g.ships.some(s => s.id === 'PIR')) youngGone++;
  }
  check('молодой пират (age<5) не исчезает', youngGone === 0, `(исчез ${youngGone}/${N})`);
  // РАСТВОРЕНИЕ + ПОПОЛНЕНИЕ: старый пират (их >1) иногда растворяется, но на замену тут же
  // спавнится новый в другом месте — состав на карте остаётся полным (PIRATE_MAX), не проседает.
  let replaced = 0, belowMax = 0; N = 300;
  for (let k = 0; k < N; k++) {
    const g = game2(); g.ships = [];                         // без игроков рядом → не «вовлечён»
    const p1 = addPirate(g, g.map.w / 2, g.map.h / 2); p1.turnSlot = 0; p1.bornTurn = g.turn.number - 10;
    const p2 = addPirate(g, g.map.w / 2 + 300, g.map.h / 2); p2.id = 'PIR2'; p2.turnSlot = 0; p2.bornTurn = g.turn.number - 10;
    const idsBefore = new Set([p1.id, p2.id]);
    applyAction(g, 'p0', { type: 'skip' });
    const pirs = g.ships.filter(s => s.owner === -1);
    if (pirs.length < PIRATE_MAX) belowMax++;                // состав просел ниже максимума
    if (pirs.some(s => !idsBefore.has(s.id))) replaced++;    // появился новый id → был despawn+refill
  }
  check('пираты обновляются: старый растворяется, на замену спавнится новый', replaced > 0, `(обновлений ${replaced}/${N})`);
  check('состав никогда не проседает ниже PIRATE_MAX (всегда полный)', belowMax === 0, `(просадок ${belowMax}/${N})`);
}
// === 6б. Море никогда не пустеет: даже из одного пирата состав добивается до PIRATE_MAX ===
{
  let belowMax = 0, emptied = 0, N = 120;
  for (let k = 0; k < N; k++) {
    const g = game2(); g.ships = [];
    const p = addPirate(g, g.map.w / 2, g.map.h / 2); p.turnSlot = 0; p.bornTurn = g.turn.number - 10;
    applyAction(g, 'p0', { type: 'skip' });
    const left = g.ships.filter(s => s.owner === -1).length;
    if (left === 0) emptied++;
    if (left < PIRATE_MAX) belowMax++;
  }
  check('море никогда не пустеет', emptied === 0, `(пустых ${emptied}/${N})`);
  check('одиночный пират добивается пополнением до PIRATE_MAX', belowMax === 0, `(недобора ${belowMax}/${N})`);
}

// === 7. Ход раз в цикл: пират со слотом игрока 2 действует только после хода игрока 2 ===
{
  const g = game2(4); clearPirates(g);
  const pir = addPirate(g, 500, 500); pir.turnSlot = 2;
  const victim = myShip(g, 'shkhuna', 500, 560, PIRATE.dmg - 2); // добиваемый, в радиусе
  applyAction(g, 'p0', { type: 'skip' }); // ход игрока 0 закончился — НЕ слот пирата
  const aliveAfterP0 = g.ships.some(s => s.id === victim.id);
  applyAction(g, 'p1', { type: 'skip' });
  applyAction(g, 'p2', { type: 'skip' }); // ход игрока 2 — слот пирата → атакует
  const deadAfterP2 = !g.ships.some(s => s.id === victim.id);
  check('пират бездействует не в свой слот (после игрока 0)', aliveAfterP0, '(жертва цела)');
  check('пират действует в свой слот (после игрока 2)', deadAfterP2, '(жертва потоплена)');
}

// === 8. Мелкий пират МОЖЕТ пощипать рыбацкий баркас (одиночным выстрелом) ===
{
  const g = game2(); clearPirates(g);
  addPirate(g, 500, 500);
  const barkas = myShip(g, 'barkas', 500, 540, 30); // вплотную, в радиусе огня
  applyAction(g, 'p0', { type: 'skip' });
  const after = g.ships.find(s => s.id === barkas.id);
  check('мелкий пират бьёт баркас', after && after.hp === 30 - PIRATE.dmg, `(hp ${after?.hp})`);
}

// === 9. БОСС агрессивен: идёт НАВСТРЕЧУ подбитому кораблю (а не убегает) ===
{
  const g = game2(); clearPirates(g);
  const boss = addBoss(g, 500, 500);
  const prey = myShip(g, 'brig', 500, 660, 50); // подбит (50<110), вне радиуса огня, но в зоне вовлечения
  const dBefore = dist(boss, prey);
  applyAction(g, 'p0', { type: 'skip' });
  check('босс идёт навстречу подбитому', dist(boss, prey) < dBefore, `(${Math.round(dBefore)}→${Math.round(dist(boss, prey))})`);
}

console.log(`\nИтого: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
