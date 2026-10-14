// Casino sound effects, synthesised with the Web Audio API (no audio files).
window.Sound = (() => {
  'use strict';

  const KEY = 'poker-night-payout:sound';
  let enabled = true;
  try { enabled = localStorage.getItem(KEY) !== 'off'; } catch { /* ignore */ }

  let ctx = null;

  // Browsers only allow audio after a user gesture; every sound is triggered
  // by a click, so the context is created lazily on first use.
  function audio() {
    if (!enabled) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(c, { type = 'sine', freq, at = 0, dur, gain = 0.15, attack = 0.005, glideTo }) {
    const start = c.currentTime + at;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + attack);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(amp).connect(c.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  // Bright two-step arcade coin.
  function coin(at = 0) {
    const c = audio();
    if (!c) return;
    tone(c, { type: 'square', freq: 988, at, dur: 0.07, gain: 0.06 });
    tone(c, { type: 'square', freq: 1319, at: at + 0.07, dur: 0.32, gain: 0.06 });
  }

  // Same coin, falling: used when a buy-in is taken back.
  function coinDown() {
    const c = audio();
    if (!c) return;
    tone(c, { type: 'square', freq: 1319, dur: 0.07, gain: 0.05 });
    tone(c, { type: 'square', freq: 784, at: 0.07, dur: 0.22, gain: 0.05 });
  }

  // Soft "payment accepted" chime: two rising bell tones with a quiet octave.
  function pay() {
    const c = audio();
    if (!c) return;
    [[1175, 0], [1760, 0.11]].forEach(([f, at]) => {
      tone(c, { freq: f, at, dur: 0.55, gain: 0.16, attack: 0.008 });
      tone(c, { type: 'triangle', freq: f * 2, at, dur: 0.25, gain: 0.03 });
    });
  }

  // Slot-machine payout: a cascade of coins.
  function jackpot() {
    if (!audio()) return;
    for (let i = 0; i < 6; i++) coin(i * 0.09);
  }

  function setEnabled(on) {
    enabled = on;
    try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
  }

  return { coin, coinDown, pay, jackpot, setEnabled, get enabled() { return enabled; } };
})();
