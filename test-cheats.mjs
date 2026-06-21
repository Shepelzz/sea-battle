// Читы тестового режима + залп авианосца. Коды читов — только на сервере (server/cheats.js),
// тут проверяем их применение и поведение чит-корабля (волей из 5 снарядов).
import { createGame, addPlayer, startGame, applyAction, publicState } from './server/game.js';
import { applyCheat } from './server/cheats.js';
import { SHIP_TYPES, CHEATS_ENABLED } from './server/config.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++) : (fail++, console.error('✗', n, extra)); };
const eq = (n, got, want) => check(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

function setup() {
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0, seed: 4242 });
  addPlayer(g, 'A', 'Алиса');
  addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  g.ships = [];
  g.map.lootIslands = [];
  return g;
}
const put = (g, owner, type, x, y, hp) =>
  (g.ships.push({ id: `${owner}_${type}_${x}_${y}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp, maxHp: SHIP_TYPES[type].hp }), g.ships.at(-1));

// === Характеристики чит-авианосца ===
const C = SHIP_TYPES.carrier;
eq('carrier.move (7 клеток)', C.move, 280);
eq('carrier.fireRange (8 клеток)', C.fireRange, 320);
eq('carrier.dmg (как линкор)', C.dmg, SHIP_TYPES.linkor.dmg);
eq('carrier.hp (×5 линкора)', C.hp, SHIP_TYPES.linkor.hp * 5);
eq('carrier.volley', C.volley, 5);
eq('carrier.cheat', C.cheat, true);

// === Применение читов работает ТОЛЬКО в тестовом режиме (CHEATS_ENABLED) ===
if (CHEATS_ENABLED) {
// === motherlode: +1000 золота ===
{
  const g = setup();
  const before = g.players[0].gold;
  const r = applyCheat(g, 0, 'motherlode');
  check('motherlode ок', r.ok && r.broadcast, JSON.stringify(r));
  eq('motherlode +1000', g.players[0].gold, before + 1000);
}
// регистр не важен
{
  const g = setup();
  const before = g.players[0].gold;
  applyCheat(g, 0, '  MotherLode ');
  eq('motherlode без учёта регистра/пробелов', g.players[0].gold, before + 1000);
}

// === geraldford: спавнит авианосец у базы ===
{
  const g = setup();
  const r = applyCheat(g, 0, 'geraldford');
  check('geraldford ок', r.ok && r.broadcast, JSON.stringify(r));
  const mine = g.ships.filter(s => s.owner === 0 && s.type === 'carrier');
  eq('заспавнен 1 авианосец игрока 0', mine.length, 1);
  eq('у авианосца полный HP 1400', mine[0]?.hp, 1400);
  // спавн НЕ пишет сообщение в журнал
  check('журнал без записи про подкрепление/авианосец',
    !g.log.some(l => /подкреплени|авианосец/i.test(l.text)), g.log.map(l => l.text).join(' | '));
}
// === лимит: не больше одного авианосца на игрока ===
{
  const g = setup();
  applyCheat(g, 0, 'geraldford');
  const r2 = applyCheat(g, 0, 'geraldford');           // второй раз тем же игроком — нельзя
  check('второй авианосец не выдаётся', !r2.ok, JSON.stringify(r2));
  eq('у игрока остаётся ровно 1 авианосец', g.ships.filter(s => s.owner === 0 && s.type === 'carrier').length, 1);
  // лимит — ПО ИГРОКУ: другой игрок свой авианосец получить может
  const r3 = applyCheat(g, 1, 'geraldford');
  check('другой игрок получает свой авианосец', r3.ok, JSON.stringify(r3));
  eq('у второго игрока 1 авианосец', g.ships.filter(s => s.owner === 1 && s.type === 'carrier').length, 1);
}

// === nofog: клиентский эффект, состояние игры не трогает ===
{
  const g = setup();
  const shipsBefore = g.ships.length, goldBefore = g.players[0].gold;
  const r = applyCheat(g, 0, 'nofog');
  check('nofog ок + effect toggleFog', r.ok && r.effect === 'toggleFog', JSON.stringify(r));
  check('nofog не трогает состояние', g.ships.length === shipsBefore && g.players[0].gold === goldBefore);
  check('nofog без broadcast', !r.broadcast, JSON.stringify(r));
}
} else {
  // тестовый режим ВЫКЛЮЧЕН (CHEATS_ENABLED=false): распознанные коды отклоняются («Сейчас недоступно»),
  // состояние игры не меняется. (Не-команды по-прежнему возвращают null → уходят в чат — проверяется ниже.)
  const g = setup();
  const before = g.players[0].gold;
  check('читы выкл: motherlode отклонён', applyCheat(g, 0, 'motherlode')?.ok === false);
  eq('читы выкл: золото не начислено', g.players[0].gold, before);
  check('читы выкл: geraldford отклонён', applyCheat(g, 0, 'geraldford')?.ok === false);
  eq('читы выкл: авианосец не заспавнен', g.ships.filter(s => s.type === 'carrier').length, 0);
  check('читы выкл: nofog отклонён', applyCheat(g, 0, 'nofog')?.ok === false);
}

// === не-команда → applyCheat возвращает null (текст уйдёт в чат, не в команды) ===
{
  const g = setup();
  eq('обычный текст → null (это чат, не команда)', applyCheat(g, 0, 'привет всем'), null);
  eq('неизвестное слово → null', applyCheat(g, 0, 'iddqd'), null);
}

// === Залп авианосца: 5 снарядов, урон ×5 ===
{
  const g = setup();
  const me = put(g, 0, 'carrier', 760, 600);
  const foe = put(g, 1, 'carrier', 900, 600); // в радиусе огня (140 ≤ 320), живучий (1400)
  const before = foe.hp;
  const r = applyAction(g, 'A', { type: 'attack', shipId: me.id, targetType: 'ship', targetId: foe.id });
  check('атака авианосца ок', r.ok, JSON.stringify(r));
  eq('урон по цели = 5×65', before - foe.hp, 325);
  eq('ровно 5 событий-выстрелов', g.events.filter(e => e.type === 'shot').length, 5);
  eq('damageDealt += 325', g.players[0].stats.damageDealt, 325);
}

// === Бриг теперь НЕ умеет мортиру (только бортовой залп) ===
{
  const g = setup();
  const me = put(g, 0, 'brig', 760, 600);
  const foe = put(g, 1, 'linkor', 850, 600);
  const r = applyAction(g, 'A', { type: 'attack', shipId: me.id, targetType: 'ship', targetId: foe.id });
  check('бриг не может мортиру (только фрегат/линкор)', r.ok === false, JSON.stringify(r));
  check('HP цели не изменилось', foe.hp === SHIP_TYPES.linkor.hp);
}

// === Залп авианосца (чит): КРУГОВОЙ — бьёт всех врагов в радиусе (без сектора) ===
{
  const g = setup();
  const me = put(g, 0, 'carrier', 760, 600);
  const a = put(g, 1, 'shkhuna', 820, 600);     // в радиусе (320), восток
  const b = put(g, 1, 'brig', 760, 760, 110);   // в радиусе, ЮГ (круговой достаёт другую сторону)
  const far = put(g, 1, 'shkhuna', 1500, 1150); // вне радиуса
  const r = applyAction(g, 'A', { type: 'broadside', shipId: me.id, tx: 820, ty: 600 });
  check('залп авианосца проходит', r.ok, JSON.stringify(r));
  const ev = g.events.find(e => e.type === 'volley');
  check('событие volley, full=true (круговой)', ev && ev.full === true, JSON.stringify(ev));
  check('круговой залп задел обе цели в радиусе', a.hp < SHIP_TYPES.shkhuna.hp && b.hp < 110, `(a ${a.hp}, b ${b.hp})`);
  eq('дальняя цель не задета', far.hp, SHIP_TYPES.shkhuna.hp);
}
// === Авианосец валит и рыбацкие баркасы ===
{
  const g = setup();
  const me = put(g, 0, 'carrier', 760, 600);
  const bk = put(g, 1, 'barkas', 820, 600);
  const r = applyAction(g, 'A', { type: 'broadside', shipId: me.id, tx: 820, ty: 600 });
  check('залп авианосца задевает баркас', r.ok && bk.hp < SHIP_TYPES.barkas.hp, JSON.stringify(r));
}

// === publicState отдаёт carrier клиенту ТОЛЬКО в тестовом режиме (иначе ни следа) ===
{
  const g = setup();
  const st = publicState(g, 'A').shipTypes;
  check(
    CHEATS_ENABLED ? 'carrier виден клиенту при включённых читах' : 'carrier скрыт от клиента при выключенных читах',
    CHEATS_ENABLED ? !!st.carrier : !st.carrier,
    Object.keys(st).join(','));
}

console.log(`\nИтого читы/авианосец: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
