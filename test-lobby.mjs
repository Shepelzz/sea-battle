// Лобби: время жизни до авто-удаления (неполное 6 ч / полное укомплектованное 24 ч) и проброс хоста (hostPid).
import {
  createGame, addPlayer, publicState,
  lobbyTtlMs, lobbyExpired, LOBBY_TTL_PARTIAL_MS, LOBBY_TTL_FULL_MS
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

console.log(fail ? `\n❌ test-lobby: провалено ${fail}, прошло ${ok}` : `\n✅ test-lobby: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
