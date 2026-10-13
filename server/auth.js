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
// pid аккаунта Telegram по его числовому user id. Префикс 't' — своё пространство: тот же человек из
// Google и из Телеграма — два разных капитана (связывать аккаунты — отдельная задача).
export const telegramPid = id => 't' + sha('tg:' + id).slice(0, 15);

// --- Telegram Mini App: проверка initData ---
// Телеграм открывает мини-апп и даёт строке initData (querystring) подпись: hash = HMAC-SHA256
// по «ключ=значение» всех полей (кроме hash), отсортированных по ключу и склеенных '\n', где
// секрет = HMAC-SHA256(ключ 'WebAppData', данные — токен бота). Проверяем подпись и свежесть
// auth_date (initData можно скопировать и переиспользовать — ограничиваем окно), возвращаем
// разобранного user + start_param, либо null. Чистая функция — для тестов.
export const TELEGRAM_INIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function verifyTelegramInitData(initData, botToken, { now = () => Date.now(), maxAgeMs = TELEGRAM_INIT_MAX_AGE_MS } = {}) {
  if (!initData || !botToken || typeof initData !== 'string' || initData.length > 4096) return null;
  let params;
  try { params = new URLSearchParams(initData); } catch { return null; }
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  const pairs = [];
  for (const [k, v] of params) if (k !== 'hash') pairs.push(`${k}=${v}`);
  pairs.sort();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(hash.toLowerCase(), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get('auth_date')) * 1000;
  if (!Number.isFinite(authDate) || authDate <= 0 || now() - authDate > maxAgeMs || authDate - now() > 60 * 1000) return null;
  let user = null;
  try { user = JSON.parse(params.get('user') || 'null'); } catch { return null; }
  if (!user || !Number.isInteger(user.id) || user.id <= 0) return null;
  return {
    id: user.id,
    firstName: String(user.first_name || ''), lastName: String(user.last_name || ''),
    username: String(user.username || ''), photoUrl: /^https:\/\//.test(user.photo_url || '') ? user.photo_url : null,
    lang: String(user.language_code || '').slice(0, 2).toLowerCase(),
    startParam: String(params.get('start_param') || '').slice(0, 64)
  };
}
// Имя для ника из данных Телеграма: «Имя Фамилия», иначе @username
export const telegramName = u => [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username || '';
// нормализуем ник: тримим и режем по длине (тот же лимит, что в UI)
export const cleanNick = (n, max = 20) => String(n || '').trim().slice(0, max);

// Ник аккаунта при входе. Приоритет: СОХРАНЁННЫЙ ник аккаунта > явно введённый игроком >
// имя из Google > префикс email. Сохранённый главнее — чтобы вернувшийся игрок получил СВОЙ
// ник, а не тот, что случайно остался в localStorage от прошлого аккаунта на этом устройстве.
export const resolveAccountNick = (existingNick, requested, providerName, email) =>
  cleanNick(existingNick) || cleanNick(requested) || cleanNick(providerName)
  || cleanNick(email ? String(email).split('@')[0] : '');

// --- откуда брать токен сессии ---
// Обычный браузер: httpOnly-cookie. Telegram Mini App (WebView, особенно iOS) куки может не сохранить —
// там клиент держит токен сам и шлёт его заголовком Authorization: Bearer <токен> (HTTP) или в
// socket.handshake.auth.session (сокет). Cookie главнее: если она есть, заголовок не смотрим.
export function sessionTokenOf(cookieHeader, authHeader = null, socketAuth = null) {
  const fromCookie = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (fromCookie) return fromCookie;
  const m = /^Bearer\s+([A-Za-z0-9_-]{16,128})$/.exec(String(authHeader || '').trim());
  if (m) return m[1];
  const s = socketAuth && typeof socketAuth === 'object' ? socketAuth.session : null;
  return typeof s === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(s) ? s : null;
}

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
