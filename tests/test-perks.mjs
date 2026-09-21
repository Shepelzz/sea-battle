// 🎖 ПЕРКИ: разовые покупки за золото + 🪙 монеты.
//
// Схема «золото — цена, монета — разрешение»: золота в партии много, монет единицы, поэтому
// перк берётся раз-два за бой. Тест держит и покупку (цена, повторы, отказы), и КАЖДЫЙ эффект —
// иначе перк легко остаётся красивой строчкой в витрине, ничего не меняющей в бою.
import {
  createGame, addPlayer, startGame, applyAction, publicState, applyOutpostPerks, applyBasePerks
} from '../server/game.js';
import {
  PERKS, PERK_KEYS, hasPerk, perksEnabled, shipPrice, portReturnDmg, wreckLootFrac,
  windMoveMultFor, outpostMaxHp, portIncome, SHIP_TYPES, OUTPOST_LEVELS, PORT_RETURN_DMG,
  BATTERY_RETURN_DMG, MARKET_INCOME_MULT, GARRISON_HP_MULT, WAREHOUSE_INCOME,
  GRAPNELS_LOOT_FRAC, WRECK_LOOT_FRAC, SHIPYARD_DISCOUNT, DRYDOCK_HEAL, DRYDOCK_RADIUS, LIGHTHOUSE_EXTRA,
  fishIncomeFor, isInstantPerk, FISHERY_BONUS, PORT_REPAIR_FRAC, PORT_HP, isPerkHidden, shopPerks
} from '../server/config.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const no = (n, c) => { !c ? ok++ : (fail++, console.error('✗', n, '— ожидалось false')); };
const eq = (n, g, w) => { g === w ? ok++ : (fail++, console.error('✗', n, '— получили', JSON.stringify(g), 'ждали', JSON.stringify(w))); };

const banish = g => { for (const p of g.ships.filter(s => s.owner === -1)) { p.x = 20; p.y = 20; p.bornTurn = 1e9; } };
function game(cfg = {}) {
  const g = createGame('t', { maxPlayers: 2, turnTimer: 0, seed: 7 });
  Object.assign(g.config, { multiMove: true }, cfg);
  addPlayer(g, 'p0', 'A'); addPlayer(g, 'p1', 'B');
  startGame(g, 'p0');
  banish(g);
  return g;
}
const put = (g, owner, type, x, y, hp) => {
  const s = { id: `${owner}_${type}_${g.ships.length}`, owner, type, x, y, hp: hp ?? SHIP_TYPES[type].hp, heading: 0 };
  g.ships.push(s); return s;
};
const pirate = (g, x, y, hp = 1) => {
  const p = { id: 'PIR' + g.ships.length, owner: -1, type: 'pirate', x, y, hp, maxHp: 80,
    boss: false, bounty: 200, heading: 0, angryAt: null, turnSlot: 99, bornTurn: 1e9 };
  g.ships.push(p); return p;
};
const give = (g, pIdx, key) => { (g.players[pIdx].perks ??= {})[key] = true; };
const rich = (g, pIdx) => { g.players[pIdx].gold = 9999; g.players[pIdx].coins = 99; };

// ═══════════ ВИТРИНА И ПОКУПКА ═══════════
eq('перков ровно двенадцать', PERK_KEYS.length, 12);
// Скрытые: доделаны и покрыты тестами, но игроку не показываются и не продаются.
eq('скрыто ровно два', PERK_KEYS.filter(isPerkHidden).length, 2);
yes('батарея скрыта', isPerkHidden('battery'));
yes('гарнизон скрыт', isPerkHidden('garrison'));
yes('в витрине скрытых нет', Object.keys(shopPerks()).every(k => !isPerkHidden(k)));
eq('в витрине десять', Object.keys(shopPerks()).length, 10);
yes('у каждого есть цена в золоте', PERK_KEYS.every(k => PERKS[k].gold > 0));
yes('у каждого есть значок', PERK_KEYS.every(k => typeof PERKS[k].icon === 'string' && PERKS[k].icon));
yes('монеты требует большинство', PERK_KEYS.filter(k => PERKS[k].coins > 0).length >= 10);

{
  const g = game(); rich(g, 0);
  const before = { gold: g.players[0].gold, coins: g.players[0].coins, moves: g.turn.moves };
  const r = applyAction(g, 'p0', { type: 'buyPerk', key: 'market' });
  yes('покупка проходит', r.ok);
  yes('перк записан игроку', hasPerk(g, 0, 'market'));
  eq('золото списано', g.players[0].gold, before.gold - PERKS.market.gold);
  eq('монеты списаны', g.players[0].coins, before.coins - PERKS.market.coins);
  eq('покупка тратит манёвр', g.turn.moves, before.moves + 1);
  yes('в журнале есть запись', publicState(g, 'p0').log.some(l => l.k === 'log.perkBought'));
  const again = applyAction(g, 'p0', { type: 'buyPerk', key: 'market' });
  eq('второй раз тот же перк не купить', again.error, 'err.perkOwned');
  eq('соседу перк не достался', hasPerk(g, 1, 'market'), false);
}
{
  const g = game();
  g.players[0].gold = 10; g.players[0].coins = 9;
  eq('без золота — отказ', applyAction(g, 'p0', { type: 'buyPerk', key: 'market' }).error, 'err.noGoldFor');
  g.players[0].gold = 9999; g.players[0].coins = 0;
  eq('без монет — отказ', applyAction(g, 'p0', { type: 'buyPerk', key: 'market' }).error, 'err.noCoinsFor');
  rich(g, 0);
  eq('неизвестный ключ — отказ', applyAction(g, 'p0', { type: 'buyPerk', key: 'нетакого' }).error, 'err.unknownPerk');
  eq('пустой ключ — отказ', applyAction(g, 'p0', { type: 'buyPerk' }).error, 'err.unknownPerk');
  yes('после отказов казна цела', g.players[0].gold === 9999 && g.players[0].coins === 99);
}
{ // 🗼 маяк — единственный за чистое золото, монеты не нужны
  const g = game(); g.players[0].gold = 9999; g.players[0].coins = 0;
  yes('маяк берётся без монет', applyAction(g, 'p0', { type: 'buyPerk', key: 'lighthouse' }).ok);
}

// ═══════════ ДУЭЛЬ: ни перков, ни витрины ═══════════
{
  const g = createGame('d', { maxPlayers: 2, turnTimer: 0, seed: 7 });
  g.config.mode = 'duel';
  addPlayer(g, 'p0', 'A'); addPlayer(g, 'p1', 'B');
  startGame(g, 'p0'); banish(g);
  g.phase = 'battle';
  g.turn = { idx: 0, number: 1, round: 1, deadline: null, moves: 0, actedShips: [], broadsideSides: {} };
  rich(g, 0);
  no('perksEnabled в дуэли выключен', perksEnabled(g));
  eq('покупка в дуэли отклоняется', applyAction(g, 'p0', { type: 'buyPerk', key: 'market' }).error, 'err.perksOffHere');
  eq('витрина в дуэли пустая', publicState(g, 'p0').perkShop, null);
}

// ═══════════ ПРИВАТНОСТЬ ═══════════
{
  const g = game(); give(g, 0, 'market');
  eq('свои перки вижу', publicState(g, 'p0').players[0].perks.market, true);
  eq('чужие перки скрыты', publicState(g, 'p1').players[0].perks, null);
  const fin = game(); give(fin, 0, 'market'); fin.status = 'finished';
  eq('после финала раскрыты', publicState(fin, 'p1').players[0].perks.market, true);
}
{ // партия, сохранённая до ввода перков
  const g = game();
  delete g.players[0].perks;
  eq('старый сейв: hasPerk не падает', hasPerk(g, 0, 'market'), false);
  eq('старый сейв: в стейте пустой объект', JSON.stringify(publicState(g, 'p0').players[0].perks), '{}');
  rich(g, 0);
  yes('и покупка на нём работает', applyAction(g, 'p0', { type: 'buyPerk', key: 'market' }).ok);
}

// ═══════════ 🏰 БЕРЕГОВАЯ БАТАРЕЯ ═══════════
{
  const g = game();
  eq('без перка ответка обычная', portReturnDmg(g, 0, 'brig'), PORT_RETURN_DMG);
  give(g, 0, 'battery');
  eq('с батареей ответка сильнее', portReturnDmg(g, 0, 'brig'), BATTERY_RETURN_DMG);
  yes('линкору всё так же больнее', portReturnDmg(g, 0, 'linkor') > portReturnDmg(g, 0, 'brig'));
}
{ // в бою: батарея защитника снимает больше HP с атакующего
  const hit = (withPerk) => {
    const g = game();
    if (withPerk) give(g, 1, 'battery');
    const base = g.map.bases[1];
    const s = put(g, 0, 'linkor', base.x - 150, base.y);
    applyAction(g, 'p0', { type: 'attack', shipId: s.id, targetType: 'port', targetId: 1 });
    return SHIP_TYPES.linkor.hp - g.ships.find(x => x.id === s.id).hp;
  };
  const plain = hit(false), armed = hit(true);
  yes('осада против батареи дороже', armed > plain);
  eq('ровно по формуле', armed, portReturnDmg({ players: [{}, { perks: { battery: true } }] }, 1, 'linkor'));
}

// ═══════════ 📈 ТОРГОВЫЙ РЯД ═══════════
{
  const g = game();
  put(g, 0, 'linkor', 500, 500); put(g, 0, 'linkor', 560, 500);   // флот дорогой → надбавки бедного нет
  const plain = portIncome(g, 0);
  give(g, 0, 'market');
  eq('доход порта вырос в полтора раза', portIncome(g, 0), Math.round(plain * MARKET_INCOME_MULT));
}

// ═══════════ ⚓ СУХОЙ ДОК ═══════════
{
  const g = game();
  const base = g.map.bases[0];
  const near = put(g, 0, 'brig', base.x + 100, base.y, 10);
  const far = put(g, 0, 'brig', base.x + base.radius + DRYDOCK_RADIUS + 200, base.y, 10);
  const foe = put(g, 1, 'brig', base.x + 100, base.y + 40, 10);
  applyBasePerks(g, 0);
  eq('без перка никто не лечится', near.hp, 10);
  give(g, 0, 'drydock');
  applyBasePerks(g, 0);
  eq('свой у базы подлечился', near.hp, 10 + Math.round(SHIP_TYPES.brig.hp * DRYDOCK_HEAL));
  eq('дальний — нет', far.hp, 10);
  eq('чужой — нет', foe.hp, 10);
  const full = put(g, 0, 'brig', base.x + 90, base.y);
  applyBasePerks(g, 0);
  eq('целый корабль не перелечивается', full.hp, SHIP_TYPES.brig.hp);
}

// ═══════════ 🗼 МАЯК ═══════════
{
  const g = game();
  yes('радиус маяка уходит клиенту', publicState(g, 'p0').perkFx?.lighthouse === LIGHTHOUSE_EXTRA);
  yes('радиус положительный', LIGHTHOUSE_EXTRA > 0);
}

// ═══════════ 🛡 ГАРНИЗОН ═══════════
{
  const g = game();
  eq('без перка — паспортная прочность', outpostMaxHp(g, 0, 1), OUTPOST_LEVELS[0].hp);
  give(g, 0, 'garrison');
  eq('с гарнизоном — в полтора раза', outpostMaxHp(g, 0, 1), Math.round(OUTPOST_LEVELS[0].hp * GARRISON_HP_MULT));
}
{ // скрытый перк не купить, даже зная ключ
  const g = game(); rich(g, 0);
  eq('покупка скрытого отклоняется', applyAction(g, 'p0', { type: 'buyPerk', key: 'garrison' }).error, 'err.unknownPerk');
  eq('и батареи тоже', applyAction(g, 'p0', { type: 'buyPerk', key: 'battery' }).error, 'err.unknownPerk');
  eq('казна не тронута', g.players[0].gold, 9999);
  yes('в стейте витрины скрытых нет', !('garrison' in publicState(g, 'p0').perkShop));
}
{ // сам механизм гарнизона остаётся рабочим — он просто спрятан
  const g = game();
  const isl = g.map.lootIslands[0];
  isl.looted = true; isl.outpost = { owner: 0, level: 1, hp: OUTPOST_LEVELS[0].hp };
  give(g, 0, 'garrison');
  eq('гарнизон по-прежнему считает прочность', outpostMaxHp(g, 0, 1), Math.round(OUTPOST_LEVELS[0].hp * GARRISON_HP_MULT));
}

// ═══════════ 📦 СКЛАД ═══════════
{
  const g = game();
  const isl = g.map.lootIslands[0];
  isl.looted = true; isl.outpost = { owner: 0, level: 1, hp: OUTPOST_LEVELS[0].hp };
  const g0 = g.players[0].gold;
  applyOutpostPerks(g, 0);
  const plain = g.players[0].gold - g0;
  eq('без склада — доход уровня', plain, OUTPOST_LEVELS[0].income);
  give(g, 0, 'warehouse');
  const g1 = g.players[0].gold;
  applyOutpostPerks(g, 0);
  eq('со складом — плюс добавка', g.players[0].gold - g1, OUTPOST_LEVELS[0].income + WAREHOUSE_INCOME);
}

// ═══════════ 🏯 БАСТИОН ═══════════
{
  const shots = (withPerk) => {
    const g = game();
    if (withPerk) give(g, 0, 'bastion');
    const isl = g.map.lootIslands[0];
    isl.looted = true; isl.outpost = { owner: 0, level: 3, hp: OUTPOST_LEVELS[2].hp };
    const foe = put(g, 1, 'linkor', isl.x + 60, isl.y);
    applyOutpostPerks(g, 0);
    return SHIP_TYPES.linkor.hp - g.ships.find(s => s.id === foe.id).hp;
  };
  const gun = OUTPOST_LEVELS[2].gun;
  eq('обычный форт бьёт один раз', shots(false), gun);
  eq('бастион — дважды', shots(true), gun * 2);
}
{ // второй выстрел переносится на другую цель, если первую добили
  const g = game(); give(g, 0, 'bastion');
  const isl = g.map.lootIslands[0];
  isl.looted = true; isl.outpost = { owner: 0, level: 3, hp: OUTPOST_LEVELS[2].hp };
  const dying = put(g, 1, 'barkas', isl.x + 40, isl.y, 1);
  const second = put(g, 1, 'brig', isl.x + 80, isl.y);
  applyOutpostPerks(g, 0);
  yes('первую цель добили', !g.ships.some(s => s.id === dying.id));
  yes('второй выстрел ушёл в следующую', g.ships.find(s => s.id === second.id).hp < SHIP_TYPES.brig.hp);
}

// ═══════════ 🪝 АБОРДАЖНЫЕ КРЮЧЬЯ ═══════════
{
  const g = game();
  eq('без перка — половина цены', wreckLootFrac(g, 0), WRECK_LOOT_FRAC);
  give(g, 0, 'grapnels');
  eq('с крючьями — больше', wreckLootFrac(g, 0), GRAPNELS_LOOT_FRAC);
}
{ // в бою: лут с потопленного судна больше
  const loot = (withPerk) => {
    const g = game();
    if (withPerk) give(g, 0, 'grapnels');
    const mine = put(g, 0, 'fregat', 500, 500);
    const foe = put(g, 1, 'brig', 560, 500, 1);
    const before = g.players[0].gold;
    applyAction(g, 'p0', { type: 'attack', shipId: mine.id, targetType: 'ship', targetId: foe.id });
    return g.players[0].gold - before;
  };
  const plain = loot(false), hooked = loot(true);
  eq('обычный лут', plain, Math.round(SHIP_TYPES.brig.price * WRECK_LOOT_FRAC));
  eq('лут с крючьями', hooked, Math.round(SHIP_TYPES.brig.price * GRAPNELS_LOOT_FRAC));
  yes('крючья действительно выгоднее', hooked > plain);
}

// ═══════════ ⛵ КОСОЙ ПАРУС ═══════════
{
  const g = game();
  g.wind = { ang: 0, str: 1 };                       // ветер строго на восток, полной силы
  const against = Math.PI, along = 0;
  yes('без перка встречный режет ход', windMoveMultFor(g, 0, against) < 1);
  give(g, 0, 'lateen');
  eq('с парусом встречный не режет', windMoveMultFor(g, 0, against), 1);
  yes('попутный по-прежнему помогает', windMoveMultFor(g, 0, along) > 1);
  yes('соседу перк не помогает', windMoveMultFor(g, 1, against) < 1);
}
{ // в бою: ход против ветра, который раньше не проходил
  const g = game();
  g.wind = { ang: 0, str: 1 };
  const s = put(g, 0, 'brig', 800, 600);
  const far = { x: 800 - Math.round(SHIP_TYPES.brig.move * 0.9), y: 600 };  // на запад, против ветра
  const plain = applyAction(g, 'p0', { type: 'move', shipId: s.id, x: far.x, y: far.y });
  eq('без паруса — слишком далеко', plain.error, 'err.windTooFar');
  give(g, 0, 'lateen');
  yes('с парусом тот же ход проходит', applyAction(g, 'p0', { type: 'move', shipId: s.id, x: far.x, y: far.y }).ok);
}

// ═══════════ 🛠 ВЕРФЬ НА ПОТОКЕ ═══════════
{
  const g = game();
  eq('без перка — прайс', shipPrice(g, 0, 'linkor'), SHIP_TYPES.linkor.price);
  give(g, 0, 'shipyard');
  eq('со скидкой', shipPrice(g, 0, 'linkor'), Math.round(SHIP_TYPES.linkor.price * (1 - SHIPYARD_DISCOUNT)));
  yes('скидка реальная', shipPrice(g, 0, 'linkor') < SHIP_TYPES.linkor.price);
}
{ // покупка списывает именно сниженную цену
  const g = game(); give(g, 0, 'shipyard');
  g.players[0].gold = 1000;
  applyAction(g, 'p0', { type: 'buy', ships: ['brig'] });
  eq('списали со скидкой', g.players[0].gold, 1000 - shipPrice(g, 0, 'brig'));
}
{ // и клиенту уходят уже сниженные цены
  const g = game(); give(g, 0, 'shipyard');
  const s = publicState(g, 'p0');
  eq('в стейте цена со скидкой', s.shipPrices.brig, shipPrice(g, 0, 'brig'));
  eq('соседу — обычная', publicState(g, 'p1').shipPrices.brig, SHIP_TYPES.brig.price);
}

// ═══════════ 🐟 РЫБНЫЙ ПРОМЫСЕЛ ═══════════
{
  const g = game();
  eq('без перка — паспортный улов', fishIncomeFor(g, 0, 'barkas'), SHIP_TYPES.barkas.fishing);
  give(g, 0, 'fishery');
  eq('с промыслом — плюс надбавка', fishIncomeFor(g, 0, 'barkas'), SHIP_TYPES.barkas.fishing + FISHERY_BONUS);
  eq('соседу не помогает', fishIncomeFor(g, 1, 'barkas'), SHIP_TYPES.barkas.fishing);
  eq('небаркасу удваивать нечего', fishIncomeFor(g, 0, 'brig'), 0);
}
{ // в бою: улов капает в начале хода владельца
  const haul = (withPerk) => {
    const g = game();
    if (withPerk) give(g, 0, 'fishery');
    const z = g.map.fishZones[0];
    put(g, 0, 'barkas', z.x, z.y);
    const before = g.players[0].gold;
    applyAction(g, 'p0', { type: 'skip' });          // ход соперника…
    applyAction(g, 'p1', { type: 'skip' });          // …и снова мой: доход начислен
    return g.players[0].gold - before;
  };
  yes('с промыслом улов больше', haul(true) > haul(false));
}

// ═══════════ 🔧 РЕМОНТ ПОРТА (расходник) ═══════════
{
  const g = game(); rich(g, 0);
  g.players[0].portHp = 100;
  const r = applyAction(g, 'p0', { type: 'buyPerk', key: 'portRepair' });
  yes('ремонт проходит', r.ok);
  eq('порт починен на половину прочности', g.players[0].portHp, 100 + Math.round(PORT_HP * PORT_REPAIR_FRAC));
  no('расходник НЕ записывается в перки', hasPerk(g, 0, 'portRepair'));
  yes('в журнале запись о ремонте', publicState(g, 'p0').log.some(l => l.k === 'log.portRepaired'));
  yes('обычной «покупки перка» для расходника нет', !publicState(g, 'p0').log.some(l => l.k === 'log.perkBought'));
  const again = applyAction(g, 'p0', { type: 'buyPerk', key: 'portRepair' });
  yes('и его можно взять ещё раз', again.ok);
  eq('выше потолка не чинит', g.players[0].portHp, PORT_HP);
}
{
  const g = game(); rich(g, 0);
  eq('целый порт чинить нечем', applyAction(g, 'p0', { type: 'buyPerk', key: 'portRepair' }).error, 'err.portFull');
  eq('и казна цела', g.players[0].gold, 9999);
}
{ // расходник помечен флагом, постоянные перки — нет
  yes('portRepair — расходник', isInstantPerk('portRepair'));
  no('market — постоянный', isInstantPerk('market'));
  eq('расходник в списке один', PERK_KEYS.filter(isInstantPerk).length, 1);
}

console.log(fail ? `\n❌ test-perks: провалено ${fail}, прошло ${ok}` : `\n✅ test-perks: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
