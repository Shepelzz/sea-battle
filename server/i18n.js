// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ЯЗЫК ИНТЕРФЕЙСА — единый источник правды. Чистая логика, без сети и БД,  ║
// ║  чтобы её можно было покрыть тестами (index.js надевает сверху HTTP).     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ГЛАВНОЕ ПРАВИЛО ЛОКАЛИЗАЦИИ: в одной партии сидят игроки с РАЗНЫМИ языками,
// а сервер один. Значит сервер НЕ шлёт готовых фраз — только ключи и числа,
// текст рисует клиент своим словарём (public/locales/*.json). События боя
// (pushEvent) с самого начала структурные, так что журнал переводится даром.

export const LANGS = ['uk', 'ru', 'en'];

// Язык-ЭТАЛОН: на нём написаны исходные строки (и текст в самой разметке). В него падаем,
// если ключа нет в выбранном словаре — лучше показать русскую фразу, чем голый ключ.
// На практике не срабатывает: полноту словарей стережёт test-i18n.mjs.
export const SOURCE_LANG = 'ru';

// Язык по умолчанию: гостю, чей Accept-Language ничего не подсказал, показываем украинский.
export const DEFAULT_LANG = 'uk';

export const LANG_COOKIE = 'sb_lang';
export const LANG_TTL_MS = 365 * 24 * 60 * 60 * 1000; // год

export const isLang = l => LANGS.includes(l);

// 'uk-UA' / 'ru_RU' / ' EN ' → 'uk' / 'ru' / 'en'; чужое или мусор → null.
export function normLang(raw) {
  const base = String(raw || '').trim().toLowerCase().split(/[-_;]/)[0];
  return isLang(base) ? base : null;
}

// Accept-Language: 'uk-UA,uk;q=0.9,en;q=0.7,de' → ['uk','en'] (по убыванию q, чужие выброшены).
export function parseAcceptLanguage(header) {
  return String(header || '').split(',')
    .map(part => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map(p => /^\s*q\s*=\s*([\d.]+)/i.exec(p)?.[1]).find(Boolean);
      return { lang: normLang(tag), q: q === undefined ? 1 : parseFloat(q) };
    })
    .filter(x => x.lang && Number.isFinite(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q)
    .map(x => x.lang)
    .filter((l, i, arr) => arr.indexOf(l) === i);
}

// Какой язык показать. ПРОФИЛЬ > КУКА > Accept-Language > дефолт.
// Профиль главнее куки намеренно: залогинился со своего аккаунта — получил СВОЙ язык,
// а не тот, что остался в браузере от чужого/гостевого сеанса на этом устройстве.
export function pickLang({ profile, cookie, header } = {}) {
  return normLang(profile) || normLang(cookie) || parseAcceptLanguage(header)[0] || DEFAULT_LANG;
}

// Кука языка — НЕ httpOnly: клиент читает её сам, когда страницу отдал не наш рендер
// (например статикой из кэша). Ничего секретного в ней нет.
export function buildLangCookie(lang, { secure = false, ttlMs = LANG_TTL_MS } = {}) {
  const p = [`${LANG_COOKIE}=${lang}`, 'SameSite=Lax', 'Path=/', `Max-Age=${Math.floor(ttlMs / 1000)}`];
  if (secure) p.push('Secure');
  return p.join('; ');
}
