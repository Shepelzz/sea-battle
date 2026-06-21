// Личность игрока и серверные сессии — чистая логика (без сети и БД), чтобы её можно
// было покрыть тестами. index.js оборачивает это HTTP/cookie/БД-слоем.
//
// Две роли:
//   • Аккаунт (Google и т.п.) — стабильный pid, выведенный из id провайдера (sub). Один
//     аккаунт → один pid на любом устройстве. Серверная сессия живёт в httpOnly-cookie.
//   • Гость (одиночка/хотсит) — случайный токен из localStorage, pid = его хэш.
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'sb_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// pid гостя по его секретному токену
export const pidOf = token => sha(token).slice(0, 16);
// pid аккаунта по стабильному id провайдера (Google sub). Префикс 'g' — задел под f/d (FB/Discord).
export const googlePid = sub => 'g' + sha(sub).slice(0, 15);
// нормализуем ник: тримим и режем по длине (тот же лимит, что в UI)
export const cleanNick = (n, max = 20) => String(n || '').trim().slice(0, max);

// Ник аккаунта при входе. Приоритет: СОХРАНЁННЫЙ ник аккаунта > явно введённый игроком >
// имя из Google > префикс email. Сохранённый главнее — чтобы вернувшийся игрок получил СВОЙ
// ник, а не тот, что случайно остался в localStorage от прошлого аккаунта на этом устройстве.
export const resolveAccountNick = (existingNick, requested, providerName, email) =>
  cleanNick(existingNick) || cleanNick(requested) || cleanNick(providerName)
  || cleanNick(email ? String(email).split('@')[0] : '');

// --- cookie ---
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// Secure ставим только на проде/https — иначе локалка по http не получит cookie.
export function buildSetCookie(token, { secure = false, ttlMs = SESSION_TTL_MS } = {}) {
  const p = [`${SESSION_COOKIE}=${token}`, 'HttpOnly', 'SameSite=Lax', 'Path=/',
    `Max-Age=${Math.floor(ttlMs / 1000)}`];
  if (secure) p.push('Secure');
  return p.join('; ');
}
export function buildClearCookie({ secure = false } = {}) {
  const p = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) p.push('Secure');
  return p.join('; ');
}

// --- in-memory хранилище сессий: cookie-токен -> { pid, createdAt }, с TTL ---
// БД-персистентность снаружи (index.js): сюда грузим на старте, удаляем протухшие через onExpire.
export function createSessionStore({ ttlMs = SESSION_TTL_MS, now = () => Date.now() } = {}) {
  const map = new Map();
  const expired = rec => now() - rec.createdAt > ttlMs;
  return {
    add(token, pid, createdAt = now()) { map.set(token, { pid, createdAt }); return token; },
    // pid по токену (или null). Протухший — удаляем и зовём onExpire(token) для чистки в БД.
    pid(token, onExpire) {
      const rec = token && map.get(token);
      if (!rec) return null;
      if (expired(rec)) { map.delete(token); onExpire?.(token); return null; }
      return rec.pid;
    },
    delete(token) { return map.delete(token); },
    // загрузка из БД на старте: пропускаем уже протухшие (их вернём для удаления через onExpire)
    load(rows, onExpire) {
      for (const r of rows) {
        const createdAt = Number(r.created_at) || now();
        if (now() - createdAt > ttlMs) { onExpire?.(r.token); continue; }
        map.set(r.token, { pid: r.pid, createdAt });
      }
    },
    size() { return map.size; },
  };
}

// Генерация нового секретного токена сессии (base64url, 24 байта энтропии)
export const newSessionToken = () => crypto.randomBytes(24).toString('base64url');
