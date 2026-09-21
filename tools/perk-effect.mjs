// Влияют ли перки на ход партии — ПАРНЫМ замером.
//
// Одиночные прогоны тут бесполезны: одна и та же конфигурация без перков давала медиану то 318,
// то 506 ходов. Поэтому карта задаётся зерном, Math.random подменяется детерминированным
// генератором с тем же зерном, и одно зерно гоняется дважды — с перками и без. Разница по каждой
// паре, а не средние двух облаков.
import { createGame, addPlayer, startGame, applyAction } from '../server/game.js';
import { chooseBotAction } from '../server/bot.js';

const CAP = 1500;
const mulberry32 = (a) => () => {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const real = Math.random;

function sim(seed, perksOn, nPlayers, level) {
  Math.random = mulberry32(seed);
  process.env.BOT_PERKS = perksOn ? '1' : '0';
  const g = createGame('s', { maxPlayers: nPlayers, turnTimer: 0, seed });
  g.config.mode = 'classic'; g.config.multiMove = true;
  for (let i = 0; i < nPlayers; i++) { addPlayer(g, 'b' + i, 'B' + i); g.players[i].isBot = true; g.players[i].botLevel = level; }
  startGame(g, 'b0');
  let guard = 0, repairs = 0;
  while (g.status === 'active' && guard++ < CAP) {
    const cur = g.players[g.turn.idx];
    let a; try { a = chooseBotAction(g, g.turn.idx, cur.botLevel); } catch { a = { type: 'skip' }; }
    if (a?.type === 'buyPerk' && a.key === 'portRepair') repairs++;
    if (!applyAction(g, cur.id, a).ok) applyAction(g, cur.id, { type: 'skip' });
  }
  Math.random = real;
  const perks = {};
  for (const p of g.players) for (const k in (p.perks || {})) perks[k] = (perks[k] || 0) + 1;
  return { turns: g.turn.number, coins: g.players.reduce((s, p) => s + (p.coins || 0), 0), perks, repairs };
}

const N = +(process.argv[2] || 25);
const med = a => { const x = [...a].sort((p, q) => p - q); return x[Math.floor(x.length / 2)]; };
console.log(`парный замер, ${N} зёрен\n`);
for (const [label, n, lvl] of [['1×1, Боцман', 2, 'mid'], ['1×1, Адмирал', 2, 'hard'], ['вчетвером, Боцман', 4, 'mid']]) {
  const seeds = Array.from({ length: N }, (_, i) => 1000 + i * 7);
  const off = seeds.map(s => sim(s, false, n, lvl));
  const on = seeds.map(s => sim(s, true, n, lvl));
  const diffs = on.map((r, i) => r.turns - off[i].turns);
  const taken = {}; let repairs = 0;
  for (const r of on) { repairs += r.repairs; for (const k in r.perks) taken[k] = (taken[k] || 0) + r.perks[k]; }
  console.log(`── ${label}`);
  console.log(`   ходов: без перков ${med(off.map(r => r.turns))}, с перками ${med(on.map(r => r.turns))} · сдвиг по парам ${med(diffs) >= 0 ? '+' : ''}${med(diffs)}`);
  console.log(`   партий длиннее ${diffs.filter(d => d > 0).length}, короче ${diffs.filter(d => d < 0).length}, без изменений ${diffs.filter(d => d === 0).length}`);
  console.log(`   монет за партию: ${(med(off.map(r => r.coins)))} → ${(med(on.map(r => r.coins)))} (остаток на руках)`);
  console.log('   куплено: ' + (Object.keys(taken).length ? Object.entries(taken).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k} ${c}`).join(' · ') : '— ничего —') + ` · ремонтов порта ${repairs}`);
  console.log();
}
