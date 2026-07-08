// ⛈️ «ШТОРМ» — реалтайм-движок (бета).
//
// Никаких ходов: сервер тикает симуляцию (RT.TICK_MS), корабли непрерывно плывут к точке
// назначения (приказ «плыть» ставит ship.dest — см. applyAction в game.js), стрельба и ремонт
// работают по перезарядке (ship.cd), экономика капает по таймерам, ветер меняет скорость.
//
// Движок ПЕРЕИСПОЛЬЗУЕТ игровые кирпичи из game.js (пиратский ИИ, потопление, рыбные слоты,
// применение действий) — чтобы урон/награды/статы в реалтайме не разъезжались с пошаговой игрой.
// Всё реалтайм-состояние живёт в game.rt (обычный объект — переживает сохранение в БД).
import {
  SHIP_TYPES, PIRATE, PIRATE_MAX, PIRATE_MOVE_CHANCE, PIRATE_ENGAGE_MULT, MAP_EDGE_MARGIN,
  PORT_INCOME, PORT_NO_SHIP_INCOME_MULT, MORTAR_SHIPS, LOOT_REACH, FISH_ZONE_CAP,
  OUTPOST_LEVELS, OUTPOST_BUILD_REACH, RT_OUTPOST_MS, FISH_DRIFT_RT,
  RT, isRealtime, isDuel, isPeace, windMoveMult
} from './config.js';
import {
  applyAction, pushEvent, pushLog, logEvent, spawnPirate, sinkShip, pirateVolley,
  fishEarners, terrainBlocked, dist, applyOutpostPerks, driftFishZones, debugGold
} from './game.js';

const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Множитель скорости от ветра: по ветру до ×(1+WIND_STRENGTH), против — до ×(1−WIND_STRENGTH).
// Ветер ОБЩИЙ для всех режимов (game.wind, формула windMoveMult в config) — тут лишь удобная обёртка.
export function windMult(game, heading) {
  return windMoveMult(game.wind, heading);
}

// ─── Жизненный цикл: один интервал на игру ───────────────────────────────────
const loops = new Map(); // gameId -> interval

export function rtStop(gameId) {
  clearInterval(loops.get(gameId));
  loops.delete(gameId);
}

// hooks: { broadcast(game): Promise, save(game) } — рассылка/сохранение делает index.js
// (у движка нет доступа к сокетам и БД — он только крутит симуляцию).
export function rtStart(game, hooks) {
  if (!isRealtime(game) || game.status !== 'active' || loops.has(game.id)) return;
  const now = Date.now();
  const rt = (game.rt ??= {});
  rt.startedAt ??= now; // от него считается «разгон» ботов (см. botThink)
  game.wind ??= { ang: Math.random() * Math.PI * 2, str: 0.5, targetAng: null, targetStr: null }; // старые сейвы
  rt.windShiftAt ??= now + RT.WIND_MS;
  rt.nextIncome ??= now + RT.INCOME_MS;
  rt.nextFish ??= now + RT.FISH_MS;

  let last = Date.now();
  let busy = false; // тик асинхронный (рассылка) — не пускаем второй поверх первого
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const g = game; // игра живёт в памяти; ссылка стабильна (index.js держит games Map)
      const t = Date.now();
      const dt = Math.min(500, t - last); // после лага/деплоя не телепортируем на минуты вперёд
      last = t;

      if (g.status !== 'active') { // финал (порт разбит/сдались): последняя рассылка и стоп
        if (g.events?.length) g.eventSeq = (g.eventSeq || 0) + 1;
        await hooks.broadcast(g);
        g.events = [];
        hooks.save?.(g);
        rtStop(g.id);
        return;
      }

      // ⏸ пауза: мир заморожен — симуляцию не тикаем, только рассылаем состояние (лог/снятие паузы
      // доходят мгновенно и через action-рассылку, это подстраховка) и изредка сейвим.
      if (g.rt.paused) {
        if (t >= (rt.nextCast || 0)) {
          rt.nextCast = t + RT.BROADCAST_MS;
          if (g.events?.length) g.eventSeq = (g.eventSeq || 0) + 1;
          await hooks.broadcast(g);
          g.events = [];
        }
        if (t >= (rt.nextSave || 0)) { rt.nextSave = t + RT.SAVE_MS; hooks.save?.(g); }
        return;
      }

      tickWind(g, t, dt);
      tickMovement(g, dt);
      tickEconomy(g, t);
      tickOutposts(g, t);
      driftFishZones(g, FISH_DRIFT_RT * dt / 1000); // 🐟 рыба очень медленно мигрирует
      tickPirates(g, t);
      tickBots(g, t);

      // рассылка состояния (позиции клиент сглаживает сам): события пачкой — двигаем eventSeq,
      // чистим ТОЛЬКО после завершения рассылки (broadcast async — иначе события потерялись бы)
      if (t >= (rt.nextCast || 0)) {
        rt.nextCast = t + RT.BROADCAST_MS;
        if (g.events?.length) g.eventSeq = (g.eventSeq || 0) + 1;
        await hooks.broadcast(g);
        g.events = [];
      }
      if (t >= (rt.nextSave || 0)) { // в БД — редко (не каждый тик)
        rt.nextSave = t + RT.SAVE_MS;
        g.updatedAt = Date.now();
        hooks.save?.(g);
      }
    } catch (e) {
      console.error('rt tick:', e);
    } finally {
      busy = false;
    }
  }, RT.TICK_MS);
  loops.set(game.id, timer);
}

// ─── Ветер: плавно доворачивает к новой цели каждые ~WIND_MS (общий game.wind) ──
export function tickWind(game, now, dt) {
  const w = (game.wind ??= { ang: 0, str: 0.5, targetAng: null, targetStr: null });
  if (now >= (game.rt.windShiftAt || 0)) {
    game.rt.windShiftAt = now + RT.WIND_MS * (0.75 + Math.random() * 0.5);
    w.targetAng = Math.random() * Math.PI * 2;
    w.targetStr = 0.3 + Math.random() * 0.7;
    pushLog(game, '🌬 Ветер меняется…');
  }
  const maxTurn = RT.WIND_TURN * dt / 1000;
  w.ang = norm(w.ang + clamp(norm((w.targetAng ?? w.ang) - w.ang), -maxTurn, maxTurn));
  const maxStr = 0.15 * dt / 1000;
  w.str = clamp(w.str + clamp((w.targetStr ?? w.str) - w.str, -maxStr, maxStr), 0, 1);
}

// ─── Движение: корабли плывут к ship.dest ПО ТРАЕКТОРИИ ──────────────────────
// Курс доворачивает к цели с ограниченной скоростью (RT.TURN_RATE, рад/с), корабль всегда
// идёт ПО КУРСУ — получается дуга разворота. Это закрывает эксплойт «залп бортом → мгновенный
// флип → залп вторым»: перекладка на другой борт стоит реального времени (линкор ~5с).
// Прямо по курсу суша → доворачиваем на ближайший свободный угол (обход островов).
// Пираты плывут той же физикой (их мозг в tickPirates лишь ставит dest).
const shipStats = s => (s.owner === -1 ? PIRATE : SHIP_TYPES[s.type]);
// луч свободен, если чисто ВБЛИЗИ (первые метры — иначе при касательном заходе длинный луч
// «перескакивает» кромку, а шаг упирается), на полпути и в конце
const rayFree = (game, s, ang, look) =>
  !terrainBlocked(game, s.x + Math.cos(ang) * 10, s.y + Math.sin(ang) * 10) &&
  !terrainBlocked(game, s.x + Math.cos(ang) * look * 0.5, s.y + Math.sin(ang) * look * 0.5) &&
  !terrainBlocked(game, s.x + Math.cos(ang) * look, s.y + Math.sin(ang) * look);

export function tickMovement(game, dt) {
  for (const s of game.ships) {
    if (!s.dest) continue;
    const st = shipStats(s);
    if (!st) { delete s.dest; continue; }
    const d = dist(s.x, s.y, s.dest.x, s.dest.y);
    // приказ «в остров»: у берега ближе не подплыть — встали, ждём нового курса
    if (d < 60 && terrainBlocked(game, s.dest.x, s.dest.y)) { delete s.dest; continue; }
    let want = Math.atan2(s.dest.y - s.y, s.dest.x - s.x);
    if (typeof s.heading !== 'number') s.heading = want; // первый приказ в жизни — нос уже туда
    // ОБХОД СУШИ: смотрим вперёд; прямо земля → доворот в сторону обхода. Сторона ЛИПКАЯ
    // (s.avoid): выбрав, куда огибать остров, держимся её — иначе корабль мечется у берега.
    const cruise = (st.move / RT.MOVE_SECONDS) * windMult(game, s.heading);
    const look = Math.max(48, cruise * 1.2);
    if (!rayFree(game, s, want, look)) {
      s.avoidHold = 0;
      const side = s.avoid || 1;
      let free = null;
      for (const da of [0.45, 0.9, 1.35, 1.8, 2.2, 2.6]) {
        if (rayFree(game, s, want + side * da, look)) { free = want + side * da; s.avoid = side; break; }
        if (rayFree(game, s, want - side * da, look)) { free = want - side * da; s.avoid = -side; break; }
      }
      if (free == null) { delete s.dest; s.avoid = 0; continue; } // земля со всех сторон — отбой приказа
      want = free;
    } else if (s.avoid) {
      // прямой курс чист, но сторону обхода бросаем НЕ сразу (гистерезис ~0.7с):
      // у рваного берега «чисто» мигает, и корабль начинал метаться между сторонами
      s.avoidHold = (s.avoidHold || 0) + dt;
      if (s.avoidHold > 700) { s.avoid = 0; s.avoidHold = 0; }
    }
    // ТРАЕКТОРИЯ: доворот курса ≤ turnRate·dt; при развороте круче 90° ход падает (дуга, не пируэт)
    const turnRate = RT.TURN_RATE[s.owner === -1 ? 'pirate' : s.type] ?? RT.TURN_RATE.default;
    const maxTurn = turnRate * dt / 1000;
    s.heading = norm(s.heading + clamp(norm(want - s.heading), -maxTurn, maxTurn));
    const sharp = Math.abs(norm(want - s.heading)) > Math.PI / 2;
    const step = (st.move / RT.MOVE_SECONDS) * windMult(game, s.heading) * (sharp ? RT.TURN_SLOW : 1) * dt / 1000;
    if (d <= Math.max(step, 8)) { // дошли
      if (!terrainBlocked(game, s.dest.x, s.dest.y)) { s.x = s.dest.x; s.y = s.dest.y; }
      delete s.dest;
      s.stuck = 0;
      continue;
    }
    const nx = s.x + Math.cos(s.heading) * step, ny = s.y + Math.sin(s.heading) * step;
    if (terrainBlocked(game, nx, ny)) {
      // нос упёрся: стоим, курс доворачивает. Стоим дольше секунды — аварийный пивот на месте
      // (корабль и так без хода — разворот у берега выводит из «клина»). Совсем застрял — отбой.
      s.stuck = (s.stuck || 0) + dt;
      if (s.stuck > 1200) s.heading = want;
      if (s.stuck > 6000) { delete s.dest; s.stuck = 0; s.avoid = 0; }
      continue;
    }
    s.stuck = 0;
    s.x = nx; s.y = ny;
  }
}

// ─── Экономика: доход порта и пассивная рыбалка — по таймерам ────────────────
export function tickEconomy(game, now) {
  const rt = game.rt;
  if (now >= rt.nextIncome) {
    rt.nextIncome = now + RT.INCOME_MS;
    // в дуэли дохода нет (как и «за ход» в пошаговой) — золото только за пиратов
    if (!isDuel(game)) game.players.forEach((p, i) => {
      if (!p.alive) return;
      const hasShips = game.ships.some(s => s.owner === i);
      // как в пошаговом: порт без единого корабля приносит на 50% больше — легче встать на ноги
      const inc = hasShips ? PORT_INCOME : Math.round(PORT_INCOME * PORT_NO_SHIP_INCOME_MULT);
      p.gold += inc;
      debugGold(game, p, inc, hasShips ? 'доход порта' : 'доход порта (без флота, +50%)');
    });
  }
  if (now >= rt.nextFish) {
    rt.nextFish = now + RT.FISH_MS;
    for (const zone of game.map.fishZones || []) {
      for (const s of fishEarners(game, zone)) { // лимит слотов зоны — общий с пошаговым
        const p = game.players[s.owner];
        if (!p?.alive) continue;
        const inc = SHIP_TYPES[s.type].fishing;
        p.gold += inc;
        p.stats.goldCollected += inc;
        pushEvent(game, { type: 'gold', x: s.x, y: s.y, amount: inc });
        debugGold(game, p, inc, 'рыбалка');
      }
    }
  }
}

// ─── ⛺ Аванпосты: доход/ремонт/пушка форта — раз в RT_OUTPOST_MS (общая логика с пошаговым) ──
export function tickOutposts(game, now) {
  const rt = game.rt;
  if (now < (rt.nextOutpost || 0)) return;
  rt.nextOutpost = now + RT_OUTPOST_MS;
  for (let i = 0; i < game.players.length; i++) applyOutpostPerks(game, i);
}

// ─── Пираты: реалтайм-ИИ — пушка ПО ПЕРЕЗАРЯДКЕ, плавание непрерывное (как у всех) ──
// Дух пошагового pirateAct сохранён: реактивная агрессия (бьёт зашедших в радиус, сам не гоняется),
// босс добивает подранков, слабый отходит. Но выстрел взводит кулдаун RT.PIRATE_CD_MS, а движение —
// через pir.dest: скорость/развороты/обход островов считает общий tickMovement.
export function pirateThink(game, pir, now) {
  const all = game.ships.filter(s => s.owner >= 0 && game.players[s.owner]?.alive);
  if (!all.length) { pir.angryAt = null; return; }
  const m = game.map;
  const clampMap = (x, y) => ({
    x: Math.min(m.w - MAP_EDGE_MARGIN, Math.max(MAP_EDGE_MARGIN, Math.round(x))),
    y: Math.min(m.h - MAP_EDGE_MARGIN, Math.max(MAP_EDGE_MARGIN, Math.round(y)))
  });
  const nearest = list => list.reduce((a, b) => dist(pir.x, pir.y, a.x, a.y) < dist(pir.x, pir.y, b.x, b.y) ? a : b);
  const near = nearest(all);
  const engaged = all.some(s => {
    const st = SHIP_TYPES[s.type];
    return dist(pir.x, pir.y, s.x, s.y) <= Math.max(st.move, st.fireRange) * PIRATE_ENGAGE_MULT;
  });
  // суммарный урон, которым пирата достают прямо сейчас — для решения «драться или отходить»
  const incoming = all.filter(s => SHIP_TYPES[s.type].dmg > 0 && dist(pir.x, pir.y, s.x, s.y) <= SHIP_TYPES[s.type].fireRange)
    .reduce((sum, s) => sum + SHIP_TYPES[s.type].dmg, 0);

  // 🔫 цель в радиусе: добиваемый в приоритете; босс целит подранков; иначе слабейший
  const inRange = all.filter(s => dist(pir.x, pir.y, s.x, s.y) <= PIRATE.fireRange);
  const killable = inRange.filter(s => s.hp <= PIRATE.dmg);
  const wounded = inRange.filter(s => s.hp < SHIP_TYPES[s.type].hp);
  const target = killable.length ? killable.reduce((a, b) => (a.hp < b.hp ? b : a))
    : (pir.boss && wounded.length) ? wounded.reduce((a, b) => (a.hp < b.hp ? a : b))
    : inRange.length ? inRange.reduce((a, b) => (a.hp < b.hp ? a : b)) : null;
  const brave = !!target && (target.hp <= PIRATE.dmg || pir.boss || pir.hp > incoming);

  if (target && brave && now >= (pir.gunAt || 0)) { // залп строго по перезарядке
    pir.gunAt = now + RT.PIRATE_CD_MS * (0.85 + Math.random() * 0.3);
    pirateVolley(game, pir, target); // 💥 бортовой залп: разворот бортом + все игроки в секторе
    return; // отстрелялся — манёвр обдумает в следующее «размышление»
  }

  // 🧭 движение
  if (engaged) {
    if (target && brave) return; // цель на прицеле, ждём перезарядку — держим позицию
    if (pir.boss) {              // босс, завидев подранка вне радиуса, идёт добивать
      const prey = all.filter(s => s.hp < SHIP_TYPES[s.type].hp);
      if (prey.length) { const p = nearest(prey); pir.dest = clampMap(p.x, p.y); return; }
    }
    // не добить и опасно / достать некого — отходим от ближайшего (реактивная агрессия)
    const a = Math.atan2(pir.y - near.y, pir.x - near.x);
    pir.dest = clampMap(pir.x + Math.cos(a) * 150, pir.y + Math.sin(a) * 150);
  } else {
    pir.angryAt = null;
    if (!pir.dest && Math.random() < PIRATE_MOVE_CHANCE) { // свободный дрейф в окрестностях
      const a = Math.random() * Math.PI * 2;
      pir.dest = clampMap(pir.x + Math.cos(a) * (60 + Math.random() * 120), pir.y + Math.sin(a) * (60 + Math.random() * 120));
    }
  }
}

export function tickPirates(game, now) {
  const rt = game.rt;
  for (const pir of [...game.ships.filter(s => s.owner === -1)]) {
    if (now < (pir.rtNext || 0)) continue;
    pir.rtNext = now + RT.PIRATE_THINK_MS * (0.8 + Math.random() * 0.4);
    try { pirateThink(game, pir, now); } catch (e) { console.error('rt pirate:', e.message); }
  }
  // пополнение до штатных PIRATE_MAX (в реалтайме пираты не растворяются — живут, пока не потопят)
  if (now >= (rt.nextPirateRefill || 0)) {
    rt.nextPirateRefill = now + 10000;
    let guard = PIRATE_MAX + 2;
    while (game.ships.filter(s => s.owner === -1).length < PIRATE_MAX && guard-- > 0) {
      const before = game.ships.length;
      spawnPirate(game, false, true, 0);
      if (game.ships.length === before) break; // воды не нашлось — попробуем позже
    }
  }
}

// ─── Боты: простой реалтайм-мозг (раз в BOT_THINK_MS) ────────────────────────
// Все действия идут через applyAction — та же валидация/перезарядки, что у человека.
function tickBots(game, now) {
  const rt = game.rt;
  if (now < (rt.nextBot || 0)) return;
  rt.nextBot = now + RT.BOT_THINK_MS;
  for (let i = 0; i < game.players.length; i++) {
    const bot = game.players[i];
    if (!bot.isBot || !bot.alive) continue;
    try { botThink(game, i, now); } catch (e) { console.error('rt bot:', e.message); }
  }
}

export function botThink(game, bIdx, now) {
  const bot = game.players[bIdx];
  const mine = game.ships.filter(s => s.owner === bIdx);
  // 🕊 мирное время («Развитие»): игроки — не цели вовсе, бот качает экономику и бьёт пиратов
  const peace = isPeace(game);
  const foes = peace ? [] : game.ships.filter(s => s.owner >= 0 && s.owner !== bIdx && game.players[s.owner]?.alive);
  const pirates = game.ships.filter(s => s.owner === -1);
  // «РАЗГОН»: первые минуты бот не рашит чужую базу — строит экономику и держится своей половины.
  // Игрок успевает освоить реалтайм-управление. Длина разгона — по уровню бота.
  const aggroDelay = { easy: 180000, mid: 75000, hard: 20000 }[bot.botLevel || 'mid'] ?? 75000;
  const rushing = !peace && now - (game.rt.startedAt || 0) >= aggroDelay;
  const enemyPorts = peace ? [] : game.players
    .map((p, i) => (i !== bIdx && p.alive && game.map.bases[i] && !game.map.bases[i].noPort)
      ? { i, base: game.map.bases[i] } : null) // дуэль: базы-якоря без порта — не цель
    .filter(Boolean);
  const nearest = (from, list) => list.reduce((a, b) => dist(from.x, from.y, a.x, a.y) < dist(from.x, from.y, b.x, b.y) ? a : b);

  for (const s of mine) {
    const st = SHIP_TYPES[s.type];

    // СТРЕЛЬБА: залп по ближайшей цели в радиусе. Сектор/перезарядку проверит сама механика —
    // неудачная попытка ничего не стоит (бот не человек, промах интерфейсом не расстраивает).
    const targets = [...foes, ...pirates].filter(t => dist(s.x, s.y, t.x, t.y) <= st.fireRange);
    if (!st.repairer && st.dmg > 0 && targets.length) {
      const t = nearest(s, targets);
      applyAction(game, bot.id, { type: 'broadside', shipId: s.id, tx: t.x, ty: t.y });
    }
    // мортира тяжёлых: приоритет — вражеский порт в радиусе, иначе корабль.
    // На подходе к осаждаемому порту мортиру БЕРЕЖЁМ: не разряжаем в корабли, чтобы
    // не встать у стен с пустой мортирой на 14с перезарядки (осада — её работа).
    if (MORTAR_SHIPS.includes(s.type)) {
      const port = enemyPorts.find(p => dist(s.x, s.y, p.base.x, p.base.y) <= st.fireRange + p.base.radius * 0.5);
      const closingIn = rushing && enemyPorts.some(p => dist(s.x, s.y, p.base.x, p.base.y) <= st.fireRange * 2);
      if (port) applyAction(game, bot.id, { type: 'attack', shipId: s.id, targetType: 'port', targetId: port.i });
      else if (!closingIn && targets.length) applyAction(game, bot.id, { type: 'attack', shipId: s.id, targetType: 'ship', targetId: nearest(s, targets).id });
    }
    // ремонтник: чинит самого побитого в радиусе (и держится за флотом ниже)
    if (st.repairer) {
      const hurt = mine.filter(m => m.id !== s.id && m.hp < SHIP_TYPES[m.type].hp && dist(s.x, s.y, m.x, m.y) <= st.fireRange)
        .sort((a, b) => a.hp / SHIP_TYPES[a.type].hp - b.hp / SHIP_TYPES[b.type].hp);
      if (hurt.length) applyAction(game, bot.id, { type: 'repair', shipId: s.id, targetId: hurt[0].id });
    }

    // ДВИЖЕНИЕ — только если корабль стоит без приказа
    if (s.dest) continue;
    if (st.fishing > 0) {
      // баркас → БЛИЖАЙШАЯ зона со свободным местом (раньше .find() всегда брал ПЕРВУЮ зону
      // карты — в «Развитии» это зона первого игрока, и все боты пёрлись рыбачить к нему).
      // Свои уже плывущие туда рыбаки считаются занявшими место — в полную зону не ломимся,
      // а вставший в переполненную (не кормится) снимается и уходит в следующую.
      const inbound = z => mine.filter(m => m.id !== s.id && SHIP_TYPES[m.type].fishing > 0 &&
        m.dest && dist(m.dest.x, m.dest.y, z.x, z.y) <= z.radius).length;
      const zone = (game.map.fishZones || [])
        .slice().sort((a, b) => dist(s.x, s.y, a.x, a.y) - dist(s.x, s.y, b.x, b.y))
        .find(z => fishEarners(game, z).some(e => e.id === s.id) ||
                   fishEarners(game, z).length + inbound(z) < (z.cap || FISH_ZONE_CAP));
      if (zone && dist(s.x, s.y, zone.x, zone.y) > zone.radius * 0.5)
        applyAction(game, bot.id, { type: 'move', shipId: s.id, x: zone.x, y: zone.y });
    } else if (st.repairer) { // ремонтник держится за самым толстым боевым
      const guard = mine.filter(m => !SHIP_TYPES[m.type].repairer && SHIP_TYPES[m.type].dmg > 0)
        .sort((a, b) => SHIP_TYPES[b.type].hp - SHIP_TYPES[a.type].hp)[0];
      if (guard && dist(s.x, s.y, guard.x, guard.y) > st.fireRange * 0.8)
        applyAction(game, bot.id, { type: 'move', shipId: s.id, x: guard.x + 40, y: guard.y + 40 });
    } else if (st.dmg > 0) {
      // боевой: цель — ближайший вражеский корабль (нет — порт, нет — пират); заход ТАНГЕНЦИАЛЬНО,
      // чтобы к моменту сближения цель оказалась на траверзе (борт к врагу — залп готов).
      // На «разгоне» через карту не гоняемся: цели — только рядом (оборона) да пираты за наградой.
      const nearFoes = rushing ? foes : foes.filter(f => dist(s.x, s.y, f.x, f.y) <= st.fireRange * 2.5);
      const all = nearFoes.length ? nearFoes
        : (rushing && enemyPorts.length ? enemyPorts.map(p => p.base) : pirates);
      if (all.length) {
        const t = nearest(s, all);
        const d = dist(s.x, s.y, t.x, t.y);
        const fromT = Math.atan2(s.y - t.y, s.x - t.x); // направление от цели к нам
        if (d > st.fireRange * 0.95) {
          const side = (s.id.charCodeAt(1) % 2) ? 1 : -1; // стабильный выбор фланга кораблём
          applyAction(game, bot.id, {
            type: 'move', shipId: s.id,
            x: t.x + Math.cos(fromT + side * 0.9) * st.fireRange * 0.7,
            y: t.y + Math.sin(fromT + side * 0.9) * st.fireRange * 0.7
          });
        } else if (Math.random() < 0.35) { // на дистанции: подрабатываем галсом — держим цель на борту
          const side = Math.random() < 0.5 ? 1 : -1;
          applyAction(game, bot.id, {
            type: 'move', shipId: s.id,
            x: s.x + Math.cos(fromT + side * Math.PI / 2) * 70,
            y: s.y + Math.sin(fromT + side * Math.PI / 2) * 70
          });
        }
      }
    }
  }

  // ЛУТ: кто-то из своих стоит у нелутанного острова → собрать (сервер сам проверит дистанции)
  if (game.map.lootIslands?.some(i => !i.looted && mine.some(s => dist(s.x, s.y, i.x, i.y) <= i.radius + LOOT_REACH)))
    applyAction(game, bot.id, { type: 'collect' });

  // ⛺ АВАНПОСТЫ: первая постройка — кораблём у острова; апгрейд — без корабля (гарнизон сам).
  // Резерв небольшой (апгрейд окупается доходом) — с большим боты копили вечно и не качали ничего.
  (game.map.lootIslands || []).forEach((isl, ii) => {
    if (!isl.looted) return;
    if (isl.outpost && (isl.outpost.owner !== bIdx || isl.outpost.level >= OUTPOST_LEVELS.length)) return;
    const price = OUTPOST_LEVELS[(isl.outpost?.level || 0)].price;
    if (bot.gold < price + 120) return; // строим только с запасом — флот важнее
    if (isl.outpost) { applyAction(game, bot.id, { type: 'outpost', islandId: ii }); return; }
    const builder = mine.find(s => dist(s.x, s.y, isl.x, isl.y) <= isl.radius + OUTPOST_BUILD_REACH);
    if (builder) applyAction(game, bot.id, { type: 'outpost', shipId: builder.id, islandId: ii });
  });

  // ВЕРФЬ: заглядываем нечасто, флот держим в разумных рамках. Приоритеты:
  // 1) баркасы-кормильцы (без рыбалки экономика бота чахнет);
  // 2) мортирный корабль, если ни одного, — КОПИМ на фрегат, мелочь не берём
  //    (иначе, потеряв тяжёлых, бот вечно скупал шхуны и физически не мог добить порт);
  // 3) при крепком флоте и ждущем прокачки аванпосте — тоже копим (мелочь не объедает апгрейд);
  // 4) иначе обычная лесенка по золоту.
  if (now >= (rt_nextBuy(game, bIdx))) {
    game.rt['nextBuy' + bIdx] = now + RT.BOT_BUY_MS;
    if (mine.length < 8) {
      const fishers = mine.filter(m => SHIP_TYPES[m.type].fishing > 0).length;
      const wantFishers = Math.min(2, (game.map.fishZones || []).length);
      const hasMortar = mine.some(m => MORTAR_SHIPS.includes(m.type));
      const upWaiting = mine.length >= 6 && (game.map.lootIslands || []).some(i =>
        i.outpost && i.outpost.owner === bIdx && i.outpost.level < OUTPOST_LEVELS.length);
      let wish = null;
      if (fishers < wantFishers && bot.gold >= SHIP_TYPES.barkas.price + 60) wish = 'barkas';
      else if (!hasMortar) wish = bot.gold >= SHIP_TYPES.fregat.price ? 'fregat' : null;
      else if (!upWaiting) wish = bot.gold >= 500 && mine.length >= 3 ? 'linkor'
        : bot.gold >= 380 ? 'fregat'
        : bot.gold >= 220 ? 'brig'
        : bot.gold >= 110 ? 'shkhuna' : null;
      if (wish) applyAction(game, bot.id, { type: 'buy', ships: [wish] });
    }
  }
}
const rt_nextBuy = (game, bIdx) => game.rt['nextBuy' + bIdx] || 0;
