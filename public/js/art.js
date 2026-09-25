// «МАРКЕРНЫЙ» РЕНДЕР — рукописный стиль карты поверх тетрадной клетки.
//
// Идея: лист остаётся листом (клетка, бумага), а всё, что на нём нарисовано, выглядит как
// рисунок маркерами: полупрозрачная заливка (клетка просвечивает, как под фломастером),
// двойной чуть смещённый контур (маркер «наехал» на свою же линию), штриховка вместо плоской
// заливки, тень под предметом — и лёгкая «жизнь»: покачивание судов, дыхание мелководья вокруг
// островов, бегущие по воде ряби, рыба в рыбных местах, трепет флагов.
//
// Всё здесь — чистый визуал, состояние игры не трогает. Параметры — FX.art (fx-params.js):
//   enabled — маркерный стиль вообще; motion — «живая» анимация (при prefers-reduced-motion
//   выключается сама, во вкладке в фоне цикл не крутится).
//
// Координаты: функции получают уже ЭКРАННЫЕ точки (game.js переводит через sx/sy) и масштаб k
// (= view.scale), чтобы толщины штрихов росли вместе с зумом, но не тоньше читаемого.
window.SBArt = (() => {
  const INK = '#2b3a55';
  const WATER = '120,170,210';
  let t = 0;                      // секунды, ставит tick() раз за кадр
  const reduced = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  const P = () => (window.FX && window.FX.art) || { enabled: true, motion: true, grain: 1, waves: 1 };
  const flag = v => v === undefined ? true : !!v;   // из лаборатории приходит 0/1, из дефолтов — boolean
  const on = () => flag(P().enabled);
  // «живая» анимация: параметр + системная настройка + вкладка на виду
  const ambientOn = () => on() && flag(P().motion) && !reduced.matches && !document.hidden;

  // детерминированный шум 0..1 по целым (для стабильных «дрожащих» контуров и фаз)
  function hash(i, j = 0) {
    let h = (Math.imul(i | 0, 374761393) + Math.imul(j | 0, 668265263)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }
  // строковый id → число (фазы качки по id корабля)
  function seedOf(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  // ---------- маркерные штрихи ----------
  // Контур: два прохода — основной и полупрозрачный, чуть смещённый (маркер «наехал» на линию).
  function ink(ctx, path, { color = INK, width = 2, alpha = 0.9, dbl = true } = {}) {
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = color; ctx.lineWidth = width;
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * alpha;
    ctx.beginPath(); path(); ctx.stroke();
    if (dbl) {
      ctx.globalAlpha = a0 * alpha * 0.4;
      ctx.translate(width * 0.35, width * 0.3);
      ctx.lineWidth = width * 0.8;
      ctx.beginPath(); path(); ctx.stroke();
    }
    ctx.restore();
  }
  // Заливка фломастером: multiply — клетка листа просвечивает сквозь цвет
  function fill(ctx, path, color, alpha = 0.82) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = ctx.globalAlpha * alpha;
    ctx.fillStyle = color;
    ctx.beginPath(); path(); ctx.fill();
    ctx.restore();
  }
  // Тень под предметом: та же форма, смещена вправо-вниз, тёмная и прозрачная — даёт «отрыв» от листа.
  // Рисуем только СНАРУЖИ формы (клип «всё, кроме неё»): заливка сверху полупрозрачная, и тень
  // под ней делала предмет грязно-серым.
  function shadow(ctx, path, k, alpha = 0.16) {
    ctx.save();
    ctx.beginPath(); ctx.rect(-1e5, -1e5, 2e5, 2e5); path(); ctx.clip('evenodd');
    ctx.translate(2.2 * k, 3 * k);
    ctx.globalAlpha = ctx.globalAlpha * alpha;
    ctx.fillStyle = INK;
    ctx.beginPath(); path(); ctx.fill();
    ctx.restore();
  }
  // Штриховка внутри формы: параллельные штрихи под 45°, обрезаны по контуру
  function hatch(ctx, path, { color = `rgba(${WATER},.3)`, gap = 9, width = 1.2, angle = -Math.PI / 4, box } = {}) {
    ctx.save();
    ctx.beginPath(); path(); ctx.clip();
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
    const { x, y, w, h } = box;
    const cx = x + w / 2, cy = y + h / 2, R = Math.hypot(w, h) / 2 + gap;
    ctx.translate(cx, cy); ctx.rotate(angle);
    ctx.beginPath();
    for (let d = -R; d <= R; d += gap) { ctx.moveTo(-R, d); ctx.lineTo(R, d); }
    ctx.stroke();
    ctx.restore();
  }
  // Дрожащая окружность: радиус гуляет по seed-шуму — рукой ровно не нарисуешь
  function wobblyCircle(ctx, x, y, r, seed, amp = 0.035, n = 28) {
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      const j = i % n;
      const rr = r * (1 + (hash(seed, j) - 0.5) * 2 * amp);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }
  const polyPath = pts => () => { pts.forEach((p, i) => i ? ctx_.lineTo(p[0], p[1]) : ctx_.moveTo(p[0], p[1])); ctx_.closePath(); };
  let ctx_ = null; // текущий контекст для polyPath (модуль работает с одной канвой за раз)

  // ---------- бумага ----------
  let grain = null, grainKey = '';
  function grainPattern(ctx) {
    const dpr = window.devicePixelRatio || 1, key = 'g' + dpr;
    if (grain && grainKey === key) return grain;
    const S = 180, c = document.createElement('canvas');
    c.width = c.height = Math.round(S * dpr);
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    // крапинки бумажной массы
    for (let i = 0; i < 1000; i++) {
      const x = hash(i, 1) * S, y = hash(i, 2) * S, r = 0.3 + hash(i, 3) * 0.9;
      g.fillStyle = `rgba(110,90,50,${0.02 + hash(i, 4) * 0.045})`;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // волокна
    g.lineCap = 'round';
    for (let i = 0; i < 90; i++) {
      const x = hash(i, 5) * S, y = hash(i, 6) * S, a = hash(i, 7) * Math.PI, l = 4 + hash(i, 8) * 10;
      g.strokeStyle = `rgba(120,100,60,${0.03 + hash(i, 9) * 0.04})`; g.lineWidth = 0.6 + hash(i, 10) * 0.5;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
    }
    grain = ctx.createPattern(c, 'repeat');
    // паттерн в экранных пикселях: контекст игры уже умножен на dpr — сжимаем обратно
    if (grain.setTransform && window.DOMMatrix) grain.setTransform(new DOMMatrix().scale(1 / dpr));
    grainKey = key;
    return grain;
  }
  // Лист: цвет бумаги + зерно + лёгкая виньетка по краям (глубина, «лист лежит на столе»)
  function paper(ctx, w, h) {
    ctx.fillStyle = '#fdfbf3';
    ctx.fillRect(0, 0, w, h);
    if (!on()) return;
    if ((P().grain ?? 1) > 0) {
      ctx.save(); ctx.globalAlpha = P().grain ?? 1;
      ctx.fillStyle = grainPattern(ctx); ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
    const R = Math.hypot(w, h) / 2;
    const vg = ctx.createRadialGradient(w / 2, h / 2, R * 0.45, w / 2, h / 2, R);
    vg.addColorStop(0, 'rgba(70,55,30,0)'); vg.addColorStop(1, 'rgba(70,55,30,.10)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  }
  // Клетка: обычные линии + каждая пятая пожирнее (как на настоящей миллиметровке/тетради)
  function grid(ctx, w, h, sx, sy, toMap, cell = 40) {
    const x0 = Math.floor(toMap(0, 0).x / cell) * cell, x1 = Math.ceil(toMap(w, h).x / cell) * cell;
    const y0 = Math.floor(toMap(0, 0).y / cell) * cell, y1 = Math.ceil(toMap(w, h).y / cell) * cell;
    const bold = on();
    ctx.lineWidth = 1;
    ctx.strokeStyle = bold ? 'rgba(116,160,199,.30)' : 'rgba(116,160,199,.35)';
    ctx.beginPath();
    for (let x = x0; x <= x1; x += cell) { if (bold && x % (cell * 5) === 0) continue; ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), h); }
    for (let y = y0; y <= y1; y += cell) { if (bold && y % (cell * 5) === 0) continue; ctx.moveTo(0, sy(y)); ctx.lineTo(w, sy(y)); }
    ctx.stroke();
    if (!bold) return;
    ctx.strokeStyle = 'rgba(116,160,199,.50)'; ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += cell) if (x % (cell * 5) === 0) { ctx.moveTo(sx(x), 0); ctx.lineTo(sx(x), h); }
    for (let y = y0; y <= y1; y += cell) if (y % (cell * 5) === 0) { ctx.moveTo(0, sy(y)); ctx.lineTo(w, sy(y)); }
    ctx.stroke();
  }

  // ---------- вода ----------
  // Ряби: заранее раскиданные по карте «〰» (сид от размеров карты), подальше от островов и баз.
  // Каждая живёт в своей фазе: чуть дрейфует и мерцает. Рисуем только попавшие в кадр.
  let waves = null, wavesKey = '';
  function buildWaves(map) {
    const key = `${map.w}x${map.h}:${map.lootIslands?.length}:${map.bases?.length}:${map.fishZones?.length}`;
    if (waves && wavesKey === key) return waves;
    const out = [], n = Math.round((map.w * map.h) / (150 * 150) * (P().waves ?? 1));
    const far = (x, y) => {
      for (const b of map.bases || []) if (Math.hypot(x - b.x, y - b.y) < (b.radius || 0) + 70) return false;
      for (const o of map.lootIslands || []) if (Math.hypot(x - o.x, y - o.y) < o.radius + 45) return false;
      for (const z of map.fishZones || []) if (Math.hypot(x - z.x, y - z.y) < z.radius + 10) return false;
      return true;
    };
    for (let i = 0, guard = 0; out.length < n && guard < n * 6; guard++, i++) {
      const x = 20 + hash(i, 21) * (map.w - 40), y = 20 + hash(i, 22) * (map.h - 40);
      if (!far(x, y)) continue;
      out.push({ x, y, len: 18 + hash(i, 23) * 16, ph: hash(i, 24) * Math.PI * 2, sp: 0.6 + hash(i, 25) * 0.6 });
    }
    waves = out; wavesKey = key;
    return out;
  }
  function drawWaves(ctx, map, sx, sy, k, w, h) {
    if (!on() || (P().waves ?? 1) <= 0) return;
    const list = buildWaves(map), live = ambientOn();
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineWidth = Math.max(1, 1.3 * k);
    for (const wv of list) {
      const drift = live ? Math.sin(t * 0.35 * wv.sp + wv.ph) * 6 : 0;
      const X = sx(wv.x + drift), Y = sy(wv.y);
      const L = wv.len * k;
      if (X < -L || X > w + L || Y < -20 || Y > h + 20) continue;
      const a = 0.3 + (live ? Math.sin(t * 0.9 * wv.sp + wv.ph) * 0.14 : 0);
      ctx.strokeStyle = `rgba(90,150,200,${a.toFixed(3)})`;
      const hump = 2.2 * k;
      ctx.beginPath();
      ctx.moveTo(X - L / 2, Y);
      ctx.quadraticCurveTo(X - L / 3, Y - hump, X - L / 6, Y);
      ctx.quadraticCurveTo(X, Y + hump, X + L / 6, Y);
      ctx.quadraticCurveTo(X + L / 3, Y - hump, X + L / 2, Y);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- острова ----------
  // pts — ЭКРАННЫЕ точки контура [[x,y],...]; center — экранный центр; r — экранный радиус.
  // Мелководье (2 дрожащих кольца-контура, дышат), тень, заливка фломастером, штриховка-тень
  // у нижнего края, двойной контур.
  function island(ctx, pts, { cx, cy, r, sand = '#e8d9a8', edge = '#8a7a45', seed = 1, k = 1, shallow = true, alpha = 1 } = {}) {
    ctx_ = ctx;
    const path = polyPath(pts);
    if (!on()) { // плоский запасной вариант — как было
      ctx.beginPath(); path(); ctx.fillStyle = sand; ctx.fill(); ctx.strokeStyle = edge; ctx.lineWidth = 2; ctx.stroke();
      return;
    }
    const live = ambientOn();
    if (shallow) {
      for (let ring = 1; ring <= 2; ring++) {
        const breathe = live ? Math.sin(t * 0.8 + seed + ring) * 0.012 : 0;
        const f = 1 + (ring * 11 * k) / Math.max(r, 1) + breathe;
        const ringPts = pts.map(([x, y], i) => {
          const wob = 1 + (hash(seed * 7 + ring, i) - 0.5) * 0.05;
          return [cx + (x - cx) * f * wob, cy + (y - cy) * f * wob];
        });
        ink(ctx, polyPath(ringPts), { color: `rgba(${WATER},${ring === 1 ? 0.42 : 0.24})`, width: Math.max(1, 1.5 * k), alpha: 1, dbl: false });
      }
    }
    shadow(ctx, path, k, 0.18);
    fill(ctx, path, sand, 0.78 * alpha);
    // объём: полумесяц внутренней тени у юго-восточного берега — широкий штрих контура,
    // сдвинутый к северо-западу и обрезанный по острову (снаружи не видно)
    ctx.save();
    ctx.beginPath(); path(); ctx.clip();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha *= 0.13;
    ctx.strokeStyle = edge; ctx.lineWidth = r * 0.2; ctx.lineJoin = 'round';
    ctx.translate(-r * 0.09, -r * 0.09);
    ctx.beginPath(); path(); ctx.stroke();
    ctx.restore();
    // пара штрихов-«травинок» маркером на светлой стороне — рукописная фактура
    ctx.save();
    ctx.beginPath(); path(); ctx.clip();
    ctx.strokeStyle = edge; ctx.globalAlpha *= 0.35; ctx.lineCap = 'round'; ctx.lineWidth = Math.max(0.8, 1.1 * k);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const ax = cx + (hash(seed, 40 + i) - 0.7) * r * 0.9, ay = cy + (hash(seed, 50 + i) - 0.7) * r * 0.9, l = r * 0.16;
      ctx.moveTo(ax - l, ay + l * 0.4); ctx.lineTo(ax + l, ay - l * 0.4);
    }
    ctx.stroke();
    ctx.restore();
    ink(ctx, path, { color: edge, width: Math.max(1.2, 2.2 * k), alpha: 0.95 });
  }

  // ---------- корабли ----------
  // Качка: маленькая вертикальная и угловая, своя фаза у каждого судна. dy — в экранных пикселях.
  function bob(id, k) {
    if (!ambientOn()) return { dy: 0, rot: 0 };
    const s = seedOf(String(id)), ph = (s % 1000) / 1000 * Math.PI * 2, ph2 = ((s >> 10) % 1000) / 1000 * Math.PI * 2;
    return { dy: Math.sin(t * 1.3 + ph) * 1.1 * k, rot: Math.sin(t * 0.85 + ph2) * 0.03 };
  }
  // Рябь у борта стоящего судна: раз в ~3 с от корпуса расходится и тает одно дрожащее кольцо
  function ripple(ctx, X, Y, L, k, id) {
    if (!ambientOn()) return;
    const s = seedOf(String(id)), period = 2.6 + (s % 100) / 100, ph = ((t + (s % 1000) / 1000 * period) % period) / period;
    const r = L * (0.55 + ph * 0.5), a = (1 - ph) * 0.22;
    ctx.save();
    ctx.strokeStyle = `rgba(${WATER},${a.toFixed(3)})`; ctx.lineWidth = Math.max(0.8, 1.2 * k);
    ctx.beginPath(); wobblyCircle(ctx, X, Y, r, s, 0.05, 20); ctx.stroke();
    ctx.restore();
  }
  // Корпус (в локальных координатах судна: нос по +x). Тень → заливка → блик → контур → палуба.
  function hull(ctx, L, W, k, color, deck = '#e8d9a8', outline = INK) {
    const body = () => {
      ctx.moveTo(-L / 2, 0);
      ctx.quadraticCurveTo(-L / 2 + L * 0.12, -W / 2, 0, -W / 2);
      ctx.quadraticCurveTo(L / 2 - L * 0.06, -W / 2 + 2 * k, L / 2 + L * 0.11, 0);
      ctx.quadraticCurveTo(L / 2 - L * 0.06, W / 2 - 2 * k, 0, W / 2);
      ctx.quadraticCurveTo(-L / 2 + L * 0.12, W / 2, -L / 2, 0);
      ctx.closePath();
    };
    const deckP = () => {
      ctx.moveTo(-L / 2 + L * 0.09, 0);
      ctx.quadraticCurveTo(0, -W / 2 + W * 0.3, L / 2 - L * 0.03, 0);
      ctx.quadraticCurveTo(0, W / 2 - W * 0.3, -L / 2 + L * 0.09, 0);
      ctx.closePath();
    };
    if (!on()) {
      ctx.beginPath(); body(); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = outline; ctx.lineWidth = Math.max(0.8, 1.6 * k); ctx.stroke();
      ctx.beginPath(); deckP(); ctx.fillStyle = deck; ctx.fill(); ctx.lineWidth = Math.max(0.6, 1 * k); ctx.stroke();
      return;
    }
    shadow(ctx, body, k, 0.22);
    fill(ctx, body, color, 0.88);
    // блик маркера — светлая полоска вдоль борта (маркер прошёл не везде)
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,.32)'; ctx.lineWidth = Math.max(0.8, W * 0.16); ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-L * 0.3, -W * 0.28); ctx.lineTo(L * 0.28, -W * 0.22); ctx.stroke();
    ctx.restore();
    ink(ctx, body, { color: outline, width: Math.max(1, 1.9 * k), alpha: 0.95 });
    fill(ctx, deckP, deck, 0.95);
    ink(ctx, deckP, { color: outline, width: Math.max(0.6, 1 * k), alpha: 0.8, dbl: false });
  }

  // ---------- рыбные места ----------
  // Штриховка водой + дрожащее кольцо + три рыбки, что кружат внутри.
  function fishZone(ctx, X, Y, R, seed, k) {
    if (!on()) {
      ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.fillStyle = `rgba(${WATER},.16)`; ctx.fill();
      return false; // пусть game.js дорисует свой пунктир
    }
    const circ = () => wobblyCircle(ctx, X, Y, R, seed, 0.03);
    fill(ctx, circ, `rgb(${WATER})`, 0.09);
    hatch(ctx, circ, { color: `rgba(${WATER},.22)`, gap: Math.max(7, 13 * k), width: Math.max(0.8, 1.1 * k), box: { x: X - R, y: Y - R, w: 2 * R, h: 2 * R } });
    ink(ctx, circ, { color: 'rgba(80,130,180,.7)', width: Math.max(1, 1.6 * k), alpha: 1 });
    // рыбки
    const live = ambientOn(), n = 3;
    ctx.save();
    ctx.fillStyle = 'rgba(60,110,160,.72)';
    for (let i = 0; i < n; i++) {
      const a = (live ? t * 0.35 : 0) * (i % 2 ? -1 : 1) + i * 2.1 + seed;
      const rr = R * (0.45 + 0.18 * Math.sin(a * 1.7 + i));
      const fx = X + Math.cos(a) * rr, fy = Y + Math.sin(a) * rr, s = Math.max(4, 6.5 * k);
      const head = a + (i % 2 ? -1 : 1) * Math.PI / 2; // по касательной
      ctx.save(); ctx.translate(fx, fy); ctx.rotate(head);
      ctx.beginPath(); ctx.ellipse(0, 0, s, s * 0.45, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s * 0.8, 0); ctx.lineTo(-s * 1.5, -s * 0.5); ctx.lineTo(-s * 1.5, s * 0.5); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    return true;
  }

  // ---------- чайки ----------
  // Стайка из трёх «птичек-галочек» медленно пересекает карту по диагонали (цикл ~55 с), машет
  // крыльями. Чисто атмосфера: рисуется поверх всего, в туман не попадает — небо, а не море.
  function drawGulls(ctx, map, sx, sy, k, w, h) {
    if (!ambientOn()) return;
    const T = 55, ph = (t % T) / T, s = seedOf(`${map.w}x${map.h}`);
    const dir = (Math.floor(t / T) + s) % 2 ? -1 : 1;        // каждый пролёт — в другую сторону
    const x0 = dir > 0 ? -80 : map.w + 80, x1 = dir > 0 ? map.w + 80 : -80;
    const cx = x0 + (x1 - x0) * ph, cy = map.h * (0.25 + 0.5 * hash(s, Math.floor(t / T))) + Math.sin(t * 0.4) * 30;
    ctx.save();
    ctx.strokeStyle = 'rgba(43,58,85,.7)'; ctx.lineWidth = Math.max(1, 1.4 * k); ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const bx = sx(cx - dir * i * 26 + (i % 2) * 6), by = sy(cy + (i ? (i % 2 ? 14 : -12) : 0));
      if (bx < -30 || bx > w + 30 || by < -30 || by > h + 30) continue;
      const flap = Math.sin(t * 7 + i * 1.3) * 3.5 * k, ww = 7 * k;
      ctx.beginPath();
      ctx.moveTo(bx - ww, by - flap); ctx.quadraticCurveTo(bx - ww * 0.4, by + 1.5 * k, bx, by);
      ctx.quadraticCurveTo(bx + ww * 0.4, by + 1.5 * k, bx + ww, by - flap);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- мелочи ----------
  // Трепет флага: 0..1 фаза для смещения кончика
  const flutter = seed => ambientOn() ? Math.sin(t * 5 + seed) : 0;
  // Полоска HP в маркерном стиле: скруглённая, заливка фломастером, тонкий контур
  function bar(ctx, px, py, w, frac, color, h = 5) {
    const r = h / 2;
    const rr = (x, y, ww) => { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, ww, h, r) : ctx.rect(x, y, ww, h); };
    ctx.fillStyle = 'rgba(255,255,255,.8)'; rr(px - w / 2, py, w); ctx.fill();
    if (frac > 0) {
      ctx.save(); ctx.globalCompositeOperation = on() ? 'multiply' : 'source-over'; ctx.globalAlpha *= 0.9;
      ctx.fillStyle = color; rr(px - w / 2, py, Math.max(h, w * Math.min(1, frac))); ctx.fill(); ctx.restore();
    }
    ctx.strokeStyle = INK; ctx.lineWidth = 0.9; rr(px - w / 2, py, w); ctx.stroke();
  }

  function tick(nowMs) { t = nowMs / 1000; }

  return { on, ambientOn, tick, hash, ink, fill, shadow, hatch, wobblyCircle, paper, grid, drawWaves, drawGulls, island, bob, ripple, hull, fishZone, flutter, bar, get t() { return t; } };
})();
