// Проверка поведения ботов: прикрытие кормящих рыбаков и выбор БЕЗОПАСНОЙ рыбной зоны
// (две жалобы: рыбак-смертник на круг + соло-атака без прикрытия).
import { createGame, addPlayer, startGame, applyAction } from './server/game.js';
import { movesBudget, OUTPOST_LEVELS, OUTPOST_BUILD_REACH, TRIBUTE_MIN, TRIBUTE_MAX, tributeFor } from './server/config.js';
import { chooseBotAction, boardValue } from './server/bot.js';
import { SHIP_TYPES } from './server/ships.js';

let ok = 0, fail = 0;
const check = (n, c, extra = '') => { c ? (ok++, console.log('✓', n, extra)) : (fail++, console.error('✗', n, extra)); };
const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function setup() {
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0, seed: 4242 });
  addPlayer(g, 'p0', 'Я');
  addPlayer(g, 'p1', 'Враг');
  startGame(g, 'p0');
  g.ships = [];                                   // чистый стол
  g.map.lootIslands.forEach(i => (i.looted = true)); // лут не мешает оценкам
  g.players.forEach(p => (p.gold = 0));           // без денег — изолируем решения о движении/бое
  return g;
}
const put = (g, owner, type, x, y, hp) =>
  (g.ships.push({ id: `${owner}_${type}_${x}_${y}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp }), g.ships.at(-1));

// === 1. Прикрытие кормилицы: враг насел на наш баркас в зоне — боевой корабль идёт его бить ===
{
  const g = setup();
  const z = g.map.fishZones[0];
  const fisher = put(g, 0, 'barkas', z.x, z.y);                 // мой кормилец в зоне
  const enemy = put(g, 1, 'brig', z.x + 60, z.y);              // враг впритык к зоне
  const myBrig = put(g, 0, 'brig', z.x - 320, z.y);            // мой боевик в стороне (вне радиуса огня)
  const dBefore = D(myBrig, enemy);
  const a = chooseBotAction(g, 0, 'hard');
  // ждём: либо стреляем по врагу (если достаём), либо ДВИГАЕМ боевик НАВСТРЕЧУ врагу-обидчику
  const movesToEnemy = a.type === 'move' && a.shipId === myBrig.id &&
    Math.hypot(a.x - enemy.x, a.y - enemy.y) < dBefore;
  const shootsEnemy = a.type === 'attack' && a.targetId === enemy.id;
  check('боевой прикрывает кормящего баркаса', movesToEnemy || shootsEnemy, `(${a.type} ${a.shipId || a.targetId || ''})`);
}

// === 2. Рыбак выбирает БЕЗОПАСНУЮ зону, а не ближайшую под врагом ===
{
  const g = setup();
  const zNear = g.map.fishZones[0];               // ближе к рыбаку, но под огнём
  const zSafe = g.map.fishZones[1];               // дальше, зато чисто
  // делаем все зоны кроме zSafe опасными
  g.map.fishZones.forEach(z => { if (z !== zSafe) put(g, 1, 'brig', z.x + 40, z.y); });
  // рыбак стоит ВНЕ зон, ближе к опасной zNear
  const fisher = put(g, 0, 'barkas',
    Math.round((zNear.x * 2 + zSafe.x) / 3), Math.round((zNear.y * 2 + zSafe.y) / 3));
  const dNearBefore = D(fisher, zNear), dSafeBefore = D(fisher, zSafe);
  const a = chooseBotAction(g, 0, 'mid');
  const movesFisher = a.type === 'move' && a.shipId === fisher.id;
  const towardSafe = movesFisher && Math.hypot(a.x - zSafe.x, a.y - zSafe.y) < dSafeBefore;
  const notTowardNear = !movesFisher || Math.hypot(a.x - zNear.x, a.y - zNear.y) >= dNearBefore - 5;
  check('рыбак идёт в безопасную зону, а не в ближнюю опасную', towardSafe && notTowardNear,
    `(${a.type} → safeΔ ${Math.round(dSafeBefore)}→${movesFisher ? Math.round(Math.hypot(a.x - zSafe.x, a.y - zSafe.y)) : '—'})`);
}

// === 3. Рыбак под ударом без защитника отходит к базе (не кормит собой врага) ===
{
  const g = setup();
  const z = g.map.fishZones[0];
  const base = g.map.bases[0];
  const fisher = put(g, 0, 'barkas', z.x, z.y);   // в зоне
  put(g, 1, 'brig', z.x + 60, z.y);               // враг впритык, мой боевик далеко-отсутствует
  const dBaseBefore = D(fisher, base);
  const a = chooseBotAction(g, 0, 'mid');
  const retreats = a.type === 'move' && a.shipId === fisher.id &&
    Math.hypot(a.x - base.x, a.y - base.y) < dBaseBefore;
  check('рыбак без прикрытия отходит к базе', retreats, `(${a.type} ${a.shipId || ''})`);
}

// === 4. ⛺ Бот ПОЛЬЗУЕТСЯ аванпостами ===
// Мотива «подойти к залутанному острову под стройку» раньше не было: корабль после сбора
// клада уплывал, условие «свой корабль вплотную + хватает золота» не совпадало, и за целую
// партию не ставилось НИ ОДНОГО аванпоста. Этот тест — сторож, чтобы механика не отмерла снова.
{
  // Постройка НАРОЧНО уступает и бою, и верфи: при живом враге бот воюет, при пустой палубе
  // докупает флот — и это правильный порядок приоритетов. Поэтому проверяем не «строит вместо
  // всего», а сам гейт: без запаса золота стройка не должна даже рассматриваться.
  const g = setup();
  const z = g.map.fishZones[0], isl = g.map.lootIslands[0];
  isl.x = z.x + z.radius + 20; isl.y = z.y;
  put(g, 0, 'barkas', isl.x - isl.radius - 20, isl.y);
  put(g, 1, 'brig', g.map.bases[1].x - 100, g.map.bases[1].y);
  g.players[0].gold = OUTPOST_LEVELS[0].price + 50;             // денег впритык
  check('без запаса золота бот не строит (флот важнее экономики)',
    chooseBotAction(g, 0, 'hard').type !== 'outpost');
}

{
  // …и доводит дело до конца в живой партии. Условия постройки нарочно жёсткие (лишние
  // деньги + лишний флот + остров по дороге), поэтому строит он не каждую партию: замер —
  // 0.7 аванпоста на партию, в коротких партиях 0. Сторожим сам факт, что механика жива.
  let built = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const g = createGame('op' + seed, { maxPlayers: 2, turnTimer: 0, seed });
    g.config.multiMove = true; g.config.botGame = true; g.config.fog = true;
    addPlayer(g, 'p0', 'A'); addPlayer(g, 'p1', 'B');
    g.players.forEach(p => { p.isBot = true; p.botLevel = 'hard'; });
    startGame(g, 'p0');
    let guard = 0;
    while (g.status === 'active' && guard++ < 900) {
      const i = g.turn.idx;
      let moves = 0;
      while (g.status === 'active' && g.turn.idx === i && moves++ <= movesBudget(g.config)) {
        let a; try { a = chooseBotAction(g, i, 'hard'); } catch { a = { type: 'skip' }; }
        if (!applyAction(g, 'p' + i, a).ok) applyAction(g, 'p' + i, { type: 'skip' });
      }
    }
    built += (g.map.lootIslands || []).filter(i => i.outpost).length;
  }
  check('за шесть живых партий аванпосты реально появляются', built > 0, `построено ${built}`);
}

// === 5. 🎯 Сосредоточенный огонь: флот добивает ОДНУ цель, а не царапает всех ===
// Потопленный враг перестаёт стрелять, раненый стреляет в полную силу — размазывать урон
// невыгодно. Цель вычисляется из доски одной формулой, поэтому корабли сходятся на ней без
// всякого обмена сообщениями. A/B: +34 победы на 120 партиях против версии без фокуса.
{
  const g = setup();
  const cx = g.map.w / 2, cy = g.map.h / 2;                    // подальше от обеих баз
  const a = put(g, 0, 'fregat', cx - 60, cy, SHIP_TYPES.fregat.hp);
  const b = put(g, 0, 'fregat', cx - 60, cy + 80, SHIP_TYPES.fregat.hp);
  const hurt = put(g, 1, 'brig', cx + 60, cy + 20, 60);        // подранок
  const fresh = put(g, 1, 'brig', cx + 60, cy - 20, SHIP_TYPES.brig.hp); // целый
  [a, b].forEach(s2 => (s2.heading = 0));
  const first = chooseBotAction(g, 0, 'hard');
  check('первый корабль бьёт подранка, а не целого',
    first.type === 'attack' && first.targetId === hurt.id, `(${first.type} → ${first.targetId === fresh.id ? 'целый' : first.targetId})`);
  // второй корабль в том же ходу должен добивать ТУ ЖЕ цель
  g.turn.actedShips = [first.shipId];
  const second = chooseBotAction(g, 0, 'hard');
  check('второй корабль бьёт ТУ ЖЕ цель (сосредоточенный огонь)',
    second.type === 'attack' && second.targetId === hurt.id, `(${second.type} → ${second.targetId === fresh.id ? 'целый' : second.targetId})`);
}

// === 6. 🧩 Оценка позиции (на ней стоит планирование хода) ===
// Планировщик сравнивает не приоритеты действий, а ПОЗИЦИЮ после них: первая версия складывала
// эвристические оценки и провалилась (−4 победы), версия на оценке доски дала +68 на 120 партиях.
// Здесь проверяем, что сама оценка ведёт себя осмысленно — иначе планировщик поедет молча.
{
  const g = setup();
  const base = boardValue(g, 0);
  const mine = put(g, 0, 'linkor', 600, 600);
  check('свой корабль поднимает оценку', boardValue(g, 0) > base);
  const theirs = put(g, 1, 'linkor', 900, 600);
  check('вражеский корабль симметрично опускает', Math.abs(boardValue(g, 0) - base) < 1, `(${Math.round(boardValue(g, 0) - base)})`);
  // Строгой зеркальности больше нет — и это осознанно: своя казна считается как будущий флот,
  // а чужая — через КУШ за снос её базы (tributeFor: 100–500 по развитию жертвы). Оба игрока
  // видят куш друг за друга, поэтому сумма оценок не ноль, а небольшой общий остаток.
  const mirror = boardValue(g, 1) + boardValue(g, 0);
  check('оценка почти зеркальная (расхождение — только куш)', Math.abs(mirror) <= 2 * TRIBUTE_MIN * 0.25 + 5,
    `(расхождение ${Math.round(mirror)})`);
  const before = boardValue(g, 0);
  theirs.hp = Math.round(theirs.hp / 2);
  check('подбитый враг улучшает позицию', boardValue(g, 0) > before);
  const beforeGold = boardValue(g, 0);
  g.players[0].gold += 400;
  check('казна учитывается', boardValue(g, 0) > beforeGold);
  const beforePort = boardValue(g, 0);
  g.players[1].portHp -= 200;
  check('пробитый вражеский порт улучшает позицию', boardValue(g, 0) > beforePort);
  const beforeOut = boardValue(g, 0);
  g.map.lootIslands[0].outpost = { owner: 0, level: 1, hp: 120 };
  check('свой аванпост учитывается', boardValue(g, 0) > beforeOut);
  g.players[1].alive = false;
  check('выбывание соперника — решающий скачок', boardValue(g, 0) - beforeOut > 300);
}

// === 7. 🪜 Лестница сложности не съехала ===
// Замер показал, что «Юнга» выигрывал у «Боцмана» 43% партий — выбор сложности между ними почти
// ничего не менял. Теперь Юнга выбирает лучшее из случайной ГОРСТКИ вариантов, а не из всей
// доски. Сторож грубый (мало партий — иначе тест станет долгим), порог с большим запасом:
// на замере в 80 партий «Адмирал» бьёт «Юнгу» в 90% случаев.
{
  let admiral = 0, played = 0;
  for (let n = 0; n < 36; n++) {
    const g = createGame('lad' + n, { maxPlayers: 2, turnTimer: 0, seed: 1 + (n >> 1) });
    g.config.multiMove = true; g.config.botGame = true; g.config.fog = true;
    const hardIdx = n % 2;
    addPlayer(g, 'p0', 'A'); addPlayer(g, 'p1', 'B');
    g.players.forEach((p, i) => { p.isBot = true; p.botLevel = i === hardIdx ? 'hard' : 'easy'; });
    startGame(g, 'p0');
    let guard = 0;
    while (g.status === 'active' && guard++ < 900) {
      const i = g.turn.idx, lvl = i === hardIdx ? 'hard' : 'easy';
      let m = 0;
      while (g.status === 'active' && g.turn.idx === i && m++ <= movesBudget(g.config)) {
        let a; try { a = chooseBotAction(g, i, lvl); } catch { a = { type: 'skip' }; }
        if (!applyAction(g, 'p' + i, a).ok) applyAction(g, 'p' + i, { type: 'skip' });
      }
    }
    if (g.status === 'active') continue;                 // недоигранные не считаем
    played++;
    if (g.players.findIndex(p => p.placement === 1) === hardIdx) admiral++;
  }
  // Порог с запасом и выборка побольше: на замере в 80 партий «Адмирал» берёт 90%, но на
  // двух десятках партий разброс доходил до 65% — тест краснел на ровном месте.
  check('«Адмирал» уверенно сильнее «Юнги»', played >= 20 && admiral / played >= 0.65,
    `${admiral} из ${played} партий`);
}

// === 8. 🏰 Осада доводится до конца ===
// Жалоба с живой партии: боты крутились вокруг вражеского острова и не били по базе. Причина
// была в оценке позиции — порт весил 0.35 за HP, а свой корабль 1.0, и выстрел фрегата (+14.7)
// не окупал ответку порта (−25). Осада выходила «убыточной», планировщик от неё отказывался.
// Теперь порт весит как условие победы, а не как мешок HP.
{
  const g = setup();
  const b = g.map.bases[1];
  put(g, 0, 'fregat', b.x - 120, b.y).heading = 0;
  put(g, 0, 'linkor', b.x - 130, b.y + 60).heading = 0;
  g.players[1].portHp = 200;
  const a = chooseBotAction(g, 0, 'hard');
  check('тяжёлый корабль бьёт по вражескому порту, а не маневрирует',
    a.type === 'attack' && a.targetType === 'port' && a.targetId === 1, `(${a.type})`);
}
{
  // обратная сторона: бриг по порту почти бесполезен (залп по базе ×0.12), а сдачу получает
  // полную — он не должен разменивать себя на символические 3 HP
  const g = setup();
  const b = g.map.bases[1];
  put(g, 0, 'brig', b.x - 120, b.y).heading = 0;
  g.players[1].portHp = 200;
  const a = chooseBotAction(g, 0, 'hard');
  check('бриг не долбит порт впустую', !(a.type === 'attack' && a.targetType === 'port'), `(${a.type})`);
}

// === 9. 🏴‍☠️ Куш за базу считается по ПУТИ жертвы за всю партию ===
// Замер 12 партий: у проигравшего в казне ноль в 11 случаях — если базу смогли осадить, денег
// у него давно нет. Поэтому куш меряет не «что осталось», а «что было»: заработано за партию,
// нанесено урона, потоплено судов.
{
  const g = setup();
  g.players[1].gold = 0;
  const bare = tributeFor(g, 1);
  check('за пустой путь дают минимум', bare === TRIBUTE_MIN, `(${bare})`);

  g.players[1].stats.goldCollected = 700;                    // короткая партия
  const short0 = tributeFor(g, 1);
  g.players[1].stats.goldCollected = 1700;                   // обычная
  const mid0 = tributeFor(g, 1);
  g.players[1].stats.goldCollected = 3000;                   // долгая и богатая
  const long0 = tributeFor(g, 1);
  check('чем больше заработал за партию, тем крупнее куш', short0 < mid0 && mid0 < long0,
    `(${short0} → ${mid0} → ${long0})`);
  check('ранний вылет стоит немного', short0 < 300, `(${short0})`);

  g.players[1].stats.goldCollected = 1700;
  const noWar = tributeFor(g, 1);
  g.players[1].stats.damageDealt = 1500;
  g.players[1].stats.shipsSunk = 8;
  check('навоёванное тоже идёт в куш', tributeFor(g, 1) > noWar, `(${noWar} → ${tributeFor(g, 1)})`);

  g.players[1].stats.goldCollected = 9000; g.players[1].stats.damageDealt = 9000;
  check('куш не улетает в космос', tributeFor(g, 1) === TRIBUTE_MAX, `(${tributeFor(g, 1)})`);

  const poor = setup();
  poor.players[1].stats.goldCollected = 1500;
  const before = tributeFor(poor, 1);
  poor.players[1].gold = 4000;                               // редкий скупец с полной казной
  check('нерастраченная казна тоже учитывается', tributeFor(poor, 1) > before, `(${before} → ${tributeFor(poor, 1)})`);
}
{
  // и в бою: разрушение порта реально приносит этот куш победителю
  const g = setup();
  const b = g.map.bases[1];
  const lk = put(g, 0, 'linkor', b.x - 150, b.y);
  lk.heading = 0;
  g.players[1].portHp = 50; g.players[1].gold = 200;
  const expected = tributeFor(g, 1);
  const goldBefore = g.players[0].gold;
  applyAction(g, 'p0', { type: 'attack', shipId: lk.id, targetType: 'port', targetId: 1 });
  check('порт разрушен', g.players[1].alive === false);
  check('победитель получил ровно рассчитанный куш', g.players[0].gold - goldBefore === expected,
    `(получено ${g.players[0].gold - goldBefore}, ожидалось ${expected})`);
}

// === 10. 🏰 Осада: подбитые фрегаты не срывают штурм, порт ломает линкор ===
// С живой партии: «все фрегаты на нуле HP, и он перестаёт бить базу, чтобы их не потерять —
// корабли просто кружат вокруг». Порт ломает только мортира, причём линкор вдвое эффективнее
// фрегата (portBonus) и легче переживает ответку — значит его и тянем к базе, а подбитые
// держат блокаду (порт сам не стреляет, стоять рядом безопасно).
{
  const g = setup();
  const b = g.map.bases[1];
  put(g, 0, 'fregat', b.x - 130, b.y - 40, 30).heading = 0;     // оба фрегата почти мертвы
  put(g, 0, 'fregat', b.x - 130, b.y + 40, 25).heading = 0;
  put(g, 0, 'linkor', b.x - 150, b.y).heading = 0;
  put(g, 0, 'brig', b.x - 110, b.y + 90).heading = 0;
  g.players[1].portHp = 400;
  const a = chooseBotAction(g, 0, 'hard');
  const ship = g.ships.find(s => s.id === a.shipId);
  check('штурм продолжается, и порт бьёт именно линкор',
    a.type === 'attack' && a.targetType === 'port' && ship?.type === 'linkor', `(${a.type} ${ship?.type || ''})`);
}

// === 11. 🛡 Вторжение к своему порту не игнорируется ===
// С живой партии: «я подогнал корабли к его порту, пока он валил соперника, разбил всё вокруг —
// а он не начал обороняться». Причина была в оценке позиции: она видела только текущий HP порта,
// то есть пока база цела — будто и угрозы нет. Теперь считается НЕПОКРЫТАЯ огневая мощь у порога
// (чужая минус своя), поэтому вернуть корабль домой или купить защитника стало выгодно.
{
  const mk = gold => {
    const g = setup();
    g.config.multiMove = true;                                 // иначе «ход целиком» = одно действие
    const eb = g.map.bases[1], mb = g.map.bases[0];
    put(g, 0, 'linkor', eb.x - 150, eb.y).heading = 0;          // основные силы в осаде
    put(g, 0, 'brig', mb.x + 300, mb.y + 200).heading = 0;      // один на полпути домой
    put(g, 1, 'brig', mb.x + 120, mb.y).heading = 0;            // враг у моего порога
    put(g, 1, 'brig', mb.x + 120, mb.y + 60).heading = 0;
    g.players[0].gold = gold; g.players[1].portHp = 600;
    return g;
  };
  // Что именно выберет бот — купить защитника или увести корабль домой — зависит от денег и
  // позиции, и обе реакции законны (иногда верно и дожимать в гонке). Поэтому проверяем не
  // конкретное действие, а что ЗА ХОД ЦЕЛИКОМ он хоть как-то отреагировал на вторжение.
  const reacted = gold => {
    const g = mk(gold);
    const mb = g.map.bases[0];
    let defensive = 0;
    for (let i = 0; i < movesBudget(g.config) && g.turn.idx === 0; i++) {
      const a = chooseBotAction(g, 0, 'hard');
      const sh = g.ships.find(s2 => s2.id === a.shipId);
      if (a.type === 'buy') defensive++;                       // подкрепление появляется у своего порта
      if (a.type === 'move' && sh && Math.hypot(a.x - mb.x, a.y - mb.y) < Math.hypot(sh.x - mb.x, sh.y - mb.y)) defensive++;
      if ((a.type === 'attack' || a.type === 'broadside') && sh &&
          Math.hypot(sh.x - mb.x, sh.y - mb.y) < mb.radius + 300) defensive++;   // отбивается у себя дома
      applyAction(g, 'p0', a);
    }
    return defensive;
  };
  check('при деньгах бот реагирует на вторжение', reacted(600) > 0);
  check('без денег бот тоже реагирует (ведёт корабль домой)', reacted(0) > 0);
}

// === 12. 🛡 Оборона по МАСШТАБУ вторжения ===
// Спецификация с живой партии: к пустому порту подошёл фрегат — купить защитника не ниже
// рангом; идёт флот из двух тяжёлых — брать линкора, а если денег нет, гнать домой всё боевое.
{
  const mk = (enemyTypes, gold) => {
    const g = setup();
    g.config.multiMove = true;
    const eb = g.map.bases[1], mb = g.map.bases[0];
    put(g, 0, 'linkor', eb.x - 150, eb.y).heading = 0;         // силы в осаде, дома пусто
    put(g, 0, 'fregat', eb.x - 180, eb.y + 50).heading = 0;
    put(g, 0, 'brig', mb.x + 400, mb.y + 250).heading = 0;
    enemyTypes.forEach((t, i) => put(g, 1, t, mb.x + 150 + i * 30, mb.y + i * 60));
    g.players[0].gold = gold; g.players[1].portHp = 600;
    return g;
  };
  const turn = g => {
    const acts = [];
    for (let i = 0; i < movesBudget(g.config) && g.turn.idx === 0 && g.status === 'active'; i++) {
      const a = chooseBotAction(g, 0, 'hard');
      const sh = g.ships.find(s2 => s2.id === a.shipId);
      // позицию снимаем ДО применения: объект корабля живой, после хода он уже сдвинут
      acts.push({ a, type: sh?.type, from: sh ? { x: sh.x, y: sh.y } : null });
      applyAction(g, 'p0', a);
    }
    return acts;
  };

  const solo = turn(mk(['fregat'], 400));
  const bought = solo.find(x => x.a.type === 'buy');
  check('одинокий фрегат у порта → покупается защитник не ниже рангом',
    !!bought && SHIP_TYPES[bought.a.ships[0]].dmg >= SHIP_TYPES.fregat.dmg,
    bought ? bought.a.ships.join(',') : 'не купил');

  const fleet = turn(mk(['linkor', 'fregat'], 700));
  const heavy = fleet.find(x => x.a.type === 'buy');
  check('флот вторжения при деньгах → берётся линкор',
    !!heavy && heavy.a.ships[0] === 'linkor', heavy ? heavy.a.ships.join(',') : 'не купил');

  const gBroke = mk(['linkor', 'fregat'], 0);
  const mb = gBroke.map.bases[0];
  const home = turn(gBroke).filter(x => x.a.type === 'move' && x.from &&
    Math.hypot(x.a.x - mb.x, x.a.y - mb.y) < Math.hypot(x.from.x - mb.x, x.from.y - mb.y));
  check('флот вторжения без денег → боевые гонят домой', home.length >= 1, `${home.length} корабля(ей)`);
}

// === 13. Жалобы с живой партии: пират, рыбаки, аванпост, клад ===
// Общая причина у всех четырёх была одна: оценка позиции считала только СЛУЧИВШЕЕСЯ. Пираты в
// неё не входили вовсе (урон по ним стоил ноль), а подход к кладу или к рыбной зоне не давал
// ничего — поэтому планировщик всегда выбирал сиюминутный выстрел.
{
  const clean = gold => {                                       // чистая доска: ничто не отвлекает
    const g = setup();
    g.config.multiMove = true;
    g.players[0].gold = gold;
    g.map.lootIslands.forEach(i => (i.looted = true));
    return g;
  };

  {  // пират обстрелял наш корабль — на это надо отвечать, тем более что за него платят
    const g = clean(0);
    put(g, 0, 'fregat', 600, 600).heading = 0;
    put(g, 0, 'brig', 560, 640).heading = 0;
    g.ships.push({ id: 'pir', owner: -1, type: 'pirate', x: 680, y: 600, hp: 50, maxHp: 80, bounty: 260, angryAt: 0, heading: 0 });
    const a = chooseBotAction(g, 0, 'hard');
    check('бот отвечает напавшему пирату (он же и добыча)',
      a.type === 'attack' || a.type === 'broadside', `(${a.type})`);
  }

  {  // деньги есть, рыбное место рядом и в нём свободно — рыбаков надо ставить, а не копить
    const g = clean(1300);
    const z = g.map.fishZones[0];
    put(g, 0, 'barkas', z.x, z.y);
    put(g, 0, 'fregat', z.x + 200, z.y);
    let bought = [];
    for (let t = 0; t < 3; t++) {
      for (let i = 0; i < movesBudget(g.config) && g.turn.idx === 0; i++) {
        const a = chooseBotAction(g, 0, 'hard');
        if (a.type === 'buy') bought.push(...a.ships);
        applyAction(g, 'p0', a);
      }
      g.turn.idx = 0; g.turn.moves = 0; g.turn.actedShips = []; g.turn.number++;
    }
    check('при деньгах и свободных местах бот докупает рыбаков',
      bought.filter(t => t === 'barkas').length >= 1, bought.join(',') || 'ничего');
  }

  {  // свой аванпост первого уровня и деньги — апгрейд окупается (доход + ремонт + пушка)
    const g = clean(900);
    const isl = g.map.lootIslands[0];
    isl.outpost = { owner: 0, level: 1, hp: 120 };
    put(g, 0, 'fregat', isl.x + 120, isl.y);
    let upgraded = false;
    for (let i = 0; i < movesBudget(g.config) && g.turn.idx === 0; i++) {
      const a = chooseBotAction(g, 0, 'hard');
      if (a.type === 'outpost') upgraded = true;
      applyAction(g, 'p0', a);
    }
    check('бот прокачивает свой аванпост', upgraded);
  }

  {  // незалутанный клад под боком — его надо брать, а не ловить рыбу
    const g = setup();
    g.config.multiMove = true; g.players[0].gold = 0;
    const isl = g.map.lootIslands[0];
    put(g, 0, 'shkhuna', isl.x - 200, isl.y);
    put(g, 0, 'brig', isl.x - 260, isl.y + 40);
    const a = chooseBotAction(g, 0, 'hard');
    const sh = g.ships.find(s2 => s2.id === a.shipId);
    const toIsland = a.type === 'collect' || (a.type === 'move' && sh &&
      Math.hypot(a.x - isl.x, a.y - isl.y) < Math.hypot(sh.x - isl.x, sh.y - isl.y));
    check('бот идёт за незалутанным кладом', toIsland, `(${a.type})`);
  }
}

console.log(`\nИтого: ${ok} ок, ${fail} провал(ов)`);
process.exit(fail ? 1 : 0);
