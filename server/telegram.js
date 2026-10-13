// Telegram Mini App — серверная часть бота. Проверка подписи initData живёт в auth.js (чистая
// логика), здесь — то, что ходит в Bot API: напоминание «твой ход» личным сообщением и ответ на
// /start (кнопка «Открыть игру»). Всё необязательно: без TELEGRAM_BOT_TOKEN модуль не используется.
//
// Чистые помощники (ссылки, разбор /start) экспортированы отдельно — их покрывают тесты; сетевой
// слой (fetch) подменяется через fetchImpl.

// id партии — то, что ходит в ссылках t.me/<бот>?startapp=<id> и /game/<id>
export const GAME_ID_RE = /^[A-Za-z0-9_-]{4,24}$/;
export const parseStartParam = v => (typeof v === 'string' && GAME_ID_RE.test(v) ? v : null);

// «/start», «/start abc», «/start@botname abc» → { param } ; не команда /start → null
export function parseStartCommand(text) {
  const m = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(String(text || ''));
  return m ? { param: parseStartParam(m[1] || '') } : null;
}

const trimSlash = s => String(s || '').replace(/\/+$/, '');
export const gameUrl = (baseUrl, gameId) => (gameId ? `${trimSlash(baseUrl)}/game/${gameId}` : trimSlash(baseUrl) || '/');
// Прямая ссылка на Main Mini App бота (BotFather → Bot Settings → Configure Mini App); startapp → start_param
export const miniAppLink = (bot, gameId) => `https://t.me/${bot}${gameId ? `?startapp=${gameId}` : ''}`;
// «Поделиться» штатным окном Телеграма: получатель видит текст и ссылку на мини-апп с партией
export const shareLink = (bot, gameId, text) =>
  `https://t.me/share/url?url=${encodeURIComponent(miniAppLink(bot, gameId))}&text=${encodeURIComponent(text || '')}`;

// Кнопка под сообщением: web_app открывает мини-апп прямо из чата, но Телеграм принимает там
// только https — на локалке (http) шлём обычную url-кнопку, чтобы sendMessage не падал.
export const openButton = (text, url) => (/^https:\/\//.test(url) ? { text, web_app: { url } } : { text, url });

export function createTelegramBot({ token, baseUrl, t, fetchImpl = globalThis.fetch, log = console, pollTimeoutS = 25 }) {
  const API = `https://api.telegram.org/bot${token}/`;
  let offset = 0, polling = false, stopped = false;

  async function api(method, body, { timeoutMs = 15000 } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(API + method, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}), signal: ctl.signal
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.description || `telegram ${method}: http ${r.status}`);
      return data.result;
    } finally { clearTimeout(timer); }
  }

  // «Твой ход, 10 минут» — личным сообщением с кнопкой в партию. false — не ушло (бот не может
  // писать первым: человек должен был открыть мини-апп или нажать /start).
  async function sendNudge(chatId, nick, url, lang) {
    if (!chatId) return false;
    try {
      await api('sendMessage', {
        chat_id: chatId,
        text: await t(lang, 'mail.nudge.tg', { nick, url }),
        reply_markup: { inline_keyboard: [[openButton(await t(lang, 'mail.nudge.tgBtn'), url)]] }
      });
      return true;
    } catch (e) { log.error('Telegram: напоминание не ушло:', e.message); return false; }
  }

  // Ответ на сообщение в личке бота: /start [id партии] → приветствие + кнопка «Открыть игру»
  // (с id — «Присоединиться» прямо в лобби). Любой другой текст — то же приветствие.
  async function replyToMessage(msg) {
    const chatId = msg?.chat?.id; if (!chatId) return null;
    const lang = String(msg.from?.language_code || '').slice(0, 2);
    const start = parseStartCommand(msg.text);
    const gameId = start?.param || null;
    const url = gameUrl(baseUrl, gameId);
    const text = await t(lang, gameId ? 'mail.tg.join' : 'mail.tg.welcome');
    const btn = await t(lang, gameId ? 'mail.tg.joinBtn' : 'mail.tg.open');
    return api('sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: [[openButton(btn, url)]] } });
  }

  // Длинный опрос getUpdates — без вебхука и публичного адреса для него. Один инстанс сервера —
  // один опрос (два параллельных опроса Телеграм отвергает: 409). Ошибки — пауза и снова.
  async function pollOnce() {
    const updates = await api('getUpdates', { offset, timeout: pollTimeoutS, allowed_updates: ['message'] },
      { timeoutMs: (pollTimeoutS + 10) * 1000 });
    for (const u of updates || []) {
      offset = Math.max(offset, u.update_id + 1);
      if (u.message?.text) {
        try { await replyToMessage(u.message); } catch (e) { log.error('Telegram: ответ не ушёл:', e.message); }
      }
    }
    return (updates || []).length;
  }
  async function startPolling() {
    if (polling) return; polling = true; stopped = false;
    log.log('Telegram: бот слушает /start (long polling)');
    while (!stopped) {
      try { await pollOnce(); }
      catch (e) {
        if (stopped) break;
        log.error('Telegram: опрос упал, пауза 5 с:', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
    polling = false;
  }
  const stop = () => { stopped = true; };

  return { api, sendNudge, replyToMessage, pollOnce, startPolling, stop, get offset() { return offset; } };
}
