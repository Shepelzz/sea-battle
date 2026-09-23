// Анти-накрутка рейтинга: за что партия идёт в лидерборд, а за что нет.
//
// Очки даём за СОСТОЯВШИЙСЯ бой между людьми. Раньше признак был один — «это онлайн-партия»,
// и рейтинг фармился сдачей на первом ходу: победителю 3 очка, сдавшемуся 1 (второе место),
// четыре очка за полминуты на пару аккаунтов. Сдача при этом остаётся нормальным ходом:
// не считается не «сдача», а партия, которой не было.
import { createGame, addPlayer, startGame, applyAction, leaveGame, forceFinish, isRanked, rankedWhy, battleHappened, publicState, lobbyTags } from '../server/game.js';
import { resultRows } from '../server/db.js';
import { RANKED_MIN_ROUNDS, RANKED_MIN_DAMAGE, RANKED_MIN_SUNK_ON_QUIT, RANKED_BROKE_SHIP, RANKED_PORT_WRECK, PORT_HP, SHIP_TYPES } from '../server/config.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const eq = (n, g, w) => { JSON.stringify(g) === JSON.stringify(w) ? ok++ : (fail++, console.error('✗', n, 'got', JSON.stringify(g), 'want', JSON.stringify(w))); };

// онлайн-лобби (`listed` ставит index.js при создании игры по сети)
function online(cfg = {}) {
  const g = createGame('t' + Math.random().toString(36).slice(2), { maxPlayers: 4, turnTimer: 0, seed: 4242, ...cfg });
  g.config.listed = true;
  return g;
}
const put = (g, owner, type, x, y) =>
  (g.ships.push({ id: `${owner}_${type}_${x}_${y}`, owner, type, x, y, hp: SHIP_TYPES[type].hp, maxHp: SHIP_TYPES[type].hp }), g.ships.at(-1));

// живой бой: A стреляет по кораблю B, и партия проживает нужные раунды
function realBattle(g) {
  g.ships = [];
  const mine = put(g, 0, 'fregat', 760, 600), foe = put(g, 1, 'shkhuna', 820, 600);
  applyAction(g, 'A', { type: 'attack', shipId: mine.id, targetType: 'ship', targetId: foe.id });
  g.turn.round = RANKED_MIN_ROUNDS;
  return g;
}
// разгромленный соперник: флот на дне, в казне пусто (порт при этом цел — значит признаком
// разгрома работает счёт потопленных). Сдаваться в таком положении уже не стыдно.
function crushed(g, loser = 1) {
  g.players[0].stats.shipsSunk = RANKED_MIN_SUNK_ON_QUIT;
  g.players[loser].gold = SHIP_TYPES[RANKED_BROKE_SHIP].price - 1;
  return g;
}

// === 1. Сдача на первом ходу — не партия: вне рейтинга ОБЕИМ сторонам ===
{
  const g = online({ maxPlayers: 2 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  leaveGame(g, 'B');                       // 🏳 белый флаг сразу после старта
  eq('мгновенная сдача завершает партию', g.status, 'finished');
  eq('причина — сдался, не будучи разбитым', rankedWhy(g), 'rank.quit');
  yes('в рейтинг не идёт', !isRanked(g));
  eq('обе строки помечены ranked=0', resultRows(g).map(r => r.at(-1)), [0, 0]);
  // сдавшийся больше не получает очко за второе место — его партия тоже вне рейтинга
  eq('второе место сдавшемуся записано (но без рейтинга)', resultRows(g)[1][2], 2);
}

// === 2. Капитуляция разбитого соперника — обычный исход, очки победителю идут ===
{
  const g = online({ maxPlayers: 2 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  crushed(realBattle(g));
  leaveGame(g, 'B');                       // сдался, но флот выбит и денег нет
  eq('партия зачтена', rankedWhy(g), null);
  yes('идёт в рейтинг', isRanked(g));
  eq('обе строки ranked=1', resultRows(g).map(r => r.at(-1)), [1, 1]);
}

// === 2а. Сдача при живой позиции — подарок, а не поражение ===
// Раунды накликиваются пропуском хода, поэтому одних раундов мало: смотрим, был ли
// сдавшийся действительно разбит (потоплено кораблей + у него пусто в казне).
{
  const base = () => {
    const g = online({ maxPlayers: 2 });
    addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
    startGame(g, 'A');
    return crushed(realBattle(g));
  };
  {
    const g = base();
    g.turn.round = 30;                                  // «доиграли» до 30-го раунда…
    g.players[0].stats.shipsSunk = RANKED_MIN_SUNK_ON_QUIT - 1;   // …но флот соперника цел
    leaveGame(g, 'B');
    eq('мало потопленных — сдача не считается', rankedWhy(g), 'rank.quit');
  }
  {
    const g = base();
    g.players[1].gold = SHIP_TYPES[RANKED_BROKE_SHIP].price;      // может отстроиться, а вышел
    leaveGame(g, 'B');
    eq('сдался при деньгах — не считается', rankedWhy(g), 'rank.quit');
    yes('в рейтинг не идёт', !isRanked(g));
  }
  {
    const g = base();
    leaveGame(g, 'B');
    yes('разбит по обоим признакам — засчитано', isRanked(g));
  }
}

// === 2б. Финал БОЕМ строгой проверки не требует: такой исход не подаришь ===
{
  const g = online({ maxPlayers: 2 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  realBattle(g);
  g.players[1].gold = 9999;                 // богат и с флотом — но порт снесли в бою
  g.players[1].portHp = 0;
  g.players[1].alive = false; g.players[1].placement = 2;
  g.players[0].placement = 1; g.winner = 0; g.status = 'finished';
  yes('победа в бою — рейтинговая', isRanked(g));
}

// === 2г. Победа ОСАДОЙ: флотами не менялись, но порт в руинах ===
// Вынести порт, не потопив ни одного корабля, — законный способ выиграть, и сдача под таким
// обстрелом настоящая. Подделать это дёшево нельзя: порт огрызается по атакующему.
{
  const siege = (portHp, gold) => {
    const g = online({ maxPlayers: 2 });
    addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
    startGame(g, 'A');
    realBattle(g);
    g.players[0].stats.shipsSunk = 0;            // размена флотами не было вовсе
    g.players[1].portHp = portHp;
    g.players[1].gold = gold;
    leaveGame(g, 'B');
    return g;
  };
  const broke = SHIP_TYPES[RANKED_BROKE_SHIP].price - 1;
  yes('порт в руинах + пустая казна — засчитано', isRanked(siege(PORT_HP * RANKED_PORT_WRECK - 1, broke)));
  eq('порт почти цел — не засчитано', rankedWhy(siege(PORT_HP - 1, broke)), 'rank.quit');
  eq('порт в руинах, но казна полна — не засчитано',
    rankedWhy(siege(1, SHIP_TYPES[RANKED_BROKE_SHIP].price)), 'rank.quit');
}

// === 2в. Строка из прода: «1 игра, 1 победа, урон 0, потоплено 0» ===
// Соперник вышел, не сделав ни выстрела, а победитель получил 3 очка. Больше не получит.
{
  const g = online({ maxPlayers: 2 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  leaveGame(g, 'B');
  const rows = resultRows(g);
  eq('урона нет', rows[0][4], 0);
  eq('потоплено нет', rows[0][5], 0);
  eq('победа записана, но вне рейтинга', [rows[0][3], rows[0].at(-1)], [1, 0]);
}

// === 3. Порог: нужны И раунды, И урон между людьми ===
{
  const g = online({ maxPlayers: 2 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  g.turn.round = RANKED_MIN_ROUNDS + 10;   // досидели, но не стреляли
  yes('долгая партия без урона боем не считается', !battleHappened(g));
  realBattle(g);
  g.turn.round = RANKED_MIN_ROUNDS - 1;    // стреляли, но партия ещё короткая
  yes('урон без раундов боем не считается', !battleHappened(g));
  g.turn.round = RANKED_MIN_ROUNDS;
  yes('раунды + урон = бой состоялся', battleHappened(g));
  yes('порог урона — хотя бы одно попадание', RANKED_MIN_DAMAGE >= 1);
  yes('порог раундов заметный', RANKED_MIN_ROUNDS >= 3);
}

// === 3а. Короткий финал БЕЗ сдачи — своя причина ===
{
  const g = online({ maxPlayers: 2 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  g.players[1].alive = false; g.players[1].placement = 2;   // выбит боем, но партия только началась
  g.players[0].placement = 1; g.winner = 0; g.status = 'finished';
  eq('причина — боя не было', rankedWhy(g), 'rank.short');
}

// === 4. Бот в составе — вне рейтинга, и это видно ДО старта ===
{
  const g = online({ maxPlayers: 4 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб'); addPlayer(g, 'C', 'Бот');
  g.players[2].isBot = true;
  eq('причина — бот в составе', rankedWhy(g), 'rank.bots');
  yes('метка «вне рейтинга» есть в витрине лобби', lobbyTags(g).some(x => x.k === 'tag.unranked'));
  yes('состояние лобби несёт признак рейтинга', publicState(g).ranked.ok === false);
  eq('и причину ключом', publicState(g).ranked.why, 'rank.bots');
  startGame(g, 'A');
  realBattle(g);
  leaveGame(g, 'B');
  yes('честный бой с ботом в составе всё равно вне рейтинга', !isRanked(g));
  yes('строки людей помечены ranked=0', resultRows(g).every(r => r.at(-1) === 0));
}

// === 5. Партию прибил хост («завершить») — победа не по бою ===
{
  const g = online({ maxPlayers: 2 });
  addPlayer(g, 'A', 'Алиса'); addPlayer(g, 'B', 'Боб');
  startGame(g, 'A');
  realBattle(g);                            // бой был — но финал не боевой
  forceFinish(g);
  eq('партия завершена принудительно', g.status, 'finished');
  eq('причина — завершил создатель', rankedWhy(g), 'rank.forced');
  yes('в рейтинг не идёт', !isRanked(g));
}

// === 6. Что рейтинга не касалось и не касается ===
{
  const solo = createGame('s', { maxPlayers: 2, seed: 1 });   // без listed — бот/хотсит
  addPlayer(solo, 'A', 'Алиса'); addPlayer(solo, 'B', 'Боб');
  eq('оффлайн-партия вне рейтинга', rankedWhy(solo), 'rank.offline');
  const rt = online({ maxPlayers: 2 });
  rt.config.realtime = true;                                  // ⚡ флаг ставит index.js при создании
  addPlayer(rt, 'A', 'Алиса'); addPlayer(rt, 'B', 'Боб');
  eq('⚡ реалтайм — бета, вне рейтинга', rankedWhy(rt), 'rank.realtime');
}

// === 7. Все причины переводимы во всех языках ===
{
  const REASONS = ['rank.offline', 'rank.realtime', 'rank.bots', 'rank.forced', 'rank.short', 'rank.quit'];
  for (const lang of ['ru', 'uk', 'en']) {
    const dict = JSON.parse(await (await import('node:fs/promises')).readFile(`public/locales/${lang}.json`, 'utf8'));
    for (const key of REASONS)
      yes(`${lang}: есть текст для ${key}`, typeof key.split('.').reduce((o, k) => o?.[k], dict) === 'string');
  }
}

console.log(fail ? `❌ рейтинг: ${ok} ок, ${fail} провал(ов)` : `✅ анти-накрутка рейтинга: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
