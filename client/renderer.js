/**
 * Canvas renderer for the world: parallax starfield, vector-style entities,
 * particles. Everything is drawn relative to the camera with wrap-aware
 * offsets, so the torus world needs no special casing. Same-coloured shapes
 * are batched into one path where possible to keep draw calls low.
 */
import {
  ALIEN_RADIUS,
  AlienKind,
  BodyKind,
  BulletKind,
  Button,
  EntityType,
  FLARE_REACH,
  FLARE_SHADOW_MARGIN,
  NO_TEAM,
  OUTPOST_RADIUS,
  Perk,
  PickupKind,
  ShipFlag,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  WORLD_SIZE,
} from '../shared/constants.js';
import { GRAVITY, pullAt } from '../shared/gravity.js';
import { TAU, createRng, wrapDelta } from '../shared/math.js';
import { CLASSES, ShipClass, Weapon } from '../shared/stats.js';
import { nightSide, starOf } from '../shared/terrain.js';
import { Flight } from './flightpath.js';
import { TEAM_HUES } from './world.js';

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

/** Flight-path colours by Flight state. */
export const FLIGHT_COLORS = ['#9fb3c8', '#7dff6a', '#e8eef5', '#ffd166', '#ff4d4d', '#7dff6a', '#5cf2ff'];
const RIPPLES = 3;
const RIPPLE_PERIOD = 3.6; // seconds for a ripple to fall from the edge of a well to the surface

/**
 * Colour and surface details for a body. The star burns gold; planets run
 * from cool blue (light gas giants) to hot red (dense cores). `contours` are
 * the radii where the pull doubles: 2×, 4×, 8×… the pull at the edge.
 */
function bodyArt(p) {
  const star = p.kind === BodyKind.STAR;
  const heat = Math.min(1, Math.max(0, (p.density - 0.4) / 3.2));
  const hue = star ? 42 : Math.round(215 - heat * 205);
  const rng = createRng(p.id * 977 + 13);
  const contours = [];
  for (let k = 2; ; k *= 2) {
    const r = Math.sqrt(p.gm / (GRAVITY.edgeAccel * k));
    if (r < p.radius + 12) break;
    contours.push(r);
  }
  return {
    kind: star ? 'star' : p.kind === BodyKind.GAS ? 'gas' : p.kind === BodyKind.ROCK ? 'rock' : 'core',
    hue,
    fill: `hsl(${hue} 45% 9%)`,
    outline: `hsl(${hue} 75% 62%)`,
    detail: `hsla(${hue} 70% 60% / 0.45)`,
    field: null, // radial gradient of the pull, built on first draw
    contours,
    bands: [-0.62, -0.3, 0.05, 0.38, 0.66],
    craters: Array.from({ length: 5 }, () => ({ x: rng() * 1.2 - 0.6, y: rng() * 1.2 - 0.6, r: 0.08 + rng() * 0.12 })),
    flares: Array.from({ length: 16 }, () => ({ phase: rng() * TAU, speed: 0.6 + rng() * 1.4, length: 0.12 + rng() * 0.22 })),
  };
}

/** A radial gradient (centred on the origin) whose opacity follows the body's pull. */
function fieldGradient(ctx, p, hue) {
  const g = ctx.createRadialGradient(0, 0, p.radius, 0, 0, p.range);
  for (const f of [0, 0.06, 0.15, 0.3, 0.5, 0.7, 0.85, 1]) {
    const strength = pullAt(p, p.radius + f * (p.range - p.radius)) / p.surfacePull;
    g.addColorStop(f, `hsla(${hue} 85% 60% / ${(0.2 * Math.sqrt(strength)).toFixed(3)})`);
  }
  return g;
}

export function playerColor(hue, lightness = 65) {
  return `hsl(${hue} 90% ${lightness}%)`;
}

export const teamColor = (team, lightness = 62) => (team === NO_TEAM ? '#cfd6e6' : `hsl(${TEAM_HUES[team]} 92% ${lightness}%)`);
const PERK_LABELS = { [Perk.FORGE]: 'FORGE', [Perk.REFINERY]: 'REFINERY', [Perk.SHIPYARD]: 'SHIPYARD' };

/**
 * Traces a ship class's hull (nose along +x) at radius `r`, ready to fill and
 * stroke. Fighter: the classic notched dart. Breaker: an armoured wedge.
 * Medic: a slim dart with swept wings. Graviton: a ring with a prow.
 */
export function traceHull(ctx, shipClass, r) {
  ctx.beginPath();
  switch (shipClass) {
    case ShipClass.BREAKER:
      ctx.moveTo(1.2 * r, 0);
      ctx.lineTo(0.55 * r, -0.82 * r);
      ctx.lineTo(-0.85 * r, -0.85 * r);
      ctx.lineTo(-0.6 * r, -0.3 * r);
      ctx.lineTo(-0.6 * r, 0.3 * r);
      ctx.lineTo(-0.85 * r, 0.85 * r);
      ctx.lineTo(0.55 * r, 0.82 * r);
      break;
    case ShipClass.MEDIC:
      ctx.moveTo(1.3 * r, 0);
      ctx.lineTo(0.2 * r, -0.5 * r);
      ctx.lineTo(-0.55 * r, -0.98 * r);
      ctx.lineTo(-0.88 * r, -0.36 * r);
      ctx.lineTo(-0.88 * r, 0.36 * r);
      ctx.lineTo(-0.55 * r, 0.98 * r);
      ctx.lineTo(0.2 * r, 0.5 * r);
      break;
    case ShipClass.GRAVITON:
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const k = i === 0 ? 1.35 : 0.85;
        if (i === 0) ctx.moveTo(Math.cos(a) * k * r, Math.sin(a) * k * r);
        else ctx.lineTo(Math.cos(a) * k * r, Math.sin(a) * k * r);
      }
      break;
    default:
      ctx.moveTo(1.35 * r, 0);
      ctx.lineTo(-r, -0.9 * r);
      ctx.lineTo(-0.55 * r, 0);
      ctx.lineTo(-r, 0.9 * r);
  }
  ctx.closePath();
}

/** Class markings drawn over the hull: ram plate, repair cross, gravity core. */
export function traceHullDetails(ctx, shipClass, r, time = 0) {
  ctx.beginPath();
  switch (shipClass) {
    case ShipClass.BREAKER:
      ctx.moveTo(0.5 * r, -0.52 * r);
      ctx.lineTo(0.92 * r, 0);
      ctx.lineTo(0.5 * r, 0.52 * r);
      break;
    case ShipClass.MEDIC:
      ctx.moveTo(-0.28 * r, 0);
      ctx.lineTo(0.34 * r, 0);
      ctx.moveTo(0.03 * r, -0.31 * r);
      ctx.lineTo(0.03 * r, 0.31 * r);
      break;
    case ShipClass.GRAVITON: {
      const k = 0.38 + 0.06 * Math.sin(time * 5);
      ctx.moveTo(k * r, 0);
      ctx.arc(0, 0, k * r, 0, TAU);
      break;
    }
    default:
      break;
  }
}

/** Renders a nebula once into an offscreen canvas: overlapping soft puffs seeded by the nebula. */
function nebulaImage(n) {
  const scale = 0.5; // pixels per world unit: clouds are soft, so half resolution is plenty
  const size = Math.ceil(n.radius * 2.3 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = createRng(n.seed);
  const c = size / 2;
  const hues = [265, 285, 205, 320];
  for (let i = 0; i < 26; i++) {
    const a = rng() * TAU;
    const d = Math.sqrt(rng()) * n.radius * 0.7 * scale;
    const r = (0.25 + rng() * 0.35) * n.radius * scale;
    const x = c + Math.cos(a) * d;
    const y = c + Math.sin(a) * d;
    const hue = hues[Math.floor(rng() * hues.length)];
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `hsla(${hue} 70% 55% / 0.16)`);
    g.addColorStop(1, `hsla(${hue} 70% 40% / 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return canvas;
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
    this.offset = { x: 0, y: 0 };
    this.point = { x: 0, y: 0, nx: 0, ny: 0 };
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
   * (own ship render state or null), effects, time (seconds), tick (the
   * present, in server ticks), flight (the own ship's FlightPath, or null)
   * and lock ({body, radius, dir} or null).
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

    const focus = view.flight && view.flight.state !== Flight.FREE ? view.flight : null;
    if (world.match?.flare) this.drawFlare(world, world.match.flare, view.tick, view.time);
    this.drawWells(world.planets, view.time, focus);
    this.drawFields(world, view.tick, view.time);
    if (view.flight?.visible && (view.flight.shown || view.lock)) this.drawFlight(view.flight, view.lock, view.time);
    if (view.reticle) this.drawReticle(view.reticle, view.time);
    this.drawBodies(world.planets, view.time);
    this.drawOutposts(world, view.time);
    this.drawPickups(pickups, view.time);
    this.drawAsteroids(asteroids);
    this.drawBullets(bullets);
    for (const al of aliens) this.drawAlien(al, view.time);
    for (const s of ships) this.drawShip(s, world, view.time, false);
    if (view.self) this.drawShip(view.self, world, view.time, true);
    this.drawNebulae(world.nebulae);
    view.effects.draw(ctx, camX, camY, halfW, halfH);
  }

  /**
   * Nebulae: soft clouds pre-rendered once each (at half resolution) and
   * drawn over everything else, so ships inside look veiled.
   */
  drawNebulae(nebulae) {
    const { ctx } = this;
    for (const n of nebulae) {
      const dx = wrapDelta(n.x - this.camX, WORLD_SIZE);
      const dy = wrapDelta(n.y - this.camY, WORLD_SIZE);
      if (Math.abs(dx) > this.halfW + n.radius * 1.2 || Math.abs(dy) > this.halfH + n.radius * 1.2) continue;
      n.image ??= nebulaImage(n);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(n.image, dx - n.radius * 1.15, dy - n.radius * 1.15, n.radius * 2.3, n.radius * 2.3);
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Outposts on the planets' night sides: a beacon in its owner's colour and
   * the capture zone, whose ring fills towards the team taking it and
   * flashes while contested.
   */
  drawOutposts(world, time) {
    const star = starOf(world.planets);
    const m = world.match;
    if (!star || !m) return;
    const { ctx } = this;
    for (let i = 0; i < world.outposts.length; i++) {
      const def = world.outposts[i];
      const planet = world.planets[def.planet];
      const state = m.outposts[i];
      if (!planet || !state) continue;
      const p = nightSide(star, planet, 0, this.point);
      const dx = wrapDelta(p.x - this.camX, WORLD_SIZE);
      const dy = wrapDelta(p.y - this.camY, WORLD_SIZE);
      if (Math.abs(dx) > this.halfW + OUTPOST_RADIUS || Math.abs(dy) > this.halfH + OUTPOST_RADIUS) continue;
      const color = teamColor(state.owner);
      ctx.setLineDash([6, 10]);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dx, dy, OUTPOST_RADIUS, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      if (state.progress !== 0) {
        const start = Math.atan2(p.ny, p.nx);
        ctx.strokeStyle = teamColor(state.progress < 0 ? 0 : 1);
        ctx.globalAlpha = state.contested ? 0.5 + 0.5 * Math.sin(time * 14) : 0.9;
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(dx, dy, OUTPOST_RADIUS, start, start + TAU * Math.abs(state.progress));
        ctx.stroke();
      }
      if (state.contested) {
        ctx.strokeStyle = '#ffffff';
        ctx.globalAlpha = 0.4 + 0.4 * Math.sin(time * 14);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(dx, dy, OUTPOST_RADIUS + 8, 0, TAU);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // Beacon: a mast on the surface with a pulsing light
      const tx = dx + p.nx * 34;
      const ty = dy + p.ny * 34;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(dx - p.ny * 14, dy + p.nx * 14);
      ctx.lineTo(tx, ty);
      ctx.lineTo(dx + p.ny * 14, dy - p.nx * 14);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.6 + 0.4 * Math.sin(time * 4 + i);
      ctx.beginPath();
      ctx.arc(tx, ty, 6, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.font = `bold 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(PERK_LABELS[def.perk] ?? '', dx + p.nx * 62, dy + p.ny * 62);
    }
  }

  /**
   * A solar flare: while it is coming, its wedge pulses and the planets'
   * shadows (the safe zones) show as cones; while it burns, the wedge blazes
   * and the shadows are the only dark places in it.
   */
  drawFlare(world, flare, tick, time) {
    const star = starOf(world.planets);
    if (!star) return;
    const { ctx } = this;
    const sx = wrapDelta(star.x - this.camX, WORLD_SIZE);
    const sy = wrapDelta(star.y - this.camY, WORLD_SIZE);
    const burning = tick >= flare.start;
    const a0 = flare.angle - flare.halfWidth;
    const a1 = flare.angle + flare.halfWidth;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.arc(sx, sy, FLARE_REACH, a0, a1);
    ctx.closePath();
    if (burning) {
      const k = Math.max(0, 1 - (tick - flare.start) / Math.max(1, flare.end - flare.start));
      ctx.fillStyle = `rgba(255, 214, 120, ${(0.18 + 0.22 * k).toFixed(3)})`;
    } else {
      ctx.fillStyle = `rgba(255, 140, 66, ${(0.05 + 0.05 * Math.sin(time * 8)).toFixed(3)})`;
    }
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = burning ? 'rgba(0, 0, 0, 0.55)' : 'rgba(30, 60, 140, 0.25)';
    for (const p of world.planets) {
      if (p === star) continue;
      const px = wrapDelta(p.x - star.x, WORLD_SIZE);
      const py = wrapDelta(p.y - star.y, WORLD_SIZE);
      const d = Math.hypot(px, py) || 1;
      const r = p.radius + FLARE_SHADOW_MARGIN;
      const nx = -py / d;
      const ny = px / d;
      const s1x = px + nx * r;
      const s1y = py + ny * r;
      const s2x = px - nx * r;
      const s2y = py - ny * r;
      const f1 = FLARE_REACH / Math.hypot(s1x, s1y);
      const f2 = FLARE_REACH / Math.hypot(s2x, s2y);
      ctx.beginPath();
      ctx.moveTo(sx + s1x, sy + s1y);
      ctx.lineTo(sx + s1x * f1, sy + s1y * f1);
      ctx.lineTo(sx + s2x * f2, sy + s2y * f2);
      ctx.lineTo(sx + s2x, sy + s2y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    ctx.strokeStyle = burning ? '#ffe08a' : '#ff8c42';
    ctx.globalAlpha = burning ? 0.8 : 0.5 + 0.3 * Math.sin(time * 8);
    ctx.lineWidth = 2;
    ctx.setLineDash(burning ? [] : [18, 14]);
    ctx.beginPath();
    ctx.moveTo(sx + Math.cos(a0) * star.radius, sy + Math.sin(a0) * star.radius);
    ctx.lineTo(sx + Math.cos(a0) * FLARE_REACH, sy + Math.sin(a0) * FLARE_REACH);
    ctx.moveTo(sx + Math.cos(a1) * star.radius, sy + Math.sin(a1) * star.radius);
    ctx.lineTo(sx + Math.cos(a1) * FLARE_REACH, sy + Math.sin(a1) * FLARE_REACH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /** Graviton singularities: a dark core inside spiral arms winding inwards, in the owner's colour. */
  drawFields(world, tick, time) {
    const { ctx } = this;
    for (const f of world.gravityFields) {
      if (tick < f.born - 2 || tick >= f.expires) continue;
      const dx = wrapDelta(f.x - this.camX, WORLD_SIZE);
      const dy = wrapDelta(f.y - this.camY, WORLD_SIZE);
      if (Math.abs(dx) > this.halfW + f.range || Math.abs(dy) > this.halfH + f.range) continue;
      const fade = Math.max(0, Math.min(1, (tick - f.born + 2) / 12, (f.expires - tick) / 20));
      const color = f.team === NO_TEAM ? '#b48cff' : teamColor(f.team, 66);
      ctx.save();
      ctx.translate(dx, dy);
      ctx.globalAlpha = 0.25 * fade;
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 12]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, f.range, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.rotate(time * 3.2);
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.7 * fade;
      ctx.beginPath();
      for (let arm = 0; arm < 4; arm++) {
        for (let k = 0; k <= 16; k++) {
          const t = k / 16;
          const r = f.radius + (f.range * 0.62 - f.radius) * t;
          const a = (arm / 4) * TAU + t * 2.4;
          if (k === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
      }
      ctx.stroke();
      ctx.globalAlpha = fade;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(0, 0, f.radius, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Computes the camera-relative offset (dx, dy) and reports whether `e` is on screen. */
  cull(e, r) {
    e.dx = wrapDelta(e.rx - this.camX, WORLD_SIZE);
    e.dy = wrapDelta(e.ry - this.camY, WORLD_SIZE);
    return e.dx > -this.halfW - r && e.dx < this.halfW + r && e.dy > -this.halfH - r && e.dy < this.halfH + r;
  }

  /** Camera-relative offset of a body, or null when neither it nor its well is on screen. */
  bodyOffset(p, reach) {
    const dx = wrapDelta(p.x - this.camX, WORLD_SIZE);
    const dy = wrapDelta(p.y - this.camY, WORLD_SIZE);
    if (Math.abs(dx) > this.halfW + reach || Math.abs(dy) > this.halfH + reach) return null;
    this.offset.x = dx;
    this.offset.y = dy;
    return this.offset;
  }

  /**
   * Gravity wells, made visible: a haze whose opacity follows the pull,
   * contour rings where the pull doubles, ripples falling inwards (faster as
   * they near the surface, like anything else in the well) and the edge of
   * the well. The well the player is in is lit up, its edge in the colour of
   * their flight state (green: stable orbit, yellow: descent, red: crash).
   */
  drawWells(planets, time, focus) {
    const { ctx } = this;
    for (const p of planets) {
      const o = this.bodyOffset(p, p.range);
      if (!o) continue;
      const art = p.art ?? (p.art = bodyArt(p));
      const lit = focus !== null && focus.body !== null && focus.body.id === p.id;
      const boost = lit ? 1.9 : 1;

      ctx.save();
      ctx.translate(o.x, o.y);
      art.field ??= fieldGradient(ctx, p, art.hue);
      ctx.globalAlpha = lit ? 1 : 0.7;
      ctx.fillStyle = art.field;
      ctx.beginPath();
      ctx.arc(0, 0, p.range, 0, TAU);
      ctx.arc(0, 0, p.radius, 0, TAU, true);
      ctx.fill();

      ctx.strokeStyle = `hsl(${art.hue} 80% 70%)`;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 9]);
      for (let i = 0; i < art.contours.length; i++) {
        ctx.globalAlpha = Math.min(1, (0.1 + 0.05 * i) * boost);
        ctx.beginPath();
        ctx.arc(0, 0, art.contours[i], 0, TAU);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      ctx.lineWidth = 2;
      for (let i = 0; i < RIPPLES; i++) {
        const t = (time / RIPPLE_PERIOD + i / RIPPLES) % 1;
        const r = p.range - (p.range - p.radius) * t * t;
        ctx.globalAlpha = Math.sin(Math.PI * t) * 0.16 * boost;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, TAU);
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(0, 0, p.range, 0, TAU);
      if (lit) {
        ctx.strokeStyle = FLIGHT_COLORS[focus.state];
        ctx.globalAlpha = 0.55 + 0.15 * Math.sin(time * 4);
        ctx.lineWidth = 2;
      } else {
        ctx.setLineDash([10, 16]);
        ctx.globalAlpha = 0.3;
        ctx.lineWidth = 1.5;
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * The own ship's coasting path in its well's frame: dots fading with time,
   * ending in a cross at a crash or a ring at a touchdown. While orbit-locked,
   * the whole locked orbit is drawn instead, with chevrons showing direction.
   */
  drawFlight(f, lock, time) {
    const { ctx } = this;
    const color = FLIGHT_COLORS[f.state];
    if (lock) {
      const o = this.bodyOffset(lock.body, lock.radius);
      if (!o) return;
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 2;
      ctx.setLineDash([14, 10]);
      ctx.lineDashOffset = -lock.dir * time * 40;
      ctx.beginPath();
      ctx.arc(0, 0, lock.radius, 0, TAU);
      ctx.stroke();
      ctx.restore();
      return;
    }
    const n = f.count;
    if (n < 2 || f.state === Flight.LANDED) return;
    ctx.fillStyle = color;
    const bands = 4;
    for (let band = 0; band < bands; band++) {
      ctx.globalAlpha = 0.85 - band * 0.2;
      ctx.beginPath();
      const from = Math.floor((band * n) / bands);
      const to = Math.floor(((band + 1) * n) / bands);
      for (let i = Math.max(1, from); i < to; i++) {
        const x = wrapDelta(f.xs[i] - this.camX, WORLD_SIZE);
        const y = wrapDelta(f.ys[i] - this.camY, WORLD_SIZE);
        ctx.moveTo(x + 2.2, y);
        ctx.arc(x, y, 2.2, 0, TAU);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (f.contact) {
      const x = wrapDelta(f.xs[n - 1] - this.camX, WORLD_SIZE);
      const y = wrapDelta(f.ys[n - 1] - this.camY, WORLD_SIZE);
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      if (f.state === Flight.IMPACT) {
        const r = 9 + 2 * Math.sin(time * 12);
        ctx.moveTo(x - r, y - r);
        ctx.lineTo(x + r, y + r);
        ctx.moveTo(x + r, y - r);
        ctx.lineTo(x - r, y + r);
      } else {
        ctx.arc(x, y, 8, 0, TAU);
      }
      ctx.stroke();
    }
  }

  /**
   * The Graviton's aim: where its singularity would form, solid when the
   * ability is ready.
   */
  drawReticle(r, time) {
    const { ctx } = this;
    const dx = wrapDelta(r.x - this.camX, WORLD_SIZE);
    const dy = wrapDelta(r.y - this.camY, WORLD_SIZE);
    ctx.save();
    ctx.translate(dx, dy);
    ctx.rotate(time * 1.5);
    ctx.strokeStyle = r.color;
    ctx.globalAlpha = r.ready ? 0.7 : 0.25;
    ctx.lineWidth = 2;
    ctx.setLineDash(r.ready ? [] : [4, 6]);
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * TAU;
      ctx.moveTo(Math.cos(a) * 14, Math.sin(a) * 14);
      ctx.arc(0, 0, 14, a, a + 0.9);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /**
   * Bodies as vector globes: the star a blazing disc with a flickering
   * corona; light gas giants get bands and a ring, rocky worlds craters,
   * dense cores a hot glowing heart.
   */
  drawBodies(planets, time) {
    const { ctx } = this;
    for (const p of planets) {
      const o = this.bodyOffset(p, p.radius * 2);
      if (!o) continue;
      const art = p.art ?? (p.art = bodyArt(p));
      const r = p.radius;
      const dx = o.x;
      const dy = o.y;
      if (art.kind === 'star') {
        this.drawStar(p, art, dx, dy, time);
        continue;
      }

      ctx.save();
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, TAU);
      ctx.fillStyle = art.fill;
      ctx.fill();
      ctx.clip();
      ctx.strokeStyle = art.detail;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (art.kind === 'gas') {
        for (const band of art.bands) {
          ctx.moveTo(dx - r, dy + band * r);
          ctx.lineTo(dx + r, dy + band * r + 0.08 * r);
        }
      } else if (art.kind === 'rock') {
        for (const c of art.craters) {
          ctx.moveTo(dx + c.x * r + c.r * r, dy + c.y * r);
          ctx.arc(dx + c.x * r, dy + c.y * r, c.r * r, 0, TAU);
        }
      } else {
        const pulse = 0.85 + 0.15 * Math.sin(time * 3 + p.id);
        ctx.moveTo(dx + r * 0.68 * pulse, dy);
        ctx.arc(dx, dy, r * 0.68 * pulse, 0, TAU);
        ctx.moveTo(dx + r * 0.36 * pulse, dy);
        ctx.arc(dx, dy, r * 0.36 * pulse, 0, TAU);
      }
      ctx.stroke();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, TAU);
      ctx.strokeStyle = art.outline;
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 8;
      ctx.stroke(); // soft atmosphere glow
      ctx.globalAlpha = 1;
      if (art.kind === 'gas') {
        ctx.beginPath();
        ctx.ellipse(dx, dy, r * 1.55, r * 0.32, -0.35, 0, TAU);
        ctx.strokeStyle = art.detail;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      this.drawBodyLabel(p, dx, dy - r - 14);
    }
  }

  drawStar(p, art, dx, dy, time) {
    const { ctx } = this;
    const r = p.radius;
    ctx.save();
    ctx.translate(dx, dy);
    art.corona ??= (() => {
      const g = ctx.createRadialGradient(0, 0, r * 0.85, 0, 0, r * 2.1);
      g.addColorStop(0, 'rgba(255, 214, 120, 0.55)');
      g.addColorStop(0.35, 'rgba(255, 150, 60, 0.18)');
      g.addColorStop(1, 'rgba(255, 110, 40, 0)');
      return g;
    })();
    art.disc ??= (() => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, '#fff8dc');
      g.addColorStop(0.55, '#ffd36b');
      g.addColorStop(1, '#ff9a2e');
      return g;
    })();
    ctx.fillStyle = art.corona;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.1, 0, TAU);
    ctx.fill();

    // Flickering flares around the limb
    ctx.strokeStyle = '#ffb347';
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    for (let i = 0; i < art.flares.length; i++) {
      const f = art.flares[i];
      const a = (i / art.flares.length) * TAU + time * 0.05;
      const len = r * f.length * (0.6 + 0.4 * Math.sin(time * f.speed + f.phase));
      ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      ctx.lineTo(Math.cos(a) * (r + len), Math.sin(a) * (r + len));
    }
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = art.disc;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = '#ffe9a8';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
    this.drawBodyLabel(p, dx, dy - r * 1.3);
  }

  drawBodyLabel(p, x, y) {
    const { ctx } = this;
    ctx.font = `12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(p.name.toUpperCase(), x, y);
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

  /** Fuel cells: amber canisters that bob and glow. */
  drawFuelCells(list, time) {
    const { ctx } = this;
    ctx.lineWidth = 2;
    for (const p of list) {
      if (p.kind !== PickupKind.FUEL) continue;
      const bob = Math.sin(time * 3 + p.seed) * 2;
      ctx.save();
      ctx.translate(p.dx, p.dy + bob);
      ctx.rotate(0.35);
      ctx.fillStyle = 'rgba(255, 179, 71, 0.2)';
      ctx.strokeStyle = '#ffb347';
      ctx.beginPath();
      ctx.rect(-6, -10, 12, 20);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-3, -13);
      ctx.lineTo(3, -13);
      ctx.moveTo(-6, 0);
      ctx.lineTo(6, 0);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawPickups(list, time) {
    this.drawFuelCells(list, time);
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

  /**
   * A ship: its class's hull in its team's colour (our own outlined in
   * white). `s` has dx, dy, ra, flags, hpFrac, playerId, level, weapon, and
   * for our own ship `thrusters` (the reverse and lateral thruster buttons
   * that are firing) and `shipClass`.
   */
  drawShip(s, world, time, mine) {
    const { ctx } = this;
    const shipClass = mine ? s.shipClass : world.playerClass(s.playerId);
    const r = (CLASSES[shipClass] ?? CLASSES[0]).radius;
    const hue = world.playerHue(s.playerId);
    const color = mine ? '#ffffff' : playerColor(hue);
    const blink = s.flags & ShipFlag.INVULN && Math.floor(time * 8) % 2 === 0;
    const stealth = (s.flags & ShipFlag.STEALTH) !== 0;
    const hidden = (s.flags & ShipFlag.HIDDEN) !== 0;

    ctx.save();
    ctx.translate(s.dx, s.dy);
    ctx.rotate(s.ra);
    ctx.globalAlpha = blink ? 0.35 : stealth || hidden ? 0.45 : 1;
    if (stealth) ctx.setLineDash([5, 4]);
    if (s.flags & ShipFlag.ABILITY) {
      // Ram drive: a blazing shield over the prow and a long burn behind
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.45, -1, 1);
      ctx.strokeStyle = '#ffb347';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-0.7 * r, -0.4 * r);
      ctx.lineTo(-(2.6 + Math.random()) * r, 0);
      ctx.lineTo(-0.7 * r, 0.4 * r);
      ctx.strokeStyle = '#ff8c42';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
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
    if (s.moveX || s.moveY) {
      // Screen-direction thrusters: a flame on the side opposite the push, whatever the heading.
      const a = Math.atan2(-s.moveY, -s.moveX) - s.ra;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const len = (1.25 + Math.random() * 0.4) * r;
      ctx.beginPath();
      ctx.moveTo(c * 0.7 * r - sn * 0.3 * r, sn * 0.7 * r + c * 0.3 * r);
      ctx.lineTo(c * len, sn * len);
      ctx.lineTo(c * 0.7 * r + sn * 0.3 * r, sn * 0.7 * r - c * 0.3 * r);
      ctx.strokeStyle = '#ff8c42';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (s.thrusters) {
      // Small puffs from the reverse and lateral thrusters
      const flick = 0.8 + Math.random() * 0.4;
      ctx.beginPath();
      if (s.thrusters & Button.BACK) {
        ctx.moveTo(0.9 * r, -0.25 * r);
        ctx.lineTo((1.35 + 0.5 * flick) * r, -0.45 * r);
        ctx.moveTo(0.9 * r, 0.25 * r);
        ctx.lineTo((1.35 + 0.5 * flick) * r, 0.45 * r);
      }
      if (s.thrusters & Button.STRAFE_LEFT) {
        ctx.moveTo(-0.2 * r, 0.55 * r);
        ctx.lineTo(-0.2 * r, (0.95 + 0.5 * flick) * r);
      }
      if (s.thrusters & Button.STRAFE_RIGHT) {
        ctx.moveTo(-0.2 * r, -0.55 * r);
        ctx.lineTo(-0.2 * r, -(0.95 + 0.5 * flick) * r);
      }
      ctx.strokeStyle = '#ff8c42';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    traceHull(ctx, shipClass, r);
    ctx.fillStyle = s.hitFlash > 0 ? `rgba(255,255,255,${0.6 * s.hitFlash})` : mine ? `hsla(${hue} 90% 60% / 0.2)` : playerColor(hue, 30);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.stroke();
    traceHullDetails(ctx, shipClass, r, time);
    ctx.lineWidth = 2;
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
    ctx.setLineDash([]);
    ctx.restore();

    if (s.flags & ShipFlag.LOCKED) {
      // Orbit-locked: two arcs circling the ship
      const spin = time * 2.5;
      ctx.beginPath();
      ctx.arc(s.dx, s.dy, r * 1.55, spin, spin + 1.2);
      ctx.moveTo(s.dx + Math.cos(spin + Math.PI) * r * 1.55, s.dy + Math.sin(spin + Math.PI) * r * 1.55);
      ctx.arc(s.dx, s.dy, r * 1.55, spin + Math.PI, spin + Math.PI + 1.2);
      ctx.strokeStyle = '#5cf2ff';
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
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
