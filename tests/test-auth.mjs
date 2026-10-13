import crypto from 'node:crypto';
// Тесты авторизации/личности: чистая логика из server/auth.js + правило ranked из game.js.
// Покрывают: стабильность pid аккаунта (кросс-девайс), гость≠аккаунт, нормализацию ника,
// парсинг/сборку cookie (включая Secure только на проде), TTL хранилища сессий, isRanked.
import {
  pidOf, googlePid, telegramPid, verifyTelegramInitData, telegramName, cleanNick, resolveAccountNick, parseCookies, sessionTokenOf, createLinkCodes,
  buildSetCookie, buildClearCookie, createSessionStore, newSessionToken,
  SESSION_COOKIE, SESSION_TTL_MS
} from '../server/auth.js';
import { isRanked } from '../server/game.js';

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


// === Telegram Mini App: pid и проверка подписи initData ===
eq('telegramPid детерминирован', telegramPid(12345), telegramPid(12345));
no('telegramPid отличается для разных id', telegramPid(1) === telegramPid(2));
yes('telegramPid начинается с t', telegramPid(777).startsWith('t'));
eq('telegramPid длина 16', telegramPid(777).length, 16);
no('Telegram ≠ Google для одного числа', telegramPid(5) === googlePid(5));
{
  const BOT = '123456:ABC-DEF_botsecret';
  const NOW = 1_800_000_000_000;
  // собрать initData так, как это делает Телеграм
  const sign = (fields, token = BOT) => {
    const p = new URLSearchParams(fields);
    const check = [...p].filter(([k]) => k !== 'hash').map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
    p.set('hash', crypto.createHmac('sha256', secret).update(check).digest('hex'));
    return p.toString();
  };
  const user = JSON.stringify({ id: 42, first_name: 'Іван', last_name: 'Сірко', username: 'sirko', language_code: 'uk', photo_url: 'https://t.me/i/userpic/320/x.jpg' });
  const good = sign({ query_id: 'AAE', user, auth_date: String(NOW / 1000 - 60), start_param: 'ab-CD12' });
  const opts = { now: () => NOW };
  const ok = verifyTelegramInitData(good, BOT, opts);
  yes('честная подпись принимается', !!ok);
  eq('user.id разобран', ok?.id, 42);
  eq('имя для ника — «Имя Фамилия»', telegramName(ok), 'Іван Сірко');
  eq('язык — первые две буквы', ok?.lang, 'uk');
  eq('start_param доходит', ok?.startParam, 'ab-CD12');
  eq('аватар — только https', ok?.photoUrl, 'https://t.me/i/userpic/320/x.jpg');
  yes('подпись другим токеном бота — отказ', verifyTelegramInitData(good, 'other:token', opts) === null);
  yes('подменённый user — отказ', verifyTelegramInitData(good.replace('%22id%22%3A42', '%22id%22%3A43'), BOT, opts) === null);
  yes('без hash — отказ', verifyTelegramInitData(good.replace(/&hash=[0-9a-f]+/, ''), BOT, opts) === null);
  const old = sign({ user, auth_date: String(NOW / 1000 - 2 * 24 * 3600) });
  yes('старше суток — отказ (initData нельзя переиспользовать вечно)', verifyTelegramInitData(old, BOT, opts) === null);
  yes('без user — отказ', verifyTelegramInitData(sign({ auth_date: String(NOW / 1000) }), BOT, opts) === null);
  yes('пустая строка — отказ', verifyTelegramInitData('', BOT, opts) === null);
  yes('без токена бота — отказ', verifyTelegramInitData(good, null, opts) === null);
  const noname = verifyTelegramInitData(sign({ user: JSON.stringify({ id: 7, username: 'ghost' }), auth_date: String(NOW / 1000) }), BOT, opts);
  eq('без имени — @username', telegramName(noname), 'ghost');
  eq('без аватара — null', noname?.photoUrl, null);
}


// === Сессия без cookie: cookie главнее, иначе Authorization: Bearer, иначе socket.handshake.auth ===
{
  const TOK = 'abcDEF123456_-xyz789';
  eq('из cookie', sessionTokenOf('a=1; sb_session=' + TOK, 'Bearer other0000000000000'), TOK);
  eq('без cookie — из Bearer', sessionTokenOf('', 'Bearer ' + TOK), TOK);
  eq('Bearer регистр схемы строгий', sessionTokenOf('', 'bearer ' + TOK), null);
  eq('не Bearer — null', sessionTokenOf('', 'Basic ' + TOK), null);
  eq('слишком короткий токен — null', sessionTokenOf('', 'Bearer short'), null);
  eq('мусор в токене — null', sessionTokenOf('', 'Bearer ' + TOK + ';drop'), null);
  eq('из handshake.auth.session', sessionTokenOf(undefined, undefined, { session: TOK }), TOK);
  eq('auth не объект — null', sessionTokenOf(undefined, undefined, 'x'), null);
  eq('auth.session не строка — null', sessionTokenOf(undefined, undefined, { session: 42 }), null);
  eq('ничего нет — null', sessionTokenOf(undefined, undefined, undefined), null);
}


// === Слияние аккаунтов: remap сессий и коды привязки ===
{
  const st = createSessionStore({ now: () => 1000 });
  st.add('s1', 'gAAA'); st.add('s2', 'gAAA'); st.add('s3', 'tBBB');
  eq('remap переводит все сессии старого pid', st.remap('gAAA', 'tBBB'), 2);
  eq('…и они ведут на новый', [st.pid('s1'), st.pid('s2'), st.pid('s3')], ['tBBB', 'tBBB', 'tBBB']);
  eq('remap без совпадений — 0', st.remap('nope', 'x'), 0);
}
{
  let t = 0; const codes = createLinkCodes({ ttlMs: 1000, now: () => t });
  const c = codes.issue('tAAA');
  yes('код из 6 символов безопасного алфавита', /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(c));
  eq('claim отдаёт владельца', codes.claim(c), 'tAAA');
  eq('код одноразовый', codes.claim(c), null);
  const c2 = codes.issue('tAAA');
  eq('регистр и мусор во вводе не мешают', codes.claim(' ' + c2.toLowerCase() + '-'), 'tAAA');
  const c3 = codes.issue('tAAA'); const c4 = codes.issue('tAAA');
  eq('новый код отзывает предыдущий того же аккаунта', codes.claim(c3), null);
  eq('…а последний работает', codes.claim(c4), 'tAAA');
  const c5 = codes.issue('gBBB'); t = 2000;
  eq('протухший код не принимается', codes.claim(c5), null);
  eq('чужой/несуществующий — null', codes.claim('ZZZZZZ'), null);
  eq('size чистит протухшие', codes.size(), 0);
}

console.log(fail ? `❌ test-auth: провалено ${fail}, прошло ${ok}` : `✅ test-auth: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
