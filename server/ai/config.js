// ⚙️ Настройки ИИ-соперника. Ключ живёт ТОЛЬКО здесь, на сервере: в клиент уходит
// лишь флаг «ИИ доступен» (как сделано с читами — коды тоже не покидают сервер).
//
// Провайдер выбирается переменной AI_PROVIDER: anthropic | openai. Второй драйвер
// говорит на OpenAI-совместимом протоколе, так что через AI_BASE_URL туда же
// подключается локальная модель или любой совместимый шлюз.

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const num = (k, d) => { const v = Number(process.env[k]); return Number.isFinite(v) ? v : d; };
const bool = (k, d) => { const v = env(k); return v ? !/^(0|false|no|off)$/i.test(v) : d; };

// Модели по умолчанию. Меняются переменной AI_MODEL; AI_MODEL_FAST — для «лёгкого»
// уровня ИИ (дешевле и быстрее, слабее в тактике).
const DEFAULT_MODEL = { anthropic: 'claude-opus-5', openai: 'gpt-5.4' };

function fromEnv() {
  const provider = /^openai$/i.test(env('AI_PROVIDER', 'anthropic')) ? 'openai' : 'anthropic';
  return {
    provider,
    enabled: bool('AI_ENABLED', true),
    apiKey: env('AI_API_KEY') || env(provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'),
    baseUrl: env('AI_BASE_URL') || (provider === 'openai' ? 'https://api.openai.com/v1' : ''),
    model: env('AI_MODEL') || DEFAULT_MODEL[provider],
    modelFast: env('AI_MODEL_FAST') || '',       // пусто → «лёгкий» ИИ играет на той же модели
    effort: env('AI_EFFORT', 'medium'),          // anthropic: low|medium|high|xhigh|max
    maxTokens: num('AI_MAX_TOKENS', 4000),
    timeoutMs: num('AI_TIMEOUT_MS', 20000),
    retries: num('AI_RETRIES', 1),               // ретраев ПОСЛЕ неудачного плана (с текстом ошибки)
    // 🚦 Лимиты провайдера (429 «слишком часто», 503/529 «перегружены») — это НЕ поломка,
    // а просьба подождать. Ждём и повторяем; сдаёмся только после rateLimitTries попыток,
    // и тогда ход доигрывает эвристика.
    rateLimitTries: num('AI_RATELIMIT_TRIES', 10),
    rateLimitWaitMs: num('AI_RATELIMIT_WAIT_MS', 10000),
    maxCallsPerGame: num('AI_MAX_CALLS_PER_GAME', 300),
    maxAiGames: num('AI_MAX_AI_GAMES', 3),       // одновременных партий с ИИ на сервере
    taunts: bool('AI_TAUNTS', true),             // реплики капитана в чат партии
    debug: bool('AI_DEBUG', false),              // логировать промпт/ответ в консоль сервера
  };
}

// Живые настройки: читаются из ENV при старте, но их можно подменить в тестах и эвале.
export let AI = fromEnv();

/** Точечно поменять настройки (тесты, эвал, ручная отладка). Возвращает новый объект. */
export function configureAi(patch = {}) { AI = { ...AI, ...patch }; return AI; }
/** Перечитать переменные окружения (например, после подгрузки .env). */
export function reloadAi() { AI = fromEnv(); return AI; }

/** Доступен ли ИИ-соперник: включён и есть ключ (или подставлен свой драйвер в тестах). */
export const aiAvailable = () => !!(AI.enabled && (AI.apiKey || AI.driver));

/** Модель для уровня бота: 'ai' — основная, 'ai-fast' — облегчённая (если задана). */
export const modelFor = (level = 'ai') => (level === 'ai-fast' && AI.modelFast) ? AI.modelFast : AI.model;

/** Уровни бота, которые обслуживает ИИ (остальные — старая эвристика из bot.js). */
export const AI_LEVELS = ['ai', 'ai-fast'];
export const isAiLevel = level => AI_LEVELS.includes(level);
