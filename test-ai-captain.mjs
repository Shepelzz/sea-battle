// 🧠 Этап 3: провайдер + капитан (server/ai/config.js, client.js, captain.js).
// Вся сеть подменена фейковым драйвером: тест гоняется без ключей и без интернета.
import { createGame, addPlayer, startGame } from './server/game.js';
import { SHIP_TYPES, MOVES_PER_TURN } from './server/config.js';
import { AI, configureAi, reloadAi, aiAvailable, modelFor, isAiLevel } from './server/ai/config.js';
import { askPlan, AiError } from './server/ai/client.js';
import { rulesPrompt, aliasOf } from './server/ai/perception.js';
import { playAiTurn, memoryOf, aiCalls } from './server/ai/captain.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

// ─── Фейковый драйвер: очередь ответов + запись запросов ─────────────────────
const calls = [];
function driver(queue) {
  calls.length = 0;
  return async req => {
    calls.push(req);
    const next = queue.shift();
    if (typeof next === 'function') return next(req);
    if (next instanceof Error) throw next;
    return { plan: next, usage: { input: 1200, output: 180, cacheRead: 900, cacheWrite: 0 } };
  };
}

function game({ level = 'ai', mode = 'classic' } = {}) {
  const g = createGame('cap', { maxPlayers: 2, turnTimer: 0, seed: 7 });
  g.config.mode = mode; g.config.fog = true; g.config.multiMove = true;
  addPlayer(g, 'ai0', 'Капитан ИИ'); addPlayer(g, 'p1', 'Человек');
  startGame(g, 'ai0');
  g.players[0].isBot = true; g.players[0].botLevel = level;
  g.ships = [];
  g.wind = { ang: 0, str: 0, targetAng: 0, targetStr: 0 };
  const mine = [
    { id: 'm1', owner: 0, type: 'fregat', x: 500, y: 500, hp: 170, heading: 0 },
    { id: 'm2', owner: 0, type: 'brig', x: 560, y: 560, hp: 110, heading: 0 },
  ];
  g.ships.push(...mine, { id: 'e1', owner: 1, type: 'shkhuna', x: 500, y: 600, hp: 60 });
  g.ships.forEach(s => aliasOf(g, 0, s));
  return g;
}

// ─── Конфиг ──────────────────────────────────────────────────────────────────
{
  reloadAi();
  check('провайдер по умолчанию — anthropic', AI.provider === 'anthropic', AI.provider);
  check('модель по умолчанию — claude-opus-5', AI.model === 'claude-opus-5', AI.model);
  check('без ключа и драйвера ИИ недоступен', aiAvailable() === false || !!AI.apiKey);
  configureAi({ apiKey: '', driver: null });
  check('явно пустой ключ → ИИ недоступен', aiAvailable() === false);
  configureAi({ driver: async () => ({ plan: { plan: '', actions: [] }, usage: {} }) });
  check('подставленный драйвер включает ИИ (тесты/эвал)', aiAvailable() === true);
  check('уровни ИИ опознаются', isAiLevel('ai') && isAiLevel('ai-fast') && !isAiLevel('hard'));
  configureAi({ model: 'MAIN', modelFast: 'FAST' });
  check('модель уровня: ai → основная', modelFor('ai') === 'MAIN');
  check('модель уровня: ai-fast → облегчённая', modelFor('ai-fast') === 'FAST');
  configureAi({ modelFast: '' });
  check('без AI_MODEL_FAST лёгкий уровень играет на основной', modelFor('ai-fast') === 'MAIN');
}
{
  configureAi({ driver: null, apiKey: '' });
  let kind = null;
  try { await askPlan({ rules: 'r', brief: 'b', tools: [], model: 'm' }); } catch (e) { kind = e instanceof AiError ? e.kind : 'wrong-type'; }
  check('без ключа askPlan бросает понятную AiError', kind === 'config', String(kind));
}

// ─── Удачный ход ─────────────────────────────────────────────────────────────
{
  const g = game();
  configureAi({
    apiKey: '', retries: 1, taunts: true, maxCallsPerGame: 300,
    driver: driver([{
      plan: 'Давлю шхуну и держу центр.',
      taunt: 'Попутного ветра\nна дно!',
      actions: [
        { type: 'broadside', ship: 'M1', target: 'E1', why: 'цель в секторе' },
        { type: 'sail', ship: 'M2', to: '16,14', why: 'к центру' }
      ]
    }])
  });
  const res = await playAiTurn(g, 0);
  check('ход ИИ: один вызов модели на весь ход', res.calls === 1, `вызовов ${res.calls}`);
  check('ход ИИ: оба действия применились', res.applied === 2, `применено ${res.applied}`);
  check('ход ИИ: фолбэка не было', res.fallback === null, String(res.fallback));
  check('ход ИИ: залп реально снял HP', g.ships.find(s => s.id === 'e1').hp < 60);
  check('ход ИИ: реплика очищена от переводов строк', res.taunt === 'Попутного ветра на дно!', JSON.stringify(res.taunt));
  check('ход ИИ: токены посчитаны', res.usage.input === 1200 && res.usage.cacheRead === 900);
  check('ход ИИ: ход передан сопернику', g.turn.idx === 1, `idx=${g.turn.idx}`);
  check('ход ИИ: план записан в память', memoryOf(g, 0).plan.startsWith('Давлю шхуну'));
  check('ход ИИ: счётчик вызовов партии вырос', aiCalls(g) === 1);
  check('ход ИИ: отладочный след сложен в game.ai.log', g.ai.log.length === 1 && g.ai.log[0].applied === 2);
  check('состояние ИИ сериализуется в БД (без циклов)', (() => { try { JSON.parse(JSON.stringify(g)); return true; } catch { return false; } })());

  // правила и брифинг разделены — иначе кэш провайдера бессмысленен
  const req = calls[0];
  check('промпт: правила отдельно от брифинга', req.rules === rulesPrompt(g) && req.rules !== req.brief);
  check('промпт: в брифинге есть задача и лимит действий', req.brief.includes('=== ЗАДАЧА ===') && req.brief.includes(String(MOVES_PER_TURN)));
  check('промпт: в брифинге есть возможности с посчитанным уроном', req.brief.includes('ВОЗМОЖНОСТИ ЭТОГО ХОДА'));
  check('промпт: инструмент передан', req.tools?.[0]?.name === 'submit_turn');
}

// ─── Память между ходами ────────────────────────────────────────────────────
{
  const g = game();
  configureAi({
    driver: driver([
      { plan: 'Копим на линкор, не лезем в размен.', actions: [{ type: 'sail', ship: 'M1', to: '15,13' }] },
      { plan: 'Всё ещё копим.', actions: [{ type: 'sail', ship: 'M1', to: '16,13' }] }
    ])
  });
  await playAiTurn(g, 0);
  g.turn.idx = 0; g.turn.moves = 0; g.turn.actedShips = []; g.turn.number++;   // вернули ход ИИ
  await playAiTurn(g, 0);
  check('память: прошлый план попал в брифинг второго хода',
    calls[1].brief.includes('ТВОЙ ПЛАН С ПРОШЛОГО ХОДА') && calls[1].brief.includes('Копим на линкор'));
  check('память: новый план перезаписал старый', memoryOf(g, 0).plan === 'Всё ещё копим.');
}

// ─── Ретрай: первый план невалиден, второй проходит ─────────────────────────
{
  const g = game();
  configureAi({
    retries: 1,
    driver: driver([
      { plan: 'Атака', actions: [{ type: 'mortar', ship: 'M2', target: 'E1' }] },      // у брига нет мортиры
      { plan: 'Ладно, залпом', actions: [{ type: 'broadside', ship: 'M1', target: 'E1' }] }
    ])
  });
  const res = await playAiTurn(g, 0);
  check('ретрай: сделано два вызова', res.calls === 2, `вызовов ${res.calls}`);
  check('ретрай: во втором промпте есть текст ошибки навигатора',
    calls[1].brief.includes('ПРОШЛЫЙ ПРИКАЗ НЕ ПРОШЁЛ') && calls[1].brief.includes('мортира'), '');
  check('ретрай: второй план применился', res.applied === 1 && res.fallback === null, String(res.fallback));
}

// ─── Фолбэк: сеть, мусор, бюджет, выключенный ИИ ────────────────────────────
{
  const g = game();
  configureAi({ retries: 1, driver: driver([new Error('сеть легла')]) });
  const res = await playAiTurn(g, 0);
  check('фолбэк по ошибке сети: без ретрая (ретраить нечего)', res.calls === 1, `вызовов ${res.calls}`);
  check('фолбэк по ошибке сети: ход всё равно сделан', res.applied > 0 && !!res.fallback, String(res.fallback));
  check('фолбэк по ошибке сети: ход передан сопернику', g.turn.idx === 1);
}
{
  const g = game();
  configureAi({ retries: 1, driver: driver([{ plan: 'чушь', actions: [{ type: 'телепорт', ship: 'M1' }] }, { plan: 'опять чушь', actions: [{ type: 'sail', ship: 'M77', to: 'нигде' }] }]) });
  const res = await playAiTurn(g, 0);
  check('фолбэк по невалидному плану: ретрай был', res.calls === 2);
  check('фолбэк по невалидному плану: ход доигран эвристикой', res.applied > 0 && !!res.fallback, String(res.fallback));
  check('фолбэк: ход передан сопернику', g.turn.idx === 1);
}
{
  const g = game();
  configureAi({ maxCallsPerGame: 0, driver: driver([{ plan: 'не спросят', actions: [] }]) });
  const res = await playAiTurn(g, 0);
  check('бюджет вызовов исчерпан → модель не дёргаем вовсе', res.calls === 0 && calls.length === 0);
  check('бюджет исчерпан → ход делает эвристика', res.applied > 0 && res.fallback.includes('бюджет'));
  configureAi({ maxCallsPerGame: 300 });
}
{
  const g = game();
  configureAi({ enabled: false, driver: driver([{ plan: 'не спросят', actions: [] }]) });
  const res = await playAiTurn(g, 0);
  check('ИИ выключен → ход делает эвристика, партия не стоит', res.calls === 0 && res.applied > 0 && g.turn.idx === 1);
  configureAi({ enabled: true });
}

// ─── 🚦 Лимит провайдера: ждём и повторяем, а не сдаёмся сразу ──────────────
{
  const g = game();
  const rate = (status = 429) => Object.assign(new Error('HTTP ' + status), { kind: 'ratelimit', status });
  let asked = 0;
  configureAi({
    retries: 0, rateLimitTries: 10, rateLimitWaitMs: 5,   // в тесте ждём 5 мс вместо 10 с
    driver: async () => {
      asked++;
      if (asked <= 2) throw rate();                        // два раза «слишком часто», потом норм
      return { plan: { plan: 'Пробился сквозь лимит.', actions: [{ type: 'sail', ship: 'M1', to: '15,13' }] }, usage: {} };
    }
  });
  const res = await playAiTurn(g, 0);
  check('лимит: дождались и переспросили', asked === 3, `обращений к API ${asked}`);
  check('лимит: ход в итоге сделала МОДЕЛЬ, не эвристика', res.applied === 1 && res.fallback === null, String(res.fallback));
  check('лимит: ожидания посчитаны', res.rateWaits === 2 && res.waitedMs === 10, `${res.rateWaits} × ${res.waitedMs} мс`);
  check('лимит: это один ход, а не десять вызовов модели', res.calls === 1);
}
{
  const g = game();
  let asked = 0;
  configureAi({
    retries: 0, rateLimitTries: 10, rateLimitWaitMs: 1,
    driver: async () => { asked++; throw Object.assign(new Error('HTTP 429'), { kind: 'ratelimit', status: 429 }); }
  });
  const res = await playAiTurn(g, 0);
  check('лимит не отпускает: ровно 10 попыток, потом сдаёмся', asked === 10, `попыток ${asked}`);
  check('сдались → ход доиграла эвристика, партия не встала', res.applied > 0 && !!res.fallback && g.turn.idx === 1, String(res.fallback));
}
{
  const g = game();
  let asked = 0;
  configureAi({ retries: 0, rateLimitTries: 10, rateLimitWaitMs: 1,
    driver: async () => { asked++; throw Object.assign(new Error('HTTP 400 кривой запрос'), { status: 400 }); } });
  const res = await playAiTurn(g, 0);
  check('обычная ошибка (не лимит) не ретраится', asked === 1, `попыток ${asked}`);
  check('обычная ошибка → сразу эвристика', res.applied > 0 && !!res.fallback);
  configureAi({ rateLimitTries: 10, rateLimitWaitMs: 10000 });
}

// ─── Пустой план = осознанный пропуск хода ──────────────────────────────────
{
  const g = game();
  configureAi({ retries: 0, driver: driver([{ plan: 'Жду ветра.', actions: [] }]) });
  const res = await playAiTurn(g, 0);
  check('пустой план: ход не зависает', g.turn.idx === 1);
  check('пустой план: считается за фолбэк (делать что-то надо)', !!res.fallback || res.applied > 0);
}

// ─── Реплики можно выключить ────────────────────────────────────────────────
{
  const g = game();
  configureAi({ taunts: false, driver: driver([{ plan: 'Тихо иду', taunt: 'Эй!', actions: [{ type: 'sail', ship: 'M1', to: '15,13' }] }]) });
  const res = await playAiTurn(g, 0);
  check('AI_TAUNTS=false → реплика не выдаётся', res.taunt === '');
  configureAi({ taunts: true });
}

// ─── Не свой ход трогать нельзя ─────────────────────────────────────────────
{
  const g = game();
  configureAi({ driver: driver([{ plan: 'x', actions: [{ type: 'sail', ship: 'M1', to: '15,13' }] }]) });
  g.turn.idx = 1;                                       // сейчас ходит человек
  const res = await playAiTurn(g, 0);
  check('чужой ход: модель не дёргаем и ничего не применяем', res.calls === 0 && res.applied === 0 && res.error === 'не наш ход');
  check('чужой ход: очередь не украдена', g.turn.idx === 1);
}

console.log(`\nИтого капитан ИИ: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
