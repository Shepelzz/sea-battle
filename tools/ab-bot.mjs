// ⚖️ A/B-СТЕНД ДЛЯ ЭВРИСТИКИ: текущий bot.js против его версии из git.
//
// Любая правка бота может сделать его СЛАБЕЕ — это уже случалось (щедрая стройка аванпостов
// дала 3 победы против 9). Поэтому каждое изменение меряем, а не обсуждаем.
//
//   node tools/ab-bot.mjs                      # 30 партий против версии из HEAD
//   node tools/ab-bot.mjs --games=60           # длиннее прогон — меньше шума
//   node tools/ab-bot.mjs --ref=HEAD~3         # сравнить с другой версией
//   node tools/ab-bot.mjs --level=mid          # уровень обоих ботов
//   BOT_RISK_W=12 node tools/ab-bot.mjs        # подбор веса-константы
//
// Стороны чередуются по семенам: преимущество первого хода не должно решать исход.
// Партия, упершаяся в лимит ходов, доигрывается forceFinish (победа по силе флота).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createGame, addPlayer, startGame, applyAction, forceFinish } from '../server/game.js';
import { chooseBotAction as NEW } from '../server/bot.js';
import { movesBudget } from '../server/config.js';

const arg = (n, d) => {
  const hit = process.argv.find(a => a.startsWith(`--${n}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const GAMES = +arg('games', 30);
const REF = arg('ref', 'HEAD');
const LEVEL = arg('level', 'hard');
const GUARD = +arg('maxTurns', 900);
const PLAYERS = +arg('players', 2);   // на троих-четверых видно то, чего не видно в дуэли: смену жертвы

// старую версию кладём рядом (иначе относительные импорты внутри неё не найдутся) и убираем за собой
const refFile = path.join('server', `bot-ref-${process.pid}.js`);
fs.writeFileSync(refFile, execFileSync('git', ['show', `${REF}:server/bot.js`], { encoding: 'utf8' }));
let OLD;
try {
  ({ chooseBotAction: OLD } = await import('../' + refFile.replace(/\\/g, '/')));
} finally {
  fs.rmSync(refFile, { force: true });
}

// ПАРНЫЕ ПАРТИИ: каждое семя играется ДВАЖДЫ — один раз новая версия ходит первой, второй раз
// второй. Так преимущество первого хода и удачная карта достаются обеим версиям поровну, и шум
// падает вдвое. Без этого на 30 партиях разброс достигал ±16 побед — то есть «замер» показывал
// что угодно.
const stat = { neu: 0, old: 0, draw: 0, rounds: 0, capped: 0, outNew: 0, outOld: 0, goldNew: 0, goldOld: 0 };
const PAIRS = GAMES;
for (let n = 0; n < PAIRS * 2; n++) {
  const seed = 1 + (n >> 1);
  const g = createGame('ab' + n, { maxPlayers: PLAYERS, turnTimer: 0, seed });
  g.config.fog = true; g.config.multiMove = true; g.config.botGame = true;
  // при 2 игроках чередуем порядок; при 3+ новая версия садится на разные места по кругу
  const newIdx = PLAYERS === 2 ? n % 2 : n % PLAYERS;
  for (let i = 0; i < PLAYERS; i++) addPlayer(g, 'p' + i, 'P' + i);
  g.players.forEach(p => { p.isBot = true; p.botLevel = LEVEL; });
  startGame(g, 'p0');

  let guard = 0;
  while (g.status === 'active' && guard++ < GUARD) {
    const i = g.turn.idx, pick = (i === newIdx) ? NEW : OLD;
    let moves = 0;
    while (g.status === 'active' && g.turn.idx === i && moves++ <= movesBudget(g.config)) {
      let a; try { a = pick(g, i, LEVEL); } catch { a = { type: 'skip' }; }
      if (!applyAction(g, 'p' + i, a).ok) applyAction(g, 'p' + i, { type: 'skip' });
    }
  }
  if (g.status === 'active') { forceFinish(g); stat.capped++; }

  const win = g.players.findIndex(p => p.placement === 1);
  if (win === newIdx) stat.neu++; else if (win >= 0) stat.old++; else stat.draw++;
  stat.rounds += g.turn.round;
  stat.goldNew += g.players[newIdx].stats.goldCollected;
  stat.goldOld += g.players.reduce((a, p, i) => i === newIdx ? a : a + p.stats.goldCollected, 0) / (PLAYERS - 1);
  stat.outNew += (g.map.lootIslands || []).filter(i => i.outpost?.owner === newIdx).length;
  stat.outOld += (g.map.lootIslands || []).filter(i => i.outpost && i.outpost.owner !== newIdx).length;
}

const GAMES_PLAYED = PAIRS * 2;
const pct = n => Math.round(n / GAMES_PLAYED * 100);
console.log(`⚖️ ${GAMES_PLAYED} партий (${PAIRS} семян × 2 порядка), ${PLAYERS} игрока(ов), уровень ${LEVEL}, эталон ${REF}` +
  (process.env.BOT_RISK_W ? ` · BOT_RISK_W=${process.env.BOT_RISK_W}` : ''));
console.log(`   новая:  ${stat.neu} побед (${pct(stat.neu)}%) · золота ${Math.round(stat.goldNew / GAMES_PLAYED)} · аванпостов ${stat.outNew}`);
console.log(`   старая: ${stat.old} побед (${pct(stat.old)}%) · золота ${Math.round(stat.goldOld / GAMES_PLAYED)} · аванпостов ${stat.outOld}`);
console.log(`   средняя длина ${Math.round(stat.rounds / GAMES_PLAYED)} раундов · ничьих ${stat.draw} · по лимиту ${stat.capped}`);
// Значимость: сравниваем долю побед новой версии с её «нейтральной» долей (1/игроков).
// На двоих нейтраль — 50%, на троих — 33%: при 3+ игроках одно место новой противостоят
// ДВА места старой, и прямое «побед больше/меньше» вводит в заблуждение.
const expected = GAMES_PLAYED / PLAYERS;
const edge = Math.round(stat.neu - expected);
const noise = Math.max(6, Math.sqrt(GAMES_PLAYED) * 2);
console.log(`   итог: ${edge > 0 ? '+' : ''}${edge} побед сверх нейтральных ${Math.round(expected)} — ` +
  (Math.abs(edge) < noise ? 'в пределах шума, нужен прогон длиннее'
    : edge > 0 ? 'новая сильнее' : 'новая СЛАБЕЕ, откатывать'));
