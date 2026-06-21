// Хранилище: игроки (по токену), сохранение игр, результаты и лидерборд.
//
// Два движка, выбор автоматический:
//   • Заданы MySQL-переменные среды (DATABASE_URL или DB_HOST/DB_USER/...) → MySQL.
//     Так на проде (Render и т.п. с эфемерной ФС): данные живут во внешней базе и
//     переживают деплой. См. переменные ниже.
//   • Ничего не задано → локальный SQLite-файл (встроенный node:sqlite, без зависимостей
//     и нативной сборки). Файл создаётся сам — локально «просто работает», без MySQL.
//
// MySQL: DATABASE_URL=mysql://user:pass@host:3306/db  (или DB_HOST/DB_PORT/DB_USER/
//        DB_PASSWORD/DB_NAME); опц. DB_SSL=true, DB_POOL=5.
// SQLite: путь можно задать через SQLITE_PATH (по умолчанию sea-battle.db рядом с проектом).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const useMysql = !!(process.env.DATABASE_URL || process.env.MYSQL_URL
  || process.env.JAWSDB_URL || process.env.CLEARDB_DATABASE_URL
  || process.env.DB_HOST || process.env.MYSQLHOST);

let api = null; // выбранный бэкенд (заполняется в init)

// единый асинхронный интерфейс — index.js не знает, какой движок под капотом
export async function init() {
  api = useMysql ? await makeMysql() : await makeSqlite();
  await api.init();
}
export const getAllGames    = () => api.getAllGames();
export const getAllSessions = () => api.getAllSessions();
export const upsertPlayer   = (token, nick, email = null, provider = null, avatar = null) =>
  api.upsertPlayer(token, nick, email, provider, avatar);
export const createSession  = (token, pid) => api.createSession(token, pid);
export const deleteSession  = (token) => api.deleteSession(token);
export const saveGame       = (game) => api.saveGame(game);
export const saveResults    = (game) => api.saveResults(game);
export const getPlayer      = (pid) => api.getPlayer(pid);
export const getPlayerEmail = (pid) => api.getPlayerEmail(pid);
export const countGames     = () => api.countGames();
export const getLeaderboard = () => api.getLeaderboard();

const LEADERBOARD_SQL = `
  SELECT p.nick AS nick,
         COUNT(*) AS games,
         SUM(r.win) AS wins,
         SUM(r.win) * 3 + SUM(CASE WHEN r.placement = 2 THEN 1 ELSE 0 END) AS points,
         SUM(r.damage) AS damage,
         SUM(r.sunk) AS sunk,
         SUM(r.gold) AS gold
  FROM results r JOIN players p ON p.token = r.player_token
  GROUP BY r.player_token, p.nick
  ORDER BY points DESC, wins DESC, damage DESC
  LIMIT 50`;

const resultRows = game => game.players.filter(p => !p.isBot).map(p => [
  game.id, p.id, p.placement ?? game.players.length, p.placement === 1 ? 1 : 0,
  p.stats.damageDealt, p.stats.shipsSunk, p.stats.shipsLost, p.stats.goldCollected
]);

// =================== SQLite (локально, встроенный node:sqlite) ===================
async function makeSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  const file = process.env.SQLITE_PATH
    ? path.resolve(process.env.SQLITE_PATH)
    : path.join(__dirname, '..', 'sea-battle.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');

  const run = (sql, ...a) => { try { db.prepare(sql).run(...a); } catch (e) { console.error('db:', e.message); } };

  return {
    async init() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS players (
          token TEXT PRIMARY KEY, nick TEXT NOT NULL, email TEXT,
          provider TEXT, avatar TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS games (
          id TEXT PRIMARY KEY, status TEXT NOT NULL, state TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS results (
          game_id TEXT NOT NULL, player_token TEXT NOT NULL, placement INTEGER NOT NULL,
          win INTEGER NOT NULL, damage INTEGER NOT NULL, sunk INTEGER NOT NULL,
          lost INTEGER NOT NULL, gold INTEGER NOT NULL, finished_at INTEGER NOT NULL,
          PRIMARY KEY (game_id, player_token));
        CREATE TABLE IF NOT EXISTS sessions (
          token TEXT PRIMARY KEY, pid TEXT NOT NULL, created_at INTEGER NOT NULL);
      `);
      // миграция уже существующих баз: добавляем новые колонки, если их ещё нет
      for (const [col, def] of [['provider', 'TEXT'], ['avatar', 'TEXT']])
        try { db.exec(`ALTER TABLE players ADD COLUMN ${col} ${def}`); } catch { /* колонка уже есть */ }
      console.log('🗄  SQLite (локально): ' + file);
    },
    async getAllGames() {
      return db.prepare('SELECT state FROM games').all()
        .map(r => { try { return JSON.parse(r.state); } catch { return null; } }).filter(Boolean);
    },
    async getAllSessions() { return db.prepare('SELECT token, pid, created_at FROM sessions').all(); },
    async upsertPlayer(token, nick, email, provider, avatar) {
      run(`INSERT INTO players (token, nick, email, provider, avatar, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(token) DO UPDATE SET nick = excluded.nick,
             email = COALESCE(excluded.email, players.email),
             provider = COALESCE(excluded.provider, players.provider),
             avatar = COALESCE(excluded.avatar, players.avatar)`,
        token, nick, email ?? null, provider ?? null, avatar ?? null, Date.now());
    },
    async createSession(token, pid) {
      run('INSERT OR REPLACE INTO sessions (token, pid, created_at) VALUES (?, ?, ?)', token, pid, Date.now());
    },
    async deleteSession(token) { run('DELETE FROM sessions WHERE token = ?', token); },
    async saveGame(game) {
      run(`INSERT INTO games (id, status, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, state = excluded.state,
             updated_at = excluded.updated_at`,
        game.id, game.status, JSON.stringify(game), game.createdAt, Date.now());
    },
    async saveResults(game) {
      const now = Date.now();
      for (const r of resultRows(game)) {
        run(`INSERT OR IGNORE INTO results
             (game_id, player_token, placement, win, damage, sunk, lost, gold, finished_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ...r, now);
      }
    },
    async getPlayer(pid) {
      const r = db.prepare('SELECT nick, email, provider, avatar FROM players WHERE token = ?').get(pid);
      return r ? { nick: r.nick, email: r.email ?? null, provider: r.provider ?? null, avatar: r.avatar ?? null } : null;
    },
    async getPlayerEmail(pid) {
      return db.prepare('SELECT email FROM players WHERE token = ?').get(pid)?.email ?? null;
    },
    async countGames() { return Number(db.prepare('SELECT COUNT(*) AS n FROM games').get().n) || 0; },
    async getLeaderboard() {
      return db.prepare(LEADERBOARD_SQL).all().map(r => ({
        nick: r.nick, games: Number(r.games), wins: Number(r.wins), points: Number(r.points),
        damage: Number(r.damage), sunk: Number(r.sunk), gold: Number(r.gold)
      }));
    }
  };
}

// =================== MySQL (прод, внешняя база) ===================
async function makeMysql() {
  const mysql = (await import('mysql2/promise')).default;
  let cfg;
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL
    || process.env.JAWSDB_URL || process.env.CLEARDB_DATABASE_URL;
  if (url) {
    const u = new URL(url);
    cfg = { host: u.hostname, port: u.port ? +u.port : 3306,
      user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') };
  } else {
    cfg = { host: process.env.DB_HOST || process.env.MYSQLHOST,
      port: +(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
      user: process.env.DB_USER || process.env.MYSQLUSER,
      password: process.env.DB_PASSWORD || process.env.DB_PASS || process.env.MYSQLPASSWORD || '',
      database: process.env.DB_NAME || process.env.DB_DATABASE || process.env.MYSQLDATABASE };
  }
  const ssl = process.env.DB_SSL;
  if (ssl && ssl !== 'false' && ssl !== '0') cfg.ssl = { rejectUnauthorized: false };

  const pool = mysql.createPool({
    ...cfg, waitForConnections: true,
    connectionLimit: +(process.env.DB_POOL || 5), maxIdle: +(process.env.DB_POOL || 5),
    idleTimeout: 60000, enableKeepAlive: true, charset: 'utf8mb4_general_ci'
  });
  const q = async (sql, params) => { try { await pool.query(sql, params); } catch (e) { console.error('db:', e.message); } };

  return {
    async init() {
      const tables = [
        `CREATE TABLE IF NOT EXISTS players (token VARCHAR(64) PRIMARY KEY, nick VARCHAR(255) NOT NULL,
           email VARCHAR(255), provider VARCHAR(16), avatar VARCHAR(512), created_at BIGINT NOT NULL) DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS games (id VARCHAR(32) PRIMARY KEY, status VARCHAR(16) NOT NULL,
           state LONGTEXT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL) DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS results (game_id VARCHAR(32) NOT NULL, player_token VARCHAR(64) NOT NULL,
           placement INT NOT NULL, win INT NOT NULL, damage INT NOT NULL, sunk INT NOT NULL, lost INT NOT NULL,
           gold INT NOT NULL, finished_at BIGINT NOT NULL, PRIMARY KEY (game_id, player_token)) DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS sessions (token VARCHAR(64) PRIMARY KEY, pid VARCHAR(64) NOT NULL,
           created_at BIGINT NOT NULL) DEFAULT CHARSET=utf8mb4`
      ];
      for (const t of tables) await pool.query(t);
      // миграция уже существующих баз: добавляем новые колонки, если их ещё нет
      for (const [col, def] of [['provider', 'VARCHAR(16)'], ['avatar', 'VARCHAR(512)']])
        try { await pool.query(`ALTER TABLE players ADD COLUMN ${col} ${def}`); } catch { /* колонка уже есть */ }
      console.log('🗄  MySQL: ' + cfg.host + '/' + cfg.database);
    },
    async getAllGames() {
      const [rows] = await pool.query('SELECT state FROM games');
      return rows.map(r => { try { return JSON.parse(r.state); } catch { return null; } }).filter(Boolean);
    },
    async getAllSessions() { const [rows] = await pool.query('SELECT token, pid, created_at FROM sessions'); return rows; },
    async upsertPlayer(token, nick, email, provider, avatar) {
      await q(`INSERT INTO players (token, nick, email, provider, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE nick = VALUES(nick),
                 email = COALESCE(VALUES(email), email),
                 provider = COALESCE(VALUES(provider), provider),
                 avatar = COALESCE(VALUES(avatar), avatar)`,
        [token, nick, email ?? null, provider ?? null, avatar ?? null, Date.now()]);
    },
    async createSession(token, pid) {
      await q('REPLACE INTO sessions (token, pid, created_at) VALUES (?, ?, ?)', [token, pid, Date.now()]);
    },
    async deleteSession(token) { await q('DELETE FROM sessions WHERE token = ?', [token]); },
    async saveGame(game) {
      await q(`INSERT INTO games (id, status, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
               ON DUPLICATE KEY UPDATE status = VALUES(status), state = VALUES(state), updated_at = VALUES(updated_at)`,
        [game.id, game.status, JSON.stringify(game), game.createdAt, Date.now()]);
    },
    async saveResults(game) {
      const now = Date.now();
      for (const r of resultRows(game)) {
        await q(`INSERT IGNORE INTO results
                 (game_id, player_token, placement, win, damage, sunk, lost, gold, finished_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...r, now]);
      }
    },
    async getPlayer(pid) {
      try { const [rows] = await pool.query('SELECT nick, email, provider, avatar FROM players WHERE token = ?', [pid]);
        const r = rows[0];
        return r ? { nick: r.nick, email: r.email ?? null, provider: r.provider ?? null, avatar: r.avatar ?? null } : null;
      } catch (e) { console.error('db:', e.message); return null; }
    },
    async getPlayerEmail(pid) {
      try { const [rows] = await pool.query('SELECT email FROM players WHERE token = ?', [pid]);
        return rows[0]?.email ?? null; } catch (e) { console.error('db:', e.message); return null; }
    },
    async countGames() {
      try { const [rows] = await pool.query('SELECT COUNT(*) AS n FROM games'); return Number(rows[0].n) || 0; }
      catch { return 0; }
    },
    async getLeaderboard() {
      try {
        const [rows] = await pool.query(LEADERBOARD_SQL);
        return rows.map(r => ({ nick: r.nick, games: Number(r.games), wins: Number(r.wins),
          points: Number(r.points), damage: Number(r.damage), sunk: Number(r.sunk), gold: Number(r.gold) }));
      } catch (e) { console.error('db:', e.message); return []; }
    }
  };
}
