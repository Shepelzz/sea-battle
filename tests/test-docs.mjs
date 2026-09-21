// 📄 MECHANICS.md против кода: документация гниёт молча.
//
// README уже разъезжался с балансом (ход баркаса, ответка порта, правила залпа) — заметить это
// можно было только случайно. Тест закрывает три самых частых способа соврать:
//   • число в тексте разошлось с константой в config.js;
//   • таблица флота/аванпостов отстала от SHIP_TYPES / OUTPOST_LEVELS;
//   • упомянут файл, которого больше нет (переименовали модуль — ссылка протухла).
//
// Он НЕ проверяет прозу: за смысл отвечает автор. Он держит цифры и пути.
import { readFileSync, existsSync } from 'node:fs';
import * as CFG from '../server/config.js';

let ok = 0, fail = 0;
const yes = (n, c) => { c ? ok++ : (fail++, console.error('✗', n)); };
const eq = (n, g, w) => { g === w ? ok++ : (fail++, console.error('✗', n, '— в доке', g, ', в коде', w)); };

const DOC = 'MECHANICS.md';
yes(`${DOC} существует`, existsSync(DOC));
const md = readFileSync(DOC, 'utf8');

// ─── 1. Пути к файлам: всё, что упомянуто в `бэктиках`, должно существовать ───
{
  const paths = new Set();
  for (const m of md.matchAll(/`((?:server|public|tests|tools|test-|sim|ab-bot|ladder)[\w/.-]*\.(?:js|mjs|json|html|css|md))`/g))
    paths.add(m[1]);
  yes('пути вообще упоминаются', paths.size >= 15);
  for (const p of paths) yes(`файл существует: ${p}`, existsSync(p));
}

// ─── 2. Константы: `ИМЯ = число` в тексте против экспорта config.js ───
// Ловит ровно тот случай, когда баланс покрутили, а доку забыли.
{
  let checked = 0;
  for (const m of md.matchAll(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*(-?\d+(?:\.\d+)?)\b/g)) {
    const [, name, raw] = m;
    const real = CFG[name];
    if (typeof real !== 'number') continue;   // не константа конфига (или не число) — не наше дело
    checked++;
    eq(`константа ${name}`, Number(raw), real);
  }
  yes(`константы сверены (${checked} шт.)`, checked >= 25);
}

// ─── 3. Таблица флота ───
// Строка вида: | `barkas` | ⛵ | 60 | 30 | 5 | 70 | 180 | … |
{
  const rows = [...md.matchAll(/^\|\s*`(\w+)`\s*\|[^|]*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/gm)];
  const seen = new Set();
  for (const [, type, price, hp, dmg, fireRange, move] of rows) {
    const st = CFG.SHIP_TYPES[type];
    if (!st) { fail++; console.error('✗ в таблице флота класс, которого нет в SHIP_TYPES:', type); continue; }
    seen.add(type);
    eq(`${type}: цена`, +price, st.price);
    eq(`${type}: HP`, +hp, st.hp);
    eq(`${type}: урон`, +dmg, st.dmg);
    eq(`${type}: дальность огня`, +fireRange, st.fireRange);
    eq(`${type}: ход`, +move, st.move);
  }
  for (const type of Object.keys(CFG.SHIP_TYPES))
    yes(`класс ${type} описан в таблице флота`, seen.has(type));
}

// ─── 4. Таблица аванпостов ───
// Строка вида: | 1 | ⛺ | 150 | 120 | 3 | … |
{
  const rows = [...md.matchAll(/^\|\s*([123])\s*\|\s*[^|]*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/gm)];
  eq('уровней аванпоста в таблице', rows.length, CFG.OUTPOST_LEVELS.length);
  for (const [, lvl, price, hp, income] of rows) {
    const def = CFG.OUTPOST_LEVELS[+lvl - 1];
    if (!def) { fail++; console.error('✗ лишний уровень аванпоста в доке:', lvl); continue; }
    eq(`аванпост ${lvl}: цена`, +price, def.price);
    eq(`аванпост ${lvl}: HP`, +hp, def.hp);
    eq(`аванпост ${lvl}: доход`, +income, def.income);
  }
}

// ─── 5. Режимы: каждый включённый режим должен быть описан ───
for (const mode of CFG.enabledModes())
  yes(`режим ${mode} описан`, new RegExp('`' + mode + '`').test(md));

// ─── 6. Действия: каждый case из applyAction должен быть в таблице действий ───
{
  const src = readFileSync('server/game.js', 'utf8');
  const body = src.slice(src.indexOf('export function applyAction'));
  const types = new Set([...body.matchAll(/^\s{4}case '(\w+)':/gm)].map(m => m[1]));
  yes(`действия найдены в applyAction (${types.size} шт.)`, types.size >= 8);
  for (const t of types) yes(`действие ${t} описано`, new RegExp('`' + t + '`').test(md));
}

console.log(fail ? `\n❌ test-docs: провалено ${fail}, прошло ${ok}` : `\n✅ test-docs: все ${ok} проверок прошли`);
process.exit(fail ? 1 : 0);
