// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ЕДИНЫЙ КОНФИГ ИГРЫ — здесь все числа и настройки баланса.                  ║
// ║  Меняешь баланс/карту/экономику/пиратов — только тут. Код читает отсюда.    ║
// ║  (Эвристические веса бота-ИИ живут в bot.js — это поведение, не баланс.)    ║
// ╚══════════════════════════════════════════════════════════════════════════╝

// ─── Боевые флаги ───────────────────────────────────────────────────────────
export const BROADSIDE_ENABLED = false; // бортовой залп временно выключен (дисбаланс)
export const BROADSIDE_MULT = 0.8;       // залп бьёт каждую цель на 20% слабее обычного выстрела

// ─── Флот ─────────────────────────────────────────────────────────────────
// Расстояния — в игровых единицах (1 клетка = 40).
export const SHIP_TYPES = {
  barkas: {
    name: 'Рыбацкий баркас', icon: '⛵', price: 60,
    hp: 30, dmg: 5, fireRange: 70, move: 140,
    fishing: 4, // золота КАЖДЫЙ ХОД, пока стоит в рыбном месте (без траты действия)
    desc: 'Стоит в рыбном месте — каждый ход сам приносит 4 золота, действие на это не тратится. Почти не вооружён.'
  },
  shkhuna: {
    name: 'Шхуна', icon: '🛥', price: 110,
    hp: 60, dmg: 15, fireRange: 110, move: 170, fishing: 0,
    desc: 'Быстрая и дешёвая рабочая лошадка. Хороша для разведки и лута.'
  },
  brig: {
    name: 'Бриг', icon: '⚓', price: 220,
    hp: 110, dmg: 28, fireRange: 140, move: 135, fishing: 0,
    desc: 'Сбалансированный боевой корабль.'
  },
  fregat: {
    name: 'Фрегат', icon: '🚢', price: 380,
    hp: 170, dmg: 42, fireRange: 165, move: 110, fishing: 0,
    broadside: true, // умеет бортовой залп по всем целям в радиусе
    desc: 'Тяжёлый корабль линии. Бьёт больно и умеет бортовой залп 💥 по всем врагам в радиусе.'
  },
  linkor: {
    name: 'Линкор', icon: '🛳', price: 500,
    hp: 280, dmg: 65, fireRange: 190, move: 90, fishing: 0,
    portBonus: 1.5, // урон по вражескому порту в 1.5 раза — главный осадный корабль
    broadside: true,
    desc: 'Король моря. Бьёт по порту в 1.5 раза сильнее (≈98) и даёт залп 💥 по всем врагам. Медленный, но почти непотопляемый.'
  }
};

// ─── Старт ──────────────────────────────────────────────────────────────────
export const START_FLEET = ['shkhuna', 'shkhuna', 'fregat']; // пара шхун и фрегат
export const START_GOLD = 250;

// ─── Рыбалка ──────────────────────────────────────────────────────────────────
export const FISH_ZONE_CAP = 4;     // базовый лимит судов на рыбное место
export const FISH_ZONE_CAP_BIG = 5; // …у крупных зон — на 1 больше (порог: FISH_BIG_RADIUS, см. ниже)

// ─── Порт / база ──────────────────────────────────────────────────────────────
export const PORT_HP = 840;
export const PORT_RETURN_DMG = 15;          // порт огрызается по атакующему кораблю
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
export const PIRATE_MAX = 2;               // не больше двух пиратов на карте
export const PIRATE_REVENGE_SHOT = 0.35;   // (легаси) шанс выстрела в обидчика за ход
export const PIRATE_FLEE_CHANCE = 0.5;     // (легаси) иначе — шанс удрать
export const PIRATE_CALM_CHANCE = 0.25;    // (легаси) шанс остыть и забыть обиду
export const PIRATE_DESPAWN_CHANCE = 0.08; // шанс раствориться в тумане за ход
export const PIRATE_SPAWN_CHANCE = 0.16;   // шанс появления нового за круг
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
// крупной считается зона радиусом больше 2/3 диапазона размеров (90..120) → порог 110
export const FISH_BIG_RADIUS = FISH_RADIUS_MIN + Math.round(FISH_RADIUS_RAND * 2 / 3);
// лимит судов на конкретную зону: крупная (радиус > порога) кормит FISH_ZONE_CAP_BIG, иначе FISH_ZONE_CAP
export const fishZoneCap = (radius) => (radius > FISH_BIG_RADIUS ? FISH_ZONE_CAP_BIG : FISH_ZONE_CAP);

// форма острова (полигон для отрисовки)
export const ISLAND_SHAPE_MIN_PTS = 11, ISLAND_SHAPE_RAND_PTS = 4;
export const ISLAND_SHAPE_R_MIN = 0.72, ISLAND_SHAPE_R_RAND = 0.42;

// стартовая расстановка флота вокруг базы (в сторону центра)
export const START_SPAWN_SPREAD = 0.55; // угловой разброс между кораблями
export const START_SPAWN_RING = 55;     // отступ от края базы
