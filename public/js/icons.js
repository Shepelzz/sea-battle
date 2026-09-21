// 🎨 ПОДМЕНА ЭМОДЗИ НА СВОЙ НАБОР.
//
// Зачем: системные эмодзи рисует шрифт устройства — на макоси один рисунок, на винде и андроиде
// другой, а часть символов вообще выходит чёрно-белой. Свой набор (public/icons/sb.js) выглядит
// одинаково у всех и правится нами.
//
// Подменять приходится в ДВУХ разных мирах:
//   • разметка — значки сидят прямо внутри строк словаря («⚓ Морской бой»), и строки эти
//     постоянно пересобираются (смена языка, перерисовка сайдбара, журнал). Поэтому вместо того
//     чтобы ловить каждое присваивание innerHTML, мы один раз вешаем MutationObserver и красим
//     всё, что появляется в документе. Точки вызова менять не нужно вообще;
//   • канва — там текст рисует сам браузер, DOM его не видит. Для неё есть SBIcons.text(),
//     который раскладывает строку на куски «текст / значок» и рисует значки картинкой.
//
// Чего НЕ трогаем: атрибуты (title, placeholder) и document.title — там значок остаётся
// системным, подменить его нечем. И список KEEP ниже — значки, которые решено оставить как есть.
(() => {
  const SET = window.SB_ICONS || {};

  // Оставляем системными намеренно: рисунок в наборе есть, но в игре он не нужен.
  const KEEP = new Set(['1f446', '1f447', '270b']);   // 👆 👇 ✋

  const cpOf = ch => [...ch].map(c => c.codePointAt(0).toString(16)).join('-');

  // Символ → разметка. Строим по набору, отбрасывая KEEP и группу ship-* (у неё свои ключи,
  // к символам она не привязана).
  //
  // ВАРИАНТЫ. Ключ вида `<код>--<вариант>` — тот же символ, нарисованный иначе для конкретного
  // места. Пиратский флаг на карте с древком, а в переключателе языка он стоит в ряду с 🇺🇦 и 🇬🇧,
  // и древко там лишнее. Какой вариант брать — говорит ближайший предок с data-icon-variant.
  const BY_CHAR = new Map();     // символ → разметка (обычная)
  const VARIANTS = new Map();    // "символ|вариант" → разметка
  const charOf = cp => String.fromCodePoint(...cp.split('-').map(h => parseInt(h, 16)));
  for (const [key, body] of Object.entries(SET)) {
    if (!/^[0-9a-f]/.test(key)) continue;
    const [cp, variant] = key.split('--');
    if (KEEP.has(cp)) continue;
    if (variant) VARIANTS.set(charOf(cp) + '|' + variant, body);
    else BY_CHAR.set(charOf(cp), body);
  }

  // Регулярка из всех известных символов, длинные — первыми: 🏴‍☠️ обязан совпасть раньше, чем 🏴.
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const RE = BY_CHAR.size
    ? new RegExp([...BY_CHAR.keys()].sort((a, b) => b.length - a.length).map(esc).join('|'), 'g')
    : null;

  const bodyOf = (ch, variant) =>
    (variant && VARIANTS.get(ch + '|' + variant)) || BY_CHAR.get(ch);
  const svgOf = (ch, variant) => {
    const body = bodyOf(ch, variant);
    return body ? `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg>` : null;
  };

  // ─── DOM ───────────────────────────────────────────────────────────────────
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'SVG']);
  let painting = false;   // свои же вставки обратно в наблюдатель не пускаем

  function paintText(node) {
    // Узел мог уже отвалиться от дерева: наблюдатель приходит асинхронно, а игра перерисовывает
    // баннер хода и журнал каждым тиком. Без этой проверки replaceChild падал на null, исключение
    // рвало обработку всего пакета правок — и половина документа оставалась некрашеной.
    if (!node.parentNode) return;
    const txt = node.nodeValue;
    if (!txt || !RE) return;
    RE.lastIndex = 0;
    if (!RE.test(txt)) return;
    RE.lastIndex = 0;
    const host = node.parentElement && node.parentElement.closest('[data-icon-variant]');
    const variant = host ? host.dataset.iconVariant : '';
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = RE.exec(txt))) {
      if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'sbi';
      span.dataset.ch = m[0];          // исходный символ — видно в инспекторе и годится для отката
      if (variant) span.dataset.variant = variant;
      span.innerHTML = svgOf(m[0], variant);
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function paint(root) {
    if (!RE || !root) return;
    if (root.nodeType === Node.TEXT_NODE) return paintText(root);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.closest && root.closest('[data-no-icons]')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName) || p.classList.contains('sbi')) return NodeFilter.FILTER_REJECT;
        if (p.closest('[data-no-icons]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const list = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) list.push(n);
    list.forEach(paintText);
  }

  function paintAll(root) {
    if (painting) return;
    painting = true;
    try { paint(root); } finally { painting = false; }
  }

  function observe() {
    paintAll(document.body);
    new MutationObserver(muts => {
      if (painting) return;
      painting = true;
      try {
        for (const m of muts) {
          // каждую запись — отдельно: споткнулись на одной, остальные всё равно докрасим
          try {
            if (m.type === 'characterData') paintText(m.target);
            else m.addedNodes.forEach(n => paint(n));
          } catch (e) { console.warn('icons: не покрасил узел', e); }
        }
      } finally { painting = false; }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // ─── КАНВА ─────────────────────────────────────────────────────────────────
  // Значок на канве — картинка: data-URL с тем же SVG. Держим кэш, чтобы не собирать его
  // заново каждый кадр. Пока картинка грузится, рисуем системный символ — кадр не пропадёт.
  const imgCache = new Map();
  function imgOf(ch) {
    if (imgCache.has(ch)) return imgCache.get(ch);
    const svg = svgOf(ch);
    if (!svg) { imgCache.set(ch, null); return null; }
    const img = new Image();
    img.decoding = 'sync';
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    imgCache.set(ch, img);
    return img;
  }
  const ready = img => img && img.complete && img.naturalWidth > 0;

  const fontPx = font => {
    const m = /(\d+(?:\.\d+)?)px/.exec(font || '');
    return m ? +m[1] : 16;
  };

  function parts(str) {
    if (!RE) return [{ text: str }];
    RE.lastIndex = 0;
    const out = []; let last = 0, m;
    while ((m = RE.exec(str))) {
      if (m.index > last) out.push({ text: str.slice(last, m.index) });
      out.push({ icon: m[0] });
      last = m.index + m[0].length;
    }
    if (last < str.length) out.push({ text: str.slice(last) });
    return out;
  }

  // Рисует строку со значками. Держит ctx.textAlign и ctx.textBaseline, как обычный fillText,
  // поэтому вызывающему коду ничего менять не надо, кроме имени функции.
  // stroke:true — обводка (как strokeText) применяется ТОЛЬКО к тексту: у значка своя обводка внутри.
  function text(ctx, str, x, y, { stroke = false } = {}) {
    const ps = parts(str);
    if (!ps.some(p => p.icon)) {           // значков нет — обычный путь, без лишней работы
      if (stroke) ctx.strokeText(str, x, y);
      ctx.fillText(str, x, y);
      return;
    }
    const size = fontPx(ctx.font);
    const adv = size * 1.06;               // значок занимает чуть больше своей ширины, как глиф
    const w = p => (p.icon ? adv : ctx.measureText(p.text).width);
    const total = ps.reduce((s, p) => s + w(p), 0);

    const align = ctx.textAlign;
    let cur = align === 'center' ? x - total / 2 : (align === 'right' || align === 'end') ? x - total : x;
    const base = ctx.textBaseline;
    const top = base === 'middle' ? y - size / 2 : base === 'top' || base === 'hanging' ? y : y - size * 0.82;

    ctx.textAlign = 'left';
    for (const p of ps) {
      if (p.icon) {
        const img = imgOf(p.icon);
        if (ready(img)) ctx.drawImage(img, cur + (adv - size) / 2, top, size, size);
        else { if (stroke) ctx.strokeText(p.icon, cur, y); ctx.fillText(p.icon, cur, y); }
      } else {
        if (stroke) ctx.strokeText(p.text, cur, y);
        ctx.fillText(p.text, cur, y);
      }
      cur += w(p);
    }
    ctx.textAlign = align;
  }

  // Значок сам по себе, вписанный в квадрат size с центром в (x, y).
  function draw(ctx, ch, x, y, size) {
    const img = imgOf(ch);
    if (ready(img)) return ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    // картинка ещё не догрузилась — рисуем системный символ, но тоже ПО ЦЕНТРУ,
    // иначе кадр-другой значок прыгает относительно своего места
    const f = ctx.font, b = ctx.textBaseline;
    ctx.font = `${size}px serif`; ctx.textBaseline = 'middle';
    ctx.fillText(ch, x, y);
    ctx.font = f; ctx.textBaseline = b;
  }

  // ─── КЛАССЫ СУДОВ ──────────────────────────────────────────────────────────
  // Классы в игре делят эмодзи с другими сущностями: бриг сидит на ⚓ (вместе с логотипом и
  // перком «сухой док»), баркас — на ⛵ (вместе с «косым парусом»), ремонтник — на 🛟 (вместе
  // с кнопкой «Чинить»). По символу их не различить, поэтому рисунок спрашивают ПО ТИПУ.
  // Нет рисунка (чит-корабль, новый класс) — отдаём исходный значок, ничего не ломается.
  function ship(type, fallback = '') {
    const body = SET['ship-' + type];
    return body
      ? `<span class="sbi" data-ship="${type}"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${body}</svg></span>`
      : fallback;
  }

  window.SBIcons = {
    ship,
    has: ch => BY_CHAR.has(ch),
    svg: svgOf,
    paint: paintAll,      // ручной проход, если понадобится
    text, draw,
    keep: KEEP,
    size: () => BY_CHAR.size
  };

  // Прогреваем картинки заранее: иначе первый кадр канвы нарисует системный символ.
  for (const ch of BY_CHAR.keys()) imgOf(ch);

  // Страховка: смена языка переписывает разом всю размеченную разметку. Наблюдатель это ловит,
  // но проход по событию дешевле, чем разбирать сотню отдельных записей, и не зависит от их порядка.
  window.addEventListener('sb:lang', () => paintAll(document.body));

  if (document.body) observe();
  else document.addEventListener('DOMContentLoaded', observe);
})();
