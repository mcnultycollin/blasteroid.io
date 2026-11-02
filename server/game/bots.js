/**
 * Server-side bots that keep small rooms lively. Bots are ordinary players
 * whose commands come from a BotBrain instead of a socket, so they exercise
 * exactly the same movement, firing, ability and upgrade code as humans.
 *
 * In team games they play the objectives: they fight enemies they can see,
 * capture and defend outposts, shelter from solar flares behind planets, heal
 * teammates (Medics) and use their class abilities. They watch their fuel:
 * running low, they grab fuel cells, hover in a friendly outpost or land on
 * a planet to refuel.
 */
import { Button, EntityType, NO_TEAM, OUTPOST_RADIUS, PickupKind, RoundPhase, TICK_RATE, WORLD_SIZE } from '../../shared/constants.js';
import { isStar } from '../../shared/gravity.js';
import { TAU, angleDiff, clamp, interceptTime, lerp, normalizeAngle, wrapDelta } from '../../shared/math.js';
import { exposedToFlare, nightSide, starOf } from '../../shared/terrain.js';
import { Ability, CLASS_COUNT, SINGULARITY, STAT_MAX, Stat, WEAPON_CHOICES } from '../../shared/stats.js';
import { Mask } from './entities.js';
import { randomName } from './names.js';
import { hiddenFrom, outpostPoint } from './objectives.js';
import { chooseWeapon, upgradeStat } from './ships.js';
import { allies, teamSizes } from './teams.js';
import { ABILITY, BOT, FLARE } from './tuning.js';

const spot = { x: 0, y: 0, nx: 0, ny: 0 };

const nearby = [];
const SENSE = Mask.SHIP | Mask.ALIEN | Mask.ASTEROID | Mask.PICKUP;

/** Stat priority lists; each bot follows one, so builds vary. */
const BUILDS = [
  [Stat.RELOAD, Stat.DAMAGE, Stat.VELOCITY, Stat.HULL, Stat.ENGINE, Stat.REPAIR, Stat.HANDLING, Stat.ENERGY],
  [Stat.HULL, Stat.REPAIR, Stat.DAMAGE, Stat.RELOAD, Stat.ENGINE, Stat.HANDLING, Stat.VELOCITY, Stat.ENERGY],
  [Stat.ENGINE, Stat.HANDLING, Stat.RELOAD, Stat.DAMAGE, Stat.ENERGY, Stat.HULL, Stat.VELOCITY, Stat.REPAIR],
];

const Mode = Object.freeze({ WANDER: 0, FARM: 1, FIGHT: 2, FLEE: 3, LOOT: 4, OBJECTIVE: 5, HEAL: 6, REFUEL: 7 });
const REFUEL_BELOW = 0.22; // share of the tank at which a bot heads off to refuel...
const REFUEL_UNTIL = 0.9; // ...and how full it gets before leaving
const LANDING_SPEED = 45; // relative speed for a gentle touchdown

/** Draws a ship class from BOT.classWeights. */
export function drawClass(rng) {
  let roll = rng();
  for (let c = 0; c < CLASS_COUNT; c++) {
    if (roll < BOT.classWeights[c]) return c;
    roll -= BOT.classWeights[c];
  }
  return 0;
}

/** Draws a skill from BOT.skillTiers. */
export function drawSkill(rng) {
  let roll = rng();
  for (const tier of BOT.skillTiers) {
    if (roll < tier.share) return lerp(tier.skill[0], tier.skill[1], rng());
    roll -= tier.share;
  }
  const top = BOT.skillTiers.at(-1).skill;
  return lerp(top[0], top[1], rng());
}

export class BotBrain {
  /** `skill`: 0 = hopeless, 1 = sharp. */
  constructor(rng, skill = drawSkill(rng)) {
    this.rng = rng;
    this.skill = skill;
    // From skill 0.5 up these match the original bots; below it each one degrades.
    const rookie = Math.max(0, 0.5 - skill); // 0 for skilled bots, up to 0.5
    this.aimJitter = (1 - skill) * 0.3 + rookie * 0.35; // radians of aim wobble
    this.reaction = Math.round((1 - skill) * 20 + rookie * 50); // ticks before firing at a new target
    this.leadAccuracy = Math.min(1, 0.4 + skill * 1.2); // share of a moving target's motion they lead
    this.aggroRange = Math.min(850, 450 + skill * 800); // how far away they pick fights with ships
    this.burstTicks = Math.round(30 + skill * 60); // rookies fire in bursts...
    this.pauseTicks = Math.round(rookie * 160); // ...with breathers between them
    this.burstPhase = Math.floor(rng() * 1000);
    // Regulars and aces fly with every thruster (strafing while they aim) and
    // use the kinetic blast; rookies can only turn, burn and brake.
    this.thrusters = skill >= 0.35;
    this.blaster = skill >= 0.35;
    this.paceMatch = 0.3 + skill * 0.7; // how well they keep pace with a moving target
    this.circleDir = rng() < 0.5 ? -1 : 1;
    this.blastAfter = 0;
    this.abilityAfter = 0;
    this.objectiveBias = 0.3 + rng() * 0.7; // how much they care about outposts over farming
    this.objective = -1; // outpost index while playing the objective
    this.shelter = null; // planet to hide behind during a solar flare
    this.depot = null; // where to refuel (this.depotChoice), or null
    this.depotChoice = { outpost: -1, planet: null };
    this.build = BUILDS[Math.floor(rng() * BUILDS.length)];
    this.mode = Mode.WANDER;
    this.target = null;
    this.danger = null;
    this.planet = null;
    this.wanderAngle = rng() * TAU;
    this.noise = 0;
    this.noiseTarget = 0;
    this.fireAfter = 0;
    this.seq = 0;
    this.buttons = 0;
    this.aim = 0;
  }

  /** Queues exactly one command for this tick, like a human client would. */
  update(game, player, ship) {
    const thinking = (game.tick + player.id) % BOT.thinkInterval === 0;
    if (thinking) this.think(game, ship);
    this.act(game, ship, thinking);
    this.seq++;
    player.lastInputSeq = this.seq;
    player.inputs.push(this.seq, this.buttons, this.aim);
  }

  think(game, ship) {
    nearby.length = 0;
    game.grid.query(ship.x, ship.y, 950, 950, SENSE, nearby);
    let enemy = null;
    let enemyDist = Infinity;
    let rock = null;
    let rockScore = Infinity;
    let loot = null;
    let lootDist = Infinity;
    let danger = null;
    let dangerDist = Infinity;
    let patient = null;
    let patientNeed = 0.8; // Medics patch up teammates below 80% hull
    for (const e of nearby) {
      if (e === ship) continue;
      const dist = Math.hypot(wrapDelta(e.x - ship.x, WORLD_SIZE), wrapDelta(e.y - ship.y, WORLD_SIZE));
      switch (e.type) {
        case EntityType.SHIP:
          if (allies(e, ship)) {
            const need = e.hp / e.maxHp;
            if (ship.st.ability === Ability.PULSE && dist < 700 && need < patientNeed) {
              patient = e;
              patientNeed = need;
            }
          } else if (e.invuln === 0 && !e.player.stealth && !hiddenFrom(e, ship, ship.team) && dist < this.aggroRange && dist < enemyDist) {
            enemy = e;
            enemyDist = dist;
          }
          break;
        case EntityType.ALIEN:
          if (dist < 700 && dist < enemyDist) {
            enemy = e;
            enemyDist = dist;
          }
          break;
        case EntityType.ASTEROID: {
          const score = dist * (1 + e.size * 0.3);
          if (dist < 800 && score < rockScore) {
            rock = e;
            rockScore = score;
          }
          if (dist - e.radius < dangerDist) {
            danger = e;
            dangerDist = dist - e.radius;
          }
          break;
        }
        case EntityType.PICKUP: {
          // Fuel cells are worth a detour when the tank is getting low.
          const reach = e.kind === PickupKind.FUEL && ship.fuel < ship.st.fuelMax * 0.5 ? 900 : 500;
          if (dist < reach && dist < lootDist) {
            loot = e;
            lootDist = dist;
          }
          break;
        }
      }
    }

    const objective = this.pickObjective(game, ship);
    const fuel = ship.fuel / ship.st.fuelMax;
    const refuel = (this.mode === Mode.REFUEL ? fuel < REFUEL_UNTIL : fuel < REFUEL_BELOW) && !(enemy && enemyDist < 350);
    if (enemy && ship.hp < ship.maxHp * 0.3 && this.skill > 0.4) this.setMode(game, Mode.FLEE, enemy);
    else if (refuel && loot && loot.kind === PickupKind.FUEL) this.setMode(game, Mode.LOOT, loot);
    else if (refuel && (this.depot = this.findDepot(game, ship))) this.setMode(game, Mode.REFUEL, null);
    else if (patient && (!enemy || patientNeed < 0.45)) this.setMode(game, Mode.HEAL, patient);
    else if (enemy) this.setMode(game, Mode.FIGHT, enemy);
    else if (loot) this.setMode(game, Mode.LOOT, loot);
    else if (objective >= 0 && (!rock || this.rng() < this.objectiveBias)) {
      this.setMode(game, Mode.OBJECTIVE, null);
      this.objective = objective;
    } else if (rock) this.setMode(game, Mode.FARM, rock);
    else {
      this.setMode(game, Mode.WANDER, null);
      this.wanderAngle += (this.rng() - 0.5) * 0.8;
    }
    this.shelter = this.findShelter(game, ship);
    this.danger = dangerDist < 150 ? danger : null;
    // The body whose surface is closest, if any is near: the star needs a wider berth.
    this.planet = null;
    let nearest = Infinity;
    for (const p of game.planets) {
      const gap = Math.hypot(wrapDelta(p.x - ship.x, WORLD_SIZE), wrapDelta(p.y - ship.y, WORLD_SIZE)) - p.radius;
      if (gap < (isStar(p) ? 420 : 260) && gap < nearest) {
        nearest = gap;
        this.planet = p;
      }
    }
    this.noiseTarget = (this.rng() * 2 - 1) * this.aimJitter;

    while (ship.points > 0) {
      const stat = this.build.find((s) => ship.statLevels[s] < STAT_MAX);
      if (stat === undefined || !upgradeStat(ship, stat)) break;
    }
    if (ship.weaponChoice) chooseWeapon(ship, WEAPON_CHOICES[Math.floor(this.rng() * WEAPON_CHOICES.length)]);
  }

  /**
   * The outpost worth flying to: our own if the enemy is taking it, otherwise
   * the nearest one we do not hold. -1 outside team rounds.
   */
  pickObjective(game, ship) {
    const m = game.match;
    if (!m.teams || ship.team === NO_TEAM || m.phase !== RoundPhase.PLAYING) return -1;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < m.outposts.length; i++) {
      const o = m.outposts[i];
      const ours = o.owner === ship.team;
      const threatened = ours && (o.contested || (ship.team === 0 ? o.progress > -1 : o.progress < 1));
      if (ours && !threatened) continue;
      const p = outpostPoint(game, i, spot);
      let score = Math.hypot(wrapDelta(p.x - ship.x, WORLD_SIZE), wrapDelta(p.y - ship.y, WORLD_SIZE));
      if (threatened) score *= 0.5; // defending comes first
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  /**
   * Where to refuel: the nearest outpost our team holds (hovering in its zone
   * refuels), otherwise the nearest planet gentle enough to land on.
   */
  findDepot(game, ship) {
    const m = game.match;
    const choice = this.depotChoice;
    let found = false;
    let bestDist = Infinity;
    for (let i = 0; i < m.outposts.length; i++) {
      if (m.outposts[i].owner !== ship.team || ship.team === NO_TEAM) continue;
      const p = outpostPoint(game, i, spot);
      const d = Math.hypot(wrapDelta(p.x - ship.x, WORLD_SIZE), wrapDelta(p.y - ship.y, WORLD_SIZE));
      if (d < bestDist) {
        bestDist = d;
        choice.outpost = i;
        choice.planet = null;
        found = true;
      }
    }
    for (const p of game.planets) {
      if (isStar(p) || p.surfacePull > ship.st.thrust * 0.85) continue; // too steep to land on safely
      const d = (Math.hypot(wrapDelta(p.x - ship.x, WORLD_SIZE), wrapDelta(p.y - ship.y, WORLD_SIZE)) - p.radius) * 1.3; // outposts first
      if (d < bestDist) {
        bestDist = d;
        choice.outpost = -1;
        choice.planet = p;
        found = true;
      }
    }
    return found ? choice : null;
  }

  /** During a flare warning: the planet whose shadow to hide in, if we are exposed. */
  findShelter(game, ship) {
    const f = game.match.flare;
    if (!f || game.tick < f.start - FLARE.warning || !exposedToFlare(game.planets, f, ship.x, ship.y, FLARE.reach + 300, -10)) return null;
    let best = null;
    let bestDist = Infinity;
    for (const p of game.planets) {
      if (isStar(p)) continue;
      const d = Math.hypot(wrapDelta(p.x - ship.x, WORLD_SIZE), wrapDelta(p.y - ship.y, WORLD_SIZE));
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  setMode(game, mode, target) {
    if (target !== this.target) this.fireAfter = game.tick + this.reaction;
    this.mode = mode;
    this.target = target;
  }

  /**
   * Turns the current plan into buttons. Space has no drag, so movement is a
   * velocity controller: each mode picks a desired velocity and steer() fires
   * whichever thrusters close the gap, while the nose aims at the target.
   */
  act(game, ship, thinking = true) {
    let buttons = Button.AIM;
    let aim = ship.angle;
    let free = true; // no target needs the nose, so it can point where thrust is needed
    let boost = false;
    let vx = 0; // desired velocity
    let vy = 0;
    const t = this.target;
    if (t && (t.dead || (t.type === EntityType.SHIP && (t.player.stealth || (!allies(t, ship) && hiddenFrom(t, ship, ship.team)))))) {
      this.target = null;
      this.mode = Mode.WANDER;
    }
    this.noise += (this.noiseTarget - this.noise) * 0.1;

    if (this.target) {
      const dx = wrapDelta(t.x - ship.x, WORLD_SIZE);
      const dy = wrapDelta(t.y - ship.y, WORLD_SIZE);
      const dist = Math.hypot(dx, dy) || 1;
      const ux = dx / dist;
      const uy = dy / dist;
      switch (this.mode) {
        case Mode.FIGHT:
        case Mode.FARM: {
          // Projectiles inherit our velocity, so lead the target's motion relative to us.
          const rvx = t.vx - ship.vx;
          const rvy = t.vy - ship.vy;
          const lead = Math.max(0, interceptTime(dx, dy, rvx, rvy, ship.st.bulletSpeed)) * this.leadAccuracy;
          aim = Math.atan2(dy + rvy * lead, dx + rvx * lead) + this.noise;
          free = false;
          const range = (ship.st.bulletSpeed * ship.st.bulletLife) / TICK_RATE;
          const tolerance = 0.1 + t.radius / dist;
          const triggerReady = this.pauseTicks === 0 || (game.tick + this.burstPhase) % (this.burstTicks + this.pauseTicks) < this.burstTicks;
          if (triggerReady && game.tick >= this.fireAfter && dist < range * 0.95 && Math.abs(angleDiff(aim, ship.angle)) < tolerance) {
            buttons |= Button.FIRE;
          }
          // Hold the preferred distance, keep pace with the target and, with
          // lateral thrusters, circle it to be harder to hit.
          const preferred = this.mode === Mode.FIGHT ? 380 + (1 - this.skill) * 160 : 240 + t.radius;
          const radial = clamp((dist - preferred) * 1.6, -320, 320);
          vx = ux * radial + t.vx * this.paceMatch;
          vy = uy * radial + t.vy * this.paceMatch;
          if (this.mode === Mode.FIGHT && this.thrusters) {
            const circle = this.circleDir * (90 + this.skill * 170);
            vx -= uy * circle;
            vy += ux * circle;
          }
          if (this.mode === Mode.FIGHT && dist > 650 && ship.energy > ship.st.energyMax * 0.6) boost = true;
          // Shove an enemy that strays close to a planet or the star into it.
          if (this.mode === Mode.FIGHT && t.type === EntityType.SHIP && dist < 300 && nearSurface(game, t, 240)) {
            buttons |= this.blast(game, ship, Math.atan2(dy, dx));
          }
          break;
        }
        case Mode.FLEE:
          aim = Math.atan2(-dy, -dx) + this.noise;
          vx = -ux * ship.st.boostSpeed;
          vy = -uy * ship.st.boostSpeed;
          boost = true;
          break;
        case Mode.LOOT: {
          const speed = Math.min(380, dist * 2.2); // arrive rather than overshoot
          vx = ux * speed;
          vy = uy * speed;
          break;
        }
        case Mode.HEAL: {
          // Medics repair with their shots: aim at the teammate from a short distance.
          aim = Math.atan2(dy + (t.vy - ship.vy) * 0.2, dx + (t.vx - ship.vx) * 0.2);
          free = false;
          if (dist < 600 && Math.abs(angleDiff(aim, ship.angle)) < 0.15) buttons |= Button.FIRE;
          const radial = clamp((dist - 240) * 1.5, -250, 250);
          vx = ux * radial + t.vx;
          vy = uy * radial + t.vy;
          break;
        }
      }
    } else if (this.mode === Mode.REFUEL && this.depot?.planet) {
      // Land gently on the planet, then sit there (riding along with it) while the tank fills.
      const planet = this.depot.planet;
      const dx = wrapDelta(planet.x - ship.x, WORLD_SIZE);
      const dy = wrapDelta(planet.y - ship.y, WORLD_SIZE);
      const dist = Math.hypot(dx, dy) || 1;
      const gap = dist - planet.radius - ship.radius;
      const speed = ship.contactBody === planet.id ? 0 : gap < 140 ? LANDING_SPEED : Math.min(300, gap * 1.3);
      vx = planet.vx + (dx / dist) * speed;
      vy = planet.vy + (dy / dist) * speed;
    } else if ((this.mode === Mode.OBJECTIVE || this.mode === Mode.REFUEL) && this.holdIndex() >= 0) {
      // Hold position in the capture zone, moving with the outpost's planet.
      const index = this.holdIndex();
      const p = outpostPoint(game, index, spot);
      const planet = game.planets[game.terrain.outposts[index].planet];
      const dx = wrapDelta(p.x + p.nx * 70 - ship.x, WORLD_SIZE);
      const dy = wrapDelta(p.y + p.ny * 70 - ship.y, WORLD_SIZE);
      const dist = Math.hypot(dx, dy) || 1;
      const speed = Math.min(360, dist * 1.4);
      vx = planet.vx + (dx / dist) * speed;
      vy = planet.vy + (dy / dist) * speed;
      if (dist > 1600 && ship.energy > ship.st.energyMax * 0.7) boost = true;
      if (dist < OUTPOST_RADIUS) aim = Math.atan2(p.ny, p.nx); // face out of the zone, towards attackers
    } else {
      vx = Math.cos(this.wanderAngle) * 220;
      vy = Math.sin(this.wanderAngle) * 220;
    }
    if (thinking) buttons |= this.ability(game, ship); // the checks scan nearby ships, so not every tick

    // A solar flare is coming and we are in the open: get behind the nearest planet.
    const shelter = this.shelter;
    if (shelter) {
      nightSide(starOf(game.planets), shelter, 110, spot);
      const dx = wrapDelta(spot.x - ship.x, WORLD_SIZE);
      const dy = wrapDelta(spot.y - ship.y, WORLD_SIZE);
      const dist = Math.hypot(dx, dy) || 1;
      const speed = Math.min(ship.st.boostSpeed, dist * 1.6);
      vx = shelter.vx + (dx / dist) * speed;
      vy = shelter.vy + (dy / dist) * speed;
      boost = dist > 500;
    }

    // Get out of the way of a rock about to hit us, or blast it aside.
    const d = this.danger;
    if (d && !d.dead) {
      const dx = wrapDelta(d.x - ship.x, WORLD_SIZE);
      const dy = wrapDelta(d.y - ship.y, WORLD_SIZE);
      const dist = Math.hypot(dx, dy) || 1;
      const closing = ((ship.vx - d.vx) * dx + (ship.vy - d.vy) * dy) / dist;
      if (dist < d.radius + ship.radius + 70 + Math.max(0, closing) * 0.3) {
        vx = d.vx - (dx / dist) * 300;
        vy = d.vy - (dy / dist) * 300;
        boost = false;
        if (!this.thrusters) free = true; // rookies have to turn away to dodge
        if (closing > 60) buttons |= this.blast(game, ship, Math.atan2(dy, dx));
      }
    }
    // Pull up before hitting a planet or the star: gravity makes a dive hard to
    // recover from, the more so the harder the body pulls. (Not while landing on it.)
    const p = this.planet;
    if (p && !(this.mode === Mode.REFUEL && this.depot?.planet === p)) {
      const dx = wrapDelta(p.x - ship.x, WORLD_SIZE);
      const dy = wrapDelta(p.y - ship.y, WORLD_SIZE);
      const dist = Math.hypot(dx, dy) || 1;
      const closing = ((ship.vx - p.vx) * dx + (ship.vy - p.vy) * dy) / dist;
      const star = isStar(p);
      const steep = p.surfacePull / ship.st.thrust; // above 1, only a boost climbs out
      const margin = star ? 220 + Math.max(0, closing) * 0.6 : 70 + 140 * steep + Math.max(0, closing) * 0.5;
      if (dist - p.radius < margin) {
        const away = 240 + Math.max(0, closing);
        vx = p.vx - (dx / dist) * away;
        vy = p.vy - (dy / dist) * away;
        free = true;
        boost = star || closing > 150 || steep > 1;
      }
    }
    if (free) {
      // Nothing needs the nose, so point it where thrust is needed.
      const ex = vx - ship.vx;
      const ey = vy - ship.vy;
      if (ex * ex + ey * ey > 40 * 40) aim = Math.atan2(ey, ex);
    }
    this.buttons = this.steer(ship, vx, vy, buttons, boost);
    this.aim = normalizeAngle(aim);
  }

  /**
   * Fires whichever thrusters move the ship's velocity towards (vx, vy).
   * With full thruster control the ship strafes while its nose aims
   * elsewhere; rookies can only burn forwards and brake.
   */
  steer(ship, vx, vy, buttons, boost) {
    const ex = vx - ship.vx;
    const ey = vy - ship.vy;
    const err = Math.hypot(ex, ey);
    // Small errors aren't worth the fuel, and less so as the tank empties.
    if (err < 20 + 60 * (1 - ship.fuel / ship.st.fuelMax)) return buttons;
    const ca = Math.cos(ship.angle);
    const sa = Math.sin(ship.angle);
    const ahead = (ex * ca + ey * sa) / err; // cosine between the nose and the needed change
    const speed = Math.hypot(ship.vx, ship.vy);
    if (speed > 40 && ex * ship.vx + ey * ship.vy < -0.85 * err * speed) {
      return buttons | Button.BRAKE; // wanted: (much) less of the current motion
    }
    if (boost && ahead > 0.8 && !ship.boostLock && ship.energy > 0) return buttons | Button.BOOST;
    if (!this.thrusters) return ahead > 0.7 ? buttons | Button.THRUST : buttons;
    // Screen-direction thrusters push straight towards the needed change, whatever the nose does.
    if (ex > err * 0.38) buttons |= Button.MOVE_RIGHT;
    else if (ex < -err * 0.38) buttons |= Button.MOVE_LEFT;
    if (ey > err * 0.38) buttons |= Button.MOVE_DOWN;
    else if (ey < -err * 0.38) buttons |= Button.MOVE_UP;
    return buttons;
  }

  /** The outpost to hold: the objective, or the friendly outpost we refuel at. */
  holdIndex() {
    if (this.mode === Mode.OBJECTIVE) return this.objective;
    return this.mode === Mode.REFUEL && this.depot && this.depot.outpost >= 0 ? this.depot.outpost : -1;
  }

  /**
   * The ABILITY button when the class ability would pay off right now.
   * Skilled bots take nearly every good chance; rookies hesitate and miss some.
   */
  ability(game, ship) {
    if (game.tick < this.abilityAfter || ship.abilityCooldown > 0 || ship.energy < ship.st.abilityCost + 30) return 0;
    const t = this.target;
    const enemy = t && !t.dead && this.mode === Mode.FIGHT ? t : null;
    let use = false;
    switch (ship.st.ability) {
      case Ability.DASH: // dodge sideways when an enemy is close
        use = enemy !== null && dist(ship, enemy) < 320 && this.rng() < 0.04;
        break;
      case Ability.RAM: {
        // Charge an enemy or a big rock roughly dead ahead.
        const prey = enemy ?? (this.mode === Mode.FARM && t && !t.dead && t.size === 2 ? t : null);
        if (prey) {
          const a = Math.atan2(wrapDelta(prey.y - ship.y, WORLD_SIZE), wrapDelta(prey.x - ship.x, WORLD_SIZE));
          use = dist(ship, prey) < 620 && Math.abs(angleDiff(a, ship.angle)) < 0.3;
        }
        break;
      }
      case Ability.PULSE: {
        // Worth it once enough hull is missing around us (our own counts half).
        let missing = (ship.maxHp - ship.hp) * 0.5;
        for (const other of game.ships) {
          if (other !== ship && !other.dead && allies(other, ship) && dist(ship, other) < ABILITY.pulseRange) missing += other.maxHp - other.hp;
        }
        use = missing >= 50;
        break;
      }
      case Ability.SINGULARITY: {
        // Drop it where it catches enemies: one close to the spot, or two around it.
        const px = ship.x + Math.cos(ship.angle) * SINGULARITY.distance;
        const py = ship.y + Math.sin(ship.angle) * SINGULARITY.distance;
        let caught = 0;
        for (const other of game.ships) {
          if (other.dead || other === ship || allies(other, ship)) continue;
          const d = Math.hypot(wrapDelta(other.x - px, WORLD_SIZE), wrapDelta(other.y - py, WORLD_SIZE));
          if (d < 260) caught += 2;
          else if (d < SINGULARITY.range * 0.8) caught++;
        }
        use = caught >= 2;
        break;
      }
    }
    if (!use) return 0;
    this.abilityAfter = game.tick + Math.round(TICK_RATE * (2.5 - 2 * this.skill));
    if (this.rng() > 0.35 + this.skill) return 0; // hesitated
    let buttons = Button.ABILITY;
    if (ship.st.ability === Ability.DASH) {
      // Dodge sideways relative to the threat: the afterburner kicks towards the held screen thruster.
      const a = ship.angle + (this.rng() < 0.5 ? -1 : 1) * (Math.PI / 2);
      buttons |= Math.abs(Math.cos(a)) > Math.abs(Math.sin(a)) ? (Math.cos(a) > 0 ? Button.MOVE_RIGHT : Button.MOVE_LEFT) : Math.sin(a) > 0 ? Button.MOVE_DOWN : Button.MOVE_UP;
    }
    return buttons;
  }

  /** The BLAST button, if this bot uses blasts, the nose points at `angle` and it can afford one. */
  blast(game, ship, angle) {
    if (!this.blaster || game.tick < this.blastAfter || ship.blastCooldown > 0) return 0;
    if (ship.energy < ship.st.blastCost + 60 || Math.abs(angleDiff(angle, ship.angle)) > 0.35) return 0;
    this.blastAfter = game.tick + Math.round(TICK_RATE * (3 - this.skill * 1.5));
    return Button.BLAST;
  }
}

const dist = (a, b) => Math.hypot(wrapDelta(a.x - b.x, WORLD_SIZE), wrapDelta(a.y - b.y, WORLD_SIZE));

/** True if `e` is within `margin` of a planet's or the star's surface. */
function nearSurface(game, e, margin) {
  for (const p of game.planets) {
    const reach = p.radius + margin;
    const dx = wrapDelta(p.x - e.x, WORLD_SIZE);
    const dy = wrapDelta(p.y - e.y, WORLD_SIZE);
    if (dx * dx + dy * dy < reach * reach) return true;
  }
  return false;
}

/** Runs every bot brain, queues respawns and lets retiring bots leave unseen. */
export function runBots(game) {
  for (const player of game.players.values()) {
    if (!player.isBot) continue;
    const ship = player.ship;
    if (player.retiring && (!ship || !nearAnotherShip(game, ship))) {
      game.removePlayer(player);
    } else if (ship) {
      player.brain.update(game, player, ship);
    } else if (!player.wantsSpawn) {
      const [min, max] = BOT.respawnDelay;
      player.wantsSpawn = true;
      player.respawnTick = Math.max(player.respawnTick, game.tick + min + Math.floor(game.rng() * (max - min)));
    }
  }
}

function nearAnotherShip(game, ship) {
  const range = BOT.retireUnseenDistance;
  for (const other of game.ships) {
    if (other === ship || other.dead) continue;
    if (Math.abs(wrapDelta(other.x - ship.x, WORLD_SIZE)) < range && Math.abs(wrapDelta(other.y - ship.y, WORLD_SIZE)) < range) {
      return true;
    }
  }
  return false;
}

/**
 * Adds or removes bots so humans + bots meets the room's bot target. Missing
 * bots arrive together (a fresh room fills instantly). Surplus bots retire:
 * they leave when they die or when nobody is close enough to see them go.
 */
export function maintainBots(game) {
  if (game.tick < game.nextBotCheck) return;
  game.nextBotCheck = game.tick + BOT.manageEvery;
  let active = 0;
  let weakest = null;
  for (const p of game.players.values()) {
    if (!p.isBot || p.retiring) continue;
    active++;
    if (!weakest || (p.ship?.score ?? -1) < (weakest.ship?.score ?? -1)) weakest = p;
  }
  const wanted = Math.max(0, game.botTarget - game.humanCount);
  for (; active < wanted; active++) {
    const player = game.addPlayer(randomName(game.rng), true, drawClass(game.rng));
    if (!player) break;
    player.brain = new BotBrain(game.rng);
    player.wantsSpawn = true;
  }
  if (active > wanted) {
    // Retire the weakest bot, from the bigger team in team games, so teams stay even.
    const sizes = game.match.teams ? teamSizes(game) : null;
    const big = sizes ? (sizes[0] > sizes[1] ? 0 : sizes[1] > sizes[0] ? 1 : NO_TEAM) : NO_TEAM;
    let pick = null;
    for (const p of game.players.values()) {
      if (!p.isBot || p.retiring || (big !== NO_TEAM && p.team !== big)) continue;
      if (!pick || (p.ship?.score ?? -1) < (pick.ship?.score ?? -1)) pick = p;
    }
    (pick ?? weakest).retiring = true;
    return;
  }
  // Keep teams even: a bot on the bigger team retires and the next check adds one to the smaller.
  if (game.match.teams) {
    const sizes = teamSizes(game);
    const big = sizes[0] - sizes[1] >= 2 ? 0 : sizes[1] - sizes[0] >= 2 ? 1 : -1;
    if (big >= 0) {
      let pick = null;
      for (const p of game.players.values()) {
        if (p.isBot && !p.retiring && p.team === big && (!pick || (p.ship?.score ?? -1) < (pick.ship?.score ?? -1))) pick = p;
      }
      if (pick) pick.retiring = true;
    }
  }
}
