// СКИН КАРТЫ: «тетрадь» (paper, рисуем векторами — game.js + art.js) или «живая карта»
// (sprites — растровые картинки из public/sprites/, см. SPRITES.md).
//
// Выбор живёт в профиле аккаунта (players.skin) и дублируется в localStorage('sb_skin'), откуда его
// читает игровой экран: игра стартует до ответа /api/auth/me, а лишний запрос ради одного слова не нужен.
// Гость без аккаунта — всегда «тетрадь» (переключателя у него нет).
//
// Спрайты подгружаются лениво по имени. Файл может оказаться JPEG на пурпурном фоне #FF00FF (так отдаёт
// генератор картинок) — тогда фон вырезаем сами при загрузке (chroma key) и складываем в канву с альфой.
// Чего нет в папке (404) — рисуем ВРЕМЕННОЙ ЗАГЛУШКОЙ: цветной квадрат с подписью, что тут должно быть.
window.SBSkin = (() => {
  const KEY = 'sb_skin', SKINS = ['paper', 'sprites'], DEFAULT = 'paper';
  const INK = '#2b3a55';
  let onReady = null;                        // game.js подписывается: спрайт догрузился → перерисовать

  const current = () => { try { const v = localStorage.getItem(KEY); return SKINS.includes(v) ? v : DEFAULT; } catch { return DEFAULT; } };
  const set = v => { try { if (SKINS.includes(v)) localStorage.setItem(KEY, v); } catch { /* приватный режим */ } };
  const isSprites = () => current() === 'sprites';

  // ---------- загрузка ----------
  const cache = new Map();                   // name → { state: 'loading'|'ok'|'missing', img: canvas|null }
  function get(name) {
    let e = cache.get(name);
    if (e) return e.state === 'ok' ? e.img : null;
    e = { state: 'loading', img: null }; cache.set(name, e);
    const im = new Image();
    im.onload = () => { e.img = prepare(im, name); e.state = 'ok'; onReady && onReady(); };
    im.onerror = () => { e.state = 'missing'; };
    im.src = `/sprites/${name}.png`;
    return null;
  }
  const missing = name => cache.get(name)?.state === 'missing';

  // Картинка → канва. Вода остаётся как есть; у остальных вырезаем пурпурный фон, если он там есть.
  function prepare(im, name) {
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0);
    if (name === 'water') return c;
    let d;
    try { d = g.getImageData(0, 0, c.width, c.height); } catch { return c; }
    const px = d.data;
    // Фон — тот цвет, что в углах картинки (генератор отдаёт не ровно #FF00FF, а свой «розовый», у каждой
    // картинки чуть разный). Углы прозрачные (честный PNG с альфой) или разноцветные — трогать нечего.
    const corner = (x, y) => { const i = (y * c.width + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };
    const cs = [corner(3, 3), corner(c.width - 4, 3), corner(3, c.height - 4), corner(c.width - 4, c.height - 4)];
    if (cs.some(p => p[3] < 200)) return c;
    // фон — цвет левого верхнего угла; ещё хотя бы два угла должны с ним совпадать (в правом нижнем
    // генератор ставит свою подпись-водяной знак — один угол имеет право отличаться)
    const bg = cs[0].slice(0, 3);
    const agree = cs.slice(1).filter(p => Math.hypot(p[0] - bg[0], p[1] - bg[1], p[2] - bg[2]) < 40).length;
    if (agree < 2) return c;                                      // углы разные — это не ровный фон
    // фон должен быть «ядовитым» (пурпур/зелёный экран): насыщенный. Небо/песок в углах — не фон
    if (Math.max(...bg) - Math.min(...bg) < 90) return c;
    for (let i = 0; i < px.length; i += 4) {
      const d = Math.hypot(px[i] - bg[0], px[i + 1] - bg[1], px[i + 2] - bg[2]) / 441; // 0 — ровно фон
      const alpha = Math.max(0, Math.min(1, (d - 0.14) / 0.16));   // мягкая кромка: d<0.14 → 0, d>0.30 → 1
      if (alpha < 1) {
        px[i + 3] = Math.round(px[i + 3] * alpha);
        // убрать цветную кайму фона на полупрозрачных пикселях: вычесть из цвета долю фона
        for (let ch = 0; ch < 3; ch++) {
          const v = alpha > 0.02 ? (px[i + ch] - bg[ch] * (1 - alpha)) / alpha : px[i + ch];
          px[i + ch] = Math.max(0, Math.min(255, Math.round(v)));
        }
      }
    }
    g.putImageData(d, 0, 0);
    return c;
  }

  // Перекраска командным цветом: почти белые пиксели (паруса, вымпел) → цвет игрока. Кэш по имени+цвету.
  const tintCache = new Map();
  function tinted(name, color) {
    const src = get(name); if (!src) return null;
    const key = name + '|' + color;
    if (tintCache.has(key)) return tintCache.get(key);
    const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    const g = c.getContext('2d'); g.drawImage(src, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
    const tr = m ? parseInt(m[1], 16) : 200, tg = m ? parseInt(m[2], 16) : 60, tb = m ? parseInt(m[3], 16) : 60;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], gg = px[i + 1], b = px[i + 2];
      const mn = Math.min(r, gg, b), mx = Math.max(r, gg, b);
      if (px[i + 3] > 40 && mn > 205 && mx - mn < 28) {          // белое/почти белое → командный цвет
        const l = mn / 255;                                       // сохранить светотень паруса
        px[i] = Math.round(tr * l); px[i + 1] = Math.round(tg * l); px[i + 2] = Math.round(tb * l);
      }
    }
    g.putImageData(d, 0, 0);
    tintCache.set(key, c);
    return c;
  }

  // ---------- заглушка ----------
  // Цветной полупрозрачный квадрат с подписью — чтобы было видно, ЧТО тут стоит, пока спрайта нет.
  function placeholder(ctx, x, y, w, h, color, label, k = 1) {
    ctx.save();
    ctx.globalAlpha *= 0.85;
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = Math.max(1, 1.5 * k);
    ctx.setLineDash([Math.max(3, 5 * k), Math.max(2, 3 * k)]);
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - w / 2, y - h / 2, w, h, 4 * k) : ctx.rect(x - w / 2, y - h / 2, w, h);
    ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
    if (label) {
      const fs = Math.max(9, Math.min(h * 0.5, 13 * k));
      ctx.font = `bold ${fs}px Neucha, cursive`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = Math.max(2, fs * 0.25); ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineJoin = 'round';
      ctx.strokeText(label, x, y); ctx.fillStyle = '#fff'; ctx.fillText(label, x, y);
      ctx.textBaseline = 'alphabetic';
    }
    ctx.restore();
  }

  // ---------- вода ----------
  let waterPat = null, waterPatSrc = null;
  const WATER_TILE = 400;                    // мировых единиц на один тайл (1600×1200 → 4×3 тайла)
  function water(ctx, w, h, sx, sy, k) {
    ctx.fillStyle = '#1b4f8a'; ctx.fillRect(0, 0, w, h);    // пока тайл не загрузился — ровная синь
    const img = get('water'); if (!img) return;
    if (waterPatSrc !== img) {
      // 2×2 с зеркалками: даже не идеально бесшовный тайл ложится без видимых стыков
      const q = document.createElement('canvas'); q.width = img.width * 2; q.height = img.height * 2;
      const g = q.getContext('2d');
      g.drawImage(img, 0, 0);
      g.save(); g.translate(img.width * 2, 0); g.scale(-1, 1); g.drawImage(img, 0, 0); g.restore();
      g.save(); g.translate(0, img.height * 2); g.scale(1, -1); g.drawImage(img, 0, 0); g.restore();
      g.save(); g.translate(img.width * 2, img.height * 2); g.scale(-1, -1); g.drawImage(img, 0, 0); g.restore();
      waterPat = ctx.createPattern(q, 'repeat'); waterPatSrc = img;
    }
    const s = (k * WATER_TILE) / img.width;
    if (waterPat.setTransform && window.DOMMatrix) waterPat.setTransform(new DOMMatrix().translate(sx(0), sy(0)).scale(s));
    ctx.fillStyle = waterPat; ctx.fillRect(0, 0, w, h);
    // лёгкая виньетка — глубина у краёв
    const R = Math.hypot(w, h) / 2;
    const vg = ctx.createRadialGradient(w / 2, h / 2, R * 0.5, w / 2, h / 2, R);
    vg.addColorStop(0, 'rgba(0,10,30,0)'); vg.addColorStop(1, 'rgba(0,10,30,.28)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  }
  // Клетка поверх воды: тонкая белёсая, каждая пятая чуть заметнее — привет тетради
  function grid(ctx, w, h, sx, sy, toMap, cell = 40) {
    const x0 = Math.floor(toMap(0, 0).x / cell) * cell, x1 = Math.ceil(toMap(w, h).x / cell) * cell;
    const y0 = Math.floor(toMap(0, 0).y / cell) * cell, y1 = Math.ceil(toMap(w, h).y / cell) * cell;
    for (const bold of [false, true]) {
      ctx.strokeStyle = bold ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.07)'; ctx.lineWidth = bold ? 1.2 : 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x += cell) if ((x % (cell * 5) === 0) === bold) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), h); }
      for (let y = y0; y <= y1; y += cell) if ((y % (cell * 5) === 0) === bold) { ctx.moveTo(0, sy(y)); ctx.lineTo(w, sy(y)); }
      ctx.stroke();
    }
  }

  // ---------- острова и базы ----------
  // Спрайт острова занимает ~85% кадра, а игровой радиус острова — это его «тело»: рисуем кадр
  // размером 2.4r, чтобы берег примерно совпал с полигоном сервера (по нему считаются спавн и лут).
  function island(ctx, X, Y, r, idx, k, alpha = 1) {
    const name = `island-${(idx % 4) + 1}`;
    const img = get(name) || (missing(name) ? (get('island-1') || get('island-2') || get('island-3')) : null);
    ctx.save(); ctx.globalAlpha *= alpha;
    if (img) { const S = r * 2.4; ctx.drawImage(img, X - S / 2, Y - S / 2, S, S); }
    else placeholder(ctx, X, Y, r * 1.7, r * 1.7, '#c9a86a', name, k);
    ctx.restore();
  }
  function base(ctx, X, Y, r, idx, alive, k) {
    const name = alive ? (idx % 2 ? 'base-island-b' : 'base-island-a') : 'base-island-ruined';
    const img = get(name);
    if (img) { const S = r * 2.3; ctx.drawImage(img, X - S / 2, Y - S / 2, S, S); }
    else placeholder(ctx, X, Y, r * 1.7, r * 1.7, alive ? '#b08850' : '#7a7468', name, k);
  }
  // Флаг цвета игрока над фортом (в спрайте флагов нет — нарочно)
  function flag(ctx, X, Y, R, color, flutter = 0) {
    const fh = R * 0.5;
    ctx.save();
    ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1.5, R * 0.035); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X, Y - fh); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X, Y - fh);
    ctx.lineTo(X + R * (0.3 - 0.03 * Math.abs(flutter)), Y - fh + R * (0.1 + 0.04 * flutter));
    ctx.lineTo(X, Y - fh + R * 0.2); ctx.closePath();
    ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = INK; ctx.lineWidth = Math.max(0.8, R * 0.015); ctx.stroke();
    ctx.restore();
  }
  // Постройка/клад поверх острова: спрайт по имени или заглушка с подписью
  function marker(ctx, X, Y, size, name, label, color, k) {
    const img = get(name);
    if (img) ctx.drawImage(img, X - size / 2, Y - size / 2, size, size);
    else placeholder(ctx, X, Y, size, size * 0.7, color, label, k);
  }

  // ---------- корабли ----------
  // В локальных координатах судна (нос по +x). Спрайт 2:1 с носом вправо; нет — заглушка цвета игрока.
  const shipSprite = (type, isPirate, boss) => (isPirate ? (boss ? 'ship-pirate-boss' : 'ship-pirate') : `ship-${type}`);
  const hasShip = (type, isPirate, boss) => !!get(shipSprite(type, isPirate, boss));
  function ship(ctx, type, L, W, k, color, isPirate, boss, label) {
    const name = shipSprite(type, isPirate, boss);
    const img = isPirate ? get(name) : tinted(name, color);
    // тень на воде — от движка, спрайт без неё
    ctx.save(); ctx.globalAlpha *= 0.28; ctx.fillStyle = '#021126';
    ctx.beginPath(); ctx.ellipse(2 * k, 3 * k, L * 0.52, W * 0.62, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    if (img) { const H = L * (img.height / img.width); ctx.drawImage(img, -L / 2, -H / 2, L, H); return; }
    placeholder(ctx, 0, 0, L, Math.max(W * 1.6, 12 * k), isPirate ? '#1c1c22' : color, label, k);
    // носик, чтобы читалось направление
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.beginPath(); ctx.moveTo(L / 2 + 1, 0); ctx.lineTo(L / 2 - 6 * k, -4 * k); ctx.lineTo(L / 2 - 6 * k, 4 * k); ctx.closePath(); ctx.fill();
  }

  // ---------- рыбное место ----------
  function fishZone(ctx, X, Y, R, k) {
    ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(120,220,255,.10)'; ctx.fill();
    ctx.setLineDash([Math.max(4, 7 * k), Math.max(3, 6 * k)]);
    ctx.strokeStyle = 'rgba(200,240,255,.7)'; ctx.lineWidth = Math.max(1, 1.6 * k); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ---------- подписи на тёмной воде ----------
  // Белый текст с тёмной обводкой: font/textAlign задаёт вызывающий
  function text(ctx, str, x, y) {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(5,20,45,.75)';
    ctx.strokeText(str, x, y); ctx.fillStyle = '#ffffff'; ctx.fillText(str, x, y);
    ctx.restore();
  }

  return { SKINS, current, set, isSprites, get, tinted, placeholder, water, grid, island, base, flag, marker, ship, hasShip, fishZone, text,
    set onReady(fn) { onReady = fn; } };
})();
