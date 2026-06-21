// Тесты авторизации/личности: чистая логика из server/auth.js + правило ranked из game.js.
// Покрывают: стабильность pid аккаунта (кросс-девайс), гость≠аккаунт, нормализацию ника,
// парсинг/сборку cookie (включая Secure только на проде), TTL хранилища сессий, isRanked.
import {
  pidOf, googlePid, cleanNick, resolveAccountNick, parseCookies,
  buildSetCookie, buildClearCookie, createSessionStore, newSessionToken,
  SESSION_COOKIE, SESSION_TTL_MS
} from './server/auth.js';
import { isRanked } from './server/game.js';

let ok = 0, fail = 0;
const eq = (n, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  pass ? ok++ : (fail++, console.error(`✗ ${n}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const yes = (n, cond) => { cond ? ok++ : (fail++, console.error(`✗ ${n}: ожидалось true`)); };
const no  = (n, cond) => { !cond ? ok++ : (fail++, console.error(`✗ ${n}: ожидалось false`)); };

// === pid аккаунта: один Google sub → один pid на любом устройстве ===
eq('googlePid детерминирован', googlePid('sub-12345'), googlePid('sub-12345'));
no('googlePid отличается для разных sub', googlePid('a') === googlePid('b'));
yes('googlePid начинается с g', googlePid('whatever').startsWith('g'));
eq('googlePid длина 16 (g + 15 hex)', googlePid('x').length, 16);

// === гость: pid из токена, детерминирован, ≠ аккаунт ===
eq('pidOf детерминирован', pidOf('tok'), pidOf('tok'));
no('pidOf отличается для разных токенов', pidOf('tok1') === pidOf('tok2'));
no('гость ≠ аккаунт (разные пространства)', pidOf('sub-12345') === googlePid('sub-12345'));

// === нормализация ника ===
eq('cleanNick тримит', cleanNick('  Капитан  '), 'Капитан');
eq('cleanNick режет до 20', cleanNick('x'.repeat(50)).length, 20);
eq('cleanNick из null', cleanNick(null), '');
eq('cleanNick из undefined', cleanNick(undefined), '');
eq('cleanNick из числа', cleanNick(777), '777');
eq('cleanNick кастомный лимит', cleanNick('abcdef', 3), 'abc');

// === ник аккаунта при входе: сохранённый главнее (вспоминаем свой, не берём чужой из localStorage) ===
eq('логин: сохранённый ник главнее введённого', resolveAccountNick('Старый', 'Новый', 'Google Name', 'a@b.com'), 'Старый');
eq('логин: нет аккаунта → берём введённый', resolveAccountNick(null, 'Новый', 'Google Name', 'a@b.com'), 'Новый');
eq('логин: нет ника → имя Google', resolveAccountNick('', '', 'Google Name', 'a@b.com'), 'Google Name');
eq('логин: ничего нет → префикс email', resolveAccountNick(null, null, null, 'jack@example.com'), 'jack');
eq('логин: пустой/пробельный сохранённый не считается', resolveAccountNick('   ', 'Новый', 'G', 'a@b.com'), 'Новый');
eq('логин: сохранённый режется до 20', resolveAccountNick('x'.repeat(40), 'Новый', 'G', 'a@b.com').length, 20);

// === парсинг cookie ===
eq('parseCookies одна', parseCookies('sb_session=abc'), { sb_session: 'abc' });
eq('parseCookies несколько', parseCookies('a=1; b=2; c=3'), { a: '1', b: '2', c: '3' });
eq('parseCookies пусто', parseCookies(''), {});
eq('parseCookies undefined', parseCookies(undefined), {});
eq('parseCookies url-decode', parseCookies('x=a%20b'), { x: 'a b' });
eq('parseCookies игнорит мусор без =', parseCookies('garbage; ok=1'), { ok: '1' });

// === сборка cookie ===
const setC = buildSetCookie('TOK', { secure: false });
yes('Set-Cookie содержит токен', setC.startsWith(`${SESSION_COOKIE}=TOK`));
yes('Set-Cookie HttpOnly', /HttpOnly/.test(setC));
yes('Set-Cookie SameSite=Lax', /SameSite=Lax/.test(setC));
yes('Set-Cookie Path=/', /Path=\//.test(setC));
yes('Set-Cookie Max-Age задан', /Max-Age=\d+/.test(setC));
no('Set-Cookie без Secure локально', /Secure/.test(setC));
yes('Set-Cookie с Secure на проде', /Secure/.test(buildSetCookie('TOK', { secure: true })));
const clr = buildClearCookie({ secure: false });
yes('Clear-Cookie обнуляет Max-Age', /Max-Age=0/.test(clr));
no('Clear-Cookie без значения токена', /sb_session=[^;]/.test(clr));

// === хранилище сессий + TTL (с искусственными часами) ===
{
  let clock = 0;
  const store = createSessionStore({ ttlMs: 1000, now: () => clock });
  store.add('t1', 'pidA', 0);
  clock = 500;
  eq('сессия в пределах TTL', store.pid('t1'), 'pidA');
  eq('неизвестный токен → null', store.pid('nope'), null);
  clock = 2000;
  let expired = [];
  eq('протухшая сессия → null', store.pid('t1', t => expired.push(t)), null);
  eq('onExpire вызван для протухшей', expired, ['t1']);
  eq('после протухания удалена', store.pid('t1'), null);
}
{
  let clock = 0;
  const store = createSessionStore({ ttlMs: 1000, now: () => clock });
  store.add('a', 'pa', 0);
  yes('delete возвращает true для существующей', store.delete('a'));
  eq('после delete → null', store.pid('a'), null);
}
{
  // загрузка из БД на старте: свежие грузятся, протухшие — на удаление через onExpire
  const clock = 10000;
  const store = createSessionStore({ ttlMs: 1000, now: () => clock });
  const dropped = [];
  store.load([
    { token: 'fresh', pid: 'pf', created_at: 9900 },   // 100 мс назад — живая
    { token: 'old', pid: 'po', created_at: 5000 }       // 5000 мс назад — протухла
  ], t => dropped.push(t));
  eq('load: свежая поднялась', store.pid('fresh'), 'pf');
  eq('load: протухшая не поднялась', store.pid('old'), null);
  eq('load: протухшая отдана на удаление', dropped, ['old']);
  eq('load: в памяти только свежая', store.size(), 1);
}

// === токен сессии ===
{
  const toks = new Set();
  for (let i = 0; i < 200; i++) toks.add(newSessionToken());
  eq('newSessionToken уникален', toks.size, 200);
  const sample = newSessionToken();
  yes('newSessionToken base64url', /^[A-Za-z0-9_-]+$/.test(sample));
  yes('newSessionToken достаточной длины', sample.length >= 30);
}

// === TTL по умолчанию — 30 дней ===
eq('SESSION_TTL_MS = 30 дней', SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);

// === ranked: в лидерборд идут только онлайн-игры ===
yes('онлайн (listed) — ranked', isRanked({ config: { listed: true } }));
no('игра с ботами — не ranked', isRanked({ config: { botGame: true } }));
no('хотсит — не ranked', isRanked({ config: { hotseat: true } }));
no('без config — не ranked', isRanked({}));
no('null — не ranked', isRanked(null));

console.log(fail ? `❌ test-auth: провалено ${fail}, прошло ${ok}` : `✅ test-auth: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
