// Главная: создание баттла + лидерборд.
const $ = s => document.querySelector(s);

function getToken() {
  let t = localStorage.getItem('sb_token');
  if (!t) { t = crypto.randomUUID(); localStorage.setItem('sb_token', t); }
  return t;
}

$('#nick').value = localStorage.getItem('sb_nick') || '';

// --- выбор режима ---
function showMode(mode) {
  $('#modeBtns').classList.toggle('hidden', !!mode);
  $('#editorOnline').classList.toggle('hidden', mode !== 'online');
  $('#editorHotseat').classList.toggle('hidden', mode !== 'hotseat');
  $('#editorBot').classList.toggle('hidden', mode !== 'bot');
}
document.querySelectorAll('.mode-btn[data-mode]').forEach(b =>
  b.addEventListener('click', () => showMode(b.dataset.mode)));
document.querySelectorAll('[data-back]').forEach(b =>
  b.addEventListener('click', () => showMode(null)));

// --- хотсит: поля имён по числу игроков ---
function renderHotseatNames() {
  const n = +$('#hotseatCount').value;
  const old = [...document.querySelectorAll('#hotseatNames input')].map(i => i.value);
  $('#hotseatNames').innerHTML = Array.from({ length: n }, (_, i) => `
    <label>Игрок ${i + 1}</label>
    <input type="text" maxlength="20" placeholder="${['Капитан', 'Адмирал', 'Боцман', 'Юнга'][i]}…" value="${old[i] ? old[i].replace(/"/g, '&quot;') : ''}">`).join('');
}
$('#hotseatCount').addEventListener('change', renderHotseatNames);
renderHotseatNames();

$('#hotseatBtn').addEventListener('click', async () => {
  const nicks = [...document.querySelectorAll('#hotseatNames input')].map(i => i.value.trim());
  if (nicks.some(n => !n)) { $('#hotseatError').textContent = 'Впиши имена всех игроков!'; return; }
  if (new Set(nicks).size !== nicks.length) { $('#hotseatError').textContent = 'Имена не должны повторяться'; return; }
  $('#hotseatBtn').disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getToken(), mode: 'hotseat', nicks })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    // ник нужен для входа на страницу игры (в хотсите не показывается)
    if (!localStorage.getItem('sb_nick')) localStorage.setItem('sb_nick', nicks[0]);
    location.href = '/game/' + data.gameId;
  } catch (e) {
    $('#hotseatError').textContent = e.message;
    $('#hotseatBtn').disabled = false;
  }
});

// Вход через Google (если настроен на сервере).
(async () => {
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (!cfg.googleClientId) return;
    $('#authBox').classList.remove('hidden');
    if (localStorage.getItem('sb_session')) {
      $('#authStatus').textContent = '✔ Вошёл через Google — придут письма, если тебя будут торопить';
      $('#logoutBtn').classList.remove('hidden');
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => {
      google.accounts.id.initialize({
        client_id: cfg.googleClientId,
        callback: async resp => {
          const r = await fetch('/api/auth/google', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ credential: resp.credential, nick: $('#nick').value.trim() })
          });
          const data = await r.json();
          if (!r.ok) { $('#createError').textContent = data.error; return; }
          localStorage.setItem('sb_session', data.session);
          localStorage.setItem('sb_nick', data.nick);
          $('#nick').value = data.nick;
          $('#googleBtn').innerHTML = '';
          $('#authStatus').textContent = `✔ ${data.email}`;
          $('#logoutBtn').classList.remove('hidden');
        }
      });
      google.accounts.id.renderButton($('#googleBtn'), { theme: 'outline', size: 'medium', text: 'signin_with' });
    };
    document.head.appendChild(s);
  } catch { /* без Google тоже работаем */ }
})();

$('#logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('sb_session');
  location.reload();
});

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
        session: localStorage.getItem('sb_session') || undefined,
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

// --- против компьютера ---
$('#botNick').value = localStorage.getItem('sb_nick') || '';
$('#botBtn').addEventListener('click', async () => {
  const nick = $('#botNick').value.trim();
  if (!nick) { $('#botError').textContent = 'Впиши ник!'; return; }
  localStorage.setItem('sb_nick', nick);
  $('#botBtn').disabled = true;
  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: getToken(),
        session: localStorage.getItem('sb_session') || undefined,
        mode: 'bot',
        nick,
        bots: +$('#botCount').value,
        level: $('#botLevel').value
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка сервера');
    location.href = '/game/' + data.gameId;
  } catch (e) {
    $('#botError').textContent = e.message;
    $('#botBtn').disabled = false;
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
