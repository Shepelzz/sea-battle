// Настройки анимаций — общие для игры и лаборатории /fx-lab.html.
// Лаборатория может сохранить свои значения в localStorage (sb_fx) —
// тогда игра в ЭТОМ браузере использует их вместо дефолтов.
window.FX_DEFAULTS = {
  sail: {
    moveDur: 700,    // длительность хода, мс
    wakeFade: 800,   // сколько след дотаивает после прибытия, мс
    lead: 60,        // «вынос» по старому курсу = крутизна разворота
    wakeWidth: 9,    // ширина волны следа
    foamWidth: 3.5,  // ширина белой пены
    wakeAlpha: 0.45  // яркость следа
  },
  shell: {
    dur: 380,        // время полёта ядра, мс
    arc: 28,         // высота дуги полёта
    size: 4          // размер ядра
  },
  boom: {
    small: 26,       // радиус вспышки попадания
    big: 48,         // радиус взрыва потопления/порта
    durSmall: 450,
    durBig: 750,
    shards: 7        // осколки-чёрточки
  },
  gold: {
    dur: 1500,       // время жизни «+N»
    rise: 52,        // насколько всплывает вверх
    grow: 0.45,      // увеличение к концу (0.45 = +45%)
    font: 17         // базовый размер шрифта
  }
};

window.FX = (() => {
  const deep = JSON.parse(JSON.stringify(window.FX_DEFAULTS));
  try {
    const saved = JSON.parse(localStorage.getItem('sb_fx') || 'null');
    if (saved) {
      for (const g in saved) {
        if (deep[g]) Object.assign(deep[g], saved[g]);
      }
    }
  } catch { /* кривой JSON — едем на дефолтах */ }
  return deep;
})();

window.FX_SAVE = () => localStorage.setItem('sb_fx', JSON.stringify(window.FX));
window.FX_RESET = () => { localStorage.removeItem('sb_fx'); location.reload(); };
