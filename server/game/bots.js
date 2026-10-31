/**
 * Server-side bots that keep small rooms lively. Bots are ordinary players
 * whose commands come from a BotBrain instead of a socket, so they exercise
 * exactly the same movement, firing and upgrade code as humans.
 */
import { Button, EntityType, TICK_RATE, WORLD_SIZE } from '../../shared/constants.js';
import { isStar } from '../../shared/gravity.js';
import { TAU, angleDiff, clamp, interceptTime, lerp, normalizeAngle, wrapDelta } from '../../shared/math.js';
import { STAT_MAX, Stat, WEAPON_CHOICES } from '../../shared/stats.js';
import { Mask } from './entities.js';
import { randomName } from './names.js';
import { chooseWeapon, upgradeStat } from './ships.js';
import { BOT } from './tuning.js';

const nearby = [];
const SENSE = Mask.SHIP | Mask.ALIEN | Mask.ASTEROID | Mask.PICKUP;

/** Stat priority lists; each bot follows one, so builds vary. */
const BUILDS = [
  [Stat.RELOAD, Stat.DAMAGE, Stat.VELOCITY, Stat.HULL, Stat.ENGINE, Stat.REPAIR, Stat.HANDLING, Stat.ENERGY],
  [Stat.HULL, Stat.REPAIR, Stat.DAMAGE, Stat.RELOAD, Stat.ENGINE, Stat.HANDLING, Stat.VELOCITY, Stat.ENERGY],
  [Stat.ENGINE, Stat.HANDLING, Stat.RELOAD, Stat.DAMAGE, Stat.ENERGY, Stat.HULL, Stat.VELOCITY, Stat.REPAIR],
];

const Mode = Object.freeze({ WANDER: 0, FARM: 1, FIGHT: 2, FLEE: 3, LOOT: 4 });

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
    if ((game.tick + player.id) % BOT.thinkInterval === 0) this.think(game, ship);
    this.act(game, ship);
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
    for (const e of nearby) {
      if (e === ship) continue;
      const dist = Math.hypot(wrapDelta(e.x - ship.x, WORLD_SIZE), wrapDelta(e.y - ship.y, WORLD_SIZE));
      switch (e.type) {
        case EntityType.SHIP:
          if (e.invuln === 0 && !e.player.stealth && dist < this.aggroRange && dist < enemyDist) {
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
        case EntityType.PICKUP:
          if (dist < 500 && dist < lootDist) {
            loot = e;
            lootDist = dist;
          }
          break;
      }
    }

    if (enemy && ship.hp < ship.maxHp * 0.3 && this.skill > 0.4) this.setMode(game, Mode.FLEE, enemy);
    else if (enemy) this.setMode(game, Mode.FIGHT, enemy);
    else if (loot) this.setMode(game, Mode.LOOT, loot);
    else if (rock) this.setMode(game, Mode.FARM, rock);
    else {
      this.setMode(game, Mode.WANDER, null);
      this.wanderAngle += (this.rng() - 0.5) * 0.8;
    }
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
  act(game, ship) {
    let buttons = Button.AIM;
    let aim = ship.angle;
    let free = true; // no target needs the nose, so it can point where thrust is needed
    let boost = false;
    let vx = 0; // desired velocity
    let vy = 0;
    const t = this.target;
    if (t && (t.dead || (t.type === EntityType.SHIP && t.player.stealth))) {
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
      }
    } else {
      vx = Math.cos(this.wanderAngle) * 220;
      vy = Math.sin(this.wanderAngle) * 220;
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
    // Pull up before hitting a planet or the star: gravity makes a dive hard to recover from.
    const p = this.planet;
    if (p) {
      const dx = wrapDelta(p.x - ship.x, WORLD_SIZE);
      const dy = wrapDelta(p.y - ship.y, WORLD_SIZE);
      const dist = Math.hypot(dx, dy) || 1;
      const closing = ((ship.vx - p.vx) * dx + (ship.vy - p.vy) * dy) / dist;
      const star = isStar(p);
      const margin = (star ? 200 : 90) + Math.max(0, closing) * (star ? 0.6 : 0.45);
      if (dist - p.radius < margin) {
        const away = 240 + Math.max(0, closing);
        vx = p.vx - (dx / dist) * away;
        vy = p.vy - (dy / dist) * away;
        free = true;
        boost = star || closing > 150;
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
    if (err < 20) return buttons;
    const ca = Math.cos(ship.angle);
    const sa = Math.sin(ship.angle);
    const ahead = (ex * ca + ey * sa) / err; // cosine between the nose and the needed change
    const right = (ey * ca - ex * sa) / err;
    const speed = Math.hypot(ship.vx, ship.vy);
    if (speed > 40 && ex * ship.vx + ey * ship.vy < -0.85 * err * speed) {
      return buttons | Button.BRAKE; // wanted: (much) less of the current motion
    }
    if (boost && ahead > 0.8 && !ship.boostLock && ship.energy > 0) return buttons | Button.BOOST;
    if (!this.thrusters) return ahead > 0.7 ? buttons | Button.THRUST : buttons;
    if (ahead > 0.38) buttons |= Button.THRUST;
    else if (ahead < -0.38) buttons |= Button.BACK;
    if (right > 0.38) buttons |= Button.STRAFE_RIGHT;
    else if (right < -0.38) buttons |= Button.STRAFE_LEFT;
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
    const player = game.addPlayer(randomName(game.rng), true);
    if (!player) break;
    player.brain = new BotBrain(game.rng);
    player.wantsSpawn = true;
  }
  if (active > wanted && weakest) weakest.retiring = true;
}
