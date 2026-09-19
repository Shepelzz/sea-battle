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
  timeoutTurn, publicState, setColor, randomFreeColor, forceFinish, isRanked, lobbyExpired, gameStale, myGameSummary, lobbyTags, PALETTE, spawnPirateAt, spawnShipAt
} from './game.js';
import {
  SESSION_COOKIE, pidOf, googlePid, cleanNick, resolveAccountNick, parseCookies,
  buildSetCookie, buildClearCookie, createSessionStore, newSessionToken
} from './auth.js';
import { chooseBotAction, BOT_NAMES, duelFleetPlan } from './bot.js';
import { LANGS, LANG_COOKIE, SOURCE_LANG, DEFAULT_LANG, normLang, pickLang, buildLangCookie } from './i18n.js';
import { applyCheat } from './cheats.js';
import { ogHead, gameFacts, previewLang, absUrl, canonicalPath, OG_IMAGE, LANG_PARAM } from './og.js';
import { VERSION, versionLabel } from './version.js';
import { rtStart, rtStop } from './rt.js';
import { CHEATS_ENABLED, DEBUG, GAME_MODES, enabledModes, DEFAULT_MODE, isDuel, isRealtime, realtimeAllowed, SHIP_TYPES, PIRATE } from './config.js';
// валидируем игровой режим из запроса (classic/deathmatch/develop) — только из включённых
const pickMode = m => enabledModes().includes(m) ? m : DEFAULT_MODE;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1); // за прокси (Render): корректный протокол — нужно для Secure-cookie
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
    .replace('</head>', `  <script>window.__SB_I18N=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>\n</head>`);

  pageCache.set(key, { stamp, html });
  return html;
}

// Язык этого запроса: профиль аккаунта > кука > дефолт (см. pickLang в i18n.js).
async function reqLang(req) {
  const pid = accountPidFromReq(req);
  const profile = pid ? (await db.getPlayer(pid))?.lang : null;
  return pickLang({ profile, cookie: parseCookies(req.headers.cookie)[LANG_COOKIE] });
}

// --- ПРЕВЬЮ ССЫЛКИ (Open Graph): что мессенджер покажет вместо голого URL ---
// Правила и формат — в og.js. Тут только «достать данные и подставить текст».
const CHARSET_META = '<meta charset="UTF-8">';   // якорь вставки: теги идут сразу за кодировкой
const reqOrigin = req => process.env.BASE_URL
  || `${req.get('x-forwarded-proto') || req.protocol}://${req.get('host')}`;

async function ogBlock(req, game) {
  // язык превью — из ссылки (?l=, его туда кладёт «скопировать» у отправителя),
  // иначе язык создателя партии, иначе дефолт. На саму страницу это не влияет.
  const hostLang = game?.hostPid ? (await db.getPlayer(game.hostPid))?.lang : null;
  const lang = previewLang({ param: req.query?.[LANG_PARAM], hostLang });
  const T = (k, p) => mailT(lang, k, p);                  // тот же резолвер, что у писем
  const origin = reqOrigin(req);
  // og:url = ровно тот адрес, по которому пришли (вместе с ?l=) — см. canonicalPath в og.js
  const url = absUrl(origin, canonicalPath(req.originalUrl, req.query?.[LANG_PARAM]));
  const base = {
    lang, url,
    siteName: await T('og.site'),
    image: absUrl(origin, OG_IMAGE),
    imageAlt: await T('og.imageAlt')
  };
  if (!game) return ogHead({ ...base, title: await T('og.homeTitle'), description: await T('og.homeDesc') });
  // описание — только НЕИЗМЕНЯЕМЫЕ приметы партии (см. предупреждение в og.js)
  const facts = [];
  for (const f of gameFacts(game)) facts.push(await T(f.k, f.p));
  return ogHead({ ...base, title: await T('og.gameTitle'), description: facts.join(' · ') });
}

async function renderPage(file, req, res, game = null) {
  try {
    let html = await buildPage(file, await reqLang(req));
    // Вставляем В НАЧАЛО <head>, а не перед </head>: там уже лежит вшитый словарь на десятки
    // килобайт, а краулеры читают только начало страницы — за ним теги можно и не найти.
    // Но ПОСЛЕ <meta charset>: объявление кодировки обязано идти первым, иначе кириллица в
    // самих тегах рискует быть разобранной не в той кодировке.
    // Готовая страница в памяти при этом не меняется: правим копию перед самой отправкой.
    const og = await ogBlock(req, game).catch(e => (console.error('og:', e.message), ''));
    if (og) html = html.includes(CHARSET_META)
      ? html.replace(CHARSET_META, CHARSET_META + '\n' + og.replace(/\n$/, ''))
      : html.replace('<head>', '<head>\n' + og);
    res.type('html').set('Cache-Control', 'no-cache').send(html);
  } catch (e) {
    console.error('page:', e.message);
    res.sendFile(path.join(PUBLIC, file));   // сломался рендер — отдаём как есть, на языке разметки
  }
}
app.get(['/', '/index.html'], (req, res) => renderPage('index.html', req, res));
app.get('/game.html', (req, res) => renderPage('game.html', req, res));

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

async function sendNudgeEmail(email, nick, gameUrl, lang = SOURCE_LANG) {
  if (!mailer || !email) return false;
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
    if (p.isBot && !p.ready) applyAction(game, p.id, { type: 'buyFleet', ships: duelFleetPlan(game, i, p.botLevel || 'mid') });
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
    if (g.status === 'finished' && isRanked(g)) db.saveResults(g); // в лидерборд — только онлайн
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
    try { action = chooseBotAction(game, game.turn.idx, cur.botLevel || 'mid'); }
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
  res.json({ loggedIn: true, nick: prof?.nick || '', email: prof?.email || '', avatar: prof?.avatar || '', lang: normLang(prof?.lang) });
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
    const level = ['easy', 'mid', 'hard'].includes(req.body.level) ? req.body.level : 'mid';
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
  // одно открытое лобби на аккаунт: уже есть незавершённое — возвращаем в него, второе не плодим
  for (const g of games.values())
    if (g.status === 'lobby' && g.config?.listed && g.hostPid === pid && !lobbyExpired(g, Date.now()))
      return res.json({ gameId: g.id, existing: true });
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
    p.nick = nm;
    db.upsertPlayer(myPid, nm);   // железно в БД — ник аккаунта меняется везде (вкл. лидерборд)
    db.saveGame(game);
    broadcastState(game);
    broadcastLobbies();           // в витрине лобби имя хоста могло измениться
    ack?.({ ok: true });
  });

  // добавить бота в онлайн-лобби (только создатель; ботов не больше половины мест)
  socket.on('addBot', ({ level } = {}, ack) => {
    const game = joinedGameId && getGame(joinedGameId);
    if (!game) return ack?.({ ok: false, error: 'err.noGame' });
    if (game.status !== 'lobby') return ack?.({ ok: false, error: 'err.gameRunning' });
    if (isDuel(game)) return ack?.({ ok: false, error: 'err.duelNeedsHuman' });
    if (game.players[0]?.id !== myPid) return ack?.({ ok: false, error: 'err.hostAddsBots' });
    const lvl = ['easy', 'mid', 'hard'].includes(level) ? level : 'mid';
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
    if (game.status === 'finished' && isRanked(game)) db.saveResults(game); // в лидерборд — только онлайн
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
      io.to('game:' + game.id).emit('lobbyClosed');
      games.delete(game.id);
      broadcastLobbies();
      return ack?.({ ok: true, lobbyClosed: true });
    }
    const result = leaveGame(game, myPid);
    if (!result.ok) return ack?.({ ok: false, error: result.error });
    maybeAutoFinish(game); // все люди сдались → доигрываем за ботов и завершаем сразу
    if (game.status === 'finished' && isRanked(game)) db.saveResults(game); // в лидерборд — только онлайн
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
      io.to('game:' + game.id).emit('lobbyClosed');   // кто в нём открыт — на главную
      games.delete(game.id); db.deleteGame(game.id);
      broadcastLobbies();
      return ack?.({ ok: true });
    }
    if (game.config?.listed) {                       // ОНЛАЙН: завершить может только хост
      if (game.hostPid !== pid) return ack?.({ ok: false, error: 'err.hostFinishesOnly' });
      if (game.status === 'active') forceFinish(game);
      if (game.status === 'finished' && isRanked(game)) db.saveResults(game);
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
    sendNudgeEmail(email, target.nick, `${origin}/game/${game.id}`, normLang(prof?.lang) || SOURCE_LANG)
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
  });
}

bootstrap();
