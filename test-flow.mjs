// E2E-прогон: создание игры, лобби, ходы, бой до победы.
import { io } from 'socket.io-client';

const BASE = 'http://127.0.0.1:3456';
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
if (A.state.ships.length !== 6) fail('ожидалось 6 стартовых кораблей, есть ' + A.state.ships.length);
if (!A.state.map.lootIslands.length) fail('нет лут-островов');
if (A.state.map.fishZones.length < 2) fail('мало рыбных мест');
ok(`карта: ${A.state.map.lootIslands.length} лут-островов, ${A.state.map.fishZones.length} рыбных мест, флоты на воде`);

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

// гоняем бой: двигаем фрегат Алисы к базе Боба и расстреливаем порт
console.log('— марш к базе Боба и осада порта —');
let turns = 0;
while (A.state.status === 'active' && turns < 400) {
  turns++;
  // ход Алисы
  const st = A.state;
  const me = st.players[0];
  if (st.turn.idx === 0) {
    const fregat = st.ships.find(s => s.owner === 0 && s.type === 'fregat');
    if (!fregat) fail('фрегат Алисы пропал');
    const enemyBase = st.map.bases[1];
    const d = Math.hypot(fregat.x - enemyBase.x, fregat.y - enemyBase.y);
    const fireReach = st.shipTypes.fregat.fireRange + enemyBase.radius * 0.5;
    if (d <= fireReach) {
      r = await emit(A, 'action', { type: 'attack', shipId: fregat.id, targetType: 'port', targetId: 1 });
      if (!r.ok) fail('осада порта: ' + r.error);
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
if (A.state.status !== 'finished') fail('игра не закончилась за 400 ходов');
if (A.state.winner !== 0) fail('победил не тот');
const fin = A.state.players;
ok(`победа Алисы за ${turns} ходов; места: ${fin.map(p => p.nick + '=' + p.placement).join(', ')}`);
if (fin[0].placement !== 1 || fin[1].placement !== 2) fail('места распределены неверно');
if (fin[0].stats.damageDealt <= 0) fail('статистика урона пуста');
ok('статистика: урон=' + fin[0].stats.damageDealt + ', золото Алисы=' + fin[0].gold);

// лидерборд
const lb = await (await fetch(BASE + '/api/leaderboard')).json();
if (!lb.length) fail('лидерборд пуст после игры');
if (lb[0].nick !== 'Алиса' || lb[0].wins !== 1) fail('лидерборд неверный: ' + JSON.stringify(lb));
ok('лидерборд обновился: ' + lb.map(x => `${x.nick}:${x.points}очк`).join(', '));

console.log('\n🎉 Все проверки пройдены');
process.exit(0);
