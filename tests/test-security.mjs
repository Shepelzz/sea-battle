// 🔒 Безопасность и поисковики: то, что ломается тихо и замечается поздно.
//
// Здесь нет игровой логики — только правила, которые легко снести случайной правкой:
// отладка не должна включаться на проде, потолок партий не должен исчезнуть, заголовки
// и robots/canonical не должны потеряться при рефакторинге.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { robotsTxt, sitemapXml, canonicalUrl, indexable, gameSchema } from '../server/og.js';
import { MAX_ACTIVE_GAMES, NUDGE_MAIL_COOLDOWN_MS, DEBUG, PRODUCTION } from '../server/config.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const eq = (n, g, w) => { JSON.stringify(g) === JSON.stringify(w) ? ok++ : (fail++, console.error('✗', n, 'получили', JSON.stringify(g), 'ждали', JSON.stringify(w))); };

const idx = readFileSync('server/index.js', 'utf8');

// === 1. Отладка не включается на проде ===
// Она раскрывает казну ВСЕХ игроков (publicState), поэтому одной забытой переменной
// окружения быть достаточно не должно.
const debugUnder = env => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    "const c = await import('./server/config.js'); console.log(JSON.stringify([c.PRODUCTION, c.DEBUG]));"],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  return JSON.parse((r.stdout || '[]').trim().split('\n').pop());
};
eq('локально SB_DEBUG=1 включает отладку', debugUnder({ SB_DEBUG: '1', NODE_ENV: '', DATABASE_URL: '' }), [false, true]);
eq('NODE_ENV=production глушит отладку', debugUnder({ SB_DEBUG: '1', NODE_ENV: 'production' }), [true, false]);
eq('внешняя база тоже глушит', debugUnder({ SB_DEBUG: '1', NODE_ENV: '', DATABASE_URL: 'mysql://x/y' }), [true, false]);
eq('без SB_DEBUG отладки нет', debugUnder({ SB_DEBUG: '', NODE_ENV: '', DATABASE_URL: '' }), [false, false]);
yes('в этом прогоне отладка выключена', DEBUG === false && PRODUCTION === false);
yes('про проигнорированный SB_DEBUG сервер говорит вслух', /ПРОИГНОРИРОВАН/.test(idx));

// === 2. Потолок одновременных партий ===
eq('своих партий — не больше 3', MAX_ACTIVE_GAMES, 3);
yes('лимит проверяется при СОЗДАНИИ партии', /tooManyGames\(pid\)[\s\S]{0,120}err\.tooManyGames/.test(idx));
yes('отказ отдаётся кодом 429', /status\(429\)[\s\S]{0,60}tooManyGames/.test(idx));
yes('доигранные партии в счёт не идут', /createdGamesOf[\s\S]{0,400}status === 'finished'\) continue/.test(idx));
// Считаем только СОЗДАННЫЕ: гостя в чужом лобби наказывать не за что, ресурсов оно ему не стоит.
yes('счёт идёт по создателю, а не по участию',
  /createdGamesOf[\s\S]{0,400}g\.hostPid === pid \|\| g\.hotseatOwner === pid/.test(idx) &&
  !/createdGamesOf[\s\S]{0,400}players\.some/.test(idx));
yes('вход в чужое лобби лимитом не режется', (idx.match(/err\.tooManyGames/g) || []).length === 1);
// у бот-партии создателя раньше не записывали — без этого потолок её не видел
yes('бот-партия помнит создателя', /botGame = true;[\s\S]{0,160}hostPid = pid/.test(idx));

// === 2а. Лаборатории на проде не отдаются ===
// Это инструменты разработки со своими встроенными скриптами (CSP на них намеренно не натянут).
{
  // index.js не импортируем: он поднимает сервер и лезет в базу. Проверяем исходник —
  // тут важно само наличие правила и его место в цепочке.
  yes('правило для лабораторий описано', /const LAB_PATH = /.test(idx));
  yes('на проде лаборатории отдают 404', /PRODUCTION && isLabPath\(req\.path\)[\s\S]{0,60}status\(404\)/.test(idx));
  yes('правило стоит ДО статики', idx.indexOf('LAB_PATH') < idx.indexOf('express.static(PUBLIC'));
  yes('robots тоже закрывает лаборатории', robotsTxt('https://sb.ua').includes('-lab.html'));
}

// === 3. Заголовки ===
yes('X-Powered-By отключён', /app\.disable\('x-powered-by'\)/.test(idx));
for (const h of ['X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options', 'Permissions-Policy'])
  yes(`заголовок ${h} ставится`, idx.includes(`'${h}'`));
{
  const csp = /const csp = \(nonce\) => \[([\s\S]*?)\]\.join/.exec(idx)?.[1] || '';
  yes('CSP: есть', !!csp);
  yes('CSP: скрипты без unsafe-inline', /script-src/.test(csp) && !/script-src[^"]*unsafe-inline/.test(csp));
  yes('CSP: нас нельзя вложить во фрейм', /frame-ancestors 'none'/.test(csp));
  yes('CSP: object-src запрещён', /object-src 'none'/.test(csp));
  yes('CSP: base-uri зафиксирован', /base-uri 'self'/.test(csp));
}
// Вшитый словарь — встроенный скрипт: без nonce его срежет собственный CSP, и страница онемеет.
yes('вшитый словарь получает nonce', /<script nonce="\$\{NONCE_MARK\}">window\.__SB_I18N/.test(idx));
yes('метка nonce подменяется на отправке', /replaceAll\(NONCE_MARK, nonce\)/.test(idx));

// === 4. Письма «поторопить» ===
yes('у писем есть пауза на получателя', NUDGE_MAIL_COOLDOWN_MS >= 10 * 60 * 1000);
yes('пауза реально проверяется перед отправкой', /if \(!mayMailNudge\(email\)\) return false/.test(idx));
// Согласие важнее паузы: молча писать тому, кто отказался, нельзя даже раз в полчаса.
yes('отказ от писем блокирует отправку', /if \(!allowed\) return false/.test(idx));
yes('согласие берётся из профиля получателя', /prof\?\.mailNudge !== false/.test(idx));
yes('согласием можно управлять', /app\.post\('\/api\/profile\/mail'/.test(idx));
yes('старые записи без колонки считаются согласием', /mailNudge !== false/.test(idx));

// === 5. Поисковики ===
{
  const r = robotsTxt('https://sb.ua');
  // ⚠ Партии в robots.txt НЕ закрыты намеренно: Disallow запрещает СКАЧИВАТЬ страницу, а по
  // ссылке-приглашению ходит краулер мессенджера за карточкой превью — и robots.txt он уважает.
  // Закрыв /game/, мы убили бы карточку приглашения. Из индекса партии убирает noindex.
  yes('партии в robots НЕ закрыты (иначе умрёт превью приглашения)', !/Disallow: \/(\*\/)?game\//.test(r));
  yes('robots закрывает API', /^Disallow: \/api\/$/m.test(r));
  yes('robots ведёт к карте сайта', r.includes('Sitemap: https://sb.ua/sitemap.xml'));

  const x = sitemapXml('https://sb.ua', new Date('2026-09-22'));
  yes('sitemap — валидный XML', x.startsWith('<?xml') && x.includes('</urlset>'));
  // В карте все три языковые версии: без этого поисковик о переводах просто не узнает.
  for (const l of ['uk', 'ru', 'en']) yes(`sitemap: есть ${l}`, x.includes(`<loc>https://sb.ua/${l}/</loc>`));
  yes('у каждой версии проставлены соседи (hreflang)', (x.match(/xhtml:link rel="alternate"/g) || []).length === 12);
  yes('есть x-default', x.includes('hreflang="x-default" href="https://sb.ua/uk/"'));
  yes('sitemap содержит дату', x.includes('<lastmod>2026-09-22</lastmod>'));
  yes('страниц партий в карте нет', !x.includes('/game/'));

  eq('canonical отбрасывает хвост запроса', canonicalUrl('https://sb.ua', '/?l=ru'), 'https://sb.ua/');
  eq('canonical для партии — её собственный адрес', canonicalUrl('https://sb.ua', '/game/aB3'), 'https://sb.ua/game/aB3');
  eq('главная индексируется', indexable(false), true);
  eq('страница партии — нет', indexable(true), false);

  const sc = gameSchema({ siteName: 'Морской бой', description: 'д', url: 'https://sb.ua/', image: 'https://sb.ua/og.png' });
  eq('разметка для поисковика — VideoGame', sc['@type'], 'VideoGame');
  yes('в ней есть имя, адрес и картинка', !!(sc.name && sc.url && sc.image));
}
// === 5а. Языки разъехались по адресам ===
{
  const { langFromPath, withLang, stripLang, langAlternates } = await import('../server/i18n.js');
  eq('язык читается из пути', langFromPath('/ru/game/x'), { lang: 'ru', rest: '/game/x' });
  eq('без префикса — null', langFromPath('/game/x'), { lang: null, rest: '/game/x' });
  eq('чужой код — не язык', langFromPath('/xx/game/x'), { lang: null, rest: '/xx/game/x' });
  eq('корень с языком', langFromPath('/uk'), { lang: 'uk', rest: '/' });
  eq('приклеивание', withLang('ru', '/game/x'), '/ru/game/x');
  eq('замена уже стоящего', withLang('en', '/ru/game/x'), '/en/game/x');
  eq('корень — со слэшем (одна форма для canonical)', withLang('uk', '/'), '/uk/');
  eq('снятие префикса', stripLang('/en/game/x'), '/game/x');
  eq('альтернатив ровно 4 (три языка + x-default)', langAlternates('/').length, 4);

  yes('адрес главнее профиля и куки', /langFromPath\(req\.path\)\.lang;\s*\n\s*if \(fromPath\) return fromPath/.test(idx));
  yes('голые адреса отдают 302, а не 404', /res\.redirect\(302, withLang/.test(idx));
  // Голый /game/<id> — это адрес ПРИГЛАШЕНИЯ, и он рисуется, а не редиректится:
  // лишний 302 для бота мессенджера — риск остаться без карточки превью.
  yes('приглашение рисуется без редиректа', /app\.get\('\/game\/:id', \(req, res\) => renderPage/.test(idx));
  yes('хвост запроса при редиректе не теряется', /req\.originalUrl\.slice\(req\.path\.length\)/.test(idx));
  yes('hreflang попадает в страницу', /rel="alternate" hreflang=/.test(idx));
  yes('на страницах партий hreflang не нужен', /if \(indexable\(!!game\)\)[\s\S]{0,200}else seo\.push\('  <meta name="robots"/.test(idx));

  // Приглашение — голый /game/<id>: ни префикса, ни параметров.
  // Язык страницы решает получатель, язык карточки берётся из профиля создателя партии.
  const gameJs = readFileSync('public/js/game.js', 'utf8');
  const share = /function shareUrl\(\) \{([\s\S]*?)\n\}/.exec(gameJs)?.[1] || '';
  yes('в приглашении нет языкового префикса', /stripLang/.test(share));
  yes('в приглашении нет хвоста запроса', /u\.search = ''/.test(share));
  yes('языкового параметра в коде не осталось', !/LANG_PARAM/.test(idx) && !/searchParams\.set\('l'/.test(gameJs));
  // Страница партии живёт по ГОЛОМУ адресу — и у создателя, и у гостя. Иначе игрок,
  // скопировав адрес из строки браузера, навязал бы получателю свой язык.
  const homeJs = readFileSync('public/js/home.js', 'utf8');
  yes('переходы в партию — без языкового префикса', !/SBI18n\.path\('\/game\//.test(homeJs));
  const i18nJs = readFileSync('public/js/i18n.js', 'utf8');
  yes('смена языка не приклеивает префикс голому адресу', /if \(LANG_RE\.test\(location\.pathname\)\)/.test(i18nJs));

  const { previewLang } = await import('../server/og.js');
  eq('язык превью — из пути, если ссылку скопировали из адресной строки', previewLang({ path: '/en/game/x' }), 'en');
  eq('иначе — язык создателя партии', previewLang({ path: '/game/x', hostLang: 'en' }), 'en');
  eq('мусор в пути игнорируем', previewLang({ path: '/zz/game/x', hostLang: 'ru' }), 'ru');
  eq('нет ничего — дефолт', previewLang({ path: '/game/x' }), 'uk');
}

yes('партии отдаются с X-Robots-Tag: noindex', /X-Robots-Tag', 'noindex'/.test(idx));
yes('мета-робот тоже ставится', /name="robots" content="noindex"/.test(idx));
// nofollow тут ничего не даёт, а лишний сигнал может отпугнуть краулер превью
yes('nofollow не ставим', !/noindex, nofollow/.test(idx));
yes('canonical попадает в страницу', /rel="canonical"/.test(idx));
yes('разметка для поисковика — только на главной', /if \(!game\) \{[\s\S]{0,400}application\/ld\+json/.test(idx));
yes('robots.txt и sitemap.xml отдаются', /app\.get\('\/robots\.txt'/.test(idx) && /app\.get\('\/sitemap\.xml'/.test(idx));

console.log(fail ? `\n❌ test-security: провалено ${fail}, прошло ${ok}` : `\n✅ test-security: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
