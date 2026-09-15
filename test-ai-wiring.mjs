// 🔗 Этап 4: подключение ИИ к настоящему серверу (server/index.js).
// Поднимаем сервер в этом же процессе на своём порту и своей временной БД, драйвер
// модели подменяем фейковым — сеть и ключи не нужны. Проверяем ровно то, чего не
// проверить юнит-тестами: доступность в /api/config, создание партии с ИИ, реальный
// ход ИИ по сокету и его реплика в чат.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { io } from 'socket.io-client';

const PORT = 3987;
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ai-')), 'test.db');
process.env.PORT = String(PORT);
process.env.SQLITE_PATH = dbFile;
process.env.BOT_DELAY_MS = '150';          // не ждать «раздумья» бота полторы секунды

const BASE = `http://127.0.0.1:${PORT}`;
let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// ── фейковый капитан: всегда двигает первый свой корабль и подкалывает соперника
const { configureAi } = await import('./server/ai/config.js');
let asked = 0;
configureAi({
  apiKey: 'test-key', taunts: true, retries: 0,
  // контракт драйвера: { plan: <объект плана>, usage }. Плоский объект тут был бы тихим
  // фолбэком на эвристику — и тест «зеленел» бы, ничего не проверяя.
  driver: async () => {
    asked++;
    return {
      plan: {
        plan: 'Иду к центру карты.',
        taunt: 'Молись ветру, салага!',
        actions: [{ type: 'sail', ship: 'M1', to: '20,15', why: 'к центру' }]
      },
      usage: { input: 100, output: 20 }
    };
  }
});

// ── поднимаем сервер (тот самый, боевой) и ждём готовности
await import('./server/index.js');
for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/api/config')).ok) break; } catch { } await wait(100); }

// ── /api/config отдаёт флаг, но НЕ ключ
{
  const cfg = await (await fetch(BASE + '/api/config')).json();
  check('/api/config сообщает, что ИИ доступен', cfg.ai === true);
  check('/api/config перечисляет уровни ИИ', Array.isArray(cfg.aiLevels) && cfg.aiLevels.includes('ai'));
  check('🛡 ключ модели наружу не уходит', !JSON.stringify(cfg).includes('test-key'));
}

// ── партия против ИИ создаётся
const createGame = async level => {
  const r = await fetch(BASE + '/api/games', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'tok-human-' + level, nick: 'Человек', mode: 'bot', level, bots: 1, gameMode: 'classic' })
  });
  return { status: r.status, body: await r.json() };
};
const made = await createGame('ai');
check('партия против ИИ создаётся', made.status === 200 && !!made.body.gameId, JSON.stringify(made.body));

// ── и наоборот: без настроенного ИИ уровень не принимается
{
  configureAi({ enabled: false });
  const denied = await createGame('ai');
  check('без настроенного ИИ уровень «ai» отвергается с понятной ошибкой',
    denied.status === 400 && /ИИ/.test(denied.body.error || ''), JSON.stringify(denied.body));
  configureAi({ enabled: true });
}

// ── реальный ход: человек пропускает, ИИ отвечает ходом и репликой
{
  const gameId = made.body.gameId;
  const socket = io(BASE);
  const chats = [];
  let state = null;
  socket.on('state', st => { state = st; });
  socket.on('chat', m => chats.push(m));
  await new Promise((res, rej) => socket.on('connect', () =>
    socket.emit('join', { gameId, token: 'tok-human-ai', nick: 'Человек' }, r => r.ok ? res() : rej(new Error(r.error)))));
  await wait(200);
  check('игра стартовала сразу (против компьютера)', state?.status === 'active', state?.status);
  const bot = state.players.find(p => p.isBot);
  check('соперник помечен ботом', !!bot, JSON.stringify(state.players.map(p => p.nick)));
  check('у ИИ-капитана своё имя', /🧠/.test(bot.nick), bot.nick);

  const before = JSON.stringify(state.ships.filter(s => s.owner === 1).map(s => [s.x, s.y]));
  await new Promise(r => socket.emit('action', { type: 'skip' }, r));
  for (let i = 0; i < 50 && state.turn.idx !== 0; i++) await wait(100);   // ждём, пока ИИ отходит

  check('модель действительно спросили', asked >= 1, `вызовов ${asked}`);
  check('ход вернулся человеку (партия не зависла)', state.turn.idx === 0, `idx=${state.turn.idx}`);
  const after = state.ships.filter(s => s.owner === 1);
  check('ИИ реально подвинул флот', JSON.stringify(after.map(s => [s.x, s.y])) !== before);
  // приказ был «к центру карты» — эвристика ходит иначе, так что это ещё и проверка,
  // что сработал именно план модели, а не тихий фолбэк
  const toCenter = after.some(s => Math.hypot(s.x - state.map.w / 2, s.y - state.map.h / 2) <
    Math.hypot(state.map.bases[1].x - state.map.w / 2, state.map.bases[1].y - state.map.h / 2));
  check('ИИ пошёл туда, куда велел план (а не в фолбэк)', toCenter);
  check('реплика ИИ ушла в чат партии', chats.some(c => /салага/.test(c.text)), JSON.stringify(chats));
  socket.close();
}

// ── партия с обычным ботом продолжает работать как раньше
{
  const plain = await createGame('hard');
  check('обычный бот не сломался', plain.status === 200 && !!plain.body.gameId);
  const socket = io(BASE);
  let state = null;
  socket.on('state', st => { state = st; });
  await new Promise((res, rej) => socket.on('connect', () =>
    socket.emit('join', { gameId: plain.body.gameId, token: 'tok-human-hard', nick: 'Человек' }, r => r.ok ? res() : rej(new Error(r.error)))));
  await wait(200);
  const asksBefore = asked;
  await new Promise(r => socket.emit('action', { type: 'skip' }, r));
  for (let i = 0; i < 50 && state.turn.idx !== 0; i++) await wait(100);
  check('эвристический бот сходил', state.turn.idx === 0, `idx=${state.turn.idx}`);
  check('эвристический бот модель не дёргает', asked === asksBefore, `${asked} против ${asksBefore}`);
  socket.close();
}

try { fs.rmSync(path.dirname(dbFile), { recursive: true, force: true }); } catch { }
console.log(`\nИтого подключение ИИ: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
