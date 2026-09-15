// 🧠 КАПИТАН — оркестратор хода ИИ-игрока.
//
//   восприятие (perception) → модель (client) → штурман (actions) → applyAction
//
// Отвечает за три вещи, которых нет ни в одном из соседних файлов:
//
//  1. ПАМЯТЬ. План прошлого хода возвращается в брифинг следующего — иначе ИИ каждый
//     ход начинает партию заново и мечется. Память живёт в game.ai (сохраняется в БД).
//  2. РЕТРАЙ. Если ни одно намерение не прошло, модели отдаётся её же план вместе с
//     текстами ошибок навигатора — обычно со второго раза приказ чинится.
//  3. ФОЛБЭК. Нет ключа, таймаут, мусор в ответе, исчерпан бюджет вызовов — ход делает
//     старый эвристический бот уровня hard. Партия НЕ зависает никогда.

import { applyAction } from '../game.js';
import { chooseBotAction } from '../bot.js';
import { movesBudget, isRealtime, isDuel, cheapestShipPrice } from '../config.js';
import { AI, aiAvailable, modelFor } from './config.js';
import { askPlan } from './client.js';
import { buildBrief, rulesPrompt, ensureOwnAliases } from './perception.js';
import { TOOLS, planToActions } from './actions.js';

const FALLBACK_LEVEL = 'hard';

/** Память капитана по игроку: план, счётчики, последняя беда. */
export function memoryOf(game, pIdx) {
  const ai = (game.ai ||= {});
  const all = (ai.memory ||= {});
  return (all[pIdx] ||= { plan: '', turn: 0, fails: 0, history: [], fleet: null });
}

/** Сколько вызовов модели уже съела эта партия (предохранитель от сжигания ключа). */
export const aiCalls = game => game.ai?.calls || 0;

const blankUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const addUsage = (a, b) => { for (const k of Object.keys(a)) a[k] += (b?.[k] || 0); return a; };

/** Наш ли сейчас ход (в реалтайме очереди нет — «наш» всегда, пока живы). */
const myTurn = (game, pIdx) => game.status === 'active' &&
  (isRealtime(game) ? !!game.players[pIdx]?.alive : game.turn.idx === pIdx);

// ─── Промпт хода ──────────────────────────────────────────────────────────────

function composeBrief(game, pIdx, mem, errorsNote = '') {
  const parts = [buildBrief(game, pIdx).text];
  if (mem.plan) {
    parts.push('', '=== ТВОЙ ПЛАН С ПРОШЛОГО ХОДА ===', mem.plan,
      'Держись его, пока обстановка не заставила менять курс. Если меняешь — скажи об этом в новом plan.');
  }
  // Журнал партии под туманом абстрактен («противник сделал ход») и для тактики бесполезен,
  // поэтому ведём СВОЮ историю: что капитан приказывал и чем это обернулось для флота.
  // Без неё каждый ход начинался с чистого листа — флот бродил кругами.
  if (mem.history?.length) {
    parts.push('', '=== ЧТО БЫЛО В ПРОШЛЫХ ХОДАХ (твои приказы и их итог) ===', ...mem.history.slice(-5));
  }
  if (errorsNote) parts.push('', '=== ПРОШЛЫЙ ПРИКАЗ НЕ ПРОШЁЛ ===', errorsNote, 'Исправь приказ и отдай новый.');
  const budget = isRealtime(game) ? 3 : Math.max(0, movesBudget(game.config) - (game.turn?.moves || 0));
  // Копить и не покупать — самая дорогая ошибка ИИ на замерах. Считаем ходы без верфи и
  // тычем в это прямо, когда денег уже хватает на боевой корабль.
  const gold = game.players[pIdx]?.gold || 0;
  const idle = (game.turn?.number || 0) - (mem.lastBuyTurn || 0);
  if (gold >= cheapestShipPrice(isDuel(game)) * 2 && idle >= 6) {
    parts.push('', `⚠ В казне ${gold} зол., а на верфи ты не был уже ${idle} ходов. Соперник в это время наращивает флот — купи корабли ЭТИМ ходом.`);
  }
  parts.push('', '=== ЗАДАЧА ===',
    `Сейчас твой ход. Вызови инструмент submit_turn: поле plan — цель на ближайшие ходы, actions — до ${budget} действий по порядку.`,
    'Пустой actions = пропустить ход (так делают, только когда действительно нечего делать).',
    // Главный источник негодных приказов на замерах — стрельба «на глазок»: модель командует
    // залп или мортиру по цели вне радиуса. Лечится не уговорами, а жёстким правилом:
    // список возможных атак уже посчитан сервером и он ПОЛНЫЙ.
    'ОГОНЬ (broadside, mortar) разрешён ТОЛЬКО теми связками «корабль → цель», которые перечислены в секции',
    '«ВОЗМОЖНОСТИ ЭТОГО ХОДА». Это полный список того, что реально достаёт прямо сейчас, и урон в нём настоящий.',
    'Если твоего корабля там нет — стрелять ему нечем: веди его к цели (sail), а огонь дай в следующий ход.',
    'Одним кораблём — одно действие за ход. Не ставь два приказа одному и тому же кораблю.',
    `ТРАТЬ ВЕСЬ БЮДЖЕТ: ${budget} действий — это ${budget} действий, а не одно. end_turn ставь только когда делать реально нечего;`,
    'покупка корабля или ход к цели почти всегда полезнее простоя. Золото само по себе партию не выигрывает — выигрывает флот.');
  return parts.join('\n');
}

function failNote(steps) {
  return steps.filter(s => !s.ok)
    .map(s => `• ${JSON.stringify(s.item)} → ${s.error}`)
    .join('\n');
}

// ─── Применение шага ──────────────────────────────────────────────────────────

function makeApply(game, pIdx, summary) {
  const botId = game.players[pIdx].id;
  return action => {
    // бюджет хода мог закончиться раньше, чем список приказов (например, все корабли
    // уже сходили) — это не ошибка приказа, а естественный конец хода
    if (!myTurn(game, pIdx)) return { ok: false, ended: true, error: 'Ход уже закончился' };
    const res = applyAction(game, botId, action);
    if (res.ok) summary.applied++;
    return res;
  };
}

/** Ход эвристическим ботом — страховка на все случаи жизни. */
function heuristicTurn(game, pIdx, summary, reason) {
  summary.fallback = reason;
  const botId = game.players[pIdx].id;
  let guard = 0;
  while (myTurn(game, pIdx) && guard++ < movesBudget(game.config) + 1) {
    let action;
    try { action = chooseBotAction(game, pIdx, FALLBACK_LEVEL); }
    catch { action = { type: 'skip' }; }
    const r = applyAction(game, botId, action);
    if (!r.ok) { applyAction(game, botId, { type: 'skip' }); break; }
    summary.applied++;
    if (isRealtime(game)) break; // в реалтайме бюджета ходов нет — одно действие за вызов
  }
  return summary;
}

// ─── Ход капитана ─────────────────────────────────────────────────────────────

/**
 * Отыграть ход ИИ-игрока целиком: один вызов модели на весь ход (+ретрай при нужде),
 * применение действий по порядку, завершение хода.
 * Ничего не бросает — любую беду превращает в ход эвристического бота.
 */
export async function playAiTurn(game, pIdx, opts = {}) {
  const t0 = Date.now();
  const player = game.players[pIdx];
  const level = opts.level || player?.botLevel || 'ai';
  const summary = {
    pIdx, nick: player?.nick, level, calls: 0, applied: 0, steps: [], rateWaits: 0, waitedMs: 0,
    plan: '', taunt: '', usage: blankUsage(), fallback: null, error: null, ms: 0
  };
  if (!myTurn(game, pIdx)) { summary.error = 'не наш ход'; return summary; }

  ensureOwnAliases(game, pIdx);
  const mem = memoryOf(game, pIdx);

  if (!aiAvailable()) return done(heuristicTurn(game, pIdx, summary, 'ИИ выключен или нет ключа'), game, pIdx, mem, t0);
  if (aiCalls(game) >= AI.maxCallsPerGame)
    return done(heuristicTurn(game, pIdx, summary, 'исчерпан бюджет вызовов на партию'), game, pIdx, mem, t0);

  const rules = rulesPrompt(game);
  const apply = makeApply(game, pIdx, summary);
  let errorsNote = '';

  for (let attempt = 0; attempt <= AI.retries; attempt++) {
    let answer;
    try {
      game.ai.calls = aiCalls(game) + 1;
      summary.calls++;
      answer = await askPlan(
        { rules, brief: composeBrief(game, pIdx, mem, errorsNote), tools: TOOLS, model: modelFor(level) },
        info => { summary.rateWaits++; summary.waitedMs += info.waitMs; });
      addUsage(summary.usage, answer.usage);
    } catch (e) {
      summary.error = e.message;
      break;                                   // сеть/ключ/парсинг — ретраить бессмысленно
    }
    if (!myTurn(game, pIdx)) { summary.error = 'ход перехвачен, пока думали'; break; }

    const run = planToActions(game, pIdx, answer.plan, apply);
    summary.steps = run.steps;
    summary.plan = run.plan || summary.plan;
    summary.taunt = AI.taunts ? (run.taunt || '') : '';
    if (summary.applied > 0) break;            // хоть что-то сделали — ход состоялся

    errorsNote = failNote(run.steps) || 'Действий в плане не было вовсе.';
    if (AI.debug) console.log('🧠 ретрай хода ИИ:', errorsNote);
  }

  if (summary.applied === 0) heuristicTurn(game, pIdx, summary, summary.error || 'план не дал ни одного действия');
  return done(summary, game, pIdx, mem, t0);
}

/** Короткая запись приказа для истории: «M3 залп по E3», «M1 к I4», «верфь: brig». */
function stepNote(st) {
  const it = st.item || {};
  const who = it.ship ? it.ship + ' ' : '';
  switch (it.type) {
    case 'sail': return `${who}→ ${it.to}`;
    case 'broadside': return `${who}залп по ${it.target}`;
    case 'mortar': return `${who}мортира по ${it.target}`;
    case 'buy': return `верфь: ${(it.ships || []).join('+')}`;
    case 'outpost': return `аванпост на ${it.island || it.target}`;
    case 'repair': return `${who}чинит ${it.target}`;
    case 'collect': return 'собрал клад';
    case 'recharge': return `${who}пополнил материалы`;
    default: return it.type || '?';
  }
}

/** Завершение: дописать память, закрыть ход, сложить отладочный след. */
function done(summary, game, pIdx, mem, t0) {
  if (summary.plan) { mem.plan = summary.plan; mem.turn = game.turn?.number || 0; }

  // Итог хода для истории: что приказали + как изменился флот с прошлого раза.
  const mine = game.ships.filter(s => s.owner === pIdx);
  const now = { n: mine.length, hp: mine.reduce((a, s) => a + s.hp, 0), gold: game.players[pIdx]?.gold || 0 };
  const did = summary.steps.filter(st => st.applied).map(stepNote);
  if (summary.steps.some(st => st.applied && st.item?.type === 'buy')) mem.lastBuyTurn = game.turn?.number || 0;
  const delta = [];
  if (mem.fleet) {
    const lost = mem.fleet.n - now.n;
    const dhp = now.hp - mem.fleet.hp;
    if (lost > 0) delta.push(`ПОТЕРЯНО кораблей: ${lost}`);
    if (dhp < -1) delta.push(`флот просел на ${-dhp} HP`);
    else if (dhp > 1) delta.push(`флот подлатан на +${dhp} HP`);
    const dg = now.gold - mem.fleet.gold;
    if (dg) delta.push(`казна ${dg > 0 ? '+' : ''}${dg}`);
  }
  mem.fleet = now;
  (mem.history ||= []).push(`ход ${game.turn?.number || 0}: ` +
    (did.length ? did.join(' · ') : (summary.fallback ? 'приказ не прошёл, ходил автопилот' : 'ничего')) +
    (delta.length ? ` — ${delta.join(', ')}` : ''));
  if (mem.history.length > 5) mem.history.splice(0, mem.history.length - 5);
  mem.fails = summary.fallback ? (mem.fails || 0) + 1 : 0;
  // бюджет действий мог остаться неизрасходованным — закрываем ход явно
  if (myTurn(game, pIdx) && !isRealtime(game)) applyAction(game, game.players[pIdx].id, { type: 'skip' });
  summary.ms = Date.now() - t0;

  const ai = (game.ai ||= {});
  (ai.log ||= []).push({
    t: Date.now(), turn: game.turn?.number || 0, pIdx,
    plan: summary.plan, applied: summary.applied, fallback: summary.fallback,
    errors: summary.steps.filter(s => !s.ok).map(s => s.error),
    usage: summary.usage, ms: summary.ms
  });
  if (ai.log.length > 10) ai.log.splice(0, ai.log.length - 10);
  if (AI.debug) console.log('🧠 ход ИИ:', JSON.stringify({ ...summary, steps: undefined }, null, 1));
  return summary;
}
