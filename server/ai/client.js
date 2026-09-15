// 🔌 Адаптер к языковой модели: один интерфейс, два драйвера.
//
//   askPlan({ rules, brief, tools, model }) → { plan, usage, raw }
//
// • anthropic — официальный SDK (@anthropic-ai/sdk). Правила партии уходят системным
//   блоком с cache_control: между ходами они не меняются, поэтому провайдер отдаёт их
//   из кэша, и платим мы фактически только за брифинг хода.
// • openai — OpenAI-совместимый HTTP (chat/completions). Через AI_BASE_URL сюда же
//   цепляется локальная модель или любой совместимый шлюз.
//
// Про игру этот файл не знает ничего: ему дают два текста и схему инструмента,
// он возвращает разобранный объект плана.

import Anthropic from '@anthropic-ai/sdk';
import { AI } from './config.js';

/** Ошибка вызова модели — капитан по ней уходит в фолбэк, а не роняет партию. */
export class AiError extends Error {
  constructor(message, { kind = 'api', status = 0, retryAfterMs = 0 } = {}) {
    super(message); this.kind = kind; this.status = status; this.retryAfterMs = retryAfterMs;
  }
}

// 429 — «слишком часто», 503/529 — «перегружены». И то и другое лечится ожиданием.
const RATE_STATUS = new Set([429, 503, 529]);
export const isRateLimit = e => e?.kind === 'ratelimit' || RATE_STATUS.has(e?.status);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const usageOf = u => ({
  input: u?.input_tokens ?? u?.prompt_tokens ?? 0,
  output: u?.output_tokens ?? u?.completion_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? 0,
});

/** Достать JSON из текстового ответа (когда модель не воспользовалась инструментом). */
function jsonFromText(text) {
  if (!text) return null;
  const clean = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = clean.indexOf('{');
  if (start === -1) return null;
  // берём самый длинный правдоподобный кусок: от первой { до последней }
  const slice = clean.slice(start, clean.lastIndexOf('}') + 1);
  try { return JSON.parse(slice); } catch { return null; }
}

// ─── Драйвер Anthropic ────────────────────────────────────────────────────────

let anthropicClient = null;
function anthropic() {
  if (!anthropicClient || anthropicClient.__key !== AI.apiKey) {
    anthropicClient = new Anthropic({ apiKey: AI.apiKey, timeout: AI.timeoutMs, maxRetries: 1 });
    anthropicClient.__key = AI.apiKey;
  }
  return anthropicClient;
}

async function askAnthropic({ rules, brief, tools, model }) {
  const tool = tools[0];
  const res = await anthropic().messages.create({
    model,
    max_tokens: AI.maxTokens,
    // ⚑ стабильный префикс — кэшируем: правила между ходами не меняются
    system: [{ type: 'text', text: rules, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: brief }],
    tools: [{ name: tool.name, description: tool.description, input_schema: tool.input_schema }],
    // auto + прямое указание в брифинге: forced tool_choice принимают не все модели,
    // а разобрать ответ мы умеем в обоих видах (инструмент или JSON текстом)
    tool_choice: { type: 'auto' },
    output_config: AI.effort ? { effort: AI.effort } : undefined,
  });
  const call = (res.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  const plan = call ? call.input : jsonFromText(text);
  if (!plan) throw new AiError('Модель не вернула план (ни инструмента, ни JSON)', { kind: 'parse' });
  return { plan, usage: usageOf(res.usage), raw: res };
}

// ─── Драйвер OpenAI-совместимый ───────────────────────────────────────────────

async function askOpenAI({ rules, brief, tools, model }) {
  const tool = tools[0];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI.timeoutMs);
  let res;
  try {
    res = await fetch(`${AI.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${AI.apiKey}` },
      body: JSON.stringify({
        model,
        max_completion_tokens: AI.maxTokens,
        messages: [{ role: 'system', content: rules }, { role: 'user', content: brief }],
        tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }],
        tool_choice: 'auto',
      }),
    });
  } catch (e) {
    throw new AiError(e.name === 'AbortError' ? `Таймаут ${AI.timeoutMs} мс` : `Сеть: ${e.message}`, { kind: 'network' });
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    // Retry-After провайдер иногда присылает сам — уважаем его, если он больше нашей паузы
    const ra = Number(res.headers.get('retry-after'));
    throw new AiError(`HTTP ${res.status}: ${body}`, {
      kind: RATE_STATUS.has(res.status) ? 'ratelimit' : 'api',
      status: res.status,
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0
    });
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  const call = msg?.tool_calls?.find(c => c.function?.name === tool.name);
  let plan = null;
  if (call) { try { plan = JSON.parse(call.function.arguments); } catch { plan = null; } }
  if (!plan) plan = jsonFromText(msg?.content);
  if (!plan) throw new AiError('Модель не вернула план (ни инструмента, ни JSON)', { kind: 'parse' });
  return { plan, usage: usageOf(data.usage), raw: data };
}

// ─── Точка входа ──────────────────────────────────────────────────────────────

/**
 * Спросить у модели план хода.
 * @param {{rules:string, brief:string, tools:Array, model:string}} req
 * Драйвер можно подменить (AI.driver) — так тесты и эвал работают без сети и ключей.
 */
async function askOnce(req) {
  if (typeof AI.driver === 'function') return AI.driver(req);
  if (!AI.apiKey) throw new AiError('Не задан ключ ИИ (AI_API_KEY)', { kind: 'config' });
  const ask = AI.provider === 'openai' ? askOpenAI : askAnthropic;
  try {
    return await ask(req);
  } catch (e) {
    if (e instanceof AiError) throw e;
    // ошибки SDK приводим к своему типу — капитану важен только факт «не вышло»
    const status = e.status || e.statusCode || 0;
    throw new AiError(`${e.name || 'Ошибка'}: ${e.message}`, {
      kind: RATE_STATUS.has(status) ? 'ratelimit' : 'api', status
    });
  }
}

/**
 * Спросить у модели план хода.
 * 🚦 Упёрлись в лимит провайдера — не считаем это поломкой: ждём (по умолчанию 10 с,
 * или дольше, если провайдер прислал Retry-After) и пробуем снова, до rateLimitTries раз.
 * Только после этого сдаёмся — и ход доигрывает эвристика. Партия не встаёт в любом случае.
 * @param {{rules:string, brief:string, tools:Array, model:string}} req
 * @param {(info:{attempt:number, tries:number, waitMs:number, error:AiError}) => void} [onWait]
 */
export async function askPlan(req, onWait = null) {
  const tries = Math.max(1, AI.rateLimitTries || 1);
  for (let attempt = 1; ; attempt++) {
    try {
      return await askOnce(req);
    } catch (e) {
      if (!isRateLimit(e) || attempt >= tries) throw e;
      const waitMs = Math.max(e.retryAfterMs || 0, AI.rateLimitWaitMs);
      onWait?.({ attempt, tries, waitMs, error: e });
      if (AI.debug) console.log(`🚦 лимит провайдера (${e.status}), попытка ${attempt}/${tries}: ждём ${waitMs} мс`);
      await sleep(waitMs);
    }
  }
}
