// 🎨 Свой набор значков против игры.
//
// Значки в игре больше не системные: их рисует public/icons/sb.js, а подменяет public/js/icons.js.
// Отсюда два способа тихо сломаться:
//   • добавили эмодзи в словарь или разметку, а рисунка не сделали — игрок увидит системный
//     значок посреди своих, и на винде он будет выбиваться ровно так, как мы и чинили;
//   • переставили порядок подключения — sb.js обязан грузиться ДО icons.js, иначе набор пуст.
// Тест закрывает оба, плюс следит, что у каждого покупаемого класса судна есть своя иконка.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { SHIP_TYPES } from '../server/config.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const eq = (n, g, w) => { JSON.stringify(g) === JSON.stringify(w) ? ok++ : (fail++, console.error('✗', n, 'получили', JSON.stringify(g), 'ждали', JSON.stringify(w))); };

// ─── набор ───
const box = { window: {} };
vm.createContext(box);
vm.runInContext(readFileSync('public/icons/sb.js', 'utf8'), box);
const SET = box.window.SB_ICONS;
yes('sb.js отдаёт набор', !!SET && Object.keys(SET).length > 50);
eq('пустых рисунков нет', Object.entries(SET).filter(([, v]) => !v || !v.trim().startsWith('<')).map(([k]) => k), []);

// ─── список «оставить системными» ───
const iconsJs = readFileSync('public/js/icons.js', 'utf8');
const keep = [...iconsJs.matchAll(/'([0-9a-f]{2,6}(?:-[0-9a-f]{2,6})*)'/g)]
  .map(m => m[1])
  .filter(cp => /KEEP = new Set\(\[[^\]]*'/.test(iconsJs) && iconsJs.split('KEEP = new Set([')[1].split(']')[0].includes(`'${cp}'`));
eq('системными оставлены ровно 👆 👇 ✋', keep, ['1f446', '1f447', '270b']);
eq('у них рисунок всё равно есть (вернуть = одна строка)', keep.filter(cp => !SET[cp]), []);

// ─── покрытие: всё, что видит игрок, нарисовано ───
const RE = /\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const cpOf = ch => [...ch].map(c => c.codePointAt(0).toString(16)).join('-');
const vals = [];
const walk = o => { for (const v of Object.values(o)) typeof v === 'string' ? vals.push(v) : (v && typeof v === 'object' && walk(v)); };
walk(JSON.parse(readFileSync('public/locales/ru.json', 'utf8')));
for (const f of ['public/index.html', 'public/game.html'])
  vals.push(readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, ''));
for (const f of ['public/js/game.js', 'public/js/home.js'])
  vals.push(readFileSync(f, 'utf8').split('\n').filter(l => !l.trim().startsWith('//')).join('\n'));
for (const st of Object.values(SHIP_TYPES)) if (st.icon) vals.push(st.icon);

const seen = new Set();
for (const m of vals.join('\n').matchAll(RE)) seen.add(m[0]);
const undrawn = [...seen].map(cpOf).filter(cp => !SET[cp]);
eq(`нарисовано всё, что видит игрок (${seen.size} значков)`, undrawn, []);

// ─── флот: своя иконка на каждый ПОКУПАЕМЫЙ класс ───
for (const [type, st] of Object.entries(SHIP_TYPES)) {
  if (st.cheat || st.npc) continue;                    // авианосец и пират в верфи не продаются
  yes(`у класса ${type} есть своя иконка ship-${type}`, !!SET[`ship-${type}`]);
}

// ─── варианты одного символа ───
// Пиратский флаг на карте с древком, а в переключателе языка стоит флагом в ряду с 🇺🇦 и 🇬🇧 —
// там древко лишнее. Механика общая: ключ `<код>--<вариант>` + метка data-icon-variant в разметке.
{
  const PIRATE = '1f3f4-200d-2620-fe0f';
  yes('у пиратского флага есть «флажный» вариант', !!SET[`${PIRATE}--flag`]);
  yes('обычный (с древком) тоже на месте', !!SET[PIRATE]);
  yes('варианты — это разные рисунки', SET[PIRATE] !== SET[`${PIRATE}--flag`]);
  yes('icons.js умеет варианты', /data-icon-variant/.test(iconsJs) && /VARIANTS/.test(iconsJs));
  yes('переключатель языка помечен вариантом',
    /iconVariant = 'flag'/.test(readFileSync('public/js/i18n.js', 'utf8')));
  // вариант без базового рисунка — опечатка в ключе: подменять будет нечего
  eq('у каждого варианта есть базовый значок',
    Object.keys(SET).filter(k => k.includes('--')).filter(k => !SET[k.split('--')[0]]), []);
}

// ─── класс судна рисуется ПО ТИПУ, а не по эмодзи ───
// Иначе бриг снова возьмёт якорь, баркас — значок перка «косой парус», и разные классы
// в верфи опять станут неотличимы. Сторож на то, чтобы не откатились к `st.icon`.
{
  const g = readFileSync('public/js/game.js', 'utf8');
  yes('верфь рисует класс через SBIcons.ship', /SBIcons\.ship\(type, st\.icon\)/.test(g));
  yes('строка флота в справке — тоже', (g.match(/SBIcons\.ship\(type, st\.icon\)/g) || []).length >= 2);
  yes('заголовок панели судна — тоже', /SBIcons\.ship\(clickedShip\.type/.test(g));
  yes('icons.js отдаёт SBIcons.ship', /function ship\(type/.test(iconsJs));
}

// ─── порядок подключения ───
for (const f of ['public/index.html', 'public/game.html']) {
  const html = readFileSync(f, 'utf8');
  // ищем именно ТЕГИ: оба пути упоминаются ещё и в комментарии над ними
  const at = src => html.indexOf(`<script src="${src}">`);
  const set = at('/icons/sb.js'), swap = at('/js/icons.js');
  yes(`${f}: набор подключён`, set > 0);
  yes(`${f}: подменялка подключена`, swap > 0);
  yes(`${f}: набор идёт ДО подменялки`, set > 0 && swap > set);
}
// Страница сравнения обязана показывать СИСТЕМНЫЕ значки слева — подменять там нечего.
yes('icons-lab.html не подключает подменялку', !readFileSync('public/icons-lab.html', 'utf8').includes('/js/icons.js'));

console.log(fail ? `\n❌ test-icons: провалено ${fail}, прошло ${ok}` : `\n✅ test-icons: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
