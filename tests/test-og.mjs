// 🔗 ПРЕВЬЮ ССЫЛКИ (Open Graph): что мессенджер покажет вместо голого URL.
//
// Тест стережёт три вещи, на которых эта фича ломается:
//   • в превью попало ИЗМЕНЧИВОЕ (счёт, очередь хода, число зашедших) — мессенджер кэширует
//     карточку намертво, и в чате навсегда повиснет устаревшее «2 из 4»;
//   • в превью попал НИК — карточку видит любой, кому попала ссылка, включая ботов-пересыльщиков;
//   • ключ описания есть не во всех словарях — игрок увидит голый `og.players`.
import { readFileSync } from 'node:fs';
import { ogHead, gameFacts, previewLang, absUrl, canonicalPath, OG_IMAGE, LANG_PARAM } from '../server/og.js';
import { DEFAULT_LANG, LANGS } from '../server/i18n.js';
import { createGame, addPlayer, startGame } from '../server/game.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const eq = (n, g, w) => { g === w ? ok++ : (fail++, console.error('✗', n, '— получили', JSON.stringify(g), 'ждали', JSON.stringify(w))); };

const dicts = Object.fromEntries(LANGS.map(l => [l, JSON.parse(readFileSync(`public/locales/${l}.json`, 'utf8'))]));
const pick = (o, key) => key.split('.').reduce((x, k) => x?.[k], o);
const T = (lang, k, p = {}) => String(pick(dicts[lang], k) ?? k).replace(/{{\s*(\w+)\s*}}/g, (_, x) => p[x] ?? '');

// ═══ выбор языка превью ═══
eq('ссылка важнее всего', previewLang({ param: 'en', hostLang: 'ru' }), 'en');
eq('локаль из ссылки нормализуется', previewLang({ param: 'uk-UA' }), 'uk');
eq('мусор в ссылке игнорируем', previewLang({ param: 'zz', hostLang: 'ru' }), 'ru');
eq('нет параметра → язык создателя', previewLang({ hostLang: 'en' }), 'en');
eq('нет ничего → дефолт', previewLang({}), DEFAULT_LANG);
eq('совсем без аргументов → дефолт', previewLang(), DEFAULT_LANG);

// ═══ приметы партии ═══
const g4 = () => ({ config: { mode: 'classic', maxPlayers: 4, turnTimer: 120, fog: true } });
{
  const keys = gameFacts(g4()).map(f => f.k);
  yes('режим в описании', keys.includes('mode.classic.name'));
  yes('число мест в описании', keys.includes('og.players'));
  yes('таймер в описании', keys.includes('tag.timer'));
  yes('туман в описании', keys.includes('og.fog'));
}
{
  const keys = gameFacts({ config: { mode: 'duel', maxPlayers: 2 } }).map(f => f.k);
  yes('дуэль: «1 на 1» вместо числа мест', keys.includes('og.duel') && !keys.includes('og.players'));
  yes('дуэль: про туман молчим (неприменим)', !keys.includes('og.fog') && !keys.includes('tag.noFog'));
}
{
  const keys = gameFacts({ config: { mode: 'classic', maxPlayers: 3, fog: false, realtime: true } }).map(f => f.k);
  yes('выключенный туман помечаем', keys.includes('tag.noFog'));
  yes('реалтайм помечаем', keys.includes('tag.realtime'));
}
eq('без конфига не падаем', gameFacts({}).length > 0, true);
eq('неизвестный режим → классика', gameFacts({ config: { mode: 'нетакого' } })[0].k, 'mode.classic.name');

// ═══ ГЛАВНОЕ: описание НЕ зависит от того, что меняется по ходу партии ═══
{
  const game = createGame('ogtest', { maxPlayers: 4, turnTimer: 60, seed: 7 });
  game.config.mode = 'classic'; game.config.fog = true;
  addPlayer(game, 'p0', 'Вася'); addPlayer(game, 'p1', 'Петя');
  const before = JSON.stringify(gameFacts(game));
  addPlayer(game, 'p2', 'Коля'); addPlayer(game, 'p3', 'Юра');   // лобби заполнилось
  startGame(game, 'p0');                                          // партия пошла
  game.turn.number = 40; game.turn.idx = 2;                       // ходы утекли
  game.players[1].alive = false; game.players[1].portHp = 0;      // кого-то выбили
  game.players[0].gold = 4200;
  const after = JSON.stringify(gameFacts(game));
  eq('приметы не поменялись за всю партию', after, before);
  game.status = 'finished'; game.winner = 0;
  eq('и после финала тоже', JSON.stringify(gameFacts(game)), before);
}

// ═══ ключи описания обязаны быть во ВСЕХ словарях ═══
{
  const variants = [
    { config: { mode: 'classic', maxPlayers: 4, turnTimer: 300, fog: true } },
    { config: { mode: 'deathmatch', maxPlayers: 2, fog: false } },
    { config: { mode: 'develop', maxPlayers: 3, realtime: true, fog: true } },
    { config: { mode: 'duel', maxPlayers: 2, turnTimer: 60 } }
  ];
  const keys = new Set(['og.site', 'og.homeTitle', 'og.homeDesc', 'og.gameTitle', 'og.imageAlt']);
  for (const v of variants) for (const f of gameFacts(v)) keys.add(f.k);
  for (const lang of LANGS) for (const k of keys)
    yes(`${lang}: есть ключ ${k}`, typeof pick(dicts[lang], k) === 'string');
}
// плейсхолдер {{n}} должен быть во всех переводах, иначе число просто исчезнет
for (const lang of LANGS) yes(`${lang}: og.players держит {{n}}`, /{{\s*n\s*}}/.test(pick(dicts[lang], 'og.players')));

// ═══ сборка тегов ═══
{
  const facts = gameFacts(g4()).map(f => T('uk', f.k, f.p));
  const head = ogHead({
    lang: 'uk', siteName: T('uk', 'og.site'), title: T('uk', 'og.gameTitle'),
    description: facts.join(' · '), url: 'https://sb.ua/game/aB3', image: 'https://sb.ua' + OG_IMAGE,
    imageAlt: T('uk', 'og.imageAlt')
  });
  for (const p of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:locale'])
    yes(`есть ${p}`, head.includes(`property="${p}"`));
  yes('картинке проставлены размеры', head.includes('og:image:width') && head.includes('1200') && head.includes('630'));
  yes('карточка крупная (twitter)', head.includes('summary_large_image'));
  yes('локаль по языку', head.includes('content="uk_UA"'));
  yes('описание собралось из примет', head.includes(T('uk', 'og.fog')));
  yes('каждый тег на своей строке', head.trim().split('\n').every(l => /^\s*<meta /.test(l)));
}
{ // без картинки — не выдумываем размеры и не обещаем большую карточку
  const head = ogHead({ lang: 'en', siteName: 'S', title: 'T', description: 'D', url: 'u' });
  yes('нет картинки → нет og:image', !head.includes('og:image'));
  yes('нет картинки → мелкая карточка', head.includes('content="summary"'));
}
{ // экранирование: кавычка в тексте не должна рвать атрибут
  const head = ogHead({ lang: 'ru', siteName: 'a"b', title: '<i>x</i>', description: "don't & do", url: 'u' });
  yes('кавычка экранирована', head.includes('a&quot;b'));
  yes('теги экранированы', head.includes('&lt;i&gt;'));
  yes('амперсанд экранирован', head.includes('&amp;'));
  yes('апостроф экранирован', head.includes('&#39;'));
}

// ═══ НИКИ В ПРЕВЬЮ НЕ ХОДЯТ ═══
{
  const game = createGame('ogtest2', { maxPlayers: 2, turnTimer: 0, seed: 7 });
  game.config.mode = 'classic'; game.config.fog = true;
  addPlayer(game, 'p0', 'СекретныйНик'); addPlayer(game, 'p1', 'ДругойНик');
  const text = gameFacts(game).map(f => T('ru', f.k, f.p)).join(' · ') + JSON.stringify(gameFacts(game));
  yes('ника создателя в описании нет', !text.includes('СекретныйНик'));
  yes('ника соперника в описании нет', !text.includes('ДругойНик'));
}

// ═══ канонический адрес (og:url) ═══
// Язык обязан оставаться в og:url: иначе мессенджер, считающий его каноническим, склеит
// кэш превью для всех языков одной ссылки — и язык отправителя перестанет работать.
eq('язык остаётся в каноне', canonicalPath('/game/aB3?l=en', 'en'), '/game/aB3?l=en');
eq('локаль нормализуется', canonicalPath('/game/aB3?l=uk-UA', 'uk-UA'), '/game/aB3?l=uk');
eq('без языка — чистый путь', canonicalPath('/game/aB3'), '/game/aB3');
eq('мусорный язык не попадает в канон', canonicalPath('/game/aB3?l=zz', 'zz'), '/game/aB3');
eq('прочие параметры отбрасываем', canonicalPath('/game/aB3?utm=vk&l=ru', 'ru'), '/game/aB3?l=ru');
eq('якорь отбрасываем', canonicalPath('/game/aB3#x', null), '/game/aB3');
eq('главная без хвостов', canonicalPath('/'), '/');
{
  const ru = canonicalPath('/game/aB3?l=ru', 'ru'), en = canonicalPath('/game/aB3?l=en', 'en');
  yes('разные языки → разные канонические адреса', ru !== en);
}

// ═══ абсолютные адреса ═══
eq('слэши не удваиваются', absUrl('https://sb.ua/', '/og-card.png'), 'https://sb.ua/og-card.png');
eq('путь без слэша тоже работает', absUrl('https://sb.ua', 'og-card.png'), 'https://sb.ua/og-card.png');
eq('параметр языка зовётся l', LANG_PARAM, 'l');
yes('карточка лежит в public', !!readFileSync('public' + OG_IMAGE).length);

console.log(fail ? `\n❌ test-og: провалено ${fail}, прошло ${ok}` : `\n✅ test-og: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
