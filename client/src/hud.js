// Injects all HUD HTML/CSS and exposes update methods
export class HUD {
  constructor() {
    this._root   = document.getElementById('hud');
    this._localId = null;
    this._scores  = {};
    this._killFeed = [];
    this._killFeedTimer = 0;
    this._hitMarkerTimer = 0;
    this._dmgTimer = 0;
    this._killConfirmTimer = 0;
    this._notifTimer = 0;
    this._scoreVisible = false;
    this._lastHealth = null;
    this._lastArmor = null;
    this._lastBloomGap = null;
    this._lastReloadProgress = null;

    this._build();
  }

  _build() {
    this._root.innerHTML = `
<style>
  #hud * { box-sizing: border-box; }

  /* ── menu overlay ── */
  #fz-menu {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.88);
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    z-index: 100; pointer-events: all;
    color: #e8d8b0;
  }
  #fz-menu h1 {
    font-size: 64px; letter-spacing: 8px;
    text-transform: uppercase;
    color: #ff8c00;
    text-shadow: 0 0 8px #ff8c0066;
    margin-bottom: 8px;
  }
  #fz-menu .subtitle { font-size: 13px; letter-spacing: 4px; color: #c0b69f; margin-bottom: 40px; }
  #fz-menu input {
    background: #111; border: 1px solid #555;
    color: #e8d8b0; padding: 10px 18px;
    font-family: inherit; font-size: 16px;
    text-align: center; width: 260px; outline: none;
    letter-spacing: 2px;
    margin-bottom: 16px;
  }
  #fz-menu input::placeholder { color: #9f9682; opacity: 1; }
  #fz-menu input:focus { border-color: #ff8c00; }
  #fz-menu button {
    background: #ff8c00; border: none; color: #000;
    padding: 12px 40px; font-size: 15px; font-family: inherit;
    letter-spacing: 3px; text-transform: uppercase;
    cursor: pointer; font-weight: bold;
    transition: background 0.15s;
  }
  #fz-menu button:hover { background: #ffa733; }
  #fz-menu button:focus-visible,
  #fz-menu input:focus-visible,
  #fz-pause button:focus-visible,
  #fz-pause input:focus-visible,
  #fz-pause select:focus-visible {
    outline: 2px solid #ffd08a;
    outline-offset: 3px;
  }
  #fz-menu .controls {
    margin-top: 32px; font-size: 11px; color: #989080;
    text-align: center; line-height: 1.9;
    letter-spacing: 1px;
  }

  /* ── pause (escape) menu ── */
  #fz-pause {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    display: none; align-items: center; justify-content: center;
    z-index: 95; pointer-events: all; /* above death screen (90), below main menu (100) */
  }
  #fz-pause .panel {
    background: rgba(0,0,0,0.88);
    border: 1px solid #444;
    padding: 28px 36px; width: min(360px, calc(100vw - 32px));
    color: #e8d8b0; text-align: center;
  }
  #fz-pause h3 {
    letter-spacing: 6px; font-size: 18px;
    color: #ff8c00; text-transform: uppercase;
    margin-bottom: 24px;
  }
  #fz-pause label {
    display: block; font-size: 11px; letter-spacing: 2px;
    color: #aaa18d; margin-bottom: 8px; text-transform: uppercase;
  }
  #fz-pause label span { color: #e8d8b0; }
  #fz-pause input[type=range] {
    -webkit-appearance: none; appearance: none;
    width: 100%; height: 3px; background: #333;
    outline: none; margin-bottom: 24px; cursor: pointer;
  }
  #fz-pause input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none;
    width: 14px; height: 14px; background: #ff8c00;
    cursor: pointer;
  }
  #fz-pause input[type=range]::-moz-range-thumb {
    width: 14px; height: 14px; background: #ff8c00;
    border: none; border-radius: 0; cursor: pointer;
  }
  #fz-pause .setting { margin-bottom: 22px; }
  #fz-pause select {
    width: 100%; background: #151515; border: 1px solid #555;
    color: #e8d8b0; padding: 9px 10px;
    font-family: inherit; font-size: 13px; cursor: pointer;
  }
  #fz-quality-hint {
    margin-top: 7px; min-height: 14px;
    color: #aaa18d; font-size: 10px; letter-spacing: 0.5px;
  }
  #fz-pause button {
    background: #ff8c00; border: none; color: #000;
    padding: 10px 32px; font-size: 13px; font-family: inherit;
    letter-spacing: 3px; text-transform: uppercase;
    cursor: pointer; font-weight: bold;
    transition: background 0.15s;
  }
  #fz-pause button:hover { background: #ffa733; }

  /* ── crosshair ── */
  #fz-xhair {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    pointer-events: none; z-index: 20;
  }
  .fz-xh-line {
    position: absolute; background: rgba(255,255,255,0.92);
    box-shadow: 0 0 2px #000a;
  }
  #xh-t { width: 1px; height: 8px; top: 0; left: 0; transform: translate(-50%, calc(-100% - var(--gap))); }
  #xh-b { width: 1px; height: 8px; top: 0; left: 0; transform: translate(-50%, calc(0% + var(--gap)));  }
  #xh-l { height:1px; width: 8px;  top: 0; left: 0; transform: translate(calc(-100% - var(--gap)), -50%); }
  #xh-r { height:1px; width: 8px;  top: 0; left: 0; transform: translate(calc(0% + var(--gap)), -50%); }
  #fz-xhair { --gap: 3px; }

  /* ── hit marker ── */
  #fz-hit {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    color: #ff4444; font-size: 18px;
    pointer-events: none; z-index: 21;
    opacity: 0; transition: opacity 0.05s;
  }

  /* ── kill confirm ── */
  #fz-kconfirm {
    position: fixed; top: calc(50% - 40px); left: 50%;
    transform: translate(-50%, -50%);
    color: #ff8c00; font-size: 11px; letter-spacing: 2px;
    pointer-events: none; z-index: 21;
    opacity: 0; transition: opacity 0.1s;
    text-transform: uppercase;
  }

  /* ── damage flash ── */
  /* Static atmosphere: one cached overlay, no blur or post-processing pass. */
  #fz-vignette {
    position: fixed; inset: 0;
    background: radial-gradient(ellipse at center, transparent 58%, rgba(4,7,9,0.3) 100%);
    pointer-events: none; z-index: 14;
    opacity: 0.52;
  }
  body.fz-performance #fz-vignette { display: none; }

  #fz-dmgflash {
    position: fixed; inset: 0;
    background: radial-gradient(circle at center, transparent 30%, rgba(185,18,18,0.78) 100%);
    pointer-events: none; z-index: 15;
    opacity: 0;
  }

  /* ── death screen ── */
  #fz-dead {
    position: fixed; inset: 0;
    background: rgba(150,0,0,0.5);
    display: none; align-items: center; justify-content: center;
    flex-direction: column; z-index: 90; pointer-events: none;
    color: #fff;
  }
  #fz-dead h2 { font-size: 48px; letter-spacing: 6px; color: #ff3333; margin-bottom: 12px; }
  #fz-dead p  { font-size: 14px; letter-spacing: 2px; color: #aaa; }

  /* ── bottom left: health / armor ── */
  #fz-health {
    position: fixed; bottom: 24px; left: 24px;
    pointer-events: none; z-index: 20;
    color: #f0dfb7; line-height: 1.55;
    text-shadow: 0 1px 2px #000;
  }
  #fz-health .hp  { font-size: 30px; letter-spacing: 2px; }
  #fz-health .hp span { color: #ff4444; }
  #fz-health .armor { font-size: 13px; letter-spacing: 1px; color: #88aaff; }

  /* ── bottom right: ammo / weapon ── */
  #fz-ammo {
    position: fixed; bottom: 24px; right: 24px;
    pointer-events: none; z-index: 20;
    color: #f0dfb7; text-align: right; line-height: 1.55;
    text-shadow: 0 1px 2px #000;
  }
  #fz-ammo .weapon-name { font-size: 11px; letter-spacing: 3px; color: #b0a792; text-transform: uppercase; }
  #fz-ammo .ammo-cur    { font-size: 34px; letter-spacing: 2px; }
  #fz-ammo .ammo-res    { font-size: 14px; color: #b0a792; margin-left: 4px; }
  #fz-ammo .gren        { font-size: 13px; color: #88ff88; }

  /* ── kill feed ── */
  #fz-killfeed {
    position: fixed; top: 20px; right: 20px;
    width: 320px; pointer-events: none; z-index: 20;
  }
  .fz-kf-entry {
    background: rgba(0,0,0,0.7);
    border: 1px solid rgba(255,140,0,0.28);
    color: #f0dfb7; font-size: 12px;
    padding: 4px 10px; margin-bottom: 3px;
    letter-spacing: 1px;
    animation: fzkfSlide 0.15s ease-out;
  }
  .fz-kf-entry.self-kill { border-color: rgba(255,51,51,0.5); }
  @keyframes fzkfSlide { from { opacity:0; transform:translateX(20px); } to { opacity:1; transform:none; } }
  .fz-kf-icon { color: #ff8c00; margin: 0 6px; }

  /* ── scoreboard ── */
  #fz-score {
    position: fixed; top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0,0,0,0.88);
    border: 1px solid #444;
    padding: 24px 32px; min-width: 440px;
    display: none; z-index: 80; pointer-events: none;
    color: #e8d8b0;
  }
  #fz-score h3 {
    text-align: center; letter-spacing: 6px;
    font-size: 16px; margin-bottom: 16px;
    color: #ff8c00; text-transform: uppercase;
  }
  .fz-score-row {
    display: flex; justify-content: space-between;
    font-size: 13px; padding: 5px 0;
    border-bottom: 1px solid #222; letter-spacing: 1px;
  }
  .fz-score-row.header { color: #888; font-size: 11px; border-bottom: 1px solid #444; margin-bottom: 4px; }
  .fz-score-row.me { color: #ff8c00; }
  .fz-score-col-name { flex: 1; }
  .fz-score-col-k, .fz-score-col-d { width: 50px; text-align: center; }
  .fz-score-col-kd { width: 60px; text-align: right; }

  /* ── notification ── */
  #fz-notif {
    position: fixed; top: 20px; left: 50%;
    transform: translateX(-50%);
    color: #d1c6aa; font-size: 11px; letter-spacing: 2px;
    pointer-events: none; z-index: 20;
    opacity: 0; transition: opacity 0.2s;
  }

  /* ── round timer / game info top center ── */
  #fz-info {
    position: fixed; top: 20px; left: 50%;
    transform: translateX(-50%);
    color: #e8d8b0; font-size: 22px; letter-spacing: 4px;
    pointer-events: none; z-index: 20;
    text-shadow: 0 1px 4px #000;
  }

  /* ── reload bar ── */
  #fz-reloadbar {
    position: fixed; bottom: 122px; right: 24px;
    width: 120px; height: 3px;
    background: #333;
    pointer-events: none; z-index: 20;
    display: none;
  }
  #fz-reloadbar-fill {
    height: 100%; background: #ff8c00;
    width: 100%; transform: scaleX(0); transform-origin: left center;
  }

  @media (prefers-reduced-motion: reduce) {
    .fz-kf-entry { animation: none; }
    #fz-menu button, #fz-pause button, #fz-hit, #fz-kconfirm, #fz-notif {
      transition: none;
    }
  }

  @media (max-width: 560px) {
    #fz-menu h1 { font-size: 46px; letter-spacing: 5px; }
    #fz-menu .controls { max-width: calc(100vw - 32px); }
    #fz-score { min-width: 0; width: calc(100vw - 32px); padding: 20px; }
  }

  /* hide cursor when locked */
  body.locked { cursor: none; }
</style>

<!-- Menu -->
<div id="fz-menu">
  <h1>FRAGZONE</h1>
  <div class="subtitle">online · free-for-all · no mercy</div>
  <input id="fz-name" type="text" maxlength="16" placeholder="Enter callsign..." spellcheck="false" autocomplete="off" />
  <button id="fz-play">ENTER FRAG</button>
  <div class="controls">
    WASD · move &nbsp;|&nbsp; MOUSE · aim &nbsp;|&nbsp; LMB · shoot<br>
    SHIFT · walk &nbsp;|&nbsp; SPACE · jump &nbsp;|&nbsp; ALT/C · crouch<br>
    G · grenade &nbsp;|&nbsp; R · reload &nbsp;|&nbsp; 1/2 · switch weapon<br>
    TAB · scoreboard &nbsp;|&nbsp; ESC · settings
  </div>
</div>

<!-- Pause (escape) menu -->
<div id="fz-pause">
  <div class="panel">
    <h3>Paused</h3>
    <label>Mouse Sensitivity <span id="fz-sens-val">1.00</span></label>
    <input id="fz-sens" type="range" min="0.1" max="3" step="0.05" value="1" />
    <div class="setting">
      <label for="fz-quality">Graphics</label>
      <select id="fz-quality">
        <option value="balanced">Balanced</option>
        <option value="performance">Performance</option>
      </select>
      <div id="fz-quality-hint"></div>
    </div>
    <button id="fz-resume">Resume</button>
  </div>
</div>

<!-- Crosshair -->
<div id="fz-xhair" style="display:none">
  <div class="fz-xh-line" id="xh-t"></div>
  <div class="fz-xh-line" id="xh-b"></div>
  <div class="fz-xh-line" id="xh-l"></div>
  <div class="fz-xh-line" id="xh-r"></div>
</div>

<!-- Hit marker (X) -->
<div id="fz-hit">✕</div>

<!-- Kill confirm -->
<div id="fz-kconfirm">kill</div>

<!-- Static low-cost atmosphere -->
<div id="fz-vignette"></div>

<!-- Damage vignette -->
<div id="fz-dmgflash"></div>

<!-- Death screen -->
<div id="fz-dead">
  <h2>YOU DIED</h2>
  <p id="fz-dead-msg">RESPAWNING IN 3...</p>
</div>

<!-- Health / armor -->
<div id="fz-health" style="display:none">
  <div class="hp"><span id="fz-hp">100</span> HP</div>
  <div class="armor">ARMOR <span id="fz-ar">100</span></div>
</div>

<!-- Ammo -->
<div id="fz-ammo" style="display:none">
  <div class="weapon-name" id="fz-wname">AK-47</div>
  <div>
    <span class="ammo-cur" id="fz-ammo-cur">30</span>
    <span class="ammo-res" id="fz-ammo-res">/ 90</span>
  </div>
  <div class="gren" id="fz-gren">⊕ 1 GRENADE</div>
</div>

<!-- Kill feed -->
<div id="fz-killfeed"></div>

<!-- Scoreboard -->
<div id="fz-score">
  <h3>FRAGZONE · SCOREBOARD</h3>
  <div class="fz-score-row header">
    <span class="fz-score-col-name">PLAYER</span>
    <span class="fz-score-col-k">K</span>
    <span class="fz-score-col-d">D</span>
    <span class="fz-score-col-kd">K/D</span>
  </div>
  <div id="fz-score-rows"></div>
</div>

<!-- Notification -->
<div id="fz-notif"></div>

<!-- Game info (top center) -->
<div id="fz-info" style="display:none"></div>

<!-- Reload bar -->
<div id="fz-reloadbar"><div id="fz-reloadbar-fill"></div></div>
    `;

    // Cache refs
    this._el = {
      menu:       document.getElementById('fz-menu'),
      pause:      document.getElementById('fz-pause'),
      sens:       document.getElementById('fz-sens'),
      sensVal:    document.getElementById('fz-sens-val'),
      quality:    document.getElementById('fz-quality'),
      qualityHint: document.getElementById('fz-quality-hint'),
      resumeBtn:  document.getElementById('fz-resume'),
      xhair:      document.getElementById('fz-xhair'),
      hit:        document.getElementById('fz-hit'),
      kconfirm:   document.getElementById('fz-kconfirm'),
      dmg:        document.getElementById('fz-dmgflash'),
      dead:       document.getElementById('fz-dead'),
      deadMsg:    document.getElementById('fz-dead-msg'),
      health:     document.getElementById('fz-health'),
      ammo:       document.getElementById('fz-ammo'),
      hp:         document.getElementById('fz-hp'),
      ar:         document.getElementById('fz-ar'),
      wname:      document.getElementById('fz-wname'),
      ammoCur:    document.getElementById('fz-ammo-cur'),
      ammoRes:    document.getElementById('fz-ammo-res'),
      gren:       document.getElementById('fz-gren'),
      killfeed:   document.getElementById('fz-killfeed'),
      scoreBox:   document.getElementById('fz-score'),
      scoreRows:  document.getElementById('fz-score-rows'),
      notif:      document.getElementById('fz-notif'),
      info:       document.getElementById('fz-info'),
      reloadBar:  document.getElementById('fz-reloadbar'),
      reloadFill: document.getElementById('fz-reloadbar-fill'),
      nameInput:  document.getElementById('fz-name'),
      playBtn:    document.getElementById('fz-play'),
    };
  }

  // Called when game starts; returns the entered name
  onPlay(callback) {
    const go = () => {
      const name = this._el.nameInput.value.trim() || 'Anon';
      callback(name);
    };
    this._el.playBtn.addEventListener('click', go);
    this._el.nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    // focus name input
    setTimeout(() => this._el.nameInput.focus(), 100);
  }

  showGameHud(show) {
    this._el.menu.style.display = show ? 'none' : 'flex';
    this._el.xhair.style.display = show ? '' : 'none';
    this._el.health.style.display = show ? '' : 'none';
    this._el.ammo.style.display = show ? '' : 'none';
  }

  setMenuStatus(text, busy = false) {
    this._el.playBtn.disabled = busy;
    this._el.playBtn.textContent = busy ? 'CONNECTING...' : 'ENTER FRAG';
    this._el.nameInput.disabled = busy;
    this._el.info.style.display = text ? '' : 'none';
    this._el.info.textContent = text || '';
  }

  setLocalId(id) { this._localId = id; }

  showPauseMenu(show) {
    this._el.pause.style.display = show ? 'flex' : 'none';
  }

  // Sensitivity slider: callback fires with the numeric value on every change.
  onSensitivity(callback) {
    this._el.sens.addEventListener('input', () => {
      const v = parseFloat(this._el.sens.value);
      this._el.sensVal.textContent = v.toFixed(2);
      callback(v);
    });
  }

  setSensitivity(v) {
    this._el.sens.value = v;
    this._el.sensVal.textContent = v.toFixed(2);
  }

  onQuality(callback) {
    this._el.quality.addEventListener('change', () => {
      callback(this._el.quality.value);
    });
  }

  setQuality(mode) {
    const value = mode === 'performance' ? 'performance' : 'balanced';
    this._el.quality.value = value;
    this._el.qualityHint.textContent = value === 'performance'
      ? 'Lowest GPU load · shadows and vignette off'
      : 'Sharper image · lightweight shadows and vignette';
  }

  onResume(callback) {
    this._el.resumeBtn.addEventListener('click', callback);
  }

  // ── per-frame update ──
  update(dt) {
    // hit marker fade
    if (this._hitMarkerTimer > 0) {
      this._hitMarkerTimer -= dt;
      this._el.hit.style.opacity = Math.max(0, this._hitMarkerTimer / 0.15);
    }
    // kill confirm fade
    if (this._killConfirmTimer > 0) {
      this._killConfirmTimer -= dt;
      this._el.kconfirm.style.opacity = Math.max(0, this._killConfirmTimer / 0.3);
    }
    // damage flash
    if (this._dmgTimer > 0) {
      this._dmgTimer -= dt;
      this._el.dmg.style.opacity = Math.max(0, this._dmgTimer / 0.3);
      if (this._dmgTimer <= 0) this._el.dmg.style.opacity = 0;
    }
    // notif fade
    if (this._notifTimer > 0) {
      this._notifTimer -= dt;
      this._el.notif.style.opacity = Math.min(1, this._notifTimer > 1.5 ? 1 : this._notifTimer / 0.5);
      if (this._notifTimer <= 0) this._el.notif.style.opacity = 0;
    }
    // kill feed expiry
    this._killFeedTimer -= dt;
    if (this._killFeedTimer <= 0 && this._killFeed.length > 0) {
      this._killFeed.shift();
      this._killFeedTimer = 3;
      this._renderKillFeed();
    }
  }

  setBloom(px) {
    const gap = Math.round(Math.max(2, px) * 4) / 4;
    if (gap === this._lastBloomGap) return;
    this._lastBloomGap = gap;
    this._el.xhair.style.setProperty('--gap', `${gap}px`);
  }

  updateHealth(hp, armor) {
    const nextHp = Math.max(0, Math.round(hp));
    const nextArmor = Math.max(0, Math.round(armor));
    if (nextHp === this._lastHealth && nextArmor === this._lastArmor) return;
    this._lastHealth = nextHp;
    this._lastArmor = nextArmor;
    this._el.hp.textContent = nextHp;
    this._el.ar.textContent = nextArmor;
    const r = Math.max(0, 255 - nextHp * 1.5);
    const g = Math.min(255, nextHp * 2.55);
    this._el.hp.style.color = `rgb(${r},${g},60)`;
  }

  updateAmmo(weaponName, cur, reserve, grenades) {
    const names = { ak: 'AK-47', pistol: 'USP-S', grenade: 'FRAG GRENADE' };
    this._el.wname.textContent = names[weaponName] || weaponName.toUpperCase();
    if (weaponName === 'grenade') {
      this._el.ammoCur.textContent = grenades;
      this._el.ammoRes.textContent = '';
    } else {
      this._el.ammoCur.textContent = cur;
      this._el.ammoRes.textContent = `/ ${reserve}`;
      const low = cur <= 5;
      this._el.ammoCur.style.color = low ? '#ff3333' : '#e8d8b0';
    }
    this._el.gren.style.display = grenades > 0 ? '' : 'none';
    this._el.gren.textContent   = grenades > 0 ? `⊕ ${grenades} GRENADE${grenades > 1 ? 'S' : ''}` : '';
  }

  showHitMarker() {
    this._hitMarkerTimer = 0.15;
    this._el.hit.style.opacity = 1;
  }

  showKillConfirm() {
    this._killConfirmTimer = 0.4;
    this._el.kconfirm.style.opacity = 1;
  }

  showDamage() {
    this._dmgTimer = 0.3;
    this._el.dmg.style.opacity = 1;
  }

  showDeathScreen(respawnSec) {
    this._el.dead.style.display = 'flex';
    this._el.deadMsg.textContent = `RESPAWNING IN ${Math.ceil(respawnSec)}…`;
  }

  updateDeathCountdown(sec) {
    this._el.deadMsg.textContent = `RESPAWNING IN ${Math.ceil(sec)}…`;
  }

  hideDeathScreen() {
    this._el.dead.style.display = 'none';
  }

  addKillFeedEntry(killerName, victimName, weapon, isMine) {
    const icons = { ak: '⚡', pistol: '✦', grenade: '💥' };
    const el    = document.createElement('div');
    el.className = `fz-kf-entry${isMine ? ' self-kill' : ''}`;
    // Build with textContent — names come from the network and must never be
    // parsed as HTML (server sanitization is a second line of defense, not the
    // contract).
    const killer = document.createElement('b');
    killer.textContent = killerName;
    const icon = document.createElement('span');
    icon.className   = 'fz-kf-icon';
    icon.textContent = icons[weapon] || '⚡';
    el.append(killer, icon, victimName);
    this._killFeed.push(el);
    this._killFeedTimer = 5;
    this._renderKillFeed();
  }

  _renderKillFeed() {
    this._el.killfeed.textContent = '';
    this._killFeed.slice(-5).forEach(el => this._el.killfeed.appendChild(el));
  }

  updateScoreboard(scores) {
    this._scores = scores;
    // Re-render live if the player is holding Tab — otherwise the board shows
    // the scores from the moment it was opened.
    if (this._scoreVisible) this._renderScoreRows();
  }

  showScoreboard(show) {
    this._scoreVisible = show;
    this._el.scoreBox.style.display = show ? 'block' : 'none';
    if (show) this._renderScoreRows();
  }

  _renderScoreRows() {
    const rows = Object.entries(this._scores)
      .sort(([, a], [, b]) => b.kills - a.kills);
    this._el.scoreRows.textContent = '';
    for (const [id, s] of rows) {
      const me  = id === this._localId;
      const kd  = s.deaths === 0 ? s.kills.toFixed(0) : (s.kills / s.deaths).toFixed(2);
      const row = document.createElement('div');
      row.className = `fz-score-row${me ? ' me' : ''}`;
      const cell = (cls, text) => {
        const span = document.createElement('span');
        span.className   = cls;
        span.textContent = text;
        row.appendChild(span);
      };
      cell('fz-score-col-name', s.name + (me ? ' ★' : ''));
      cell('fz-score-col-k',  s.kills);
      cell('fz-score-col-d',  s.deaths);
      cell('fz-score-col-kd', kd);
      this._el.scoreRows.appendChild(row);
    }
  }

  showNotification(text) {
    this._el.notif.textContent = text;
    this._notifTimer = 3;
    this._el.notif.style.opacity = 1;
  }

  showReload(progress) { // 0..1
    if (progress >= 1) {
      if (this._lastReloadProgress !== 1) this._el.reloadBar.style.display = 'none';
      this._lastReloadProgress = 1;
    } else {
      const nextProgress = Math.round(Math.max(0, progress) * 200) / 200;
      if (this._lastReloadProgress === 1 || this._lastReloadProgress === null) {
        this._el.reloadBar.style.display = 'block';
      }
      if (nextProgress !== this._lastReloadProgress) {
        this._el.reloadFill.style.transform = `scaleX(${nextProgress})`;
      }
      this._lastReloadProgress = nextProgress;
    }
  }

  setInfo(text) {
    this._el.info.style.display = text ? '' : 'none';
    this._el.info.textContent   = text;
  }
}
