// SQLite: игроки (по токену), сохранение игр, результаты и лидерборд.
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DB_PATH позволяет держать базу ВНЕ папки сайта, чтобы деплой её не затирал.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'sea-battle.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
console.log('🗄  База данных: ' + DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  nick TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  game_id TEXT NOT NULL,
  player_token TEXT NOT NULL,
  placement INTEGER NOT NULL,
  win INTEGER NOT NULL,
  damage INTEGER NOT NULL,
  sunk INTEGER NOT NULL,
  lost INTEGER NOT NULL,
  gold INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, player_token)
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  pid TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

// миграция: колонка email у игроков (для пинга «поторопить»)
try { db.exec('ALTER TABLE players ADD COLUMN email TEXT'); } catch { /* уже есть */ }

const upsertPlayerStmt = db.prepare(`
  INSERT INTO players (token, nick, created_at, email) VALUES (?, ?, ?, ?)
  ON CONFLICT(token) DO UPDATE SET
    nick = excluded.nick,
    email = COALESCE(excluded.email, players.email)
`);
const getEmailStmt = db.prepare('SELECT email FROM players WHERE token = ?');
const createSessionStmt = db.prepare('INSERT OR REPLACE INTO sessions (token, pid, created_at) VALUES (?, ?, ?)');
const getSessionStmt = db.prepare('SELECT pid FROM sessions WHERE token = ?');
const saveGameStmt = db.prepare(`
  INSERT INTO games (id, status, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET status = excluded.status, state = excluded.state, updated_at = excluded.updated_at
`);
const loadGameStmt = db.prepare('SELECT state FROM games WHERE id = ?');
const saveResultStmt = db.prepare(`
  INSERT OR IGNORE INTO results (game_id, player_token, placement, win, damage, sunk, lost, gold, finished_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const leaderboardStmt = db.prepare(`
  SELECT p.nick,
         COUNT(*) AS games,
         SUM(r.win) AS wins,
         SUM(r.win) * 3 + SUM(CASE WHEN r.placement = 2 THEN 1 ELSE 0 END) AS points,
         SUM(r.damage) AS damage,
         SUM(r.sunk) AS sunk,
         SUM(r.gold) AS gold
  FROM results r JOIN players p ON p.token = r.player_token
  GROUP BY r.player_token
  ORDER BY points DESC, wins DESC, damage DESC
  LIMIT 50
`);

export function upsertPlayer(token, nick, email = null) {
  upsertPlayerStmt.run(token, nick, Date.now(), email);
}

export function getPlayerEmail(pid) {
  return getEmailStmt.get(pid)?.email ?? null;
}

export function createSession(token, pid) {
  createSessionStmt.run(token, pid, Date.now());
}

export function getSessionPid(token) {
  return getSessionStmt.get(token)?.pid ?? null;
}

export function saveGame(game) {
  saveGameStmt.run(game.id, game.status, JSON.stringify(game), game.createdAt, Date.now());
  // сливаем WAL в основной .db, чтобы данные пережили даже потерю файлов-спутников при деплое
  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* не критично */ }
}

export function countGames() {
  return db.prepare('SELECT COUNT(*) AS n FROM games').get().n;
}

export function loadGame(id) {
  const row = loadGameStmt.get(id);
  return row ? JSON.parse(row.state) : null;
}

export function saveResults(game) {
  const now = Date.now();
  for (const p of game.players) {
    if (p.isBot) continue; // боты в лидерборд не попадают
    saveResultStmt.run(
      game.id, p.id, p.placement ?? game.players.length, p.placement === 1 ? 1 : 0,
      p.stats.damageDealt, p.stats.shipsSunk, p.stats.shipsLost, p.stats.goldCollected, now
    );
  }
}

export function getLeaderboard() {
  return leaderboardStmt.all();
}
