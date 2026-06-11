// HTTP + WebSocket сервер. Игра живёт по ссылке /game/<id>.
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import * as db from './db.js';
import { createGame, addPlayer, startGame, applyAction, voteSkip, timeoutTurn, publicState } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3456;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Секретный токен живёт только в браузере; сервер везде использует его хэш.
const pidOf = token => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);

// Активные игры в памяти; SQLite — источник истины (переживает рестарт).
const games = new Map();

function getGame(id) {
  if (games.has(id)) return games.get(id);
  const state = db.loadGame(id);
  if (state) { games.set(id, state); return state; }
  return null;
}

function persistAndBroadcast(game) {
  db.saveGame(game);
  io.to('game:' + game.id).emit('state', publicState(game));
}

// --- REST ---

app.post('/api/games', (req, res) => {
  const { token, nick, maxPlayers, turnTimer } = req.body || {};
  if (!token || !nick?.trim()) return res.status(400).json({ error: 'Нужны ник и токен' });
  const id = crypto.randomBytes(5).toString('base64url');
  const game = createGame(id, { maxPlayers: +maxPlayers, turnTimer: +turnTimer });
  const pid = pidOf(token);
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

  socket.on('join', ({ gameId, token, nick }, ack) => {
    const game = getGame(gameId);
    if (!game) return ack?.({ ok: false, error: 'Игра не найдена' });
    if (!token || !nick?.trim()) return ack?.({ ok: false, error: 'Введите ник' });
    const pid = pidOf(token);
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

  socket.on('voteSkip', (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'Нет игры' });
    const result = voteSkip(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    armTurnTimer(game);
    persistAndBroadcast(game);
    ack?.({ ok: true });
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

server.listen(PORT, () => console.log(`⚓ Sea Battle: http://localhost:${PORT}`));
