// Симулятор для анализа геймплея: гоняет бои бот-против-бота,
// собирает статистику и печатает сводку по балансу.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { chooseBotAction } from './server/bot.js';
import { SHIP_TYPES } from './server/ships.js';

const TURN_CAP = 1500; // защита от вечной партии (в advance-ходах)

function simulate(nPlayers, level, mode = 'classic') {
  const game = createGame('sim', { maxPlayers: nPlayers, turnTimer: 0 });
  game.config.mode = mode;
  for (let i = 0; i < nPlayers; i++) {
    addPlayer(game, 'b' + i, 'Bot' + i);
    game.players[i].isBot = true;
    game.players[i].botLevel = level;
  }
  startGame(game, 'b0');

  const m = {
    turns: 0, stalemate: false, winner: null,
    actions: { move: 0, attack: 0, buy: 0, collect: 0, skip: 0 },
    buys: {},                 // type -> count
    pirateKills: 0,
    firstBloodSeat: null, firstBloodWon: null,
    islandsTotal: game.map.lootIslands.length, islandsLooted: 0
  };

  let guard = 0;
  while (game.status === 'active' && guard < TURN_CAP) {
    guard++;
    const idx = game.turn.idx;
    const before = game.ships.length;
    const foeShipsBefore = game.ships.filter(s => s.owner >= 0 && s.owner !== idx).length;
    let action;
    try { action = chooseBotAction(game, idx, level); }
    catch { action = { type: 'skip' }; }

    m.actions[action.type] = (m.actions[action.type] || 0) + 1;
    if (action.type === 'buy') for (const t of action.ships) m.buys[t] = (m.buys[t] || 0) + 1;

    // отслеживаем убийство пирата
    if (action.type === 'attack' && action.targetType === 'ship') {
      const tgt = game.ships.find(s => s.id === action.targetId);
      if (tgt && tgt.owner === -1 && tgt.hp <= SHIP_TYPES[
        game.ships.find(s => s.id === action.shipId)?.type || 'shkhuna'].dmg) m.pirateKills++;
    }

    const r = applyAction(game, game.players[idx].id, action);
    if (!r.ok) applyAction(game, game.players[idx].id, { type: 'skip' });

    // первая кровь среди игроков (потоплен вражеский корабль)
    if (m.firstBloodSeat === null) {
      const foeShipsAfter = game.ships.filter(s => s.owner >= 0 && s.owner !== idx).length;
      if (foeShipsAfter < foeShipsBefore) m.firstBloodSeat = idx;
    }
  }

  m.turns = guard;
  m.stalemate = game.status !== 'finished';
  m.winner = game.winner;
  if (m.firstBloodSeat !== null) m.firstBloodWon = (m.firstBloodSeat === game.winner);
  m.islandsLooted = game.map.lootIslands.filter(i => i.looted).length;

  // финальные показатели по игрокам
  m.players = game.players.map((p, i) => ({
    seat: i, win: i === game.winner, gold: p.gold,
    goldCollected: p.stats.goldCollected, damage: p.stats.damageDealt,
    sunk: p.stats.shipsSunk, lost: p.stats.shipsLost,
    fleet: game.ships.filter(s => s.owner === i).length
  }));
  return m;
}

function run(label, n, nPlayers, level, mode = 'classic') {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(simulate(nPlayers, level, mode));
  const avg = f => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const sum = f => rows.reduce((s, r) => s + f(r), 0);

  const seatWins = Array(nPlayers).fill(0);
  rows.forEach(r => { if (r.winner != null) seatWins[r.winner]++; });

  const buys = {};
  rows.forEach(r => { for (const t in r.buys) buys[t] = (buys[t] || 0) + r.buys[t]; });
  const totalBuys = Object.values(buys).reduce((a, b) => a + b, 0) || 1;

  const acts = {};
  rows.forEach(r => { for (const a in r.actions) acts[a] = (acts[a] || 0) + r.actions[a]; });
  const totalActs = Object.values(acts).reduce((a, b) => a + b, 0) || 1;

  const fb = rows.filter(r => r.firstBloodSeat !== null);
  const fbWinRate = fb.length ? fb.filter(r => r.firstBloodWon).length / fb.length : 0;
  const stalemates = rows.filter(r => r.stalemate).length;

  console.log(`\n══════ ${label} (${n} игр, ${nPlayers}и, ${level}) ══════`);
  console.log(`длина партии: средн ${avg(r => r.turns).toFixed(0)} ходов, ` +
    `мин ${Math.min(...rows.map(r => r.turns))}, макс ${Math.max(...rows.map(r => r.turns))}`);
  console.log(`патовых (уперлись в лимит): ${stalemates} (${(stalemates / n * 100).toFixed(0)}%)`);
  console.log(`победы по местам (1й ходит=место0): [${seatWins.join(', ')}]  ` +
    `→ преимущество 1го хода: ${(seatWins[0] / n * 100).toFixed(0)}%`);
  console.log(`«первая кровь» → победа в ${(fbWinRate * 100).toFixed(0)}% случаев (снежный ком)`);
  console.log(`острова залутаны: ${avg(r => r.islandsLooted).toFixed(1)} из ${rows[0].islandsTotal}`);
  console.log(`убийств пиратов за партию: ${avg(r => r.pirateKills).toFixed(1)}`);
  console.log('действия ботов: ' + Object.entries(acts)
    .map(([a, c]) => `${a} ${(c / totalActs * 100).toFixed(0)}%`).join(', '));
  console.log('покупки кораблей: ' + (Object.keys(buys).length
    ? Object.entries(buys).sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${SHIP_TYPES[t].name} ${(c / totalBuys * 100).toFixed(0)}%`).join(', ')
    : '— ничего не покупали —'));
  const winners = rows.flatMap(r => r.players.filter(p => p.win));
  const losers = rows.flatMap(r => r.players.filter(p => !p.win));
  const a = (arr, f) => arr.length ? arr.reduce((s, x) => s + f(x), 0) / arr.length : 0;
  console.log(`победитель: урон ${a(winners, p => p.damage).toFixed(0)}, потопил ${a(winners, p => p.sunk).toFixed(1)}, ` +
    `флот в конце ${a(winners, p => p.fleet).toFixed(1)}, золота собрал ${a(winners, p => p.goldCollected).toFixed(0)}`);
  console.log(`проигравший: урон ${a(losers, p => p.damage).toFixed(0)}, потопил ${a(losers, p => p.sunk).toFixed(1)}, ` +
    `золота собрал ${a(losers, p => p.goldCollected).toFixed(0)}`);
  return rows;
}

console.log('🎲 Симуляция геймплея «Морского боя»…');
run('Дуэль, Боцман', 300, 2, 'mid');
run('Дуэль, Адмирал', 200, 2, 'hard');
run('Дуэль, Юнга', 150, 2, 'easy');
run('Трое', 120, 3, 'mid');
run('Четверо', 120, 4, 'mid');
run('ДЕЗМАТЧ дуэль mid', 200, 2, 'mid', 'deathmatch');
run('ДЕЗМАТЧ дуэль hard', 150, 2, 'hard', 'deathmatch');
run('РАЗВИТИЕ дуэль mid', 200, 2, 'mid', 'develop');
run('РАЗВИТИЕ трое mid', 120, 3, 'mid', 'develop');
console.log('\n✅ готово');
