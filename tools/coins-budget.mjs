// Сколько монет реально набегает за партию — бюджет, от которого зависит ценник любого перка.
import { createGame, addPlayer, startGame, applyAction } from '../server/game.js';
import { chooseBotAction, duelFleetPlan } from '../server/bot.js';

const TURN_CAP = 1500;
function sim(nPlayers, level, mode) {
  const g = createGame('s', { maxPlayers: nPlayers, turnTimer: 0 });
  g.config.mode = mode;
  for (let i = 0; i < nPlayers; i++) {
    addPlayer(g, 'b' + i, 'B' + i);
    g.players[i].isBot = true; g.players[i].botLevel = level;
  }
  startGame(g, 'b0');
  if (g.phase === 'buy')
    for (let i = 0; i < nPlayers; i++)
      applyAction(g, g.players[i].id, { type: 'buyFleet', ships: duelFleetPlan(g, i, level) });
  let guard = 0;
  while (g.status === 'active' && guard++ < TURN_CAP) {
    const cur = g.players[g.turn.idx];
    let a; try { a = chooseBotAction(g, g.turn.idx, cur.botLevel); } catch { a = { type: 'skip' }; }
    if (!applyAction(g, cur.id, a).ok) applyAction(g, cur.id, { type: 'skip' });
  }
  const coins = g.players.map(p => p.coins || 0);
  const gold = g.players.map(p => p.stats.goldCollected);
  const win = g.players.findIndex(p => p.placement === 1);
  return { turns: g.turn.number, coins, gold, winCoins: coins[win] ?? 0, total: coins.reduce((a, b) => a + b, 0) };
}

const runs = [
  ['классика 1×1', 2, 'mid', 'classic'],
  ['классика 1×1 (Адмирал)', 2, 'hard', 'classic'],
  ['классика вчетвером', 4, 'mid', 'classic'],
  ['дезматч 1×1', 2, 'mid', 'deathmatch'],
  ['развитие 1×1', 2, 'mid', 'develop'],
  ['режим Дуэль', 2, 'mid', 'duel'],
];
const N = +(process.argv[2] || 40);
console.log(`🪙 бюджет монет, по ${N} партий на строку\n`);
console.log('режим'.padEnd(26) + 'ходов  всего🪙  у победителя  макс у игрока  🪙/100 ходов');
for (const [label, n, lvl, mode] of runs) {
  const rows = Array.from({ length: N }, () => sim(n, lvl, mode));
  const avg = f => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  const maxCoins = Math.max(...rows.flatMap(r => r.coins));
  console.log(label.padEnd(26) +
    avg(r => r.turns).toFixed(0).padStart(5) +
    avg(r => r.total).toFixed(1).padStart(8) +
    avg(r => r.winCoins).toFixed(1).padStart(14) +
    String(maxCoins).padStart(15) +
    (avg(r => r.total) / avg(r => r.turns) * 100).toFixed(1).padStart(14));
}
