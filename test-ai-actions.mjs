// 🧭 Этап 2: слой действий ИИ (server/ai/actions.js).
// Главный критерий: ЛЮБОЕ намерение модели превращается либо в действие, которое
// applyAction принимает без единой ошибки, либо в понятный текст ошибки для ретрая.
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { SHIP_TYPES, CELL, OUTPOST_LEVELS, MOVES_PER_TURN, windMoveMult } from './server/config.js';
import { aliasOf, cellCenter, cellOf, inCells } from './server/ai/perception.js';
import { TOOLS, TURN_TOOL, ACTION_TYPES, resolveTarget, navigate, toAction, planToActions } from './server/ai/actions.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };

function game(mode = 'classic', n = 2) {
  const g = createGame('ai', { maxPlayers: n, turnTimer: 0, seed: 7 });
  g.config.mode = mode; g.config.fog = true; g.config.multiMove = true;
  for (let i = 0; i < n; i++) addPlayer(g, 'p' + i, 'Игрок' + i);
  startGame(g, 'p0');
  g.ships = [];
  g.wind = { ang: 0, str: 0, targetAng: 0, targetStr: 0 }; // штиль: расчёты предсказуемы
  return g;
}
const put = (g, owner, type, x, y, extra = {}) => {
  const s = { id: `${owner}_${type}_${Math.round(x)}_${Math.round(y)}`, owner, type, x, y, hp: SHIP_TYPES[type]?.hp ?? 80, ...extra };
  g.ships.push(s); return s;
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ─── Схема инструмента ───────────────────────────────────────────────────────
{
  check('инструмент один — весь ход разом', TOOLS.length === 1 && TURN_TOOL.name === 'submit_turn');
  const props = TURN_TOOL.input_schema.properties;
  check('схема требует plan и actions', TURN_TOOL.input_schema.required.join(',') === 'plan,actions');
  check('схема плоская (без oneOf/anyOf — совместимость провайдеров)', !JSON.stringify(TURN_TOOL).match(/"(oneOf|anyOf|allOf)"/));
  check('у каждого поля действия есть описание',
    Object.values(props.actions.items.properties).every(p => typeof p.description === 'string' && p.description.length > 10));
  check('enum типов действий совпадает с ACTION_TYPES',
    props.actions.items.properties.type.enum.join(',') === ACTION_TYPES.join(','));
  check('в описании назван лимит действий', props.actions.description.includes(String(MOVES_PER_TURN)));
}

// ─── Адреса ──────────────────────────────────────────────────────────────────
{
  const g = game();
  const my = put(g, 0, 'fregat', 500, 500);
  const foe = put(g, 1, 'brig', 700, 500);
  aliasOf(g, 0, my); aliasOf(g, 0, foe);
  const c = resolveTarget(g, 0, '12,7');
  check('адрес-клетка', c?.kind === 'cell' && cellOf(c.x, c.y).c === 12 && cellOf(c.x, c.y).r === 7);
  check('адрес-клетка терпит пробелы', resolveTarget(g, 0, '12 , 7')?.kind === 'cell');
  check('адрес порта PORT1', resolveTarget(g, 0, 'PORT1')?.idx === 1);
  check('адрес острова I0', resolveTarget(g, 0, 'I0')?.kind === 'island');
  check('адрес рыбного места F0', resolveTarget(g, 0, 'F0')?.kind === 'fish');
  check('адрес своего корабля M1', resolveTarget(g, 0, 'M1')?.ship?.id === my.id);
  check('адрес чужого корабля E1', resolveTarget(g, 0, 'e1')?.ship?.id === foe.id);
  check('несуществующий остров → null', resolveTarget(g, 0, 'I99') === null);
  check('мусор → null', resolveTarget(g, 0, 'плыви туда не знаю куда') === null);
}

// ─── Штурман: клампит по дальности, обходит препятствия ──────────────────────
{
  const g = game();
  const s = put(g, 0, 'linkor', 400, 600);           // ход 90 единиц = 2.25 клетки
  const far = navigate(g, 0, s, 1400, 600, 0);
  check('штурман: дальняя цель — идём на дальность хода, не дальше',
    far && Math.hypot(far.x - s.x, far.y - s.y) <= SHIP_TYPES.linkor.move + 0.5,
    `${Math.round(Math.hypot(far.x - s.x, far.y - s.y))} ед. при ходе ${SHIP_TYPES.linkor.move}`);
  check('штурман: курс сохраняется (идём в сторону цели)', far && far.x > s.x && Math.abs(far.y - s.y) < 30);
  const near = navigate(g, 0, s, 450, 600, 0);
  check('штурман: близкая цель — встаём на ней', near && Math.hypot(near.x - 450, near.y - 600) < 5);
  check('штурман: «уже на месте» → null', navigate(g, 0, s, s.x, s.y, 0) === null);
  check('штурман: keep_distance держит дистанцию',
    (() => { const p = navigate(g, 0, s, 500, 600, 1); return p && Math.abs(Math.hypot(p.x - 500, p.y - 600) - CELL) < 6; })());
  // сосед вплотную не должен получить таран
  const other = put(g, 0, 'brig', 450, 600);
  const pt = navigate(g, 0, s, 460, 600, 0);
  check('штурман: не встаёт на чужой корпус', !pt || Math.hypot(pt.x - other.x, pt.y - other.y) >= 20, JSON.stringify(pt));
}
{ // остров на пути — в него не встаём
  const g = game();
  const isl = g.map.lootIslands[0];
  const s = put(g, 0, 'shkhuna', isl.x - 200, isl.y);
  const pt = navigate(g, 0, s, isl.x, isl.y, 0);
  check('штурман: в остров не въезжаем', !pt || Math.hypot(pt.x - isl.x, pt.y - isl.y) > isl.radius, JSON.stringify(pt));
}
{ // ветер: по ветру дальше, против — короче
  const g = game();
  g.wind = { ang: 0, str: 1, targetAng: 0, targetStr: 1 };           // дует на восток в полную силу
  const s = put(g, 0, 'brig', 800, 600);
  const east = navigate(g, 0, s, 1500, 600, 0);
  const west = navigate(g, 0, s, 100, 600, 0);
  check('🌬 по ветру уходим дальше, чем против',
    Math.hypot(east.x - s.x, east.y - s.y) > Math.hypot(west.x - s.x, west.y - s.y),
    `${Math.round(Math.hypot(east.x - s.x, east.y - s.y))} против ${Math.round(Math.hypot(west.x - s.x, west.y - s.y))}`);
  check('🌬 попутный ход не превышает разрешённого игрой',
    Math.hypot(east.x - s.x, east.y - s.y) <= SHIP_TYPES.brig.move * windMoveMult(g.wind, 0) + 0.5);
}

// ─── sail ────────────────────────────────────────────────────────────────────
{
  const g = game();
  const s = put(g, 0, 'fregat', 500, 500);
  const foe = put(g, 1, 'brig', 1100, 500);
  aliasOf(g, 0, s); aliasOf(g, 0, foe);
  const r = toAction(g, 0, { type: 'sail', ship: 'M1', to: '20,13' });
  check('sail в клетку → move', r.ok && r.action.type === 'move' && r.action.shipId === s.id, r.error || '');
  check('sail: применяется без ошибки', applyAction(g, 'p0', r.action).ok);

  const busy = toAction(g, 0, { type: 'sail', ship: 'M1', to: 'E1' });
  check('корабль, уже сходивший в этом ходу, дальше не идёт (и это объяснено)',
    !busy.ok && busy.error.includes('уже действовал'), busy.error || '');

  const g2 = game();
  const s2 = put(g2, 0, 'fregat', 500, 500);
  const foe2 = put(g2, 1, 'brig', 1100, 500);
  aliasOf(g2, 0, s2); aliasOf(g2, 0, foe2);
  const r2 = toAction(g2, 0, { type: 'sail', ship: 'M1', to: 'E1', keep_distance: 3 });
  check('sail к врагу с дистанцией → move', r2.ok && r2.action.type === 'move', r2.error || '');
  const r3 = toAction(g2, 0, { type: 'sail', ship: 'M9', to: '10,10' });
  check('sail: неизвестный корабль → ошибка со списком своих', !r3.ok && r3.error.includes('M1'), r3.error);
  const r4 = toAction(g2, 0, { type: 'sail', ship: 'M1', to: 'куда глаза глядят' });
  check('sail: непонятная цель → подсказка формата', !r4.ok && r4.error.includes('12,7'), r4.error);
}
{ // к острову подходим ВПЛОТНУЮ к берегу, а не в центр
  const g = game();
  const isl = g.map.lootIslands[0];
  const s = put(g, 0, 'shkhuna', isl.x - 250, isl.y);
  const r = toAction(g, 0, { type: 'sail', ship: 'M1', to: 'I0' });
  check('sail к острову: получилось действие', r.ok, r.error || '');
  check('sail к острову: применяется', r.ok && applyAction(g, 'p0', r.action).ok);
  check('sail к острову: встали снаружи берега', Math.hypot(s.x - isl.x, s.y - isl.y) > isl.radius);
}

// ─── broadside ───────────────────────────────────────────────────────────────
{
  const g = game();
  const s = put(g, 0, 'fregat', 500, 500, { heading: 0 });
  const foe = put(g, 1, 'shkhuna', 500, 600);            // справа по борту
  aliasOf(g, 0, s); aliasOf(g, 0, foe);
  const r = toAction(g, 0, { type: 'broadside', ship: 'M1', target: 'E1' });
  check('broadside → залп с автовыбором борта', r.ok && r.action.type === 'broadside', r.error || '');
  const hpBefore = foe.hp;
  check('broadside применяется', applyAction(g, 'p0', r.action).ok);
  check('broadside реально бьёт по цели', g.ships.find(x => x.id === foe.id).hp < hpBefore);

  const g2 = game();
  const s2 = put(g2, 0, 'fregat', 500, 500, { heading: 0 });
  put(g2, 1, 'shkhuna', 1400, 1000);                     // далеко
  aliasOf(g2, 0, s2); aliasOf(g2, 0, g2.ships[1]);
  const r2 = toAction(g2, 0, { type: 'broadside', ship: 'M1', target: 'E1' });
  check('broadside без целей → внятная ошибка', !r2.ok && r2.error.includes('целей в радиусе нет'), r2.error);

  const g3 = game();
  const s3 = put(g3, 0, 'fregat', 500, 500, { heading: 0 });
  const side = put(g3, 1, 'shkhuna', 500, 600);          // с борта — попадёт
  const nose = put(g3, 1, 'brig', 620, 500);             // по носу — не попадёт
  aliasOf(g3, 0, s3); aliasOf(g3, 0, side); aliasOf(g3, 0, nose);
  const r3 = toAction(g3, 0, { type: 'broadside', ship: 'M1', target: 'E2' });
  check('broadside по носовой цели → объясняем, что бортом не достать',
    !r3.ok && r3.error.includes('нос'), r3.error || '');
  const r4 = toAction(g3, 0, { type: 'broadside', ship: 'M1', target: 'E1' });
  check('broadside по бортовой цели: борт подбирается сам', r4.ok && applyAction(g3, 'p0', r4.action).ok, r4.error || '');
}

// ─── mortar ──────────────────────────────────────────────────────────────────
{
  const g = game();
  const fr = put(g, 0, 'fregat', 500, 500, { heading: 0 });
  const sh = put(g, 0, 'shkhuna', 520, 540, { heading: 0 });
  const foe = put(g, 1, 'brig', 600, 500);
  [fr, sh, foe].forEach(x => aliasOf(g, 0, x));
  const r = toAction(g, 0, { type: 'mortar', ship: 'M1', target: 'E1' });
  check('mortar по кораблю → attack', r.ok && r.action.targetType === 'ship', r.error || '');
  check('mortar применяется', applyAction(g, 'p0', r.action).ok);
  const r2 = toAction(g, 0, { type: 'mortar', ship: 'M2', target: 'E1' });
  check('mortar у шхуны → ошибка с подсказкой про залп', !r2.ok && r2.error.includes('бортовой залп'), r2.error);
  const g2 = game();
  const fr2 = put(g2, 0, 'fregat', 300, 300, { heading: 0 });
  const far = put(g2, 1, 'brig', 1200, 900);
  aliasOf(g2, 0, fr2); aliasOf(g2, 0, far);
  const r3 = toAction(g2, 0, { type: 'mortar', ship: 'M1', target: 'E1' });
  check('mortar вне дальности → ошибка с дистанцией', !r3.ok && r3.error.includes('кл'), r3.error);
}
{ // порт и чужой аванпост
  const g = game();
  const base = g.map.bases[1];
  const lk = put(g, 0, 'linkor', base.x - 160, base.y, { heading: 0 });
  aliasOf(g, 0, lk);
  const r = toAction(g, 0, { type: 'mortar', ship: 'M1', target: 'PORT1' });
  check('mortar по PORT1 → attack port', r.ok && r.action.targetType === 'port' && r.action.targetId === 1, r.error || '');
  check('mortar по порту применяется', applyAction(g, 'p0', r.action).ok);
  check('mortar по своему порту запрещён', !toAction(g, 0, { type: 'mortar', ship: 'M1', target: 'PORT0' }).ok);

  const g2 = game();
  const isl = g2.map.lootIslands[0];
  isl.looted = true; isl.outpost = { owner: 1, level: 1, hp: OUTPOST_LEVELS[0].hp };
  const lk2 = put(g2, 0, 'linkor', isl.x - 150, isl.y, { heading: 0 });
  aliasOf(g2, 0, lk2);
  const r2 = toAction(g2, 0, { type: 'mortar', ship: 'M1', target: 'I0' });
  check('mortar по чужому аванпосту → attack outpost', r2.ok && r2.action.targetType === 'outpost', r2.error || '');
  check('mortar по аванпосту применяется', applyAction(g2, 'p0', r2.action).ok);
  const g3 = game();
  const lk3 = put(g3, 0, 'linkor', g3.map.lootIslands[0].x - 150, g3.map.lootIslands[0].y, { heading: 0 });
  aliasOf(g3, 0, lk3);
  check('mortar по острову без постройки → ошибка', !toAction(g3, 0, { type: 'mortar', ship: 'M1', target: 'I0' }).ok);
}

// ─── buy ─────────────────────────────────────────────────────────────────────
{
  const g = game();
  g.players[0].gold = 400;
  const r = toAction(g, 0, { type: 'buy', ships: ['brig', 'brig', 'linkor'] });
  check('buy: режем по казне, а не валим ход', r.ok && r.action.ships.length === 1 && !!r.note, r.note || '');
  check('buy: покупка применяется', applyAction(g, 'p0', r.action).ok);
  check('buy: неизвестный тип → ошибка со списком', !toAction(g, 0, { type: 'buy', ships: ['авианосец'] }).ok);
  check('buy: чит-корабль купить нельзя', !toAction(g, 0, { type: 'buy', ships: ['carrier'] }).ok);
  check('buy: пустой список → ошибка', !toAction(g, 0, { type: 'buy', ships: [] }).ok);
  g.players[0].gold = 10;
  check('buy: совсем нет денег → ошибка с суммой', (() => { const e = toAction(g, 0, { type: 'buy', ships: ['linkor'] }); return !e.ok && e.error.includes('500'); })());
}

// ─── outpost / collect / repair / recharge ───────────────────────────────────
{
  const g = game();
  const isl = g.map.lootIslands[0];
  isl.looted = true;
  g.players[0].gold = 1000;
  const builder = put(g, 0, 'shkhuna', isl.x + isl.radius + 30, isl.y);
  aliasOf(g, 0, builder);
  const r = toAction(g, 0, { type: 'outpost', island: 'I0' });
  check('outpost: строителя находим сами', r.ok && r.action.shipId === builder.id, r.error || '');
  check('outpost: постройка применяется', applyAction(g, 'p0', r.action).ok);
  const r2 = toAction(g, 0, { type: 'outpost', island: 'I0' });
  check('outpost: апгрейд без корабля', r2.ok && !r2.action.shipId, r2.error || '');
  const g2 = game();
  g2.map.lootIslands[0].looted = true;
  g2.players[0].gold = 1000;
  check('outpost: без корабля у берега → ошибка с подсказкой',
    (() => { const e = toAction(g2, 0, { type: 'outpost', island: 'I0' }); return !e.ok && e.error.includes('подплыви'); })());
  g2.players[0].gold = 10;
  put(g2, 0, 'shkhuna', g2.map.lootIslands[0].x + g2.map.lootIslands[0].radius + 30, g2.map.lootIslands[0].y);
  check('outpost: не хватает золота → ошибка с ценой',
    (() => { const e = toAction(g2, 0, { type: 'outpost', island: 'I0' }); return !e.ok && e.error.includes(String(OUTPOST_LEVELS[0].price)); })());
}
{
  const g = game();
  const rep = put(g, 0, 'repair', 500, 500, { repairCharges: 8 });
  const hurt = put(g, 0, 'brig', 560, 500, { hp: 40 });
  aliasOf(g, 0, rep); aliasOf(g, 0, hurt);
  const r = toAction(g, 0, { type: 'repair', ship: 'M1', target: 'M2' });
  check('repair → действие ремонта', r.ok && r.action.type === 'repair', r.error || '');
  check('repair применяется', applyAction(g, 'p0', r.action).ok);
  check('repair чужого → ошибка', !toAction(g, 0, { type: 'repair', ship: 'M1', target: 'PORT1' }).ok);
  check('repair не-ремонтником → ошибка', !toAction(g, 0, { type: 'repair', ship: 'M2', target: 'M1' }).ok);
  const rr = toAction(g, 0, { type: 'recharge', ship: 'M1' });
  check('recharge → действие', rr.ok && rr.action.type === 'recharge');
  check('collect → действие', toAction(g, 0, { type: 'collect' }).action.type === 'collect');
  check('end_turn → skip', toAction(g, 0, { type: 'end_turn' }).action.type === 'skip');
  check('неизвестный тип → ошибка со списком допустимых',
    (() => { const e = toAction(g, 0, { type: 'телепортация' }); return !e.ok && e.error.includes('sail'); })());
}

// ─── План целиком ────────────────────────────────────────────────────────────
{
  const g = game();
  const a = put(g, 0, 'fregat', 500, 500, { heading: 0 });
  const b = put(g, 0, 'brig', 560, 560, { heading: 0 });
  const c = put(g, 0, 'shkhuna', 620, 620, { heading: 0 });
  [a, b, c].forEach(x => aliasOf(g, 0, x));
  const res = planToActions(g, 0, {
    plan: 'Давим центр, копим на линкор.',
    taunt: 'Держись,\nсалага!',
    actions: [
      { type: 'sail', ship: 'M1', to: '16,12', why: 'к центру' },
      { type: 'sail', ship: 'M2', to: '16,14' },
      { type: 'sail', ship: 'M3', to: '18,18' },
      { type: 'sail', ship: 'M1', to: '18,12' }   // четвёртое — сверх бюджета
    ]
  }, action => applyAction(g, 'p0', action));
  check('план: режем по бюджету хода', res.steps.length === MOVES_PER_TURN && res.dropped === 1, `${res.steps.length}, лишних ${res.dropped}`);
  check('план: реплика без переводов строк', !res.taunt.includes('\n') && res.taunt.length <= 100, JSON.stringify(res.taunt));
  check('план: цель сохранена', res.plan.startsWith('Давим центр'));
  check('план: все действия приняты игрой (пересчёт по живому состоянию)',
    res.steps.every(st => st.applied), res.steps.map(st => st.ok ? 'ok' : st.error).join(' | '));

  const stuck = toAction(g, 0, { type: 'sail', ship: 'M3', to: `${cellOf(g.ships.find(x => x.type === 'shkhuna').x, g.ships.find(x => x.type === 'shkhuna').y).c},${cellOf(g.ships.find(x => x.type === 'shkhuna').x, g.ships.find(x => x.type === 'shkhuna').y).r}` });
  check('sail в клетку, где корабль уже стоит → отдельная понятная ошибка', !stuck.ok && stuck.error.includes('уже стоит'), stuck.error || '');

  const empty = planToActions(g, 0, { plan: '', actions: [] });
  check('пустой план → пустой список шагов (= пропуск хода)', empty.steps.length === 0);
  const junk = planToActions(g, 0, null);
  check('мусор вместо плана не роняет навигатор', junk.steps.length === 0 && junk.plan === '');
}

// ─── Итоговая гарантия: ok-шаг всегда принимается игрой ─────────────────────
{
  const g = game();
  const fr = put(g, 0, 'fregat', 500, 500, { heading: 0 });
  const foe = put(g, 1, 'shkhuna', 500, 600);
  aliasOf(g, 0, fr); aliasOf(g, 0, foe);
  g.players[0].gold = 600;
  const intents = [
    { type: 'sail', ship: 'M1', to: 'E1', keep_distance: 2 },
    { type: 'broadside', ship: 'M1', target: 'E1' },
    { type: 'mortar', ship: 'M1', target: 'E1' },
    { type: 'buy', ships: ['shkhuna'] },
    { type: 'collect' },
    { type: 'end_turn' },
    { type: 'sail', ship: 'НЕТ ТАКОГО', to: '5,5' },
    { type: 'mortar', ship: 'M1', target: 'PORT9' },
  ];
  let good = 0, bad = 0, lied = 0;
  for (const it of intents) {
    const r = toAction(g, 0, it);
    if (!r.ok) { bad++; if (!r.error || r.error.length < 10) lied++; continue; }
    good++;
    // каждое «ok» проверяем на свежей копии партии, чтобы шаги не мешали друг другу
    const probe = JSON.parse(JSON.stringify(g));
    const res = applyAction(probe, 'p0', r.action);
    if (!res.ok) { lied++; console.error('   игра отвергла', JSON.stringify(r.action), '→', res.error); }
  }
  check('каждое ok-намерение принято игрой, каждое не-ok объяснено', lied === 0, `принято ${good}, отклонено ${bad}`);
}

console.log(`\nИтого действия ИИ: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
