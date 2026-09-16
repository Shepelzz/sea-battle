// 🏷 ВЕРСИЯ СБОРКИ. Источник правды — поле version в package.json: его двигает `npm version`,
// который сам делает коммит и ставит git-тег (см. скрипты release:* и README).
//
// К номеру добавляем короткий хеш коммита и его дату — по ним всегда понятно, ЧТО именно
// крутится на сервере, даже если версию забыли поднять. Хеш берём из git, а если .git рядом
// нет (типичный деплой — распакованный архив), молча обходимся без него: падать из-за
// отсутствия гита сборка не должна.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const pkgVersion = (() => {
  try { return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

const git = args => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
};

// Считаем один раз при старте: дальше это просто константа.
// НОМЕР СБОРКИ — количество коммитов в истории. Он растёт сам на каждом пуше и честно
// отражает весь проделанный путь, в отличие от version, которую двигают вручную на релизах.
// Хеш коммита наружу не показываем — в подвале он не нужен.
export const VERSION = {
  version: pkgVersion,
  build: Number(git(['rev-list', '--count', 'HEAD'])) || null,
  date: git(['log', '-1', '--format=%cs']),
};

/** Строка для подвала: «v1.3.0 · сборка 74 · 2026-09-16» (хвосты опускаются, если их нет). */
export const versionLabel = () => [
  'v' + VERSION.version,
  VERSION.build ? 'сборка ' + VERSION.build : '',
  VERSION.date,
].filter(Boolean).join(' · ');
