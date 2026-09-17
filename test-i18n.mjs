// ЛОКАЛИЗАЦИЯ: выбор языка (чистая логика из server/i18n.js) + целостность словарей.
//
// Главное, ради чего тест существует: словари гниют молча. Добавил ключ в ru.json, забыл
// в uk.json — игрок увидит русскую фразу посреди украинского интерфейса, и никто не заметит
// месяцами. Поэтому здесь сверяются НАБОРЫ ключей, плейсхолдеры и то, что каждый ключ,
// упомянутый в разметке или в t(), вообще существует.
import fs from 'node:fs';
import {
  LANGS, SOURCE_LANG, DEFAULT_LANG, LANG_COOKIE, isLang, normLang,
  pickLang, buildLangCookie
} from './server/i18n.js';

let ok = 0, fail = 0;
const eq = (n, got, want) => {
  const pass = JSON.stringify(got) === JSON.stringify(want);
  pass ? (ok++) : (fail++, console.error(`✗ ${n}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`));
};
const yes = (n, cond) => eq(n, !!cond, true);

// === 1. Нормализация кода языка ===
eq('нормализация: región-тег', normLang('uk-UA'), 'uk');
eq('нормализация: подчёркивание и регистр', normLang('RU_ru'), 'ru');
eq('нормализация: пробелы', normLang('  en  '), 'en');
eq('нормализация: чужой язык', normLang('de'), null);
eq('нормализация: мусор', normLang('<script>'), null);
eq('нормализация: пусто', normLang(undefined), null);
eq('isLang', [isLang('uk'), isLang('pl')], [true, false]);
eq('эталон входит в список', LANGS.includes(SOURCE_LANG), true);
eq('дефолт входит в список', LANGS.includes(DEFAULT_LANG), true);
eq('по умолчанию — украинский', DEFAULT_LANG, 'uk');
eq('эталон (и фолбэк) — русский', SOURCE_LANG, 'ru');

// === 2. Приоритет: профиль > кука > дефолт ===
// ГЛАВНОЕ: не выбирал язык — получи дефолтный. Именно так ведёт себя инкогнито без куки,
// и никакой Accept-Language на это не влияет (он тут не участвует вовсе — см. pickLang).
eq('чистый заход (инкогнито, без куки и профиля) — дефолт', pickLang({}), DEFAULT_LANG);
eq('чистый заход: язык браузера не в счёт', pickLang({ header: 'ru-RU,ru;q=0.9' }), DEFAULT_LANG);
eq('только кука', pickLang({ cookie: 'en' }), 'en');
eq('профиль главнее куки', pickLang({ profile: 'uk', cookie: 'en' }), 'uk');
eq('битый профиль не ломает выбор', pickLang({ profile: 'de', cookie: 'en' }), 'en');
eq('битая кука → дефолт', pickLang({ cookie: 'zz' }), DEFAULT_LANG);

// === 4. Кука языка ===
const c = buildLangCookie('uk');
yes('кука: значение', c.startsWith(`${LANG_COOKIE}=uk`));
yes('кука: путь и SameSite', c.includes('Path=/') && c.includes('SameSite=Lax'));
yes('кука: живёт год', /Max-Age=31536000/.test(c));
yes('кука НЕ httpOnly (клиент её читает)', !/httponly/i.test(c));
yes('кука: Secure только по просьбе', !/Secure/.test(c) && /Secure/.test(buildLangCookie('uk', { secure: true })));

// === 5. Словари: одинаковый набор ключей ===
const read = code => JSON.parse(fs.readFileSync(`public/locales/${code}.json`, 'utf8'));
const dicts = Object.fromEntries(LANGS.map(l => [l, read(l)]));

// плоский список ключей: { a: { b: 'x' } } → ['a.b']. '_about' — служебное описание файла.
const flat = (obj, pre = '') => Object.entries(obj).flatMap(([k, v]) =>
  k.startsWith('_') ? [] : (v && typeof v === 'object' ? flat(v, pre + k + '.') : [pre + k]));
const keys = Object.fromEntries(LANGS.map(l => [l, flat(dicts[l]).sort()]));

// Множественное число. i18next хранит формы как ключ_one / ключ_few / ключ_many — и НАБОР форм
// у языков РАЗНЫЙ: в русском и украинском их три (1 раунд / 2 раунда / 5 раундов), в английском две.
// Поэтому наборы ключей сравниваем по ОСНОВЕ, а формы проверяем по Intl.PluralRules каждого языка.
const SUFFIX = /_(zero|one|two|few|many|other)$/;
const baseOf = k => k.replace(SUFFIX, '');
const suffixOf = k => SUFFIX.exec(k)?.[1] ?? null;
// какие формы реально нужны языку: смотрим, что Intl выдаёт на целых числах, которыми считает игра
const formsNeeded = lang => {
  const pr = new Intl.PluralRules(lang);
  const probe = [0, 1, 2, 3, 4, 5, 11, 21, 100, 101, 102, 105];
  return [...new Set(probe.map(n => pr.select(n)))].sort();
};
// основа → набор форм (null = обычный ключ без склонений)
const shape = l => {
  const m = new Map();
  for (const k of keys[l]) {
    const b = baseOf(k);
    if (!m.has(b)) m.set(b, new Set());
    m.get(b).add(suffixOf(k));
  }
  return m;
};
const shapes = Object.fromEntries(LANGS.map(l => [l, shape(l)]));

for (const l of LANGS) {
  if (l === SOURCE_LANG) continue;
  eq(`${l}: нет пропущенных ключей`,
    [...shapes[SOURCE_LANG].keys()].filter(k => !shapes[l].has(k)), []);
  eq(`${l}: нет ключей-сирот`,
    [...shapes[l].keys()].filter(k => !shapes[SOURCE_LANG].has(k)), []);
}
// у ключа со склонениями каждый язык обязан иметь ВСЕ свои формы, у обычного — ровно одну запись
for (const l of LANGS) {
  const need = formsNeeded(l);
  const wrong = [];
  for (const [b, forms] of shapes[l]) {
    const plural = shapes[SOURCE_LANG].get(b) && !shapes[SOURCE_LANG].get(b).has(null);
    if (!shapes[SOURCE_LANG].has(b)) continue;                       // сироту уже поймали выше
    if (plural) { if (String([...forms].sort()) !== String(need)) wrong.push(`${b}: ${[...forms].sort()} ≠ ${need}`); }
    else if (forms.has(null) === false || forms.size !== 1) wrong.push(b + ': лишние формы');
  }
  eq(`${l}: формы множественного числа на месте`, wrong, []);
}
yes('в эталоне есть ключи', keys[SOURCE_LANG].length > 0);

// === 6. Значения: не пустые, плейсхолдеры совпадают ===
const at = (obj, key) => key.split('.').reduce((o, k) => o?.[k], obj);
const holders = s => (String(s).match(/{{\s*[\w.]+\s*}}/g) || []).map(x => x.replace(/\s/g, '')).sort();
for (const l of LANGS) {
  eq(`${l}: нет пустых строк`, keys[l].filter(k => !String(at(dicts[l], k)).trim()), []);
  if (l === SOURCE_LANG) continue;
  // сравниваем с ЛЮБОЙ формой эталона той же основы — плейсхолдеры у форм одинаковы
  const srcHolders = b => {
    const k = keys[SOURCE_LANG].find(x => baseOf(x) === b);
    return k === undefined ? null : holders(at(dicts[SOURCE_LANG], k));
  };
  eq(`${l}: плейсхолдеры как в эталоне`,
    keys[l].filter(k => {
      const want = srcHolders(baseOf(k));
      return want !== null && String(holders(at(dicts[l], k))) !== String(want);
    }), []);
}

// === 7. Алфавит: перевод не подсунули копипастой из соседнего языка ===
// Самая частая порча словарей — забыть перевести строку и оставить её как есть. Набор букв
// ловит это надёжнее, чем глаз: в украинском нет ы/ъ/ё/э, в русском — і/ї/є/ґ, в английском
// кириллицы нет вовсе.
const ALIEN = {
  uk: { re: /[ыъёэЫЪЁЭ]/, what: 'русские буквы' },
  ru: { re: /[іїєґІЇЄҐ]/, what: 'украинские буквы' },
  en: { re: /[А-Яа-яЁёІіЇїЄєҐґ]/, what: 'кириллица' }
};
for (const l of LANGS) {
  const rule = ALIEN[l];
  if (!rule) continue;
  eq(`${l}: нет чужого алфавита (${rule.what})`,
    keys[l].filter(k => rule.re.test(String(at(dicts[l], k)))), []);
}

// === 8. Ключи из разметки и из кода существуют в эталоне ===
const known = new Set(keys[SOURCE_LANG].map(baseOf));
const used = new Map();   // ключ -> где встретился
const note = (k, where) => { if (k) used.set(k, where); };

for (const f of ['public/index.html', 'public/game.html']) {
  const src = fs.readFileSync(f, 'utf8');
  for (const m of src.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) note(m[1], f);
  for (const m of src.matchAll(/data-i18n-attr="([^"]+)"/g))
    for (const pair of m[1].split(';')) note(pair.split(':')[1]?.trim(), f);
}
// Ключ может стоять не только прямо в t('...'), но и в тернарнике внутри неё: t(a ? 'x' : 'y').
// Поэтому ищем ЛЮБОЙ строковый литерал, начинающийся с имени словарного раздела, — ложных
// срабатываний нет, а забытый перевод в такой ветке иначе прошёл бы мимо.
const NS = new RegExp('^(' + Object.keys(dicts[SOURCE_LANG]).filter(k => !k.startsWith('_')).join('|') + ')\\.');
for (const f of fs.readdirSync('public/js').filter(n => n.endsWith('.js') && n !== 'i18n.js')) {
  const src = fs.readFileSync('public/js/' + f, 'utf8');
  for (const m of src.matchAll(/'([\w.]+)'/g)) if (NS.test(m[1])) note(m[1], f);
}
// Сервер тоже «говорит ключами»: отказы (error: 'err.…'), журнал (L('move') и { k: 'log.…' })
// и метки лобби. Забытый ключ игрок увидит как «err.notYourTurn» — ловим здесь.
for (const f of fs.readdirSync('server').filter(n => n.endsWith('.js'))) {
  const src = fs.readFileSync('server/' + f, 'utf8');
  for (const m of src.matchAll(/'((?:err|log|ship|mode|outpost|tag|mail)\.[\w.]+)'/g)) note(m[1], 'server/' + f);
  for (const m of src.matchAll(/\bL\(\s*'([\w.]+)'/g)) note('log.' + m[1], 'server/' + f);
  // ключи, собранные из типа: ship.${type}.name → проверяем шаблон по всем классам
  for (const m of src.matchAll(/`(ship|outpost)\.\$\{[^}]+\}\.(name|desc)`/g))
    note(m[1] === 'ship' ? 'ship.brig.name' : 'outpost.0.name', 'server/' + f);
}
eq('все ключи из разметки и t() есть в эталоне',
  [...used].filter(([k]) => !known.has(k)).map(([k, w]) => `${k} (${w})`), []);
yes('разметка реально размечена', used.size >= 10);

// === 9. Игровые сущности сервера покрыты словарём ===
// Сервер шлёт только ТИП (корабля, режима, постройки) — имя и описание рисует клиент.
// Значит на каждый тип из конфига обязан найтись ключ, иначе игрок увидит «ship.brig.name».
const { SHIP_TYPES, GAME_MODES, OUTPOST_LEVELS } = await import('./server/config.js');
const needKeys = [
  ...Object.keys(SHIP_TYPES).flatMap(k => [`ship.${k}.name`, `ship.${k}.desc`]),
  'ship.pirate.name', 'ship.pirate.desc',
  ...Object.keys(GAME_MODES).flatMap(k => [`mode.${k}.name`, `mode.${k}.desc`]),
  ...OUTPOST_LEVELS.map((_, i) => `outpost.${i}.name`)
];
for (const l of LANGS) eq(`${l}: у каждого корабля/режима/постройки есть имя`,
  needKeys.filter(k => at(dicts[l], k) === undefined), []);
// имена ботов сервер тоже шлёт ключами — на каждый слот каждого уровня нужен перевод
const { BOT_NAMES } = await import('./server/bot.js');
const botKeys = Object.values(BOT_NAMES).flat().concat('bot.extra');
for (const l of LANGS) eq(`${l}: у всех ботов есть имя`, botKeys.filter(k => at(dicts[l], k) === undefined), []);
eq('ники ботов — ключи, а не фразы', botKeys.filter(k => !/^bot\.[\w.]+$/.test(k)), []);

// и наоборот: в конфиге не должно остаться человекочитаемых имён (сервер их больше не знает)
eq('в SHIP_TYPES нет name/desc', Object.entries(SHIP_TYPES).filter(([, v]) => v.name || v.desc).map(([k]) => k), []);
eq('в GAME_MODES нет name/desc', Object.entries(GAME_MODES).filter(([, v]) => v.name || v.desc).map(([k]) => k), []);
eq('в OUTPOST_LEVELS нет name/desc', OUTPOST_LEVELS.filter(v => v.name || v.desc).length, 0);

// === 10. Клиент не читает имён из серверных данных ===
// Имён и описаний в стейте больше нет, но обращение к ним НЕ падает — просто отдаёт undefined,
// и игрок видит «⬆ 🏰 undefined (400)». Именно так и уехала кнопка прокачки аванпоста. Поэтому
// запрещаем чтение .name/.desc у объектов, которые приезжают с сервера (класс судна, уровень
// постройки, режим): имя берут из словаря — shipName() / outpostName() / t('mode.…').
{
  const FORBIDDEN = /\b(?:ST\([^)]*\)\??|def|next|st|lvl|isl\.outpost)\.(?:name|desc)\b/g;
  const found = [];
  for (const f of fs.readdirSync('public/js').filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync('public/js/' + f, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//')) return;
      for (const m of line.matchAll(FORBIDDEN)) found.push(`${f}:${i + 1} ${m[0]}`);
    });
  }
  eq('клиент берёт имена из словаря, а не из стейта', found, []);
}

// === 11. Обвязка на месте ===
yes('i18next вендорится в public/vendor', fs.existsSync('public/vendor/i18next.min.js'));
for (const f of ['public/index.html', 'public/game.html']) {
  const src = fs.readFileSync(f, 'utf8');
  // ищем именно теги: путь к i18n.js упоминается ещё и в комментариях разметки
  const tag = p => src.indexOf(`<script src="${p}">`);
  yes(`${f}: подключён i18next до i18n.js`, tag('/vendor/i18next.min.js') > 0 && tag('/vendor/i18next.min.js') < tag('/js/i18n.js'));
  yes(`${f}: есть место под переключатель`, src.includes('data-lang-switch'));
}

console.log(`\nИтого локализация: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
