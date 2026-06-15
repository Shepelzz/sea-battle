// Динамическая иконка вкладки: в меню — якорь, в игре — зелёный кружок (твой ход)
// или красный (ждёшь). Рисуем крупно и чисто, чтобы читалось при 16px.
(function () {
  const cvs = document.createElement('canvas');
  cvs.width = 64; cvs.height = 64;
  const c = cvs.getContext('2d');
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }

  function circle(fill) {
    c.clearRect(0, 0, 64, 64); // прозрачный фон — никаких сеток и рамок
    c.beginPath();
    c.arc(32, 32, 28, 0, Math.PI * 2);
    c.fillStyle = fill;
    c.fill();
    c.lineWidth = 5;
    c.strokeStyle = 'rgba(43,58,85,.85)';
    c.stroke();
  }

  function anchor() {
    // якорь нарисован линиями (не эмодзи) — чёткий на любом фоне вкладки
    circle('#2b3a55');
    c.strokeStyle = '#fdfbf3';
    c.fillStyle = '#fdfbf3';
    c.lineWidth = 4.5;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath(); c.moveTo(32, 22); c.lineTo(32, 47); c.stroke();      // шток
    c.beginPath(); c.arc(32, 18, 4.5, 0, Math.PI * 2); c.lineWidth = 4; c.stroke(); // рым
    c.beginPath(); c.moveTo(22, 27); c.lineTo(42, 27); c.lineWidth = 4.5; c.stroke(); // шток-перекладина
    c.beginPath(); c.arc(32, 40, 13, 0.18 * Math.PI, 0.82 * Math.PI); c.stroke();     // лапы
    c.beginPath(); c.moveTo(20.5, 41); c.lineTo(17, 35); c.stroke();    // левый рог
    c.beginPath(); c.moveTo(43.5, 41); c.lineTo(47, 35); c.stroke();    // правый рог
  }

  // kind: 'menu' | 'myturn' | 'wait' | 'lobby' | 'over'
  window.setFavicon = function (kind) {
    if (kind === 'myturn') circle('#2ecc71');
    else if (kind === 'wait') circle('#e74c3c');
    else if (kind === 'lobby') circle('#f1c40f');
    else if (kind === 'over') circle('#9a9a9a');
    else anchor();
    try { link.href = cvs.toDataURL('image/png'); } catch { /* canvas tainted — игнор */ }
  };
})();
