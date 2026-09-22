// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ПРЕВЬЮ ССЫЛКИ (Open Graph) — то, что рисует мессенджер вместо голого URL   ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Чистая логика: ни сети, ни БД, ни файлов — чтобы проверялась тестом напрямую.
// Текст подставляет вызывающий (index.js читает словарь), сюда приходят уже готовые строки.
//
// ⚠ ГЛАВНОЕ ПРАВИЛО: в превью идёт ТОЛЬКО то, что для этой ссылки не меняется никогда.
// Мессенджеры (Телеграм, WhatsApp, Viber, Slack, Discord) ходят за карточкой ОДИН раз и
// запоминают её надолго. Написать «2 из 4 капитанов» — значит навсегда заморозить в чате
// число, которое устареет через минуту. Поэтому берём режим, число мест, таймер, туман —
// то, что задано при создании партии и больше не меняется. Ни счёта, ни очереди хода,
// ни победителя здесь быть не должно.
//
// ⚠ И НИКАКИХ НИКОВ: превью видит любой, кому попала ссылка, — включая ботов-пересыльщиков
// и превью-прокси мессенджера. Кто именно играет, их не касается.
import { GAME_MODES, DEFAULT_MODE, isDuel } from './config.js';
import { normLang, DEFAULT_LANG, langFromPath, langAlternates } from './i18n.js';

export const OG_IMAGE = '/og-card.png';   // карточка 1200×630 (public/)

// Адрес карточки с меткой версии. Мессенджер кэширует картинку ПО АДРЕСУ: пока адрес прежний,
// он покажет старую карточку даже после того, как перечитает страницу. Метка меняется вместе с
// файлом — значит новая картинка доезжает сама. Чистую логику файлами не пачкаем: версию
// вычисляет index.js и передаёт сюда готовой.
export const ogImage = (version) => version ? `${OG_IMAGE}?v=${version}` : OG_IMAGE;

// ЯЗЫК ПРЕВЬЮ. Сервер не знает, кто отправил ссылку: за карточкой приходит бот мессенджера,
// анонимно и без кук. Но знать и не надо: приглашение шлёт создатель партии, а его язык
// лежит в профиле (hostLang). Раньше тут был ещё параметр ?l= — он дублировал то же самое
// и только мусорил в ссылке, поэтому убран.
// Язык из ПУТИ учитываем на случай, если ссылку скопировали прямо из адресной строки
// (/ru/game/xxx): тогда он и есть язык того, кто копировал.
// ⚠ На саму страницу это не влияет: живой человек всегда получает её по обычному правилу
// (профиль → кука → дефолт). Параметр читает только сборка превью.
export function previewLang({ path, hostLang } = {}) {
  return langFromPath(path).lang || normLang(hostLang) || DEFAULT_LANG;
}

// Неизменяемые приметы партии → ключи словаря (текст подставит вызывающий).
export function gameFacts(game) {
  const c = game?.config || {};
  const mode = GAME_MODES[c.mode] ? c.mode : DEFAULT_MODE;
  const facts = [{ k: `mode.${mode}.name` }];
  facts.push(isDuel(game) ? { k: 'og.duel' } : { k: 'og.players', p: { n: c.maxPlayers || 2 } });
  if (c.realtime) facts.push({ k: 'tag.realtime' });
  if (!isDuel(game)) facts.push(c.fog === false ? { k: 'tag.noFog' } : { k: 'og.fog' });
  if (c.turnTimer) facts.push({ k: 'tag.timer', p: { min: c.turnTimer / 60 } });
  return facts;
}

// Абсолютный адрес: og:url и og:image мессенджер тянет со своей стороны — относительный не поймёт.
export const absUrl = (origin, path) =>
  String(origin || '').replace(/\/+$/, '') + (String(path).startsWith('/') ? path : '/' + path);

// Адрес страницы для og:url — голый путь, без хвостов запроса и якоря: мусор в конце ссылки
// не должен плодить разные карточки превью.
export const canonicalPath = pathname => String(pathname || '/').split('?')[0].split('#')[0];

// В атрибут content кладём чужой текст (словари, адрес) — экранируем, иначе кавычка порвёт тег.
const esc = s => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const OG_LOCALE = { uk: 'uk_UA', ru: 'ru_RU', en: 'en_US' };

/** Блок мета-тегов для вставки перед </head>. Все строки — уже переведённые. */
// ─── Поисковики ───────────────────────────────────────────────────────────────
// canonical: у страницы один «настоящий» адрес. og:url для поиска не считается — это разные вещи.
// ⚠ Язык в canonical НЕ включаем: сейчас все три языка живут на одном адресе и выбираются кукой,
// поэтому canonical у них общий. Когда языки разъедутся по /ru/ и /en/, здесь появится hreflang.
export const canonicalUrl = (origin, pathname) => absUrl(origin, String(pathname || '/').split('?')[0]);

// hreflang: «эта же страница на других языках». Без него поисковик считает переводы
// дублями и показывает один. x-default — куда вести того, чей язык мы не знаем.
export const hreflangLinks = (origin, pathname) =>
  langAlternates(pathname).map(a => ({ hreflang: a.hreflang, href: absUrl(origin, a.path) }));

// Страницу партии индексировать НЕЛЬЗЯ: она живёт часы, её адрес — случайный ключ, и тысячи
// таких страниц только размоют сайт в выдаче. Главная — наоборот, единственное, что нужно в индексе.
export const indexable = (isGamePage) => !isGamePage;

// Разметка для поисковика (schema.org). Отдаём объектом: тег и экранирование — дело вызывающего.
export function gameSchema({ siteName, description, url, image }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'VideoGame',
    name: siteName,
    description,
    url,
    image,
    applicationCategory: 'GameApplication',
    genre: ['Strategy', 'Naval', 'Turn-based'],
    gamePlatform: 'Web browser',
    playMode: ['SinglePlayer', 'MultiPlayer'],
    inLanguage: ['uk', 'ru', 'en'],
    operatingSystem: 'Any',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }
  };
}

// robots.txt. Партии закрыты, остальное открыто, снизу — ссылка на карту сайта.
export const robotsTxt = (origin) => [
  'User-agent: *',
  // ⚠ Страницы партий тут НЕ закрываем, хотя индексировать их не надо. Disallow запрещает
  // СКАЧИВАТЬ страницу, а по ссылке на партию ходит не только поисковик: превью в мессенджерах
  // строят краулеры, которые robots.txt уважают (Телеграм — в их числе). Закрыв /game/, мы
  // убили бы карточку приглашения — главный способ, которым игру вообще зовут играть.
  // Из индекса партии убирает noindex (мета + X-Robots-Tag): он запрещает ИНДЕКСИРОВАТЬ,
  // но не мешает скачать. Disallow + noindex вместе вообще бессмысленны: не скачав страницу,
  // краулер не увидит и noindex.
  'Disallow: /api/',
  'Disallow: /*-lab.html$',   // лаборатории: на проде их и так нет, но пусть не ищут
  'Allow: /',
  '',
  `Sitemap: ${absUrl(origin, '/sitemap.xml')}`,
  ''
].join('\n');

// sitemap.xml. Страница у нас ровно одна — главная, но у неё три языковые версии, и каждая
// должна попасть в карту со ссылками на соседей (иначе поисковик считает их дублями).
// Партии сюда не идут: они эфемерны и закрыты noindex.
export const sitemapXml = (origin, lastmod = new Date()) => {
  const alts = langAlternates('/');
  const day = new Date(lastmod).toISOString().slice(0, 10);
  const entry = a => [
    '  <url>',
    `    <loc>${esc(absUrl(origin, a.path))}</loc>`,
    ...alts.map(x => `    <xhtml:link rel="alternate" hreflang="${x.hreflang}" href="${esc(absUrl(origin, x.path))}"/>`),
    `    <lastmod>${day}</lastmod>`,
    '    <changefreq>weekly</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>'
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...alts.filter(a => a.hreflang !== 'x-default').flatMap(entry),
    '</urlset>',
    ''
  ].join('\n');
};

export function ogHead({ lang, siteName, title, description, url, image, imageAlt }) {
  const meta = [
    ['og:type', 'website'],
    ['og:site_name', siteName],
    ['og:title', title],
    ['og:description', description],
    ['og:url', url],
    ['og:image', image],
    ['og:image:width', image ? '1200' : ''],
    ['og:image:height', image ? '630' : ''],
    ['og:image:alt', image ? imageAlt : ''],
    ['og:locale', OG_LOCALE[lang] || OG_LOCALE[DEFAULT_LANG]]
  ].filter(([, v]) => v);
  const lines = meta.map(([p, v]) => `  <meta property="${p}" content="${esc(v)}">`);
  // Twitter/X читает свои теги, остальное добирает из og:*
  lines.push(`  <meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`);
  lines.push(`  <meta name="description" content="${esc(description)}">`);
  return lines.join('\n') + '\n';
}
