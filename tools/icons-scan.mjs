// 🎨 Перепись иконок: что за эмодзи в игре, где он используется и нужен ли ему вариатор.
//
// Складывает public/icons-data.json, который читает страница сравнения /icons.html.
// Запуск из корня:  node tools/icons-scan.mjs
//
// Зачем: эмодзи рисует ШРИФТ СИСТЕМЫ. На макоси он один, на винде и андроиде другой —
// та же иконка выглядит иначе, а часть вообще становится чёрно-белой (см. флаг vs16).
// Чтобы выбрать свой набор, нужно сперва увидеть весь список в одном месте.
import fs from 'node:fs';
import path from 'node:path';

const RE = /\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*/gu;
const EMOJI_DEFAULT = /^\p{Emoji_Presentation}$/u;   // сам по себе рисуется цветным, вариатор не нужен
const cpOf = e => [...e].map(c => c.codePointAt(0).toString(16)).join('-');

// человеческие подписи: имя иконки и её роль в игре. Чего нет — покажется по кодпоинту.
const NAMES = JSON.parse(fs.readFileSync('tools/icons-names.json', 'utf8'));

const icons = new Map();
const add = (e, use) => {
  if (!icons.has(e)) {
    const single = [...e].length === 1;
    icons.set(e, {
      char: e, cp: cpOf(e),
      // вариатор нужен, когда символ по умолчанию текстовый: без U+FE0F винда рисует его
      // чёрно-белым глифом шрифта, а не цветной иконкой
      needsVs16: single && !EMOJI_DEFAULT.test(e) && !e.includes('️'),
      composite: !single,
      uses: []
    });
  }
  icons.get(e).uses.push(use);
};

// --- словари: только значения, с путём ключа (он и есть лучшее описание смысла) ---
for (const lang of ['ru']) {
  const walk = (o, prefix) => {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'string') { for (const m of v.matchAll(RE)) add(m[0], { src: `locales/${lang}.json`, key, text: v.slice(0, 90) }); }
      else if (v && typeof v === 'object') walk(v, key);
    }
  };
  walk(JSON.parse(fs.readFileSync(`public/locales/${lang}.json`, 'utf8')), '');
}

// --- разметка и клиентский код: без комментариев, с номером строки ---
const codeFiles = ['public/index.html', 'public/game.html', 'public/js/game.js', 'public/js/home.js', 'public/js/palette.js'];
for (const f of codeFiles) {
  const raw = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '));
  raw.split('\n').forEach((line, i) => {
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;   // комментарии не считаем
    for (const m of line.matchAll(RE))
      add(m[0], { src: f.replace('public/', ''), line: i + 1, text: line.trim().slice(0, 110), canvas: /fillText\(|SBIcons\.(text|draw)\(/.test(line) });
  });
}

// --- иконки сущностей из конфига (корабли, постройки) ---
for (const m of fs.readFileSync('server/config.js', 'utf8').matchAll(/(\w+):\s*\{[^}]*?icon:\s*'([^']+)'/gs))
  add(m[2], { src: 'server/config.js', key: m[1], text: `icon: '${m[2]}'` });

const out = [...icons.values()].map(o => ({
  ...o,
  ...(NAMES[o.char] || {}),
  onCanvas: o.uses.some(u => u.canvas),
  count: o.uses.length
})).sort((a, b) => b.count - a.count);

fs.writeFileSync('public/icons-data.json', JSON.stringify({ generated: Date.now(), icons: out }, null, 1) + '\n');
const noName = out.filter(o => !o.name);
console.log(`✅ ${out.length} иконок → public/icons-data.json`);
console.log(`   на канве: ${out.filter(o => o.onCanvas).length} · без вариатора: ${out.filter(o => o.needsVs16).length} · без подписи: ${noName.length}`);
if (noName.length) console.log('   нет подписи у: ' + noName.map(o => o.char).join(' '));
