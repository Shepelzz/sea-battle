// Telegram-бот: разбор /start, ссылки, напоминание «твой ход», ответ на сообщения, long polling —
// с подменённым fetch, в сеть не ходим.
import {
  parseStartParam, parseStartCommand, gameUrl, miniAppLink, shareLink, openButton, createTelegramBot
} from '../server/telegram.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const eq = (n, g, w) => { JSON.stringify(g) === JSON.stringify(w) ? ok++ : (fail++, console.error('✗', n, 'получили', JSON.stringify(g), 'ждали', JSON.stringify(w))); };

// === чистые помощники ===
eq('start_param: id партии', parseStartParam('OpeF4yg'), 'OpeF4yg');
eq('start_param: мусор — null', parseStartParam('../../etc'), null);
eq('start_param: пусто — null', parseStartParam(''), null);
eq('start_param: не строка — null', parseStartParam(42), null);
eq('/start без параметра', parseStartCommand('/start'), { param: null });
eq('/start с id', parseStartCommand('/start OpeF4yg'), { param: 'OpeF4yg' });
eq('/start@bot с id', parseStartCommand('/start@seabattle_bot OpeF4yg '), { param: 'OpeF4yg' });
eq('/start с мусором — команда без параметра', parseStartCommand('/start <script>'), { param: null });
eq('не /start — null', parseStartCommand('привет'), null);
eq('/starting — не команда', parseStartCommand('/starting'), null);
eq('gameUrl с id', gameUrl('https://sb.ua/', 'abc123'), 'https://sb.ua/game/abc123');
eq('gameUrl без id — база без хвостового слэша', gameUrl('https://sb.ua/', null), 'https://sb.ua');
eq('miniAppLink с партией', miniAppLink('seabattle_bot', 'abc123'), 'https://t.me/seabattle_bot?startapp=abc123');
eq('miniAppLink без партии', miniAppLink('seabattle_bot', null), 'https://t.me/seabattle_bot');
yes('shareLink кодирует url и текст', shareLink('b', 'x1234', 'Заходи & играй') ===
  'https://t.me/share/url?url=' + encodeURIComponent('https://t.me/b?startapp=x1234') + '&text=' + encodeURIComponent('Заходи & играй'));
eq('кнопка https → web_app', openButton('Открыть', 'https://sb.ua/game/x'), { text: 'Открыть', web_app: { url: 'https://sb.ua/game/x' } });
eq('кнопка http (локалка) → обычная url', openButton('Открыть', 'http://localhost:3456/game/x'), { text: 'Открыть', url: 'http://localhost:3456/game/x' });

// === бот с подменённым fetch ===
const calls = [];
let getUpdatesQueue = [];
const fakeFetch = async (url, init) => {
  const method = url.split('/').pop();
  const body = JSON.parse(init.body);
  calls.push({ method, body });
  if (method === 'getUpdates') {
    const next = getUpdatesQueue.shift();
    if (next instanceof Error) throw next;
    return { status: 200, json: async () => ({ ok: true, result: next || [] }) };
  }
  if (method === 'sendMessage' && body.chat_id === 'boom') return { status: 403, json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }) };
  return { status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
};
const dict = {
  'mail.nudge.tg': '{{nick}}, твой ход: {{url}}', 'mail.nudge.tgBtn': 'Сделать ход',
  'mail.tg.welcome': 'Привет', 'mail.tg.open': 'Открыть игру', 'mail.tg.join': 'Зовут', 'mail.tg.joinBtn': 'Присоединиться'
};
const t = async (lang, key, params = {}) => String(dict[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, k) => params[k] ?? '') + (lang ? `|${lang}` : '');
const quiet = { log() {}, error() {} };
const bot = createTelegramBot({ token: 'T0K', baseUrl: 'https://sb.ua/', t, fetchImpl: fakeFetch, log: quiet, pollTimeoutS: 0 });

{
  const sent = await bot.sendNudge(42, 'Іван', 'https://sb.ua/game/abc', 'uk');
  yes('напоминание ушло', sent === true);
  const c = calls.at(-1);
  yes('…в Bot API sendMessage с токеном', c.method === 'sendMessage');
  eq('…в нужный чат', c.body.chat_id, 42);
  eq('…текст на языке адресата с ником и ссылкой', c.body.text, 'Іван, твой ход: https://sb.ua/game/abc|uk');
  eq('…кнопка web_app в партию', c.body.reply_markup.inline_keyboard[0][0], { text: 'Сделать ход|uk', web_app: { url: 'https://sb.ua/game/abc' } });
  yes('без chat id — не шлём', (await bot.sendNudge(null, 'x', 'u', 'ru')) === false && calls.at(-1) === c);
  yes('бот заблокирован — false, не исключение', (await bot.sendNudge('boom', 'x', 'https://sb.ua/game/1', 'ru')) === false);
}
{
  await bot.replyToMessage({ chat: { id: 7 }, from: { language_code: 'en-GB' }, text: '/start' });
  const c = calls.at(-1);
  eq('/start → приветствие на языке отправителя', c.body.text, 'Привет|en');
  eq('/start → кнопка «Открыть игру» на главную', c.body.reply_markup.inline_keyboard[0][0], { text: 'Открыть игру|en', web_app: { url: 'https://sb.ua' } });
  await bot.replyToMessage({ chat: { id: 7 }, from: {}, text: '/start OpeF4yg' });
  const j = calls.at(-1);
  eq('/start <id> → «зовут в партию»', j.body.text, 'Зовут');
  eq('/start <id> → кнопка в лобби партии', j.body.reply_markup.inline_keyboard[0][0].web_app.url, 'https://sb.ua/game/OpeF4yg');
  await bot.replyToMessage({ chat: { id: 7 }, from: {}, text: 'как играть?' });
  eq('любой другой текст → приветствие с кнопкой', calls.at(-1).body.text, 'Привет');
  yes('сообщение без чата — игнор', (await bot.replyToMessage({ text: '/start' })) === null);
}
{
  const before = calls.length;
  getUpdatesQueue = [[
    { update_id: 10, message: { chat: { id: 1 }, from: {}, text: '/start' } },
    { update_id: 11, message: { chat: { id: 2 }, from: {}, text: '/start OpeF4yg' } },
    { update_id: 12, message: { chat: { id: 3 } } }            // без текста — пропустить
  ]];
  const n = await bot.pollOnce();
  eq('pollOnce вернул число апдейтов', n, 3);
  eq('offset = последний update_id + 1', bot.offset, 13);
  eq('ответили только на два текстовых', calls.slice(before).filter(c => c.method === 'sendMessage').length, 2);
  const upd = calls.slice(before).find(c => c.method === 'getUpdates');
  eq('getUpdates просит только сообщения', upd.body.allowed_updates, ['message']);
  getUpdatesQueue = [[{ update_id: 20, message: { chat: { id: 9 }, from: {}, text: '/start' } }]];
  await bot.pollOnce();
  eq('следующий опрос идёт с новым offset', calls.at(-2).body.offset, 13);
  eq('offset двигается дальше', bot.offset, 21);
  getUpdatesQueue = [new Error('network down')];
  let threw = false;
  try { await bot.pollOnce(); } catch { threw = true; }
  yes('ошибка сети из pollOnce всплывает (цикл startPolling её ловит и ждёт)', threw);
}

console.log(fail ? `❌ test-telegram: провалено ${fail}, прошло ${ok}` : `✅ test-telegram: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
