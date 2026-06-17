// HTTP + WebSocket сервер. Игра живёт по ссылке /game/<id>.
//
// Необязательные переменные окружения:
//   DATABASE_URL (или DB_HOST/DB_USER/DB_PASSWORD/DB_NAME) — подключение к MySQL (см. db.js)
//   GOOGLE_CLIENT_ID — включает «Войти через Google»
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM — включают письма «поторопить»
//   BASE_URL — адрес сайта для ссылок в письмах (например https://game.example.ua)
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import * as db from './db.js';
import {
  createGame, addPlayer, startGame, applyAction, leaveGame, nudge,
  timeoutTurn, publicState, setColor, randomFreeColor, forceFinish, PALETTE
} from './game.js';
import { chooseBotAction, BOT_NAMES } from './bot.js';
import { BROADSIDE_ENABLED } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// --- Google Sign-In (опционально) ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
let googleClient = null;
if (GOOGLE_CLIENT_ID) {
  const { OAuth2Client } = await import('google-auth-library');
  googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  console.log('🔑 Google Sign-In включён');
}

// --- Почта (опционально) ---
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const nodemailer = (await import('nodemailer')).default;
  const smtpPort = +(process.env.SMTP_PORT || 465);
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log('📯 Почтовые уведомления включены');
}

async function sendNudgeEmail(email, nick, gameUrl) {
  if (!mailer || !email) return false;
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: '⚓ Морской бой: твой ход! Даём 10 минут',
      text: `Привет, ${nick}!\n\nСоперники тебя торопят: сейчас твой ход, и у тебя 10 минут — иначе ход будет пропущен.\n\nИграть: ${gameUrl}\n`,
      html: `<p>Привет, <b>${nick}</b>!</p>
<p>Соперники тебя торопят: сейчас твой ход, и у тебя <b>10 минут</b> — иначе ход будет пропущен.</p>
<p><a href="${gameUrl}">⚓ Сделать ход</a></p>`
    });
    return true;
  } catch (e) {
    console.error('Письмо не отправлено:', e.message);
    return false;
  }
}

// Личность: секрет (гостевой токен или серверная сессия Google) живёт в браузере,
// сервер везде использует его производный id.
const pidOf = token => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);

// Серверные сессии Google-входа: token -> pid. Держим в памяти (предзагружаем на старте,
// дополняем при логине) — чтобы resolvePid оставался синхронным.
const sessionPids = new Map();

function resolvePid({ token, session }) {
  if (session) {
    const pid = sessionPids.get(session);
    if (pid) return pid;
  }
  return token ? pidOf(token) : null;
}

// Игры в памяти — источник истины в рантайме (single-instance). Все игры предзагружаются
// из MySQL на старте, а изменения асинхронно сохраняются обратно (durability на деплой).
const games = new Map();

function getGame(id) {
  return games.get(id) || null;
}

// Персональная рассылка состояния: каждому сокету — со своей видимостью золота.
async function broadcastState(game) {
  const sockets = await io.in('game:' + game.id).fetchSockets();
  for (const s of sockets) s.emit('state', publicState(game, s.data.pid));
}

function persistAndBroadcast(game) {
  db.saveGame(game);
  broadcastState(game);
  maybeBotTurn(game);
  broadcastLobbies(); // слоты/статус лобби могли измениться
}

// --- браузер открытых лобби ---
const LOBBY_MAX_AGE = 60 * 60 * 1000; // не показываем заброшенные старше часа
function lobbyListData() {
  const now = Date.now();
  const list = [];
  for (const g of games.values()) {
    if (g.status === 'lobby' && g.config?.listed && g.players.length > 0 &&
        now - g.createdAt < LOBBY_MAX_AGE) {
      list.push({
        id: g.id, host: g.players[0].nick,
        players: g.players.length, max: g.config.maxPlayers,
        turnTimer: g.config.turnTimer, createdAt: g.createdAt
      });
    }
  }
  return list.sort((a, b) => b.createdAt - a.createdAt);
}
function broadcastLobbies() {
  io.to('lobbies').emit('lobbyList', lobbyListData());
}

// --- ходы ботов ---
const BOT_DELAY_MS = +(process.env.BOT_DELAY_MS || 1500);
const botTimers = new Map();

function maybeBotTurn(game) {
  if (game.status !== 'active') return;
  const cur = game.players[game.turn.idx];
  if (!cur?.isBot || botTimers.has(game.id)) return;
  botTimers.set(game.id, setTimeout(() => {
    botTimers.delete(game.id);
    const g = getGame(game.id);
    if (!g || g.status !== 'active') return;
    const bot = g.players[g.turn.idx];
    if (!bot?.isBot) return;
    let action;
    try { action = chooseBotAction(g, g.turn.idx, bot.botLevel); }
    catch (e) { console.error('bot:', e.message); action = { type: 'skip' }; }
    let r = applyAction(g, bot.id, action);
    if (!r.ok) r = applyAction(g, bot.id, { type: 'skip' }); // страховка от невалидного хода
    if (g.status === 'finished') db.saveResults(g);
    persistAndBroadcast(g);
  }, BOT_DELAY_MS));
}

// Все живые игроки-люди сдались → не заставляем смотреть, как боты доигрывают:
// прогоняем доигровку за ботов синхронно и завершаем партию (победитель — кто выстоял).
function maybeAutoFinish(game) {
  if (game.status !== 'active') return;
  if (game.players.some(p => p.alive && !p.isBot)) return; // ещё есть живые люди
  let guard = 0;
  while (game.status === 'active' && guard++ < 4000) {
    const cur = game.players[game.turn.idx];
    if (!cur?.alive) break; // подстраховка (advanceTurn и так пропускает выбывших)
    let action;
    try { action = chooseBotAction(game, game.turn.idx, cur.botLevel || 'mid'); }
    catch { action = { type: 'skip' }; }
    if (!applyAction(game, cur.id, action).ok) applyAction(game, cur.id, { type: 'skip' });
  }
  if (game.status === 'active') forceFinish(game); // уперлись в лимит — победитель по силе
  clearTimeout(timers.get(game.id));
}

// --- REST ---

app.get('/api/config', (_req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, palette: PALETTE, broadside: BROADSIDE_ENABLED }));

app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(400).json({ error: 'Вход через Google не настроен' });
  try {
    const { credential, nick } = req.body || {};
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const pid = 'g' + crypto.createHash('sha256').update(payload.sub).digest('hex').slice(0, 15);
    const finalNick = (nick || '').trim() || payload.name || payload.email.split('@')[0];
    db.upsertPlayer(pid, finalNick, payload.email);
    const session = crypto.randomBytes(24).toString('base64url');
    sessionPids.set(session, pid);
    db.createSession(session, pid);
    res.json({ session, nick: finalNick, email: payload.email });
  } catch (e) {
    console.error('Google auth:', e.message);
    res.status(401).json({ error: 'Не удалось проверить вход Google' });
  }
});

app.post('/api/games', (req, res) => {
  const { token, session, nick, maxPlayers, turnTimer, mode, nicks, color, colors } = req.body || {};
  const pid = resolvePid({ token, session });
  if (!pid) return res.status(400).json({ error: 'Нужен токен' });
  const id = crypto.randomBytes(5).toString('base64url');

  // хотсит: все игроки вводятся сразу, лобби нет — игра стартует мгновенно
  if (mode === 'hotseat') {
    const names = (Array.isArray(nicks) ? nicks : []).map(s => String(s || '').trim()).filter(Boolean);
    if (names.length < 2 || names.length > 4) return res.status(400).json({ error: 'Нужно 2–4 имени игроков' });
    const cols = Array.isArray(colors) ? colors : [];
    const game = createGame(id, { maxPlayers: names.length, turnTimer: 0 });
    game.config.hotseat = true;
    game.hotseatOwner = pid;
    names.forEach((n, i) => {
      db.upsertPlayer(pid + '#' + i, n);
      addPlayer(game, pid + '#' + i, n, cols[i]);
    });
    startGame(game, pid + '#0');
    games.set(id, game);
    db.saveGame(game);
    return res.json({ gameId: id });
  }

  // против компьютера: человек + 1-3 бота, старт сразу
  if (mode === 'bot') {
    const level = ['easy', 'mid', 'hard'].includes(req.body.level) ? req.body.level : 'mid';
    const botCount = Math.min(3, Math.max(1, +req.body.bots || 1));
    if (!nick?.trim()) return res.status(400).json({ error: 'Нужен ник' });
    const game = createGame(id, { maxPlayers: 1 + botCount, turnTimer: 0 });
    game.config.botGame = true;
    game.config.fog = req.body.fog !== false; // туман войны (по умолчанию вкл), визуал для игрока
    db.upsertPlayer(pid, nick.trim());
    addPlayer(game, pid, nick.trim(), color);              // цвет игрока — по выбору
    for (let i = 0; i < botCount; i++) {
      addPlayer(game, 'bot:' + id + ':' + i, BOT_NAMES[level][i], randomFreeColor(game)); // ботам — рандом из оставшихся
      const bp = game.players[game.players.length - 1];
      bp.isBot = true;
      bp.botLevel = level;
    }
    startGame(game, pid);
    games.set(id, game);
    db.saveGame(game);
    return res.json({ gameId: id });
  }

  if (!nick?.trim()) return res.status(400).json({ error: 'Нужны ник и токен' });
  const game = createGame(id, { maxPlayers: +maxPlayers, turnTimer: +turnTimer });
  game.config.listed = true; // онлайн-игра попадает в браузер лобби
  game.config.fog = req.body.fog !== false; // туман войны (по умолчанию вкл)
  db.upsertPlayer(pid, nick.trim());
  addPlayer(game, pid, nick.trim(), color);
  games.set(id, game);
  db.saveGame(game);
  res.json({ gameId: id });
  broadcastLobbies();
});

app.get('/api/leaderboard', async (_req, res) => res.json(await db.getLeaderboard()));

app.get('/game/:id', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'game.html')));

// --- WebSocket ---

io.on('connection', socket => {
  let joinedGameId = null;
  let myPid = null;

  // подписка на браузер лобби (с главной страницы)
  socket.on('lobbies:subscribe', ack => {
    socket.join('lobbies');
    ack?.(lobbyListData());
  });
  socket.on('lobbies:unsubscribe', () => socket.leave('lobbies'));

  socket.on('join', ({ gameId, token, session, nick, color }, ack) => {
    const game = getGame(gameId);
    if (!game) return ack?.({ ok: false, error: 'Игра не найдена' });
    const pid = resolvePid({ token, session });
    if (!pid || !nick?.trim()) return ack?.({ ok: false, error: 'Введите ник' });
    // хотсит: владелец устройства управляет всеми игроками
    const isHotseatOwner = !!(game.config?.hotseat && game.hotseatOwner === pid);
    if (isHotseatOwner) {
      joinedGameId = gameId;
      myPid = pid;
      socket.data.pid = pid;
      socket.join('game:' + gameId);
      ack?.({ ok: true, playerId: pid, spectator: false, hotseatOwner: true });
      socket.emit('state', publicState(game, pid));
      return;
    }
    db.upsertPlayer(pid, nick.trim());
    const result = addPlayer(game, pid, nick.trim(), color);
    // Не участник, но игра идёт — пускаем смотреть.
    const spectator = !result.ok && game.status !== 'lobby' && !game.players.some(p => p.id === pid);
    if (!result.ok && !spectator) return ack?.({ ok: false, error: result.error });
    joinedGameId = gameId;
    myPid = pid;
    socket.data.pid = pid;
    socket.join('game:' + gameId);
    db.saveGame(game);
    ack?.({ ok: true, playerId: pid, spectator });
    broadcastState(game);
    broadcastLobbies(); // обновить число игроков в витрине
  });

  socket.on('setColor', ({ color } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    const result = setColor(game, myPid, color);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    db.saveGame(game);
    broadcastState(game);
    broadcastLobbies();
    ack?.({ ok: true });
  });

  // добавить бота в онлайн-лобби (только создатель; ботов не больше половины мест)
  socket.on('addBot', ({ level } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    if (game.status !== 'lobby') return ack?.({ ok: false, error: 'Игра уже идёт' });
    if (game.players[0]?.id !== myPid) return ack?.({ ok: false, error: 'Ботов добавляет только создатель' });
    const lvl = ['easy', 'mid', 'hard'].includes(level) ? level : 'mid';
    const botCount = game.players.filter(p => p.isBot).length;
    const limit = Math.floor(game.config.maxPlayers / 2); // боты — максимум половина слотов
    if (botCount >= limit) return ack?.({ ok: false, error: `Ботов не больше ${limit} (половина мест — за людьми)` });
    if (game.players.length >= game.config.maxPlayers) return ack?.({ ok: false, error: 'Все слоты заняты' });
    const botId = 'bot:' + game.id + ':' + botCount + ':' + crypto.randomBytes(2).toString('hex');
    const name = BOT_NAMES[lvl][botCount] || ('Бот ' + (botCount + 1));
    addPlayer(game, botId, name, randomFreeColor(game));
    const bp = game.players[game.players.length - 1];
    bp.isBot = true; bp.botLevel = lvl;
    db.saveGame(game);
    broadcastState(game);
    broadcastLobbies();
    ack?.({ ok: true });
  });

  // убрать бота из лобби (только создатель)
  socket.on('removeBot', ({ botId } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    if (game.status !== 'lobby') return ack?.({ ok: false, error: 'Игра уже идёт' });
    if (game.players[0]?.id !== myPid) return ack?.({ ok: false, error: 'Только создатель' });
    const idx = game.players.findIndex(p => p.id === botId && p.isBot);
    if (idx === -1) return ack?.({ ok: false, error: 'Бот не найден' });
    game.players.splice(idx, 1);
    db.saveGame(game);
    broadcastState(game);
    broadcastLobbies();
    ack?.({ ok: true });
  });

  socket.on('start', (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    // Онлайн-баттл стартует только при 2+ живых игроках-людях. Игра с ботами — это одиночный режим.
    if (game.players.filter(p => !p.isBot).length < 2)
      return ack?.({ ok: false, error: 'Нужно минимум 2 живых игрока. Игра против ботов — в одиночном режиме.' });
    const result = startGame(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    armTurnTimer(game);
    persistAndBroadcast(game);
    ack?.({ ok: true });
  });

  socket.on('action', (action, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    const result = applyAction(game, myPid, action);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    if (game.status === 'finished') db.saveResults(game);
    else armTurnTimer(game);
    persistAndBroadcast(game);
    ack?.({ ok: true });
  });

  // Сдаться (в игре) или выйти (из лобби).
  socket.on('leave', (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    const result = leaveGame(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    maybeAutoFinish(game); // все люди сдались → доигрываем за ботов и завершаем сразу
    if (game.status === 'finished') db.saveResults(game);
    else armTurnTimer(game);
    persistAndBroadcast(game);
    ack?.({ ok: true });
  });

  // Поторопить AFK-игрока: письмо + 10 минут на ход.
  socket.on('nudge', async (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    const result = nudge(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    armTurnTimer(game);
    persistAndBroadcast(game);
    const target = game.players[result.targetIdx];
    const email = await db.getPlayerEmail(target.id);
    const origin = process.env.BASE_URL
      || socket.handshake.headers.origin
      || `http://localhost:${PORT}`;
    sendNudgeEmail(email, target.nick, `${origin}/game/${game.id}`)
      .then(sent => ack?.({ ok: true, emailSent: sent }));
  });

  // отключение: если все ушли из ещё не начавшегося лобби — убираем его из списка
  socket.on('disconnect', async () => {
    if (!joinedGameId) return;
    const game = games.get(joinedGameId);
    if (!game || game.status !== 'lobby') return;
    setTimeout(async () => {
      const g = games.get(joinedGameId);
      if (!g || g.status !== 'lobby') return;
      const sockets = await io.in('game:' + joinedGameId).fetchSockets();
      if (sockets.length === 0) { // в лобби никого не осталось — снимаем с витрины
        games.delete(joinedGameId);
        broadcastLobbies();
      }
    }, 1500); // даём шанс на переподключение/перезагрузку
  });
});

// Таймер хода: один на игру, перевзводится при каждой смене хода.
const timers = new Map();
function armTurnTimer(game) {
  clearTimeout(timers.get(game.id));
  if (game.status !== 'active' || !game.turn.deadline) return;
  const ms = Math.max(250, game.turn.deadline - Date.now());
  timers.set(game.id, setTimeout(() => {
    const g = getGame(game.id);
    if (g && timeoutTurn(g)) {
      armTurnTimer(g);
      persistAndBroadcast(g);
    }
  }, ms));
}

// Старт: подключаемся к MySQL, поднимаем все игры и сессии в память, возобновляем
// таймеры/ходы ботов, и только потом слушаем порт.
async function bootstrap() {
  try {
    await db.init();
    for (const s of await db.getAllSessions()) sessionPids.set(s.token, s.pid);
    let active = 0;
    for (const state of await db.getAllGames()) {
      games.set(state.id, state);
      if (state.status === 'active') {
        armTurnTimer(state); // возобновляем таймер хода после рестарта/деплоя
        maybeBotTurn(state);  // ...и ход бота, если он не успел сходить
        active++;
      }
    }
    console.log(`   поднято игр из базы: ${games.size} (активных: ${active}) — переживут деплой`);
  } catch (e) {
    console.error('❌ Не удалось инициализировать базу данных:', e.message);
    console.error('   Локально база (SQLite) создаётся сама. На проде проверь DATABASE_URL / DB_* (и DB_SSL при необходимости).');
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`⚓ Sea Battle: http://localhost:${PORT}`);
  });
}

bootstrap();
