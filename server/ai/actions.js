// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║  🧭 ДЕЙСТВИЯ ИИ-СОПЕРНИКА — «руки капитана» и штурман при них.                ║
// ║  Схема инструментов для модели + НАВИГАТОР: намерение → легальный applyAction.║
// ║  Про LLM и сеть этот файл, как и perception.js, не знает ничего.              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝
//
// ПОЧЕМУ НАМЕРЕНИЯ, А НЕ КООРДИНАТЫ. Если позволить модели писать «move в точку
// (486,271)», примерно треть ходов окажется невалидной: не хватит линейки, встречный
// ветер укоротит ход, в точке окажется мель или чужой корпус. Поэтому модель говорит
// ЧТО хочет («иди к I3 и держись в 3 клетках»), а штурман считает КАК: клампит по
// дальности с учётом ветра, обходит препятствия, сам выбирает борт для залпа.
//
// Итог работы навигатора — обычный action для applyAction, ровно такой же, какой шлёт
// браузер живого игрока. Никаких привилегий у ИИ нет.

import {
  SHIP_TYPES, CELL, MAP_EDGE_MARGIN, LOOT_REACH, OUTPOST_BUILD_REACH, OUTPOST_LEVELS,
  REPAIR_DOCK_REACH, REPAIR_CHARGES, MOVES_PER_TURN, SHIP_COLLISION_DIST, SHIP_ACTIONS,
  windMoveMult, movesBudget, modeOf, isPeace, isDuel, isRealtime
} from '../config.js';
import { shipPlacementBlocked, terrainBlocked } from '../game.js';
import { cellCenter, cellOf, shipByAlias, aliasOf, broadsidePreview, mortarPreview, hasMortar, inCells } from './perception.js';

const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);

// ─── Схема инструментов ───────────────────────────────────────────────────────
// Один инструмент на весь ход: модель возвращает план целиком (до MOVES_PER_TURN
// действий). Это втрое дешевле повызовного режима и заставляет думать ходом, а не
// жадно по одному кораблю. Схема нарочно ПЛОСКАЯ (без oneOf/anyOf): такую одинаково
// хорошо переваривают и Anthropic tool use, и OpenAI function calling в strict-режиме,
// а корректность всё равно проверяет навигатор ниже.

export const ACTION_TYPES = ['sail', 'broadside', 'mortar', 'collect', 'buy', 'repair', 'recharge', 'outpost', 'end_turn'];

export const TURN_TOOL = {
  name: 'submit_turn',
  description: 'Отдать приказы на этот ход. Действия выполняются по порядку.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['plan', 'actions'],
    properties: {
      plan: {
        type: 'string',
        description: 'Твоя цель на ближайшие ходы, 1–2 предложения. Её покажут тебе же в следующий ход — держи курс, не мечись.'
      },
      taunt: {
        type: 'string',
        description: 'Необязательная короткая реплика в чат партии (до 100 символов), в духе морского волка. Без оскорблений.'
      },
      actions: {
        type: 'array',
        description: `Список действий на этот ход, максимум ${MOVES_PER_TURN}. Пустой список = пропустить ход.`,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: {
            type: { type: 'string', enum: ACTION_TYPES, description: 'Что делаем: sail — плыть, broadside — бортовой залп, mortar — прицельный выстрел, collect — собрать клад, buy — купить корабли, repair — починить своего, recharge — пополнить материалы ремонтника, outpost — построить/улучшить аванпост, end_turn — закончить ход.' },
            ship: { type: 'string', description: 'Кличка своего корабля: M1, M2… Нужна для sail/broadside/mortar/repair/recharge и для первой постройки outpost.' },
            target: { type: 'string', description: 'Цель: кличка корабля (E2, P1), PORT1 — база игрока, I3 — остров (для mortar — чужой аванпост на нём), M2 — свой корабль (для repair).' },
            to: { type: 'string', description: 'Куда плыть (для sail). ЛУЧШЕ адрес объекта — PORT1 (вражеская база), E2 (чужой корабль), I3 (остров), F0 (рыбное место): штурман сам проложит курс. Сырая клетка «12,7» — только для точки на пустой воде.' },
            keep_distance: { type: 'number', description: 'Для sail: на сколько КЛЕТОК не доходить до цели (например 3.5 — встать на дистанции огня). По умолчанию 0.' },
            ships: { type: 'array', items: { type: 'string' }, description: 'Для buy: типы кораблей — barkas, shkhuna, brig, fregat, linkor, repair.' },
            island: { type: 'string', description: 'Для outpost: адрес острова, например I2.' },
            why: { type: 'string', description: 'Одной фразой — зачем это действие. Попадёт в отладочный журнал.' }
          }
        }
      }
    }
  }
};

/** Все инструменты капитана (пока один; сюда же встанут будущие — например, разведка). */
export const TOOLS = [TURN_TOOL];

// ─── Разбор адресов ───────────────────────────────────────────────────────────

/** Адрес → объект на карте: {kind, x, y, ...}. kind: ship|island|fish|port|cell. */
export function resolveTarget(game, pIdx, addr) {
  const raw = String(addr ?? '').trim();
  if (!raw) return null;
  const key = raw.toUpperCase();

  const mCell = key.match(/^(\d{1,3})\s*[,;: ]\s*(\d{1,3})$/); // «12,7»
  if (mCell) {
    const c = +mCell[1], r = +mCell[2];
    const { x, y } = cellCenter(c, r);
    if (x < 0 || y < 0 || x > game.map.w || y > game.map.h) return null;
    return { kind: 'cell', x, y, label: `${c},${r}` };
  }
  const mPort = key.match(/^PORT\s*(\d+)$/);
  if (mPort) {
    const i = +mPort[1], base = game.map.bases?.[i];
    if (!base || base.noPort || !game.players[i]) return null;
    return { kind: 'port', idx: i, x: base.x, y: base.y, radius: base.radius, label: key };
  }
  const mIsl = key.match(/^I\s*(\d+)$/);
  if (mIsl) {
    const i = +mIsl[1], isl = (game.map.lootIslands || [])[i];
    if (!isl) return null;
    return { kind: 'island', idx: i, island: isl, x: isl.x, y: isl.y, radius: isl.radius, label: key };
  }
  const mFish = key.match(/^F\s*(\d+)$/);
  if (mFish) {
    const i = +mFish[1], z = (game.map.fishZones || [])[i];
    if (!z) return null;
    return { kind: 'fish', idx: i, zone: z, x: z.x, y: z.y, radius: z.radius, label: key };
  }
  const ship = shipByAlias(game, pIdx, key);
  if (ship) return { kind: 'ship', ship, x: ship.x, y: ship.y, label: key };
  return null;
}

const myShip = (game, pIdx, addr) => {
  const t = resolveTarget(game, pIdx, addr);
  if (!t || t.kind !== 'ship') return null;
  return t.ship.owner === pIdx ? t.ship : null;
};

/**
 * Занят ли корабль в этом ходу. Правило игры: одним кораблём — одно действие за ход
 * (у залпа особый счёт: каждый борт отдельно, пока не отстреляли оба).
 * Проверяем ЗДЕСЬ, чтобы модель получила человеческое объяснение вместо сухого отказа
 * движка — она тогда переключается на другой корабль, а не долбится в тот же.
 */
function busyNote(game, pIdx, ship, type) {
  if (isRealtime(game) || !SHIP_ACTIONS.includes(type)) return null;
  const tag = aliasOf(game, pIdx, ship);
  const sides = game.turn?.broadsideSides?.[ship.id] || [];
  if ((game.turn?.actedShips || []).includes(ship.id))
    return `${tag} уже действовал в этом ходу — возьми другой корабль или заверши ход (end_turn).`;
  if (sides.length && type !== 'broadside')
    return `${tag} в этом ходу уже дал залп — ему остался только второй борт (broadside), плыть и стрелять мортирой нельзя.`;
  if (sides.length >= 2)
    return `${tag} отстрелялся обоими бортами — на этот ход он своё отработал.`;
  return null;
}

// ─── Штурман: точка, куда реально можно встать ───────────────────────────────

/**
 * Легальная точка на пути к (tx,ty) в пределах хода корабля.
 * Учитывает ветер, край карты, сушу, чужие корпуса и мирный keep-out у баз.
 * Возвращает {x,y} или null, если встать некуда вообще.
 */
export function navigate(game, pIdx, ship, tx, ty, keepCells = 0) {
  const st = SHIP_TYPES[ship.type];
  const md = modeOf(game);
  const keepout = isPeace(game) ? (md.peaceBaseKeepout || 0) : 0;
  const full = dist(ship.x, ship.y, tx, ty);
  const want = Math.max(0, full - keepCells * CELL);   // не доходить keep_distance клеток
  if (want < 1) return null;                            // уже стоим где просили
  const ang = Math.atan2(ty - ship.y, tx - ship.x);
  // 🌬 Дальность хода зависит от КУРСА, а курс у каждого варианта обхода свой — поэтому
  // лимит считаем для каждой пробы отдельно (если считать один раз по прямой на цель,
  // обходной галс окажется длиннее разрешённого и игра ответит «против ветра так далеко
  // не уплыть»). Минус единица — запас на округление координат до целых.
  const rangeAt = a => isRealtime(game) ? want : Math.max(0, st.move * windMoveMult(game.wind, a) - 1);
  if (Math.min(want, rangeAt(ang)) < 1 && !isRealtime(game)) {
    // прямо по курсу не выходит — но может выйти галсом, проверим ниже
  }

  const legal = (x, y) => {
    if (x < MAP_EDGE_MARGIN || y < MAP_EDGE_MARGIN || x > game.map.w - MAP_EDGE_MARGIN || y > game.map.h - MAP_EDGE_MARGIN) return false;
    if (terrainBlocked(game, x, y)) return false;
    if (shipPlacementBlocked(game, x, y, ship.id)) return false;
    if (keepout && (game.map.bases || []).some((b, bi) =>
      bi !== pIdx && game.players[bi]?.alive && dist(x, y, b.x, b.y) < keepout)) return false;
    return true;
  };

  // Пробуем: сначала прямо по курсу с постепенным сокращением шага, затем с небольшими
  // доворотами — так корабль обтекает остров или соседа, а не встаёт колом.
  // Довороты от «прямо по курсу» до почти перпендикулярных: лучше обойти остров или
  // затор из своих же кораблей длинной дугой, чем не сдвинуться вовсе (эвал показал
  // ~12% приказов, упиравшихся в «встать некуда» при узких доворотах).
  for (const turn of [0, 0.25, -0.25, 0.5, -0.5, 0.85, -0.85, 1.2, -1.2, 1.6, -1.6]) {
    const step0 = Math.min(want, rangeAt(ang + turn));
    if (step0 < 1) continue;
    for (let k = 1; k >= 0.18; k -= 0.08) {
      const d = step0 * k;
      if (d < SHIP_COLLISION_DIST * 0.5) break;
      const x = Math.round(ship.x + Math.cos(ang + turn) * d);
      const y = Math.round(ship.y + Math.sin(ang + turn) * d);
      if (legal(x, y)) return { x, y };
    }
  }
  return null;
}

// ─── Навигатор плана: намерения → действия ───────────────────────────────────

const err = (item, message) => ({ ok: false, error: message, item });

/**
 * Одно намерение → один action для applyAction.
 * Возвращает {ok:true, action, note?} либо {ok:false, error} с человеческим текстом
 * (его же отдаём модели на ретрай — она обычно чинит приказ с первого раза).
 */
export function toAction(game, pIdx, item) {
  const type = String(item?.type || '').toLowerCase();
  const player = game.players[pIdx];

  switch (type) {
    case 'end_turn':
      return { ok: true, action: { type: 'skip' } };

    case 'collect':
      return { ok: true, action: { type: 'collect' } };

    case 'buy': {
      const list = (Array.isArray(item.ships) ? item.ships : []).map(s => String(s || '').trim().toLowerCase());
      if (!list.length) return err(item, 'Для buy нужен непустой список ships (типы кораблей).');
      const bad = list.find(t => !SHIP_TYPES[t] || SHIP_TYPES[t].cheat || !SHIP_TYPES[t].price);
      if (bad) return err(item, `Неизвестный тип корабля «${bad}». Доступны: ${Object.keys(SHIP_TYPES).filter(k => !SHIP_TYPES[k].cheat).join(', ')}.`);
      // Не заваливаем ход из-за жадности: берём то, что по карману, лишнее отсекаем с пометкой.
      const afford = [];
      let left = player.gold;
      for (const t of list) { if (SHIP_TYPES[t].price <= left) { afford.push(t); left -= SHIP_TYPES[t].price; } }
      if (!afford.length) return err(item, `Не хватает золота: в казне ${player.gold}, самый дешёвый из запрошенных — ${Math.min(...list.map(t => SHIP_TYPES[t].price))}.`);
      const note = afford.length < list.length ? `куплено ${afford.length} из ${list.length} — на остальное не хватило золота` : null;
      return { ok: true, action: { type: 'buy', ships: afford }, note };
    }

    case 'sail': {
      const ship = myShip(game, pIdx, item.ship);
      if (!ship) return err(item, `Нет своего корабля с кличкой «${item.ship}». Свои корабли: ${game.ships.filter(s => s.owner === pIdx).map(s => aliasOf(game, pIdx, s)).join(', ') || '—'}.`);
      { const busy = busyNote(game, pIdx, ship, 'move'); if (busy) return err(item, busy); }
      const dest = resolveTarget(game, pIdx, item.to);
      if (!dest) return err(item, `Непонятно, куда плыть: «${item.to}». Используй клетку «12,7» или адрес — E2, I3, F0, PORT1.`);
      // у площадных целей keep_distance отсчитывается от БЕРЕГА, а не от центра
      const keep = Math.max(0, Number(item.keep_distance) || 0) + inCells(dest.radius || 0);
      // «уже на месте» и «встать некуда» — разные беды: модели важно понять, что чинить
      if (dist(ship.x, ship.y, dest.x, dest.y) - keep * CELL < 1)
        return err(item, `${aliasOf(game, pIdx, ship)} уже стоит там (${item.to}) — дай ему другую цель или займись другим кораблём.`);
      const pt = navigate(game, pIdx, ship, dest.x, dest.y, keep);
      if (!pt) return err(item, `Кораблю ${aliasOf(game, pIdx, ship)} некуда встать на этом курсе — путь перекрыт мелью или чужим корпусом. Возьми обходную клетку.`);
      return { ok: true, action: { type: 'move', shipId: ship.id, x: pt.x, y: pt.y } };
    }

    case 'broadside': {
      const ship = myShip(game, pIdx, item.ship);
      if (!ship) return err(item, `Нет своего корабля «${item.ship}» для залпа.`);
      { const busy = busyNote(game, pIdx, ship, 'broadside'); if (busy) return err(item, busy); }
      const t = resolveTarget(game, pIdx, item.target);
      if (!t) return err(item, `Непонятная цель залпа: «${item.target}».`);
      if (t.kind === 'ship' && t.ship.owner === pIdx) return err(item, 'По своим не стреляем.');
      // Борт выбирает сервер — модели его знать не надо. Берём тот, с которого цель реально
      // накрывается; если ни с какого — честно говорим, что она по носу/корме.
      const tag = aliasOf(game, pIdx, ship);
      const previews = ['port', 'starboard'].map(sd => ({ sd, pv: broadsidePreview(game, pIdx, ship, sd) }));
      const covers = ({ pv }) => t.kind === 'ship'
        ? pv.hits.some(h => h.ship.id === t.ship.id)
        : (t.kind === 'port' ? pv.port?.idx === t.idx : pv.hits.length > 0);
      const best = previews.find(covers) || null;
      if (!best) {
        const any = previews.find(p => p.pv.hits.length || p.pv.port);
        if (any) return err(item, `${item.target} не попадает в сектор борта ${tag} (нос или корма) — сначала повернись курсом мимо цели (sail) или бей мортирой. Сейчас с бортов достаёт: ${any.pv.hits.map(h => h.alias).join(', ') || 'порт'}.`);
        return err(item, `С бортов ${tag} целей в радиусе нет — подойди ближе и встань бортом.`);
      }
      // прицел ставим ровно в цель: applyAction по нему выберет тот же борт
      const extra = best.pv.hits.filter(h => t.kind !== 'ship' || h.ship.id !== t.ship.id).map(h => h.alias);
      return {
        ok: true,
        action: { type: 'broadside', shipId: ship.id, tx: t.x, ty: t.y },
        note: extra.length ? `тем же залпом накроет ещё: ${extra.join(', ')}` : null
      };
    }

    case 'mortar': {
      const ship = myShip(game, pIdx, item.ship);
      if (!ship) return err(item, `Нет своего корабля «${item.ship}» для мортиры.`);
      { const busy = busyNote(game, pIdx, ship, 'attack'); if (busy) return err(item, busy); }
      if (!hasMortar(ship)) return err(item, `У ${aliasOf(game, pIdx, ship)} нет мортиры — она только у фрегата и линкора. Дай бортовой залп.`);
      const t = resolveTarget(game, pIdx, item.target);
      if (!t) return err(item, `Непонятная цель мортиры: «${item.target}».`);
      const mp = mortarPreview(game, pIdx, ship);
      if (t.kind === 'ship') {
        if (t.ship.owner === pIdx) return err(item, 'По своим не стреляем.');
        if (!mp.ships.some(h => h.ship.id === t.ship.id))
          return err(item, `${item.target} вне дальности мортиры ${aliasOf(game, pIdx, ship)} (${inCells(SHIP_TYPES[ship.type].fireRange)} кл) — подойди ближе.`);
        return { ok: true, action: { type: 'attack', shipId: ship.id, targetType: 'ship', targetId: t.ship.id } };
      }
      if (t.kind === 'port') {
        if (t.idx === pIdx) return err(item, 'По своему порту не стреляем.');
        if (!mp.ports.some(p => p.idx === t.idx)) return err(item, `${item.target} вне дальности мортиры — подведи корабль к базе.`);
        return { ok: true, action: { type: 'attack', shipId: ship.id, targetType: 'port', targetId: t.idx } };
      }
      if (t.kind === 'island') {
        if (!t.island.outpost || t.island.outpost.owner === pIdx)
          return err(item, `На ${item.target} нет чужой постройки — стрелять не по чему.`);
        if (!mp.outposts.some(o => o.islandId === t.idx)) return err(item, `Аванпост на ${item.target} вне дальности — подойди ближе.`);
        return { ok: true, action: { type: 'attack', shipId: ship.id, targetType: 'outpost', targetId: t.idx } };
      }
      return err(item, 'Мортирой бьют по кораблю, порту (PORT1) или чужому аванпосту на острове (I3).');
    }

    case 'repair': {
      const ship = myShip(game, pIdx, item.ship);
      if (!ship) return err(item, `Нет своего корабля «${item.ship}».`);
      if (!SHIP_TYPES[ship.type].repairer) return err(item, `${aliasOf(game, pIdx, ship)} не умеет чинить — это делает ремонтник (repair).`);
      const t = resolveTarget(game, pIdx, item.target);
      if (!t || t.kind !== 'ship' || t.ship.owner !== pIdx) return err(item, `Чинить можно только свой корабль, «${item.target}» не подходит.`);
      return { ok: true, action: { type: 'repair', shipId: ship.id, targetId: t.ship.id } };
    }

    case 'recharge': {
      const ship = myShip(game, pIdx, item.ship);
      if (!ship) return err(item, `Нет своего корабля «${item.ship}».`);
      if (!SHIP_TYPES[ship.type].repairer) return err(item, 'Материалы пополняет только ремонтник.');
      return { ok: true, action: { type: 'recharge', shipId: ship.id } };
    }

    case 'outpost': {
      const t = resolveTarget(game, pIdx, item.island || item.target);
      if (!t || t.kind !== 'island') return err(item, `Нужен адрес острова, например I2 (получено «${item.island || item.target}»).`);
      const isl = t.island;
      const level = (isl.outpost?.level || 0) + 1;
      if (level > OUTPOST_LEVELS.length) return err(item, `На ${t.label} уже максимальный уровень постройки.`);
      const price = OUTPOST_LEVELS[level - 1].price;
      if (player.gold < price) return err(item, `На ${OUTPOST_LEVELS[level - 1].name} нужно ${price} зол., в казне ${player.gold}.`);
      const act = { type: 'outpost', islandId: t.idx };
      if (!isl.outpost) { // первая постройка требует корабль-строитель у берега
        let ship = myShip(game, pIdx, item.ship);
        if (!ship) ship = game.ships.find(s => s.owner === pIdx && dist(s.x, s.y, isl.x, isl.y) <= isl.radius + OUTPOST_BUILD_REACH);
        if (!ship) return err(item, `Для первой постройки на ${t.label} нужен свой корабль вплотную к острову (${inCells(OUTPOST_BUILD_REACH)} кл от берега) — сначала подплыви.`);
        act.shipId = ship.id;
      }
      return { ok: true, action: act };
    }

    default:
      return err(item, `Неизвестное действие «${item?.type}». Допустимые: ${ACTION_TYPES.join(', ')}.`);
  }
}

/** Каким бортом удобнее бить по точке — левым или правым (то же правило, что в applyAction). */
function pickSide(game, pIdx, ship, tx, ty) {
  const m = game.map;
  const norm = a => Math.atan2(Math.sin(a), Math.cos(a));
  const heading = (typeof ship.heading === 'number') ? ship.heading : Math.atan2(m.h / 2 - ship.y, m.w / 2 - ship.x);
  const aim = Math.atan2(ty - ship.y, tx - ship.x);
  const portDir = norm(heading - Math.PI / 2), starDir = norm(heading + Math.PI / 2);
  return Math.abs(norm(aim - portDir)) <= Math.abs(norm(aim - starDir)) ? 'port' : 'starboard';
}

/**
 * Весь план разом: режет по бюджету хода и переводит каждое намерение в action.
 * Ничего НЕ применяет — только готовит. Применение (и повторная валидация каждого
 * действия уже изменившимся миром) живёт в captain.js.
 */
export function planToActions(game, pIdx, plan, apply = null) {
  const budget = isRealtime(game) ? MOVES_PER_TURN : movesBudget(game.config);
  const items = Array.isArray(plan?.actions) ? plan.actions.slice(0, budget) : [];
  const out = [];
  for (const item of items) {
    // ВАЖНО: намерение переводится в действие ПЕРЕД самым применением. Первый приказ
    // сдвинул корабль — второй обязан считаться по новой позиции, иначе штурман
    // прокладывает курс по вчерашней карте и игра отвергает ход.
    const step = { item, ...toAction(game, pIdx, item) };
    if (step.ok && apply) {
      const res = apply(step.action) || {};
      step.applied = !!res.ok;
      if (!res.ok) {
        step.ok = false;
        step.error = res.error || 'игра отклонила действие';
        step.ended = !!res.ended;   // ход закончился сам — остаток плана просто не нужен
      }
    }
    out.push(step);
    if (step.ended) break;
  }
  return {
    plan: typeof plan?.plan === 'string' ? plan.plan.slice(0, 400) : '',
    taunt: typeof plan?.taunt === 'string' ? plan.taunt.replace(/[\n\r]/g, ' ').slice(0, 100) : '',
    steps: out,
    dropped: Array.isArray(plan?.actions) ? Math.max(0, plan.actions.length - budget) : 0
  };
}
