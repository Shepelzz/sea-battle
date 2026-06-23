// Звук: музыка и почти все эффекты синтезируются Web Audio API; пушечный залп — из сэмплов (/sounds/).
// Музыка — «Отлив»: гипнотическое арпеджио Dm(add9), как откатывающая от берега волна.
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

  const ARP_STEP = 0.44;             // «Отлив» — чуть медленнее «Дрейфа»
  const LOOP_DUR = 8 * ARP_STEP * 4; // 4 круга по 8 нот

  function scheduleLoop(startT) {
    const arpA = ['D3','A3','D4','E4','F4','A4','F4','E4'];   // Dm(add9)
    const arpB = ['A#2','F3','A#3','C4','D4','F4','D4','C4']; // переход на Bb
    for (let r = 0; r < 4; r++) {
      const seq = (r === 2) ? arpB : arpA;
      seq.forEach((n, i) => harp(n, startT + r * seq.length * ARP_STEP + i * ARP_STEP, 0.1));
    }
    pad(['D3','A3'], startT, arpA.length * ARP_STEP * 2);
    pad(['A#2','F3'], startT + arpA.length * ARP_STEP * 2, arpA.length * ARP_STEP * 2);
  }

  // Планировщик опирается на время АУДИО-контекста, а не на setTimeout:
  // когда вкладка в фоне и контекст замер, новые круги не планируются —
  // музыка не «наслаивается» при возвращении (баг задвоения на мобильных).
  let nextLoopT = 0;
  function startMusic() {
    if (started) return;
    started = true;
    ensureCtx();
    nextLoopT = ctx.currentTime + 0.1;
    musicTimer = setInterval(() => {
      if (!ctx || ctx.state !== 'running' || muted) return;
      // догоняем, если контекст долго стоял в фоне
      if (nextLoopT < ctx.currentTime - 0.05) nextLoopT = ctx.currentTime + 0.1;
      if (nextLoopT - ctx.currentTime < 0.5) {
        scheduleLoop(nextLoopT);
        nextLoopT += LOOP_DUR;
      }
    }, 250);
  }

  // --- эффекты ---
  // шина «удара»: мягкий перегруз для мощи попаданий
  let punch = null;
  function punchBus() {
    if (punch) return punch;
    const ws = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(2.6 * x); }
    ws.curve = curve;
    const g = ctx.createGain();
    g.gain.value = 0.85;
    ws.connect(g).connect(sfxGain);
    punch = ws;
    return punch;
  }

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
    const { at = 0.003, delay = 0, brown = false, q = 1, hard = false } = opts;
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
    src.connect(f).connect(g).connect(hard ? punchBus() : sfxGain);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  function tone(freq, dur, type, vol, delay = 0, slideTo = null, at = 0.01, hard = false) {
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + at);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(hard ? punchBus() : sfxGain);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  // бульк уходящего под воду
  function glug(f, vol, delay) {
    tone(f, 0.12, 'sine', vol, delay, f * 0.45);
  }

  // «цок» монеты: импульс шума через высокодобротные резонаторы металла
  function clink(base = 1, vol = 0.3, dur = 0.11, delay = 0) {
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(0.005);
    const drive = ctx.createGain();
    drive.gain.value = 16 * vol;
    src.connect(drive);
    [6300, 9100, 12100].forEach((f0, i) => {
      const f = f0 * base * (1 + (Math.random() - 0.5) * 0.06);
      if (f > 15500) return;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = 30;
      const g = ctx.createGain();
      g.gain.setValueAtTime(1 / (i + 1), t);
      g.gain.exponentialRampToValueAtTime(0.001, t + dur + i * 0.03);
      drive.connect(bp).connect(g).connect(sfxGain);
    });
    noiseHit(0.006, 4500, null, vol * 0.5, 'highpass', { at: 0.001, delay }); // тик касания
    src.start(t);
  }

  // брызги: россыпь крошечных шумовых зёрен
  function spray(n, t0, t1, vmin = 0.02, vmax = 0.08) {
    for (let i = 0; i < n; i++) {
      noiseHit(
        0.008 + Math.random() * 0.014,
        2000 + Math.random() * 4000, null,
        vmin + Math.random() * (vmax - vmin),
        'highpass',
        { at: 0.001, delay: t0 + Math.random() * (t1 - t0) }
      );
    }
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
    // попадание ядра: «борт раскалывается» — удар с двойным треском и щепками
    hit()    {
      tone(90, 0.35, 'sine', 0.85, 0, 35, 0.002, true);
      noiseHit(0.1, 4200, 900, 1, 'lowpass', { at: 0.001, hard: true });
      noiseHit(0.12, 3400, 600, 0.9, 'lowpass', { at: 0.001, delay: 0.09, hard: true });
      for (let i = 0; i < 9; i++) {
        noiseHit(0.02 + Math.random() * 0.03, 1500 + Math.random() * 3300, null,
          0.15 + Math.random() * 0.25, 'bandpass', { q: 5, at: 0.001, delay: 0.05 + Math.random() * 0.35 });
      }
      tone(95, 0.35, 'sawtooth', 0.07, 0.15, 70, 0.08); // скрип корпуса
    },
    // кораблекрушение: пар шипит, волна накрывает, пузыри ко дну
    // (взрывной «бум» здесь не нужен — его отыгрывает попадание ядра)
    wreck()  {
      noiseHit(1.3, 1400, 500, 0.3, 'highpass', { at: 0.05 });            // пар
      noiseHit(1.2, 850, 120, 0.55, 'lowpass', { at: 0.25, delay: 0.5 }); // волна
      for (let i = 0; i < 6; i++) {
        glug(170 + Math.random() * 210, 0.12 + Math.random() * 0.1, 0.9 + Math.random() * 1.3);
      }
    },
    // авто-очередь авианосца: короткий резкий «так» (играется 5 раз подряд → пулемётная очередь)
    autoshot() {
      noiseHit(0.04, 3200, 600, 0.5, 'highpass', { at: 0.0005, hard: true }); // резкий крак ствола
      tone(200, 0.05, 'square', 0.32, 0, 70, 0.0008, true);                    // низкий «тук»
      noiseHit(0.05, 1500, 300, 0.22, 'bandpass', { q: 4, at: 0.001, delay: 0.005 }); // призвук
    },
    // монета: короткий металлический «цок»
    coin()   { clink(1, 0.35, 0.12); },
    // покупка: кошель шлёпнулся на стол + горсть монет
    coins()  {
      tone(150, 0.1, 'sine', 0.35, 0, 75, 0.003);
      noiseHit(0.08, 350, null, 0.3, 'lowpass', { at: 0.005 });
      for (let i = 0; i < 9; i++) {
        clink(0.8 + Math.random() * 0.4, 0.08 + Math.random() * 0.14,
          0.05 + Math.random() * 0.05, (0.02 + Math.random() * 0.38) * (0.3 + i / 9));
      }
    },
    // плеск хода: гребок с брызгами
    move()   {
      noiseHit(0.5, 400, 1700, 0.5, 'bandpass', { q: 1.4, at: 0.08 });
      noiseHit(0.35, 1500, 450, 0.35, 'bandpass', { q: 1.4, at: 0.05, delay: 0.28 });
      spray(22, 0.05, 0.55);
    },
    // «твой ход»: ясный восходящий перезвон (A-арпеджио) — заметнее прежних двух нот
    myturn() {
      [['E5', 0], ['A5', 0.12], ['C#6', 0.24]].forEach(([n, t]) => tone(NOTE(M[n]), 0.5, 'triangle', 0.34, t));
      tone(NOTE(M.A5), 0.55, 'sine', 0.1, 0.24); // мягкий «дзынь» сверху для заметности
    },
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

  // ─── сэмплы из файлов ───
  // Для звуков, которые синтезом не передать (живой пушечный залп). Грузятся по требованию,
  // играют через ту же sfx-шину — значит слушаются громкость эффектов и общий mute.
  const samples = {}; // имя → AudioBuffer
  async function loadSample(name, url) {
    ensureCtx();
    if (samples[name]) return samples[name];
    samples[name] = await fetch(url).then(r => {
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }).then(a => ctx.decodeAudioData(a));
    return samples[name];
  }
  function hasSample(name) { return !!samples[name]; }
  // одиночный выстрел сэмплом: vol — громкость, rate — высота, delay — задержка (сек), pan — панорама [-1..1]
  function playSample(name, { vol = 1, rate = 1, delay = 0, pan = 0 } = {}) {
    const buf = samples[name];
    if (muted || !buf) return;
    ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(g);
    let tail = g;
    if (pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p); tail = p;
    }
    tail.connect(sfxGain);
    src.start(ctx.currentTime + Math.max(0, delay));
  }
  // 💥 бортовой залп сэмплом: очередь из shots выстрелов со случайным разносом и лёгким
  // разбросом высоты/панорамы — «стволы бьют не идеально разом».
  function volley(name, { shots = 4, spreadMs = 80, vol = 0.7 } = {}) {
    if (muted || !samples[name]) return;
    ensureCtx();
    let t = 0;
    for (let i = 0; i < shots; i++) {
      playSample(name, {
        vol: vol * (0.82 + Math.random() * 0.3),
        rate: 0.93 + Math.random() * 0.14,
        delay: t / 1000,
        pan: (Math.random() * 2 - 1) * 0.55
      });
      t += spreadMs * (0.6 + Math.random() * 0.8);
    }
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
    loadSample, playSample, volley, hasSample,
    get muted() { return muted; },
    get volumes() { return { music: musicVol, sfx: sfxVol }; }
  };
})();
