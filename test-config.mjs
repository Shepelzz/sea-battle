// СНАПШОТ-ТЕСТ конфигурации: фиксирует ТОЧНЫЕ текущие значения всех игровых констант
// и ключевые выходы генератора карты. Цель — чтобы вынос констант в config.js не сдвинул
// ни одной цифры. Если правишь баланс намеренно — обнови ожидания здесь же.
import {
  SHIP_TYPES, START_FLEET, START_GOLD, PORT_HP, PORT_RETURN_DMG, PORT_INCOME,
  PORT_DMG_TO_SHIPS, SHIP_COLLISION_DIST, LOOT_REACH, BROADSIDE_MULT, FISH_ZONE_CAP,
  PIRATE, PIRATE_DESPAWN_CHANCE, PIRATE_SPAWN_CHANCE, PIRATE_MOVE_CHANCE,
  PIRATE_BOSS_CHANCE, PIRATE_BOSS_HP, PIRATE_REVENGE_SHOT, PIRATE_FLEE_CHANCE, PIRATE_CALM_CHANCE
} from './server/ships.js';
import { generateMap } from './server/mapgen.js';

let ok = 0, fail = 0;
const eq = (n, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  pass ? (ok++) : (fail++, console.error(`✗ ${n}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};

// === Флот: каждое поле каждого класса ===
const FLEET = {
  barkas:  { name: 'Рыбацкий баркас', price: 60,  hp: 30,  dmg: 5,  fireRange: 70,  move: 140, fishing: 4, broadside: undefined, portBonus: undefined },
  shkhuna: { name: 'Шхуна',           price: 110, hp: 60,  dmg: 15, fireRange: 110, move: 170, fishing: 0, broadside: undefined, portBonus: undefined },
  brig:    { name: 'Бриг',            price: 220, hp: 110, dmg: 28, fireRange: 140, move: 135, fishing: 0, broadside: undefined, portBonus: undefined },
  fregat:  { name: 'Фрегат',          price: 380, hp: 170, dmg: 42, fireRange: 165, move: 110, fishing: 0, broadside: true,      portBonus: undefined },
  linkor:  { name: 'Линкор',          price: 500, hp: 280, dmg: 65, fireRange: 190, move: 90,  fishing: 0, broadside: true,      portBonus: 1.5 }
};
eq('набор классов', Object.keys(SHIP_TYPES).sort(), Object.keys(FLEET).sort());
for (const [type, want] of Object.entries(FLEET)) {
  const s = SHIP_TYPES[type] || {};
  for (const [k, v] of Object.entries(want)) eq(`${type}.${k}`, s[k], v);
}

// === Бой / экономика / порт ===
eq('BROADSIDE_MULT', BROADSIDE_MULT, 0.8);
eq('FISH_ZONE_CAP', FISH_ZONE_CAP, 4);
eq('START_FLEET', START_FLEET, ['shkhuna', 'shkhuna', 'fregat']);
eq('START_GOLD', START_GOLD, 250);
eq('PORT_HP', PORT_HP, 840);
eq('PORT_RETURN_DMG', PORT_RETURN_DMG, 15);
eq('PORT_INCOME', PORT_INCOME, 6);
eq('PORT_DMG_TO_SHIPS', PORT_DMG_TO_SHIPS, 0);
eq('SHIP_COLLISION_DIST', SHIP_COLLISION_DIST, 26);
eq('LOOT_REACH', LOOT_REACH, 55);

// === Пираты ===
eq('PIRATE.hp', PIRATE.hp, 80);
eq('PIRATE.dmg', PIRATE.dmg, 12);
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
const m2 = generateMap(7, 2), m4 = generateMap(7, 4);
eq('map.w', m2.w, 1600);
eq('map.h', m2.h, 1200);
eq('bases для 2', m2.bases.length, 2);
eq('bases для 4', m4.bases.length, 4);
eq('base.radius', m2.bases[0].radius, 105);
eq('lootCount = n+3 (2и)', m2.lootIslands.length, 5);
eq('lootCount = n+3 (4и)', m4.lootIslands.length, 7);
eq('fishCount', m2.fishZones.length, 3);
// клад: кратен 10, в диапазоне 100..300
const loots = m4.lootIslands.map(i => i.loot);
eq('лут кратен 10', loots.every(l => l % 10 === 0), true);
eq('лут в [100,300]', loots.every(l => l >= 100 && l <= 300), true);
// детерминизм по сиду
eq('детерминизм карты', JSON.stringify(generateMap(7, 3)), JSON.stringify(generateMap(7, 3)));
// ЭТАЛОН координат (seed 7, 2и) — ловит сдвиг ЛЮБОЙ map-gen-константы при выносе в config
const frozen = { bases: [[185,187,105],[1401,994,105]],
  loot: [[540,497,31,120],[669,271,41,300],[1055,244,40,100],[973,956,41,270],[844,584,33,180]],
  fish: [[1038,489,105],[454,762,110],[877,772,105]] };
eq('эталон баз', m2.bases.map(b => [b.x, b.y, b.radius]), frozen.bases);
eq('эталон лута', m2.lootIslands.map(i => [i.x, i.y, i.radius, i.loot]), frozen.loot);
eq('эталон рыбных зон', m2.fishZones.map(z => [z.x, z.y, z.radius]), frozen.fish);

console.log(`\nИтого config-снапшот: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
