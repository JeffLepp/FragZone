// Procedural audio via Web Audio API
export class AudioSystem {
  constructor() {
    this._ctx = null;
    this._master = null;
    this._stepTimer = 0;
    this._lastStepSide = 0;
  }

  _init() {
    if (this._ctx) return;
    this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Browsers suspend AudioContext by default; resume so sounds actually play.
    this._ctx.resume();
    this._master = this._ctx.createGain();
    this._master.gain.value = 0.6;
    this._master.connect(this._ctx.destination);
  }

  _noise(duration) {
    const ctx   = this._ctx;
    const size  = Math.ceil(ctx.sampleRate * duration);
    const buf   = ctx.createBuffer(1, size, ctx.sampleRate);
    const data  = buf.getChannelData(0);
    for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  }

  _connect(node, gain) {
    const g = this._ctx.createGain();
    g.gain.value = gain;
    node.connect(g);
    g.connect(this._master);
    return g;
  }

  playGunshot(weapon) {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;

    const noise = this._noise(0.18);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = weapon === 'ak' ? 400 : 700;
    filter.Q.value = 0.6;

    const env = ctx.createGain();
    const peak = weapon === 'ak' ? 1.8 : 1.2;
    env.gain.setValueAtTime(peak, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + (weapon === 'ak' ? 0.14 : 0.09));

    noise.connect(filter);
    filter.connect(env);
    env.connect(this._master);
    noise.start(now);
    noise.stop(now + 0.2);

    // Low "thump"
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(weapon === 'ak' ? 120 : 200, now);
    osc.frequency.exponentialRampToValueAtTime(30, now + 0.12);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.8, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(og);
    og.connect(this._master);
    osc.start(now);
    osc.stop(now + 0.14);
  }

  playEmpty() {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 220;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    osc.connect(g); g.connect(this._master);
    osc.start(now); osc.stop(now + 0.07);
  }

  playReload() {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;
    // Metal click
    const n = this._noise(0.05);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 2000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.6, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
    n.connect(f); f.connect(g); g.connect(this._master);
    n.start(now); n.stop(now + 0.06);
  }

  playHitMarker() {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.frequency.value = 1000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    osc.connect(g); g.connect(this._master);
    osc.start(now); osc.stop(now + 0.05);
  }

  playKillConfirm() {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;
    [880, 1100].forEach((freq, i) => {
      const t = now + i * 0.06;
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
      osc.connect(g); g.connect(this._master);
      osc.start(t); osc.stop(t + 0.06);
    });
  }

  playPickup() {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(520, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.09);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    osc.connect(g); g.connect(this._master);
    osc.start(now); osc.stop(now + 0.13);
  }

  playGrenadePull() {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const n = this._noise(0.03);
    const f = ctx.createBiquadFilter();
    f.type = 'highpass'; f.frequency.value = 4000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    n.connect(f); f.connect(g); g.connect(this._master);
    n.start(now); n.stop(now + 0.04);
  }

  playGrenadeBounce() {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const n = this._noise(0.04);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 800; f.Q.value = 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
    n.connect(f); f.connect(g); g.connect(this._master);
    n.start(now); n.stop(now + 0.05);
  }

  playExplosion() {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;

    const n = this._noise(0.8);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(2.0, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.8);
    n.connect(f); f.connect(g); g.connect(this._master);
    n.start(now); n.stop(now + 0.85);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(80, now);
    osc.frequency.exponentialRampToValueAtTime(20, now + 0.6);
    const og = ctx.createGain();
    og.gain.setValueAtTime(1.2, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
    osc.connect(og); og.connect(this._master);
    osc.start(now); osc.stop(now + 0.65);
  }

  playFootstep(speed) {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const vol = Math.min(speed / 5, 1) * 0.2;
    const n   = this._noise(0.03);
    const f   = ctx.createBiquadFilter();
    f.type = 'lowpass'; f.frequency.value = 300;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
    n.connect(f); f.connect(g); g.connect(this._master);
    n.start(now); n.stop(now + 0.04);
  }

  // Call in game loop with dt, horizontal speed
  tickFootsteps(dt, speed, onGround) {
    if (!onGround || speed < 0.5) { this._stepTimer = 0; return; }
    const interval = 0.4 - Math.min(speed / 10, 0.25); // faster = shorter interval
    this._stepTimer += dt;
    if (this._stepTimer >= interval) {
      this._stepTimer = 0;
      this.playFootstep(speed);
    }
  }

  playHit() {
    this._init();
    const ctx = this._ctx;
    const now = ctx.currentTime;
    const n = this._noise(0.06);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = 500; f.Q.value = 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    n.connect(f); f.connect(g); g.connect(this._master);
    n.start(now); n.stop(now + 0.07);
  }
}
