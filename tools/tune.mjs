// 🎛 Подбор темпа партии: гоняет бот-против-бота с разными SB_TUNE и печатает, за сколько
// РАУНДОВ партия сходится. Раунд = полный круг ходов (game.turn.round), а не действие —
// sim.mjs считает действия, и их в раунде до трёх на игрока, цифры несравнимы.
//
//   node tools/tune.mjs                       # сетка по умолчанию
//   node tools/tune.mjs 40 '{"DMG_MULT":2}' '{"DMG_MULT":2,"PORT_HP":400}'   # свои варианты
//
// Каждый вариант — отдельный процесс: константы читаются один раз при загрузке config.js.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// ─── рабочий процесс: N партий на текущем SB_TUNE → JSON в stdout ───
if (process.argv[2] === '--worker') {
  const { createGame, addPlayer, startGame, applyAction } = await import('../server/game.js');
  const { chooseBotAction } = await import('../server/bot.js');
  const { PORT_HP } = await import('../server/config.js');
  const N = +process.argv[3] || 40, level = process.argv[4] || 'hard', players = +process.argv[5] || 2;
  const CAP = 6000;
  const rows = [];
  for (let i = 0; i < N; i++) {
    const g = createGame('tune', { maxPlayers: players, turnTimer: 0 });
    for (let k = 0; k < players; k++) { addPlayer(g, 'b' + k, 'B' + k); g.players[k].isBot = true; g.players[k].botLevel = level; }
    startGame(g, 'b0');
    let guard = 0, firstDamage = null, firstSunk = null, portHit = null, buys = 0;
    while (g.status === 'active' && guard++ < CAP) {
      const idx = g.turn.idx;
      let a; try { a = chooseBotAction(g, idx, level); } catch { a = { type: 'skip' }; }
      if (a.type === 'buy') buys += (a.ships || []).length;
      if (!applyAction(g, g.players[idx].id, a).ok) applyAction(g, g.players[idx].id, { type: 'skip' });
      if (portHit === null && g.players.some(p => p.portHp < PORT_HP)) portHit = g.turn.round;
      // сырые статы: у бота ВСЁ считается «по НПС» (npc* = damageDealt), вычитать нечего
      if (firstDamage === null && g.players.some(p => p.stats.damageDealt > 0)) firstDamage = g.turn.round;
      if (firstSunk === null && g.players.some(p => p.stats.shipsSunk > 0)) firstSunk = g.turn.round;
    }
    rows.push({ rounds: g.turn.round, done: g.status === 'finished', firstDamage, firstSunk, portHit, buys,
      gold: g.players.reduce((s, p) => s + p.stats.goldCollected, 0),
      sunk: g.players.reduce((s, p) => s + p.stats.shipsSunk, 0),
      winnerFleet: g.status === 'finished' ? g.ships.filter(s => s.owner === g.winner).length : null });
  }
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}

// ─── драйвер ───
let args = process.argv.slice(2);
// --level=mid --players=3 — сложность ботов и число мест (по умолчанию Адмирал, двое)
const opt = (name, def) => { const i = args.findIndex(a => a.startsWith('--' + name + '=')); if (i < 0) return def; const v = args[i].split('=')[1]; args.splice(i, 1); return v; };
const LEVEL = opt('level', 'hard'), PLAYERS = +opt('players', 2);
const N = /^\d+$/.test(args[0]) ? +args.shift() : 40;
const grid = args.length ? args : [
  '{}',
  '{"DMG_MULT":1.5}', '{"DMG_MULT":2}', '{"DMG_MULT":2.5}', '{"DMG_MULT":3}',
  '{"DMG_MULT":2,"PORT_HP":600}', '{"DMG_MULT":2,"PORT_HP":400}', '{"DMG_MULT":2,"PORT_HP":300}',
  '{"DMG_MULT":2.5,"PORT_HP":400}', '{"DMG_MULT":3,"PORT_HP":400}', '{"DMG_MULT":3,"PORT_HP":300}',
];
const worker = tune => new Promise((res, rej) => {
  const ch = spawn(process.execPath, [SELF, '--worker', String(N), LEVEL, String(PLAYERS)], { env: { ...process.env, SB_TUNE: tune } });
  let out = '', err = '';
  ch.stdout.on('data', d => out += d); ch.stderr.on('data', d => err += d);
  ch.on('close', c => c === 0 ? res(JSON.parse(out)) : rej(new Error(err || 'worker failed')));
});
const q = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const avg = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : NaN;

console.log(`🎛 ${N} партий на вариант, классика, ${PLAYERS} игрока, боты ${LEVEL}. Цель: 25–35 раундов.\n`);
console.log('вариант'.padEnd(34) + 'средн  медиана  p10–p90   пат   1-й урон  1-е потопл.  потоплено  флот побед.  порт бит  осада  покупок  золота');
const results = await Promise.all(grid.map(worker));
results.forEach((rows, i) => {
  const r = rows.map(x => x.rounds);
  const line = grid[i].padEnd(34)
    + String(avg(r).toFixed(0)).padStart(5) + String(q(r, .5)).padStart(9)
    + `  ${q(r, .1)}–${q(r, .9)}`.padEnd(10)
    + String(rows.filter(x => !x.done).length).padStart(5)
    + String(avg(rows.map(x => x.firstDamage).filter(Boolean)).toFixed(0)).padStart(10)
    + String(avg(rows.map(x => x.firstSunk).filter(Boolean)).toFixed(0)).padStart(13)
    + String(avg(rows.map(x => x.sunk)).toFixed(1)).padStart(11)
    + String(avg(rows.map(x => x.winnerFleet).filter(x => x != null)).toFixed(1)).padStart(13)
    + String(avg(rows.map(x => x.portHit).filter(Boolean)).toFixed(0)).padStart(10)
    + String(avg(rows.filter(x => x.portHit).map(x => x.rounds - x.portHit)).toFixed(0)).padStart(7)
    + String(avg(rows.map(x => x.buys)).toFixed(1)).padStart(9)
    + String(avg(rows.map(x => x.gold)).toFixed(0)).padStart(8);
  console.log(line);
});
