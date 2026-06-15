// HTTP + WebSocket сервер. Игра живёт по ссылке /game/<id>.
//
// Необязательные переменные окружения:
//   DB_PATH — путь к файлу базы (держи ВНЕ папки сайта, чтобы деплой не затирал игры)
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
  timeoutTurn, publicState
} from './game.js';
import { chooseBotAction, BOT_NAMES } from './bot.js';

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

function resolvePid({ token, session }) {
  if (session) {
    const pid = db.getSessionPid(session);
    if (pid) return pid;
  }
  return token ? pidOf(token) : null;
}

// Активные игры в памяти; SQLite — источник истины (переживает рестарт).
const games = new Map();

function getGame(id) {
  if (games.has(id)) return games.get(id);
  const state = db.loadGame(id);
  if (state) {
    games.set(id, state);
    armTurnTimer(state); // после рестарта сервера возобновляем таймер хода
    maybeBotTurn(state); // ...и ход бота, если сервер уснул на его очереди
    return state;
  }
  return null;
}

function persistAndBroadcast(game) {
  db.saveGame(game);
  io.to('game:' + game.id).emit('state', publicState(game));
  maybeBotTurn(game);
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

// --- REST ---

app.get('/api/config', (_req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID }));

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
    db.createSession(session, pid);
    res.json({ session, nick: finalNick, email: payload.email });
  } catch (e) {
    console.error('Google auth:', e.message);
    res.status(401).json({ error: 'Не удалось проверить вход Google' });
  }
});

app.post('/api/games', (req, res) => {
  const { token, session, nick, maxPlayers, turnTimer, mode, nicks } = req.body || {};
  const pid = resolvePid({ token, session });
  if (!pid) return res.status(400).json({ error: 'Нужен токен' });
  const id = crypto.randomBytes(5).toString('base64url');

  // хотсит: все игроки вводятся сразу, лобби нет — игра стартует мгновенно
  if (mode === 'hotseat') {
    const names = (Array.isArray(nicks) ? nicks : []).map(s => String(s || '').trim()).filter(Boolean);
    if (names.length < 2 || names.length > 4) return res.status(400).json({ error: 'Нужно 2–4 имени игроков' });
    const game = createGame(id, { maxPlayers: names.length, turnTimer: 0 });
    game.config.hotseat = true;
    game.hotseatOwner = pid;
    names.forEach((n, i) => {
      db.upsertPlayer(pid + '#' + i, n);
      addPlayer(game, pid + '#' + i, n);
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
    db.upsertPlayer(pid, nick.trim());
    addPlayer(game, pid, nick.trim());
    for (let i = 0; i < botCount; i++) {
      addPlayer(game, 'bot:' + id + ':' + i, BOT_NAMES[level][i]);
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
  db.upsertPlayer(pid, nick.trim());
  addPlayer(game, pid, nick.trim());
  games.set(id, game);
  db.saveGame(game);
  res.json({ gameId: id });
});

app.get('/api/leaderboard', (_req, res) => res.json(db.getLeaderboard()));

app.get('/game/:id', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'game.html')));

// --- WebSocket ---

io.on('connection', socket => {
  let joinedGameId = null;
  let myPid = null;

  socket.on('join', ({ gameId, token, session, nick }, ack) => {
    const game = getGame(gameId);
    if (!game) return ack?.({ ok: false, error: 'Игра не найдена' });
    const pid = resolvePid({ token, session });
    if (!pid || !nick?.trim()) return ack?.({ ok: false, error: 'Введите ник' });
    // хотсит: владелец устройства управляет всеми игроками
    const isHotseatOwner = !!(game.config?.hotseat && game.hotseatOwner === pid);
    if (isHotseatOwner) {
      joinedGameId = gameId;
      myPid = pid;
      socket.join('game:' + gameId);
      ack?.({ ok: true, playerId: pid, spectator: false, hotseatOwner: true });
      socket.emit('state', publicState(game));
      return;
    }
    db.upsertPlayer(pid, nick.trim());
    const result = addPlayer(game, pid, nick.trim());
    // Не участник, но игра идёт — пускаем смотреть.
    const spectator = !result.ok && game.status !== 'lobby' && !game.players.some(p => p.id === pid);
    if (!result.ok && !spectator) return ack?.({ ok: false, error: result.error });
    joinedGameId = gameId;
    myPid = pid;
    socket.join('game:' + gameId);
    db.saveGame(game);
    ack?.({ ok: true, playerId: pid, spectator });
    io.to('game:' + gameId).emit('state', publicState(game));
  });

  socket.on('start', (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
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
    if (game.status === 'finished') db.saveResults(game);
    else armTurnTimer(game);
    persistAndBroadcast(game);
    ack?.({ ok: true });
  });

  // Поторопить AFK-игрока: письмо + 10 минут на ход.
  socket.on('nudge', (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    const result = nudge(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    armTurnTimer(game);
    persistAndBroadcast(game);
    const target = game.players[result.targetIdx];
    const email = db.getPlayerEmail(target.id);
    const origin = process.env.BASE_URL
      || socket.handshake.headers.origin
      || `http://localhost:${PORT}`;
    sendNudgeEmail(email, target.nick, `${origin}/game/${game.id}`)
      .then(sent => ack?.({ ok: true, emailSent: sent }));
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

server.listen(PORT, () => {
  console.log(`⚓ Sea Battle: http://localhost:${PORT}`);
  console.log(`   игр в базе: ${db.countGames()} (переживут перезапуск/деплой)`);
});
