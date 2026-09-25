// HTTP + WebSocket сервер. Игра живёт по ссылке /game/<id>.
//
// Необязательные переменные окружения:
//   DATABASE_URL (или DB_HOST/DB_USER/DB_PASSWORD/DB_NAME) — подключение к MySQL (см. db.js)
//   GOOGLE_CLIENT_ID — включает «Войти через Google»
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM — включают письма «поторопить»
//   BASE_URL — адрес сайта для ссылок в письмах (например https://game.example.ua)
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import * as db from './db.js';
import {
  createGame, addPlayer, startGame, applyAction, leaveGame, nudge,
  timeoutTurn, publicState, setColor, randomFreeColor, forceFinish, lobbyExpired, gameStale, myGameSummary, lobbyTags, PALETTE, spawnPirateAt, spawnShipAt
} from './game.js';
import {
  SESSION_COOKIE, pidOf, googlePid, cleanNick, resolveAccountNick, parseCookies,
  buildSetCookie, buildClearCookie, createSessionStore, newSessionToken
} from './auth.js';
import { chooseBotAction, BOT_NAMES, duelFleetPlan } from './bot.js';
import {
  LANGS, LANG_COOKIE, SOURCE_LANG, DEFAULT_LANG, normLang, pickLang, buildLangCookie,
  langFromPath, withLang, stripLang, langAlternates
} from './i18n.js';
import { applyCheat } from './cheats.js';
import {
  ogHead, gameFacts, previewLang, absUrl, canonicalPath, ogImage, canonicalUrl, indexable,
  gameSchema, robotsTxt, sitemapXml, hreflangLinks, OG_IMAGE
} from './og.js';
import { VERSION, versionLabel } from './version.js';
import { rtStart, rtStop } from './rt.js';
import {
  CHEATS_ENABLED, DEBUG, DEBUG_REQUESTED, PRODUCTION, MAX_ACTIVE_GAMES, NUDGE_MAIL_COOLDOWN_MS,
  GAME_MODES, enabledModes, DEFAULT_MODE, isDuel, isRealtime, realtimeAllowed, SHIP_TYPES, PIRATE
} from './config.js';
// валидируем игровой режим из запроса (classic/deathmatch/develop) — только из включённых
const pickMode = m => enabledModes().includes(m) ? m : DEFAULT_MODE;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');   // не подсказываем сканерам, на чём мы написаны
app.set('trust proxy', 1); // за прокси (Render): корректный протокол — нужно для Secure-cookie

// Заголовки безопасности на КАЖДЫЙ ответ. CSP тут нет: она зависит от nonce конкретной
// страницы и ставится в renderPage (см. ниже) — и только на две боевые страницы, чтобы не
// ломать лаборатории в public/, у которых свои встроенные скрипты.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');          // не угадывать тип по содержимому
  res.setHeader('X-Frame-Options', 'DENY');                    // старый запрет фреймов (для старых браузеров)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); // не светим полный путь наружу
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  next();
});
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3456;

app.use(express.json());
const PUBLIC = path.join(__dirname, '..', 'public');

// --- СТРАНИЦЫ: текст подставляет СЕРВЕР, а не скрипт в браузере ---
// Раньше страница уезжала на одном языке, а нужный подставлял клиент по data-i18n. На локалхосте
// это незаметно, но на медленном канале HTML успевает отрисоваться раньше, чем догрузятся
// i18next и i18n.js, — и человек несколько секунд смотрит на чужой язык. Поэтому подстановку
// делает рендер: в браузер уходят байты уже на нужном языке, и JS для этого не нужен вовсе.
// data-i18n остаётся в разметке — по нему клиент перерисовывает текст, когда язык меняют на лету.
// Роуты стоят ПЕРЕД express.static — иначе она перехватит.
const langDict = code => fsp.readFile(path.join(PUBLIC, 'locales', code + '.json'), 'utf8').then(JSON.parse);

// Готовая страница на каждый (файл, язык). Файлов два, языков три — шесть строк в памяти;
// пересобираем, только если правили HTML или словарь (следим по mtime, чтобы --watch не мешал).
const NONCE_MARK = '__CSP_NONCE__';   // метка в кэше страницы; на отправке меняется на живой nonce
const pageCache = new Map();
const mtime = f => fsp.stat(f).then(s => s.mtimeMs);

async function buildPage(file, lang) {
  const htmlPath = path.join(PUBLIC, file), dictPath = path.join(PUBLIC, 'locales', lang + '.json');
  const stamp = (await mtime(htmlPath)) + ':' + (await mtime(dictPath));
  const key = file + '|' + lang;
  const hit = pageCache.get(key);
  if (hit && hit.stamp === stamp) return hit.html;

  const dict = await langDict(lang);
  const at = k => k.split('.').reduce((o, p) => o?.[p], dict);
  const text = k => { const v = at(k); return v === undefined ? k : String(v); };  // нет ключа — виден ключ
  const boot = { lang, source: SOURCE_LANG, def: DEFAULT_LANG, langs: LANGS, res: { [lang]: dict } };

  const html = (await fsp.readFile(htmlPath, 'utf8'))
    // 1. содержимое помеченных элементов: <p data-i18n="ключ">…</p> и data-i18n-html
    .replace(/<([a-z0-9]+)([^>]*\sdata-i18n(?:-html)?="([\w.]+)"[^>]*)>([\s\S]*?)<\/\1>/g,
      (m, tag, attrs, key) => `<${tag}${attrs}>${text(key)}</${tag}>`)
    // 2. атрибуты: data-i18n-attr="title:ключ; placeholder:ключ2"
    .replace(/<[a-z0-9]+[^>]*data-i18n-attr="([^"]+)"[^>]*\/?>/g, (tagHtml, spec) => {
      let out = tagHtml;
      for (const pair of spec.split(';')) {
        const i = pair.indexOf(':');
        if (i < 0) continue;
        const attr = pair.slice(0, i).trim();
        out = out.replace(new RegExp(`\\s${attr}="[^"]*"`), ` ${attr}="${text(pair.slice(i + 1).trim()).replace(/"/g, '&quot;')}"`);
      }
      return out;
    })
    .replace(/<html lang="[^"]*"/, `<html lang="${lang}"`)
    // 3. словарь в <head> — он нужен уже только для динамики: журнал, тосты, смена языка на лету.
    //    '<' экранируем: строка вида "</script>" в словаре иначе закрыла бы тег.
    // ⚠ Вшитый словарь — ВСТРОЕННЫЙ скрипт, и его срезает наш же CSP. Реальный nonce у каждого
    // запроса свой, а страница кэшируется на (файл, язык) — поэтому в кэш кладём метку, а
    // подменяем её на живой nonce перед самой отправкой (renderPage).
    .replace('</head>', `  <script nonce="${NONCE_MARK}">window.__SB_I18N=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>\n</head>`);

  pageCache.set(key, { stamp, html });
  return html;
}

// Язык этого запроса: профиль аккаунта > кука > дефолт (см. pickLang в i18n.js).
// Язык для страницы. АДРЕС ГЛАВНЕЕ ВСЕГО: /en/ обязан показать английский, даже если в профиле
// русский — иначе canonical начнёт врать, а страница спорить сама с собой. Профиль и кука решают
// только одно: куда увести с голого адреса без префикса (см. redirectToLang ниже).
async function reqLang(req) {
  const fromPath = langFromPath(req.path).lang;
  if (fromPath) return fromPath;
  return pickLang({ profile: await profileLang(req), cookie: parseCookies(req.headers.cookie)[LANG_COOKIE] });
}
const profileLang = async req => {
  const pid = accountPidFromReq(req);
  return pid ? (await db.getPlayer(pid))?.lang : null;
};

// --- ПРЕВЬЮ ССЫЛКИ (Open Graph): что мессенджер покажет вместо голого URL ---
// Правила и формат — в og.js. Тут только «достать данные и подставить текст».
const CHARSET_META = '<meta charset="UTF-8">';   // якорь вставки: теги идут сразу за кодировкой
const reqOrigin = req => process.env.BASE_URL
  || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;

// Метка версии OG-карточки. Берём время правки файла, а не хэш: читать 200 КБ ради восьми
// символов незачем. Считается один раз за жизнь процесса — картинку меняют вместе с деплоем,
// а деплой перезапускает сервер (в разработке после подмены файла нужен рестарт).
let ogVersion = null;
async function ogImageUrl() {
  if (ogVersion === null)
    ogVersion = await fsp.stat(path.join(PUBLIC, OG_IMAGE))
      .then(st => Math.round(st.mtimeMs).toString(36))
      .catch(() => '');   // файла нет — отдаём адрес без метки, превью важнее падения
  return ogImage(ogVersion);
}

const escAttr = v => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

async function ogBlock(req, game, nonce = '') {
  // язык превью — из ссылки (?l=, его туда кладёт «скопировать» у отправителя),
  // иначе язык создателя партии, иначе дефолт. На саму страницу это не влияет.
  const hostLang = game?.hostPid ? (await db.getPlayer(game.hostPid))?.lang : null;
  const lang = previewLang({ path: req.path, hostLang });
  const T = (k, p) => mailT(lang, k, p);                  // тот же резолвер, что у писем
  const origin = reqOrigin(req);
  const url = absUrl(origin, canonicalPath(req.originalUrl));
  const base = {
    lang, url,
    siteName: await T('og.site'),
    image: absUrl(origin, await ogImageUrl()),
    imageAlt: await T('og.imageAlt')
  };
  // Для поисковика: canonical (у страницы один настоящий адрес — без ?l= и прочего хвоста)
  // и, для страницы партии, запрет индексации.
  const seo = [`  <link rel="canonical" href="${escAttr(canonicalUrl(origin, req.path))}">`];
  // hreflang: «эта же страница на других языках». Без него поисковик считает переводы дублями
  // и показывает один — ровно та беда, ради которой языки и разъехались по адресам.
  // Страницам партий не нужен: они всё равно noindex.
  if (indexable(!!game))
    for (const a of hreflangLinks(origin, req.path))
      seo.push(`  <link rel="alternate" hreflang="${a.hreflang}" href="${escAttr(a.href)}">`);
  else seo.push('  <meta name="robots" content="noindex">');

  if (!game) {
    const desc = await T('og.homeDesc');
    // Разметка для поисковика. Тег со script — под nonce, иначе его срежет наш же CSP.
    const schema = gameSchema({ siteName: base.siteName, description: desc, url: canonicalUrl(origin, req.path), image: base.image });
    seo.push(`  <script type="application/ld+json"${nonce ? ` nonce="${nonce}"` : ''}>${JSON.stringify(schema).replace(/</g, '\\u003c')}</script>`);
    return ogHead({ ...base, title: await T('og.homeTitle'), description: desc }) + seo.join('\n') + '\n';
  }
  // описание — только НЕИЗМЕНЯЕМЫЕ приметы партии (см. предупреждение в og.js)
  const facts = [];
  for (const f of gameFacts(game)) facts.push(await T(f.k, f.p));
  return ogHead({ ...base, title: await T('og.gameTitle'), description: facts.join(' · ') }) + seo.join('\n') + '\n';
}

// Content-Security-Policy. Сеть страницы описана явно: что не перечислено — браузер не загрузит.
// Это страховка от XSS: даже если чужой текст когда-нибудь просочится в разметку, выполнить его
// будет нечем. Внешние адреса тут только гугловы — вход, шрифты и аватарки.
// ⚠ style-src 'unsafe-inline' пока нужен: в разметке десятки style="…" и лаборатории вставляют
//   свои <style>. Убрать можно только вместе с ними — отдельной уборкой.
const csp = (nonce) => [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",                                  // нас нельзя вложить в чужой фрейм
  "form-action 'self'",
  `script-src 'self' 'nonce-${nonce}' https://accounts.google.com https://apis.google.com`,
  "frame-src https://accounts.google.com",                   // окно входа Google
  "connect-src 'self' https://accounts.google.com",          // сюда же попадает наш WebSocket
  "img-src 'self' data: https://*.googleusercontent.com https://*.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com"
].join('; ');

async function renderPage(file, req, res, game = null) {
  try {
    let html = await buildPage(file, await reqLang(req));
    const nonce = crypto.randomBytes(16).toString('base64url');
    html = html.replaceAll(NONCE_MARK, nonce);
    res.setHeader('Content-Security-Policy', csp(nonce));
    // Страницу партии из индекса убираем ещё и заголовком: он сильнее мета-тега — действует,
    // даже если краулер не дочитал до <head> или получил страницу по редиректу.
    if (!indexable(!!game)) res.setHeader('X-Robots-Tag', 'noindex');
    // Вставляем В НАЧАЛО <head>, а не перед </head>: там уже лежит вшитый словарь на десятки
    // килобайт, а краулеры читают только начало страницы — за ним теги можно и не найти.
    // Но ПОСЛЕ <meta charset>: объявление кодировки обязано идти первым, иначе кириллица в
    // самих тегах рискует быть разобранной не в той кодировке.
    // Готовая страница в памяти при этом не меняется: правим копию перед самой отправкой.
    const og = await ogBlock(req, game, nonce).catch(e => (console.error('og:', e.message), ''));
    if (og) html = html.includes(CHARSET_META)
      ? html.replace(CHARSET_META, CHARSET_META + '\n' + og.replace(/\n$/, ''))
      : html.replace('<head>', '<head>\n' + og);
    res.type('html').set('Cache-Control', 'no-cache').send(html);
  } catch (e) {
    console.error('page:', e.message);
    res.sendFile(path.join(PUBLIC, file));   // сломался рендер — отдаём как есть, на языке разметки
  }
}
// Поисковикам: что можно обходить и где карта сайта. Отдаём динамически — адрес сайта
// зависит от того, как нас открыли (BASE_URL или заголовки запроса), в статике его не зашить.
app.get('/robots.txt', (req, res) =>
  res.type('text/plain').set('Cache-Control', 'public, max-age=3600').send(robotsTxt(reqOrigin(req))));
app.get('/sitemap.xml', (req, res) =>
  res.type('application/xml').set('Cache-Control', 'public, max-age=3600').send(sitemapXml(reqOrigin(req))));

// ─── СТРАНИЦЫ ────────────────────────────────────────────────────────────────
// У каждого языка свой адрес: /uk/, /ru/, /en/ и /<язык>/game/<id>. Без этого поисковик
// видит только одну версию — краулер приходит без куки и профиля.
//
// Голые адреса ('/' и '/game/xxx') НЕ ломаем: они уже разосланы по чатам и лежат в закладках.
// Они отвечают 302 на языковую версию — по профилю, иначе по куке, иначе дефолт.
const LANG_SEG = ':lang(' + LANGS.join('|') + ')';
const redirectToLang = async (req, res) => {
  const lang = pickLang({ profile: await profileLang(req), cookie: parseCookies(req.headers.cookie)[LANG_COOKIE] });
  const q = req.originalUrl.slice(req.path.length);   // хвост запроса переносим как есть
  res.redirect(302, withLang(lang, req.path) + q);
};

app.get([`/${LANG_SEG}`, `/${LANG_SEG}/index.html`], (req, res) => renderPage('index.html', req, res));
app.get(['/', '/index.html'], redirectToLang);
app.get('/game.html', (req, res) => renderPage('game.html', req, res));

// ЛАБОРАТОРИИ (*-lab.html и их обвязка) — инструменты разработки: подбор эффектов, звуков,
// сравнение иконок. На бою им делать нечего: чужому человеку они бесполезны, а нам это лишняя
// поверхность (у них свои встроенные скрипты, под которые CSP намеренно не натянут).
// Поэтому на проде их просто нет — отдаём 404 до того, как до файла доберётся express.static.
const LAB_PATH = /^\/(?:[\w-]*lab[\w-]*\.html|draft-[\w-]*\.html|js\/lab-nav\.js|icons-data\.json)$/;
export const isLabPath = p => LAB_PATH.test(p);
app.use((req, res, next) => {
  if (PRODUCTION && isLabPath(req.path)) return res.status(404).type('text/plain').send('Not found');
  next();
});

// no-cache ≠ «не кэшировать»: браузер хранит файл, но ПЕРЕПРОВЕРЯЕТ перед использованием (304 если
// не менялся). Без этого заголовка браузеры кэшируют по эвристике и после апдейта игры днями
// показывают СТАРЫЙ клиент (старую отрисовку/логику) — «фантомные» баги, которых нет в коде.
app.use(express.static(PUBLIC, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// --- Google Sign-In (опционально) ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
let googleClient = null;
if (GOOGLE_CLIENT_ID) {
  const { OAuth2Client } = await import('google-auth-library');
  googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
  console.log('🔑 Google Sign-In включён');
}

// --- Почта (опционально) ---
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  const nodemailer = (await import('nodemailer')).default;
  const smtpPort = +(process.env.SMTP_PORT || 465);
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: smtpPort,
    secure: smtpPort === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log('📯 Почтовые уведомления включены');
}

// Письмо — ЕДИНСТВЕННОЕ место, где сервер знает конкретного адресата, а значит и его язык
// (в игре-то он шлёт ключи — см. server/i18n.js). Поэтому тут словарь читает сам сервер.
// Кэш словаря СЛЕДИТ ЗА mtime — как и готовые страницы (buildPage). Без этого правка перевода
// подхватывалась страницей, но не письмами и превью ссылок: текст на сайте новый, в карточке
// старый, и виноватым выглядит код. Файлов три, проверка — один stat на запрос.
const dictCache = new Map();
async function serverDict(lang) {
  const file = path.join(PUBLIC, 'locales', lang + '.json');
  const stamp = await mtime(file).catch(() => 0);
  const hit = dictCache.get(lang);
  if (hit && hit.stamp === stamp) return hit.dict;
  const dict = await langDict(lang).catch(() => ({}));
  dictCache.set(lang, { stamp, dict });
  return dict;
}
// t() для сервера: достаём по точечному пути и подставляем {{плейсхолдеры}}
const pick = (o, key) => key.split('.').reduce((x, k) => x?.[k], o);
async function mailT(lang, key, params = {}) {
  const line = pick(await serverDict(lang), key) ?? pick(await serverDict(SOURCE_LANG), key) ?? key;
  return String(line).replace(/{{\s*(\w+)\s*}}/g, (_, k) => params[k] ?? '');
}

// Когда кому в последний раз уходило письмо-напоминание. Ключ — адрес получателя, а не партия:
// иначе, ведя пять партий с одним человеком, ему можно написать пять раз подряд.
// Карта живёт в памяти: рестарт сервера сбрасывает паузу — не страшно, это защита от потока,
// а не учёт. Чистим по ходу, чтобы не росла без предела.
const nudgeMailAt = new Map();
function mayMailNudge(email) {
  const now = Date.now();
  if (nudgeMailAt.size > 500) for (const [k, t] of nudgeMailAt) if (now - t > NUDGE_MAIL_COOLDOWN_MS) nudgeMailAt.delete(k);
  const last = nudgeMailAt.get(email);
  if (last && now - last < NUDGE_MAIL_COOLDOWN_MS) return false;
  nudgeMailAt.set(email, now);
  return true;
}

// Письмо уходит, только если получатель СОГЛАСЕН (чекбокс в профиле, по умолчанию включён)
// и ему давно не писали. Согласие — главное: пауза лишь страхует от потока, но молчаливо
// слать почту тому, кто её не просил, нельзя даже раз в полчаса.
async function sendNudgeEmail(email, nick, gameUrl, lang = SOURCE_LANG, allowed = true) {
  if (!mailer || !email) return false;
  if (!allowed) return false;               // человек отказался от напоминаний — в игре ход всё равно торопится
  if (!mayMailNudge(email)) return false;   // недавно уже писали — в игре «поторопить» сработает, письма не будет
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: await mailT(lang, 'mail.nudge.subject'),
      text: await mailT(lang, 'mail.nudge.text', { nick, url: gameUrl }),
      html: await mailT(lang, 'mail.nudge.html', { nick, url: gameUrl })
    });
    return true;
  } catch (e) {
    console.error('Письмо не отправлено:', e.message);
    return false;
  }
}

// Личность: pidOf (гость) и googlePid (аккаунт) — в auth.js. Серверные сессии Google-входа
// держим в памяти (грузим на старте, дополняем при логине) — pid аккаунта резолвится синхронно.
const cookieSecure = () => process.env.NODE_ENV === 'production' || /^https:/i.test(process.env.BASE_URL || '');
const sessions = createSessionStore();
// pid аккаунта по cookie-токену (с проверкой срока) или null; протухшую сессию чистим и в БД.
const accountPidFromSession = token => sessions.pid(token, t => db.deleteSession(t));
const accountPidFromReq = req => accountPidFromSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);

// Игры в памяти — источник истины в рантайме (single-instance). Все игры предзагружаются
// из MySQL на старте, а изменения асинхронно сохраняются обратно (durability на деплой).
const games = new Map();

function getGame(id) {
  return games.get(id) || null;
}

// Сколько НЕзавершённых партий этот игрок СОЗДАЛ: лобби, онлайн, бот, хотсит — всё вместе.
// Ресурсы съедает именно создание (полный JSON состояния в памяти и в базе), поэтому потолок
// висит на создателе. Партии, куда его позвали гостем, не считаем: чужое лобби ему ничего не
// стоит, а наказывать за приглашения — глупо. Доигранные тоже мимо: они никому не мешают.
function createdGamesOf(pid) {
  if (!pid) return 0;
  let n = 0;
  for (const g of games.values()) {
    if (g.status === 'finished') continue;
    if (g.hostPid === pid || g.hotseatOwner === pid) n++;
  }
  return n;
}
// true → отказать: своих партий уже слишком много
const tooManyGames = pid => createdGamesOf(pid) >= MAX_ACTIVE_GAMES;

// Персональная рассылка состояния: каждому сокету — со своей видимостью золота.
async function broadcastState(game) {
  const sockets = await io.in('game:' + game.id).fetchSockets();
  for (const s of sockets) s.emit('state', publicState(game, s.data.pid));
}

function persistAndBroadcast(game) {
  game.updatedAt = Date.now();   // отметка последней активности — по ней сборщик чистит заброшенные игры
  maybeBotBuy(game);   // дуэль: боты собирают флот в фазе закупки (до рассылки состояния)
  db.saveGame(game);
  broadcastState(game);
  maybeBotTurn(game);
  broadcastLobbies(); // слоты/статус лобби могли измениться
}

// Переименование аккаунта. Ник живёт в трёх местах сразу: профиль в БД (он же светится в
// лидерборде), игроки внутри НЕзаконченных партий и витрина лобби. Меняем везде одним заходом —
// иначе соперник в лобби продолжит видеть старое имя до перезахода.
// Доигранные партии не трогаем: это история, и строки в results там уже свои.
// Хотсит тоже мимо — там игроки ходят под псевдоаккаунтами вида `pid#0`, а не под pid владельца.
function renameEverywhere(pid, nick) {
  db.upsertPlayer(pid, nick);
  let touched = 0;
  for (const g of games.values()) {
    if (g.status === 'finished') continue;
    const p = g.players.find(pl => pl.id === pid);
    if (!p || p.nick === nick) continue;
    p.nick = nick;
    db.saveGame(g);
    broadcastState(g);
    touched++;
  }
  if (touched) broadcastLobbies();   // имя хоста в витрине могло измениться
  return touched;
}

// Закрыть ЕЩЁ НЕ НАЧАТОЕ лобби: кто в нём открыт — на главную, запись стереть и из памяти,
// и из базы (иначе закрытое лобби воскреснет при первом же рестарте сервера).
function closeLobby(game) {
  io.to('game:' + game.id).emit('lobbyClosed');
  games.delete(game.id);
  db.deleteGame(game.id);
  broadcastLobbies();
}

// ⚡ «Полный вперёд»: запустить реалтайм-тик игры (движок в rt.js; рассылка/сохранение — наши)
function armRt(game) {
  rtStart(game, { broadcast: broadcastState, save: g => db.saveGame(g) });
}

// Дуэль, фаза закупки: каждый бот сразу собирает флот (умно, на всё золото). Когда все готовы —
// applyAction(buyFleet) сам переключит игру в фазу боя.
function maybeBotBuy(game) {
  if (game?.phase !== 'buy') return;
  for (let i = 0; i < game.players.length; i++) {
    const p = game.players[i];
    if (p.isBot && !p.ready) applyAction(game, p.id, { type: 'buyFleet', ships: duelFleetPlan(game, i, p.botLevel || 'hard') });
  }
}

// --- браузер открытых лобби ---
function lobbyListData(viewerPid) {
  const now = Date.now();
  const list = [];
  for (const g of games.values()) {
    if (g.status === 'lobby' && g.config?.listed && g.players.length > 0 && !lobbyExpired(g, now)) {
      list.push({
        id: g.id, host: g.players[0].nick,
        players: g.players.length, max: g.config.maxPlayers,
        tags: lobbyTags(g), createdAt: g.createdAt,    // метки-отклонения от стандарта (режим/таймер/туман/ход)
        // isHost — я СОЗДАТЕЛЬ лобби (метка «твоё»); mine — я участник (хост ИЛИ уже в лобби) → вернуться можно даже когда полно
        isHost: !!viewerPid && g.hostPid === viewerPid,
        mine: !!viewerPid && (g.hostPid === viewerPid || g.players.some(p => p.id === viewerPid))
      });
    }
  }
  return list.sort((a, b) => b.createdAt - a.createdAt);
}
// мои активные игры (онлайн — по аккаунту, бот — по токену, хотсит — по владельцу устройства)
function myGamesData(viewerPid) {
  const out = [];
  for (const g of games.values()) { const s = myGameSummary(g, viewerPid); if (s) out.push(s); }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
async function broadcastLobbies() {
  // персонально каждому подписчику: и флаг mine у лобби, и список «моих игр» зависят от того, кто смотрит
  for (const s of await io.in('lobbies').fetchSockets())
    s.emit('lobbyList', { lobbies: lobbyListData(s.data.browsePid), myGames: myGamesData(s.data.browsePid) });
}

// Периодическая уборка: заброшенные НЕ начатые лобби (6 ч неполное / 24 ч полное укомплектованное)
// и заброшенные игры (без активности 7 дней — и онлайн, и оффлайн). Чистим и память, и БД,
// иначе при рестарте всё это снова поднимется из базы.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, g] of games)
    if (lobbyExpired(g, now) || gameStale(g, now)) { rtStop(id); games.delete(id); db.deleteGame(id); changed = true; }
  if (changed) broadcastLobbies();
}, 10 * 60 * 1000);

// --- ходы ботов ---
const BOT_DELAY_MS = +(process.env.BOT_DELAY_MS || 1500);
const BOT_FOLLOWUP_MS = +(process.env.BOT_FOLLOWUP_MS || 650); // быстрее на 2-3-м судне того же хода
const botTimers = new Map();
const botStep = new Map(); // gameId -> "idx:number" последней суб-акции (для распознавания продолжения хода)

// 🐞 ОТЛАДКА: решение бота одной строкой — что сделал, из чего выбирал, сколько в казне.
// Без этого «почему он так сходил» можно только гадать по последствиям.
function botDecisionLine(game, d) {
  const name = id => {
    const sh = game.ships.find(s => s.id === id);
    return sh ? sh.type : id;
  };
  const brief = a => {
    switch (a.type) {
      case 'move': return `плыть ${name(a.shipId)} → ${Math.round(a.x)},${Math.round(a.y)}`;
      case 'convoy': return `⛵ строй ${[a.shipId, ...(a.ships || [])].map(name).join(' + ')} → ${Math.round(a.x)},${Math.round(a.y)}`;
      case 'attack': return `🎯 мортира ${name(a.shipId)} → ` +
        (a.targetType === 'port' ? `ПОРТ ${game.players[a.targetId]?.nick}` :
         a.targetType === 'outpost' ? `аванпост #${a.targetId}` : name(a.targetId));
      case 'broadside': return `💥 залп ${name(a.shipId)}`;
      case 'buy': return `🛠 верфь: ${(a.ships || []).join(', ')}`;
      case 'collect': return '💰 собрать клад';
      case 'outpost': return `⛺ аванпост на острове #${a.islandId}`;
      case 'repair': return `🛟 чинить ${name(a.targetId)}`;
      case 'recharge': return '🔧 пополнить материалы';
      case 'skip': return '⏭ пропуск';
      default: return a.type;
    }
  };
  const alt = d.top.slice(1, 4).map(c => `${brief(c.action)} (${c.score})`).join(' · ');
  return `ход ${d.turn} · ${game.players[d.pIdx]?.nick} [${d.level}] 💰${d.gold} · флот ${d.fleet.length} · оценка ${d.value}` +
    `\n   ➜ ${brief(d.chosen.action)} (эвристика ${Math.round(d.chosen.score)}${d.planned ? ', выбран планировщиком' : ''})` +
    (alt ? `\n   иначе: ${alt}` : '');
}

function maybeBotTurn(game) {
  if (game.status !== 'active') return;
  const cur = game.players[game.turn.idx];
  if (!cur?.isBot || botTimers.has(game.id)) return;
  // первый ход бота в свой ход — пауза «на раздумье»; последующие суда того же хода — быстрее
  const stepKey = game.turn.idx + ':' + game.turn.number;
  const delay = botStep.get(game.id) === stepKey ? BOT_FOLLOWUP_MS : BOT_DELAY_MS;
  botStep.set(game.id, stepKey);
  botTimers.set(game.id, setTimeout(() => {
    botTimers.delete(game.id);
    const g = getGame(game.id);
    if (!g || g.status !== 'active') return;
    const bot = g.players[g.turn.idx];
    if (!bot?.isBot) return;
    let action;
    const log = DEBUG
      ? d => io.to('game:' + g.id).emit('botlog', { text: botDecisionLine(g, d), eyes: d.meta || null })
      : null;
    try { action = chooseBotAction(g, g.turn.idx, bot.botLevel, log); }
    catch (e) { console.error('bot:', e.message); action = { type: 'skip' }; }
    let r = applyAction(g, bot.id, action);
    if (!r.ok) r = applyAction(g, bot.id, { type: 'skip' }); // страховка от невалидного хода
    if (g.status === 'finished') db.saveResults(g); // пишем все партии; в лидерборд попадут только рейтинговые
    persistAndBroadcast(g);
  }, delay));
}

// Все живые игроки-люди сдались → не заставляем смотреть, как боты доигрывают:
// прогоняем доигровку за ботов синхронно и завершаем партию (победитель — кто выстоял).
function maybeAutoFinish(game) {
  if (game.status !== 'active') return;
  if (game.players.some(p => p.alive && !p.isBot)) return; // ещё есть живые люди
  if (isRealtime(game)) { forceFinish(game); return; }     // ⛈️ шторм: без пошаговой доигровки — сразу финал по силе
  let guard = 0;
  while (game.status === 'active' && guard++ < 4000) {
    const cur = game.players[game.turn.idx];
    if (!cur?.alive) break; // подстраховка (advanceTurn и так пропускает выбывших)
    let action;
    try { action = chooseBotAction(game, game.turn.idx, cur.botLevel || 'hard'); }
    catch { action = { type: 'skip' }; }
    if (!applyAction(game, cur.id, action).ok) applyAction(game, cur.id, { type: 'skip' });
  }
  if (game.status === 'active') forceFinish(game); // уперлись в лимит — победитель по силе
  clearTimeout(timers.get(game.id));
}

// --- REST ---

app.get('/api/config', (_req, res) => res.json({
  googleClientId: GOOGLE_CLIENT_ID, palette: PALETTE, cheats: CHEATS_ENABLED,
  debug: DEBUG,   // 🐞 SB_DEBUG=1: консоль решений бота под картой + инструменты над ней
  version: VERSION,           // 🏷 номер сборки, коммит и его дата — для подвала главной
  // доступные игровые режимы (для селектора при создании игры)
  modes: enabledModes()   // только ключи: названия и описания у клиента в словаре (mode.<ключ>.name/.desc)
}));

app.post('/api/auth/google', async (req, res) => {
  if (!googleClient) return res.status(400).json({ error: 'err.googleOff' });
  try {
    const { credential, nick } = req.body || {};
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    // Личность аккаунта — стабильный pid из Google sub (а не из email: email может меняться).
    const pid = googlePid(payload.sub);
    // Ник аккаунта = его сохранённый ник (вспоминаем при возврате). Ник от клиента берём ТОЛЬКО при
    // ПЕРВОМ входе (аккаунта ещё нет) — иначе устаревший/чужой ник из localStorage затёр бы свой.
    const existing = await db.getPlayer(pid);
    const finalNick = resolveAccountNick(existing?.nick, nick, payload.name, payload.email);
    const avatar = payload.picture || null;
    db.upsertPlayer(pid, finalNick, payload.email, 'google', avatar);
    // Серверная сессия: секрет в httpOnly-cookie (недоступна из JS — защита от XSS-кражи).
    const session = newSessionToken();
    sessions.add(session, pid);
    db.createSession(session, pid);
    res.append('Set-Cookie', buildSetCookie(session, { secure: cookieSecure() }));
    // Язык аккаунта. Записан в профиле — он и главный (свой язык на любом устройстве).
    // Пусто (первый вход) — усыновляем тот, что гость успел выбрать в куке.
    const lang = normLang(existing?.lang) || normLang(parseCookies(req.headers.cookie)[LANG_COOKIE]);
    if (lang && lang !== normLang(existing?.lang)) db.setPlayerLang(pid, lang);
    if (lang) res.append('Set-Cookie', buildLangCookie(lang, { secure: cookieSecure() }));
    res.json({ nick: finalNick, email: payload.email, avatar, lang: lang || null });
  } catch (e) {
    console.error('Google auth:', e.message);
    res.status(401).json({ error: 'err.googleFailed' });
  }
});

// Кто я (по cookie-сессии). Email/аватар отдаём только владельцу — не в публичный стейт.
app.get('/api/auth/me', async (req, res) => {
  const pid = accountPidFromReq(req);
  if (!pid) return res.json({ loggedIn: false });
  const prof = await db.getPlayer(pid);
  res.json({ loggedIn: true, nick: prof?.nick || '', email: prof?.email || '', avatar: prof?.avatar || '', lang: normLang(prof?.lang), skin: normSkin(prof?.skin) });
});

// ─── Профиль игрока ───────────────────────────────────────────────────────────
// Отдаём ТОЛЬКО свой профиль и только по сессионной куке: чужой ник, почта и статистика
// наружу не уходят никак. Отдельно от /api/auth/me — тот дёргается на каждой загрузке
// страницы, а здесь четыре запроса в базу ради окна, которое открывают изредка.
app.get('/api/profile', async (req, res) => {
  const pid = accountPidFromReq(req);
  if (!pid) return res.status(401).json({ error: 'err.needLogin' });
  const prof = await db.getPlayer(pid);
  const stats = await db.getPlayerStats(pid);
  res.json({
    nick: prof?.nick || '', email: prof?.email || '', avatar: prof?.avatar || '',
    provider: prof?.provider || '', lang: normLang(prof?.lang),
    createdAt: prof?.createdAt || null, mailNudge: prof?.mailNudge !== false, skin: normSkin(prof?.skin), stats
  });
});

// Смена ника из профиля — то же самое, что сокетный setNick, но доступно вне партии.
app.post('/api/profile/nick', async (req, res) => {
  const pid = accountPidFromReq(req);
  if (!pid) return res.status(401).json({ error: 'err.needLogin' });
  const nick = cleanNick(req.body?.nick);
  if (!nick) return res.status(400).json({ error: 'err.nickEmpty' });
  renameEverywhere(pid, nick);
  res.json({ ok: true, nick });
});

// Согласие на письма-напоминания «твой ход». Отказ — это отказ: письмо не уйдёт, даже если
// соперник жмёт «поторопить». Сама механика (укорочение таймера) работает в любом случае.
app.post('/api/profile/mail', async (req, res) => {
  const pid = accountPidFromReq(req);
  if (!pid) return res.status(401).json({ error: 'err.needLogin' });
  const on = !!req.body?.mailNudge;
  await db.setPlayerMailNudge(pid, on);
  res.json({ ok: true, mailNudge: on });
});

// Оформление карты: 'paper' — тетрадь в клетку (вектор), 'sprites' — растровые картинки (public/sprites/).
// Живёт в профиле, чтобы ехало за игроком между устройствами; клиент дублирует в localStorage('sb_skin').
const SKINS = ['paper', 'sprites'];
const normSkin = v => (SKINS.includes(v) ? v : 'paper');
app.post('/api/profile/skin', async (req, res) => {
  const pid = accountPidFromReq(req);
  if (!pid) return res.status(401).json({ error: 'err.needLogin' });
  const skin = req.body?.skin;
  if (!SKINS.includes(skin)) return res.status(400).json({ error: 'err.badSkin' });
  await db.setPlayerSkin(pid, skin);
  res.json({ ok: true, skin });
});

// Смена языка. Гостю — кука, вошедшему — ещё и профиль (тогда язык едет за ним на любое устройство).
app.post('/api/lang', async (req, res) => {
  const lang = normLang(req.body?.lang);
  if (!lang) return res.status(400).json({ error: 'unknown lang' });
  res.append('Set-Cookie', buildLangCookie(lang, { secure: cookieSecure() }));
  const pid = accountPidFromReq(req);
  if (pid) await db.setPlayerLang(pid, lang);
  res.json({ ok: true, lang });
});

// Выход: инвалидируем серверную сессию и стираем cookie.
app.post('/api/auth/logout', (req, res) => {
  const session = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (session) { sessions.delete(session); db.deleteSession(session); }
  res.append('Set-Cookie', buildClearCookie({ secure: cookieSecure() }));
  res.json({ ok: true });
});

app.post('/api/games', (req, res) => {
  const { token, nick, maxPlayers, turnTimer, mode, nicks, color, colors } = req.body || {};
  const accountPid = accountPidFromReq(req);                 // вошёл через Google? (по cookie)
  const pid = accountPid || (token ? pidOf(token) : null);   // иначе — гостевой токен (одиночка/хотсит)
  if (!pid) return res.status(400).json({ error: 'err.needToken' });
  // Потолок на одновременные партии — единственная защита от «накрутить тысячу игр скриптом».
  if (tooManyGames(pid))
    return res.status(429).json({ error: 'err.tooManyGames', params: { max: MAX_ACTIVE_GAMES } });
  const id = crypto.randomBytes(5).toString('base64url');

  // хотсит: все игроки вводятся сразу, лобби нет — игра стартует мгновенно
  if (mode === 'hotseat') {
    if (req.body.realtime)
      return res.status(400).json({ error: 'err.rtNoHotseat' });
    const names = (Array.isArray(nicks) ? nicks : []).map(s => String(s || '').trim()).filter(Boolean);
    if (names.length < 2 || names.length > 4) return res.status(400).json({ error: 'err.needNames' });
    const cols = Array.isArray(colors) ? colors : [];
    const game = createGame(id, { maxPlayers: names.length, turnTimer: 0 });
    game.config.hotseat = true;
    game.config.multiMove = req.body.multiMove !== false; // ход тремя судами (по умолчанию вкл)
    game.config.mode = pickMode(req.body.gameMode);        // режим (до addPlayer — влияет на старт. золото)
    game.hotseatOwner = pid;
    names.forEach((n, i) => {
      db.upsertPlayer(pid + '#' + i, n);
      addPlayer(game, pid + '#' + i, n, cols[i]);
    });
    startGame(game, pid + '#0');
    games.set(id, game);
    db.saveGame(game);
    return res.json({ gameId: id });
  }

  // против компьютера: человек + 1-3 бота, старт сразу
  if (mode === 'bot') {
    const level = ['easy', 'mid', 'hard'].includes(req.body.level) ? req.body.level : 'hard';
    const gmode = pickMode(req.body.gameMode);
    const duel = !!GAME_MODES[gmode]?.duel;
    const botCount = duel ? 1 : Math.min(3, Math.max(1, +req.body.bots || 1)); // дуэль — ровно 1 бот (1на1)
    const nm = cleanNick(nick);
    if (!nm) return res.status(400).json({ error: 'err.needNick' });
    // ⚡ «Полный вперёд» (реалтайм, бета) — тумблер, доступен в любом режиме
    if (req.body.realtime && !realtimeAllowed(gmode))
      return res.status(400).json({ error: 'err.rtNotInMode' });
    const game = createGame(id, { maxPlayers: 1 + botCount, turnTimer: 0 });
    game.config.botGame = true;
    game.hostPid = pid;   // создатель: по нему считается потолок своих партий (в онлайне то же поле)
    game.config.realtime = !!req.body.realtime;           // ⚡ реалтайм-партия (бета)
    game.config.fog = req.body.fog !== false; // туман войны (по умолчанию вкл), визуал для игрока
    // ход тремя судами (по умолчанию вкл); в реалтайме ходов нет — форсим выкл, что бы ни прислал клиент
    game.config.multiMove = !game.config.realtime && req.body.multiMove !== false;
    game.config.mode = gmode;                             // режим (до addPlayer — влияет на старт. золото)
    db.upsertPlayer(pid, nm);
    addPlayer(game, pid, nm, color);                      // цвет игрока — по выбору
    for (let i = 0; i < botCount; i++) {
      addPlayer(game, 'bot:' + id + ':' + i, BOT_NAMES[level][i], randomFreeColor(game)); // ботам — рандом из оставшихся
      const bp = game.players[game.players.length - 1];
      bp.isBot = true;
      bp.botLevel = level;
    }
    startGame(game, pid);
    maybeBotBuy(game);   // дуэль: бот сразу собирает свой флот (фаза закупки)
    games.set(id, game);
    db.saveGame(game);
    armRt(game);         // ⛈️ шторм: завести реалтайм-тик (для остальных режимов — no-op)
    return res.json({ gameId: id });
  }

  // Онлайн-баттл требует аккаунт (когда вход через Google настроен) — гостя не пускаем.
  if (googleClient && !accountPid)
    return res.status(401).json({ error: 'err.needGoogle', needAuth: true });
  // Одно открытое лобби на аккаунт. Молча вернуть в старое нельзя: человек жмёт «Создать» с
  // новыми настройками и не понимает, почему оказался в прежнем лобби со старыми. Поэтому
  // сообщаем клиенту, что лобби уже есть, и ждём решения — вернуться туда или пересоздать.
  const openLobby = [...games.values()].find(g =>
    g.status === 'lobby' && g.config?.listed && g.hostPid === pid && !lobbyExpired(g, Date.now()));
  if (openLobby) {
    if (!req.body.replace)
      return res.json({
        gameId: openLobby.id, existing: true,
        players: openLobby.players.length, max: openLobby.config.maxPlayers
      });
    closeLobby(openLobby);   // пересоздаём: старое закрываем, кто в нём сидел — на главную
  }
  const nm = cleanNick(nick);
  if (!nm) return res.status(400).json({ error: 'err.needNickToken' });
  const gmode = pickMode(req.body.gameMode);
  // ⚡ «Полный вперёд» (реалтайм, бета): онлайн МОЖНО в любом режиме, но вне рейтинга (isRanked учитывает)
  if (req.body.realtime && !realtimeAllowed(gmode))
    return res.status(400).json({ error: 'err.rtNotInMode' });
  const maxP = GAME_MODES[gmode]?.duel ? 2 : +maxPlayers; // дуэль — строго 1 на 1
  const game = createGame(id, { maxPlayers: maxP, turnTimer: +turnTimer });
  game.config.listed = true; // онлайн-игра попадает в браузер лобби (и засчитывается в лидерборд)
  game.config.realtime = !!req.body.realtime;           // ⚡ реалтайм-партия (бета, не в рейтинг)
  game.config.fog = req.body.fog !== false; // туман войны (по умолчанию вкл)
  // ход тремя судами (по умолчанию вкл); в реалтайме ходов нет — форсим выкл, что бы ни прислал клиент
  game.config.multiMove = !game.config.realtime && req.body.multiMove !== false;
  game.config.mode = gmode;                             // режим (до addPlayer — влияет на старт. золото)
  db.upsertPlayer(pid, nm);
  addPlayer(game, pid, nm, color);
  game.hostPid = pid;        // хост лобби = аккаунт создателя (по нему вернёмся как хост)
  games.set(id, game);
  db.saveGame(game);
  res.json({ gameId: id });
  broadcastLobbies();
});

app.get('/api/leaderboard', async (_req, res) => res.json(await db.getLeaderboard()));

app.get(`/${LANG_SEG}/game/:id`, (req, res) => renderPage('game.html', req, res, getGame(req.params.id)));
// ⚠ Голый /game/<id> РИСУЕМ, а не редиректим. Это адрес из приглашения, и по нему ходит бот
// мессенджера за карточкой превью — лишний 302 для него риск остаться без карточки. Человеку
// редирект тоже не нужен: язык он и так получит свой (профиль → кука → дефолт), а страница
// партии всё равно noindex, так что два адреса у неё поисковику не мешают — их разводит canonical.
app.get('/game/:id', (req, res) => renderPage('game.html', req, res, getGame(req.params.id)));

// --- WebSocket ---

io.on('connection', socket => {
  let joinedGameId = null;
  let myPid = null;
  // pid аккаунта по cookie-сессии (один раз на подключение) — для гейта онлайна
  socket.data.accountPid = accountPidFromSession(parseCookies(socket.handshake.headers.cookie)[SESSION_COOKIE]);

  // подписка на браузер лобби (с главной страницы)
  socket.on('lobbies:subscribe', (payload, ack) => {
    const cb = typeof payload === 'function' ? payload : ack;        // старый клиент слал только колбэк
    const token = (payload && typeof payload === 'object') ? payload.token : null;
    socket.data.browsePid = socket.data.accountPid || (token ? pidOf(token) : null);
    socket.join('lobbies');
    cb?.({ lobbies: lobbyListData(socket.data.browsePid), myGames: myGamesData(socket.data.browsePid) });
  });
  socket.on('lobbies:unsubscribe', () => socket.leave('lobbies'));

  socket.on('join', ({ gameId, token, nick, color }, ack) => {
    const game = getGame(gameId);
    if (!game) return ack?.({ ok: false, error: 'err.gameNotFound' });
    const accountPid = socket.data.accountPid;
    // Онлайн-участие (вход в лобби) требует аккаунт; смотреть уже идущую игру можно и гостю.
    if (game.config?.listed && googleClient && game.status === 'lobby' && !accountPid)
      return ack?.({ ok: false, error: 'err.needGoogle', needAuth: true });
    const pid = accountPid || (token ? pidOf(token) : null);
    const nm = cleanNick(nick);
    if (!pid || !nm) return ack?.({ ok: false, error: 'err.needNick' });
    // хотсит: владелец устройства управляет всеми игроками
    const isHotseatOwner = !!(game.config?.hotseat && game.hotseatOwner === pid);
    if (isHotseatOwner) {
      joinedGameId = gameId;
      myPid = pid;
      socket.data.pid = pid;
      socket.join('game:' + gameId);
      ack?.({ ok: true, playerId: pid, spectator: false, hotseatOwner: true });
      socket.emit('state', publicState(game, pid));
      return;
    }
    // реконнект: игрок УЖЕ в этой игре/лобби (вернулся — напр. свернул лобби и зашёл снова) → пере-подключаем сокет, роль (хост) сохраняется
    if (game.players.some(p => p.id === pid)) {
      joinedGameId = gameId; myPid = pid; socket.data.pid = pid;
      socket.join('game:' + gameId);
      ack?.({ ok: true, playerId: pid, spectator: false });
      socket.emit('state', publicState(game, pid));
      broadcastLobbies();
      return;
    }
    db.upsertPlayer(pid, nm);
    const result = addPlayer(game, pid, nm, color);
    // Не участник, но игра идёт — пускаем смотреть.
    const spectator = !result.ok && game.status !== 'lobby' && !game.players.some(p => p.id === pid);
    if (!result.ok && !spectator) return ack?.({ ok: false, error: result.error });
    joinedGameId = gameId;
    myPid = pid;
    socket.data.pid = pid;
    socket.join('game:' + gameId);
    db.saveGame(game);
    ack?.({ ok: true, playerId: pid, spectator });
    broadcastState(game);
    broadcastLobbies(); // обновить число игроков в витрине
  });

  socket.on('setColor', ({ color } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'err.noGame' });
    const result = setColor(game, myPid, color);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    db.saveGame(game);
    broadcastState(game);
    broadcastLobbies();
    ack?.({ ok: true });
  });

  // Сменить свой ник (в лобби или в игре): обновляем у игрока, ЖЁСТКО пишем в БД (аккаунт запомнит
  // ник — он же в лидерборде) и тут же рассылаем всем в комнате, чтобы соперники увидели в реальном времени.
  socket.on('setNick', ({ nick } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'err.noGame' });
    const nm = cleanNick(nick);
    if (!nm) return ack?.({ ok: false, error: 'err.nickEmpty' });
    const p = game.players.find(pl => pl.id === myPid);
    if (!p) return ack?.({ ok: false, error: 'err.notInGame' });
    p.nick = nm;                  // хотсит: переименовываем именно то место за столом, откуда позвали
    db.saveGame(game);
    broadcastState(game);
    renameEverywhere(myPid, nm);  // железно в БД + во всех остальных партиях и в витрине лобби
    broadcastLobbies();
    ack?.({ ok: true });
  });

  // добавить бота в онлайн-лобби (только создатель; ботов не больше половины мест)
  socket.on('addBot', ({ level } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'err.noGame' });
    if (game.status !== 'lobby') return ack?.({ ok: false, error: 'err.gameRunning' });
    if (isDuel(game)) return ack?.({ ok: false, error: 'err.duelNeedsHuman' });
    if (game.players[0]?.id !== myPid) return ack?.({ ok: false, error: 'err.hostAddsBots' });
    const lvl = ['easy', 'mid', 'hard'].includes(level) ? level : 'hard';
    const botCount = game.players.filter(p => p.isBot).length;
    const limit = Math.floor(game.config.maxPlayers / 2); // боты — максимум половина слотов
    if (botCount >= limit) return ack?.({ ok: false, error: 'err.botLimit', params: { max: limit } });
    if (game.players.length >= game.config.maxPlayers) return ack?.({ ok: false, error: 'err.slotsFull' });
    const botId = 'bot:' + game.id + ':' + botCount + ':' + crypto.randomBytes(2).toString('hex');
    const name = BOT_NAMES[lvl][botCount] || 'bot.extra';
    addPlayer(game, botId, name, randomFreeColor(game));
    const bp = game.players[game.players.length - 1];
    bp.isBot = true; bp.botLevel = lvl;
    db.saveGame(game);
    broadcastState(game);
    broadcastLobbies();
    ack?.({ ok: true });
  });

  // убрать бота из лобби (только создатель)
  socket.on('removeBot', ({ botId } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'err.noGame' });
    if (game.status !== 'lobby') return ack?.({ ok: false, error: 'err.gameRunning' });
    if (game.players[0]?.id !== myPid) return ack?.({ ok: false, error: 'err.hostOnly' });
    const idx = game.players.findIndex(p => p.id === botId && p.isBot);
    if (idx === -1) return ack?.({ ok: false, error: 'err.botNotFound' });
    game.players.splice(idx, 1);
    db.saveGame(game);
    broadcastState(game);
    broadcastLobbies();
    ack?.({ ok: true });
  });

  socket.on('start', (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'err.noGame' });
    // Онлайн-баттл стартует только при 2+ живых игроках-людях. Игра с ботами — это одиночный режим.
    if (game.players.filter(p => !p.isBot).length < 2)
      return ack?.({ ok: false, error: 'err.needTwoHumans' });
    const result = startGame(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    armTurnTimer(game); // ⚡ реалтайм: deadline=null → no-op
    armRt(game);        // ⚡ реалтайм: завести тик (для пошаговых — no-op)
    persistAndBroadcast(game);
    ack?.({ ok: true });
  });

  socket.on('action', (action, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'err.noGame' });
    const result = applyAction(game, myPid, action);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    if (game.status === 'finished') db.saveResults(game); // пишем все партии; в лидерборд попадут только рейтинговые
    else armTurnTimer(game);
    persistAndBroadcast(game);
    ack?.({ ok: true });
  });

  // Строка ввода: клиент шлёт введённый текст. Если это команда из секретного списка (cheats.js,
  // в клиент не попадает) — применяем её игроку. Любой другой текст рассылаем всем как сообщение
  // (эфемерный чат-нотиф, не в журнал). Так панель выглядит обычным чатом, а команды скрыты.
  socket.on('msg', ({ text } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game || game.status !== 'active') return ack?.({ ok: false });
    let pIdx = game.players.findIndex(p => p.id === myPid);
    if (pIdx === -1 && game.config.hotseat && myPid === game.hotseatOwner) pIdx = game.turn.idx;
    if (pIdx === -1) return ack?.({ ok: false });
    const r = applyCheat(game, pIdx, text);
    if (r) {                                             // распознанная команда — применяем (не чатим!)
      if (r.ok && r.broadcast) persistAndBroadcast(game);
      return ack?.(r);
    }
    const chat = String(text || '').trim().slice(0, 120); // прочий текст — сообщение всем в комнате
    if (chat) io.to('game:' + game.id).emit('chat', { author: game.players[pIdx]?.nick || 'Игрок', text: chat });
    ack?.({ ok: true });
  });

  // Сдаться (в игре) или выйти (из лобби).
  socket.on('leave', (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'err.noGame' });
    // хост вышел из ещё НЕ начатого лобби → закрываем лобби целиком (остальных выкидываем на главную)
    if (game.status === 'lobby' && game.hostPid === myPid) {
      closeLobby(game);
      return ack?.({ ok: true, lobbyClosed: true });
    }
    const result = leaveGame(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    maybeAutoFinish(game); // все люди сдались → доигрываем за ботов и завершаем сразу
    if (game.status === 'finished') db.saveResults(game); // пишем все партии; в лидерборд попадут только рейтинговые
    else armTurnTimer(game);
    persistAndBroadcast(game);
    ack?.({ ok: true });
  });

  // Завершить/убрать «мою» игру из списка: оффлайн (бот/хотсит) — просто удаляем; онлайн — только хост (доигрываем за всех).
  socket.on('game:finish', ({ gameId, token } = {}, ack) => {
    const game = getGame(gameId);
    if (!game) return ack?.({ ok: false, error: 'err.gameNotFound' });
    const pid = socket.data.accountPid || (token ? pidOf(token) : null);
    const participant = game.players.some(p => p.id === pid) || game.hostPid === pid || game.hotseatOwner === pid;
    if (!participant) return ack?.({ ok: false, error: 'err.notYourGame' });
    if (game.status === 'lobby') {                    // ещё НЕ начатое лобби: закрыть может только создатель → удаляем
      if (game.hostPid !== pid) return ack?.({ ok: false, error: 'err.hostClosesOnly' });
      closeLobby(game);
      return ack?.({ ok: true });
    }
    if (game.config?.listed) {                       // ОНЛАЙН: завершить может только хост
      if (game.hostPid !== pid) return ack?.({ ok: false, error: 'err.hostFinishesOnly' });
      if (game.status === 'active') forceFinish(game);
      if (game.status === 'finished') db.saveResults(game);
      io.to('game:' + game.id).emit('state', publicState(game)); // тем, кто открыт в игре — финал
      db.saveGame(game);
    } else {                                          // ОФФЛАЙН (бот/хотсит): это сольная игра — просто удаляем
      io.to('game:' + game.id).emit('lobbyClosed');   // если кто-то открыт в этой игре — на главную
      rtStop(game.id);                                // ⛈️ шторм: заглушить тик удалённой игры
      games.delete(game.id);
      db.deleteGame(game.id);
    }
    broadcastLobbies();
    ack?.({ ok: true });
  });

  // Поторопить AFK-игрока: письмо + 10 минут на ход.
  socket.on('nudge', async (ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'err.noGame' });
    const result = nudge(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    armTurnTimer(game);
    persistAndBroadcast(game);
    const target = game.players[result.targetIdx];
    const prof = await db.getPlayer(target.id);      // заодно узнаём язык адресата — письмо уйдёт на нём
    const email = prof?.email || null;
    const origin = process.env.BASE_URL
      || socket.handshake.headers.origin
      || `http://localhost:${PORT}`;
    // prof.mailNudge !== false — старые записи без колонки считаем согласием (так и было раньше)
    sendNudgeEmail(email, target.nick, `${origin}/game/${game.id}`, normLang(prof?.lang) || SOURCE_LANG,
      prof?.mailNudge !== false)
      .then(sent => ack?.({ ok: true, emailSent: sent }));
  });

  // отключение: лобби НЕ удаляем — оно продолжает ждать (хост мог «свернуть» и вернётся).
  // Заброшенные лобби чистит периодический сборщик по TTL (6 ч неполное / 24 ч полное укомплектованное).
  // 🐞 ИНСТРУМЕНТЫ ОТЛАДКИ (только при SB_DEBUG=1): перенос и лечение корабля, подсадка
  // пирата, деньги. Ровно те операции, которых не хватает, чтобы воспроизвести ситуацию из
  // живой партии, не переигрывая её заново. В проде ручка мертва — DEBUG выключен.
  socket.on('debug', (op = {}, ack) => {
    if (!DEBUG) return ack?.({ ok: false, error: 'err.debugOff' });
    const game = joinedGameId && getGame(joinedGameId);
    if (!game || game.status !== 'active') return ack?.({ ok: false, error: 'err.noActiveGame' });
    const ship = op.shipId ? game.ships.find(s => s.id === op.shipId) : null;
    switch (op.kind) {
      case 'move': {
        if (!ship) return ack?.({ ok: false, error: 'err.shipNotFound' });
        const m = game.map;
        ship.x = Math.min(m.w - 12, Math.max(12, Math.round(op.x)));
        ship.y = Math.min(m.h - 12, Math.max(12, Math.round(op.y)));
        break;
      }
      case 'heal': {
        if (!ship) return ack?.({ ok: false, error: 'err.shipNotFound' });
        const def = ship.owner === -1 ? PIRATE : SHIP_TYPES[ship.type];
        ship.hp = ship.maxHp || def.hp;
        break;
      }
      case 'ship': {                                  // любой корабль любому игроку
        if (!spawnShipAt(game, +op.owner, String(op.type), op.x, op.y))
          return ack?.({ ok: false, error: 'err.landOrBadArgs' });
        break;
      }
      case 'pirate': {
        if (!spawnPirateAt(game, op.x, op.y, !!op.boss)) return ack?.({ ok: false, error: 'err.land' });
        break;
      }
      case 'gold': {
        const pIdx = game.players.findIndex(p => p.id === myPid);
        if (pIdx < 0) return ack?.({ ok: false, error: 'err.notInGame' });
        game.players[pIdx].gold += Math.max(-9999, Math.min(9999, +op.amount || 0));
        break;
      }
      case 'coins': {                                 // 🪙 вторая валюта — выдать себе
        const pIdx = game.players.findIndex(p => p.id === myPid);
        if (pIdx < 0) return ack?.({ ok: false, error: 'err.notInGame' });
        const p = game.players[pIdx];
        p.coins = Math.max(0, (p.coins || 0) + Math.max(-9999, Math.min(9999, +op.amount || 0)));
        break;
      }
      case 'port': {                                  // прочность порта игрока (проверка осады)
        const p = game.players[op.playerIdx];
        if (!p) return ack?.({ ok: false, error: 'err.playerNotFound' });
        p.portHp = Math.max(1, Math.min(840, +op.hp || 1));
        break;
      }
      default: return ack?.({ ok: false, error: 'err.unknownOp' });
    }
    persistAndBroadcast(game);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {});
});

// Таймер хода: один на игру, перевзводится при каждой смене хода.
const timers = new Map();
function armTurnTimer(game) {
  clearTimeout(timers.get(game.id));
  if (game.status !== 'active' || !game.turn.deadline) return;
  const ms = Math.max(250, game.turn.deadline - Date.now());
  timers.set(game.id, setTimeout(() => {
    const g = getGame(game.id);
    if (g && timeoutTurn(g)) {
      armTurnTimer(g);
      persistAndBroadcast(g);
    }
  }, ms));
}

// Старт: подключаемся к MySQL, поднимаем все игры и сессии в память, возобновляем
// таймеры/ходы ботов, и только потом слушаем порт.
async function bootstrap() {
  try {
    await db.init();
    // поднимаем сессии в память, протухшие — выбрасываем (и чистим в БД)
    sessions.load(await db.getAllSessions(), token => db.deleteSession(token));
    let active = 0;
    for (const state of await db.getAllGames()) {
      games.set(state.id, state);
      if (state.status === 'active') {
        if (isRealtime(state)) armRt(state); // ⛈️ шторм: возобновить реалтайм-тик после рестарта
        else {
          armTurnTimer(state); // возобновляем таймер хода после рестарта/деплоя
          maybeBotTurn(state);  // ...и ход бота, если он не успел сходить
        }
        active++;
      }
    }
    console.log(`   поднято игр из базы: ${games.size} (активных: ${active}) — переживут деплой`);
  } catch (e) {
    console.error('❌ Не удалось инициализировать базу данных:', e.message);
    console.error('   Локально база (SQLite) создаётся сама. На проде проверь DATABASE_URL / DB_* (и DB_SSL при необходимости).');
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(`⚓ Sea Battle ${versionLabel()}: http://localhost:${PORT}`);
    // Молча проглотить SB_DEBUG на проде — худшее, что можно сделать: человек будет уверен,
    // что отладка работает. Поэтому говорим вслух, почему её нет.
    if (DEBUG_REQUESTED && !DEBUG)
      console.warn('⚠  SB_DEBUG=1 ПРОИГНОРИРОВАН: это боевой запуск (NODE_ENV=production или внешняя база).\n' +
                   '   Отладка раскрывает казну всех игроков, поэтому на проде она выключена намертво.');
    if (DEBUG) console.warn('🐞 Режим отладки ВКЛЮЧЁН: финансы всех игроков видны в стейте. Только для локальной разработки.');
  });
}

bootstrap();
