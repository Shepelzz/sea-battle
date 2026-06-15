// Прогон слоя db.js против локальной MySQL (docker sb-mysql на 33061).
process.env.DATABASE_URL = 'mysql://root:root@127.0.0.1:33061/seabattle';

const db = await import('./server/db.js');
let ok = 0, fail = 0;
const check = (name, cond) => { if (cond) { ok++; console.log('✓', name); } else { fail++; console.error('✗', name); } };

await db.init();

// игроки + сессии
await db.upsertPlayer('tok-abc', 'Капитан Джек 🏴‍☠️', 'jack@sea.io');
await db.upsertPlayer('tok-abc', 'Джек Воробей');       // upsert: ник меняется, email сохраняется
await db.upsertPlayer('tok-xyz', 'Барбосса');
await db.createSession('sess-1', 'tok-abc');
await db.createSession('sess-1', 'tok-abc');            // replace, без дубля
check('email сохранился после upsert без email', (await db.getPlayerEmail('tok-abc')) === 'jack@sea.io');
const sessions = await db.getAllSessions();
check('сессия одна (replace работает)', sessions.length === 1 && sessions[0].pid === 'tok-abc');

// игры
const g1 = { id: 'game1', status: 'active', createdAt: 1000, players: [], turn: { idx: 0 } };
await db.saveGame(g1);
g1.status = 'finished'; g1.foo = 'bar🐙';                // обновление той же игры + utf8mb4
await db.saveGame(g1);
await db.saveGame({ id: 'game2', status: 'lobby', createdAt: 2000, players: [] });
check('countGames = 2', (await db.countGames()) === 2);
const games = await db.getAllGames();
const loaded = games.find(g => g.id === 'game1');
check('игра поднялась с обновлённым полем + эмодзи', loaded && loaded.status === 'finished' && loaded.foo === 'bar🐙');
check('всего игр поднято: 2', games.length === 2);

// результаты + лидерборд
const finishedGame = {
  id: 'game1',
  players: [
    { id: 'tok-abc', isBot: false, placement: 1, stats: { damageDealt: 120, shipsSunk: 5, shipsLost: 1, goldCollected: 300 } },
    { id: 'tok-xyz', isBot: false, placement: 2, stats: { damageDealt: 80, shipsSunk: 2, shipsLost: 4, goldCollected: 90 } },
    { id: 'bot:1', isBot: true, placement: 3, stats: { damageDealt: 10, shipsSunk: 0, shipsLost: 5, goldCollected: 0 } },
  ],
};
await db.saveResults(finishedGame);
await db.saveResults(finishedGame); // повтор: INSERT IGNORE не должен задвоить
const lb = await db.getLeaderboard();
check('лидерборд: 2 игрока (бот исключён)', lb.length === 2);
const jack = lb.find(r => r.nick === 'Джек Воробей');
check('победитель: 3 очка, 1 победа', jack && jack.points === 3 && jack.wins === 1);
check('лидерборд: числа, не строки', jack && typeof jack.damage === 'number' && jack.damage === 120);
check('второе место: 1 очко', lb.find(r => r.nick === 'Барбосса')?.points === 1);
check('топ лидерборда — победитель', lb[0].nick === 'Джек Воробей');

console.log(`\nИтого: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
