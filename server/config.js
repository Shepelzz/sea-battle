// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ЕДИНЫЙ КОНФИГ ИГРЫ — здесь все числа и настройки баланса.                  ║
// ║  Меняешь баланс/карту/экономику/пиратов — только тут. Код читает отсюда.    ║
// ║  (Эвристические веса бота-ИИ живут в bot.js — это поведение, не баланс.)    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ─── Бой: БОРТОВОЙ ЗАЛП (основная атака боевых судов) ─────────────────────────
// УРОН ПО ЦЕЛИ = БАЗА КОРАБЛЯ (SHIP_TYPES[type].dmg) × angle × falloff. БАЗА = урон в ИДЕАЛЕ (враг строго на
// перпендикуляре борта, в упор). Множители только УМЕНЬШАЮТ его:
//   • angle  = от 1.0 (враг на перпендикуляре центра борта) до BROADSIDE_SIDE_MIN (на краю сектора);
//   • falloff= от 1.0 (в упор) до BROADSIDE_FALLOFF_MIN (на краю радиуса огня).
// ЧТОБЫ БИТЬ МАКСИМУМ — поворачивайся бортом ВПЛОТНУЮ к врагу (он должен быть ровно сбоку, не у носа/кормы).
// Эффективный урон залпа по классам (база → минимум при текущих множителях):
//   шхуна 15→5 · бриг 28→10 · фрегат 42→15 · ЛИНКОР 65→23.  (поднять урон → меняй .dmg корабля в SHIP_TYPES ниже)
// Сектор борта BROADSIDE_HALF_ARC (~46° в каждую сторону) — нос/корма не задеваются (для прямого выстрела есть мортира).
export const BROADSIDE_CANNONS = { shkhuna: 2, brig: 2, fregat: 3, linkor: 4, carrier: 6 }; // пушек на борт по классам (только для вида: трассеры/таблица флота)
export const BROADSIDE_HALF_ARC = 0.8;       // полу-угол сектора борта, рад (~46°)
export const BROADSIDE_FALLOFF_MIN = 0.6;    // доля урона на КРАЮ радиуса (в упор = 1.0). Выше → дальние выстрелы сильнее
export const BROADSIDE_SIDE_MIN = 0.6;       // доля урона на КРАЯХ сектора борта (на перпендикуляре = 1.0). Выше → косые выстрелы сильнее
export const BROADSIDE_PORT_MULT = 0.12;     // залп по вражескому ПОРТУ — символический урон (осада — мортирой)

// ─── Бой: МОРТИРА (прямой одиночный выстрел) — только тяжёлые ─────────────────
// Прямой выстрел по одной цели. Доступна ТОЛЬКО фрегату и линкору (+ чит-авианосцу). У остальных боевых атака — только залп.
// По СУДАМ мортира бьёт вполовину (MORTAR_SHIP_MULT) — её дело осада; по ПОРТАМ — на максимум (st.dmg × portBonus).
export const MORTAR_SHIPS = ['fregat', 'linkor'];
export const MORTAR_SHIP_MULT = 0.5;         // мортира по кораблям = половина урона судна (по крепостям — полный)

// ─── Ход несколькими судами («ход тремя судами») ─────────────────────────────
// Если включено при создании игры (game.config.multiMove) — за один ход игрок может
// сделать до MOVES_PER_TURN ДЕЙСТВИЙ: передвинуть/выстрелить РАЗНЫМИ кораблями (один
// корабль — не больше раза за ход), собрать добычу, сходить в верфь. Любое действие
// тратит один из трёх ходов. Выключено — классика: любое действие = конец хода.
export const MOVES_PER_TURN = 3;           // сколько действий можно сделать за ход
export const MULTI_MOVE_DEFAULT = true;    // дефолт чекбокса при создании игры
// бюджет ходов на текущий ход исходя из конфига партии
export const movesBudget = (cfg) => (cfg?.multiMove ? MOVES_PER_TURN : 1);
// действия, привязанные к конкретному кораблю (тратят ход кораблём, корабль помечается «сходившим»)
export const SHIP_ACTIONS = ['move', 'attack', 'broadside', 'repair', 'recharge'];

// ─── Тестовый режим (читы для отладки) ───────────────────────────────────────
// Глобальный выключатель. ВАЖНО: коды читов лежат ТОЛЬКО на сервере (server/cheats.js) —
// в клиент они не попадают (ни в исходники, ни в devtools). Тут — только вкл/выкл.
export const CHEATS_ENABLED = false;

// ─── Игровые режимы ───────────────────────────────────────────────────────────
// Выбираются при создании партии (game.config.mode). На СТАТЫ кораблей НЕ влияют —
// только стартовые условия / правила / поведение ботов. enabled — показывать ли в выборе
// (глобальная доступность режимов). Классика = поведение «как сейчас».
export const GAME_MODES = {
  classic:    { name: 'Классический', desc: 'Стандартные правила.', enabled: true },
  deathmatch: { name: 'Дезматч',      desc: 'Много золота на старте — сразу большой флот и мясо. Боты агрессивны.',
                enabled: true, startGold: 3500, botAggro: true },
  develop:    { name: 'Развитие',     desc: 'Мирные первые раунды: качай экономику и оборону, потом война. У каждой базы своя рыбозона.',
                enabled: true, peaceRounds: 10, peaceBaseKeepout: 427, baseFishZone: true, allFishZonesBig: true },
  duel:       { name: 'Дуэль',        desc: '1 на 1 (или против бота). Маленькая карта, без баз и островов: на старте скупись на весь флот и развали флот соперника. Дохода за ход нет — золото только за пиратов.',
                enabled: true, duel: true, startGold: 4000, maxPlayers: 2, mapScale: 0.7 },
};
export const DEFAULT_MODE = 'classic';
// доступные в выборе режимы (ключи), отфильтрованные по enabled
export const enabledModes = () => Object.keys(GAME_MODES).filter(k => GAME_MODES[k].enabled);
// настройки текущего режима партии
export const modeOf = (game) => GAME_MODES[game?.config?.mode] || GAME_MODES[DEFAULT_MODE];
// стартовое золото с учётом режима (классика/развитие → START_GOLD; дезматч/дуэль → свой startGold)
export const modeStartGold = (game) => modeOf(game).startGold ?? START_GOLD;
// режим «Дуэль»: 1на1 без баз/островов, стартовая закупка флота, победа по уничтожению флота
export const isDuel = (game) => !!modeOf(game).duel;
// цена самого дешёвого покупаемого корабля (для правила «скупись на всё»: остаток < этой суммы).
// В дуэли рыбацкий баркас не продаётся (рыбалки нет и воевать он не умеет) → самый дешёвый = шхуна.
export const cheapestShipPrice = (duel = false) =>
  Math.min(...Object.values(SHIP_TYPES).filter(s => !s.cheat && s.price > 0 && (!duel || !s.fishing)).map(s => s.price));
// длина мирного периода в РАУНДАХ (0 — мира нет)
export const modePeaceRounds = (game) => modeOf(game).peaceRounds || 0;
// идёт ли сейчас мирное время (раунд ≤ peaceRounds)
export const isPeace = (game) => (game?.turn?.round || 1) <= modePeaceRounds(game);

// ─── Рыбалка: доход ──────────────────────────────────────────────────────────
// Золота за ход баркасу, стоящему в рыбном месте (= SHIP_TYPES.barkas.fishing).
// fishing>0 ещё и помечает корабль «рыбаком». Лимит судов на зону — ниже (FISH_ZONE_CAP).
export const FISH_INCOME = 5;

// ─── Ремонтник: доля ремонта ──────────────────────────────────────────────────
// За одно действие ремонтник восстанавливает союзнику долю от ЕГО максимального HP
// (а не фикс — иначе мелкому кораблю это полное лечение, а линкору крохи). Округляется.
export const REPAIR_HEAL_FRAC = 0.15;
// Запас ремонта: ремонтник чинит ограниченное число раз, потом надо вернуться на базу и «Пополнить»
// материалы. Каждая починка = 1 заряд (независимо от того, какое судно чинишь). Жёлтая шкала из стольких делений.
export const REPAIR_CHARGES = 8;
export const REPAIR_DOCK_REACH = 60; // насколько близко к СВОЕЙ базе нужно подойти, чтобы пополнить материалы

// ─── Флот ─────────────────────────────────────────────────────────────────
// Расстояния — в игровых единицах (1 клетка = 40).
export const SHIP_TYPES = {
  barkas: {
    name: 'Рыбацкий баркас', icon: '⛵', price: 60,
    hp: 30, dmg: 5, fireRange: 70, move: 180,
    fishing: FISH_INCOME, // золота КАЖДЫЙ ХОД, пока стоит в рыбном месте (без траты действия)
    desc: `Стоит в рыбном месте — каждый ход сам приносит ${FISH_INCOME} золота, действие на это не тратится. Почти не вооружён.`
  },
  shkhuna: {
    name: 'Шхуна', icon: '🛥', price: 110,
    hp: 60, dmg: 15, fireRange: 110, move: 170, fishing: 0, // dmg = урон залпа в упор по перпендикуляру (макс)
    desc: 'Быстрая и дешёвая рабочая лошадка. Бьёт бортовым залпом (2 пушки на борт). Хороша для разведки и лута.'
  },
  brig: {
    name: 'Бриг', icon: '⚓', price: 220,
    hp: 110, dmg: 28, fireRange: 140, move: 135, fishing: 0,
    desc: 'Сбалансированный боевой корабль. Бортовой залп 3 пушки на борт.'
  },
  fregat: {
    name: 'Фрегат', icon: '🚢', price: 380,
    hp: 170, dmg: 42, fireRange: 165, move: 110, fishing: 0, // dmg = база урона: залп в упор по перпендикуляру И база мортиры (по судам ×0.5)
    desc: 'Тяжёлый корабль линии: бортовой залп 4 пушки + 🎯 мортира (прицельный выстрел, в т.ч. по порту).'
  },
  linkor: {
    name: 'Линкор', icon: '🛳', price: 500,
    hp: 280, dmg: 65, fireRange: 190, move: 90, fishing: 0, // dmg = база: залп в упор по перпендикуляру (65) И база мортиры
    portBonus: 1.5, // урон МОРТИРЫ по вражескому порту в 1.5 раза — главный осадный корабль (65×1.5≈98)
    desc: 'Король моря: залп 4 пушки на борт + 🎯 мортира по порту в 1.5× (≈98). Медленный, но почти непотопляемый.'
  },
  repair: {
    name: 'Ремонтник', icon: '🛟', price: 280,
    hp: 130, dmg: 0, fireRange: 115, move: 135, fishing: 0,
    // вместо стрельбы — РЕМОНТ: за ход чинит ОДИН союзный корабль в радиусе (fireRange) на долю
    // его МАКСИМАЛЬНОГО HP (healFrac), до его максимума, показывается жёлтым лучом. Сам НЕ атакует.
    repairer: true,
    healFrac: REPAIR_HEAL_FRAC,
    desc: 'Ремонтное судно. За ход либо плывёт, либо латает ОДИН свой корабль в радиусе — восстанавливает ≈15% его прочности (жёлтый луч). Размером и ходом как бриг, но сам не воюет — держи под прикрытием.'
  },
  // ⚙️ Чит-корабль (тестовый режим): спавнится секретным читом. cheat:true прячет его из
  //   верфи/вики/таблицы флота. volley:5 — стреляет пятью снарядами подряд (урон как у линкора).
  carrier: {
    name: 'Авианосец', icon: '🛩', price: 0, cheat: true,
    hp: 1400, dmg: 65, fireRange: 320, move: 280, fishing: 0, volley: 5,
    desc: 'Военный авианосец: скорострельная очередь из пяти снарядов, очень живуч и быстр. Тестовый корабль.'
  }
};

// ─── Старт ──────────────────────────────────────────────────────────────────
export const START_FLEET = ['shkhuna', 'shkhuna', 'fregat']; // пара шхун и фрегат
export const START_GOLD = 350;

// ─── Рыбалка ──────────────────────────────────────────────────────────────────
export const FISH_ZONE_CAP = 4;     // базовый лимит судов на рыбное место
export const FISH_ZONE_CAP_BIG = 5; // …у крупных зон — на 1 больше (порог: FISH_BIG_RADIUS, см. ниже)

// ─── Порт / база ──────────────────────────────────────────────────────────────
export const PORT_HP = 840;
export const PORT_RETURN_DMG = 25;          // порт огрызается по атакующему кораблю
export const PORT_RETURN_LINKOR_MULT = 1.2; // …линкору — на 20% больнее
export const PORT_INCOME = 6;               // доход порта в начале хода игрока
export const PORT_NO_SHIP_INCOME_MULT = 1.5; // у игрока без единого корабля — +50%
export const PORT_INCOME_TURN_FACTOR = 80;  // доход выключается после turn.number > players*80 («внезапная смерть»)
export const PORT_DMG_TO_SHIPS = 0;         // порт не стреляет сам — оборона флотом

// ─── Прочее боевое/добыча ───────────────────────────────────────────────────
export const SHIP_COLLISION_DIST = 26; // мин. дистанция между центрами кораблей
export const LOOT_REACH = 55;           // насколько корабль «дотягивается» до лут-острова/обломков
export const WRECK_LOOT_FRAC = 0.5;     // лут с обломков потопленного корабля (доля цены)
export const TRIBUTE_FRAC = 0.5;        // дань: доля казны выбитого игрока победителю

// ─── Расстановка купленных кораблей у базы (веер к центру карты) ──────────────
export const SPAWN_FAN_N = 14;        // секторов в кольце
export const SPAWN_FAN_RINGS = 5;     // колец перебора
export const SPAWN_FAN_R0 = 45;       // отступ первого кольца от края базы
export const SPAWN_FAN_RING_STEP = 34;// шаг между кольцами

// ─── Пираты (нейтральные NPC) ────────────────────────────────────────────────
export const PIRATE = {
  name: 'Пиратский корабль', icon: '🏴‍☠️', npc: true, price: 0,
  hp: 80, dmg: 12, fireRange: 130, move: 80, fishing: 0,
  desc: 'Нейтральный бродяга. Потопи его и забери награду. Но смотри — может дать сдачи.'
};
export const PIRATE_MAX = 2;               // сколько пиратов ВСЕГДА держим на карте (и потолок, и поддерживаемый минимум — пополняется гарантированно)
export const PIRATE_REVENGE_SHOT = 0.35;   // (легаси) шанс выстрела в обидчика за ход
export const PIRATE_FLEE_CHANCE = 0.5;     // (легаси) иначе — шанс удрать
export const PIRATE_CALM_CHANCE = 0.25;    // (легаси) шанс остыть и забыть обиду
export const PIRATE_DESPAWN_CHANCE = 0.08; // шанс раствориться в тумане за ход (на замену тут же спавнится новый в другом месте)
export const PIRATE_SPAWN_CHANCE = 0.16;   // (легаси) больше не используется: пополнение до PIRATE_MAX теперь гарантированное, не рандомное
export const PIRATE_MOVE_CHANCE = 0.75;    // шанс, что пират сдвинется за ход
export const PIRATE_BOSS_CHANCE = 0.14;    // шанс, что новый пират — «жирный» босс
export const PIRATE_BOSS_HP = 220;         // живучий босс
export const PIRATE_MIN_LIFETIME = 5;      // не исчезает раньше 5 ходов с появления
export const PIRATE_ENGAGE_MULT = 1.2;     // «вовлечён», если корабль в max(move,fireRange)*1.2
export const PIRATE_STEP_MIN = 35;         // мин. шаг дрейфа пирата за ход
// награда: (min + floor(rnd*rand)) * step
export const PIRATE_BOUNTY_MIN = 15, PIRATE_BOUNTY_RAND = 21, PIRATE_BOUNTY_STEP = 10;       // обычный: 150..350
export const PIRATE_BOSS_BOUNTY_MIN = 40, PIRATE_BOSS_BOUNTY_RAND = 41, PIRATE_BOSS_BOUNTY_STEP = 10; // босс: 400..800
// поиск водной точки спавна
export const PIRATE_WATER_MARGIN = 0.1;  // отступ от краёв (доля карты)
export const PIRATE_WATER_SPAN = 0.8;    // рабочая площадь (доля карты)
export const PIRATE_WATER_BASE_GAP = 280;// не спавнить ближе этого к базам

// ─── Карта ────────────────────────────────────────────────────────────────────
export const MAP_W = 1600, MAP_H = 1200;
export const MAP_EDGE_MARGIN = 12;  // нельзя ставить корабль ближе к краю
export const ISLAND_BLOCK_GAP = 14; // нельзя ставить корабль ближе к острову/базе
export const MAPGEN_GUARD = 400;    // предохранитель циклов размещения

export const BASE_CORNER_MARGIN = 200; // углы баз: margin от краёв
export const BASE_RADIUS = 105;
export const BASE_JITTER = 30;         // случайное смещение базы (±15)

export const LOOT_COUNT_EXTRA = 3;     // островов = playerCount + 3
export const LOOT_RADIUS_MIN = 30, LOOT_RADIUS_RAND = 18;
export const LOOT_AREA_X0 = 0.25, LOOT_AREA_XR = 0.5, LOOT_AREA_Y0 = 0.2, LOOT_AREA_YR = 0.6;
export const LOOT_BASE_GAP = 220, LOOT_GAP = 160;
export const LOOT_VALUE_MIN = 10, LOOT_VALUE_RAND = 21, LOOT_VALUE_STEP = 10; // 100..300

export const FISH_COUNT = 3;
export const FISH_RADIUS_MIN = 90, FISH_RADIUS_RAND = 30;
export const FISH_AREA_X0 = 0.18, FISH_AREA_XR = 0.64, FISH_AREA_Y0 = 0.15, FISH_AREA_YR = 0.7;
export const FISH_BASE_GAP = 120, FISH_LOOT_GAP = 40, FISH_GAP = 100;
export const FISH_MAX_RADIUS = FISH_RADIUS_MIN + FISH_RADIUS_RAND; // максимально возможный радиус зоны (120)
// крупной (5 слотов) считается зона не более чем на 15% меньше максимального радиуса → порог 102
export const FISH_BIG_RADIUS = Math.round(FISH_MAX_RADIUS * 0.85);
// лимит судов на конкретную зону: крупная (радиус ≥ порога) кормит FISH_ZONE_CAP_BIG, иначе FISH_ZONE_CAP
export const fishZoneCap = (radius) => (radius >= FISH_BIG_RADIUS ? FISH_ZONE_CAP_BIG : FISH_ZONE_CAP);

// форма острова (полигон для отрисовки)
export const ISLAND_SHAPE_MIN_PTS = 11, ISLAND_SHAPE_RAND_PTS = 4;
export const ISLAND_SHAPE_R_MIN = 0.72, ISLAND_SHAPE_R_RAND = 0.42;

// стартовая расстановка флота вокруг базы (в сторону центра)
export const START_SPAWN_SPREAD = 0.55; // угловой разброс между кораблями
export const START_SPAWN_RING = 55;     // отступ от края базы
