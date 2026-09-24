// СНАПШОТ-ТЕСТ конфигурации: фиксирует ТОЧНЫЕ текущие значения всех игровых констант
// и ключевые выходы генератора карты. Цель — чтобы вынос констант в config.js не сдвинул
// ни одной цифры. Если правишь баланс намеренно — обнови ожидания здесь же.
import {
  SHIP_TYPES, START_FLEET, START_GOLD, PORT_HP, PORT_RETURN_DMG, PORT_INCOME,
  PORT_DMG_TO_SHIPS, SHIP_COLLISION_DIST, LOOT_REACH,
  BROADSIDE_CANNONS, BROADSIDE_SIDE_MIN, BROADSIDE_PORT_MULT, MORTAR_SHIPS, MORTAR_SHIP_MULT,
  FISH_ZONE_CAP, FISH_ZONE_CAP_BIG, FISH_BIG_RADIUS, fishZoneCap, FISH_INCOME,
  PIRATE, PIRATE_DESPAWN_CHANCE, PIRATE_SPAWN_CHANCE, PIRATE_MOVE_CHANCE,
  PIRATE_BOSS_CHANCE, PIRATE_BOSS_HP, PIRATE_REVENGE_SHOT, PIRATE_FLEE_CHANCE, PIRATE_CALM_CHANCE
} from '../server/ships.js';
import { generateMap } from '../server/mapgen.js';

let ok = 0, fail = 0;
const eq = (n, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  pass ? (ok++) : (fail++, console.error(`✗ ${n}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};

// === Флот: каждое поле каждого класса ===
// Имён и описаний тут нет намеренно: они переехали в словари клиента (public/locales/*.json),
// сервер знает только тип и цифры — см. шапку SHIP_TYPES. Их полноту проверяет test-i18n.mjs.
const FLEET = {
  barkas:  { icon: '⛵', price: 60,  hp: 30,  dmg: 15,  fireRange: 70,  move: 180, fishing: 5, broadside: undefined, portBonus: undefined, name: undefined, desc: undefined },
  shkhuna: { icon: '🛥', price: 110, hp: 60,  dmg: 45, fireRange: 110, move: 170, fishing: 0, broadside: undefined, portBonus: undefined, name: undefined, desc: undefined },
  brig:    { icon: '⚓', price: 220, hp: 110, dmg: 84, fireRange: 140, move: 135, fishing: 0, broadside: undefined, portBonus: undefined, name: undefined, desc: undefined },
  fregat:  { icon: '🚢', price: 380, hp: 170, dmg: 126, fireRange: 165, move: 110, fishing: 0, broadside: undefined, portBonus: undefined, name: undefined, desc: undefined },
  linkor:  { icon: '🛳', price: 500, hp: 280, dmg: 195, fireRange: 190, move: 90,  fishing: 0, broadside: undefined, portBonus: 1.5, name: undefined, desc: undefined },
  repair:  { icon: '🛟', price: 280, hp: 130, dmg: 0,  fireRange: 115, move: 135, fishing: 0, healFrac: 0.3, repairer: true, broadside: undefined, portBonus: undefined, name: undefined, desc: undefined },
  carrier: { icon: '🛩', price: 0,   hp: 1400,dmg: 195, fireRange: 320, move: 280, fishing: 0, volley: 5, cheat: true, name: undefined, desc: undefined } // чит-корабль (тестовый режим)
};
eq('набор классов', Object.keys(SHIP_TYPES).sort(), Object.keys(FLEET).sort());
for (const [type, want] of Object.entries(FLEET)) {
  const s = SHIP_TYPES[type] || {};
  for (const [k, v] of Object.entries(want)) eq(`${type}.${k}`, s[k], v);
}

// === Бой / экономика / порт ===
eq('BROADSIDE_CANNONS', BROADSIDE_CANNONS, { shkhuna: 2, brig: 2, fregat: 3, linkor: 4, carrier: 6 });
eq('BROADSIDE_SIDE_MIN', BROADSIDE_SIDE_MIN, 0.6);
eq('BROADSIDE_PORT_MULT', BROADSIDE_PORT_MULT, 0.12);
eq('MORTAR_SHIPS', MORTAR_SHIPS, ['fregat', 'linkor']);
eq('MORTAR_SHIP_MULT', MORTAR_SHIP_MULT, 0.5);
eq('FISH_INCOME', FISH_INCOME, 5);
eq('barkas.fishing === FISH_INCOME', SHIP_TYPES.barkas.fishing, FISH_INCOME);
eq('FISH_ZONE_CAP', FISH_ZONE_CAP, 4);
eq('FISH_ZONE_CAP_BIG', FISH_ZONE_CAP_BIG, 5);
eq('FISH_BIG_RADIUS', FISH_BIG_RADIUS, 102); // 15% от макс. радиуса 120
eq('fishZoneCap(90)=4', fishZoneCap(90), 4);
eq('fishZoneCap(101)=4 (ниже порога)', fishZoneCap(101), 4);
eq('fishZoneCap(102)=5 (порог включительно)', fishZoneCap(102), 5);
eq('fishZoneCap(120)=5', fishZoneCap(120), 5);
eq('START_FLEET', START_FLEET, ['shkhuna', 'shkhuna', 'fregat']);
eq('START_GOLD', START_GOLD, 350);
eq('PORT_HP', PORT_HP, 1680);
eq('PORT_RETURN_DMG', PORT_RETURN_DMG, 60);
eq('PORT_INCOME', PORT_INCOME, 6);
eq('PORT_DMG_TO_SHIPS', PORT_DMG_TO_SHIPS, 0);
eq('SHIP_COLLISION_DIST', SHIP_COLLISION_DIST, 26);
eq('LOOT_REACH', LOOT_REACH, 55);

// === Пираты ===
eq('PIRATE.hp', PIRATE.hp, 80);
eq('PIRATE.dmg', PIRATE.dmg, 24);
eq('PIRATE.fireRange', PIRATE.fireRange, 130);
eq('PIRATE.move', PIRATE.move, 80);
eq('PIRATE.price', PIRATE.price, 0);
eq('PIRATE.npc', PIRATE.npc, true);
eq('PIRATE_DESPAWN_CHANCE', PIRATE_DESPAWN_CHANCE, 0.08);
eq('PIRATE_SPAWN_CHANCE', PIRATE_SPAWN_CHANCE, 0.16);
eq('PIRATE_MOVE_CHANCE', PIRATE_MOVE_CHANCE, 0.75);
eq('PIRATE_BOSS_CHANCE', PIRATE_BOSS_CHANCE, 0.14);
eq('PIRATE_BOSS_HP', PIRATE_BOSS_HP, 220);
eq('PIRATE_REVENGE_SHOT', PIRATE_REVENGE_SHOT, 0.35);
eq('PIRATE_FLEE_CHANCE', PIRATE_FLEE_CHANCE, 0.5);
eq('PIRATE_CALM_CHANCE', PIRATE_CALM_CHANCE, 0.25);

// === Карта: размеры, счётчики, радиусы, детерминизм ===
// эталон координат ниже снят с ПОЛНОЙ карты — просим её явно; живая карта двоих меньше (см. ниже)
const m2 = generateMap(7, 2, { mapScale: 1 }), m4 = generateMap(7, 4, { mapScale: 1 });
eq('map.w (полная)', m2.w, 1600);
eq('map.h (полная)', m2.h, 1200);
// живая карта = полная (масштаб по числу игроков выключен: MAP_SCALE_BY_PLAYERS пустой)
const live2 = generateMap(7, 2), live4 = generateMap(7, 4);
eq('живая карта двоих — полная', [live2.w, live2.h, live2.scale], [1600, 1200, 1]);
eq('живая карта четверых — полная', [live4.w, live4.h, live4.scale], [1600, 1200, 1]);
eq('живая карта совпадает с эталоном', JSON.stringify(live2), JSON.stringify(m2));
// ручка масштаба для стенда: карта и зазоры ужимаются, острова и рыба всё равно помещаются
const small = generateMap(7, 2, { mapScale: 0.625 });
eq('явный mapScale уважается', [small.w, small.h, small.scale], [1000, 750, 0.625]);
eq('на малой карте острова помещаются (2и)', small.lootIslands.length, 5);
eq('на малой карте рыба на месте (2и)', small.fishZones.length, 3);
eq('bases для 2', m2.bases.length, 2);
eq('bases для 4', m4.bases.length, 4);
eq('base.radius', m2.bases[0].radius, 105);
eq('lootCount = n+3 (2и)', m2.lootIslands.length, 5);
eq('lootCount = n+3 (4и)', m4.lootIslands.length, 7);
eq('fishCount', m2.fishZones.length, 3);
// у каждой зоны есть cap, согласованный с радиусом (4 или 5)
eq('у зон есть cap по радиусу', m4.fishZones.every(z => z.cap === fishZoneCap(z.radius)), true);
eq('cap только 4 или 5', m4.fishZones.every(z => z.cap === 4 || z.cap === 5), true);
// клад: кратен 10, в диапазоне 100..300
const loots = m4.lootIslands.map(i => i.loot);
eq('лут кратен 10', loots.every(l => l % 10 === 0), true);
eq('лут в [100,300]', loots.every(l => l >= 100 && l <= 300), true);
// детерминизм по сиду
eq('детерминизм карты', JSON.stringify(generateMap(7, 3)), JSON.stringify(generateMap(7, 3)));
// ЭТАЛОН координат (seed 7, 2и) — ловит сдвиг ЛЮБОЙ map-gen-константы при выносе в config
// углы раздаются игрокам случайно (тасовка + зеркало ПОСЛЕ генерации): для сида 7 хост в правом нижнем
const frozen = { bases: [[1401,994,105],[185,187,105]],
  loot: [[540,497,31,120],[669,271,41,300],[1055,244,40,100],[973,956,41,270],[844,584,33,180]],
  fish: [[1038,489,105],[454,762,110],[877,772,105]] };
eq('эталон баз', m2.bases.map(b => [b.x, b.y, b.radius]), frozen.bases);
eq('эталон лута', m2.lootIslands.map(i => [i.x, i.y, i.radius, i.loot]), frozen.loot);
eq('эталон рыбных зон', m2.fishZones.map(z => [z.x, z.y, z.radius]), frozen.fish);
// раздача углов: хост (idx 0) бывает в каждом из четырёх углов, у двоих базы всегда по диагонали,
// playerIdx после тасовки совпадает с индексом в массиве
const cornerOf = (m, b) => (b.x < m.w / 2 ? 'L' : 'R') + (b.y < m.h / 2 ? 'T' : 'B');
const hostCorners = new Set(), hostCorners4 = new Set();
let diag = 0, idxOk = true;
for (let seed = 1; seed <= 120; seed++) {
  const a = generateMap(seed, 2, { mapScale: 1 }), b4 = generateMap(seed, 4, { mapScale: 1 });
  hostCorners.add(cornerOf(a, a.bases[0])); hostCorners4.add(cornerOf(b4, b4.bases[0]));
  const [p, q] = a.bases;
  if ((p.x < a.w / 2) !== (q.x < a.w / 2) && (p.y < a.h / 2) !== (q.y < a.h / 2)) diag++;
  if (!b4.bases.every((b, i) => b.playerIdx === i)) idxOk = false;
}
eq('хост у двоих бывает во всех 4 углах', hostCorners.size, 4);
eq('хост у четверых бывает во всех 4 углах', hostCorners4.size, 4);
eq('у двоих базы всегда по диагонали', diag, 120);
eq('playerIdx = индекс после тасовки', idxOk, true);
const fixed = generateMap(7, 2, { mapScale: 1, fixedCorners: true });
eq('fixedCorners: p0 слева сверху, p1 справа снизу (как раньше)', fixed.bases.map(b => [b.x, b.y]), [[185, 187], [1401, 994]]);

console.log(`\nИтого config-снапшот: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
