/**
 * Canvas renderer for the world: parallax starfield, vector-style entities,
 * particles. Everything is drawn relative to the camera with wrap-aware
 * offsets, so the torus world needs no special casing. Same-coloured shapes
 * are batched into one path where possible to keep draw calls low.
 */
import {
  ALIEN_RADIUS,
  AlienKind,
  BulletKind,
  EntityType,
  PickupKind,
  SHIP_RADIUS,
  ShipFlag,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  WORLD_SIZE,
} from '../shared/constants.js';
import { TAU, createRng, wrapDelta } from '../shared/math.js';
import { Weapon } from '../shared/stats.js';

const FONT = 'ui-monospace, Menlo, Consolas, monospace';
const STAR_TILE = 512;
const STAR_LAYERS = [
  { parallax: 0.25, count: 70, size: 1, alpha: 0.35 },
  { parallax: 0.5, count: 45, size: 1.4, alpha: 0.55 },
  { parallax: 0.75, count: 25, size: 1.8, alpha: 0.8 },
];
const BULLET_COLORS = ['#ffffff', '#ffd166', '#7dff6a', '#ff5cf2']; // by BulletKind for others' shots
const POWERUP_STYLE = {
  [PickupKind.SHIELD]: { color: '#5cf2ff', label: 'S' },
  [PickupKind.RAPID]: { color: '#ff8c42', label: 'R' },
  [PickupKind.REPAIR]: { color: '#7dff6a', label: '+' },
  [PickupKind.OVERDRIVE]: { color: '#ff5cf2', label: 'O' },
};
const ORB_SIZE = [3, 4.5, 6];

export function playerColor(hue, lightness = 65) {
  return `hsl(${hue} 90% ${lightness}%)`;
}

function makeStarTile(layer, seed) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = STAR_TILE;
  const ctx = canvas.getContext('2d');
  const rng = createRng(seed);
  ctx.fillStyle = '#fff';
  for (let i = 0; i < layer.count; i++) {
    ctx.globalAlpha = layer.alpha * (0.5 + rng() * 0.5);
    const s = layer.size * (0.6 + rng() * 0.8);
    ctx.fillRect(rng() * STAR_TILE, rng() * STAR_TILE, s, s);
  }
  return canvas;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.width = 0; // CSS pixels
    this.height = 0;
    this.dpr = 1;
    this.scale = 1; // CSS pixels per world unit
    this.starTiles = STAR_LAYERS.map((layer, i) => makeStarTile(layer, 1234 + i * 99));
    this.batch = { mine: [], kinds: [[], [], [], []] };
    this.lists = { asteroids: [], ships: [], aliens: [], pickups: [] };
    this.halfW = 0;
    this.halfH = 0;
    this.camX = 0;
    this.camY = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = innerWidth;
    this.height = innerHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  /** Fits the fixed world view to the screen; a larger viewScale shows more of the world. */
  setViewScale(viewScale) {
    this.scale = Math.max(this.width / (VIEW_WIDTH * viewScale), this.height / (VIEW_HEIGHT * viewScale));
  }

  /** Converts a world position to CSS pixels on screen for the given camera. */
  toScreen(x, y, camX, camY, out) {
    out.x = this.width / 2 + wrapDelta(x - camX, WORLD_SIZE) * this.scale;
    out.y = this.height / 2 + wrapDelta(y - camY, WORLD_SIZE) * this.scale;
    return out;
  }

  /**
   * Draws a frame. `view` carries: camX, camY, shakeX, shakeY, world, self
   * (own ship render state or null), effects, time (seconds), presentTick.
   */
  draw(view) {
    const { ctx, dpr, scale } = this;
    const camX = view.camX + view.shakeX;
    const camY = view.camY + view.shakeY;
    const halfW = this.width / 2 / scale + 80;
    const halfH = this.height / 2 / scale + 80;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.width, this.height);
    this.drawStars(camX, camY);

    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, (this.width / 2) * dpr, (this.height / 2) * dpr);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    this.drawGrid(camX, camY, halfW, halfH);

    const world = view.world;
    const { asteroids, ships, aliens, pickups } = this.lists;
    asteroids.length = ships.length = aliens.length = pickups.length = 0;
    const bullets = this.batch;
    bullets.mine.length = 0;
    for (const list of bullets.kinds) list.length = 0;
    this.halfW = halfW;
    this.halfH = halfH;
    this.camX = camX;
    this.camY = camY;

    for (const e of world.entities.values()) {
      switch (e.type) {
        case EntityType.ASTEROID:
          if (this.cull(e, 70)) asteroids.push(e);
          break;
        case EntityType.SHIP:
          if (this.cull(e, 60)) ships.push(e);
          break;
        case EntityType.ALIEN:
          if (this.cull(e, 100)) aliens.push(e);
          break;
        case EntityType.PICKUP:
          if (this.cull(e, 20)) pickups.push(e);
          break;
        case EntityType.BULLET:
          if (e.visible && this.cull(e, 10)) (e.own ? bullets.mine : bullets.kinds[e.kind] ?? bullets.kinds[0]).push(e);
          break;
      }
    }
    for (const g of world.ghosts) if (g.visible && this.cull(g, 10)) bullets.mine.push(g);

    this.drawPickups(pickups, view.time);
    this.drawAsteroids(asteroids);
    this.drawBullets(bullets);
    for (const al of aliens) this.drawAlien(al, view.time);
    for (const s of ships) this.drawShip(s, world, view.time, false);
    if (view.self) this.drawShip(view.self, world, view.time, true);
    view.effects.draw(ctx, camX, camY, halfW, halfH);
  }

  /** Computes the camera-relative offset (dx, dy) and reports whether `e` is on screen. */
  cull(e, r) {
    e.dx = wrapDelta(e.rx - this.camX, WORLD_SIZE);
    e.dy = wrapDelta(e.ry - this.camY, WORLD_SIZE);
    return e.dx > -this.halfW - r && e.dx < this.halfW + r && e.dy > -this.halfH - r && e.dy < this.halfH + r;
  }

  drawStars(camX, camY) {
    const { ctx } = this;
    for (let i = 0; i < STAR_LAYERS.length; i++) {
      const p = STAR_LAYERS[i].parallax;
      const ox = -(((camX * p) % STAR_TILE) + STAR_TILE) % STAR_TILE;
      const oy = -(((camY * p) % STAR_TILE) + STAR_TILE) % STAR_TILE;
      for (let x = ox; x < this.width; x += STAR_TILE) {
        for (let y = oy; y < this.height; y += STAR_TILE) ctx.drawImage(this.starTiles[i], x, y);
      }
    }
  }

  drawGrid(camX, camY, halfW, halfH) {
    const { ctx } = this;
    const step = 384;
    ctx.strokeStyle = 'rgba(120, 140, 255, 0.07)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const x0 = Math.ceil((camX - halfW) / step) * step;
    for (let x = x0; x < camX + halfW; x += step) {
      const dx = x - camX;
      ctx.moveTo(dx, -halfH);
      ctx.lineTo(dx, halfH);
    }
    const y0 = Math.ceil((camY - halfH) / step) * step;
    for (let y = y0; y < camY + halfH; y += step) {
      const dy = y - camY;
      ctx.moveTo(-halfW, dy);
      ctx.lineTo(halfW, dy);
    }
    ctx.stroke();
  }

  drawAsteroids(list) {
    const { ctx } = this;
    ctx.beginPath();
    for (const a of list) {
      const shape = a.shape;
      const c = Math.cos(a.ra);
      const s = Math.sin(a.ra);
      for (let i = 0; i < shape.length; i += 2) {
        const x = a.dx + shape[i] * c - shape[i + 1] * s;
        const y = a.dy + shape[i] * s + shape[i + 1] * c;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
    ctx.fillStyle = 'rgba(154, 165, 177, 0.06)';
    ctx.fill();
    ctx.strokeStyle = '#b8c2cc';
    ctx.lineWidth = 2.2;
    ctx.stroke();
  }

  drawBullets(batch) {
    const { ctx } = this;
    const dots = (list, color, glow) => {
      if (list.length === 0) return;
      ctx.beginPath();
      for (const b of list) {
        const r = b.kind === BulletKind.CANNON ? 7 : b.kind === BulletKind.MOTHERSHIP ? 6 : b.kind === BulletKind.ALIEN ? 4 : 3;
        ctx.moveTo(b.dx + r, b.dy);
        ctx.arc(b.dx, b.dy, r, 0, TAU);
      }
      ctx.globalAlpha = 0.25;
      ctx.strokeStyle = glow;
      ctx.lineWidth = 6;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = color;
      ctx.fill();
    };
    dots(batch.mine, '#ffffff', '#5cf2ff');
    for (let k = 0; k < batch.kinds.length; k++) dots(batch.kinds[k], BULLET_COLORS[k], BULLET_COLORS[k]);
  }

  drawPickups(list, time) {
    const { ctx } = this;
    ctx.beginPath();
    for (const p of list) {
      if (p.kind > PickupKind.ORB_LARGE) continue;
      const r = ORB_SIZE[p.kind] * (1 + 0.15 * Math.sin(time * 6 + p.seed));
      ctx.moveTo(p.dx + r, p.dy);
      ctx.arc(p.dx, p.dy, r, 0, TAU);
    }
    ctx.fillStyle = '#ffd166';
    ctx.fill();
    ctx.font = `bold 14px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const p of list) {
      const style = POWERUP_STYLE[p.kind];
      if (!style) continue;
      const pulse = 1 + 0.12 * Math.sin(time * 5 + p.seed);
      ctx.strokeStyle = style.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + time * 0.8;
        const x = p.dx + Math.cos(a) * 14 * pulse;
        const y = p.dy + Math.sin(a) * 14 * pulse;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = style.color;
      ctx.fillText(style.label, p.dx, p.dy + 1);
    }
  }

  /** Ship as the classic notched triangle. `s` has dx, dy, ra, flags, hpFrac, playerId, level, weapon. */
  drawShip(s, world, time, mine) {
    const { ctx } = this;
    const r = SHIP_RADIUS;
    const hue = world.playerHue(s.playerId);
    const color = mine ? '#ffffff' : playerColor(hue);
    const blink = s.flags & ShipFlag.INVULN && Math.floor(time * 8) % 2 === 0;

    ctx.save();
    ctx.translate(s.dx, s.dy);
    ctx.rotate(s.ra);
    ctx.globalAlpha = blink ? 0.35 : 1;
    if (s.flags & ShipFlag.THRUST) {
      const boost = (s.flags & ShipFlag.BOOST) !== 0;
      const len = (boost ? 2.2 : 1.5) + Math.random() * 0.4;
      ctx.beginPath();
      ctx.moveTo(-0.62 * r, -0.38 * r);
      ctx.lineTo(-len * r, 0);
      ctx.lineTo(-0.62 * r, 0.38 * r);
      ctx.strokeStyle = boost ? '#5cf2ff' : '#ff8c42';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(1.35 * r, 0);
    ctx.lineTo(-r, -0.9 * r);
    ctx.lineTo(-0.55 * r, 0);
    ctx.lineTo(-r, 0.9 * r);
    ctx.closePath();
    ctx.fillStyle = s.hitFlash > 0 ? `rgba(255,255,255,${0.6 * s.hitFlash})` : mine ? 'rgba(92,242,255,0.12)' : playerColor(hue, 30);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.stroke();
    if (s.weapon !== Weapon.BLASTER) {
      ctx.beginPath();
      if (s.weapon === Weapon.TWIN) {
        ctx.moveTo(0.2 * r, -0.45 * r);
        ctx.lineTo(0.95 * r, -0.45 * r);
        ctx.moveTo(0.2 * r, 0.45 * r);
        ctx.lineTo(0.95 * r, 0.45 * r);
      } else if (s.weapon === Weapon.SCATTER) {
        ctx.moveTo(0.4 * r, -0.3 * r);
        ctx.lineTo(0.95 * r, -0.62 * r);
        ctx.moveTo(0.4 * r, 0.3 * r);
        ctx.lineTo(0.95 * r, 0.62 * r);
      } else {
        ctx.moveTo(0.3 * r, 0);
        ctx.lineTo(1.7 * r, 0);
      }
      ctx.lineWidth = s.weapon === Weapon.CANNON ? 4 : 2;
      ctx.stroke();
    }
    ctx.restore();

    if (s.flags & ShipFlag.SHIELD) {
      ctx.beginPath();
      ctx.arc(s.dx, s.dy, r * 1.9, 0, TAU);
      ctx.strokeStyle = '#5cf2ff';
      ctx.globalAlpha = 0.45 + 0.25 * Math.sin(time * 7);
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (!mine) {
      ctx.font = `13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = color;
      ctx.fillText(world.playerName(s.playerId), s.dx, s.dy + r + 12);
      ctx.font = `10px ${FONT}`;
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(`LV ${s.level}`, s.dx, s.dy + r + 27);
      if (s.hpFrac < 0.999) this.drawHealthBar(s.dx, s.dy - r - 14, 36, s.hpFrac);
    }
  }

  drawHealthBar(x, y, width, frac) {
    const { ctx } = this;
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(x - width / 2, y, width, 4);
    ctx.fillStyle = frac > 0.5 ? '#7dff6a' : frac > 0.25 ? '#ffd166' : '#ff4d4d';
    ctx.fillRect(x - width / 2, y, width * frac, 4);
  }

  drawAlien(al, time) {
    const { ctx } = this;
    const r = ALIEN_RADIUS[al.kind];
    const color = al.kind === AlienKind.HUNTER ? '#ff4d4d' : al.kind === AlienKind.MOTHERSHIP ? '#ff5cf2' : '#7dff6a';
    const x = al.dx;
    const y = al.dy;
    ctx.beginPath();
    // Classic saucer: hull, rim line and dome
    ctx.moveTo(x - r, y);
    ctx.lineTo(x - 0.45 * r, y - 0.32 * r);
    ctx.lineTo(x + 0.45 * r, y - 0.32 * r);
    ctx.lineTo(x + r, y);
    ctx.lineTo(x + 0.45 * r, y + 0.32 * r);
    ctx.lineTo(x - 0.45 * r, y + 0.32 * r);
    ctx.closePath();
    ctx.moveTo(x - r, y);
    ctx.lineTo(x + r, y);
    ctx.moveTo(x - 0.3 * r, y - 0.32 * r);
    ctx.lineTo(x - 0.18 * r, y - 0.62 * r);
    ctx.lineTo(x + 0.18 * r, y - 0.62 * r);
    ctx.lineTo(x + 0.3 * r, y - 0.32 * r);
    ctx.fillStyle = al.hitFlash > 0 ? `rgba(255,255,255,${0.5 * al.hitFlash})` : 'rgba(0,0,0,0.6)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = al.kind === AlienKind.MOTHERSHIP ? 3.5 : 2.2;
    ctx.stroke();
    if (al.kind === AlienKind.MOTHERSHIP) {
      ctx.fillStyle = '#ffd166';
      for (let i = 0; i < 8; i++) {
        const a = time * 2 + (i / 8) * TAU;
        const lx = x + Math.cos(a) * r * 0.72;
        if (Math.sin(a) > 0) ctx.fillRect(lx - 3, y + 0.1 * r - 3, 6, 6);
      }
      this.drawHealthBar(x, y - r * 0.85, 140, al.hpFrac);
    } else if (al.hpFrac < 0.999) {
      this.drawHealthBar(x, y - r - 10, 30, al.hpFrac);
    }
  }
}
