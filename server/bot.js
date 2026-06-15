// Бот: на своём ходу собирает все осмысленные действия, оценивает и берёт лучшее.
// Уровни: easy (Юнга) — шумные оценки и случайные ходы, mid (Боцман) — лучший ход,
// hard (Адмирал) — лучший ход + фокус раненых, удушение экономики, ранняя агрессия.
import { SHIP_TYPES, PIRATE, LOOT_REACH, PORT_RETURN_DMG } from './ships.js';
import { shipPlacementBlocked } from './game.js';

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

export const BOT_NAMES = {
  easy: ['Юнга Билли', 'Юнга Том', 'Юнга Чарли'],
  mid: ['Боцман Сэм', 'Боцман Дрейк', 'Боцман Луи'],
  hard: ['Адмирал Грей', 'Адмирал Шторм', 'Адмирал Кроу']
};

// шаг к цели с объездом препятствий (как «по линейке»)
function findStep(game, ship, tx, ty) {
  const st = SHIP_TYPES[ship.type];
  const d = dist(ship.x, ship.y, tx, ty);
  if (d < 8) return null;
  const step = Math.min(st.move - 2, d);
  const base = Math.atan2(ty - ship.y, tx - ship.x);
  for (const da of [0, 0.4, -0.4, 0.8, -0.8, 1.3, -1.3]) {
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

export function chooseBotAction(game, pIdx, level = 'mid') {
  const me = game.players[pIdx];
  const myShips = game.ships.filter(s => s.owner === pIdx);
  const foeShips = game.ships.filter(s =>
    s.owner >= 0 && s.owner !== pIdx && game.players[s.owner]?.alive);
  const cands = [{ score: 1, action: { type: 'skip' } }];

  // затяжная партия — хватит копить, идём добивать
  const turnPressure = game.turn.number > game.players.length * 25;
  // сила игрока: HP + урон флота (единая метрика для всех сравнений)
  const powerOf = i => game.ships.filter(s => s.owner === i)
    .reduce((a, x) => a + x.hp + SHIP_TYPES[x.type].dmg, 0);
  const myPower = powerOf(pIdx);
  const foePower = foeShips.reduce((s, x) => s + x.hp + SHIP_TYPES[x.type].dmg, 0);

  // угроза базе: вражеские боевые корабли рядом с моим портом
  const myBase = game.map.bases[pIdx];
  const invaders = foeShips.filter(f =>
    SHIP_TYPES[f.type].dmg > 0 && dist(f.x, f.y, myBase.x, myBase.y) < 430);
  const underSiege = invaders.length > 0 && level !== 'easy';

  // жертва — слабейший противник; решимость меряем с НИМ, а не с суммой всех
  const foes = game.players.map((p, i) => ({ p, i })).filter(x => x.i !== pIdx && x.p.alive);
  let victim = null;
  for (const x of foes) if (!victim || powerOf(x.i) < powerOf(victim.i)) victim = x;
  const aggressive = turnPressure || foeShips.length === 0 ||
    (victim && myPower > powerOf(victim.i) * (level === 'hard' ? 1.1 : 1.3));

  // --- стрельба ---
  for (const ship of myShips) {
    const st = SHIP_TYPES[ship.type];
    if (!st.dmg) continue;
    for (const t of game.ships) {
      if (t.owner === pIdx) continue;
      if (t.owner >= 0 && !game.players[t.owner]?.alive) continue;
      if (dist(ship.x, ship.y, t.x, t.y) > st.fireRange) continue;
      const tdef = t.owner === -1 ? PIRATE : SHIP_TYPES[t.type];
      const kills = t.hp <= st.dmg;
      let score = st.dmg * 0.8;
      if (kills) score += 30 + (t.owner === -1 ? t.bounty * 0.3 : SHIP_TYPES[t.type].price * 0.2);
      if (t.owner === -1 && !kills && level !== 'easy') score -= 15; // пираты мстят
      if (level === 'hard') {
        if (t.owner !== -1 && SHIP_TYPES[t.type].fishing) score += 12; // душим экономику
        score += ((t.maxHp || tdef.hp) - t.hp) * 0.12;                // фокус раненых
      }
      cands.push({ score, action: { type: 'attack', shipId: ship.id, targetType: 'ship', targetId: t.id } });
    }
    // бортовой залп: бьёт всех в радиусе на -20% — выгоден против стаи
    if (st.broadside) {
      const inRange = game.ships.filter(t =>
        t.owner !== pIdx && !(t.owner >= 0 && !game.players[t.owner]?.alive) &&
        (t.owner === -1 || !SHIP_TYPES[t.type].fishing) &&
        dist(ship.x, ship.y, t.x, t.y) <= st.fireRange);
      if (inRange.length >= 2) {
        const dmg = st.dmg * 0.8;
        const kills = inRange.filter(t => t.hp <= dmg).length;
        const score = inRange.length * dmg * 0.6 + kills * 22;
        cands.push({ score, action: { type: 'broadside', shipId: ship.id } });
      }
    }
    game.players.forEach((p, i) => {
      if (i === pIdx || !p.alive) return;
      const base = game.map.bases[i];
      if (dist(ship.x, ship.y, base.x, base.y) <= st.fireRange + base.radius * 0.5) {
        const portDmg = st.dmg * (st.portBonus || 1);
        const destroys = p.portHp <= portDmg;
        // порт огрызается: не скармливаем корабль, если он от ответки погибнет, а порт устоит
        const suicidal = !destroys && ship.hp <= PORT_RETURN_DMG;
        cands.push({
          score: portDmg * 1.1 + (destroys ? 200 : 20) - (suicidal ? 60 : 0),
          action: { type: 'attack', shipId: ship.id, targetType: 'port', targetId: i }
        });
      }
    });
  }

  // --- сбор добычи ---
  let gain = 0;
  for (const s of myShips.filter(s => SHIP_TYPES[s.type].fishing > 0)) {
    if (game.map.fishZones.some(z => dist(s.x, s.y, z.x, z.y) <= z.radius)) gain += SHIP_TYPES[s.type].fishing;
  }
  for (const isl of game.map.lootIslands.filter(i => !i.looted)) {
    if (myShips.some(s => dist(s.x, s.y, isl.x, isl.y) <= isl.radius + LOOT_REACH)) gain += isl.loot;
  }
  // сбор — рутина, а не стратегия: не должен перебивать манёвры и оборону
  if (gain > 0) {
    cands.push({
      score: Math.min(24, 8 + gain * 0.12) * (underSiege ? 0.5 : 1),
      action: { type: 'collect' }
    });
  }

  // --- верфь (флот не раздуваем — место у порта и здравый смысл) ---
  const fishers = myShips.filter(s => SHIP_TYPES[s.type].fishing > 0).length;
  if (myShips.length < 8) {
    if (level !== 'easy') {
      if (fishers === 0 && me.gold >= SHIP_TYPES.barkas.price + 60) {
        // когда под стенами враг — не до рыбалки
        cands.push({ score: underSiege ? 6 : 34, action: { type: 'buy', ships: ['barkas'] } });
      }
      const pick = level === 'hard'
        ? (me.gold >= SHIP_TYPES.linkor.price ? 'linkor' : me.gold >= 380 ? 'fregat' : me.gold >= 220 ? 'brig' : null)
        : (me.gold >= 380 ? 'fregat' : me.gold >= 220 ? 'brig' : null);
      if (pick && (underSiege || !turnPressure)) {
        const score = underSiege
          ? 30 + Math.min(8, me.gold / 200) // срочно строим защитников
          : (foePower >= myPower ? 26 : 14) + Math.min(8, me.gold / 200);
        cands.push({ score, action: { type: 'buy', ships: [pick] } });
      }
    } else if (me.gold >= SHIP_TYPES.shkhuna.price && Math.random() < 0.4) {
      cands.push({ score: 14, action: { type: 'buy', ships: ['shkhuna'] } });
    }
  }

  // --- движение ---
  const addMove = (ship, tx, ty, score) => {
    const pos = findStep(game, ship, tx, ty);
    if (pos) cands.push({ score, action: { type: 'move', shipId: ship.id, x: pos.x, y: pos.y } });
  };
  const isls = game.map.lootIslands.filter(i => !i.looted);

  for (const ship of myShips) {
    const st = SHIP_TYPES[ship.type];

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

    // рыбак плывёт в рыбное место и не воюет
    if (st.fishing > 0) {
      const inZone = game.map.fishZones.some(z => dist(ship.x, ship.y, z.x, z.y) <= z.radius);
      if (!inZone) {
        const z = nearest(ship, game.map.fishZones, zz => [zz.x, zz.y]);
        if (z) addMove(ship, z.x, z.y, 24);
      }
      continue;
    }

    // оборона: перехватываем гостей у своего порта — высший приоритет
    if (underSiege) {
      const inv = nearest(ship, invaders, f => [f.x, f.y]);
      if (inv) addMove(ship, inv.x, inv.y, 30);
    }

    // к ближайшему кладу — лут важнее бесконечной рыбалки
    const isl = nearest(ship, isls, ii => [ii.x, ii.y]);
    if (isl && dist(ship.x, ship.y, isl.x, isl.y) > isl.radius + LOOT_REACH) {
      const turns = Math.ceil(dist(ship.x, ship.y, isl.x, isl.y) / st.move);
      addMove(ship, isl.x, isl.y, Math.min(24, 10 + isl.loot * 0.05) - turns * 2);
    }

    // охота на пирата с наградой (боевыми кораблями) — особенно за 👑-боссом
    if (st.dmg > 0 && level !== 'easy') {
      const pirates = game.ships.filter(s => s.owner === -1);
      const prey = nearest(ship, pirates, pr => [pr.x, pr.y]);
      if (prey && dist(ship.x, ship.y, prey.x, prey.y) > st.fireRange) {
        const turns = Math.ceil(dist(ship.x, ship.y, prey.x, prey.y) / st.move);
        addMove(ship, prey.x, prey.y, Math.min(28, 8 + prey.bounty * 0.03) - turns * 2);
      }
    }

    // на сближение с флотом противника — только когда готовы драться,
    // иначе не скармливаем корабли по одному
    const foe = nearest(ship, foeShips, f => [f.x, f.y]);
    if (foe) addMove(ship, foe.x, foe.y, aggressive ? (level === 'hard' ? 18 : 14) : 7);

    // осада порта жертвы. В режиме добивания осада ДОЛЖНА перебивать лут/охоту за
    // пиратами (иначе флот распыляется и порт не падает) — даём ей явный приоритет.
    if (victim) {
      const b = game.map.bases[victim.i];
      // осаду ведут тяжёлые корабли (фрегат/линкор соло пробивают порт, переживая ответку),
      // лёгкие — в хвосте. Скор выше лута(24)/пиратов(28), но ниже выстрела по порту.
      const siegeScore = Math.min(36, 12 + st.dmg * 0.6);
      addMove(ship, b.x, b.y, aggressive ? siegeScore : 6);
    }
  }

  // --- выбор по уровню ---
  if (level === 'easy') {
    if (Math.random() < 0.3) return cands[Math.floor(Math.random() * cands.length)].action;
    for (const c of cands) c.score *= 0.7 + Math.random() * 0.6; // шумные оценки
  }
  cands.sort((a, b) => b.score - a.score);
  return cands[0].action;
}
