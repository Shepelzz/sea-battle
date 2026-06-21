// Новая боевая механика: БОРТОВОЙ ЗАЛП (ВЕСЬ борт по ВСЕМ врагам с этой стороны в радиусе, урон только по дистанции,
// оба борта = 1 действие) и МОРТИРА (бывший одиночный выстрел, только фрегат/линкор). Прямые вызовы game.js.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { SHIP_TYPES, BROADSIDE_CANNONS, MORTAR_SHIPS } from './server/ships.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

function game(multiMove = true) {
  const g = createGame('b', { maxPlayers: 2, turnTimer: 0, seed: 7 });
  g.config.multiMove = multiMove;
  addPlayer(g, 'A', 'A'); addPlayer(g, 'B', 'B');
  startGame(g, 'A');
  g.ships = []; g.map.lootIslands = [];
  g.turn.idx = 0; g.turn.moves = 0; g.turn.actedShips = []; g.turn.broadsideSides = {};
  return g;
}
let seq = 0;
const put = (g, owner, type, x, y, opt = {}) => {
  const s = { id: owner + '_' + type + '_' + (seq++), owner, type, x, y, hp: opt.hp ?? SHIP_TYPES[type].hp };
  if (opt.heading !== undefined) s.heading = opt.heading;
  g.ships.push(s); return s;
};
const broadside = (g, ship, tx, ty) => applyAction(g, 'A', { type: 'broadside', shipId: ship.id, tx, ty });
const mortar = (g, ship, targetId, targetType = 'ship') => applyAction(g, 'A', { type: 'attack', shipId: ship.id, targetType, targetId });

// heading=0 → нос на восток (+x); левый борт (port) = север (−y), правый (starboard) = юг (+y)

// === Залп бьёт В БОРТ (абеам), не по курсу/корме ===
{
  const g = game();
  const me = put(g, 0, 'shkhuna', 500, 500, { heading: 0 });
  const north = put(g, 1, 'brig', 500, 430, { hp: 110 });   // левый борт, в секторе
  const ahead = put(g, 1, 'brig', 608, 500, { hp: 110 });   // прямо по курсу (вне сектора), дист ≤ радиуса
  const r = broadside(g, me, 500, 380);                     // наводим в левый борт (север)
  check('залп прошёл', r.ok, JSON.stringify(r));
  check('цель в борт — получила урон', north.hp < 110, `(${north.hp})`);
  check('цель по курсу — НЕ задета (только в борт)', ahead.hp === 110, `(${ahead.hp})`);
}

// === Урон падает с расстоянием (ближе к борту — больнее) ===
{
  const g = game();
  const me = put(g, 0, 'fregat', 500, 500, { heading: 0 });
  const near = put(g, 1, 'brig', 500, 440, { hp: 300 });    // дист 60
  const far = put(g, 1, 'brig', 500, 360, { hp: 300 });     // дист 140
  broadside(g, me, 500, 380);                               // левый борт
  const dN = 300 - near.hp, dF = 300 - far.hp;
  check('обе цели в секторе получили урон', dN > 0 && dF > 0, `(near −${dN}, far −${dF})`);
  check('ближняя получила больше дальней', dN > dF, `(near −${dN} > far −${dF})`);
}

// === Весь борт бьёт ПО ВСЕМ врагам с этой стороны (не по одному); ловит и диагонали (раньше выпадали из узкого сектора) ===
{
  const g = game();
  const me = put(g, 0, 'linkor', 500, 500, { heading: 0 });   // нос восток → левый борт = север
  const a = put(g, 1, 'brig', 500, 440, { hp: 200 });          // абеам (север)
  const b = put(g, 1, 'brig', 540, 431, { hp: 200 });          // ~30° вперёд-влево (в секторе)
  const c = put(g, 1, 'brig', 460, 431, { hp: 200 });          // ~30° назад-влево (в секторе)
  const r = broadside(g, me, 500, 400);                        // левый борт
  check('залп прошёл', r.ok, JSON.stringify(r));
  check('накрыты ВСЕ 3 цели борта (вкл. диагонали), а не одна', a.hp < 200 && b.hp < 200 && c.hp < 200, `(a${a.hp} b${b.hp} c${c.hp})`);
}

// === Кто умеет залп: боевые да, баркас/ремонтник — нет ===
{
  const g = game();
  const bk = put(g, 0, 'barkas', 500, 500, { heading: 0 });
  const rp = put(g, 0, 'repair', 540, 500, { heading: 0 });
  put(g, 1, 'brig', 500, 440, { hp: 110 });
  check('баркас не даёт залп', broadside(g, bk, 500, 380).ok === false);
  check('ремонтник не даёт залп', broadside(g, rp, 500, 380).ok === false);
  check('пушек у баркаса/ремонтника нет в конфиге', !BROADSIDE_CANNONS.barkas && !BROADSIDE_CANNONS.repair);
}

// === Мортира — только фрегат/линкор ===
{
  const g = game();
  const sh = put(g, 0, 'shkhuna', 500, 500, { heading: 0 });
  const fr = put(g, 0, 'fregat', 460, 500, { heading: 0 });
  const foe = put(g, 1, 'brig', 520, 500, { hp: 110 });
  check('MORTAR_SHIPS = фрегат/линкор', JSON.stringify(MORTAR_SHIPS) === JSON.stringify(['fregat', 'linkor']));
  check('шхуна НЕ может мортиру', mortar(g, sh, foe.id).ok === false);
  const r = mortar(g, fr, foe.id);
  check('фрегат МОЖЕТ мортиру (по кораблю)', r.ok && foe.hp === 110 - SHIP_TYPES.fregat.dmg, `(${foe.hp})`);
}

// === Экономика хода: оба борта = ОДНО действие корабля (2-й борт бесплатный) ===
{
  const g = game(true);
  const me = put(g, 0, 'brig', 500, 500, { heading: 0 });
  put(g, 1, 'shkhuna', 500, 440, { hp: 60 });   // левый борт
  put(g, 1, 'shkhuna', 500, 560, { hp: 60 });   // правый борт
  check('залп левым бортом — ок', broadside(g, me, 500, 400).ok);
  check('после 1-го борта потрачен 1 слот (moves=1)', g.turn.moves === 1, `(${g.turn.moves})`);
  check('корабль ещё не «отстрелялся» (можно 2-й борт)', !(g.turn.actedShips || []).includes(me.id));
  check('тем же бортом повторно — нельзя', broadside(g, me, 500, 400).ok === false);
  check('ходить после начатого залпа — нельзя', applyAction(g, 'A', { type: 'move', shipId: me.id, x: 545, y: 500 }).ok === false);
  check('правый борт — ок', broadside(g, me, 500, 600).ok);
  check('2-й борт БЕСПЛАТНЫЙ (moves всё ещё 1)', g.turn.moves === 1, `(${g.turn.moves})`);
  check('после обоих бортов — отстрелялся', (g.turn.actedShips || []).includes(me.id));
}

// === Порт: залп — символический урон + отдача; мортира — осадный урон ===
{
  const g = game();
  const fr = put(g, 0, 'fregat', 1300, 994, { heading: -Math.PI / 2, hp: 170 }); // нос на север → правый борт = восток (к базе p1)
  const beforeB = g.players[1].portHp;
  const r = broadside(g, fr, 1401, 994);                    // наводим в базу p1 (восток = правый борт)
  const chip = beforeB - g.players[1].portHp;
  check('залп по порту прошёл', r.ok, JSON.stringify(r));
  check('залп бьёт порт лишь символически (<20)', chip > 0 && chip < 20, `(−${chip})`);
  check('порт огрызнулся по стрелявшему', fr.hp < 170, `(${fr.hp})`);

  const g2 = game();
  const fr2 = put(g2, 0, 'fregat', 1300, 994, { hp: 170 });
  const beforeM = g2.players[1].portHp;
  mortar(g2, fr2, 1, 'port');
  check('мортира бьёт порт по-настоящему (≥40)', beforeM - g2.players[1].portHp >= 40, `(−${beforeM - g2.players[1].portHp})`);
}

console.log(`\nИтого залп/мортира: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
