// Боковая навигация по lab-страницам. Подключается ТОЛЬКО на самих lab-страницах:
// в проде лабов нет, поэтому ни этот скрипт, ни ссылки на лабы на ГЛАВНУЮ не добавляем.
// Чтобы добавить новый лаб — допиши строку в LABS, и панель появится на всех страницах.
(() => {
  const LABS = [
    ['/fx-lab.html',     '🧪', 'Эффекты'],
    ['/sound-lab.html',  '🎙', 'Звуки'],
    ['/music-lab.html',  '🎵', 'Мелодии'],
    ['/ship-lab.html',   '⚓', 'Корабли'],
    ['/races-lab.html',  '⛵', 'Расы'],
    ['/move-lab.html',   '🧭', 'Ход'],
    ['/fort-lab.html',   '🏰', 'Форт'],
    ['/draft-fire.html', '🔥', 'Горящая база'],
  ];
  const here = (location.pathname.split('/').pop() || '').toLowerCase();

  const style = document.createElement('style');
  style.textContent = `
    #lab-nav { position: fixed; inset: 0 auto 0 0; z-index: 9999; width: 160px;
      box-sizing: border-box; padding: 14px 10px; overflow-y: auto;
      background: rgba(253,251,243,.97); border-right: 2px solid var(--ink,#2b3a55);
      transition: transform .2s ease; }
    #lab-nav h4 { margin: 2px 0 8px; font-size: 13px; letter-spacing: .6px;
      text-transform: uppercase; color: var(--pencil,#6b6f76); }
    #lab-nav a { display: block; padding: 7px 9px; margin: 3px 0; border-radius: 7px;
      font-size: 16px; text-decoration: none; color: var(--ink,#2b3a55);
      border: 1.5px solid transparent; }
    #lab-nav a:hover { background: var(--sea-hl,#e8eff7); }
    #lab-nav a.here { background: var(--sea-hl,#e8eff7); border-color: var(--ink,#2b3a55); font-weight: bold; }
    #lab-nav a.home { font-weight: bold; margin-bottom: 6px; padding-bottom: 10px;
      border-radius: 0; border-bottom: 1.5px dashed var(--pencil,#9aa0a6); }
    #lab-nav-toggle { position: fixed; top: 10px; left: 10px; z-index: 10000; display: none;
      width: 42px; height: 42px; font-size: 20px; line-height: 1; cursor: pointer; border-radius: 8px;
      background: var(--paper,#fdfbf3); border: 2px solid var(--ink,#2b3a55); }
    body { padding-left: 160px; }
    @media (max-width: 820px) {
      body { padding-left: 0; }
      #lab-nav { transform: translateX(-100%); padding-top: 60px; box-shadow: 3px 0 14px rgba(0,0,0,.25); }
      #lab-nav.open { transform: translateX(0); }
      #lab-nav-toggle { display: flex; align-items: center; justify-content: center; }
    }`;
  document.head.appendChild(style);

  const nav = document.createElement('nav');
  nav.id = 'lab-nav';
  nav.innerHTML = '<a class="home" href="/">🏠 Главная</a><h4>Лаборатории</h4>' +
    LABS.map(([href, emoji, label]) => {
      const cur = here && href.toLowerCase().endsWith(here) ? ' here' : '';
      return `<a class="lab${cur}" href="${href}">${emoji} ${label}</a>`;
    }).join('');

  const toggle = document.createElement('button');
  toggle.id = 'lab-nav-toggle';
  toggle.type = 'button';
  toggle.textContent = '☰';
  toggle.title = 'Лаборатории';
  toggle.addEventListener('click', () => nav.classList.toggle('open'));

  const mount = () => { document.body.appendChild(nav); document.body.appendChild(toggle); };
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
