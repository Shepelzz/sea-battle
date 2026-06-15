// MySQL: игроки (по токену), сохранение игр, результаты и лидерборд.
//
// Render и подобные хостинги имеют ЭФЕМЕРНУЮ файловую систему — файл SQLite там не
// переживает деплой. Поэтому данные храним во внешней MySQL, доступной по сети.
//
// Подключение через переменные окружения (любой из вариантов):
//   DATABASE_URL = mysql://user:pass@host:3306/dbname        (одной строкой)
//   либо по отдельности: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
//   DB_SSL=true — включить TLS (нужно некоторым хостерам, напр. Aiven)
//   DB_POOL=5  — размер пула соединений (по умолчанию 5; на free-базах лимит низкий)
import mysql from 'mysql2/promise';

function buildConfig() {
  const url = process.env.DATABASE_URL || process.env.MYSQL_URL
    || process.env.JAWSDB_URL || process.env.CLEARDB_DATABASE_URL;
  let cfg;
  if (url) {
    const u = new URL(url);
    cfg = {
      host: u.hostname,
      port: u.port ? +u.port : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ''),
    };
  } else {
    cfg = {
      host: process.env.DB_HOST || process.env.MYSQLHOST,
      port: +(process.env.DB_PORT || process.env.MYSQLPORT || 3306),
      user: process.env.DB_USER || process.env.MYSQLUSER,
      password: process.env.DB_PASSWORD || process.env.DB_PASS || process.env.MYSQLPASSWORD || '',
      database: process.env.DB_NAME || process.env.DB_DATABASE || process.env.MYSQLDATABASE,
    };
  }
  const ssl = process.env.DB_SSL;
  if (ssl && ssl !== 'false' && ssl !== '0') cfg.ssl = { rejectUnauthorized: false };
  return cfg;
}

const config = buildConfig();
if (!config.host || !config.user || !config.database) {
  console.error('❌ Не заданы параметры MySQL. Укажи DATABASE_URL '
    + '(mysql://user:pass@host:port/db) или DB_HOST/DB_USER/DB_PASSWORD/DB_NAME.');
}

const pool = mysql.createPool({
  ...config,
  waitForConnections: true,
  connectionLimit: +(process.env.DB_POOL || 5),
  maxIdle: +(process.env.DB_POOL || 5),
  idleTimeout: 60000,
  enableKeepAlive: true,
  charset: 'utf8mb4_general_ci',
});

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS players (
     token VARCHAR(64) PRIMARY KEY,
     nick VARCHAR(255) NOT NULL,
     email VARCHAR(255),
     created_at BIGINT NOT NULL
   ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS games (
     id VARCHAR(32) PRIMARY KEY,
     status VARCHAR(16) NOT NULL,
     state LONGTEXT NOT NULL,
     created_at BIGINT NOT NULL,
     updated_at BIGINT NOT NULL
   ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS results (
     game_id VARCHAR(32) NOT NULL,
     player_token VARCHAR(64) NOT NULL,
     placement INT NOT NULL,
     win INT NOT NULL,
     damage INT NOT NULL,
     sunk INT NOT NULL,
     lost INT NOT NULL,
     gold INT NOT NULL,
     finished_at BIGINT NOT NULL,
     PRIMARY KEY (game_id, player_token)
   ) DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token VARCHAR(64) PRIMARY KEY,
     pid VARCHAR(64) NOT NULL,
     created_at BIGINT NOT NULL
   ) DEFAULT CHARSET=utf8mb4`,
];

// Создаёт таблицы и проверяет соединение. Вызывать один раз при старте сервера.
export async function init() {
  for (const sql of SCHEMA) await pool.query(sql);
  console.log('🗄  MySQL подключён: ' + config.host + '/' + config.database);
}

// Предзагрузка при старте: все игры из БД в память (источник истины в рантайме).
export async function getAllGames() {
  const [rows] = await pool.query('SELECT state FROM games');
  return rows
    .map(r => { try { return JSON.parse(r.state); } catch { return null; } })
    .filter(Boolean);
}

// Предзагрузка серверных сессий (Google-вход): token -> pid.
export async function getAllSessions() {
  const [rows] = await pool.query('SELECT token, pid FROM sessions');
  return rows;
}

// --- записи: сами ловят ошибки, чтобы вызывающий код мог не ждать (fire-and-forget) ---

export async function upsertPlayer(token, nick, email = null) {
  try {
    await pool.query(
      `INSERT INTO players (token, nick, email, created_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE nick = VALUES(nick), email = COALESCE(VALUES(email), email)`,
      [token, nick, email, Date.now()]
    );
  } catch (e) { console.error('db.upsertPlayer:', e.message); }
}

export async function createSession(token, pid) {
  try {
    await pool.query(
      'REPLACE INTO sessions (token, pid, created_at) VALUES (?, ?, ?)',
      [token, pid, Date.now()]
    );
  } catch (e) { console.error('db.createSession:', e.message); }
}

export async function saveGame(game) {
  try {
    await pool.query(
      `INSERT INTO games (id, status, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE status = VALUES(status), state = VALUES(state), updated_at = VALUES(updated_at)`,
      [game.id, game.status, JSON.stringify(game), game.createdAt, Date.now()]
    );
  } catch (e) { console.error('db.saveGame:', e.message); }
}

export async function saveResults(game) {
  const now = Date.now();
  for (const p of game.players) {
    if (p.isBot) continue; // боты в лидерборд не попадают
    try {
      await pool.query(
        `INSERT IGNORE INTO results (game_id, player_token, placement, win, damage, sunk, lost, gold, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [game.id, p.id, p.placement ?? game.players.length, p.placement === 1 ? 1 : 0,
         p.stats.damageDealt, p.stats.shipsSunk, p.stats.shipsLost, p.stats.goldCollected, now]
      );
    } catch (e) { console.error('db.saveResults:', e.message); }
  }
}

// --- чтения-значения: возвращают данные, поэтому вызываются с await ---

export async function getPlayerEmail(pid) {
  try {
    const [rows] = await pool.query('SELECT email FROM players WHERE token = ?', [pid]);
    return rows[0]?.email ?? null;
  } catch (e) { console.error('db.getPlayerEmail:', e.message); return null; }
}

export async function countGames() {
  try {
    const [rows] = await pool.query('SELECT COUNT(*) AS n FROM games');
    return Number(rows[0].n) || 0;
  } catch { return 0; }
}

export async function getLeaderboard() {
  try {
    const [rows] = await pool.query(`
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
      LIMIT 50`);
    return rows.map(r => ({
      nick: r.nick,
      games: Number(r.games),
      wins: Number(r.wins),
      points: Number(r.points),
      damage: Number(r.damage),
      sunk: Number(r.sunk),
      gold: Number(r.gold),
    }));
  } catch (e) { console.error('db.getLeaderboard:', e.message); return []; }
}
