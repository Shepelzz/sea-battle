// Прогон всех логических тестов (без e2e test-flow, которому нужен запущенный сервер).
import { spawnSync } from 'node:child_process';

const tests = ['test-config.mjs', 'test-broadside.mjs', 'test-pirates.mjs', 'test-balance2.mjs', 'test-bot.mjs', 'test-multimove.mjs', 'test-cheats.mjs', 'test-shipyard.mjs', 'test-repair.mjs', 'test-modes.mjs', 'test-auth.mjs'];
let failed = 0;
for (const t of tests) {
  const r = spawnSync('node', [t], { encoding: 'utf8' });
  const last = (r.stdout || '').trim().split('\n').pop();
  const okRun = r.status === 0;
  if (!okRun) failed++;
  console.log(`${okRun ? '✅' : '❌'} ${t.padEnd(20)} ${last || (r.stderr || '').trim().split('\n').pop() || ''}`);
}
console.log(failed ? `\n❌ Провалено наборов: ${failed}` : '\n✅ Все наборы зелёные');
process.exit(failed ? 1 : 0);
