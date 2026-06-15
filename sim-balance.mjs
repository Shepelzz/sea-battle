// Эксперимент: лечит ли преимущество 1-го хода стартовая компенсация золотом
// поздним игрокам? Гоняем дуэли с разным бонусом 2-му игроку.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { chooseBotAction } from './server/bot.js';

function duel(level, seatBonus) {
  const game = createGame('s', { maxPlayers: 2, turnTimer: 0 });
  for (let i = 0; i < 2; i++) {
    addPlayer(game, 'b' + i, 'B' + i);
    game.players[i].isBot = true;
    game.players[i].botLevel = level;
  }
  startGame(game, 'b0');
  for (let i = 0; i < 2; i++) game.players[i].gold += seatBonus[i] || 0;
  let g = 0;
  while (game.status === 'active' && g < 1500) {
    g++;
    const idx = game.turn.idx;
    let a; try { a = chooseBotAction(game, idx, level); } catch { a = { type: 'skip' }; }
    const r = applyAction(game, game.players[idx].id, a);
    if (!r.ok) applyAction(game, game.players[idx].id, { type: 'skip' });
  }
  return game.winner;
}

function trial(level, bonus, n) {
  let s0 = 0, fin = 0;
  for (let i = 0; i < n; i++) {
    const w = duel(level, [0, bonus]);
    if (w != null) { fin++; if (w === 0) s0++; }
  }
  return (s0 / fin * 100).toFixed(0);
}

console.log('Преимущество 1-го хода при компенсации золотом 2-му игроку (% побед 1-го):');
for (const level of ['mid', 'hard']) {
  const line = [0, 50, 100, 150, 200].map(b => `+${b}з: ${trial(level, b, 200)}%`).join('  |  ');
  console.log(`  ${level}:  ${line}`);
}

// Альтернатива: что если 2-й игрок получает лишний корабль (бриг) на старте?
import { SHIP_TYPES } from './server/ships.js';
function duelExtraShip(level) {
  const game = createGame('s', { maxPlayers: 2, turnTimer: 0 });
  for (let i = 0; i < 2; i++) {
    addPlayer(game, 'b' + i, 'B' + i);
    game.players[i].isBot = true; game.players[i].botLevel = level;
  }
  startGame(game, 'b0');
  // 2-му даём бриг рядом с базой
  const base = game.map.bases[1];
  game.ships.push({ id: 'extra', owner: 1, type: 'brig', x: base.x + 60, y: base.y, hp: SHIP_TYPES.brig.hp });
  let g = 0;
  while (game.status === 'active' && g < 1500) {
    g++; const idx = game.turn.idx;
    let a; try { a = chooseBotAction(game, idx, level); } catch { a = { type: 'skip' }; }
    const r = applyAction(game, game.players[idx].id, a);
    if (!r.ok) applyAction(game, game.players[idx].id, { type: 'skip' });
  }
  return game.winner;
}
let s0 = 0, fin = 0;
for (let i = 0; i < 200; i++) { const w = duelExtraShip('hard'); if (w != null) { fin++; if (w === 0) s0++; } }
console.log(`\n2-й игрок +бриг на старте (hard): 1й побеждает ${(s0 / fin * 100).toFixed(0)}%`);
