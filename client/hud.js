/**
 * Heads-up display drawn on the game canvas in screen space: hull/energy/XP
 * bars, upgrade panel, weapon choice, power-up timers, leaderboard, minimap,
 * kill feed, announcements, damage direction and off-screen indicators.
 * Clickable areas are recorded while drawing and resolved by hitTest().
 */
import { EntityType, MarkerKind, POWERUP_COUNT, POWERUP_SECONDS, TICK_RATE, WORLD_SIZE } from '../shared/constants.js';
import { gravityAt } from '../shared/gravity.js';
import { TAU, clamp, wrapDelta } from '../shared/math.js';
import { MAX_LEVEL, STAT_COUNT, STAT_INFO, STAT_MAX, WEAPONS, WEAPON_CHOICES, scoreForLevel } from '../shared/stats.js';
import { playerColor } from './renderer.js';

const FONT = 'ui-monospace, Menlo, Consolas, monospace';
const MARGIN = 16;
const POWERUP_UI = [
  { label: 'SHIELD', color: '#5cf2ff' },
  { label: 'RAPID', color: '#ff8c42' },
  { label: 'OVERDRIVE', color: '#ff5cf2' },
];
const WEAPON_KEYS = ['Z', 'X', 'C'];

function formatScore(n) {
  return n >= 100000 ? `${(n / 1000).toFixed(0)}k` : n.toLocaleString('en-US');
}

export class Hud {
  constructor() {
    this.killfeed = []; // { parts: [{text, color}], time }
    this.announcements = []; // { text, sub, color, time }
    this.damageMarks = []; // { angle, time }
    this.leaderboard = null;
    this.hitAreas = [];
    this.uiScale = 1;
    this.upgradePanelTop = 0;
    this.pull = { x: 0, y: 0 };
    this.gravity = null; // { name, ratio, color } while inside a gravity well
  }

  /* Feeds --------------------------------------------------------------------- */

  addKill(parts, now) {
    this.killfeed.push({ parts, time: now });
    if (this.killfeed.length > 5) this.killfeed.shift();
  }

  announce(text, sub, color, now) {
    this.announcements = this.announcements.filter((a) => a.text !== text);
    this.announcements.push({ text, sub, color, time: now });
    if (this.announcements.length > 3) this.announcements.shift();
  }

  addDamage(angle, now) {
    this.damageMarks.push({ angle, time: now });
    if (this.damageMarks.length > 8) this.damageMarks.shift();
  }

  /** Returns the action under a screen point: { type: 'upgrade', stat } | { type: 'weapon', weapon } | null. */
  hitTest(x, y) {
    for (const area of this.hitAreas) {
      if (x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h) return area.action;
    }
    return null;
  }

  addHitArea(x, y, w, h, action) {
    const s = this.uiScale;
    this.hitAreas.push({ x: x * s, y: y * s, w: w * s, h: h * s, action });
  }

  /* Drawing ------------------------------------------------------------------- */

  /**
   * `v` carries: ctx, width, height, dpr, now (ms), playing, self (hp, shield,
   * energy, flags), stats, st (derived stats), world, myPlayerId, camX, camY,
   * scale, ping, fps, serverTick, touchStick, shipScreen, debug.
   */
  draw(v) {
    const { ctx, dpr } = v;
    this.hitAreas.length = 0;
    this.uiScale = clamp(Math.min(v.width / 1280, v.height / 760), 0.62, 1.25);
    const s = this.uiScale;
    const W = v.width / s;
    const H = v.height / s;

    this.gravity = null;
    if (v.playing) {
      this.drawOffscreenMarkers(v);
      this.drawDamageMarks(v);
      this.drawGravity(v);
      this.drawVignette(v);
    }
    ctx.setTransform(dpr * s, 0, 0, dpr * s, 0, 0);
    ctx.textBaseline = 'alphabetic';

    if (v.playing && v.stats) {
      this.drawStatus(ctx, v, W, H);
      this.drawUpgrades(ctx, v, W, H);
      this.drawWeaponChoice(ctx, v, W, H);
      this.drawPowerups(ctx, v, W, H);
      this.drawGravityLabel(ctx, W, H);
    }
    this.drawLeaderboard(ctx, v, W);
    this.drawMinimap(ctx, v, W, H);
    this.drawKillfeed(ctx, v, W);
    this.drawAnnouncements(ctx, v, W, H);
    this.drawNetStats(ctx, v, H);
    if (v.debug) this.drawNetGraph(ctx, v);
    if (v.touchStick) this.drawStick(ctx, v);
  }

  drawStatus(ctx, v, W, H) {
    const { self, stats, st } = v;
    const barW = Math.min(440, W - 2 * MARGIN);
    const x = (W - barW) / 2;
    let y = H - MARGIN - 52;

    // Hull, with shield shown as an overlay segment
    const hpFrac = clamp(self.hp / st.maxHp, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, barW, 14);
    ctx.fillStyle = hpFrac > 0.5 ? '#7dff6a' : hpFrac > 0.25 ? '#ffd166' : '#ff4d4d';
    ctx.fillRect(x, y, barW * hpFrac, 14);
    if (self.shield > 0) {
      ctx.fillStyle = 'rgba(92,242,255,0.75)';
      ctx.fillRect(x, y, barW * clamp(self.shield / st.maxHp, 0, 1), 5);
    }
    ctx.font = `bold 11px ${FONT}`;
    ctx.fillStyle = '#000';
    ctx.textAlign = 'left';
    ctx.fillText(`HULL ${Math.ceil(self.hp)}/${st.maxHp}`, x + 6, y + 11);

    // Boost energy
    y += 18;
    const energyFrac = clamp(self.energy / st.energyMax, 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, barW, 6);
    ctx.fillStyle = self.boostLock ? '#556' : '#5cf2ff';
    ctx.fillRect(x, y, barW * energyFrac, 6);

    // Experience
    y += 12;
    const lo = scoreForLevel(stats.level);
    const hi = scoreForLevel(stats.level + 1);
    const xpFrac = stats.level >= MAX_LEVEL ? 1 : clamp((stats.score - lo) / Math.max(1, hi - lo), 0, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.fillRect(x, y, barW, 8);
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(x, y, barW * xpFrac, 8);
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(`LV ${stats.level}`, x, y + 22);
    ctx.textAlign = 'center';
    ctx.fillText(WEAPONS[stats.weapon].name.toUpperCase(), x + barW / 2, y + 22);
    ctx.textAlign = 'right';
    ctx.fillText(`${formatScore(stats.score)} pts`, x + barW, y + 22);

    // Score block, top left
    ctx.textAlign = 'left';
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(formatScore(stats.score), MARGIN, MARGIN + 24);
    ctx.font = `12px ${FONT}`;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    const rank = this.leaderboard?.rank ? `#${this.leaderboard.rank} of ${this.leaderboard.total}` : '';
    const alive = Math.max(0, Math.floor((v.serverTick - stats.spawnTick) / TICK_RATE));
    const time = `${Math.floor(alive / 60)}:${String(alive % 60).padStart(2, '0')}`;
    ctx.fillText(`RANK ${rank}   KILLS ${stats.kills}   TIME ${time}`, MARGIN, MARGIN + 44);
  }

  /**
   * Upgrade panel, bottom left. With points to spend it lists every stat
   * (clickable, keys 1-8); otherwise it collapses to a compact build summary
   * so it doesn't crowd the screen.
   */
  drawUpgrades(ctx, v, W, H) {
    const { stats } = v;
    const x = MARGIN;
    const w = 214;
    const stat = (i) => `hsl(${i * 45} 85% 62%)`;
    if (stats.points === 0) {
      const h = 50;
      const y = H - MARGIN - h;
      this.upgradePanelTop = y;
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      ctx.fillRect(x, y, w, h);
      ctx.font = `bold 10px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(255,255,255,0.45)';
      ctx.fillText('BUILD', x + 8, y + 14);
      for (let i = 0; i < STAT_COUNT; i++) {
        const level = stats.statLevels[i];
        for (let p = 0; p < STAT_MAX; p++) {
          ctx.fillStyle = p < level ? stat(i) : 'rgba(255,255,255,0.1)';
          ctx.fillRect(x + 8 + i * 25, y + 42 - p * 4, 19, 3);
        }
      }
      return;
    }
    const rowH = v.touch ? 26 : 19; // finger-sized rows on touch screens
    const h = 30 + STAT_COUNT * rowH;
    const y = H - MARGIN - h;
    this.upgradePanelTop = y;
    ctx.fillStyle = 'rgba(255,209,102,0.08)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255,209,102,0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.font = `bold 12px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#ffd166';
    ctx.fillText(`UPGRADES  +${stats.points}${v.touch ? '' : '  [1-8]'}`, x + 8, y + 19);
    for (let i = 0; i < STAT_COUNT; i++) {
      const ry = y + 28 + i * rowH;
      const level = stats.statLevels[i];
      const maxed = level >= STAT_MAX;
      ctx.font = `11px ${FONT}`;
      ctx.fillStyle = maxed ? 'rgba(255,255,255,0.45)' : '#fff';
      ctx.fillText(`${i + 1} ${STAT_INFO[i].name}`, x + 8, ry + rowH / 2 + 4);
      for (let p = 0; p < STAT_MAX; p++) {
        ctx.fillStyle = p < level ? stat(i) : 'rgba(255,255,255,0.12)';
        ctx.fillRect(x + 104 + p * 14, ry + rowH / 2 - 5, 11, 10);
      }
      if (!maxed) this.addHitArea(x, ry, w, rowH, { type: 'upgrade', stat: i });
    }
  }

  drawWeaponChoice(ctx, v, W, H) {
    if (!v.stats.weaponChoice) return;
    const cardW = 150;
    const cardH = 70;
    const gap = 12;
    const total = WEAPON_CHOICES.length * cardW + (WEAPON_CHOICES.length - 1) * gap;
    const x0 = (W - total) / 2;
    const y = H - MARGIN - 52 - 30 - cardH - 26;
    ctx.textAlign = 'center';
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillStyle = '#ffd166';
    ctx.fillText('CHOOSE YOUR WEAPON', W / 2, y - 10);
    WEAPON_CHOICES.forEach((weapon, i) => {
      const x = x0 + i * (cardW + gap);
      ctx.fillStyle = 'rgba(255,209,102,0.1)';
      ctx.fillRect(x, y, cardW, cardH);
      ctx.strokeStyle = '#ffd166';
      ctx.strokeRect(x + 0.5, y + 0.5, cardW - 1, cardH - 1);
      ctx.fillStyle = '#fff';
      ctx.font = `bold 14px ${FONT}`;
      ctx.fillText(`[${WEAPON_KEYS[i]}] ${WEAPONS[weapon].name}`, x + cardW / 2, y + 26);
      ctx.font = `10px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(WEAPONS[weapon].desc, x + cardW / 2, y + 48);
      this.addHitArea(x, y, cardW, cardH, { type: 'weapon', weapon: i });
    });
  }

  drawPowerups(ctx, v, W, H) {
    const { stats } = v;
    const elapsed = v.serverTick - stats.receivedTick;
    let x = (W - Math.min(440, W - 2 * MARGIN)) / 2;
    const y = H - MARGIN - 52 - 14;
    ctx.font = `bold 11px ${FONT}`;
    ctx.textAlign = 'left';
    for (let p = 0; p < POWERUP_COUNT; p++) {
      const ticks = stats.powerups[p] - elapsed;
      if (stats.powerups[p] === 0 || ticks <= 0) continue;
      const ui = POWERUP_UI[p];
      const frac = ticks / (POWERUP_SECONDS[p] * TICK_RATE);
      ctx.fillStyle = ui.color;
      ctx.fillText(`${ui.label} ${Math.ceil(ticks / TICK_RATE)}s`, x, y);
      ctx.fillRect(x, y + 3, 70 * clamp(frac, 0, 1), 2);
      x += 96;
    }
  }

  drawLeaderboard(ctx, v, W) {
    const lb = this.leaderboard;
    if (!lb) return;
    const w = 220;
    const x = W - MARGIN - w;
    let y = MARGIN;
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(x, y, w, 30 + lb.entries.length * 18);
    ctx.textAlign = 'left';
    ctx.font = `bold 12px ${FONT}`;
    ctx.fillStyle = '#ffd166';
    ctx.fillText('LEADERBOARD', x + 8, y + 19);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(`${lb.total} online`, x + w - 8, y + 19);
    y += 26;
    ctx.font = `12px ${FONT}`;
    lb.entries.forEach((entry, i) => {
      if (!v.world.roster.has(entry.playerId)) return; // left since this leaderboard was sent
      const mine = entry.playerId === v.myPlayerId;
      const name = v.world.playerName(entry.playerId).slice(0, 14);
      ctx.textAlign = 'left';
      ctx.fillStyle = mine ? '#fff' : playerColor(v.world.playerHue(entry.playerId));
      ctx.fillText(`${i + 1}. ${name}`, x + 8, y + 14);
      ctx.textAlign = 'right';
      ctx.fillStyle = mine ? '#fff' : 'rgba(255,255,255,0.75)';
      ctx.fillText(formatScore(entry.score), x + w - 8, y + 14);
      y += 18;
    });
  }

  drawMinimap(ctx, v, W, H) {
    const size = 150;
    const x = W - MARGIN - size;
    const y = H - MARGIN - size;
    const k = size / WORLD_SIZE;
    ctx.fillStyle = 'rgba(10,12,30,0.75)';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    for (const p of v.planets ?? []) {
      ctx.beginPath();
      ctx.arc(x + p.x * k, y + p.y * k, Math.max(2.5, p.radius * k), 0, TAU);
      ctx.fillStyle = 'rgba(170,185,255,0.55)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x + p.x * k, y + p.y * k, p.range * k, 0, TAU);
      ctx.strokeStyle = 'rgba(140,170,255,0.2)';
      ctx.stroke();
    }
    // Visible area, wrapped around the torus and clipped to the map
    const vw = (v.width / v.scale) * k;
    const vh = (v.height / v.scale) * k;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, size, size);
    ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let ox = -size; ox <= size; ox += size) {
      for (let oy = -size; oy <= size; oy += size) {
        ctx.strokeRect(x + ox + v.camX * k - vw / 2, y + oy + v.camY * k - vh / 2, vw, vh);
      }
    }
    ctx.restore();
    for (const m of this.leaderboard?.markers ?? []) {
      const mx = x + m.x * k;
      const my = y + m.y * k;
      if (m.kind === MarkerKind.MOTHERSHIP) {
        ctx.fillStyle = Math.floor(v.now / 300) % 2 ? '#ff5cf2' : '#ffd166';
        ctx.fillRect(mx - 4, my - 4, 8, 8);
      } else {
        ctx.fillStyle = '#ffd166';
        ctx.beginPath();
        ctx.moveTo(mx, my - 5);
        ctx.lineTo(mx + 4, my + 3);
        ctx.lineTo(mx - 4, my + 3);
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(x + v.camX * k - 2, y + v.camY * k - 2, 4, 4);
  }

  drawKillfeed(ctx, v, W) {
    const now = v.now;
    this.killfeed = this.killfeed.filter((k) => now - k.time < 7000);
    ctx.font = `12px ${FONT}`;
    let y = MARGIN + 14;
    for (const k of this.killfeed) {
      ctx.globalAlpha = clamp((7000 - (now - k.time)) / 800, 0, 1);
      let width = 0;
      for (const part of k.parts) width += ctx.measureText(part.text).width;
      let x = W / 2 - width / 2;
      ctx.textAlign = 'left';
      for (const part of k.parts) {
        ctx.fillStyle = part.color;
        ctx.fillText(part.text, x, y);
        x += ctx.measureText(part.text).width;
      }
      y += 17;
    }
    ctx.globalAlpha = 1;
  }

  drawAnnouncements(ctx, v, W, H) {
    const now = v.now;
    this.announcements = this.announcements.filter((a) => now - a.time < 3200);
    let y = H * 0.27;
    ctx.textAlign = 'center';
    for (const a of this.announcements) {
      const age = now - a.time;
      ctx.globalAlpha = clamp(Math.min(age / 150, (3200 - age) / 600), 0, 1);
      ctx.font = `bold 30px ${FONT}`;
      ctx.fillStyle = a.color;
      ctx.fillText(a.text, W / 2, y);
      if (a.sub) {
        ctx.font = `14px ${FONT}`;
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(a.sub, W / 2, y + 22);
      }
      y += 56;
    }
    ctx.globalAlpha = 1;
  }

  drawNetStats(ctx, v, H) {
    ctx.font = `10px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    const y = v.playing && v.stats ? this.upgradePanelTop - 8 : H - MARGIN;
    ctx.fillText(`${Math.round(v.ping)} ms  ${Math.round(v.fps)} fps`, MARGIN, y);
  }

  /**
   * Inside a gravity well: a chevron beside the ship pointing at the pull,
   * sized by its strength relative to our thrust (red means boost to escape).
   */
  drawGravity(v) {
    if (!v.planets || v.planets.length === 0) return;
    const planet = gravityAt(v.shipX, v.shipY, v.planets, this.pull);
    if (!planet) return;
    const ratio = Math.hypot(this.pull.x, this.pull.y) / v.st.thrust;
    const color = ratio < 0.5 ? '#7dff6a' : ratio < 0.85 ? '#ffd166' : '#ff4d4d';
    this.gravity = { name: planet.name, ratio, color };
    const { ctx, dpr } = v;
    const angle = Math.atan2(this.pull.y, this.pull.x);
    const size = 5 + Math.min(ratio, 1.2) * 9;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.save();
    ctx.translate(v.shipScreen.x + Math.cos(angle) * 54, v.shipScreen.y + Math.sin(angle) * 54);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.6, -size * 0.8);
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.6, size * 0.8);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();
  }

  drawGravityLabel(ctx, W, H) {
    const g = this.gravity;
    if (!g) return;
    const barW = Math.min(440, W - 2 * MARGIN);
    ctx.font = `bold 11px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillStyle = g.color;
    ctx.fillText(`${g.name.toUpperCase()} GRAVITY  ${Math.round(g.ratio * 100)}% OF THRUST`, (W + barW) / 2, H - MARGIN - 52 - 14);
  }

  /** Netcode diagnostics (toggle with F3). */
  drawNetGraph(ctx, v) {
    const d = v.debug;
    const tickMs = 1000 / TICK_RATE;
    const lines = [
      `ping ${d.rtt.toFixed(0)} ms   jitter ${(d.jitter * tickMs).toFixed(0)} ms   interp ${(d.delay * tickMs).toFixed(0)} ms`,
      `in ${d.kbps.toFixed(1)} KiB/s   ${d.snapshotsPerSecond} snapshots/s   ${d.entities} entities`,
      `prediction: ${d.pending} pending, ${d.corrections} corrections (last ${d.lastCorrection.toFixed(1)}u)`,
      `projectiles: ${d.ghostsConfirmed} confirmed, ${d.ghostsExpired} unconfirmed   extrapolated ${d.extrapolations}`,
    ];
    ctx.font = `11px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(MARGIN, 64, 470, lines.length * 15 + 10);
    ctx.fillStyle = '#7dff6a';
    lines.forEach((line, i) => ctx.fillText(line, MARGIN + 6, 80 + i * 15));
  }

  /** Edge arrows towards known ships and aliens that are just off screen (screen space, unscaled). */
  drawOffscreenMarkers(v) {
    const { ctx, dpr, width, height, scale, world } = v;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 26;
    for (const e of world.entities.values()) {
      if (e.type !== EntityType.SHIP && e.type !== EntityType.ALIEN) continue;
      const dx = wrapDelta(e.rx - v.camX, WORLD_SIZE) * scale;
      const dy = wrapDelta(e.ry - v.camY, WORLD_SIZE) * scale;
      if (Math.abs(dx) < width / 2 && Math.abs(dy) < height / 2) continue;
      const a = Math.atan2(dy, dx);
      const k = Math.min((width / 2 - pad) / Math.abs(Math.cos(a) || 1e-6), (height / 2 - pad) / Math.abs(Math.sin(a) || 1e-6));
      const x = width / 2 + Math.cos(a) * k;
      const y = height / 2 + Math.sin(a) * k;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.lineTo(-6, -6);
      ctx.lineTo(-6, 6);
      ctx.closePath();
      ctx.fillStyle = e.type === EntityType.ALIEN ? '#7dff6a' : playerColor(world.playerHue(e.playerId));
      ctx.globalAlpha = 0.75;
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /** Red arcs around the ship pointing towards recent damage. */
  drawDamageMarks(v) {
    const { ctx, dpr } = v;
    const now = v.now;
    this.damageMarks = this.damageMarks.filter((m) => now - m.time < 900);
    if (this.damageMarks.length === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = v.shipScreen.x;
    const cy = v.shipScreen.y;
    const radius = 70;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    for (const m of this.damageMarks) {
      ctx.globalAlpha = 1 - (now - m.time) / 900;
      ctx.strokeStyle = '#ff4d4d';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, m.angle - 0.35, m.angle + 0.35);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  drawVignette(v) {
    const { ctx, dpr, width, height, self, st } = v;
    if (!self || !st) return;
    const frac = self.hp / st.maxHp;
    if (frac > 0.3) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pulse = 0.5 + 0.5 * Math.sin(v.now / 160);
    const g = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.35, width / 2, height / 2, Math.max(width, height) * 0.7);
    g.addColorStop(0, 'rgba(255,0,0,0)');
    g.addColorStop(1, `rgba(255,30,30,${(0.18 + 0.17 * pulse) * (1 - frac / 0.3)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }

  drawStick(ctx, v) {
    const { dpr } = v;
    const st = v.touchStick;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(st.ox, st.oy, 60, 0, TAU);
    ctx.stroke();
    const len = Math.hypot(st.x - st.ox, st.y - st.oy);
    const k = len > 60 ? 60 / len : 1;
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.arc(st.ox + (st.x - st.ox) * k, st.oy + (st.y - st.oy) * k, 24, 0, TAU);
    ctx.fill();
  }
}
