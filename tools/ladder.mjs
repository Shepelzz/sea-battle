// 🪜 Лестница сложности: кто кого бьёт. Парные партии, стороны чередуются.
//   node tools/ladder.mjs            # текущая версия
//   node tools/ladder.mjs --ref=HEAD # версия из git (для сравнения «до/после»)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createGame, addPlayer, startGame, applyAction, forceFinish } from '../server/game.js';
import { movesBudget } from '../server/config.js';

const arg = (n, d) => { const h = process.argv.find(a => a.startsWith(`--${n}=`)); return h ? h.split('=')[1] : d; };
const PAIRS = +arg('pairs', 30);
const REF = arg('ref', null);

let pick;
if (REF) {
  const f = `server/bot-ladder-${process.pid}.js`;
  fs.writeFileSync(f, execFileSync('git', ['show', `${REF}:server/bot.js`], { encoding: 'utf8' }));
  try { ({ chooseBotAction: pick } = await import('../' + f)); } finally { fs.rmSync(f, { force: true }); }
} else {
  ({ chooseBotAction: pick } = await import('../server/bot.js'));
}

const duel = (A, B) => {
  let aw = 0, bw = 0;
  for (let n = 0; n < PAIRS * 2; n++) {
    const g = createGame('l' + n, { maxPlayers: 2, turnTimer: 0, seed: 1 + (n >> 1) });
    g.config.fog = true; g.config.multiMove = true; g.config.botGame = true;
    const aIdx = n % 2;
    addPlayer(g, 'p0', 'P0'); addPlayer(g, 'p1', 'P1');
    g.players.forEach((p, i) => { p.isBot = true; p.botLevel = i === aIdx ? A : B; });
    startGame(g, 'p0');
    let guard = 0;
    while (g.status === 'active' && guard++ < 900) {
      const i = g.turn.idx, lvl = i === aIdx ? A : B;
      let m = 0;
      while (g.status === 'active' && g.turn.idx === i && m++ <= movesBudget(g.config)) {
        let a; try { a = pick(g, i, lvl); } catch { a = { type: 'skip' }; }
        if (!applyAction(g, 'p' + i, a).ok) applyAction(g, 'p' + i, { type: 'skip' });
      }
    }
    if (g.status === 'active') forceFinish(g);
    const w = g.players.findIndex(p => p.placement === 1);
    if (w === aIdx) aw++; else if (w >= 0) bw++;
  }
  const pct = Math.round(aw / Math.max(1, aw + bw) * 100);
  console.log(`  ${A.padEnd(5)} против ${B.padEnd(5)}: ${String(aw).padStart(3)} — ${String(bw).padStart(3)}  (${pct}% у ${A})`);
};
console.log(`🪜 Лестница${REF ? ' (' + REF + ')' : ''}, ${PAIRS * 2} партий на пару:`);
duel('hard', 'mid'); duel('mid', 'easy'); duel('hard', 'easy');
