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
    fishing: 30, // золота за сбор в рыбном месте
    desc: 'Добывает рыбу в рыбных местах (30 золота за сбор). Почти не вооружён.'
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
    desc: 'Тяжёлый корабль линии. Медленный, но бьёт больно.'
  },
  linkor: {
    name: 'Линкор',
    icon: '🛳',
    price: 650,
    hp: 280,
    dmg: 65,
    fireRange: 190,
    move: 90,
    fishing: 0,
    desc: 'Король моря. Дорогой, медленный, почти непотопляемый.'
  }
};

// Стартовый флот: пара шхун и один фрегат («крейсер»), как в оригинале.
export const START_FLEET = ['shkhuna', 'shkhuna', 'fregat'];
export const START_GOLD = 250;
export const PORT_HP = 300;
export const PORT_DMG_TO_SHIPS = 0; // порт не стреляет — оборона флотом
export const SHIP_COLLISION_DIST = 26; // мин. дистанция между центрами кораблей
export const LOOT_REACH = 55; // насколько корабль «дотягивается» до лут-острова/обломков
