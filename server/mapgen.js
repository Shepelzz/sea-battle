// Генерация карты: базы по краям, лут-острова и рыбные места в центре.
// Все острова в логике — круги; полигональная форма генерируется для отрисовки.
// Все числа — из config.js (порядок вызовов rnd() менять нельзя: ломает детерминизм карты).
import {
  MAP_W, MAP_H, MAPGEN_GUARD, BASE_CORNER_MARGIN, BASE_RADIUS, BASE_JITTER,
  LOOT_COUNT_EXTRA, LOOT_RADIUS_MIN, LOOT_RADIUS_RAND, LOOT_AREA_X0, LOOT_AREA_XR,
  LOOT_AREA_Y0, LOOT_AREA_YR, LOOT_BASE_GAP, LOOT_GAP, LOOT_VALUE_MIN, LOOT_VALUE_RAND, LOOT_VALUE_STEP,
  FISH_COUNT, FISH_RADIUS_MIN, FISH_RADIUS_RAND, FISH_AREA_X0, FISH_AREA_XR, FISH_AREA_Y0, FISH_AREA_YR,
  FISH_BASE_GAP, FISH_LOOT_GAP, FISH_GAP, fishZoneCap, ISLAND_SHAPE_MIN_PTS, ISLAND_SHAPE_RAND_PTS,
  ISLAND_SHAPE_R_MIN, ISLAND_SHAPE_R_RAND, START_SPAWN_SPREAD, START_SPAWN_RING
} from './config.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function islandShape(rnd, radius) {
  const points = [];
  const n = ISLAND_SHAPE_MIN_PTS + Math.floor(rnd() * ISLAND_SHAPE_RAND_PTS);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const r = radius * (ISLAND_SHAPE_R_MIN + rnd() * ISLAND_SHAPE_R_RAND);
    points.push([Math.round(Math.cos(ang) * r), Math.round(Math.sin(ang) * r)]);
  }
  return points;
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

export function generateMap(seed, playerCount) {
  const rnd = mulberry32(seed);
  const W = MAP_W, H = MAP_H, M = BASE_CORNER_MARGIN;

  // Углы для баз. 2 игрока — по диагонали, 3-4 — по углам.
  const corners = [
    [M, M], [W - M, H - M], [W - M, M], [M, H - M]
  ];
  const bases = [];
  for (let i = 0; i < playerCount; i++) {
    const [x, y] = corners[i];
    const radius = BASE_RADIUS;
    bases.push({
      playerIdx: i,
      x: x + Math.round((rnd() - 0.5) * BASE_JITTER),
      y: y + Math.round((rnd() - 0.5) * BASE_JITTER),
      radius,
      shape: islandShape(rnd, radius)
    });
  }

  // Лут-острова: небольшие, в центральной части, подальше от баз и друг от друга.
  const lootIslands = [];
  const lootCount = playerCount + LOOT_COUNT_EXTRA;
  let guard = 0;
  while (lootIslands.length < lootCount && guard++ < MAPGEN_GUARD) {
    const radius = LOOT_RADIUS_MIN + Math.round(rnd() * LOOT_RADIUS_RAND);
    const x = Math.round(W * LOOT_AREA_X0 + rnd() * W * LOOT_AREA_XR);
    const y = Math.round(H * LOOT_AREA_Y0 + rnd() * H * LOOT_AREA_YR);
    if (bases.some(b => dist(x, y, b.x, b.y) < b.radius + radius + LOOT_BASE_GAP)) continue;
    if (lootIslands.some(o => dist(x, y, o.x, o.y) < o.radius + radius + LOOT_GAP)) continue;
    lootIslands.push({
      id: 'isl' + lootIslands.length,
      x, y, radius,
      shape: islandShape(rnd, radius),
      loot: (LOOT_VALUE_MIN + Math.floor(rnd() * LOOT_VALUE_RAND)) * LOOT_VALUE_STEP, // 100..300 золота
      looted: false
    });
  }

  // Рыбные места: зоны, где баркасы добывают рыбу.
  const fishZones = [];
  guard = 0;
  while (fishZones.length < FISH_COUNT && guard++ < MAPGEN_GUARD) {
    const radius = FISH_RADIUS_MIN + Math.round(rnd() * FISH_RADIUS_RAND);
    const x = Math.round(W * FISH_AREA_X0 + rnd() * W * FISH_AREA_XR);
    const y = Math.round(H * FISH_AREA_Y0 + rnd() * H * FISH_AREA_YR);
    if (bases.some(b => dist(x, y, b.x, b.y) < b.radius + radius + FISH_BASE_GAP)) continue;
    if (lootIslands.some(o => dist(x, y, o.x, o.y) < o.radius + radius + FISH_LOOT_GAP)) continue;
    if (fishZones.some(z => dist(x, y, z.x, z.y) < z.radius + radius + FISH_GAP)) continue;
    fishZones.push({ x, y, radius, cap: fishZoneCap(radius) }); // лимит судов зависит от размера зоны
  }

  return { w: W, h: H, bases, lootIslands, fishZones };
}

// Точки расстановки стартового флота вокруг базы (в сторону центра карты).
export function spawnPoints(map, base, count) {
  const cx = map.w / 2, cy = map.h / 2;
  const toCenter = Math.atan2(cy - base.y, cx - base.x);
  const pts = [];
  for (let i = 0; i < count; i++) {
    const ang = toCenter + (i - (count - 1) / 2) * START_SPAWN_SPREAD;
    const r = base.radius + START_SPAWN_RING;
    pts.push({
      x: Math.round(base.x + Math.cos(ang) * r),
      y: Math.round(base.y + Math.sin(ang) * r)
    });
  }
  return pts;
}
