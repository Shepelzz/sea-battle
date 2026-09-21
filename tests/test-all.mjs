// Прогон всех логических тестов (без e2e test-flow, которому нужен запущенный сервер).
//
// Тесты читают файлы проекта по путям от КОРНЯ (`server/game.js`, `public/locales/ru.json`,
// `MECHANICS.md`), поэтому запускаются с cwd = корень — его и выставляем сами, чтобы
// `node tests/test-all.mjs` работал из любой папки.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const tests = ['test-i18n.mjs', 'test-docs.mjs', 'test-og.mjs', 'test-icons.mjs', 'test-log.mjs', 'test-config.mjs', 'test-broadside.mjs', 'test-pirates.mjs', 'test-coins.mjs', 'test-perks.mjs', 'test-balance2.mjs', 'test-bot.mjs', 'test-multimove.mjs', 'test-cheats.mjs', 'test-shipyard.mjs', 'test-repair.mjs', 'test-modes.mjs', 'test-auth.mjs', 'test-duel.mjs', 'test-lobby.mjs', 'test-stats.mjs', 'test-profile.mjs', 'test-storm.mjs', 'test-islands.mjs'];
let failed = 0;
for (const t of tests) {
  const r = spawnSync('node', [path.join(HERE, t)], { encoding: 'utf8', cwd: ROOT });
  const last = (r.stdout || '').trim().split('\n').pop();
  const okRun = r.status === 0;
  if (!okRun) failed++;
  console.log(`${okRun ? '✅' : '❌'} ${t.padEnd(20)} ${last || (r.stderr || '').trim().split('\n').pop() || ''}`);
}
console.log(failed ? `\n❌ Провалено наборов: ${failed}` : '\n✅ Все наборы зелёные');
process.exit(failed ? 1 : 0);
