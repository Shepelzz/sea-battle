// Тест устойчивости к деплою: создаём активную игру, «передеплоиваем»
// (убиваем и поднимаем сервер на той же базе), игра должна находиться.
import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
import fs from 'node:fs';

const DB = '/tmp/sb-redeploy.db';
const PORT = 3491;
const BASE = `http://127.0.0.1:${PORT}`;
const ok = m => console.log('✅ ' + m);
const fail = m => { console.error('❌ ' + m); process.exit(1); };
const wait = ms => new Promise(r => setTimeout(r, ms));

for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + ext); } catch {} }

function boot() {
  const p = spawn('node', ['server/index.js'], {
    env: { ...process.env, DB_PATH: DB, PORT: String(PORT) },
    stdio: 'ignore'
  });
  return p;
}

async function createActiveGame() {
  const r = await fetch(BASE + '/api/games', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'rd-a', nick: 'Алиса', maxPlayers: 2, turnTimer: 0 })
  });
  const { gameId } = await r.json();
  if (!gameId) fail('игра не создалась');
  // Боб заходит, Алиса стартует и делает ход
  await new Promise((res, rej) => {
    const b = io(BASE);
    b.on('connect', () => b.emit('join', { gameId, token: 'rd-b', nick: 'Боб' }, x => x.ok ? res() : rej(new Error(x.error))));
  });
  await new Promise((res, rej) => {
    const a = io(BASE);
    let st = null;
    a.on('state', s => { st = s; });
    a.on('connect', () => a.emit('join', { gameId, token: 'rd-a', nick: 'Алиса' }, () => {
      a.emit('start', () => setTimeout(() => {
        const ship = st.ships.find(s => s.owner === 0 && s.type === 'shkhuna');
        a.emit('action', { type: 'move', shipId: ship.id, x: ship.x + 80, y: ship.y + 40 }, r2 => r2.ok ? res() : rej(new Error(r2.error)));
      }, 300));
    }));
  });
  return gameId;
}

function findGame(gameId) {
  return new Promise((res) => {
    const s = io(BASE);
    let st = null;
    s.on('state', x => { st = x; });
    s.on('connect', () => s.emit('join', { gameId, token: 'rd-a', nick: 'Алиса' }, r => {
      setTimeout(() => { s.close(); res({ ack: r, state: st }); }, 300);
    }));
  });
}

(async () => {
  let srv = boot();
  await wait(1400);
  const gameId = await createActiveGame();
  ok('активная игра создана и сделан ход: ' + gameId);
  await wait(400); // дать сохраниться

  // «ДЕПЛОЙ»: убиваем сервер, удаляем файлы-спутники WAL (как при чистой распаковке zip),
  // оставляем только основной .db — он должен содержать всё благодаря чекпоинту
  srv.kill('SIGKILL');
  await wait(600);
  for (const ext of ['-wal', '-shm']) { try { fs.unlinkSync(DB + ext); } catch {} }
  ok('сервер убит, файлы -wal/-shm удалены (симуляция деплоя)');

  // поднимаем заново
  srv = boot();
  await wait(1400);

  const { ack, state } = await findGame(gameId);
  if (!ack.ok) fail('после деплоя игра НЕ найдена: ' + ack.error);
  if (state?.status !== 'active') fail('игра нашлась, но не активна: ' + state?.status);
  if (state.players.length !== 2) fail('потеряны игроки');
  ok('после деплоя игра найдена, статус active, игроков ' + state.players.length + ', ход №' + state.turn.number);

  srv.kill('SIGKILL');
  console.log('🎉 устойчивость к деплою подтверждена');
  process.exit(0);
})();
