// Звук: всё синтезируется Web Audio API, без аудиофайлов.
// Музыка — «Дрейф»: гипнотическое арпеджио Am(add9), как волны о борт.
const Sound = (() => {
  let ctx = null, master = null, musicGain = null, sfxGain = null, echo = null;
  let muted = localStorage.getItem('sb_muted') === '1';
  let musicTimer = null;
  let started = false;
  let musicVol = +(localStorage.getItem('sb_vol_music') ?? 0.6);
  let sfxVol = +(localStorage.getItem('sb_vol_sfx') ?? 0.5);

  const NOTE = n => 440 * Math.pow(2, (n - 69) / 12);
  // имена нот → midi
  const M = {};
  ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'].forEach((n, i) => {
    for (let o = 1; o <= 6; o++) M[n + o] = 12 * (o + 1) + i;
  });

  function ensureCtx() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 1;
      master.connect(ctx.destination);
      musicGain = ctx.createGain();
      musicGain.gain.value = musicVol;
      musicGain.connect(master);
      sfxGain = ctx.createGain();
      sfxGain.gain.value = sfxVol;
      sfxGain.connect(master);
      // «пространство» для музыки: задержка с обратной связью
      echo = ctx.createDelay(2);
      echo.delayTime.value = 0.45;
      const fb = ctx.createGain(); fb.gain.value = 0.38;
      const wet = ctx.createGain(); wet.gain.value = 0.35;
      echo.connect(fb).connect(echo);
      echo.connect(wet).connect(musicGain);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  // --- музыка: «Дрейф» ---
  function harp(noteName, t, vol = 0.1) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = NOTE(M[noteName]);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    osc.connect(g).connect(musicGain);
    g.connect(echo);
    osc.start(t);
    osc.stop(t + 1.5);
  }

  function pad(notes, t, dur, vol = 0.035) {
    for (const n of notes) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = NOTE(M[n]);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + dur * 0.35);
      g.gain.linearRampToValueAtTime(vol * 0.7, t + dur * 0.8);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900;
      osc.connect(g).connect(f).connect(musicGain);
      g.connect(echo);
      osc.start(t);
      osc.stop(t + dur + 0.1);
    }
  }

  function scheduleLoop(startT) {
    const arpAm = ['A2','E3','A3','B3','C4','E4','C4','B3'];
    const arpF  = ['F2','C3','F3','G3','A3','C4','A3','G3'];
    const step = 0.42;
    for (let r = 0; r < 4; r++) {
      const seq = (r === 2) ? arpF : arpAm;
      seq.forEach((n, i) => harp(n, startT + r * seq.length * step + i * step, 0.1));
    }
    pad(['A2','E3'], startT, arpAm.length * step * 2);
    pad(['F2','C3'], startT + arpAm.length * step * 2, arpAm.length * step * 2);
    const loopDur = arpAm.length * step * 4;
    musicTimer = setTimeout(() => scheduleLoop(ctx.currentTime + 0.05), (loopDur - 0.3) * 1000);
  }

  function startMusic() {
    if (started) return;
    started = true;
    ensureCtx();
    scheduleLoop(ctx.currentTime + 0.1);
  }

  // --- эффекты ---
  function noiseBuffer(dur, brown = false) {
    const b = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * dur) | 0, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w;
    }
    return b;
  }

  function noiseHit(dur, fStart, fEnd, vol, type = 'lowpass', opts = {}) {
    const { at = 0.003, delay = 0, brown = false, q = 1 } = opts;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(dur, brown);
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(fStart, t);
    if (fEnd) f.frequency.exponentialRampToValueAtTime(Math.max(20, fEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + at);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(sfxGain);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  function tone(freq, dur, type, vol, delay = 0, slideTo = null, at = 0.01) {
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + at);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(sfxGain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // бульк уходящего под воду
  function glug(f, vol, delay) {
    tone(f, 0.12, 'sine', vol, delay, f * 0.45);
  }

  const SFX = {
    click()  { tone(900, 0.05, 'square', 0.12); },
    // пушечный выстрел: «дальняя канонада» — низкий бум с раскатом и эхом
    shot()   {
      tone(75, 1.5, 'sine', 0.8, 0, 30, 0.03);
      noiseHit(1.9, 300, 55, 0.7, 'lowpass', { brown: true, at: 0.05 });
      tone(60, 0.9, 'sine', 0.28, 0.28, 28, 0.04);                       // эхо
      noiseHit(1.1, 220, 50, 0.22, 'lowpass', { brown: true, at: 0.06, delay: 0.3 });
    },
    // попадание ядра: короткий взрыв
    hit()    { noiseHit(0.3, 800, 90, 0.7); tone(180, 0.18, 'sine', 0.4, 0, 60); },
    // кораблекрушение: пар шипит, волна накрывает, пузыри ко дну
    // (взрывной «бум» здесь не нужен — его отыгрывает попадание ядра)
    wreck()  {
      noiseHit(1.3, 1400, 500, 0.3, 'highpass', { at: 0.05 });            // пар
      noiseHit(1.2, 850, 120, 0.55, 'lowpass', { at: 0.25, delay: 0.5 }); // волна
      for (let i = 0; i < 6; i++) {
        glug(170 + Math.random() * 210, 0.12 + Math.random() * 0.1, 0.9 + Math.random() * 1.3);
      }
    },
    coin()   { tone(880, 0.09, 'square', 0.2); tone(1320, 0.14, 'square', 0.2, 0.09); },
    // горсть монет на стол — для покупки
    coins()  {
      [988, 1175, 880, 1319, 1047].forEach((f, i) =>
        tone(f, 0.07 + Math.random() * 0.03, 'square', 0.16, i * 0.06));
    },
    move()   { noiseHit(0.4, 300, 1200, 0.18, 'bandpass'); },
    myturn() { tone(NOTE(M.E5), 0.12, 'triangle', 0.35); tone(NOTE(M.A5), 0.22, 'triangle', 0.35, 0.13); },
    horn()   { tone(196, 0.5, 'sawtooth', 0.25); tone(98, 0.5, 'sawtooth', 0.18); },
    pirate() { tone(110, 0.3, 'triangle', 0.3, 0, 82); tone(165, 0.25, 'triangle', 0.2, 0.28, 110); },
    win()    {
      ['A4', 'C5', 'E5', 'A5'].forEach((n, i) => tone(NOTE(M[n]), 0.14, 'square', 0.3, i * 0.13));
      ['A4', 'C5', 'E5', 'A5'].forEach(n => tone(NOTE(M[n]), 0.7, 'triangle', 0.16, 0.55));
    },
    lose()   { ['A4', 'E4', 'C4', 'A3'].forEach((n, i) => tone(NOTE(M[n]), 0.25, 'triangle', 0.3, i * 0.22)); }
  };

  function play(name) {
    if (muted || !SFX[name]) return;
    ensureCtx();
    SFX[name]();
  }

  // запуск звука с задержкой — для синхронизации с анимациями
  function playAt(name, delayMs) {
    if (!delayMs) return play(name);
    setTimeout(() => play(name), delayMs);
  }

  // звуки по записям журнала — только то, у чего нет события-анимации
  // (бой, лут и движение озвучиваются из playEvents синхронно с анимацией)
  const LOG_SOUNDS = [
    ['🛠', 'coins'], ['📯', 'horn'], ['🏴‍☠️ На горизонте', 'pirate'],
    ['🌫', 'pirate'], ['🏳️', 'horn'], ['⏰', 'horn'], ['⏭', 'click']
  ];
  let lastLogT = Date.now(); // не озвучиваем историю при входе

  function onState(prev, next, myIdxVal) {
    if (!prev || !prev.map) { lastLogT = Date.now(); return; }
    const fresh = next.log.filter(l => l.t > lastLogT);
    if (next.log.length) lastLogT = Math.max(lastLogT, next.log[next.log.length - 1].t);
    let played = 0;
    for (const entry of fresh) {
      if (entry.text.includes('👑')) { play(next.winner === myIdxVal ? 'win' : 'lose'); played++; continue; }
      const hit = LOG_SOUNDS.find(([k]) => entry.text.includes(k));
      if (hit && played < 3) { play(hit[1]); played++; }
    }
    // мой ход настал
    if (next.status === 'active' && myIdxVal >= 0 &&
        next.turn.idx === myIdxVal && prev.turn.idx !== myIdxVal) {
      play('myturn');
    }
  }

  function toggleMute() {
    muted = !muted;
    localStorage.setItem('sb_muted', muted ? '1' : '0');
    if (ctx) master.gain.value = muted ? 0 : 1;
    if (!muted) { ensureCtx(); startMusic(); }
    return muted;
  }

  // музыка стартует после первого жеста (требование браузеров)
  function armAutostart() {
    const kick = () => {
      document.removeEventListener('pointerdown', kick);
      document.removeEventListener('keydown', kick);
      if (!muted) { ensureCtx(); startMusic(); }
    };
    document.addEventListener('pointerdown', kick);
    document.addEventListener('keydown', kick);
  }

  function setVolumes(music, sfx) {
    if (music !== null && music !== undefined) {
      musicVol = music;
      localStorage.setItem('sb_vol_music', String(music));
      if (musicGain) musicGain.gain.value = music;
    }
    if (sfx !== null && sfx !== undefined) {
      sfxVol = sfx;
      localStorage.setItem('sb_vol_sfx', String(sfx));
      if (sfxGain) sfxGain.gain.value = sfx;
    }
  }

  return {
    play, playAt, onState, toggleMute, armAutostart, setVolumes, startMusic,
    get muted() { return muted; },
    get volumes() { return { music: musicVol, sfx: sfxVol }; }
  };
})();
