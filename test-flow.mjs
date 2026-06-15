// E2E-прогон: создание игры, лобби, ходы, бой до победы.
import { io } from 'socket.io-client';

const BASE = process.env.SB_URL || 'http://127.0.0.1:3456';
const fail = msg => { console.error('❌ ' + msg); process.exit(1); };
const ok = msg => console.log('✅ ' + msg);

const res = await fetch(BASE + '/api/games', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: 'tokA', nick: 'Алиса', maxPlayers: 2, turnTimer: 0 })
});
const { gameId } = await res.json();
if (!gameId) fail('игра не создалась');
ok('игра создана: ' + gameId);

function connect(token, nick) {
  return new Promise((resolve, reject) => {
    const s = io(BASE);
    const ctx = { socket: s, state: null, id: null };
    s.on('state', st => { ctx.state = st; });
    s.on('connect', () => {
      s.emit('join', { gameId, token, nick }, r => r.ok ? (ctx.id = r.playerId, resolve(ctx)) : reject(new Error(r.error)));
    });
  });
}
const emit = (ctx, ev, arg) => new Promise(r => arg !== undefined ? ctx.socket.emit(ev, arg, r) : ctx.socket.emit(ev, r));
const wait = ms => new Promise(r => setTimeout(r, ms));

const A = await connect('tokA', 'Алиса');
const B = await connect('tokB', 'Боб');
await wait(300);
if (A.state.players.length !== 2) fail('в лобби не 2 игрока');
ok('оба игрока в лобби');

// чужой не может начать
let r = await emit(B, 'start');
if (r.ok) fail('Боб смог начать чужую игру');
ok('начать может только создатель');

r = await emit(A, 'start');
if (!r.ok) fail('старт не удался: ' + r.error);
await wait(300);
if (A.state.status !== 'active') fail('игра не активна');
const playerShips = A.state.ships.filter(s => s.owner >= 0);
const pirates = A.state.ships.filter(s => s.owner === -1);
if (playerShips.length !== 6) fail('ожидалось 6 стартовых кораблей, есть ' + playerShips.length);
if (!pirates.length) fail('пираты не заспавнились');
if (pirates.some(p => !p.bounty || p.bounty < 80)) fail('у пиратов нет награды');
if (!A.state.map.lootIslands.length) fail('нет лут-островов');
if (A.state.map.fishZones.length < 2) fail('мало рыбных мест');
ok(`карта: ${A.state.map.lootIslands.length} лут-островов, ${A.state.map.fishZones.length} рыбных мест, ${pirates.length} пиратов`);

// «поторопить»: нельзя торопить, когда твой ход; можно — когда ход соперника
let rn = await emit(A, 'nudge');
if (rn.ok) fail('Алиса поторопила саму себя');
rn = await emit(B, 'nudge');
if (!rn.ok) fail('Боб не смог поторопить: ' + rn.error);
await wait(200);
const dl = A.state.turn.deadline - Date.now();
if (dl < 9 * 60_000 || dl > 10 * 60_000) fail('дедлайн после nudge неверный: ' + dl);
rn = await emit(B, 'nudge');
if (rn.ok) fail('повторный nudge прошёл');
ok('«поторопить» работает: 10 минут на ход, повтор запрещён');

// не свой ход
r = await emit(B, 'action', { type: 'skip' });
if (r.ok) fail('Боб сходил вне очереди');
ok('ход вне очереди отклонён');

// Алиса покупает баркас
r = await emit(A, 'action', { type: 'buy', ships: ['barkas'] });
if (!r.ok) fail('покупка не удалась: ' + r.error);
await wait(200);
const alice = A.state.players[0];
if (alice.gold !== 250 - 60) fail('золото после покупки неверное: ' + alice.gold);
if (A.state.ships.filter(s => s.owner === 0).length !== 4) fail('баркас не появился');
ok('покупка работает, золото списано: ' + alice.gold);

// слишком дорогая покупка
r = await emit(B, 'action', { type: 'buy', ships: ['linkor'] });
if (r.ok) fail('Боб купил линкор без денег');
ok('покупка без денег отклонена');
r = await emit(B, 'action', { type: 'skip' });
if (!r.ok) fail('скип не сработал');

// движение: слишком далеко
await wait(200);
let ship = A.state.ships.find(s => s.owner === 0 && s.type === 'shkhuna');
r = await emit(A, 'action', { type: 'move', shipId: ship.id, x: ship.x + 500, y: ship.y });
if (r.ok) fail('корабль уплыл дальше линейки');
ok('движение дальше линейки отклонено');

// движение: нормальное
r = await emit(A, 'action', { type: 'move', shipId: ship.id, x: ship.x + 120, y: ship.y + 60 });
if (!r.ok) fail('обычное движение не удалось: ' + r.error);
ok('движение по линейке работает');

// чужим кораблём ходить нельзя
await wait(200);
const bobShip = B.state.ships.find(s => s.owner === 1);
r = await emit(B, 'action', { type: 'move', shipId: ship.id, x: 800, y: 600 });
if (r.ok) fail('Боб подвинул корабль Алисы');
ok('чужой корабль двигать нельзя');
r = await emit(B, 'action', { type: 'skip' });

// телепорт кораблей для проверки боя (читерим напрямую нельзя — стреляем издалека: должно отклониться)
await wait(200);
ship = A.state.ships.find(s => s.owner === 0 && s.type === 'fregat');
const target = B.state.ships.find(s => s.owner === 1);
r = await emit(A, 'action', { type: 'attack', shipId: ship.id, targetType: 'ship', targetId: target.id });
if (r.ok) fail('выстрел через всю карту прошёл');
ok('выстрел вне дальности отклонён');

// сбор: проверяем согласованность с состоянием карты
await wait(200);
{
  const st = A.state;
  const canCollect =
    st.ships.some(s => s.owner === 0 && st.shipTypes[s.type].fishing > 0 &&
      st.map.fishZones.some(z => Math.hypot(s.x - z.x, s.y - z.y) <= z.radius)) ||
    st.map.lootIslands.some(isl => !isl.looted && st.ships.some(s => s.owner === 0 &&
      Math.hypot(s.x - isl.x, s.y - isl.y) <= isl.radius + 55));
  const goldBefore = st.players[0].gold;
  r = await emit(A, 'action', { type: 'collect' });
  if (r.ok !== canCollect) fail(`сбор: ожидали ${canCollect}, получили ${r.ok}`);
  if (r.ok) {
    await wait(200);
    if (A.state.players[0].gold <= goldBefore) fail('сбор прошёл, но золото не выросло');
    // ход ушёл — вернём очередь Алисе пропуском Боба
    await emit(B, 'action', { type: 'skip' });
  }
  ok('сбор добычи согласован с картой (' + (canCollect ? 'добыча была и собрана' : 'пустой сбор отклонён') + ')');
}

// гоняем бой: двигаем фрегат Алисы к базе Боба и проверяем механику осады
// (порт прочный — 840 HP — и огрызается; одиночный фрегат базу не валит by design,
//  полный снос порта до победы покрыт симулятором sim.mjs. Тут проверяем урон по
//  порту + ответный огонь, а победу/статы — через сдачу Боба ниже.)
console.log('— марш к базе Боба и осада порта —');
let turns = 0, portShots = 0;
let portHpAtFirstShot = null, fregatHpAtFirstShot = null;
while (A.state.status === 'active' && turns < 400 && portShots < 4) {
  turns++;
  const st = A.state;
  if (st.turn.idx === 0) {
    const fregat = st.ships.find(s => s.owner === 0 && s.type === 'fregat');
    if (!fregat) fail('фрегат Алисы пропал ещё до осады');
    const enemyBase = st.map.bases[1];
    const d = Math.hypot(fregat.x - enemyBase.x, fregat.y - enemyBase.y);
    const fireReach = st.shipTypes.fregat.fireRange + enemyBase.radius * 0.5;
    if (d <= fireReach) {
      if (portShots === 0) { portHpAtFirstShot = st.players[1].portHp; fregatHpAtFirstShot = fregat.hp; }
      r = await emit(A, 'action', { type: 'attack', shipId: fregat.id, targetType: 'port', targetId: 1 });
      if (!r.ok) fail('осада порта: ' + r.error);
      portShots++;
    } else {
      const step = Math.min(st.shipTypes.fregat.move - 2, d - fireReach + 2);
      const baseAng = Math.atan2(enemyBase.y - fregat.y, enemyBase.x - fregat.x);
      let moved = false;
      for (const da of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
        const nx = fregat.x + Math.cos(baseAng + da) * step;
        const ny = fregat.y + Math.sin(baseAng + da) * step;
        r = await emit(A, 'action', { type: 'move', shipId: fregat.id, x: nx, y: ny });
        if (r.ok) { moved = true; break; }
      }
      if (!moved) r = await emit(A, 'action', { type: 'skip' });
    }
  } else {
    r = await emit(B, 'action', { type: 'skip' });
    if (!r.ok) fail('скип Боба: ' + r.error);
  }
  await wait(60);
}
if (portShots < 4) fail('не удалось подвести фрегат и обстрелять порт');
// порт получил урон, и порт огрызнулся по фрегату
const portNow = A.state.players[1].portHp;
const fregatNow = A.state.ships.find(s => s.owner === 0 && s.type === 'fregat')?.hp ?? 0;
if (!(portNow < portHpAtFirstShot)) fail('порт не получил урона');
if (!(fregatNow < fregatHpAtFirstShot)) fail('порт не огрызнулся по атакующему фрегату');
ok(`осада: порт ${portHpAtFirstShot}→${portNow} за ${portShots} залпа, фрегат огрёб ответку ${fregatHpAtFirstShot}→${fregatNow}`);

// победу засчитываем через сдачу Боба (полный снос 840-HP порта — в sim.mjs)
r = await emit(B, 'leave');
if (!r.ok) fail('сдача Боба: ' + r.error);
await wait(300);
if (A.state.status !== 'finished') fail('игра не завершилась после сдачи Боба');
if (A.state.winner !== 0) fail('победил не тот');
const fin = A.state.players;
ok(`победа Алисы (Боб сдался); места: ${fin.map(p => p.nick + '=' + p.placement).join(', ')}`);
if (fin[0].placement !== 1 || fin[1].placement !== 2) fail('места распределены неверно');
if (fin[0].stats.damageDealt <= 0) fail('статистика урона пуста');
ok('статистика: урон=' + fin[0].stats.damageDealt + ', золото Алисы=' + fin[0].gold);

// лидерборд (в БД могут быть и реальные игроки — проверяем только строку Алисы)
const lb = await (await fetch(BASE + '/api/leaderboard')).json();
const aliceRow = lb.find(r => r.nick === 'Алиса');
if (!aliceRow || aliceRow.wins < 1) fail('Алисы нет в лидерборде: ' + JSON.stringify(lb));
const aliceWinsBefore = aliceRow.wins;
ok('лидерборд обновился: у Алисы побед ' + aliceWinsBefore);

// --- вторая игра: выход из лобби и сдача ---
const res2 = await fetch(BASE + '/api/games', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: 'tokA', nick: 'Алиса', maxPlayers: 3, turnTimer: 0 })
});
const game2 = (await res2.json()).gameId;

function connect2(token, nick) {
  return new Promise((resolve, reject) => {
    const s = io(BASE);
    const ctx = { socket: s, state: null };
    s.on('state', x => { ctx.state = x; });
    s.on('connect', () => {
      s.emit('join', { gameId: game2, token, nick }, r => r.ok ? resolve(ctx) : reject(new Error(r.error)));
    });
  });
}
const A2 = await connect2('tokA', 'Алиса');
const B2 = await connect2('tokB', 'Боб');
const C2 = await connect2('tokC', 'Чарли');
await wait(200);
if (A2.state.players.length !== 3) fail('в лобби-2 не 3 игрока');

// Чарли передумал и вышел из лобби
let r2 = await emit(C2, 'leave');
if (!r2.ok) fail('выход из лобби не сработал: ' + r2.error);
await wait(200);
if (A2.state.players.length !== 2) fail('слот не освободился после выхода');
ok('выход из лобби освобождает слот');

r2 = await emit(A2, 'start');
if (!r2.ok) fail('старт игры-2: ' + r2.error);
await wait(200);

// Боб сдаётся → Алиса побеждает
r2 = await emit(B2, 'leave');
if (!r2.ok) fail('сдача не сработала: ' + r2.error);
await wait(300);
if (A2.state.status !== 'finished') fail('игра-2 не завершилась после сдачи');
if (A2.state.players[A2.state.winner]?.nick !== 'Алиса') fail('после сдачи победил не тот');
if (A2.state.ships.some(s => s.owner === 1)) fail('флот сдавшегося не утонул');
ok('сдача работает: Боб спустил флаг, Алиса победила');

const lb2 = await (await fetch(BASE + '/api/leaderboard')).json();
const aliceAfter = lb2.find(r => r.nick === 'Алиса');
if (!aliceAfter || aliceAfter.wins !== aliceWinsBefore + 1) fail('победа после сдачи не записалась в лидерборд');
ok('результат сдачи записан в лидерборд');

console.log('\n🎉 Все проверки пройдены');
process.exit(0);
