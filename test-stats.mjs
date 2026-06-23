// Лидерборд считает бой ТОЛЬКО против живых людей: урон/потопления/добыча по НПС
// (пираты owner=-1 и игроки-боты) копятся в общих статах (для рекапа/сима), но в лидерборд НЕ идут.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { resultRows } from './server/db.js';
import { SHIP_TYPES } from './server/config.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const eq = (n, g, w) => { JSON.stringify(g) === JSON.stringify(w) ? ok++ : (fail++, console.error('✗', n, 'got', JSON.stringify(g), 'want', JSON.stringify(w))); };

function setup() {
  const g = createGame('t', { maxPlayers: 4, turnTimer: 0, seed: 4242 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб'); addPlayer(g, 'C', 'Бот');
  startGame(g, 'A');
  g.players[2].isBot = true;            // C — бот
  g.ships = []; g.map.lootIslands = [];
  return g;
}
const put = (g, owner, type, x, y, hp) =>
  (g.ships.push({ id: `${owner}_${type}_${x}_${y}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp, maxHp: SHIP_TYPES[type].hp }), g.ships.at(-1));
const attack = (g, me, foe) => applyAction(g, 'A', { type: 'attack', shipId: me.id, targetType: 'ship', targetId: foe.id });

// === урон по ЧЕЛОВЕКУ: идёт и в общий зачёт, и в лидерборд (npcDamage = 0) ===
{
  const g = setup();
  const r = attack(g, put(g, 0, 'fregat', 760, 600), put(g, 1, 'shkhuna', 820, 600));
  const s = g.players[0].stats;
  yes('атака по человеку ок', r.ok);
  yes('человек: damageDealt > 0', s.damageDealt > 0);
  eq('человек: npcDamage = 0 (в лидерборд идёт)', s.npcDamage, 0);
}

// === урон по БОТУ: в общий зачёт идёт, но весь помечен npc (из лидерборда вычтется) ===
{
  const g = setup();
  const r = attack(g, put(g, 0, 'fregat', 760, 600), put(g, 2, 'shkhuna', 820, 600));
  const s = g.players[0].stats;
  yes('атака по боту ок', r.ok);
  yes('бот: damageDealt > 0 (общий зачёт цел)', s.damageDealt > 0);
  eq('бот: npcDamage = damageDealt (весь урон вне лидерборда)', s.npcDamage, s.damageDealt);
}

// === урон по ПИРАТУ: тоже npc (вне лидерборда) ===
{
  const g = setup();
  const r = attack(g, put(g, 0, 'fregat', 760, 600), put(g, -1, 'shkhuna', 820, 600));
  const s = g.players[0].stats;
  yes('атака по пирату ок', r.ok);
  eq('пират: npcDamage = damageDealt', s.npcDamage, s.damageDealt);
}

// === потопление ПИРАТА: золото-валюта приходит, но потопление/добыча — вне лидерборда ===
{
  const g = setup();
  const goldBefore = g.players[0].gold;
  const pir = put(g, -1, 'shkhuna', 820, 600, 1); pir.bounty = 120;
  attack(g, put(g, 0, 'fregat', 760, 600), pir);
  const s = g.players[0].stats;
  yes('пират потоплен: shipsSunk учтён в общем', s.shipsSunk >= 1);
  eq('пират: npcSunk = shipsSunk (вне лидерборда)', s.npcSunk, s.shipsSunk);
  eq('пират: золото-валюта пришла (экономика цела)', g.players[0].gold, goldBefore + 120);
  eq('пират: npcGold = goldCollected (добыча вне лидерборда)', s.npcGold, s.goldCollected);
}

// === потопление ЧЕЛОВЕКА: засчитывается в лидерборд (npcSunk = 0) ===
{
  const g = setup();
  attack(g, put(g, 0, 'fregat', 760, 600), put(g, 1, 'shkhuna', 820, 600, 1));
  const s = g.players[0].stats;
  yes('человек потоплен: shipsSunk++', s.shipsSunk >= 1);
  eq('человек: npcSunk = 0 (идёт в лидерборд)', s.npcSunk, 0);
}

// === resultRows: строки лидерборда = totals − npc; бот строки не получает ===
{
  const g = setup();
  // полные статы (как накопились бы за матч): часть боя — по людям, часть — по НПС
  g.players[0].stats = { damageDealt: 100, shipsSunk: 3, shipsLost: 1, goldCollected: 50, shotsFired: 9, npcDamage: 40, npcSunk: 1, npcGold: 20 };
  g.players[0].placement = 1;
  const rows = resultRows(g);
  yes('бот строки в лидерборде НЕ получает', !rows.some(r => r[1] === 'C'));
  yes('люди A и B в лидерборде есть', rows.some(r => r[1] === 'A') && rows.some(r => r[1] === 'B'));
  const rowA = rows.find(r => r[1] === 'A'); // [game,id,placement,win,damage,sunk,lost,gold]
  eq('лидерборд урон = 100−40 (NPC вычтен)', rowA[4], 60);
  eq('лидерборд потоплено = 3−1', rowA[5], 2);
  eq('лидерборд золото = 50−20', rowA[7], 30);
  eq('лидерборд win = 1 (placement 1)', rowA[3], 1);
}

console.log(fail ? `\n❌ test-stats: провалено ${fail}, прошло ${ok}` : `\n✅ test-stats: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
