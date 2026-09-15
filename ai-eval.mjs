// 📊 ЭВАЛ ИИ-СОПЕРНИКА: гоняет партии ИИ против эвристического бота и считает метрики.
// Без сервера и без сокетов — прямые вызовы игрового ядра, как в sim.mjs.
//
//   node ai-eval.mjs --games=10                 # реальная модель (нужен ключ в .env)
//   node ai-eval.mjs --games=4 --dry            # без сети: «капитан-регулярка» вместо модели
//   node ai-eval.mjs --games=6 --mode=develop --foe=mid --model=claude-haiku-4-5
//
// Что меряем и зачем:
//   • ПОБЕДЫ против hard — главный вопрос: ИИ вообще сильнее старого бота?
//   • ДОЛЯ НЕВАЛИДНЫХ ПРИКАЗОВ — чинится брифингом, а не уговорами в промпте.
//   • ФОЛБЭКИ — как часто ход в итоге делала эвристика (значит, ИИ не сыграл).
//   • ТОКЕНЫ И $ — сколько стоит одна партия.
//   • ДЛИНА ПАРТИИ — модели свойственно тянуть; если партии распухают, надо давить в промпте.
import { createGame, addPlayer, startGame, applyAction, forceFinish } from './server/game.js';
import { chooseBotAction } from './server/bot.js';
import { configureAi, AI } from './server/ai/config.js';
import { playAiTurn } from './server/ai/captain.js';
import { movesBudget } from './server/config.js';

const arg = (name, def) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${name}`) ? true : def;
};
const GAMES = +arg('games', 5);
const MODE = arg('mode', 'classic');
const FOE = arg('foe', 'hard');
const DRY = !!arg('dry', false);
const CONTROL = !!arg('control', false);   // за «ИИ» играет эвристика — база для сравнения
const MAX_TURNS = +arg('maxTurns', 400);
const SEED0 = +arg('seed', 1);

// Цены за миллион токенов — для оценки стоимости партии. Неизвестная модель → без денег.
const PRICES = {
  'claude-opus-5': { in: 5, out: 25, cache: 0.5 },
  'claude-sonnet-5': { in: 2, out: 10, cache: 0.2 },
  'claude-haiku-4-5': { in: 1, out: 5, cache: 0.1 },
};
const costOf = (model, u) => {
  const p = PRICES[model];
  if (!p) return null;
  return ((u.input - u.cacheRead) * p.in + u.cacheRead * p.cache + u.output * p.out) / 1e6;
};

// ─── «Капитан-регулярка» для --dry ────────────────────────────────────────────
// Читает ТОТ ЖЕ брифинг, что ушёл бы модели, и вытаскивает из него ход регулярками.
// Сети не требует, а заодно проверяет главное свойство брифинга: он машиночитаем.
// Если регулярки перестают находить ходы — брифинг стал невнятным, и модели тоже плохо.
function regexCaptain({ brief }) {
  const actions = [];
  const volley = brief.match(/💥 (M\d+): залп (левым|правым) бортом → ([A-Z]\d+)/);
  if (volley) actions.push({ type: 'broadside', ship: volley[1], target: volley[3], why: 'цель под бортом' });
  const mortar = brief.match(/🎯 (M\d+): мортира → (PORT\d+|[A-Z]\d+)/);
  if (mortar && !actions.some(a => a.ship === mortar[1])) actions.push({ type: 'mortar', ship: mortar[1], target: mortar[2].replace(/[()].*/, '') });
  if (/💰 собрать клад/.test(brief)) actions.push({ type: 'collect' });
  // остальным кораблям — курс на вражеский порт (или в центр, если порта не видно)
  const mine = [...brief.matchAll(/^ {2}(M\d+) · /gm)].map(m => m[1]);
  const foePort = brief.match(/^ {2}(PORT\d+) · /m);
  for (const ship of mine) {
    if (actions.length >= 3) break;
    if (actions.some(a => a.ship === ship)) continue;
    actions.push({ type: 'sail', ship, to: foePort ? foePort[1] : '20,15', keep_distance: 3 });
  }
  const afford = brief.match(/🛠 верфь: по карману .*?\((\w+), \d+\)/);
  if (afford && actions.length < 3 && /казна (\d+)/.test(brief) && +RegExp.$1 > 600)
    actions.push({ type: 'buy', ships: [afford[1]] });
  return { plan: { plan: 'Курс на вражеский порт, по дороге бьём всё, что под бортом.', actions: actions.slice(0, 3) }, usage: {} };
}

// ─── Одна партия ──────────────────────────────────────────────────────────────
async function playGame(seed) {
  const g = createGame('eval' + seed, { maxPlayers: 2, turnTimer: 0, seed });
  g.config.mode = MODE;
  g.config.fog = true;
  g.config.multiMove = true;
  g.config.botGame = true;
  addPlayer(g, 'ai', '🧠 ИИ');
  addPlayer(g, 'foe', '💀 Бот');
  g.players[0].isBot = true; g.players[0].botLevel = 'ai';
  g.players[1].isBot = true; g.players[1].botLevel = FOE;
  startGame(g, 'ai');

  const stat = { turns: 0, aiTurns: 0, calls: 0, steps: 0, bad: 0, fallbacks: 0, ms: 0, errors: [], fallReasons: [], rateWaits: 0, waitedMs: 0, acts: {}, bought: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  let guard = 0;
  while (g.status === 'active' && guard++ < MAX_TURNS) {
    stat.turns++;
    if (g.turn.idx === 0 && !CONTROL) {
      const r = await playAiTurn(g, 0);
      stat.aiTurns++;
      stat.calls += r.calls;
      stat.steps += r.steps.filter(s => !s.ended).length;
      const bad = r.steps.filter(s => !s.ok && !s.ended);   // конец хода — не вина приказа
      stat.bad += bad.length;
      stat.errors.push(...bad.map(s => s.error));
      if (r.fallback) { stat.fallbacks++; stat.fallReasons.push(r.fallback); }
      stat.ms += r.ms;
      for (const st2 of r.steps) {
        if (!st2.applied) continue;
        const t = st2.item?.type || '?';
        stat.acts[t] = (stat.acts[t] || 0) + 1;
        if (t === 'buy') for (const sh of (st2.item.ships || [])) stat.bought[sh] = (stat.bought[sh] || 0) + 1;
      }
      stat.rateWaits += r.rateWaits || 0;
      stat.waitedMs += r.waitedMs || 0;
      for (const k of Object.keys(stat.usage)) stat.usage[k] += r.usage[k] || 0;
    } else {
      let moves = 0;
      while (g.status === 'active' && g.turn.idx === 1 && moves++ <= movesBudget(g.config)) {
        let a; try { a = chooseBotAction(g, 1, FOE); } catch { a = { type: 'skip' }; }
        if (!applyAction(g, 'foe', a).ok) applyAction(g, 'foe', { type: 'skip' });
      }
    }
    if (CONTROL && g.turn.idx === 0) {                 // контроль: за «ИИ» играет эвристика
      let moves = 0;
      while (g.status === 'active' && g.turn.idx === 0 && moves++ <= movesBudget(g.config)) {
        let a; try { a = chooseBotAction(g, 0, 'hard'); } catch { a = { type: 'skip' }; }
        const r2 = applyAction(g, 'ai', a);
        if (!r2.ok) applyAction(g, 'ai', { type: 'skip' });
        else { stat.acts[a.type] = (stat.acts[a.type] || 0) + 1; if (a.type === 'buy') for (const sh of (a.ships || [])) stat.bought[sh] = (stat.bought[sh] || 0) + 1; }
      }
    }
  }
  // Партия, упёршаяся в лимит ходов, НЕ доиграна: forceFinish присуждает победу «по силе»,
  // и считать это победой ИИ нельзя — иначе метрика меряет мой лимит, а не игру.
  const capped = g.status === 'active';
  if (capped) forceFinish(g);
  const winner = g.players.findIndex(p => p.placement === 1);
  return { ...stat, capped, win: winner === 0, draw: winner === -1, rounds: g.turn.round, game: g };
}

// ─── Прогон ───────────────────────────────────────────────────────────────────
if (DRY) configureAi({ apiKey: 'dry', driver: async req => regexCaptain(req), retries: 0 });
if (arg('model', null)) configureAi({ model: arg('model') });
if (arg('provider', null)) configureAi({ provider: arg('provider') });
configureAi({ taunts: false, maxCallsPerGame: 10000 });

if (!DRY && !CONTROL && !AI.apiKey) {
  console.error('❌ Нет ключа модели. Задай AI_API_KEY в .env или запусти с --dry (капитан-регулярка, без сети).');
  process.exit(1);
}

console.log(`📊 Эвал ИИ: ${GAMES} парт., режим ${MODE}, соперник ${FOE}, ` +
  (CONTROL ? 'КОНТРОЛЬ: вместо ИИ играет эвристика hard' : DRY ? 'драйвер: капитан-регулярка (--dry)' : `модель ${AI.model} (${AI.provider})`));

const all = [];
for (let i = 0; i < GAMES; i++) {
  const r = await playGame(SEED0 + i);
  all.push(r);
  console.log(`  #${i + 1} ${r.capped ? '⏱ не доиграна (лимит ходов), по силе — ' : ''}${r.win ? '🏆 победа ИИ' : (r.draw ? '⚖️ ничья' : '💀 победил бот')}` +
    ` · раундов ${r.rounds} · вызовов ${r.calls} · невалидных приказов ${r.bad}/${r.steps}` +
    ` · фолбэков ${r.fallbacks}/${r.aiTurns}` + (r.usage.input ? ` · токенов ${r.usage.input}/${r.usage.output}` : ''));
}

const sum = k => all.reduce((a, r) => a + (typeof k === 'function' ? k(r) : r[k]), 0);
const played = all.filter(r => !r.capped);           // только доигранные партии идут в win-rate
const wins = played.filter(r => r.win).length;
const capped = all.length - played.length;
const steps = sum('steps'), bad = sum('bad'), aiTurns = sum('aiTurns');
const usage = all.reduce((a, r) => { for (const k of Object.keys(a)) a[k] += r.usage[k]; return a; },
  { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const cost = DRY ? null : costOf(AI.model, usage);

console.log('\n─── ИТОГ ───');
console.log(`🏆 Победы ИИ:            ${wins}/${played.length} доигранных` +
  (played.length ? ` (${Math.round(wins / played.length * 100)}%)` : '') + ' — цель >60% против hard' +
  (capped ? `; ещё ${capped} парт. упёрлись в лимит ходов и в зачёт не идут (подними --maxTurns)` : ''));
console.log(`🧭 Невалидные приказы:   ${steps ? Math.round(bad / steps * 100) : 0}% (${bad} из ${steps}) — цель <5%`);
console.log(`🛟 Ходов ушло в фолбэк:  ${aiTurns ? Math.round(sum('fallbacks') / aiTurns * 100) : 0}% (${sum('fallbacks')} из ${aiTurns})`);
console.log(`⏱ Среднее на ход:        ${aiTurns ? Math.round(sum('ms') / aiTurns) : 0} мс`);
if (sum('rateWaits')) console.log(`🚦 Упирались в лимит API:  ${sum('rateWaits')} раз, суммарно ждали ${Math.round(sum('waitedMs') / 1000)} с`);
console.log(`🔁 Средняя длина партии: ${Math.round(sum('rounds') / GAMES)} раундов`);
// ЧЕМ ОН ЗАНИМАЕТСЯ: без этого «проиграл» ничего не объясняет
const acts = {}, bought = {};
for (const r of all) {
  for (const [k, v] of Object.entries(r.acts)) acts[k] = (acts[k] || 0) + v;
  for (const [k, v] of Object.entries(r.bought)) bought[k] = (bought[k] || 0) + v;
}
const st0 = all.map(r => r.game.players[0].stats);
const sumStat = f => st0.reduce((a, s2) => a + (f(s2) || 0), 0);
const outposts = all.reduce((a, r) => a + (r.game.map.lootIslands || []).filter(i => i.outpost?.owner === 0).length, 0);
const NAMES = { sail: '🧭 ходы', broadside: '💥 бортовые залпы', mortar: '🎯 мортира', collect: '💰 сбор кладов',
  buy: '🛠 походы на верфь', outpost: '⛺ постройка/апгрейд аванпоста', repair: '🛟 ремонт', recharge: '🔧 пополнение', end_turn: '⏭ завершение хода' };
console.log('\n🎭 ЧЕМ ЗАНИМАЛСЯ (на партию):');
for (const [k, v] of Object.entries(acts).sort((a, b) => b[1] - a[1]))
  console.log(`   ${(NAMES[k] || k).padEnd(34)} ${(v / GAMES).toFixed(1)}`);
console.log(`   ${'🚢 куплено кораблей'.padEnd(34)} ${(Object.values(bought).reduce((a, b) => a + b, 0) / GAMES).toFixed(1)}` +
  (Object.keys(bought).length ? ` (${Object.entries(bought).map(([k, v]) => k + '×' + v).join(', ')})` : ''));
console.log(`   ${'⛺ аванпостов к концу партии'.padEnd(34)} ${(outposts / GAMES).toFixed(1)}`);
console.log(`   ${'🏴‍☠️ потоплено НПС (пираты)'.padEnd(34)} ${(sumStat(s2 => s2.npcSunk) / GAMES).toFixed(1)}`);
console.log(`   ${'💰 золота собрано за партию'.padEnd(34)} ${Math.round(sumStat(s2 => s2.goldCollected) / GAMES)}`);
console.log(`   ${'⚔️ урона нанесено / кораблей потеряно'.padEnd(34)} ${Math.round(sumStat(s2 => s2.damageDealt) / GAMES)} / ${(sumStat(s2 => s2.shipsLost) / GAMES).toFixed(1)}`);

// на чём именно спотыкаются приказы — это чинится брифингом и схемой, а не уговорами
const byError = new Map();
for (const r of all) for (const e of r.errors) {
  const key = String(e).replace(/[«»][^«»]*[«»]/g, '«…»').replace(/\b[MEP]\d+\b/g, 'X1').replace(/\d+([.,]\d+)?/g, 'N');
  byError.set(key, (byError.get(key) || 0) + 1);
}
const byFall = new Map();
for (const r of all) for (const e of r.fallReasons) {
  const key = String(e).replace(/\d+/g, 'N').slice(0, 120);
  byFall.set(key, (byFall.get(key) || 0) + 1);
}
if (byFall.size) {
  console.log('\n🛟 Почему ход уходил в фолбэк:');
  [...byFall.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([msg, n]) => console.log(`   ${String(n).padStart(4)} × ${msg}`));
}
if (byError.size) {
  console.log('\n🔧 Частые причины отказов (их чинят брифингом и схемой инструмента):');
  [...byError.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .forEach(([msg, n]) => console.log(`   ${String(n).padStart(4)} × ${msg}`));
}
if (usage.input) {
  console.log(`🔤 Токены на партию:     ${Math.round(usage.input / GAMES)} вход (из них из кэша ${Math.round(usage.cacheRead / GAMES)}) / ${Math.round(usage.output / GAMES)} выход`);
  if (cost != null) console.log(`💵 Цена партии:          $${(cost / GAMES).toFixed(3)} (всего $${cost.toFixed(2)})`);
  else console.log('💵 Цена: неизвестна для этой модели (добавь её в PRICES в ai-eval.mjs)');
}
