/**
 * Terrain objectives for team play:
 *
 *  - Outposts, one on each planet's night side. Hold its zone with more
 *    pilots than the enemy to capture it. A held outpost scores points for its
 *    team every second and grants a perk to the whole team:
 *      Forge (on the dense core world): +15% weapon damage;
 *      Refinery (on the gas giant): +50% energy recharge;
 *      Shipyard (on the rocky world): respawn on the outpost itself.
 *    Getting there means flying into a gravity well: orbits, locks and
 *    landings all matter, and the Graviton's singularity can drag defenders off.
 *  - Solar flares: every minute or two the star erupts in a wedge, announced
 *    seconds ahead. Anything caught in the open is scorched; planets cast safe
 *    shadows behind them (outposts are always in their planet's shadow).
 *  - Nebulae: clouds in open space that hide pilots from enemies beyond
 *    close range, for ambushes and flanking. Firing gives you away.
 */
import { BodyKind, KillCause, NO_TEAM, Perk, RoundPhase, TICK_RATE, OUTPOST_RADIUS, WORLD_SIZE } from '../../shared/constants.js';
import { TAU, lerp, wrapDelta } from '../../shared/math.js';
import { dqPos, qPos } from '../../shared/protocol.js';
import { exposedToFlare, nebulaAt, nightSide, starOf } from '../../shared/terrain.js';
import { awardScore, damageAlien, damageShip, refreshStats } from './combat.js';
import { findOpenSpot } from './spawning.js';
import { addTeamScore } from './teams.js';
import { FLARE, NEBULA, OUTPOST } from './tuning.js';

const PERK_BY_KIND = { [BodyKind.CORE]: Perk.FORGE, [BodyKind.GAS]: Perk.REFINERY, [BodyKind.ROCK]: Perk.SHIPYARD };
const PERK_NAMES = { [Perk.FORGE]: 'Forge', [Perk.REFINERY]: 'Refinery', [Perk.SHIPYARD]: 'Shipyard' };
const point = { x: 0, y: 0, nx: 0, ny: 0 };
const crews = [0, 0];

/* Generation ------------------------------------------------------------------- */

/**
 * Outposts (one per planet) and nebulae (in the open space beyond the
 * planets' orbits, evenly spread around the star). Nebula positions are
 * snapped to the wire format so clients draw exactly what the server uses.
 */
export function generateTerrain(game) {
  const outposts = [];
  for (const planet of game.planets) {
    const perk = PERK_BY_KIND[planet.kind];
    if (perk) outposts.push({ planet: planet.id, perk, name: `${planet.name.split(' ')[0]} ${PERK_NAMES[perk]}` });
  }
  const nebulae = [];
  const star = starOf(game.planets);
  const cx = star ? star.x : WORLD_SIZE / 2;
  const cy = star ? star.y : WORLD_SIZE / 2;
  const turn = game.rng() * TAU;
  for (let i = 0; i < NEBULA.count; i++) {
    const a = turn + (i / NEBULA.count) * TAU + (game.rng() - 0.5) * 0.5;
    const d = lerp(NEBULA.ring[0], NEBULA.ring[1], game.rng());
    nebulae.push({
      x: dqPos(qPos(cx + Math.cos(a) * d)),
      y: dqPos(qPos(cy + Math.sin(a) * d)),
      radius: Math.round(lerp(NEBULA.radius[0], NEBULA.radius[1], game.rng())),
      seed: Math.floor(game.rng() * 0xffffffff),
    });
  }
  return { outposts, nebulae };
}

/** Fresh, neutral outposts and the flare schedule, at the start of every round. */
export function resetObjectives(game) {
  const m = game.match;
  m.outposts = game.terrain.outposts.map(() => ({ owner: NO_TEAM, progress: 0, contested: false }));
  for (let t = 0; t < m.perks.length; t++) setTeamPerks(game, t, 0);
  m.version++;
}

/** Where an outpost is right now (its planet moves): {x, y, nx, ny}. */
export function outpostPoint(game, index, out = point) {
  const def = game.terrain.outposts[index];
  return nightSide(starOf(game.planets), game.planets[def.planet], 0, out);
}

/* Per tick ---------------------------------------------------------------------- */

export function updateObjectives(game) {
  if (game.match.teams && game.match.phase === RoundPhase.PLAYING && starOf(game.planets)) updateOutposts(game);
  updateFlares(game);
  updateNebulae(game);
}

/**
 * Capture rules: progress runs from -1 (Helios) to +1 (Polaris). Pilots of
 * one team alone in the zone push it towards their side, faster with more of
 * them; both teams present means contested and frozen; an empty zone drifts
 * back towards its owner, or to neutral. Ownership flips at the ends, and is
 * lost when the progress crosses the middle.
 */
function updateOutposts(game) {
  const m = game.match;
  const second = game.tick % TICK_RATE === 0;
  const step = 1 / OUTPOST.captureTime;
  const decay = 1 / OUTPOST.decayTime;
  for (let i = 0; i < m.outposts.length; i++) {
    const state = m.outposts[i];
    const p = outpostPoint(game, i);
    crews[0] = crews[1] = 0;
    for (const ship of game.ships) {
      if (ship.dead || ship.team === NO_TEAM) continue;
      const dx = wrapDelta(ship.x - p.x, WORLD_SIZE);
      const dy = wrapDelta(ship.y - p.y, WORLD_SIZE);
      if (dx * dx + dy * dy < OUTPOST_RADIUS * OUTPOST_RADIUS) crews[ship.team]++;
    }
    const contested = crews[0] > 0 && crews[1] > 0;
    const before = state.progress;
    let progress = before;
    if (!contested && crews[0] + crews[1] > 0) {
      const team = crews[0] > 0 ? 0 : 1;
      const pace = step * Math.min(crews[team], OUTPOST.maxCrew);
      progress += team === 0 ? -pace : pace;
    } else if (!contested) {
      const home = state.owner === 0 ? -1 : state.owner === 1 ? 1 : 0;
      progress += Math.max(-decay, Math.min(decay, home - progress));
    }
    progress = Math.max(-1, Math.min(1, progress));
    state.progress = progress;
    let owner = state.owner;
    if (progress <= -1) owner = 0;
    else if (progress >= 1) owner = 1;
    else if ((owner === 0 && progress > 0) || (owner === 1 && progress < 0)) owner = NO_TEAM;
    const flipped = owner !== state.owner;
    // Clients animate the capture ring from the progress; resend it in small steps.
    if (flipped || contested !== state.contested || Math.round(before * 50) !== Math.round(progress * 50)) m.version++;
    state.contested = contested;
    if (flipped) {
      state.owner = owner;
      updatePerks(game);
      if (owner !== NO_TEAM) rewardCrew(game, p, owner, OUTPOST.captureScore);
    }
    if (second && state.owner !== NO_TEAM) {
      addTeamScore(game, state.owner, OUTPOST.pointsPerSecond);
      rewardCrew(game, p, state.owner, OUTPOST.holdScore);
    }
  }
}

function rewardCrew(game, p, team, amount) {
  for (const ship of game.ships) {
    if (ship.dead || ship.team !== team) continue;
    const dx = wrapDelta(ship.x - p.x, WORLD_SIZE);
    const dy = wrapDelta(ship.y - p.y, WORLD_SIZE);
    if (dx * dx + dy * dy < OUTPOST_RADIUS * OUTPOST_RADIUS) awardScore(game, ship, amount, ship.x, ship.y);
  }
}

/** Recomputes each team's perks from the outposts it holds. */
function updatePerks(game) {
  const m = game.match;
  for (let t = 0; t < m.perks.length; t++) {
    let perks = 0;
    for (let i = 0; i < m.outposts.length; i++) if (m.outposts[i].owner === t) perks |= game.terrain.outposts[i].perk;
    setTeamPerks(game, t, perks);
  }
}

function setTeamPerks(game, team, perks) {
  const m = game.match;
  if (m.perks[team] === perks) return;
  m.perks[team] = perks;
  m.version++;
  for (const ship of game.ships) {
    if (!ship.dead && ship.team === team) applyPerks(ship, perks);
  }
}

/** Folds team perks into a ship's stats (they change damage and energy recharge, which clients predict). */
export function applyPerks(ship, perks) {
  if (ship.perks === perks) return;
  ship.perks = perks;
  refreshStats(ship);
}

/** The outpost index whose Shipyard `team` holds, or -1. */
export function shipyardOf(game, team) {
  const m = game.match;
  if (team === NO_TEAM || !(m.perks[team] & Perk.SHIPYARD)) return -1;
  return m.outposts.findIndex((o, i) => o.owner === team && game.terrain.outposts[i].perk === Perk.SHIPYARD);
}

/**
 * Where `player` should spawn, written to `out` ({x, y, vx, vy, angle}): on
 * their team's Shipyard if they hold one (landed on the outpost, riding along
 * with its planet), otherwise near their team's home in the open, away from
 * enemies. Teams' homes are diagonally opposite corners of the system, as far
 * apart as the torus allows. Returns null in free-for-all (spawn anywhere).
 */
export function spawnPoint(game, player, radius, out) {
  const team = player.team;
  if (team === NO_TEAM) return null;
  const yard = shipyardOf(game, team);
  if (yard >= 0 && starOf(game.planets)) {
    const planet = game.planets[game.terrain.outposts[yard].planet];
    nightSide(game.planets[0], planet, radius + 1, point);
    out.x = point.x;
    out.y = point.y;
    out.vx = planet.vx;
    out.vy = planet.vy;
    out.angle = Math.atan2(point.ny, point.nx);
    return out;
  }
  const star = starOf(game.planets);
  const cx = star ? star.x : WORLD_SIZE / 2;
  const cy = star ? star.y : WORLD_SIZE / 2;
  const side = team === 0 ? -1 : 1;
  const home = { x: cx + side * WORLD_SIZE * 0.25, y: cy + side * WORLD_SIZE * 0.25, radius: 650 };
  const spot = findOpenSpot(game, 900, 24, true, home, team);
  out.x = spot.x;
  out.y = spot.y;
  out.vx = 0;
  out.vy = 0;
  out.angle = Math.atan2(cy - spot.y, cx - spot.x); // facing the action
  return out;
}

/* Solar flares --------------------------------------------------------------------- */

/**
 * Schedules the next flare and announces it `FLARE.warning` ahead; while it
 * burns, scorches every ship and saucer in its wedge that no planet shades.
 */
function updateFlares(game) {
  const m = game.match;
  const star = starOf(game.planets);
  if (!star) return;
  const tick = game.tick;
  if (!m.flare && tick >= game.nextFlareTick - FLARE.warning) {
    m.flare = {
      angle: game.rng() * TAU,
      halfWidth: lerp(FLARE.halfWidth[0], FLARE.halfWidth[1], game.rng()),
      start: game.nextFlareTick,
      end: game.nextFlareTick + FLARE.duration,
    };
    m.version++;
  }
  const f = m.flare;
  if (!f) return;
  if (tick >= f.end) {
    m.flare = null;
    m.version++;
    game.nextFlareTick = tick + Math.round(lerp(FLARE.interval[0], FLARE.interval[1], game.rng()));
    return;
  }
  if (tick < f.start) return;
  for (const ship of game.ships) {
    if (!ship.dead && exposedToFlare(game.planets, f, ship.x, ship.y, FLARE.reach, FLARE.shadowMargin)) {
      damageShip(game, ship, FLARE.damage, null, KillCause.FLARE, star.x, star.y);
    }
  }
  for (const al of game.aliens) {
    if (!al.dead && exposedToFlare(game.planets, f, al.x, al.y, FLARE.reach, FLARE.shadowMargin)) damageAlien(game, al, FLARE.damage, null);
  }
}

/* Nebulae ------------------------------------------------------------------------------ */

/** A ship inside a nebula is hidden unless it fired, blasted or used an ability moments ago. */
function updateNebulae(game) {
  const nebulae = game.terrain.nebulae;
  for (const ship of game.ships) {
    if (ship.dead) continue;
    ship.hidden = game.tick >= ship.revealedUntil && nebulaAt(nebulae, ship.x, ship.y) !== null;
  }
}

/** True if `viewer` (a ship, or null for a spectator of `viewerTeam`) cannot see hidden ship `ship`. */
export function hiddenFrom(ship, viewer, viewerTeam) {
  if (!ship.hidden || (ship.team !== NO_TEAM && ship.team === viewerTeam)) return false;
  if (!viewer) return true;
  if (viewer === ship) return false;
  const dx = wrapDelta(ship.x - viewer.x, WORLD_SIZE);
  const dy = wrapDelta(ship.y - viewer.y, WORLD_SIZE);
  return dx * dx + dy * dy > NEBULA.reveal * NEBULA.reveal;
}
