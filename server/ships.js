// Характеристики флота. Расстояния — в игровых единицах (1 клетка = 40).
export const SHIP_TYPES = {
  barkas: {
    name: 'Рыбацкий баркас',
    icon: '⛵',
    price: 60,
    hp: 30,
    dmg: 5,
    fireRange: 70,
    move: 140,
    fishing: 4, // золота КАЖДЫЙ ХОД, пока стоит в рыбном месте (без траты действия)
    desc: 'Стоит в рыбном месте — каждый ход сам приносит 4 золота, действие на это не тратится. Почти не вооружён.'
  },
  shkhuna: {
    name: 'Шхуна',
    icon: '🛥',
    price: 110,
    hp: 60,
    dmg: 15,
    fireRange: 110,
    move: 170,
    fishing: 0,
    desc: 'Быстрая и дешёвая рабочая лошадка. Хороша для разведки и лута.'
  },
  brig: {
    name: 'Бриг',
    icon: '⚓',
    price: 220,
    hp: 110,
    dmg: 28,
    fireRange: 140,
    move: 135,
    fishing: 0,
    desc: 'Сбалансированный боевой корабль.'
  },
  fregat: {
    name: 'Фрегат',
    icon: '🚢',
    price: 380,
    hp: 170,
    dmg: 42,
    fireRange: 165,
    move: 110,
    fishing: 0,
    broadside: true, // умеет бортовой залп по всем целям в радиусе
    desc: 'Тяжёлый корабль линии. Бьёт больно и умеет бортовой залп 💥 по всем врагам в радиусе.'
  },
  linkor: {
    name: 'Линкор',
    icon: '🛳',
    price: 500,
    hp: 280,
    dmg: 65,
    fireRange: 190,
    move: 90,
    fishing: 0,
    portBonus: 1.5, // урон по вражескому порту в 1.5 раза — главный осадный корабль, но в одиночку базу не свалить с пары тычков
    broadside: true,
    desc: 'Король моря. Бьёт по порту в 1.5 раза сильнее (≈98) и даёт залп 💥 по всем врагам. Медленный, но почти непотопляемый.'
  }
};

export const BROADSIDE_MULT = 0.8; // залп бьёт каждую цель на 20% слабее обычного выстрела
export const FISH_ZONE_CAP = 4;    // рыбное место кормит не больше 4 судов одновременно

// Нейтральные пираты: бродят по карте, исчезают и появляются. Награда — за потопление.
export const PIRATE = {
  name: 'Пиратский корабль',
  icon: '🏴‍☠️',
  npc: true,
  price: 0,
  hp: 80,
  dmg: 12,
  fireRange: 130,
  move: 80, // медленнее шхуны (170)
  fishing: 0,
  desc: 'Нейтральный бродяга. Потопи его и забери награду. Но смотри — может дать сдачи.'
};
export const PIRATE_REVENGE_SHOT = 0.35; // шанс выстрела в обидчика за ход
export const PIRATE_FLEE_CHANCE = 0.5;   // иначе — шанс удрать
export const PIRATE_CALM_CHANCE = 0.25;  // шанс остыть и забыть обиду
export const PIRATE_DESPAWN_CHANCE = 0.08;  // шанс раствориться в тумане за ход
export const PIRATE_SPAWN_CHANCE = 0.16;    // шанс появления нового за ход (если есть место)
export const PIRATE_MOVE_CHANCE = 0.75;     // шанс, что пират сдвинется за ход
export const PIRATE_BOSS_CHANCE = 0.14;     // шанс, что новый пират — «жирный» босс
export const PIRATE_BOSS_HP = 220;          // живучий босс — за ним охота

// Стартовый флот: пара шхун и один фрегат («крейсер»), как в оригинале.
export const START_FLEET = ['shkhuna', 'shkhuna', 'fregat'];
export const START_GOLD = 250;
export const PORT_HP = 840;
export const PORT_RETURN_DMG = 15;  // порт огрызается по атакующему: лёгким в одиночку базу не взять,
                                    // фрегат — лишь ценой гибели, вдвоём/линкором — норм
export const PORT_INCOME = 6;       // порт приносит немного золота в начале хода игрока
export const PORT_DMG_TO_SHIPS = 0; // порт не стреляет — оборона флотом
export const SHIP_COLLISION_DIST = 26; // мин. дистанция между центрами кораблей
export const LOOT_REACH = 55; // насколько корабль «дотягивается» до лут-острова/обломков
