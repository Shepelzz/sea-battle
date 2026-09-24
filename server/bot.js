// Бот: на своём ходу собирает все осмысленные действия, оценивает и берёт лучшее.
// Уровни: easy (Юнга) — шумные оценки и случайные ходы, mid (Боцман) — лучший ход,
// hard (Адмирал) — лучший ход + фокус раненых, удушение экономики, ранняя агрессия.
import { movesBudget, convoyCost, convoyMoveRange, CONVOY_MAX, CONVOY_PICK_MULT, shipRank, tributeFor, FISH_INCOME, FISH_ZONE_CAP, SHIP_TYPES, PIRATE, LOOT_REACH, PORT_RETURN_DMG, BROADSIDE_CANNONS, BROADSIDE_HALF_ARC, BROADSIDE_FALLOFF_MIN, BROADSIDE_SIDE_MIN, MORTAR_SHIPS, MORTAR_SHIP_MULT, OUTPOST_LEVELS, OUTPOST_BUILD_REACH, modeOf, isPeace, isDuel, cheapestShipPrice, windMoveMult,
  PERKS, perksEnabled, hasPerk, isPerkHidden, PORT_HP, DRYDOCK_RADIUS } from './config.js';
import { shipPlacementBlocked, shipInContact, applyAction, portMaxOf } from './game.js';

// ─── Шкала урона в ОЦЕНКАХ ───────────────────────────────────────────────────
// Урон флота утроили ради темпа партии (config.js, «Темп партии»), а веса эвристик ниже —
// сколько «очков» стоит огневая мощь против прочности, золота, дохода постройки — калиброваны
// на прежней шкале и мерились A/B-стендом (tools/ab-bot.mjs). Везде, где урон ВЗВЕШИВАЕТСЯ
// (оценка позиции, приоритеты целей и покупок), приводим его к старой шкале: после ×3 флот
// перевесил экономику, бот бросил покупать рыбаков и прокачивать аванпосты — тест поймал.
// Там, где урон СРАВНИВАЕТСЯ с HP (добьём ли, сколько выстрелов до порта), берём сырой.
const DMG_SCORE_SCALE = Number(process.env.BOT_DMG_SCALE ?? 3);   // BOT_DMG_SCALE — для A/B-стенда
const fp = dmg => dmg / DMG_SCORE_SCALE;   // огневая мощь в очках оценки

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// Вес «бить общую цель флота» (сосредоточенный огонь, см. focusTarget). Подбирается прогоном
// ab-bot.mjs, а не на глаз: 0 — каждый корабль снова воюет сам по себе.
const FOCUS_W = Number(process.env.BOT_FOCUS_W ?? 25);
// ⛵ Надбавка за КАЖДОЕ попутное судно в строю. Строй стоит один манёвр на всех, поэтому
// переброска пачкой втрое дешевле поштучной — но и жёстче: идут по медленному, в бою не собрать.
// Подбирается прогоном ab-bot.mjs; 0 — бот строем не пользуется. Замер (80/60 партий, hard):
// 4 → +5, 9 → +3, 18 → −2 побед. Жадный до строя бот таскает корабли, которым было чем заняться,
// поэтому надбавка держится НИЗКОЙ: строй берётся, только когда он заметно лучше одиночного хода.
const CONVOY_W = Number(process.env.BOT_CONVOY_W ?? 5);

// Имена ботов — КЛЮЧИ словаря: звание у бота переводится, и игрок должен видеть его
// на своём языке (текст — в public/locales/*.json, раздел bot.*).
export const BOT_NAMES = {
  easy: ['bot.easy.0', 'bot.easy.1', 'bot.easy.2'],
  mid: ['bot.mid.0', 'bot.mid.1', 'bot.mid.2'],
  hard: ['bot.hard.0', 'bot.hard.1', 'bot.hard.2']
};

// шаг к цели с объездом препятствий (как «по линейке»)
function findStep(game, ship, tx, ty) {
  const st = SHIP_TYPES[ship.type];
  const d = dist(ship.x, ship.y, tx, ty);
  if (d < 8) return null;
  const base = Math.atan2(ty - ship.y, tx - ship.x);
  for (const da of [0, 0.4, -0.4, 0.8, -0.8, 1.3, -1.3]) {
    // 🌬 дальность шага зависит от курса относительно ветра — тот же каплевидный контур, что у людей
    const step = Math.min(st.move * windMoveMult(game.wind, base + da) - 2, d);
    if (step < 6) continue; // в эту сторону против шквала почти не сдвинуться — пробуем другой угол
    const nx = Math.round(ship.x + Math.cos(base + da) * step);
    const ny = Math.round(ship.y + Math.sin(base + da) * step);
    if (!shipPlacementBlocked(game, nx, ny, ship.id)) return { x: nx, y: ny };
  }
  return null;
}

const nearest = (from, list, getXY) => {
  let best = null, bestD = Infinity;
  for (const item of list) {
    const [x, y] = getXY(item);
    const d = dist(from.x, from.y, x, y);
    if (d < bestD) { bestD = d; best = item; }
  }
  return best;
};

// Все возможные действия хода с их оценками. Вынесено отдельно, чтобы планировщик мог
// прогонять эту же оценку на КОПИИ партии и смотреть, что останется сделать следующим ходом.
function buildCandidates(game, pIdx, level) {
  const me = game.players[pIdx];
  const myShips = game.ships.filter(s => s.owner === pIdx);
  // режим «ход тремя судами»: корабль, уже сходивший в этом ходу, в этом ходу больше не действует.
  // Считаем его в общем контексте (он на доске — прикрывает, входит в «стаю»), но НЕ генерируем им
  // новых ходов/выстрелов/залпов. Покупка и сбор не привязаны к кораблю — остаются доступны.
  const acted = new Set(game.turn?.actedShips || []);
  const foeShips = game.ships.filter(s =>
    s.owner >= 0 && s.owner !== pIdx && game.players[s.owner]?.alive);
  const cands = [{ score: 1, action: { type: 'skip' } }];

  // затяжная партия — хватит копить, идём добивать
  const turnPressure = game.turn.number > game.players.length * 25;
  // сила игрока: HP + урон флота (единая метрика для всех сравнений)
  const powerOf = i => game.ships.filter(s => s.owner === i)
    .reduce((a, x) => a + x.hp + fp(SHIP_TYPES[x.type].dmg), 0);
  const myPower = powerOf(pIdx);
  const foePower = foeShips.reduce((s, x) => s + x.hp + fp(SHIP_TYPES[x.type].dmg), 0);

  // настоящие боевые корабли (рыбацкие баркасы не в счёт) — для прикрытия рыбалки и «стадности»
  const isFighter = s => SHIP_TYPES[s.type].dmg > 0 && !SHIP_TYPES[s.type].fishing;
  const myFighters = myShips.filter(isFighter);
  const foeFighters = foeShips.filter(isFighter);
  // есть ли вражеский боевик, достающий точку (x,y) огнём (+pad запас)
  const enemyAt = (x, y, pad = 80) => foeFighters.find(f =>
    dist(f.x, f.y, x, y) <= SHIP_TYPES[f.type].fireRange + pad);
  // мои кормящие рыбаки (стоят в зоне) и те из них, на кого насел враг
  const myFishersInZone = myShips.filter(s => SHIP_TYPES[s.type].fishing > 0 &&
    game.map.fishZones.some(z => dist(s.x, s.y, z.x, z.y) <= z.radius));
  const threatenedFishers = myFishersInZone.filter(s => enemyAt(s.x, s.y, 120));
  // сколько боевых соратников рядом — чтобы в атаку шли стаей, а не по одному
  const packmates = ship => myFighters.filter(o => o.id !== ship.id &&
    dist(o.x, o.y, ship.x, ship.y) < 260).length;

  // угроза базе: вражеские боевые корабли ВПЛОТНУЮ к моему порту (реальная осада,
  // а не далёкий разведчик — иначе бот панически обороняется и партия не двигается)
  const myBase = game.map.bases[pIdx];
  const threatR = myBase.radius + 240;
  const invaders = foeShips.filter(f =>
    SHIP_TYPES[f.type].dmg > 0 && dist(f.x, f.y, myBase.x, myBase.y) < threatR);
  const underSiege = invaders.length > 0 && level !== 'easy';

  // ── 🛡 МАСШТАБ ВТОРЖЕНИЯ ──────────────────────────────────────────────────
  // Важен не факт «кто-то приплыл», а СИЛА того, что идёт, за вычетом того, чем я уже прикрыт.
  // Один фрегат у пустого порта — купить равного и хватит. Два линкора на подходе — гнать домой
  // всё боевое и брать линкора, пока есть на что. Считаем и тех, кто ещё в переходе от базы:
  // среагировать нужно ЗАРАНЕЕ, а не когда они уже расстреливают порт.
  const homeReach = myBase.radius + 240;
  let homeThreat = 0, homeGuard = 0, worstAttacker = 0;
  for (const s2 of game.ships) {
    const sd = SHIP_TYPES[s2.type];
    if (!sd?.dmg || s2.owner < 0) continue;
    const d = dist(s2.x, s2.y, myBase.x, myBase.y);
    if (s2.owner === pIdx) { if (d < homeReach) homeGuard += fp(sd.dmg); continue; }
    if (!game.players[s2.owner]?.alive) continue;
    if (d < homeReach + sd.move) {                    // уже здесь или дойдёт следующим ходом
      homeThreat += fp(sd.dmg);
      worstAttacker = Math.max(worstAttacker, sd.dmg);   // сырой: сравнивается с dmg кандидата на покупку
    }
  }
  // Градуированная оборона (покупка защитника по рангу нападающего + массовый отзыв флота) —
  // умение «Адмирала». «Боцману» оставлен прежний простой перехват гостей у порта, иначе
  // уровни сравниваются по силе: замер показал 46–52% в дуэли hard против mid, то есть верхняя
  // ступень переставала быть верхней.
  const homeDeficit = level === 'hard' ? Math.max(0, homeThreat - homeGuard) : 0;
  // приоритет обороны растёт с дефицитом: одиночный налёт ≈50, флот вторжения ≈90 (выше осады)
  const defenceUrgency = homeDeficit ? Math.min(90, 30 + homeDeficit * 0.5) * DEFENCE_W : 0;

  // жертва — слабейший противник; решимость меряем с НИМ, а не с суммой всех
  const foes = game.players.map((p, i) => ({ p, i })).filter(x => x.i !== pIdx && x.p.alive);
  let victim = null;
  for (const x of foes) if (!victim || powerOf(x.i) < powerOf(victim.i)) victim = x;
  // режимы: дезматч → боты всегда агрессивны; развитие → мирный период (не трогаем игроков, развиваемся)
  const peace = isPeace(game);
  const aggressive = !peace && (modeOf(game).botAggro || turnPressure || foeShips.length === 0 ||
    (victim && myPower > powerOf(victim.i) * (level === 'hard' ? 1.1 : 1.3)));

  // --- 🎯 ЕДИНАЯ ЦЕЛЬ ФЛОТА (сосредоточенный огонь) ---
  // Раньше каждый корабль выбирал себе цель сам: флот царапал троих вместо того, чтобы добить
  // одного. Потопленный враг перестаёт стрелять, раненый стреляет в полную силу — размазывать
  // урон невыгодно. Договариваться кораблям не нужно: цель вычисляется ИЗ ДОСКИ по одной
  // формуле, поэтому все приходят к ней независимо и одновременно.
  // Приоритет: добиваемость (сколько уже снято) + опасность цели + враг у моего порога.
  const reachable = t => myFighters.some(s2 => !acted.has(s2.id) &&
    dist(s2.x, s2.y, t.x, t.y) <= SHIP_TYPES[s2.type].fireRange + SHIP_TYPES[s2.type].move);
  // Сосредоточенный огонь — умение «Адмирала». Замер: он стоит +30 побед, и это как раз та
  // разница, которой не хватало между верхней и средней ступенью (они сошлись в 50/50).
  // «Боцман» воюет как раньше: каждый корабль выбирает цель сам.
  let focusTarget = null, focusBest = 0;
  if (!peace && level === 'hard') for (const t of foeFighters) {
    if (!reachable(t)) continue;                       // до недосягаемого фокусироваться бессмысленно
    const def = SHIP_TYPES[t.type];
    const hurt = 1 - t.hp / (t.maxHp || def.hp);       // 0 — целёхонек, 1 — при смерти
    const v = hurt * 55 + fp(def.dmg) * 0.35 +
      (dist(t.x, t.y, myBase.x, myBase.y) < threatR ? 30 : 0);
    if (v > focusBest) { focusBest = v; focusTarget = t; }
  }
  const isFocus = t => !!focusTarget && t.id === focusTarget.id;

  // --- стрельба: 🎯 МОРТИРА (фрегат/линкор) по цели/порту + 💥 БОРТОВОЙ ЗАЛП (все боевые) ---
  const cx = game.map.w / 2, cy = game.map.h / 2, norm = a => Math.atan2(Math.sin(a), Math.cos(a));
  for (const ship of myShips) {
    if (acted.has(ship.id)) continue; // полностью отстрелялся
    const st = SHIP_TYPES[ship.type];
    const cannons = BROADSIDE_CANNONS[ship.type] || 0;
    const canMortar = MORTAR_SHIPS.includes(ship.type);
    if (!cannons && !canMortar) continue; // не боевой (баркас/ремонтник)
    const firedSides = game.turn.broadsideSides?.[ship.id] || []; // уже дал борт → можно только другой, мортиру нельзя
    const heading = (typeof ship.heading === 'number') ? ship.heading : Math.atan2(cy - ship.y, cx - ship.x);
    const portDir = norm(heading - Math.PI / 2), starDir = norm(heading + Math.PI / 2);

    // МОРТИРА — прицельный одиночный (только пока корабль не начал залп)
    if (canMortar && !firedSides.length) {
      for (const t of game.ships) {
        if (t.owner === pIdx) continue;
        if (t.owner >= 0 && peace) continue; // мир: игроков не трогаем (пиратов — можно)
        if (t.owner >= 0 && !game.players[t.owner]?.alive) continue;
        if (dist(ship.x, ship.y, t.x, t.y) > st.fireRange) continue;
        const tdef = t.owner === -1 ? PIRATE : SHIP_TYPES[t.type];
        const hit = st.dmg * MORTAR_SHIP_MULT; // мортира по судам бьёт вполовину
        const kills = t.hp <= hit;
        let score = hit * 0.8;
        if (kills) score += 30 + (t.owner === -1 ? t.bounty * 0.3 : SHIP_TYPES[t.type].price * 0.2);
        if (t.owner === -1 && !kills && level !== 'easy') {
          // Штраф «не трать осадный выстрел на НПС» глушил и ОТВЕТ на нападение: пират бил
          // корабль бота, а тот молча уплывал. Добивать подранка и отвечать обидчику — нужно.
          const angry = t.angryAt === pIdx;
          const hurt = 1 - t.hp / (t.maxHp || PIRATE.hp);
          score -= angry ? 4 : 15 * (1 - hurt);
        }
        if (level !== 'easy' && t.owner >= 0 && SHIP_TYPES[t.type].dmg > 0 && dist(t.x, t.y, myBase.x, myBase.y) < threatR) score += 35;
        if (level === 'hard') { if (t.owner !== -1 && SHIP_TYPES[t.type].fishing) score += 12; score += ((t.maxHp || tdef.hp) - t.hp) * 0.12; }
        if (isFocus(t)) score += FOCUS_W;              // добиваем то же, что и остальной флот
        cands.push({ score, action: { type: 'attack', shipId: ship.id, targetType: 'ship', targetId: t.id } });
      }
      game.players.forEach((p, i) => {
        if (i === pIdx || !p.alive || peace) return; // мир: базы не атакуем
        const base = game.map.bases[i];
        if (dist(ship.x, ship.y, base.x, base.y) <= st.fireRange + base.radius * 0.5) {
          const portDmg = st.dmg * (st.portBonus || 1);
          const destroys = p.portHp <= portDmg;
          const suicidal = !destroys && ship.hp <= PORT_RETURN_DMG;
          cands.push({ score: portDmg * 1.1 + (destroys ? 200 : 20) - (suicidal ? 60 : 0), action: { type: 'attack', shipId: ship.id, targetType: 'port', targetId: i } });
        }
      });
    }

    // 💥 БОРТОВОЙ ЗАЛП. Борт накрывает ВСЕ цели в секторе разом — значит и оценивать его надо по
    // всему, что он накроет. Раньше считалась одна лучшая цель, и залп по трём рыбацким баркасам
    // стоил ровно столько же, сколько по одному: бот исправно долбил их мортирой по очереди,
    // вместо того чтобы снести всех тремя пушками (живая жалоба из партии).
    // Борта считаем ПОРОЗНЬ: у них разные секторы, и лучший может оказаться не тот, где ближайшая цель.
    if (cannons && !peace) {
      for (const side of ['port', 'starboard']) {
        if (firedSides.includes(side)) continue;          // этот борт уже отстрелялся в этом ходу
        const sideDir = side === 'port' ? portDir : starDir;
        let score = 0, tgt = null, bestPick = -Infinity;
        for (const t of game.ships) {
          if (t.owner === pIdx) continue;
          if (t.owner >= 0 && !game.players[t.owner]?.alive) continue;
          const d = dist(ship.x, ship.y, t.x, t.y);
          if (d > st.fireRange) continue;
          const off = Math.abs(norm(Math.atan2(t.y - ship.y, t.x - ship.x) - sideDir));
          if (off > BROADSIDE_HALF_ARC) continue;         // не с этого борта (нос/корма)
          const def = t.owner === -1 ? PIRATE : SHIP_TYPES[t.type];
          // РЕАЛЬНЫЙ урон — ровно по серверной формуле: нужен, чтобы не проморгать потопление
          const real = Math.max(1, Math.round(st.dmg *
            (1 - (1 - BROADSIDE_SIDE_MIN) * Math.min(1, off / BROADSIDE_HALF_ARC)) *
            (1 - (1 - BROADSIDE_FALLOFF_MIN) * (d / st.fireRange))));
          // ВЕС урона в оценке — по «крутому» качеству наводки, а НЕ по реальному урону: флоры
          // (SIDE_MIN/FALLOFF_MIN) щадящие, и по ним бот начинал палить с края сектора и с предела
          // дистанции вместо осады (проверено раньше — капканы и паты). Залп даём, когда борт наведён.
          const aq = Math.max(0, 1 - off / BROADSIDE_HALF_ARC);   // 1 на перпендикуляре → 0 на краю сектора
          const dq = Math.max(0, 1 - d / st.fireRange);           // 1 в упор → 0 на краю радиуса
          const q = aq * dq;                                      // 1 — борт наведён в упор, 0 — мазня
          score += fp(st.dmg) * q * 2.0;
          // ПОТОПЛЕНИЕ считаем в полную силу: убитый убит, под каким бы углом ни прилетело.
          if (t.hp <= real) score += 30 + (t.owner === -1 ? (t.bounty || 0) * 0.3 : def.price * 0.2);
          // А вот приоритеты (общая цель флота, гость у порога) — ТОЛЬКО в меру наведённости:
          // иначе кривой выстрел на пределе дальности получал полный вес приоритета и выглядел
          // осмысленным ходом, хотя не наносит почти ничего.
          if (isFocus(t)) score += FOCUS_W * q;                   // бьём туда же, куда весь флот
          if (t.owner >= 0 && dist(t.x, t.y, myBase.x, myBase.y) < threatR) score += 35 * q; // гость у порога
          const pick = aq * 100 + (isFocus(t) ? FOCUS_W : 0);     // куда целиться (борт выбирает сервер по точке)
          if (pick > bestPick) { bestPick = pick; tgt = t; }
        }
        if (tgt) cands.push({ score, action: { type: 'broadside', shipId: ship.id, tx: tgt.x, ty: tgt.y } });
      }
    }
  }

  // --- сбор добычи (только клад с островов; рыбалка теперь капает пассивно) ---
  // считаем лишь клад, до которого дотянулись ЕЩЁ НЕ ходившие корабли — нельзя «походить кораблём,
  // а затем им же собрать» (иначе бот растрачивал ход впустую, а сервер всё равно отклонит).
  let gain = 0;
  for (const isl of game.map.lootIslands.filter(i => !i.looted)) {
    if (myShips.some(s => !acted.has(s.id) && dist(s.x, s.y, isl.x, isl.y) <= isl.radius + LOOT_REACH)) gain += isl.loot;
  }
  // сбор — рутина, а не стратегия: не должен перебивать манёвры и оборону
  if (gain > 0) {
    cands.push({
      score: Math.min(30, 8 + gain * 0.1) * (underSiege ? 0.5 : 1),
      action: { type: 'collect' }
    });
  }

  // --- ⛺ аванпост: стоим у залутанного острова и есть запас золота → построить/прокачать ---
  // экономика вдолгую (доход/дозор/ремонт/пушка), но флот и оборона важнее — скор умеренный
  game.map.lootIslands.forEach((isl, ii) => {
    if (!isl.looted) return;
    if (isl.outpost && (isl.outpost.owner !== pIdx || isl.outpost.level >= OUTPOST_LEVELS.length)) return;
    const price = OUTPOST_LEVELS[(isl.outpost?.level || 0)].price;
    if (me.gold < price + 120) return; // строим только с запасом на корабли (апгрейд окупается доходом)
    if (isl.outpost) { // апгрейд своего — гарнизон строит сам, корабль не нужен
      cands.push({ score: 17 * (underSiege ? 0.4 : 1), action: { type: 'outpost', islandId: ii } });
      return;
    }
    const builder = myShips.find(s => !acted.has(s.id) && dist(s.x, s.y, isl.x, isl.y) <= isl.radius + OUTPOST_BUILD_REACH);
    if (builder) cands.push({
      score: 20 * (underSiege ? 0.4 : 1), // первая постройка ценнее апгрейда (доход + дозор + ремонт на всю партию)
      action: { type: 'outpost', shipId: builder.id, islandId: ii }
    });
  });

  // --- 🎖 перки (в дуэли их нет) ---
  if (botPerksOn() && perksEnabled(game) && level !== 'easy') {
    const canBuy = key => {
      const def = PERKS[key];
      return def && !def.hidden && !hasPerk(game, pIdx, key) &&
        me.gold >= def.gold && (me.coins || 0) >= def.coins;
    };
    // 🔧 ПОРТУ ПЛОХО — чиним, и это перебивает почти любую другую покупку. Чем ближе к гибели,
    // тем выше приоритет: терять базу нельзя ни при каком раскладе.
    const hurt = 1 - me.portHp / portMaxOf(game);
    if (hurt > 0.4 && me.gold >= PERKS.portRepair.gold && (me.coins || 0) >= PERKS.portRepair.coins)
      cands.push({ score: 30 + hurt * 45, action: { type: 'buyPerk', key: 'portRepair' } });

    // 📦 склад — добавка идёт с каждого аванпоста, значит нужен хотя бы пара построек
    const myOutposts = (game.map.lootIslands || []).filter(i => i.outpost?.owner === pIdx).length;
    if (myOutposts >= 2 && canBuy('warehouse'))
      cands.push({ score: (12 + myOutposts * 4) * (underSiege ? 0.3 : 1), action: { type: 'buyPerk', key: 'warehouse' } });

    // ⚓ сухой док — когда у базы действительно стоят свои подбитые (иначе чинить нечего)
    const hurtAtHome = myShips.filter(s => dist(s.x, s.y, myBase.x, myBase.y) <= myBase.radius + DRYDOCK_RADIUS &&
      s.hp < SHIP_TYPES[s.type].hp * 0.8).length;
    if (hurtAtHome >= 2 && canBuy('drydock'))
      cands.push({ score: 12 + hurtAtHome * 3, action: { type: 'buyPerk', key: 'drydock' } });

    // 🐟 промысел — когда есть кому ловить
    if (myFishersInZone.length >= 2 && canBuy('fishery'))
      cands.push({ score: (8 + myFishersInZone.length * 3) * (underSiege ? 0.3 : 1), action: { type: 'buyPerk', key: 'fishery' } });
  }

  // --- верфь (флот не раздуваем — место у порта и здравый смысл) ---
  const fishers = myShips.filter(s => SHIP_TYPES[s.type].fishing > 0).length;
  if (myShips.length < 8) {
    if (level !== 'easy') {
      // Сколько ещё рыбаков реально прокормится: свободные места в БЕЗОПАСНЫХ зонах.
      // Жалоба с живой партии: 1300 золота, рядом рыбное место на четверых, а у бота одна
      // лодка — потому что покупка срабатывала только при «рыбаков ноль».
      const freeSlots = game.map.fishZones.reduce((a, z) => {
        if (enemyAt(z.x, z.y, 80)) return a;
        const cap = z.cap ?? FISH_ZONE_CAP;
        return a + Math.max(0, cap - game.ships.filter(s2 => dist(s2.x, s2.y, z.x, z.y) <= z.radius).length);
      }, 0);
      if (fishers < freeSlots && me.gold >= SHIP_TYPES.barkas.price + 60) {
        const score = underSiege ? 6 : (fishers === 0 ? 34 : 30 - fishers * 4);  // первый важнее всех
        cands.push({ score, action: { type: 'buy', ships: ['barkas'] } });
      }
      const pick = level === 'hard'
        ? (me.gold >= SHIP_TYPES.linkor.price ? 'linkor' : me.gold >= 380 ? 'fregat' : me.gold >= 220 ? 'brig' : null)
        : (me.gold >= 380 ? 'fregat' : me.gold >= 220 ? 'brig' : null);
      // Жалоба с живой партии: боту разбили флот, у него полная казна — а он ловит рыбу.
      // Виноват был гейт !turnPressure: в затяжной партии («хватит копить, идём добивать»)
      // покупка боевых кораблей отключалась совсем. Но без флота добивать нечем — поэтому
      // при пустой палубе отстраиваемся независимо ни от чего.
      const fleetWiped = myFighters.length < 2;
      if (pick && (underSiege || homeDeficit || fleetWiped || !turnPressure)) {
        // ОБОРОНА ПОКУПКОЙ: новый корабль появляется у СВОЕГО порта, то есть прямо против
        // вторжения. Берём не ниже рангом, чем сильнейший из идущих на нас (если по карману),
        // и тем охотнее, чем больше дефицит.
        let ships = [pick];
        if (homeDeficit) {
          const need = Object.entries(SHIP_TYPES)
            .filter(([, t]) => !t.cheat && !t.fishing && t.dmg >= worstAttacker && t.price <= me.gold)
            .sort((a, b) => a[1].price - b[1].price)[0];
          if (need) ships = [need[0]];
        }
        const score = homeDeficit ? defenceUrgency
          : underSiege ? 30 + Math.min(8, me.gold / 200)
          : fleetWiped ? 40 + Math.min(10, me.gold / 200)   // без флота восстановление — приоритет №1
          : (foePower >= myPower ? 26 : 14) + Math.min(8, me.gold / 200);
        cands.push({ score, action: { type: 'buy', ships } });
      }
    } else if (Math.random() < 0.4) {
      // Юнга покупает наугад, НО среди вариантов есть фрегат — иначе порт не пробить (мортира только у фрегата/линкора),
      // и партия не кончается. Фрегат с двойным весом, чтобы осадные суда всё же появлялись.
      const opts = [];
      if (me.gold >= SHIP_TYPES.fregat.price) opts.push('fregat', 'fregat');
      if (me.gold >= SHIP_TYPES.brig.price) opts.push('brig');
      if (me.gold >= SHIP_TYPES.shkhuna.price) opts.push('shkhuna');
      if (opts.length) cands.push({ score: 14, action: { type: 'buy', ships: [opts[Math.floor(Math.random() * opts.length)]] } });
    }
  }

  // --- движение ---
  const addMove = (ship, tx, ty, score) => {
    const pos = findStep(game, ship, tx, ty);
    if (pos) cands.push({ score, action: { type: 'move', shipId: ship.id, x: pos.x, y: pos.y } });
  };
  const isls = game.map.lootIslands.filter(i => !i.looted);

  for (const ship of myShips) {
    if (acted.has(ship.id) || game.turn.broadsideSides?.[ship.id]?.length) continue; // сходил/начал залп — ходить уже нельзя
    const st = SHIP_TYPES[ship.type];
    const cannons = BROADSIDE_CANNONS[ship.type] || 0; // есть ли бортовой залп (для захода бортом)

    // идёт ли этот корабль на штурм порта жертвы (тогда раненым не отступаем — добиваем)
    const vBase = victim && game.map.bases[victim.i];
    const sieging = aggressive && vBase &&
      dist(ship.x, ship.y, vBase.x, vBase.y) < st.fireRange + vBase.radius + st.move;

    // повреждённый — отступает от угрозы (но не во время решающего штурма)
    if (level !== 'easy' && ship.hp < st.hp * 0.35 && !sieging) {
      const threat = foeShips.find(f =>
        dist(f.x, f.y, ship.x, ship.y) < SHIP_TYPES[f.type].fireRange + 60);
      if (threat) {
        const ang = Math.atan2(ship.y - threat.y, ship.x - threat.x);
        addMove(ship, ship.x + Math.cos(ang) * st.move, ship.y + Math.sin(ang) * st.move, 23);
        continue;
      }
    }

    // рыбак плывёт в рыбное место и не воюет — но в БЕЗОПАСНОЕ (без вражеского боевика рядом),
    // а если на него уже насели и защитника нет — отходит к базе, чтобы не кормить собой врага.
    if (st.fishing > 0) {
      const curZone = game.map.fishZones.find(z => dist(ship.x, ship.y, z.x, z.y) <= z.radius);
      if (curZone) {
        if (enemyAt(ship.x, ship.y, 80) && !myFighters.some(f => dist(f.x, f.y, ship.x, ship.y) < 200))
          addMove(ship, myBase.x, myBase.y, 26); // удираем под защиту порта
        continue;                                 // иначе стоим и кормим
      }
      // МЕСТА В ЗОНЕ КОНЕЧНЫ: кормится только первые cap лодок (fishEarners в game.js), лишние
      // просто стоят балластом. Раньше бот слал рыбаков в ближайшую зону, не считая занятых
      // мест, и набивал одну зону, пока соседние пустовали.
      const freeIn = z2 => {
        const cap = z2.cap ?? FISH_ZONE_CAP;
        const busy = game.ships.filter(s2 => SHIP_TYPES[s2.type]?.fishing > 0 &&
          s2.id !== ship.id && dist(s2.x, s2.y, z2.x, z2.y) <= z2.radius).length;
        return cap - busy;
      };
      const open = game.map.fishZones.filter(z2 => freeIn(z2) > 0);
      const safe = open.filter(z2 => !enemyAt(z2.x, z2.y, 80));
      const z = nearest(ship, safe.length ? safe : open, zz => [zz.x, zz.y]);
      if (z) addMove(ship, z.x, z.y, safe.length ? 24 : 9);   // в опасную зону — без энтузиазма
      else addMove(ship, myBase.x, myBase.y, 8);              // мест нет нигде — не мешаемся под ногами
      continue;
    }

    // оборона: перехватываем гостей у своего порта — выше осады/лута/охоты,
    // боевые корабли идут домой бить захватчиков, а не «занимаются своим».
    if (underSiege && st.dmg > 0) {
      const inv = nearest(ship, invaders, f => [f.x, f.y]);
      if (inv) addMove(ship, inv.x, inv.y, 35);
    }
    // ОТЗЫВ ДОМОЙ. Если у порта дефицит обороны, всё боевое гребёт назад, и тем решительнее,
    // чем крупнее идущий флот: при серьёзном вторжении это перебивает даже осаду чужой базы.
    // Тяжёлые возвращаются охотнее — они и решают исход у своего порога.
    if (defenceUrgency && st.dmg > 0 && dist(ship.x, ship.y, myBase.x, myBase.y) > homeReach) {
      addMove(ship, myBase.x, myBase.y, defenceUrgency * (MORTAR_SHIPS.includes(ship.type) ? 1 : 0.85));
    }

    // ПРИКРЫТИЕ КОРМИЛИЦ: боевой корабль идёт бить врага, насевшего на наш кормящий баркас
    if (st.dmg > 0 && threatenedFishers.length) {
      const fz = nearest(ship, threatenedFishers, f => [f.x, f.y]);
      const enemy = nearest(ship,
        foeFighters.filter(f => dist(f.x, f.y, fz.x, fz.y) <= SHIP_TYPES[f.type].fireRange + 120),
        f => [f.x, f.y]);
      if (enemy) addMove(ship, enemy.x, enemy.y, 31); // чуть ниже обороны базы (35), выше лута/охоты
    }

    // ⛺ к залутанному острову под стройку. Без этого мотива аванпосты не строились ВООБЩЕ:
    // мотив «плыть к острову» работал только для НЕсобранных кладов, после сбора корабль
    // уплывал, и условие постройки «свой корабль вплотную + хватает золота» не совпадало ни
    // разу за партию (замер на 4 партиях: 0 аванпостов у всех уровней).
    // Условия нарочно жёсткие: A/B показал, что «строить при первой возможности» делает бота
    // СЛАБЕЕ (3 победы против 9) — отвлечённый корабль и потраченные 150 зол. стоят дороже,
    // чем +3 золота в ход за остаток партии. Поэтому: только с лишними деньгами, только
    // лишним кораблём (рыбак или когда боевых больше трёх) и только если остров по дороге.
    if (level !== 'easy' && me.gold >= OUTPOST_LEVELS[0].price + 450 && !underSiege &&
        (st.fishing > 0 || myFighters.length > 3)) {
      const free = game.map.lootIslands.filter(i => i.looted && !i.outpost);
      const spot = nearest(ship, free, ii => [ii.x, ii.y]);
      const d = spot ? dist(ship.x, ship.y, spot.x, spot.y) : Infinity;
      if (spot && d > spot.radius + OUTPOST_BUILD_REACH && d <= st.move * 2) {
        addMove(ship, spot.x, spot.y, 16 - Math.ceil(d / st.move) * 3); // ниже обороны (35) и прикрытия (31)
      }
    }

    // к ближайшему кладу — лут важнее бесконечной рыбалки
    const isl = nearest(ship, isls, ii => [ii.x, ii.y]);
    if (isl && dist(ship.x, ship.y, isl.x, isl.y) > isl.radius + LOOT_REACH) {
      const turns = Math.ceil(dist(ship.x, ship.y, isl.x, isl.y) / st.move);
      addMove(ship, isl.x, isl.y, Math.min(30, 12 + isl.loot * 0.06) - turns * 2);
    }

    // Охота на пирата с наградой (боевыми кораблями) — особенно за 👑-боссом.
    // Вес подняли: пираты теперь несут не только золото, но и 🪙 монеты, а на них покупаются
    // перки — значит гонять их стало объективно выгоднее, чем было.
    // ⚠ Но НЕ в ущерб обороне: пока к своему порту идут чужие боевые корабли, охота почти
    // обнуляется. Иначе бот уплывал за наградой, пока ему сносили базу.
    if (st.dmg > 0 && level !== 'easy') {
      const pirates = game.ships.filter(s => s.owner === -1);
      const prey = nearest(ship, pirates, pr => [pr.x, pr.y]);
      if (prey && dist(ship.x, ship.y, prey.x, prey.y) > st.fireRange) {
        const turns = Math.ceil(dist(ship.x, ship.y, prey.x, prey.y) / st.move);
        const hunt = Math.min(34, 12 + prey.bounty * 0.04) - turns * 2;
        addMove(ship, prey.x, prey.y, hunt * (underSiege ? 0.15 : 1));
      }
    }

    // «стадность»: со стаей боевых соратников рядом корабль идёт в наступление охотнее,
    // в одиночку — вяло (чтобы не скармливать корабли по одному). Множитель скромный (до ~1.5×).
    const pack = 1 + Math.min(3, packmates(ship)) * 0.17;

    // на сближение с флотом противника — только когда готовы драться, и охотнее в группе.
    // В мирный период («Развитие») к врагам/базам не лезем — развиваемся (сближение/осаду пропускаем).
    const foe = nearest(ship, foeShips, f => [f.x, f.y]);
    if (foe && !peace) {
      const eng = aggressive ? (level === 'hard' ? 18 : 14) : 7;
      const fd = dist(ship.x, ship.y, foe.x, foe.y);
      if (cannons && fd <= st.fireRange) {
        // враг в радиусе — ЗАХОД БОРТОМ по спирали (≈65°), чтобы он встал на борт и мы сближались к упору.
        // ВАЖНО: score = eng (НЕ выше осады) — иначе боты «танцуют» бортами в открытом море и не штурмуют порт → 70% патов.
        const dir = Math.atan2(foe.y - ship.y, foe.x - ship.x);
        for (const s of [1, -1]) {
          const a = dir + s * (Math.PI / 2) * 0.72;
          addMove(ship, ship.x + Math.cos(a) * st.move * 0.85, ship.y + Math.sin(a) * st.move * 0.85, eng);
        }
      } else {
        addMove(ship, foe.x, foe.y, eng * pack); // далеко — сближаемся (стаей охотнее)
      }
    }

    // осада порта жертвы. В режиме добивания осада ДОЛЖНА перебивать лут/охоту за
    // пиратами (иначе флот распыляется и порт не падает) — даём ей явный приоритет.
    if (victim && !peace) {
      const b = game.map.bases[victim.i];
      // РАЗДЕЛЕНИЕ РОЛЕЙ. Порт ломает только мортира (залп по базе бьёт ×0.12), причём линкор
      // вдвое эффективнее фрегата (portBonus) и легче переживает ответку. Поэтому к базе в
      // первую очередь тянем мортирщиков — тем охотнее, чем больнее они бьют по порту.
      // Остальные идут в БЛОКАДУ: порт сам не стреляет (PORT_DMG_TO_SHIPS=0), стоять у него
      // безопасно, а новые суда соперника выходят как раз оттуда — их и перехватываем.
      // (Запереть верфь нельзя: место для спавна ищется кольцами до самой воды. Но чем плотнее
      // блокада, тем дальше от базы вылупляется пополнение и тем позже доходит до боя.)
      const portDmg = MORTAR_SHIPS.includes(ship.type) || st.cheat ? st.dmg * (st.portBonus || 1) : 0;
      const siegeScore = portDmg
        ? Math.min(40, 14 + fp(portDmg) * 0.35)     // линкор ≈40, фрегат ≈29
        : Math.min(26, 10 + fp(st.dmg) * 0.35);     // бриг ≈20 — блокада, а не размен с портом
      addMove(ship, b.x, b.y, aggressive ? siegeScore * pack : 6);
    }
  }

  // ── ⛵ СТРОЙ: перегнать эскадру одним манёвром ────────────────────────────────
  // Конвой стоит ОДИН манёвр на весь строй (config.convoyCost), а не по манёвру за судно.
  // Значит переброска пачкой втрое дешевле поштучной — ровно то, что нужно, когда бой уехал
  // на другой конец карты, а подкрепление стоит у базы. Кандидаты строим ПОВЕРХ уже
  // насчитанных мотивов движения: берём лучший ход корабля и смотрим, кому из соседей по пути.
  if (game.config?.multiMove && CONVOY_W > 0) {
    const left = movesBudget(game.config) - (game.turn.moves || 0);
    const freeShips = myShips.filter(s2 => !acted.has(s2.id) && !game.turn.broadsideSides?.[s2.id]?.length);
    // лучший мотив движения для каждого корабля — из уже собранных кандидатов
    const bestMove = new Map();
    for (const c of cands) {
      if (c.action.type !== 'move') continue;
      const cur = bestMove.get(c.action.shipId);
      if (!cur || c.score > cur.score) bestMove.set(c.action.shipId, c);
    }
    const dirOf = (ship, c) => Math.atan2(c.action.y - ship.y, c.action.x - ship.x);
    // ведём строй от самых мотивированных — перебирать все корабли незачем, это только шум
    const leads = freeShips
      .filter(s2 => bestMove.has(s2.id))
      .sort((a2, b2) => bestMove.get(b2.id).score - bestMove.get(a2.id).score)
      .slice(0, 3);
    for (const lead of leads) {
      if (shipInContact(game, lead)) continue;          // в бою строй не собрать (сервер откажет)
      const leadBest = bestMove.get(lead.id);
      const dir = dirOf(lead, leadBest);
      const pickR = SHIP_TYPES[lead.type].move * CONVOY_PICK_MULT;
      // попутчики: рядом, свободны, и их собственный мотив смотрит примерно туда же
      // (иначе строй растащил бы рыбака с промысла или защитника от порта)
      const mates = freeShips
        .filter(s2 => s2.id !== lead.id && dist(lead.x, lead.y, s2.x, s2.y) <= pickR &&
          shipRank(s2.type) <= shipRank(lead.type))   // флагман не младше ведомых (см. config)
        .filter(s2 => {
          const mb = bestMove.get(s2.id);
          return !mb || Math.abs(norm(dirOf(s2, mb) - dir)) < 1.0;
        })
        .sort((a2, b2) => dist(lead.x, lead.y, a2.x, a2.y) - dist(lead.x, lead.y, b2.x, b2.y))
        .slice(0, CONVOY_MAX - 1);
      if (!mates.length) continue;
      for (let n = mates.length; n >= 1; n--) {         // не влез строй целиком — пробуем короче
        const crew = [lead, ...mates.slice(0, n)];
        if (convoyCost(crew.length) > left) continue;
        if (crew.some(s2 => shipInContact(game, s2))) continue;
        const slow = convoyMoveRange(crew.map(s2 => s2.type));   // по самому медленному +25%, как на сервере
        const want = dist(lead.x, lead.y, leadBest.action.x, leadBest.action.y);
        const ids = new Set(crew.map(s2 => s2.id));
        let step = null;
        for (const da of [0, 0.4, -0.4, 0.8, -0.8]) {   // упёрлись — пробуем чуть в сторону
          const len = Math.min(slow * windMoveMult(game.wind, dir + da) - 2, want);
          if (len < 12) continue;                       // такой строй почти не сдвинется — не ход
          const dx = Math.cos(dir + da) * len, dy = Math.sin(dir + da) * len;
          if (crew.every(s2 => !shipPlacementBlocked(game, Math.round(s2.x + dx), Math.round(s2.y + dy), ids))) {
            step = { x: Math.round(lead.x + dx), y: Math.round(lead.y + dy) };
            break;
          }
        }
        if (!step) continue;
        cands.push({
          score: leadBest.score + CONVOY_W * (crew.length - 1),
          action: { type: 'convoy', shipId: lead.id, ships: crew.slice(1).map(s2 => s2.id), x: step.x, y: step.y }
        });
        break;                                          // строй от этого флагмана найден
      }
    }
  }

  // 🐞 Разбор для отладки: то, что бот «держит в голове» — кого считает жертвой, по кому ведёт
  // сосредоточенный огонь и насколько прикрыт его порт. Идёт в консоль и в наложение на карту.
  cands.meta = {
    pIdx,
    focusId: focusTarget?.id || null,
    victimIdx: victim ? victim.i : null,
    homeThreat, homeGuard, defenceUrgency,
    homeReach, underSiege,
    vision: myShips.map(s2 => ({
      x: s2.x, y: s2.y,
      r: Math.max(SHIP_TYPES[s2.type].move, SHIP_TYPES[s2.type].fireRange) * 1.3
    }))
  };
  return cands;
}

// ═══════════════ 🎖 ПЕРКИ У БОТА ═══════════════
// Никакой общей теории ценности: бот берёт короткий список того, что для него однозначно
// полезно и не требует оценки плана на партию.
//   🔧 ремонт порта — когда порту плохо. Это важнее почти всего остального;
//   📦 склад        — когда аванпостов хотя бы пара (добавка идёт с КАЖДОГО);
//   ⚓ сухой док    — когда у базы стоят свои подбитые;
//   🐟 промысел     — когда есть кому ловить.
// Остальное бот сознательно не покупает: выгода там зависит от замысла на партию, а строить
// ему такую оценку — отдельная работа с длинными прогонами. Пробовал общую формулу «ценность
// минус цена» — она уводила бота в экономику и мешала воевать, поэтому откатил к списку.
//
// ⚠ Замер длины партий парный, на фиксированных зёрнах: одиночные прогоны тут бесполезны —
// одна и та же конфигурация без перков давала медиану от 318 до 506 ходов.
const botPerksOn = () => Number(process.env.BOT_PERKS ?? 1) !== 0;   // BOT_PERKS=0 — для A/B-замеров

// Вклад купленных перков в оценку позиции — ПЛОСКИЙ, по цене покупки. Нужен ровно для одного:
// чтобы планировщик не видел в покупке чистый убыток (минус золото) и не запрещал её. Считать
// здесь ситуативную ценность нельзя — пробовал: «верфь на потоке» делала дороже каждую монету
// в казне, бот переставал тратить и партии растягивались.
function perksValue(game, pIdx) {
  const owned = game.players[pIdx]?.perks;
  if (!owned) return 0;
  let v = 0;
  for (const k in owned) if (owned[k] && PERKS[k]) v += PERKS[k].gold * GOLD_W;
  return v;
}

// ═══════════════ 🧩 ПЛАНИРОВАНИЕ ХОДА (просмотр на действие вперёд) ═══════════════
// Первая попытка складывала эвристические ОЦЕНКИ действий («сделай это, потом лучшее из
// оставшегося») — и провалилась: −4 победы против +30 без планировщика. Причина в том, что
// приоритеты это не ценность. «Не стрелять» сохраняет лучший выстрел на следующее действие,
// и сумма приоритетов такое поощряет — бот начинал тянуть.
//
// Правильный способ: сравнивать не приоритеты, а ПОЗИЦИЮ. Кандидаты по-прежнему порождаются
// эвристикой (она отсекает бессмысленное), но ранжируются по тому, какой станет доска после
// действия — и после лучшего продолжения. Ценность считается с моей стороны: живучесть и
// огневая мощь флота, казна, прочность портов, аванпосты.
const PLAN_K = Number(process.env.BOT_PLAN_K ?? 5);            // «Адмирал»: сколько кандидатов проверять (0 — выключить)
// «Боцман» получает урезанный просмотр: замер показал, что без него средняя ступень почти не
// отличается от «Юнги» (55% побед), то есть выбор сложности между ними ничего не менял.
const PLAN_K_MID = Number(process.env.BOT_PLAN_K_MID ?? 3);
// «Юнга»: из скольких случайных вариантов он выбирает. Это и есть его сложность.
const EASY_SAMPLE = Number(process.env.BOT_EASY_SAMPLE ?? 6);
// Вес HP порта в оценке позиции (см. boardValue). Порт — условие победы, а не мешок HP.
const PORT_W = Number(process.env.BOT_PORT_W ?? 1);
// Вес чужой огневой мощи у МОЕГО порта в оценке позиции: без него бот замечал вторжение,
// только когда база уже сыпалась.
const HOME_THREAT_W = Number(process.env.BOT_HOME_THREAT_W ?? 2.5);
// Ценность «цель уже под бортом»: заставляет разворачиваться бортом вместо стрельбы мортирой
// вполовину силы. Слишком большой вес — боты «танцуют» и не штурмуют, поэтому подбирается замером.
const BROAD_READY_W = Number(process.env.BOT_BROAD_READY_W ?? 1);
// Курс «золото → ценность». Корабль в оценке весит hp + урон×2, то есть линкор за 500 золота
// даёт 410 — при курсе 0.25 покупка выглядела созданием ценности из воздуха, и бот сливал всю
// казну в самое крупное железо, игнорируя экономику. Реальный курс по прайсу ≈0.7–0.8.
const GOLD_W = Number(process.env.BOT_GOLD_W ?? 0.7);
// Общий множитель решимости обороняться (0 — не бросать осаду ради дома вовсе).
const DEFENCE_W = Number(process.env.BOT_DEFENCE_W ?? 1);
const PLAN_DISCOUNT = Number(process.env.BOT_PLAN_DISCOUNT ?? 0.7); // вес продолжения

export function boardValue(game, pIdx) {
  let v = 0;
  for (const s2 of game.ships) {
    const st = SHIP_TYPES[s2.type] || PIRATE;
    const w = s2.hp + fp(st.dmg) * 2;                          // живучесть + огневая мощь
    if (s2.owner === pIdx) { v += w; continue; }
    if (s2.owner >= 0) { if (game.players[s2.owner]?.alive) v -= w; continue; }
    // 🏴‍☠️ ПИРАТ. Раньше НПС не попадал в оценку совсем: урон по нему стоил ноль, и
    // планировщик не отвечал даже на прямое нападение — корабль молча терпел, а флот плыл
    // дальше. Теперь пират это и угроза, и ДЕНЬГИ: чем он слабее, тем ближе награда.
    const maxHp = s2.maxHp || PIRATE.hp;
    v -= s2.hp * 0.5;                                          // добивать выгодно
    v += (s2.bounty || 0) * 0.25 * (1 - s2.hp / maxHp);        // награда приближается с уроном
  }
  game.players.forEach((p, i) => {
    if (!p.alive) { v += i === pIdx ? -400 : 400; return; }     // выбывание решает партию
    // ПОРТ ВЕСИТ КАК КОРАБЛЬ. При весе 0.35 осада выходила убыточной по арифметике: выстрел
    // фрегата давал +14.7, а ответка порта снимала 25 HP с весом 1.0 — планировщик отказывался
    // от осады и водил флот кругами вокруг вражеского острова. Порт — это не «ещё немного HP»,
    // а условие победы: снёс — соперник выбывает и отдаёт половину казны.
    // Чем дольше тянется партия, тем дороже стоит ЧУЖОЙ порт: иначе бот бесконечно копит
    // экономику и «улучшает позицию», а партия не кончается (замер: 283 раунда, 45% упёрлись
    // в лимит). К середине партии осада должна перевешивать любой фарм.
    const late = 1 + (game.turn?.number || 0) / (game.players.length * 40);
    v += (i === pIdx ? 1 : -1) * p.portHp * PORT_W * (i === pIdx ? 1 : late);
    // Казна: своя — это будущий флот. Чужую по номиналу считать бессмысленно — у того, кто
    // уже не может обороняться, она обычно пуста; зато за снос его базы дают куш, зависящий
    // от РАЗВИТИЯ (tributeFor). Его и учитываем: чем жирнее жертва, тем ценнее её добить.
    v += i === pIdx ? p.gold * GOLD_W : tributeFor(game, i) * 0.25;
  });
  // Жалоба с живой партии: пока бот осаждал соперника, игрок подвёл корабли к ЕГО порту —
  // и бот не среагировал. Причина в том, что оценка видела только текущий portHp: пока база
  // цела, угрозы будто нет. Теперь чужая огневая мощь у моего порога вычитается сразу.
  const home = game.map.bases?.[pIdx];
  if (home && !home.noPort) {
    // Считаем НЕПОКРЫТУЮ угрозу: чужая огневая мощь у порога минус своя, которая там же стоит.
    // Так оценка не просто «боится» вторжения, а поощряет привести корабли домой — иначе
    // штраф одинаков, где бы мой флот ни находился, и планировщику нет смысла возвращаться.
    let threat = 0, guardv = 0;
    for (const s2 of game.ships) {
      const sd = SHIP_TYPES[s2.type];
      if (!sd?.dmg || s2.owner < 0) continue;
      if (Math.hypot(s2.x - home.x, s2.y - home.y) >= home.radius + 240) continue;
      if (s2.owner === pIdx) guardv += fp(sd.dmg);
      else if (game.players[s2.owner]?.alive) threat += fp(sd.dmg);
    }
    v -= Math.max(0, threat - guardv) * HOME_THREAT_W;
  }

  // ── ПОТЕНЦИАЛ: что станет доступно, если так встать ──
  // ВАЖНО: потенциал ЗАТУХАЕТ по ходу партии. Без этого замер дал 277 раундов при 46% партий,
  // упёршихся в лимит: бот бесконечно улучшал позицию и копил экономику вместо того, чтобы
  // добивать. К середине партии клады и рыбалка должны весить меньше, чем чужой порт.
  const pot = Math.max(0.25, 1 - (game.turn?.number || 0) / (game.players.length * 45));
  const myShips = game.ships.filter(s2 => s2.owner === pIdx);
  const near = (x, y) => {                     // 1 — рядом, 0 — на другом конце карты
    if (!myShips.length) return 0;
    const d = Math.min(...myShips.map(s2 => dist(s2.x, s2.y, x, y)));
    return Math.max(0, 1 - d / 900);
  };
  // 🏝 НЕЗАЛУТАННЫЙ КЛАД тянет к себе: чем ближе мой корабль, тем ценнее позиция
  for (const isl of game.map.lootIslands || [])
    if (!isl.looted) v += isl.loot * 0.25 * near(isl.x, isl.y) * 0.8 * pot;
  // 🐟 РЫБНОЕ МЕСТО: кормящийся баркас — доход навсегда, идущий к зоне — доход скоро
  for (const z of game.map.fishZones || []) {
    const cap = z.cap ?? FISH_ZONE_CAP;
    const crew = game.ships.filter(s2 => dist(s2.x, s2.y, z.x, z.y) <= z.radius);
    const mine = crew.filter(s2 => s2.owner === pIdx && SHIP_TYPES[s2.type]?.fishing > 0).length;
    v += Math.min(mine, cap) * FISH_INCOME * 9 * pot;
    const free = cap - crew.length;
    if (free > 0) {
      // рыбак ВНЕ зоны — это будущий доход: считаем его тем весомее, чем он ближе к воде с рыбой
      const idle = myShips.filter(s2 => SHIP_TYPES[s2.type]?.fishing > 0 &&
        dist(s2.x, s2.y, z.x, z.y) > z.radius);
      for (const f of idle.slice(0, free))
        v += FISH_INCOME * 6 * pot * Math.max(0.35, 1 - dist(f.x, f.y, z.x, z.y) / 900);
    }
  }
  // 💥 ГОТОВНОСТЬ БОРТА. Жалоба: «два линкора 1 на 1, я развернулся бортом и наваливаю, а он
  // стоит мордой и пуляет мортирой». Мортира по судам бьёт ВПОЛОВИНУ, борт — вдвое сильнее,
  // но развернуться выгодно лишь если оценка видит, ЧТО он сможет сделать после разворота.
  const norm2 = a => Math.atan2(Math.sin(a), Math.cos(a));
  for (const s2 of myShips) {
    const st = SHIP_TYPES[s2.type];
    const cannons = BROADSIDE_CANNONS[s2.type] || 0;
    if (!cannons || typeof s2.heading !== 'number') continue;
    for (const t of game.ships) {
      if (t.owner === pIdx) continue;
      if (t.owner >= 0 && !game.players[t.owner]?.alive) continue;
      const d = dist(s2.x, s2.y, t.x, t.y);
      if (d > st.fireRange) continue;
      const ang = Math.atan2(t.y - s2.y, t.x - s2.x);
      const off = Math.min(Math.abs(norm2(ang - norm2(s2.heading - Math.PI / 2))),
                           Math.abs(norm2(ang - norm2(s2.heading + Math.PI / 2))));
      if (off > BROADSIDE_HALF_ARC) continue;
      const q = (1 - off / BROADSIDE_HALF_ARC) * (1 - d / st.fireRange);
      v += fp(st.dmg) * q * BROAD_READY_W;     // цель под бортом в упор — позиция сама по себе ценна
    }
  }

  // 🎖 уже купленные перки — часть позиции. Без этого планировщик видел бы в покупке только
  // минус золота и не брал бы перки никогда (та же грабля, что когда-то с аванпостами).
  v += perksValue(game, pIdx);

  for (const isl of game.map.lootIslands || []) {
    if (!isl.outpost) continue;
    // Аванпост — это ПОТОК дохода, а не разовая трата: оцениваем его примерно в десять ходов
    // своего дохода плюс прочность. Без этого планировщик видел только списанное золото
    // (казна весит 0.25) и не строил вообще — тест это поймал.
    const def = OUTPOST_LEVELS[isl.outpost.level - 1] || OUTPOST_LEVELS[0];
    // доход на всю партию + перки: фактория чинит флот рядом, форт ещё и стреляет по врагу
    // Доход аванпоста идёт до конца партии, а партии тут длинные: считать его «за 10 ходов»
    // было вдвое заниженно — апгрейд выглядел тратой, и бот не прокачивал постройки вообще.
    // Перки тоже стоят денег: фактория чинит флот рядом, форт ещё и стреляет.
    const perks = (def.heal ? 80 : 0) + (def.gun ? def.gun * 8 : 0);
    v += (isl.outpost.owner === pIdx ? 1 : -1) * (def.income * 25 + perks + isl.outpost.hp * 0.1);
  }
  return v;
}

/**
 * Выбор хода бота.
 * @param log — необязательный приёмник отладки (см. SB_DEBUG): получает разбор решения —
 *   казну, флот, что выбрано и из чего выбиралось. Нужен, чтобы в игре было видно, ПОЧЕМУ
 *   бот сделал именно этот ход, а не гадать по последствиям.
 */
export function chooseBotAction(game, pIdx, level = 'mid', log = null) {
  if (isDuel(game)) return chooseDuelBotAction(game, pIdx, level); // дуэль — своя тактика (без баз/экономики/лута)
  const cands = buildCandidates(game, pIdx, level);

  // «ЮНГА»: раньше он в 70% ходов играл ПОЛНОЙ эвристикой, лишь с шумом в оценках — и потому
  // выигрывал у «Боцмана» 43% партий, то есть выбор сложности между ними почти ничего не менял.
  // Теперь он новичок по сути: видит не всю доску, а случайную горстку вариантов, и выбирает
  // лучшее из НЕЁ. Размер горстки — ручка сложности: 1 — чистый рандом, много — почти Боцман.
  if (level === 'easy') {
    const sample = [];
    const pool = cands.slice();
    for (let i = 0; i < EASY_SAMPLE && pool.length; i++)
      sample.push(...pool.splice(Math.floor(Math.random() * pool.length), 1));
    for (const c of sample) c.score *= 0.6 + Math.random() * 0.8; // и оценивает на глазок
    sample.sort((a, b) => b.score - a.score);
    return sample[0].action;
  }
  cands.sort((a, b) => b.score - a.score);

  // планируем только там, где есть что планировать: остался бюджет хода и уровень это позволяет
  const left = movesBudget(game.config) - (game.turn?.moves || 0);
  const k = level === 'hard' ? PLAN_K : level === 'mid' ? PLAN_K_MID : 0;
  const report = (chosen, planned) => {
    if (!log) return;
    try {
      log({
        pIdx, level, turn: game.turn?.number || 0,
        gold: game.players[pIdx].gold,
        fleet: game.ships.filter(s2 => s2.owner === pIdx).map(s2 => s2.type),
        chosen, planned,
        top: cands.slice(0, 5).map(c => ({ score: Math.round(c.score), action: c.action })),
        value: Math.round(boardValue(game, pIdx)),
        meta: cands.meta || null
      });
    } catch { /* отладка не должна ломать ход */ }
  };
  if (k < 2 || left < 2 || cands.length < 2) { report(cands[0], false); return cands[0].action; }

  const me = game.players[pIdx];
  let best = cands[0], bestTotal = -Infinity;
  for (const c of cands.slice(0, k)) {
    let total = -Infinity;
    try {
      const probe = structuredClone(game);
      if (applyAction(probe, me.id, c.action).ok) {
        total = boardValue(probe, pIdx);
        // осталось ещё действие — доигрываем лучшим продолжением и учитываем его со скидкой
        if (probe.status === 'active' && probe.turn.idx === pIdx) {
          const next = buildCandidates(probe, pIdx, level).sort((a, b) => b.score - a.score)[0];
          if (next) {
            const probe2 = structuredClone(probe);
            // ЗАМЕЧЕНО ПРИ ВВОДЕ СТРОЯ, НО НЕ ЧИНИТСЯ ЗДЕСЬ: если продолжение ЗАКРЫВАЕТ ход,
            // в доску прилетает чужая случайность (пополнение пиратов, доход соперника) и оценка
            // проседает независимо от качества хода — действия, занимающие сразу несколько судов
            // (⛵ строй), от этого страдают. Отсечка «считать продолжение, только пока ход наш»
            // пробовалась: строй бот берёт охотнее и A/B даёт +8 вместо +6 (обе цифры в шуме),
            // НО перестаёт прокачивать аванпосты — их окупаемость держится как раз на этом
            // просмотре. Менять — отдельной задачей с длинным прогоном, не заодно со строем.
            if (applyAction(probe2, me.id, next.action).ok)
              total += PLAN_DISCOUNT * (boardValue(probe2, pIdx) - total);
          }
        }
      }
    } catch { /* симуляция не удалась — этот кандидат просто не получает бонуса */ }
    if (total > bestTotal) { bestTotal = total; best = c; }
  }
  report(best, true);
  return best.action;
}

// ══════════════════════ ДУЭЛЬ ══════════════════════
// Закупка флота (фаза 'buy'): умный микс под бюджет, не один тип. Ядро — тяжёлые (линкор/фрегат:
// мортира + сильный борт), 1 ремонтник (кроме Юнги), добивка шхунами до полного расхода (остаток <
// цены шхуны). Возвращает список ключей кораблей для action buyFleet.
export function duelFleetPlan(game, pIdx, level = 'mid') {
  let budget = game.players[pIdx].gold;
  const P = t => SHIP_TYPES[t].price;
  const fleet = [];
  const buy = t => { if (budget >= P(t)) { fleet.push(t); budget -= P(t); return true; } return false; };
  if (level !== 'easy') buy('repair');                       // один ремонтник в поддержку
  // ядро: чередуем тяжёлые. hard — линкоры+фрегаты, иначе фрегаты+бриги (дешевле, манёвреннее).
  const heavy = level === 'hard' ? ['linkor', 'fregat', 'brig'] : ['fregat', 'brig', 'shkhuna'];
  let i = 0, guard = 0;
  while (budget >= P('brig') && guard++ < 60) { if (!buy(heavy[i % heavy.length])) break; i++; }
  // добиваем до полного расхода (правило «скупись на всё»): шхуны, пока хватает
  guard = 0;
  while (budget >= cheapestShipPrice(true) && guard++ < 200) {
    if (!buy('shkhuna') && !buy('brig')) break;
  }
  if (!fleet.length) buy('shkhuna'); // подстраховка (на случай крошечного бюджета)
  return fleet;
}

// Бой в дуэли: цель — уничтожить флот соперника (баз/экономики/лута нет). Фокус по самым «выгодным»
// вражеским судам (раненые + опасные), бортовой манёвр, ремонт раненых, отвод подбитых ценных кораблей,
// докупка за пиратское золото. Агрессия высокая — осады, которую можно «забыть», тут нет (≠ капкан классики).
function chooseDuelBotAction(game, pIdx, level) {
  const me = game.players[pIdx];
  const acted = new Set(game.turn?.actedShips || []);
  const myShips = game.ships.filter(s => s.owner === pIdx);
  const foeShips = game.ships.filter(s => s.owner >= 0 && s.owner !== pIdx && game.players[s.owner]?.alive);
  const pirates = game.ships.filter(s => s.owner === -1);
  const cands = [{ score: 1, action: { type: 'skip' } }];
  const cx = game.map.w / 2, cy = game.map.h / 2, norm = a => Math.atan2(Math.sin(a), Math.cos(a));
  const maxHp = t => t.maxHp || (t.owner === -1 ? PIRATE.hp : SHIP_TYPES[t.type].hp);
  const vuln = t => Math.max(0, maxHp(t) - t.hp);          // насколько ранен (добить выгодно)
  const worth = t => t.owner >= 0 ? fp(SHIP_TYPES[t.type].dmg) * 0.5 : (t.bounty || 0) * 0.04; // ценность цели

  // --- стрельба: мортира + бортовой залп по врагам/пиратам ---
  for (const ship of myShips) {
    if (acted.has(ship.id)) continue;
    const st = SHIP_TYPES[ship.type];
    const cannons = BROADSIDE_CANNONS[ship.type] || 0;
    const canMortar = MORTAR_SHIPS.includes(ship.type);
    if (!cannons && !canMortar) continue;
    const firedSides = game.turn.broadsideSides?.[ship.id] || [];
    const heading = (typeof ship.heading === 'number') ? ship.heading : Math.atan2(cy - ship.y, cx - ship.x);
    const portDir = norm(heading - Math.PI / 2), starDir = norm(heading + Math.PI / 2);

    if (canMortar && !firedSides.length) {
      for (const t of [...foeShips, ...pirates]) {
        if (dist(ship.x, ship.y, t.x, t.y) > st.fireRange) continue;
        const hit = st.dmg * MORTAR_SHIP_MULT, kills = t.hp <= hit;
        // Мортира по судам бьёт ВПОЛОВИНУ — это ДОБИВАНИЕ/фолбэк. Полный бортовой залп выгоднее (полный
        // урон, по всем целям с борта), поэтому не-добивающая мортира — низкий приоритет: пусть бот лучше
        // развернётся бортом и даст залп. Добивание (kills) — высокий приоритет (снять корабль с доски).
        let score = kills
          ? 46 + worth(t) + (t.owner === -1 ? (t.bounty || 0) * 0.25 : SHIP_TYPES[t.type].price * 0.22)
          : hit * 0.35 + vuln(t) * 0.1;
        if (t.owner === -1 && !kills) score -= 10;
        cands.push({ score, action: { type: 'attack', shipId: ship.id, targetType: 'ship', targetId: t.id } });
      }
    }
    if (cannons) {
      let tgt = null, side = null, bestD = Infinity, bestOff = 0;
      for (const t of [...foeShips, ...pirates]) {
        const d = dist(ship.x, ship.y, t.x, t.y);
        if (d > st.fireRange || d >= bestD) continue;
        const ang = Math.atan2(t.y - ship.y, t.x - ship.x);
        const offP = Math.abs(norm(ang - portDir)), offS = Math.abs(norm(ang - starDir));
        const sd = offP <= offS ? 'port' : 'starboard', off = Math.min(offP, offS);
        if (off > BROADSIDE_HALF_ARC || firedSides.includes(sd)) continue;
        tgt = t; side = sd; bestD = d; bestOff = off;
      }
      if (tgt) {
        const aq = Math.max(0, 1 - bestOff / BROADSIDE_HALF_ARC);
        const dq = Math.max(0, 1 - bestD / st.fireRange);
        // Цель уже в секторе борта — ДАЁМ ЗАЛП (база +40), а не доводим угол до идеала: иначе боты
        // «танцуют» бортами и не сходятся (стейлмейты). Манёвр — только когда стрелять НЕ по кому.
        const score = 40 + fp(st.dmg) * aq * dq * 2.2 + vuln(tgt) * 0.12;
        cands.push({ score, action: { type: 'broadside', shipId: ship.id, tx: tgt.x, ty: tgt.y } });
      }
    }
  }

  // --- ремонт: ремонтник латает самого раненого союзника в радиусе ---
  for (const ship of myShips) {
    if (acted.has(ship.id)) continue;
    const st = SHIP_TYPES[ship.type];
    if (!st.repairer || (ship.repairCharges ?? 0) <= 0) continue;
    let best = null, bestV = 0;
    for (const t of myShips) {
      if (t.id === ship.id) continue;
      const v = vuln(t);
      if (v > bestV && dist(ship.x, ship.y, t.x, t.y) <= st.fireRange) { bestV = v; best = t; }
    }
    if (best) cands.push({ score: 18 + bestV * 0.2, action: { type: 'repair', shipId: ship.id, targetId: best.id } });
  }

  // --- докупка за пиратское золото (середина боя) ---
  if (level !== 'easy' && me.gold >= SHIP_TYPES.fregat.price) {
    cands.push({ score: 21, action: { type: 'buy', ships: [me.gold >= SHIP_TYPES.linkor.price ? 'linkor' : 'fregat'] } });
  }

  // --- движение ---
  const addMove = (ship, tx, ty, score) => {
    const pos = findStep(game, ship, tx, ty);
    if (pos) cands.push({ score, action: { type: 'move', shipId: ship.id, x: pos.x, y: pos.y } });
  };
  for (const ship of myShips) {
    if (acted.has(ship.id) || game.turn.broadsideSides?.[ship.id]?.length) continue;
    const st = SHIP_TYPES[ship.type];
    const cannons = BROADSIDE_CANNONS[ship.type] || 0;

    // ремонтник идёт со стаей (к ближайшему боевому союзнику), чтобы быть в радиусе ремонта,
    // но к раненым — охотнее (их и латать). Сам в свалку не лезет (выстрелов у него нет).
    if (st.repairer) {
      const allies = myShips.filter(s => s.id !== ship.id && SHIP_TYPES[s.type].dmg > 0);
      const hurt = allies.filter(s => s.hp < SHIP_TYPES[s.type].hp * 0.85);
      const ally = nearest(ship, hurt.length ? hurt : allies, s => [s.x, s.y]);
      if (ally) addMove(ship, ally.x, ally.y, hurt.length ? 26 : 23); // идём с флотом (вровень со сближением)
      continue;
    }
    // подбитый ценный корабль отходит от ближайшего врага (сохранить флот, дать ремонт)
    if (level !== 'easy' && ship.hp < st.hp * 0.3 && st.price >= 220) {
      const threat = nearest(ship, foeShips, f => [f.x, f.y]);
      if (threat && dist(threat.x, threat.y, ship.x, ship.y) < SHIP_TYPES[threat.type].fireRange + 80) {
        const ang = Math.atan2(ship.y - threat.y, ship.x - threat.x);
        addMove(ship, ship.x + Math.cos(ang) * st.move, ship.y + Math.sin(ang) * st.move, 30);
        continue;
      }
    }
    // лучшая жертва: опаснее + раненее + ближе. Нет врагов рядом — добиваем пирата (золото на докупку).
    let target = null, bestSc = -Infinity;
    for (const t of foeShips) {
      const sc = worth(t) + vuln(t) * 0.3 - dist(ship.x, ship.y, t.x, t.y) * 0.02;
      if (sc > bestSc) { bestSc = sc; target = t; }
    }
    if (!target && pirates.length) target = nearest(ship, pirates, p => [p.x, p.y]);
    if (target) {
      const fd = dist(ship.x, ship.y, target.x, target.y);
      if (cannons && fd <= st.fireRange + st.move) {
        // ЗАХОД БОРТОМ: разворачиваемся, чтобы враг встал на ТРАВЕРЗ (≈90°) — тогда залп бьёт в полную силу.
        // Начинаем манёвр ещё на подходе (в пределах хода до радиуса), чтобы прийти бортом, а не носом.
        // Приоритет ВЫШЕ не-добивающей мортиры (борт выгоднее); тяжёлым важнее встать бортом (линкор ~46).
        const dir = Math.atan2(target.y - ship.y, target.x - ship.x);
        const turnScore = 24 + fp(st.dmg) * 0.1; // выше не-добивающей мортиры, но ниже залпа по цели в секторе
        for (const s of [1, -1]) {
          const a = dir + s * (Math.PI / 2) * 0.78;
          addMove(ship, ship.x + Math.cos(a) * st.move * 0.9, ship.y + Math.sin(a) * st.move * 0.9, turnScore);
        }
      } else {
        // далеко — сближаемся. У отставших чуть выше приоритет, чтобы флот шёл КУЧЕЙ, а не по одному на убой.
        addMove(ship, target.x, target.y, 22 + Math.min(8, fd * 0.006));
      }
    }
  }

  if (level === 'easy') {
    if (Math.random() < 0.3) return cands[Math.floor(Math.random() * cands.length)].action;
    for (const c of cands) c.score *= 0.7 + Math.random() * 0.6;
  }
  cands.sort((a, b) => b.score - a.score);
  return cands[0].action;
}
