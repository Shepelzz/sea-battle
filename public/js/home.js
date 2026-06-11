// Главная: создание баттла + лидерборд.
const $ = s => document.querySelector(s);

function getToken() {
  let t = localStorage.getItem('sb_token');
  if (!t) { t = crypto.randomUUID(); localStorage.setItem('sb_token', t); }
  return t;
}

$('#nick').value = localStorage.getItem('sb_nick') || '';

$('#createBtn').addEventListener('click', async () => {
  const nick = $('#nick').value.trim();
  if (!nick) { $('#createError').textContent = 'Сначала впиши ник!'; return; }
  localStorage.setItem('sb_nick', nick);
  $('#createBtn').disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: getToken(),
        nick,
        maxPlayers: +$('#maxPlayers').value,
        turnTimer: +$('#turnTimer').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    location.href = '/game/' + data.gameId;
  } catch (e) {
    $('#createError').textContent = e.message;
    $('#createBtn').disabled = false;
  }
});

(async function loadLeaderboard() {
  try {
    const rows = await (await fetch('/api/leaderboard')).json();
    if (!rows.length) return;
    const medals = ['🥇', '🥈', '🥉'];
    $('#leaderboard tbody').innerHTML = rows.map((r, i) => `
      <tr>
        <td class="medal">${medals[i] || i + 1}</td>
        <td>${escapeHtml(r.nick)}</td>
        <td><b>${r.points}</b></td>
        <td>${r.wins}</td>
        <td>${r.games}</td>
        <td>${r.damage}</td>
        <td>${r.sunk}</td>
        <td>${r.gold}</td>
      </tr>`).join('');
  } catch { /* лидерборд не критичен */ }
})();

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
