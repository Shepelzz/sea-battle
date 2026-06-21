// Игровые режимы: классика / дезматч / развитие. Прямые вызовы game.js + конфиг-хелперы.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { GAME_MODES, enabledModes, DEFAULT_MODE, modeStartGold, modePeaceRounds, isPeace, START_GOLD } from './server/config.js';
import { SHIP_TYPES } from './server/ships.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

function game(mode, n = 2) {
  const g = createGame('m', { maxPlayers: n, turnTimer: 0, seed: 7 });
  g.config.mode = mode;
  for (let i = 0; i < n; i++) addPlayer(g, 'p' + i, 'P' + i);
  startGame(g, 'p0');
  return g;
}
const put = (g, owner, type, x, y, hp) =>
  (g.ships.push({ id: `${owner}_${type}_${x}_${y}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp }), g.ships.at(-1));
const addPirate = (g, x, y) => (g.ships.push({ id: 'PIR', owner: -1, type: 'pirate', x, y, hp: 80, bounty: 200 }), g.ships.at(-1));

// === Каркас режимов ===
check('режимы: classic/deathmatch/develop', ['classic', 'deathmatch', 'develop'].every(k => GAME_MODES[k]));
check('DEFAULT_MODE = classic', DEFAULT_MODE === 'classic');
check('enabledModes непустой', enabledModes().length >= 1);
check('старт-золото классики = START_GOLD', modeStartGold({ config: { mode: 'classic' } }) === START_GOLD, `(${modeStartGold({ config: { mode: 'classic' } })})`);
check('старт-золото дезматча = 3500', modeStartGold({ config: { mode: 'deathmatch' } }) === 3500);
check('старт-золото развития = START_GOLD', modeStartGold({ config: { mode: 'develop' } }) === START_GOLD);
check('мир: develop = 10 раундов', modePeaceRounds({ config: { mode: 'develop' } }) === 10);
check('мир: классика = 0 раундов', modePeaceRounds({ config: { mode: 'classic' } }) === 0);
check('isPeace develop раунд 1 — да', isPeace({ config: { mode: 'develop' }, turn: { round: 1 } }) === true);
check('isPeace develop раунд 10 — да', isPeace({ config: { mode: 'develop' }, turn: { round: 10 } }) === true);
check('isPeace develop раунд 11 — нет', isPeace({ config: { mode: 'develop' }, turn: { round: 11 } }) === false);
check('isPeace классика — всегда нет', isPeace({ config: { mode: 'classic' }, turn: { round: 1 } }) === false);

// === Старт-золото применяется к игрокам ===
check('дезматч: у игрока 3500 на старте', game('deathmatch').players[0].gold === 3500, `(${game('deathmatch').players[0].gold})`);
check('классика: у игрока START_GOLD', game('classic').players[0].gold === START_GOLD);

// === Счётчик раундов (полный круг) ===
{
  const g = game('classic');
  check('старт: раунд 1', g.turn.round === 1);
  applyAction(g, 'p0', { type: 'skip' });
  check('после хода p0: ещё раунд 1', g.turn.round === 1, `(${g.turn.round})`);
  applyAction(g, 'p1', { type: 'skip' });
  check('после круга (p1): раунд 2', g.turn.round === 2, `(${g.turn.round})`);
}

// === Развитие: рыбозоны — по одной у каждой базы, все крупные (5 слотов) ===
{
  const g = game('develop', 2);
  check('develop: рыбозон = числу баз', g.map.fishZones.length === g.map.bases.length, `(${g.map.fishZones.length})`);
  check('develop: все зоны на 5 слотов', g.map.fishZones.every(z => z.cap === 5), g.map.fishZones.map(z => z.cap).join(','));
  check('develop: каждая зона рядом со своей базой', g.map.bases.every(b =>
    g.map.fishZones.some(z => Math.hypot(z.x - b.x, z.y - b.y) < b.radius + z.radius * 2 + 130)));
  const gc = game('classic', 2);
  check('классика: зоны разбросаны (не по числу баз)', gc.map.fishZones.length !== gc.map.bases.length || gc.map.fishZones.length === 3);
}

// === Развитие: мирный период — гейты ===
{
  const g = game('develop', 2);
  g.ships = []; g.map.lootIslands = []; g.map.fishZones = [];
  const b1 = g.map.bases[1];
  const mine = put(g, 0, 'fregat', 900, 700, 170);        // фрегат: у него мортира (направление неважно для теста гейтов)
  const foe = put(g, 1, 'brig', 940, 720, 110);           // в радиусе мортиры фрегата
  const pir = addPirate(g, 945, 690);
  g.turn.idx = 0; g.turn.round = 1;                        // МИР

  const r1 = applyAction(g, 'p0', { type: 'attack', shipId: mine.id, targetType: 'ship', targetId: foe.id });
  check('мир: атака игрока отклонена', r1.ok === false && /мирн/i.test(r1.error), JSON.stringify(r1));
  check('мир: HP врага не изменилось', foe.hp === 110);

  g.turn.idx = 0; g.turn.moves = 0; g.turn.actedShips = [];
  const r2 = applyAction(g, 'p0', { type: 'attack', shipId: mine.id, targetType: 'ship', targetId: pir.id });
  check('мир: пирата бить МОЖНО', r2.ok === true, JSON.stringify(r2));

  g.turn.idx = 0; g.turn.moves = 0; g.turn.actedShips = [];
  const r3 = applyAction(g, 'p0', { type: 'attack', shipId: mine.id, targetType: 'port', targetId: 1 });
  check('мир: атака базы отклонена', r3.ok === false && /мирн/i.test(r3.error), JSON.stringify(r3));

  g.turn.idx = 0; g.turn.moves = 0; g.turn.actedShips = [];
  const near = applyAction(g, 'p0', { type: 'move', shipId: mine.id, x: 900, y: 760 }); // в зоне keepout базы p1, без коллизий
  check('мир: подход к чужой базе отклонён', near.ok === false && /мирн/i.test(near.error), JSON.stringify(near));

  // ВОЙНА (раунд 11) — те же действия разрешены
  g.turn.idx = 0; g.turn.round = 11; g.turn.moves = 0; g.turn.actedShips = [];
  const r4 = applyAction(g, 'p0', { type: 'attack', shipId: mine.id, targetType: 'ship', targetId: foe.id });
  check('война: атака игрока проходит', r4.ok === true, JSON.stringify(r4));
}

console.log(`\nИтого режимы: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
