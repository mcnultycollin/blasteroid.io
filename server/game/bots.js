/**
 * Server-side bots that keep small rooms lively. Bots are ordinary players
 * whose commands come from a BotBrain instead of a socket, so they exercise
 * exactly the same movement, firing and upgrade code as humans.
 */
import { Button, EntityType, TICK_RATE, WORLD_SIZE } from '../../shared/constants.js';
import { TAU, angleDiff, interceptTime, normalizeAngle, wrapDelta } from '../../shared/math.js';
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

export class BotBrain {
  constructor(rng) {
    this.rng = rng;
    this.skill = 0.25 + rng() * 0.65; // 0 = hopeless, 1 = sharp
    this.aimJitter = (1 - this.skill) * 0.3;
    this.reaction = Math.round((1 - this.skill) * 20); // ticks before firing at a new target
    this.build = BUILDS[Math.floor(rng() * BUILDS.length)];
    this.mode = Mode.WANDER;
    this.target = null;
    this.danger = null;
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
          if (e.invuln === 0 && dist < 850 && dist < enemyDist) {
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
    this.danger = dangerDist < 110 ? danger : null;
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

  act(game, ship) {
    let buttons = Button.AIM;
    let aim = ship.angle;
    const t = this.target;
    if (t && t.dead) {
      this.target = null;
      this.mode = Mode.WANDER;
    }
    this.noise += (this.noiseTarget - this.noise) * 0.1;
    const speed = Math.hypot(ship.vx, ship.vy);

    if (this.target) {
      const dx = wrapDelta(t.x - ship.x, WORLD_SIZE);
      const dy = wrapDelta(t.y - ship.y, WORLD_SIZE);
      const dist = Math.hypot(dx, dy);
      switch (this.mode) {
        case Mode.FIGHT:
        case Mode.FARM: {
          // Projectiles inherit our velocity, so lead the target's motion relative to us.
          const rvx = t.vx - ship.vx;
          const rvy = t.vy - ship.vy;
          const time = interceptTime(dx, dy, rvx, rvy, ship.st.bulletSpeed);
          aim = (time > 0 ? Math.atan2(dy + rvy * time, dx + rvx * time) : Math.atan2(dy, dx)) + this.noise;
          const range = (ship.st.bulletSpeed * ship.st.bulletLife) / TICK_RATE;
          const tolerance = 0.1 + t.radius / Math.max(dist, 1);
          if (game.tick >= this.fireAfter && dist < range * 0.95 && Math.abs(angleDiff(aim, ship.angle)) < tolerance) {
            buttons |= Button.FIRE;
          }
          const preferred = this.mode === Mode.FIGHT ? 380 + (1 - this.skill) * 160 : 240 + t.radius;
          if (dist > preferred + 80) buttons |= Button.THRUST;
          else if (dist < preferred - 60 || speed > 420) buttons |= Button.BRAKE;
          if (this.mode === Mode.FIGHT && dist > 650 && ship.energy > ship.st.energyMax * 0.6) buttons |= Button.BOOST;
          break;
        }
        case Mode.FLEE:
          aim = Math.atan2(-dy, -dx) + this.noise;
          buttons |= Button.THRUST;
          if (!ship.boostLock && ship.energy > 0) buttons |= Button.BOOST;
          break;
        case Mode.LOOT:
          aim = Math.atan2(dy, dx);
          if (dist > 80 && speed < 380) buttons |= Button.THRUST;
          else if (speed > 250) buttons |= Button.BRAKE;
          break;
      }
    } else {
      aim = this.wanderAngle;
      if (speed < 220) buttons |= Button.THRUST;
    }

    const d = this.danger;
    if (d && !d.dead) {
      const dx = wrapDelta(d.x - ship.x, WORLD_SIZE);
      const dy = wrapDelta(d.y - ship.y, WORLD_SIZE);
      if (Math.hypot(dx, dy) < d.radius + ship.radius + 70) {
        aim = Math.atan2(-dy, -dx);
        buttons = (buttons & Button.FIRE) | Button.AIM | Button.THRUST;
      }
    }
    this.buttons = buttons;
    this.aim = normalizeAngle(aim);
  }
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
