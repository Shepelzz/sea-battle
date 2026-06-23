// Лобби: время жизни до авто-удаления (неполное 6 ч / полное укомплектованное 24 ч) и проброс хоста (hostPid).
import {
  createGame, addPlayer, publicState,
  lobbyTtlMs, lobbyExpired, LOBBY_TTL_PARTIAL_MS, LOBBY_TTL_FULL_MS,
  gameStale, GAME_STALE_MS, myGameSummary, lobbyTags
} from './server/game.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n, '— ожидалось true')); };
const no = (n, c) => { !c ? ok++ : (fail++, console.error('✗', n, '— ожидалось false')); };
const eq = (n, g, w) => { JSON.stringify(g) === JSON.stringify(w) ? ok++ : (fail++, console.error('✗', n, 'got', JSON.stringify(g), 'want', JSON.stringify(w))); };

const H = 60 * 60 * 1000;
function lobby(maxP, nPlayers) {
  const g = createGame('t', { maxPlayers: maxP, turnTimer: 0 });
  g.config.listed = true;
  for (let i = 0; i < nPlayers; i++) addPlayer(g, 'p' + i, 'P' + i);
  g.hostPid = 'p0';
  g.createdAt = 1_000_000;
  return g;
}

// === константы политики ===
eq('TTL неполного = 6 ч', LOBBY_TTL_PARTIAL_MS, 6 * H);
eq('TTL полного = 24 ч', LOBBY_TTL_FULL_MS, 24 * H);

// === неполное лобби (2 из 4): живёт 6 ч ===
{
  const g = lobby(4, 2);
  eq('неполное → TTL 6 ч', lobbyTtlMs(g), LOBBY_TTL_PARTIAL_MS);
  no('неполное, 5 ч — ещё живо', lobbyExpired(g, g.createdAt + 5 * H));
  no('неполное, 5:59 — ещё живо', lobbyExpired(g, g.createdAt + 6 * H - 1));
  yes('неполное, 6 ч — удаляем', lobbyExpired(g, g.createdAt + 6 * H));
}

// === полное укомплектованное лобби (4 из 4), но НЕ начато: живёт 24 ч ===
{
  const g = lobby(4, 4);
  eq('полное → TTL 24 ч', lobbyTtlMs(g), LOBBY_TTL_FULL_MS);
  no('полное, 7 ч — живо (а не 6 ч!)', lobbyExpired(g, g.createdAt + 7 * H));
  no('полное, 23 ч — живо', lobbyExpired(g, g.createdAt + 23 * H));
  yes('полное, 24 ч — удаляем', lobbyExpired(g, g.createdAt + 24 * H));
}

// === начатая/завершённая игра под авто-очистку лобби НЕ попадает ===
{
  const g = lobby(2, 2);
  g.status = 'active';
  no('активная игра не expired', lobbyExpired(g, g.createdAt + 1000 * H));
  g.status = 'finished';
  no('завершённая игра не expired', lobbyExpired(g, g.createdAt + 1000 * H));
}

// === publicState пробрасывает хоста (для роли «создатель» по аккаунту на клиенте) ===
{
  const g = lobby(4, 2);
  eq('publicState.hostPid = создатель', publicState(g, 'p0').hostPid, 'p0');
  // даже если hostPid не проставлен явно — берём первого игрока (бэкап для старых/не-онлайн игр)
  const g2 = lobby(4, 2); g2.hostPid = null;
  eq('hostPid пуст → берём players[0]', publicState(g2, 'p0').hostPid, 'p0');
}

// === режим: человекочитаемое имя в publicState (для строки конфига лобби) ===
{
  const g = lobby(2, 2); g.config.mode = 'deathmatch';
  eq('publicState.modeName = имя режима', publicState(g, 'p0').modeName, 'Дезматч');
  const g2 = lobby(2, 2);   // без явного режима → классика по умолчанию
  eq('publicState.modeName дефолт = Классический', publicState(g2, 'p0').modeName, 'Классический');
}

// === метки лобби в СПИСКЕ: только отклонения от стандарта (дефолты не пишем) ===
{
  eq('дефолтный батл (классика/туман/ход-3/без таймера) — меток нет', lobbyTags(lobby(2, 2)), []);
  const g2 = lobby(2, 2); g2.config.mode = 'develop'; g2.config.fog = false; g2.config.multiMove = true;
  eq('режим + выкл. туман (ход-3 дефолт скрыт)', lobbyTags(g2), ['Развитие', 'без тумана']);
  const g3 = lobby(2, 2); g3.config.multiMove = false; g3.config.turnTimer = 120;
  eq('таймер 2 мин + по одному ходу', lobbyTags(g3), ['таймер 2 мин', 'по одному ходу']);
  const g4 = lobby(2, 2); g4.config.mode = 'duel'; g4.config.fog = false; g4.config.multiMove = false;
  eq('дуэль: только режим (туман/ход-3 неприменимы)', lobbyTags(g4), ['Дуэль']);
}

// === Заброшенная игра: авто-уборка через 7 дней (gameStale) ===
{
  eq('GAME_STALE_MS = 7 дней', GAME_STALE_MS, 7 * 24 * H);
  const g = lobby(2, 2); g.status = 'active'; g.updatedAt = 1_000_000;
  no('активная, 6 дней без ходов — живёт', gameStale(g, g.updatedAt + 6 * 24 * H));
  yes('активная, 7 дней без ходов — убираем', gameStale(g, g.updatedAt + 7 * 24 * H));
  g.status = 'finished';
  yes('завершённая старше 7 дней — тоже убираем', gameStale(g, g.updatedAt + 8 * 24 * H));
  g.status = 'lobby';
  no('лобби под gameStale не попадает (его чистит lobbyExpired)', gameStale(g, g.updatedAt + 30 * 24 * H));
}

// === «Мои игры»: сводка myGameSummary ===
function activeGame({ online = false, hotseat = false, bot = false } = {}) {
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0 });
  addPlayer(g, 'p0', 'Я'); addPlayer(g, 'p1', 'Соперник');
  g.status = 'active'; g.config.mode = 'classic';
  if (online) { g.config.listed = true; g.hostPid = 'p0'; }
  if (bot) { g.config.botGame = true; g.players[1].isBot = true; }
  if (hotseat) g.config.hotseat = true;
  g.turn = { idx: 0, number: 1, round: 1, moves: 0, actedShips: [] };
  return g;
}
{
  const g = activeGame({ online: true });
  const s = myGameSummary(g, 'p0');
  yes('онлайн: игра моя (хост)', !!s);
  yes('онлайн-хост: завершить можно', s.canFinish === true);
  yes('онлайн: мой ход (turn.idx=0 → p0)', s.myTurn === true);
  yes('онлайн: флаг online', s.online === true);
  eq('соперники в сводке', s.opponents, ['Соперник']);
  yes('режим — непустая строка', typeof s.mode === 'string' && s.mode.length > 0);
  const s1 = myGameSummary(g, 'p1');
  yes('онлайн не-хост: завершить нельзя', s1.canFinish === false);
  yes('онлайн не-хост: сейчас не мой ход', s1.myTurn === false);
  yes('посторонний → null', myGameSummary(g, 'stranger') === null);
}
{
  const s = myGameSummary(activeGame({ bot: true }), 'p0');
  yes('бот-игра: моя', !!s);
  yes('бот-игра: оффлайн', s.online === false);
  yes('бот-игра: завершить можно (сольная)', s.canFinish === true);
}
{
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0 });
  addPlayer(g, 'h#0', 'Игрок1'); addPlayer(g, 'h#1', 'Игрок2');
  g.status = 'active'; g.config.hotseat = true; g.hotseatOwner = 'h'; g.config.mode = 'classic';
  g.turn = { idx: 1, number: 1, round: 1, moves: 0, actedShips: [] };
  const s = myGameSummary(g, 'h');
  yes('хотсит: моя (по hotseatOwner)', !!s);
  yes('хотсит: завершить можно', s.canFinish === true);
  yes('хотсит: ход всегда «мой» (устройство одно)', s.myTurn === true);
}
{
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0 });
  addPlayer(g, 'p0', 'Я');                  // статус lobby (не active)
  yes('лобби (не active) → null', myGameSummary(g, 'p0') === null);
}

console.log(fail ? `\n❌ test-lobby: провалено ${fail}, прошло ${ok}` : `\n✅ test-lobby: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
