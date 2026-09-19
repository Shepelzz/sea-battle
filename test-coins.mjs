// 🪙 ВТОРАЯ ВАЛЮТА: монеты за потопленных пиратов.
//
// Правило простое — за обычного пирата одна монета, за 👑-босса две, тратить пока не на что.
// Тест держит четыре вещи, на которых такая фича обычно и ломается:
//   • монеты капают ТОЛЬКО с пиратов (за корабль игрока или базу — ни одной);
//   • кошелёк приватен ровно как золото: соперник видит null, а не число;
//   • партии, сохранённые ДО ввода валюты (нет поля coins), не падают и считаются с нуля;
//   • монеты не притворяются золотом и не лезут в статистику матча / лидерборд.
import {
  createGame, addPlayer, startGame, applyAction, publicState, applyOutpostPerks, forceFinish
} from './server/game.js';
import { SHIP_TYPES, PIRATE, PIRATE_COINS, PIRATE_BOSS_COINS, pirateCoins, OUTPOST_LEVELS } from './server/config.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const eq = (n, g, w) => { g === w ? ok++ : (fail++, console.error('✗', n, '— получили', JSON.stringify(g), 'ждали', JSON.stringify(w))); };

function game(nPlayers = 2, cfg = {}) {
  const g = createGame('t', { maxPlayers: nPlayers, turnTimer: 0, seed: 7 });
  Object.assign(g.config, cfg);
  for (let i = 0; i < nPlayers; i++) addPlayer(g, 'p' + i, 'P' + i);
  startGame(g, 'p0');
  banish(g);
  return g;
}
// детерминизм: штатных пиратов — в угол и «вечными», чтобы они не лезли в сцену
const banish = g => { for (const p of g.ships.filter(s => s.owner === -1)) { p.x = 20; p.y = 20; p.bornTurn = 1e9; } };
const put = (g, owner, type, x, y, hp) => {
  const s = { id: `${owner}_${type}_${g.ships.length}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp, heading: 0 };
  g.ships.push(s); return s;
};
const pirate = (g, x, y, { boss = false, hp = 1 } = {}) => {
  const p = { id: 'PIR' + g.ships.length, owner: -1, type: 'pirate', x, y, hp,
    maxHp: boss ? 220 : PIRATE.hp, boss, bounty: 200, heading: 0, angryAt: null, turnSlot: 99, bornTurn: 1e9 };
  g.ships.push(p); return p;
};
// выстрел мортирой в упор: фрегат добивает цель с 1 HP
const mortar = (g, pid, ship, target) =>
  applyAction(g, pid, { type: 'attack', shipId: ship.id, targetType: 'ship', targetId: target.id });

// ═══ константы ═══
eq('за обычного пирата — 1', PIRATE_COINS, 1);
eq('за босса — 2', PIRATE_BOSS_COINS, 2);
eq('pirateCoins(false)', pirateCoins(false), PIRATE_COINS);
eq('pirateCoins(true)', pirateCoins(true), PIRATE_BOSS_COINS);
yes('за босса строго больше', PIRATE_BOSS_COINS > PIRATE_COINS);

// ═══ старт: кошелёк пуст ═══
{
  const g = game();
  eq('новый игрок начинает с нуля монет', g.players[0].coins, 0);
  eq('и второй тоже', g.players[1].coins, 0);
}

// ═══ обычный пират → +1 ═══
{
  const g = game();
  const f = put(g, 0, 'fregat', 500, 500);
  const p = pirate(g, 560, 500);
  const goldBefore = g.players[0].gold;
  const r = mortar(g, 'p0', f, p);
  yes('выстрел прошёл', r.ok);
  yes('пират потоплен', !g.ships.some(s => s.id === p.id));
  eq('обычный пират дал 1 монету', g.players[0].coins, 1);
  eq('награда золотом тоже начислена', g.players[0].gold, goldBefore + 200);
}

// ═══ босс → +2 ═══
{
  const g = game();
  const f = put(g, 0, 'fregat', 500, 500);
  const b = pirate(g, 560, 500, { boss: true });
  mortar(g, 'p0', f, b);
  yes('босс потоплен', !g.ships.some(s => s.id === b.id));
  eq('босс дал 2 монеты', g.players[0].coins, 2);
}

// ═══ копятся ═══
{
  const g = game();
  const f = put(g, 0, 'fregat', 500, 500);
  g.config.multiMove = true;                      // три действия за ход — топим подряд
  mortar(g, 'p0', f, pirate(g, 560, 500));
  g.turn.actedShips = []; g.turn.moves = 0;       // тому же кораблю — ещё выстрел (ручной сброс)
  mortar(g, 'p0', f, pirate(g, 560, 520, { boss: true }));
  g.turn.actedShips = []; g.turn.moves = 0;
  mortar(g, 'p0', f, pirate(g, 560, 540));
  eq('1 + 2 + 1 = 4 монеты', g.players[0].coins, 4);
}

// ═══ ТОЛЬКО пираты: за чужой корабль и за базу монет нет ═══
{
  const g = game();
  const f = put(g, 0, 'fregat', 500, 500);
  const foe = put(g, 1, 'shkhuna', 560, 500, 1);
  mortar(g, 'p0', f, foe);
  yes('вражеский корабль потоплен', !g.ships.some(s => s.id === foe.id));
  eq('за корабль игрока монет нет', g.players[0].coins, 0);
}
{
  const g = game();
  g.players[1].portHp = 1;
  const base = g.map.bases[1];
  const l = put(g, 0, 'linkor', base.x - 150, base.y);
  applyAction(g, 'p0', { type: 'attack', shipId: l.id, targetType: 'port', targetId: 1 });
  yes('соперник выбит', !g.players[1].alive);
  eq('за разбитую базу монет нет', g.players[0].coins, 0);
}

// ═══ пират топит МОЙ корабль — никому ничего, и не падаем ═══
{
  const g = game();
  const victim = put(g, 0, 'barkas', 500, 500, 1);
  const pir = pirate(g, 520, 500, { hp: PIRATE.hp });
  pir.turnSlot = 0; pir.bornTurn = 0;              // вернём его в игру: пусть ходит после p0
  applyAction(g, 'p0', { type: 'skip' });          // → advanceTurn → movePirates → пират стреляет
  yes('баркас потоплен пиратом', !g.ships.some(s => s.id === victim.id));
  eq('у игрока монет не прибавилось', g.players[0].coins, 0);
  eq('и у соперника тоже', g.players[1].coins, 0);
}

// ═══ пушка форта тоже платит монетами (другой путь до sinkShip) ═══
{
  const g = game();
  const isl = g.map.lootIslands[0];
  isl.looted = true;
  isl.outpost = { owner: 0, level: 3, hp: OUTPOST_LEVELS[2].hp };
  const p = pirate(g, isl.x + 40, isl.y, { hp: 1 });
  applyOutpostPerks(g, 0);
  yes('форт добил пирата', !g.ships.some(s => s.id === p.id));
  eq('за пирата от пушки форта — монета', g.players[0].coins, 1);
}

// ═══ приватность: чужой кошелёк не виден ═══
{
  const g = game();
  const f = put(g, 0, 'fregat', 500, 500);
  mortar(g, 'p0', f, pirate(g, 560, 500, { boss: true }));
  const mine = publicState(g, 'p0').players;
  const theirs = publicState(g, 'p1').players;
  eq('свои монеты вижу', mine[0].coins, 2);
  eq('чужие монеты скрыты', theirs[0].coins, null);
  eq('чужое золото скрыто так же', theirs[0].gold, null);
  eq('свои монеты соперника — его собственные', theirs[1].coins, 0);
}
{ // хотсит и финал раскрывают всё — как и золото
  const g = game();
  g.config.hotseat = true;
  g.players[0].coins = 5;
  eq('хотсит: монеты видны всем за устройством', publicState(g, 'p1').players[0].coins, 5);
}
{
  const g = game();
  g.players[0].coins = 7;
  forceFinish(g);
  eq('после финала монеты раскрыты', publicState(g, 'p1').players[0].coins, 7);
}

// ═══ старые сейвы: поля coins нет ═══
{
  const g = game();
  delete g.players[0].coins;                      // партия, сохранённая до ввода валюты
  eq('старый сейв: в стейте 0, а не null/undefined', publicState(g, 'p0').players[0].coins, 0);
  const f = put(g, 0, 'fregat', 500, 500);
  mortar(g, 'p0', f, pirate(g, 560, 500));
  eq('старый сейв: после первого пирата ровно 1', g.players[0].coins, 1);
}

// ═══ монеты — не статистика и не золото ═══
{
  const g = game();
  const f = put(g, 0, 'fregat', 500, 500);
  const goldBefore = g.players[0].gold;
  mortar(g, 'p0', f, pirate(g, 560, 500, { boss: true }));
  const st = g.players[0].stats;
  yes('в stats монет нет', !('coins' in st));
  eq('золото выросло ровно на награду', g.players[0].gold, goldBefore + 200);
  yes('потопление засчиталось в статистику', st.shipsSunk === 1 && st.npcSunk === 1);
}

// ═══ журнал сообщает про монеты ═══
{
  const g = game();
  const f = put(g, 0, 'fregat', 500, 500);
  mortar(g, 'p0', f, pirate(g, 560, 500, { boss: true }));
  const row = publicState(g, 'p0').log.find(l => l.k === 'log.pirateSunk');
  yes('запись о потоплении пирата есть', !!row);
  eq('в записи столько же монет, сколько начислили', row?.p?.coins, 2);
  eq('и золото на месте', row?.p?.gold, 200);
}
{ // под туманом — абстрактная запись без цифр (экономику не палим)
  const g = game(2, { fog: true });
  const f = put(g, 0, 'fregat', 500, 500);
  mortar(g, 'p0', f, pirate(g, 560, 500));
  const log = publicState(g, 'p0').log;
  yes('под туманом — запись без чисел', log.some(l => l.k === 'log.pirateSunkFog'));
  yes('и подробной записи нет', !log.some(l => l.k === 'log.pirateSunk'));
}

// ═══ дуэль: пираты есть, значит и монеты ═══
{
  const g = createGame('d', { maxPlayers: 2, turnTimer: 0, seed: 7 });
  g.config.mode = 'duel';
  addPlayer(g, 'p0', 'A'); addPlayer(g, 'p1', 'B');
  startGame(g, 'p0');
  banish(g);
  g.phase = 'battle';
  g.turn = { idx: 0, number: 1, round: 1, deadline: null, moves: 0, actedShips: [], broadsideSides: {} };
  const f = put(g, 0, 'fregat', 300, 300);
  mortar(g, 'p0', f, pirate(g, 360, 300));
  eq('в дуэли монета за пирата тоже капает', g.players[0].coins, 1);
}

console.log(fail ? `\n❌ test-coins: провалено ${fail}, прошло ${ok}` : `\n✅ test-coins: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
