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

// клик мимо — закрыть все открытые списки
document.addEventListener('click', () => {
  document.querySelectorAll('.color-dd-menu').forEach(m => m.classList.add('hidden'));
});
