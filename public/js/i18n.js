// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ЛОКАЛИЗАЦИЯ КЛИЕНТА — поверх i18next (public/vendor/i18next.min.js).     ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ⚠ ТЕКСТ СТРАНИЦЫ ПЕРЕВОДИТ СЕРВЕР, а не этот файл: HTML приезжает уже на нужном языке
// (см. buildPage в server/index.js). Иначе на медленном канале страница успевала отрисоваться
// до загрузки скриптов, и человек видел чужой язык, пока едут i18next и этот файл.
//
// Здесь остаётся динамика: t() для текста, который рисует JS (журнал, тосты, панели),
// переключатель языка и перерисовка по data-i18n, когда язык меняют на лету. Словарь для
// этого приезжает вместе со страницей (window.__SB_I18N в <head>) — ни фетча, ни гонки
// с game.js/home.js: к моменту их запуска t() уже работает.
//
// Как размечать:
//   <p data-i18n="home.tagline">…</p>                  → textContent
//   <p data-i18n-html="wiki.turn">…<b>…</b></p>        → innerHTML (для строк с тегами)
//   <button data-i18n-attr="title:lang.title">…        → атрибуты, через ; можно несколько
//   <div data-lang-switch></div>                       → сюда встанет переключатель языка
// В JS: t('common.login'), t('log.sunk', { count: 3 }).
//
// ⚠ escapeValue: false — в словаре есть теги (<b>, <br>), и мы вставляем строки как HTML.
// Значит ПОДСТАВЛЯЕМЫЕ значения, пришедшие от людей (ники!), экранируем сами escapeHtml(),
// ровно как и до локализации.
(function () {
  const boot = window.__SB_I18N || {};
  const LANGS = boot.langs || ['uk', 'ru', 'en'];
  const SOURCE = boot.source || 'ru';
  // Язык по умолчанию — дубль DEFAULT_LANG из server/i18n.js. Нужен ровно в одном случае:
  // страница пришла мимо рендера (сырая статика), и boot.lang пуст. Язык браузера тут
  // НЕ смотрим — по той же причине, что и на сервере: не выбирал язык → видишь дефолтный.
  const DEFAULT = boot.def || 'uk';
  // Родные названия языков — единственное, что НЕ переводится: в списке каждый язык
  // подписан на себе самом, иначе его не найдёт тот, кто попал не на свой.
  // На кнопке — только флаг (она стоит в тесном ряду у бейджа входа), название видно в списке.
  // У русского вместо флага — 🏴‍☠️: так захотел владелец игры. Заодно попадает в тему.
  const FLAGS = { uk: '🇺🇦', ru: '🏴‍☠️', en: '🇬🇧' };
  const NAMES = { uk: 'Українська', ru: 'Русский', en: 'English' };

  let lang = boot.lang || readCookie('sb_lang') || DEFAULT;

  function norm(raw) {
    const base = String(raw || '').trim().toLowerCase().split(/[-_]/)[0];
    return LANGS.includes(base) ? base : null;
  }
  function readCookie(name) {
    const m = new RegExp('(?:^|; )' + name + '=([^;]*)').exec(document.cookie || '');
    return m ? norm(decodeURIComponent(m[1])) : null;
  }

  // --- старт i18next: ресурсы уже в странице, поэтому init синхронный ---
  const resources = {};
  for (const [code, dict] of Object.entries(boot.res || {})) resources[code] = { translation: dict };
  i18next.init({
    lng: lang, fallbackLng: SOURCE, resources,
    interpolation: { escapeValue: false },   // см. предупреждение в шапке файла
    parseMissingKeyHandler: k => k           // ключа нет нигде — видно ключ, а не пустота
  });

  const t = (key, opts) => i18next.t(key, opts);

  // ── то, что прислал сервер ──────────────────────────────────────────────
  // Сервер один на партию, а игроки в ней с РАЗНЫМИ языками — поэтому он шлёт не фразы,
  // а ключи: ошибки ('err.notYourTurn'), строки журнала ('log.move'), метки лобби. Ключ
  // может приехать и ЗНАЧЕНИЕМ параметра (имя корабля, причина отказа) — переводим и его.
  // Всё, что на ключ не похоже (ник игрока, число, запись из старой сохранённой партии,
  // сообщение чит-режима), отдаём как есть.
  const KEYISH = /^(err|ship|mode|outpost|log|tag|bot)\.[\w.]+$/;
  function tr(key, params) {
    if (key === null || key === undefined) return '';
    if (typeof key !== 'string' || !KEYISH.test(key)) return String(key);
    const one = v => (typeof v === 'string' && KEYISH.test(v)) ? t(v) : v;
    const p = {};
    for (const [k, v] of Object.entries(params || {}))
      p[k] = Array.isArray(v) ? v.map(one).join(', ') : one(v);   // список судов приезжает массивом ключей
    return t(key, p);
  }
  // ответ сервера {ok:false, error, params} → готовая строка
  const errText = r => tr(r && r.error, r && r.params);

  // --- разметка → текст ---
  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    scope.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
    scope.querySelectorAll('[data-i18n-attr]').forEach(el => {
      for (const pair of el.dataset.i18nAttr.split(';')) {
        const i = pair.indexOf(':');
        if (i > 0) el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
      }
    });
    scope.querySelectorAll('[data-lang-switch]').forEach(mount);
  }

  // --- переключатель ---
  // Тот же дропдаун, что у режимов и цветов (public/js/palette.js): нативный <select> на мобиле
  // всплывает не там, да и показать в кнопке одно, а в списке другое он не умеет.
  function mount(box) {
    box.replaceChildren();
    box.classList.add('lang-dd');
    const opts = LANGS.map(code => ({ key: code, name: `${FLAGS[code] || ''} ${NAMES[code] || code}`.trim() }));
    renderModeDropdown(box, opts, lang, code => set(code), m => FLAGS[m.key] || m.key);
    const btn = box.querySelector('.mode-dd-btn');
    if (btn) { btn.title = t('lang.title'); btn.setAttribute('aria-label', t('lang.title')); }
  }

  // --- смена языка на лету ---
  // persist=false — когда язык НАВЯЗАН сервером (вошёл в аккаунт, где записан свой язык):
  // применяем, но не пишем обратно, иначе затрём профиль его же значением.
  async function set(next, { persist = true } = {}) {
    const code = norm(next);
    if (!code || code === lang) return;
    if (!i18next.hasResourceBundle(code, 'translation')) {
      try {
        const r = await fetch('/locales/' + code + '.json', { cache: 'no-cache' });
        if (!r.ok) throw new Error(r.status);
        i18next.addResourceBundle(code, 'translation', await r.json(), true, true);
      } catch (e) { console.warn('i18n: не загрузился словарь ' + code, e); return; }
    }
    lang = code;
    await i18next.changeLanguage(code);
    document.documentElement.lang = code;
    apply(document);
    if (persist) fetch('/api/lang', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: code })
    }).catch(() => { /* не сохранилось — язык всё равно сменился до перезагрузки */ });
    // динамику (канва, списки, журнал) перерисовывают подписчики
    window.dispatchEvent(new CustomEvent('sb:lang', { detail: { lang: code } }));
  }

  window.t = t;
  window.tr = tr;
  window.errText = errText;
  window.SBI18n = { t, tr, errText, apply, set, mount, lang: () => lang, langs: () => LANGS.slice(), source: SOURCE };

  // Словаря может не быть, если страницу отдали статикой мимо нашего рендера —
  // тогда докачаем нужный язык асинхронно (страница уже показывает эталонный текст).
  if (!i18next.hasResourceBundle(lang, 'translation')) {
    const want = lang; lang = SOURCE; set(want, { persist: false });
  }

  // Разметку сервер уже перевёл — этот проход ставит переключатель языка и страхует
  // редкий случай, когда страница пришла мимо рендера (сырая статика, ошибка рендера).
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => apply(document));
  else apply(document);
})();
