// Генерация карты: базы по краям, лут-острова и рыбные места в центре.
// Все острова в логике — круги; полигональная форма генерируется для отрисовки.

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
  const n = 11 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2;
    const r = radius * (0.72 + rnd() * 0.42);
    points.push([Math.round(Math.cos(ang) * r), Math.round(Math.sin(ang) * r)]);
  }
  return points;
}

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

export function generateMap(seed, playerCount) {
  const rnd = mulberry32(seed);
  const W = 1600, H = 1200;

  // Углы для баз. 2 игрока — по диагонали, 3-4 — по углам.
  const corners = [
    [200, 200], [W - 200, H - 200], [W - 200, 200], [200, H - 200]
  ];
  const bases = [];
  for (let i = 0; i < playerCount; i++) {
    const [x, y] = corners[i];
    const radius = 105;
    bases.push({
      playerIdx: i,
      x: x + Math.round((rnd() - 0.5) * 30),
      y: y + Math.round((rnd() - 0.5) * 30),
      radius,
      shape: islandShape(rnd, radius)
    });
  }

  // Лут-острова: небольшие, в центральной части, подальше от баз и друг от друга.
  const lootIslands = [];
  const lootCount = playerCount + 3;
  let guard = 0;
  while (lootIslands.length < lootCount && guard++ < 400) {
    const radius = 30 + Math.round(rnd() * 18);
    const x = Math.round(W * 0.25 + rnd() * W * 0.5);
    const y = Math.round(H * 0.2 + rnd() * H * 0.6);
    if (bases.some(b => dist(x, y, b.x, b.y) < b.radius + radius + 220)) continue;
    if (lootIslands.some(o => dist(x, y, o.x, o.y) < o.radius + radius + 160)) continue;
    lootIslands.push({
      id: 'isl' + lootIslands.length,
      x, y, radius,
      shape: islandShape(rnd, radius),
      loot: (10 + Math.floor(rnd() * 21)) * 10, // 100..300 золота
      looted: false
    });
  }

  // Рыбные места: зоны, где баркасы добывают рыбу.
  const fishZones = [];
  const fishCount = 3;
  guard = 0;
  while (fishZones.length < fishCount && guard++ < 400) {
    const radius = 90 + Math.round(rnd() * 30);
    const x = Math.round(W * 0.18 + rnd() * W * 0.64);
    const y = Math.round(H * 0.15 + rnd() * H * 0.7);
    if (bases.some(b => dist(x, y, b.x, b.y) < b.radius + radius + 120)) continue;
    if (lootIslands.some(o => dist(x, y, o.x, o.y) < o.radius + radius + 40)) continue;
    if (fishZones.some(z => dist(x, y, z.x, z.y) < z.radius + radius + 100)) continue;
    fishZones.push({ x, y, radius });
  }

  return { w: W, h: H, bases, lootIslands, fishZones };
}

// Точки расстановки стартового флота вокруг базы (в сторону центра карты).
export function spawnPoints(map, base, count) {
  const cx = map.w / 2, cy = map.h / 2;
  const toCenter = Math.atan2(cy - base.y, cx - base.x);
  const pts = [];
  for (let i = 0; i < count; i++) {
    const ang = toCenter + (i - (count - 1) / 2) * 0.55;
    const r = base.radius + 55;
    pts.push({
      x: Math.round(base.x + Math.cos(ang) * r),
      y: Math.round(base.y + Math.sin(ang) * r)
    });
  }
  return pts;
}
