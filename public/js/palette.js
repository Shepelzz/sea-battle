// Общий выпадающий выбор цвета (главная и лобби). Палитра приходит с сервера.
// renderColorDropdown(host, palette, selected, onPick, taken?):
//   host — контейнер; кнопка показывает текущий цвет, клик открывает сетку образцов.
//   taken — Set цветов, занятых другими (в списке приглушены и недоступны).
function renderColorDropdown(host, palette, selected, onPick, taken) {
  host.innerHTML = '';
  host.classList.add('color-dd');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'color-dd-btn';
  btn.innerHTML = `<span class="dd-dot" style="background:${selected || '#ccc'}"></span><span class="dd-caret">▾</span>`;

  const menu = document.createElement('div');
  menu.className = 'color-dd-menu hidden';
  for (const c of palette) {
    const o = document.createElement('button');
    o.type = 'button';
    o.className = 'swatch' + (c === selected ? ' sel' : '');
    o.style.background = c;
    o.title = c;
    if (taken && taken.has(c) && c !== selected) { o.classList.add('taken'); o.disabled = true; }
    o.addEventListener('click', e => { e.stopPropagation(); menu.classList.add('hidden'); onPick(c); });
    menu.appendChild(o);
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.color-dd-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
    menu.classList.toggle('hidden');
  });

  host.append(btn, menu);
}

// Выпадающий выбор игрового режима — СВОЙ дропдаун (не нативный <select>): нативный на мобиле
// всплывает не там (внутри повёрнутой .note), а этот позиционируется CSS под кнопкой.
// renderModeDropdown(host, modes, selectedKey, onPick): modes = [{key,name,desc}].
function renderModeDropdown(host, modes, selected, onPick) {
  host.innerHTML = '';
  host.classList.add('mode-dd');
  const cur = modes.find(m => m.key === selected) || modes[0];

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'mode-dd-btn';
  btn.innerHTML = `<span class="dd-label"></span><span class="dd-caret">▾</span>`;
  btn.querySelector('.dd-label').textContent = cur ? cur.name : '';

  const menu = document.createElement('div');
  menu.className = 'mode-dd-menu hidden';
  for (const m of modes) {
    const o = document.createElement('button');
    o.type = 'button';
    o.className = 'mode-dd-opt' + (m.key === selected ? ' sel' : '');
    o.textContent = m.name;
    o.addEventListener('click', e => { e.stopPropagation(); menu.classList.add('hidden'); onPick(m.key); });
    menu.appendChild(o);
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    document.querySelectorAll('.mode-dd-menu, .color-dd-menu').forEach(x => { if (x !== menu) x.classList.add('hidden'); });
    const opening = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    if (opening) {   // если меню не влезает вниз (низ экрана) — открыть его ВВЕРХ
      menu.classList.remove('up');
      if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) menu.classList.add('up');
    }
  });

  host.append(btn, menu);
}

// клик мимо — закрыть все открытые списки (и цвет, и режим)
document.addEventListener('click', () => {
  document.querySelectorAll('.color-dd-menu, .mode-dd-menu').forEach(m => m.classList.add('hidden'));
});
