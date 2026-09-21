// 🧭 Профиль капитана: что попадает в статистику и что — в лидерборд.
//
// До профиля строка в `results` писалась ТОЛЬКО за рейтинговую партию, поэтому у того, кто играет
// с ботами, история была пустой. Теперь пишется каждая доигранная партия, а отличает их колонка
// `ranked`: лидерборд берёт только единицы, профиль показывает и общее число, и рейтинговое.
// Тест стережёт ровно эту развилку — и то, что старая база доживёт до новой схемы сама.
import { createGame, addPlayer, startGame } from '../server/game.js';
import { resultRows } from '../server/db.js';
import { rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const eq = (n, g, w) => { JSON.stringify(g) === JSON.stringify(w) ? ok++ : (fail++, console.error('✗', n, 'получили', JSON.stringify(g), 'ждали', JSON.stringify(w))); };

// доигранная партия: двое людей + бот, места расставлены
function finished(cfg = {}) {
  const g = createGame('t' + Math.random().toString(36).slice(2, 7), { maxPlayers: 3, turnTimer: 0, seed: 11 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб'); addPlayer(g, 'BOT', 'Бот');
  startGame(g, 'A');
  Object.assign(g.config, cfg);
  g.players[2].isBot = true;
  g.status = 'finished';
  g.players[0].placement = 1; g.players[1].placement = 2; g.players[2].placement = 3;
  for (const p of g.players) Object.assign(p.stats, { damageDealt: 500, shipsSunk: 4, shipsLost: 2, goldCollected: 1000 });
  return g;
}
const rankedOf = rows => rows.map(r => r[8]);   // ranked — предпоследняя колонка (finished_at добавит движок)

// === 1. Флаг ranked выставляется по правилам лидерборда ===
eq('онлайн-партия → ranked 1', rankedOf(resultRows(finished({ listed: true }))), [1, 1]);
eq('игра с ботами (не в лобби) → ranked 0', rankedOf(resultRows(finished({ listed: false }))), [0, 0]);
eq('реалтайм-онлайн → ranked 0 (вне рейтинга)', rankedOf(resultRows(finished({ listed: true, realtime: true }))), [0, 0]);
eq('хотсит не пишется вовсе', resultRows(finished({ hotseat: true })), []);
eq('боты в статистику не идут', resultRows(finished({ listed: true })).map(r => r[1]), ['A', 'B']);

// === 2. Живая база: старая схема доезжает до новой сама ===
const TMP = path.join(os.tmpdir(), `sb-profile-${process.pid}.db`);
const cleanup = () => { for (const s of ['', '-wal', '-shm']) rmSync(TMP + s, { force: true }); };
cleanup();
for (const k of ['DATABASE_URL', 'MYSQL_URL', 'JAWSDB_URL', 'CLEARDB_DATABASE_URL', 'DB_HOST', 'MYSQLHOST'])
  delete process.env[k];            // чтобы движок точно выбрался sqlite-овый
process.env.SQLITE_PATH = TMP;

const { DatabaseSync } = await import('node:sqlite');
{
  // база «как до профиля»: в results нет колонки ranked
  const raw = new DatabaseSync(TMP);
  raw.exec(`CREATE TABLE results (
    game_id TEXT NOT NULL, player_token TEXT NOT NULL, placement INTEGER NOT NULL, win INTEGER NOT NULL,
    damage INTEGER NOT NULL, sunk INTEGER NOT NULL, lost INTEGER NOT NULL, gold INTEGER NOT NULL,
    finished_at INTEGER NOT NULL, PRIMARY KEY (game_id, player_token));`);
  raw.prepare('INSERT INTO results VALUES (?,?,?,?,?,?,?,?,?)').run('old1', 'A', 1, 1, 100, 1, 0, 200, Date.now());
  raw.close();
}

const db = await import('../server/db.js');
await db.init();
await db.init();   // повторный старт (рестарт сервера) не должен падать на уже применённой миграции

{
  const raw = new DatabaseSync(TMP);
  const cols = raw.prepare('PRAGMA table_info(results)').all().map(c => c.name);
  yes('миграция добавила колонку ranked', cols.includes('ranked'));
  eq('старые строки считаются рейтинговыми', raw.prepare("SELECT ranked FROM results WHERE game_id = 'old1'").get().ranked, 1);
  raw.close();
}

// === 3. Профиль считает все партии, лидерборд — только рейтинговые ===
await db.upsertPlayer('A', 'Алиса');
await db.upsertPlayer('B', 'Боб');
await db.saveResults(finished({ listed: true }));    // рейтинговая
await db.saveResults(finished({ listed: false }));   // против ботов
await db.saveResults(finished({ listed: false }));   // ещё одна против ботов

{
  const s = await db.getPlayerStats('A');
  eq('в профиле все 4 партии (1 старая + 3 новых)', s.games, 4);
  eq('из них рейтинговых — 2', s.ranked.games, 2);
  eq('побед всего 4 (везде первое место)', s.wins, 4);
  yes('урон просуммирован', s.damage === 100 + 500 * 3);
  yes('дата последней партии есть', typeof s.lastAt === 'number' && s.lastAt > 0);
}
{
  const board = await db.getLeaderboard();
  const a = board.find(r => r.nick === 'Алиса');
  eq('в лидерборде у Алисы только рейтинговые партии', a.games, 2);
  eq('очки только за рейтинговые (2 победы × 3)', a.points, 6);
  const b = board.find(r => r.nick === 'Боб');
  eq('второе место приносит 1 очко за рейтинговую партию', b.points, 1);
  eq('Боб тоже видит лишь рейтинговые', b.games, 1);
}

// === 4. Место в рейтинге ===
{
  const a = await db.getPlayerStats('A');
  const b = await db.getPlayerStats('B');
  eq('у Алисы очков больше → первое место', a.ranked.place, 1);
  eq('Боб второй', b.ranked.place, 2);
  eq('всего в таблице двое', a.ranked.total, 2);
}
{
  // человек без единой партии: нулевые статы и НЕТ места в таблице (а не «последнее»)
  const s = await db.getPlayerStats('никогда-не-играл');
  eq('без партий: games 0', s.games, 0);
  eq('без партий: места в рейтинге нет', s.ranked.place, null);
  eq('без партий: суммы — нули, а не null', [s.damage, s.gold, s.wins], [0, 0, 0]);
  eq('без партий: дата последней партии пуста', s.lastAt, null);
}

cleanup();
console.log(fail ? `\n❌ test-profile: провалено ${fail}, прошло ${ok}` : `\n✅ test-profile: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
