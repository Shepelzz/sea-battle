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
  timeoutTurn, publicState, setColor, randomFreeColor, forceFinish, isRanked, PALETTE
} from './game.js';
import {
  SESSION_COOKIE, pidOf, googlePid, cleanNick, resolveAccountNick, parseCookies,
  buildSetCookie, buildClearCookie, createSessionStore, newSessionToken
} from './auth.js';
import { chooseBotAction, BOT_NAMES, duelFleetPlan } from './bot.js';
import { applyCheat } from './cheats.js';
import { CHEATS_ENABLED, GAME_MODES, enabledModes, DEFAULT_MODE, isDuel } from './config.js';
// валидируем игровой режим из запроса (classic/deathmatch/develop) — только из включённых
const pickMode = m => enabledModes().includes(m) ? m : DEFAULT_MODE;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // за прокси (Render): корректный протокол — нужно для Secure-cookie
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

// Личность: pidOf (гость) и googlePid (аккаунт) — в auth.js. Серверные сессии Google-входа
// держим в памяти (грузим на старте, дополняем при логине) — pid аккаунта резолвится синхронно.
const cookieSecure = () => process.env.NODE_ENV === 'production' || /^https:/i.test(process.env.BASE_URL || '');
const sessions = createSessionStore();
// pid аккаунта по cookie-токену (с проверкой срока) или null; протухшую сессию чистим и в БД.
const accountPidFromSession = token => sessions.pid(token, t => db.deleteSession(t));
const accountPidFromReq = req => accountPidFromSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

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
  maybeBotBuy(game);   // дуэль: боты собирают флот в фазе закупки (до рассылки состояния)
  db.saveGame(game);
  broadcastState(game);
  maybeBotTurn(game);
  broadcastLobbies(); // слоты/статус лобби могли измениться
}

// Дуэль, фаза закупки: каждый бот сразу собирает флот (умно, на всё золото). Когда все готовы —
// applyAction(buyFleet) сам переключит игру в фазу боя.
function maybeBotBuy(game) {
  if (game?.phase !== 'buy') return;
  for (let i = 0; i < game.players.length; i++) {
    const p = game.players[i];
    if (p.isBot && !p.ready) applyAction(game, p.id, { type: 'buyFleet', ships: duelFleetPlan(game, i, p.botLevel || 'mid') });
  }
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
const BOT_FOLLOWUP_MS = +(process.env.BOT_FOLLOWUP_MS || 650); // быстрее на 2-3-м судне того же хода
const botTimers = new Map();
const botStep = new Map(); // gameId -> "idx:number" последней суб-акции (для распознавания продолжения хода)

function maybeBotTurn(game) {
  if (game.status !== 'active') return;
  const cur = game.players[game.turn.idx];
  if (!cur?.isBot || botTimers.has(game.id)) return;
  // первый ход бота в свой ход — пауза «на раздумье»; последующие суда того же хода — быстрее
  const stepKey = game.turn.idx + ':' + game.turn.number;
  const delay = botStep.get(game.id) === stepKey ? BOT_FOLLOWUP_MS : BOT_DELAY_MS;
  botStep.set(game.id, stepKey);
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
    if (g.status === 'finished' && isRanked(g)) db.saveResults(g); // в лидерборд — только онлайн
    persistAndBroadcast(g);
  }, delay));
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

app.get('/api/config', (_req, res) => res.json({
  googleClientId: GOOGLE_CLIENT_ID, palette: PALETTE, cheats: CHEATS_ENABLED,
  // доступные игровые режимы (для селектора при создании игры)
  modes: enabledModes().map(k => ({ key: k, name: GAME_MODES[k].name, desc: GAME_MODES[k].desc }))
}));

app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(400).json({ error: 'Вход через Google не настроен' });
  try {
    const { credential, nick } = req.body || {};
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    // Личность аккаунта — стабильный pid из Google sub (а не из email: email может меняться).
    const pid = googlePid(payload.sub);
    // Ник аккаунта = его сохранённый ник (вспоминаем при возврате). Ник от клиента берём ТОЛЬКО при
    // ПЕРВОМ входе (аккаунта ещё нет) — иначе устаревший/чужой ник из localStorage затёр бы свой.
    const existing = await db.getPlayer(pid);
    const finalNick = resolveAccountNick(existing?.nick, nick, payload.name, payload.email);
    const avatar = payload.picture || null;
    db.upsertPlayer(pid, finalNick, payload.email, 'google', avatar);
    // Серверная сессия: секрет в httpOnly-cookie (недоступна из JS — защита от XSS-кражи).
    const session = newSessionToken();
    sessions.add(session, pid);
    db.createSession(session, pid);
    res.append('Set-Cookie', buildSetCookie(session, { secure: cookieSecure() }));
    res.json({ nick: finalNick, email: payload.email, avatar });
  } catch (e) {
    console.error('Google auth:', e.message);
    res.status(401).json({ error: 'Не удалось проверить вход Google' });
  }
});

// Кто я (по cookie-сессии). Email/аватар отдаём только владельцу — не в публичный стейт.
app.get('/api/auth/me', async (req, res) => {
  const pid = accountPidFromReq(req);
  if (!pid) return res.json({ loggedIn: false });
  const prof = await db.getPlayer(pid);
  res.json({ loggedIn: true, nick: prof?.nick || '', email: prof?.email || '', avatar: prof?.avatar || '' });
});

// Выход: инвалидируем серверную сессию и стираем cookie.
app.post('/api/auth/logout', (req, res) => {
  const session = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (session) { sessions.delete(session); db.deleteSession(session); }
  res.append('Set-Cookie', buildClearCookie({ secure: cookieSecure() }));
  res.json({ ok: true });
});

app.post('/api/games', (req, res) => {
  const { token, nick, maxPlayers, turnTimer, mode, nicks, color, colors } = req.body || {};
  const accountPid = accountPidFromReq(req);                 // вошёл через Google? (по cookie)
  const pid = accountPid || (token ? pidOf(token) : null);   // иначе — гостевой токен (одиночка/хотсит)
  if (!pid) return res.status(400).json({ error: 'Нужен токен' });
  const id = crypto.randomBytes(5).toString('base64url');

  // хотсит: все игроки вводятся сразу, лобби нет — игра стартует мгновенно
  if (mode === 'hotseat') {
    const names = (Array.isArray(nicks) ? nicks : []).map(s => String(s || '').trim()).filter(Boolean);
    if (names.length < 2 || names.length > 4) return res.status(400).json({ error: 'Нужно 2–4 имени игроков' });
    const cols = Array.isArray(colors) ? colors : [];
    const game = createGame(id, { maxPlayers: names.length, turnTimer: 0 });
    game.config.hotseat = true;
    game.config.multiMove = req.body.multiMove !== false; // ход тремя судами (по умолчанию вкл)
    game.config.mode = pickMode(req.body.gameMode);        // режим (до addPlayer — влияет на старт. золото)
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
    const gmode = pickMode(req.body.gameMode);
    const duel = !!GAME_MODES[gmode]?.duel;
    const botCount = duel ? 1 : Math.min(3, Math.max(1, +req.body.bots || 1)); // дуэль — ровно 1 бот (1на1)
    const nm = cleanNick(nick);
    if (!nm) return res.status(400).json({ error: 'Нужен ник' });
    const game = createGame(id, { maxPlayers: 1 + botCount, turnTimer: 0 });
    game.config.botGame = true;
    game.config.fog = req.body.fog !== false; // туман войны (по умолчанию вкл), визуал для игрока
    game.config.multiMove = req.body.multiMove !== false; // ход тремя судами (по умолчанию вкл)
    game.config.mode = gmode;                             // режим (до addPlayer — влияет на старт. золото)
    db.upsertPlayer(pid, nm);
    addPlayer(game, pid, nm, color);                      // цвет игрока — по выбору
    for (let i = 0; i < botCount; i++) {
      addPlayer(game, 'bot:' + id + ':' + i, BOT_NAMES[level][i], randomFreeColor(game)); // ботам — рандом из оставшихся
      const bp = game.players[game.players.length - 1];
      bp.isBot = true;
      bp.botLevel = level;
    }
    startGame(game, pid);
    maybeBotBuy(game);   // дуэль: бот сразу собирает свой флот (фаза закупки)
    games.set(id, game);
    db.saveGame(game);
    return res.json({ gameId: id });
  }

  // Онлайн-баттл требует аккаунт (когда вход через Google настроен) — гостя не пускаем.
  if (googleClient && !accountPid)
    return res.status(401).json({ error: 'Войдите через Google, чтобы играть онлайн', needAuth: true });
  const nm = cleanNick(nick);
  if (!nm) return res.status(400).json({ error: 'Нужны ник и токен' });
  const gmode = pickMode(req.body.gameMode);
  const maxP = GAME_MODES[gmode]?.duel ? 2 : +maxPlayers; // дуэль — строго 1 на 1
  const game = createGame(id, { maxPlayers: maxP, turnTimer: +turnTimer });
  game.config.listed = true; // онлайн-игра попадает в браузер лобби (и засчитывается в лидерборд)
  game.config.fog = req.body.fog !== false; // туман войны (по умолчанию вкл)
  game.config.multiMove = req.body.multiMove !== false; // ход тремя судами (по умолчанию вкл)
  game.config.mode = gmode;                             // режим (до addPlayer — влияет на старт. золото)
  db.upsertPlayer(pid, nm);
  addPlayer(game, pid, nm, color);
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
  // pid аккаунта по cookie-сессии (один раз на подключение) — для гейта онлайна
  socket.data.accountPid = accountPidFromSession(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]);

  // подписка на браузер лобби (с главной страницы)
  socket.on('lobbies:subscribe', ack => {
    socket.join('lobbies');
    ack?.(lobbyListData());
  });
  socket.on('lobbies:unsubscribe', () => socket.leave('lobbies'));

  socket.on('join', ({ gameId, token, nick, color }, ack) => {
    const game = getGame(gameId);
    if (!game) return ack?.({ ok: false, error: 'Игра не найдена' });
    const accountPid = socket.data.accountPid;
    // Онлайн-участие (вход в лобби) требует аккаунт; смотреть уже идущую игру можно и гостю.
    if (game.config?.listed && googleClient && game.status === 'lobby' && !accountPid)
      return ack?.({ ok: false, error: 'Войдите через Google, чтобы играть онлайн', needAuth: true });
    const pid = accountPid || (token ? pidOf(token) : null);
    const nm = cleanNick(nick);
    if (!pid || !nm) return ack?.({ ok: false, error: 'Введите ник' });
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
    db.upsertPlayer(pid, nm);
    const result = addPlayer(game, pid, nm, color);
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

  // Сменить свой ник (в лобби или в игре): обновляем у игрока, ЖЁСТКО пишем в БД (аккаунт запомнит
  // ник — он же в лидерборде) и тут же рассылаем всем в комнате, чтобы соперники увидели в реальном времени.
  socket.on('setNick', ({ nick } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    const nm = cleanNick(nick);
    if (!nm) return ack?.({ ok: false, error: 'Ник не может быть пустым' });
    const p = game.players.find(pl => pl.id === myPid);
    if (!p) return ack?.({ ok: false, error: 'Ты не участник этой игры' });
    p.nick = nm;
    db.upsertPlayer(myPid, nm);   // железно в БД — ник аккаунта меняется везде (вкл. лидерборд)
    db.saveGame(game);
    broadcastState(game);
    broadcastLobbies();           // в витрине лобби имя хоста могло измениться
    ack?.({ ok: true });
  });

  // добавить бота в онлайн-лобби (только создатель; ботов не больше половины мест)
  socket.on('addBot', ({ level } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    if (game.status !== 'lobby') return ack?.({ ok: false, error: 'Игра уже идёт' });
    if (isDuel(game)) return ack?.({ ok: false, error: 'Дуэль — это 1 на 1 с живым игроком. Для игры с ботом выбери «Против компьютера».' });
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
    if (game.status === 'finished' && isRanked(game)) db.saveResults(game); // в лидерборд — только онлайн
    else armTurnTimer(game);
    persistAndBroadcast(game);
    ack?.({ ok: true });
  });

  // Строка ввода: клиент шлёт введённый текст. Если это команда из секретного списка (cheats.js,
  // в клиент не попадает) — применяем её игроку. Любой другой текст рассылаем всем как сообщение
  // (эфемерный чат-нотиф, не в журнал). Так панель выглядит обычным чатом, а команды скрыты.
  socket.on('msg', ({ text } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game || game.status !== 'active') return ack?.({ ok: false });
    let pIdx = game.players.findIndex(p => p.id === myPid);
    if (pIdx === -1 && game.config.hotseat && myPid === game.hotseatOwner) pIdx = game.turn.idx;
    if (pIdx === -1) return ack?.({ ok: false });
    const r = applyCheat(game, pIdx, text);
    if (r) {                                             // распознанная команда — применяем (не чатим!)
      if (r.ok && r.broadcast) persistAndBroadcast(game);
      return ack?.(r);
    }
    const chat = String(text || '').trim().slice(0, 120); // прочий текст — сообщение всем в комнате
    if (chat) io.to('game:' + game.id).emit('chat', { author: game.players[pIdx]?.nick || 'Игрок', text: chat });
    ack?.({ ok: true });
  });

  // Сдаться (в игре) или выйти (из лобби).
  socket.on('leave', (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    const result = leaveGame(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    maybeAutoFinish(game); // все люди сдались → доигрываем за ботов и завершаем сразу
    if (game.status === 'finished' && isRanked(game)) db.saveResults(game); // в лидерборд — только онлайн
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
    // поднимаем сессии в память, протухшие — выбрасываем (и чистим в БД)
    sessions.load(await db.getAllSessions(), token => db.deleteSession(token));
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
