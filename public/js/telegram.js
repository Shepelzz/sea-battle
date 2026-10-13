// Telegram Mini App — клиентская обвязка. Подключается на главной и в игре ПЕРЕД home.js/game.js.
//
// Как это работает: Телеграм открывает наш сайт в своём WebView и кладёт в hash адреса подписанный
// initData (подпись — HMAC от токена бота, проверяет сервер в /api/auth/telegram). Снаружи Телеграма
// этот файл ничего не делает: ни скрипта telegram.org, ни запросов — обычный сайт остаётся обычным.
//
// Внутри Телеграма: грузим их telegram-web-app.js (он разбирает hash в Telegram.WebApp.initData и
// сам запоминает параметры в sessionStorage, так что переход на /game/<id> их не теряет),
// разворачиваем окно и, если аккаунта ещё нет, входим молча — кнопка Google там не нужна.
window.SBTelegram = (() => {
  // признак запуска из Телеграма — параметры, которые он сам дописывает в hash; запоминаем на вкладку,
  // чтобы страница партии (без hash) тоже знала, что мы внутри мини-аппа
  const FLAG = 'sb_tg';
  const fromHash = /tgWebAppData=|tgWebAppPlatform=/.test(location.hash);
  if (fromHash) { try { sessionStorage.setItem(FLAG, '1'); } catch { /* приватный режим */ } }
  const inTelegram = fromHash || (() => { try { return sessionStorage.getItem(FLAG) === '1'; } catch { return false; } })();
  let readyP = null;

  // --- сессия без cookie ---
  // В WebView Телеграма cookie может не сохраниться, поэтому токен сессии (его отдаёт /api/auth/telegram)
  // держим в localStorage и шлём сами: HTTP — заголовком Authorization: Bearer, сокет — в auth.session.
  // Снаружи Телеграма токена нет и ничего не меняется.
  const SKEY = 'sb_tg_session';
  const session = () => { try { return localStorage.getItem(SKEY) || null; } catch { return null; } };
  const setSession = v => { try { v ? localStorage.setItem(SKEY, v) : localStorage.removeItem(SKEY); } catch { /* приватный режим */ } };
  // Заголовок Authorization на свои же /api/… запросы — оборачиваем fetch один раз, чтобы не трогать
  // каждый вызов в home.js/game.js. Чужие адреса не трогаем: токен не должен утечь наружу.
  const rawFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const tok = session();
    const url = typeof input === 'string' ? input : input?.url || '';
    if (tok && /^\/api\//.test(url)) {
      init = { ...(init || {}) };
      const h = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined) || {});
      if (!h.has('Authorization')) h.set('Authorization', 'Bearer ' + tok);
      init.headers = h;
    }
    return rawFetch(input, init);
  };
  // опции для io(): токен подставляется при КАЖДОМ рукопожатии (после входа сокет переподключают)
  const socketAuth = cb => cb(session() ? { session: session() } : {});

  // подгрузить SDK Телеграма (один раз) и дождаться объекта WebApp
  function init() {
    if (!inTelegram) return Promise.resolve(null);
    if (readyP) return readyP;
    readyP = new Promise(resolve => {
      const done = () => {
        const wa = window.Telegram?.WebApp || null;
        if (wa) {
          try { wa.ready(); wa.expand(); } catch { /* старый клиент */ }
          try { document.body.classList.add('tg-app'); } catch { /* до body */ }
          // На телефоне — во весь экран (Bot API 8.0+): без шапки Телеграма. Отступы под статус-бар и
          // кнопки Телеграма SDK отдаёт CSS-переменными --tg-safe-area-inset-* / --tg-content-safe-area-inset-*,
          // стили их читают через класс tg-fullscreen. Вертикальные свайпы гасим: иначе тяга карты
          // вниз сворачивала бы мини-апп.
          try { if (wa.disableVerticalSwipes) wa.disableVerticalSwipes(); } catch { /* старый клиент */ }
          const syncFs = () => document.body.classList.toggle('tg-fullscreen', !!wa.isFullscreen);
          try { wa.onEvent && wa.onEvent('fullscreenChanged', syncFs); } catch { /* старый клиент */ }
          try {
            if (wa.requestFullscreen && /^(ios|android)$/.test(wa.platform || '') && (!wa.isVersionAtLeast || wa.isVersionAtLeast('8.0')))
              wa.requestFullscreen();
          } catch { /* старый клиент */ }
          syncFs();
        }
        resolve(wa);
      };
      if (window.Telegram?.WebApp) return done();
      const s = document.createElement('script');
      s.src = 'https://telegram.org/js/telegram-web-app.js';
      s.onload = done; s.onerror = () => resolve(null);
      document.head.appendChild(s);
    });
    return readyP;
  }

  // Войти по initData. nick — только явно введённый игроком (на первом входе), иначе ник из Телеграма.
  // Возвращает { ok, data } — data как у /api/auth/google: { nick, email, avatar, lang, startParam }.
  async function login(nick = '') {
    const wa = await init();
    const initData = wa?.initData || '';
    if (!initData) return { ok: false, error: 'err.telegramFailed' };
    try {
      const r = await fetch('/api/auth/telegram', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ initData, nick })
      });
      const data = await r.json();
      if (r.ok && data.session) setSession(data.session);
      if (r.ok) askWriteAccess();   // чтобы бот мог прислать «твой ход» — спрашиваем один раз
      return r.ok ? { ok: true, data } : { ok: false, error: data?.error || 'err.telegramFailed', data };
    } catch {
      return { ok: false, error: 'err.telegramFailed' };
    }
  }

  // Разрешение боту писать в личку (напоминания «твой ход»). Телеграм сам помнит ответ, но окно
  // показываем не чаще раза: отказавшему — не надоедать.
  async function askWriteAccess() {
    const wa = await init(); if (!wa?.requestWriteAccess) return;
    try {
      if (wa.initDataUnsafe?.user?.allows_write_to_pm) return;
      if (localStorage.getItem('sb_tg_write_asked')) return;
      localStorage.setItem('sb_tg_write_asked', '1');
      wa.requestWriteAccess();
    } catch { /* старый клиент */ }
  }

  // параметр запуска (ссылка t.me/<бот>?startapp=<id партии>) — приглашение в лобби. Берём ОДИН раз
  // на вкладку: после перехода в партию SDK его помнит, и без этого главная уводила бы туда снова и снова
  async function takeStartParam() {
    const v = (await init())?.initDataUnsafe?.start_param || '';
    if (!v || !/^[A-Za-z0-9_-]{4,24}$/.test(v)) return '';
    try { if (sessionStorage.getItem('sb_tg_start_done') === v) return ''; sessionStorage.setItem('sb_tg_start_done', v); } catch { /* ок */ }
    return v;
  }

  // Кнопка «назад» Телеграма (в шапке мини-аппа) — ведёт туда, куда скажет страница
  async function backButton(onBack) {
    const wa = await init(); if (!wa?.BackButton) return;
    try { wa.BackButton.show(); wa.BackButton.onClick(onBack); } catch { /* старый клиент */ }
  }
  // Подтверждение закрытия мини-аппа свайпом — пока идёт партия, чтобы не вылететь случайно
  async function closingConfirm(on) {
    const wa = await init(); if (!wa) return;
    try { on ? wa.enableClosingConfirmation() : wa.disableClosingConfirmation(); } catch { /* старый клиент */ }
  }

  // Ссылка на мини-апп с партией и штатное окно «поделиться» Телеграма
  const miniAppLink = (bot, gameId) => `https://t.me/${bot}${gameId ? `?startapp=${gameId}` : ''}`;
  async function share(bot, gameId, text) {
    const wa = await init();
    const url = `https://t.me/share/url?url=${encodeURIComponent(miniAppLink(bot, gameId))}&text=${encodeURIComponent(text || '')}`;
    if (wa?.openTelegramLink) wa.openTelegramLink(url); else window.open(url, '_blank');
  }

  // Верхний отступ в полноэкранном режиме (статус-бар + кнопки Телеграма), px — для рисунков на канве
  function topInset() {
    const wa = window.Telegram?.WebApp;
    if (!wa?.isFullscreen) return 0;
    return (wa.safeAreaInset?.top || 0) + (wa.contentSafeAreaInset?.top || 0);
  }

  // Открыть адрес во ВНЕШНЕМ браузере телефона (не в WebView): так работает вход Google, который
  // Google запрещает внутри встроенных браузеров
  async function openLink(url) {
    const wa = await init();
    if (wa?.openLink) wa.openLink(url, { try_instant_view: false }); else window.open(url, '_blank');
  }

  // Закрыть мини-апп (после «выйти»: перезагрузка внутри Телеграма просто залогинила бы снова)
  async function close() {
    const wa = await init();
    try { wa?.close(); } catch { /* старый клиент */ }
  }

  return { inTelegram, init, login, takeStartParam, session, socketAuth, logout: () => setSession(null),
    backButton, closingConfirm, miniAppLink, share, askWriteAccess, topInset, openLink, close };
})();
