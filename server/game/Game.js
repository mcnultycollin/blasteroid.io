/**
 * One authoritative game world. Advances in fixed ticks and exposes a small
 * API for the network layer (players, input, upgrades) plus an outbox of
 * notable events. It has no knowledge of sockets, so it can be driven
 * directly by tests, benchmarks and bots.
 */
import { KillCause, SNAPSHOT_INTERVAL, TEAM_COUNT, WORLD_SIZE } from '../../shared/constants.js';
import { createRng } from '../../shared/math.js';
import { CLASSES, CLASS_COUNT } from '../../shared/stats.js';
import { applyFieldEffects, updateFields, updateMedics } from './abilities.js';
import { updateAliens, collideAliens, maintainAliens } from './aliens.js';
import { maintainAsteroids, seedAsteroids, updateAsteroids } from './asteroids.js';
import { maintainBots, runBots } from './bots.js';
import { collideBullets, updateBullets } from './bullets.js';
import { killShip } from './combat.js';
import { IdPool } from './IdPool.js';
import { randomName } from './names.js';
import { applyPerks, generateTerrain, resetObjectives, spawnPoint, updateObjectives } from './objectives.js';
import { maintainPickups, updatePickups } from './pickups.js';
import { generateSolarSystem, maintainBelts, seedBelts, updateBodies } from './planets.js';
import { Player } from './Player.js';
import { chooseWeapon, collideShips, despawnShip, processShipInputs, updateShips, upgradeStat } from './ships.js';
import { spawnShip } from './spawning.js';
import { SpatialGrid } from './SpatialGrid.js';
import { createMatch, pickTeam, updateRound } from './teams.js';
import { FLARE, GRID_CELL, MOTHERSHIP, REWARD, SHIP } from './tuning.js';

const validClass = (c) => (Number.isInteger(c) && c >= 0 && c < CLASS_COUNT ? c : 0);
const spawnScratch = { x: 0, y: 0, vx: 0, vy: 0, angle: 0 };

export class Game {
  /**
   * `teams`: two teams fighting over outposts in rounds (the default), or a
   * free-for-all where everyone is on their own.
   */
  constructor({ seed = (Math.random() * 2 ** 32) >>> 0, botTarget = 0, teams = true } = {}) {
    this.seed = seed;
    this.rng = createRng(seed);
    this.botTarget = botTarget;
    this.tick = 0;
    this.entityIds = new IdPool(1, 0xfffe);
    this.playerIds = new IdPool(1, 0xfffe);
    this.ships = [];
    this.asteroids = [];
    this.bullets = [];
    this.aliens = [];
    this.pickups = [];
    this.lists = [this.ships, this.asteroids, this.bullets, this.aliens, this.pickups];
    this.players = new Map(); // id -> Player
    this.humanCount = 0;
    this.grid = new SpatialGrid(WORLD_SIZE, GRID_CELL);
    this.mothership = null;
    this.nextMothershipTick = MOTHERSHIP.firstDelay;
    this.nextBotCheck = 0;
    /** Notable events for the network layer to broadcast; it clears them after each tick. */
    this.outbox = { roster: [], rosterRemoved: [], kills: [], deaths: [], announcements: [] };
    /** The star and planets (see shared/gravity.js); posed for the current tick at the start of each step. */
    this.planets = generateSolarSystem(this.rng);
    /** Outposts and nebulae (see objectives.js); sent to clients once, in the welcome message. */
    this.terrain = generateTerrain(this);
    /** Teams, rounds, outpost control and solar flares, replicated whenever they change. */
    this.match = createMatch(teams ? TEAM_COUNT : 0, 0);
    resetObjectives(this);
    this.nextFlareTick = FLARE.firstDelay;
    /** Graviton singularities: all live ones, and those acting this tick. */
    this.fields = [];
    this.activeFields = [];
    this.nextFieldId = 0;
    /**
     * Recent visual effects (blasts) for the network layer to replicate. Each
     * is kept for exactly one snapshot interval, so every snapshot sees it once.
     */
    this.fx = [];
    seedAsteroids(this);
    seedBelts(this);
    this.rebuildGrid();
  }

  /* Players ----------------------------------------------------------------- */

  /** Registers a player on the smaller team. They have no ship until spawned (see requestSpawn). */
  addPlayer(name, isBot = false, shipClass = 0) {
    const id = this.playerIds.alloc();
    if (!id) return null;
    const player = new Player(id, name || randomName(this.rng), isBot, SHIP.maxCredits);
    player.team = pickTeam(this, isBot);
    player.shipClass = validClass(shipClass);
    this.players.set(id, player);
    if (!isBot) this.humanCount++;
    this.outbox.roster.push(player);
    return player;
  }

  renamePlayer(player, name) {
    if (!name || name === player.name) return;
    player.name = name;
    this.outbox.roster.push(player);
  }

  removePlayer(player) {
    if (player.removed) return;
    const ship = player.ship;
    if (ship) {
      // Disconnecting mid-fight counts as a death, so attackers keep their reward.
      if (ship.lastAttacker && this.tick - ship.lastAttackTick <= REWARD.assistWindow) {
        killShip(this, ship, null, KillCause.SHIP);
      } else {
        despawnShip(this, ship);
      }
    }
    this.players.delete(player.id);
    if (!player.isBot) this.humanCount--;
    this.playerIds.release(player.id);
    this.outbox.rosterRemoved.push(player.id);
    player.removed = true;
  }

  /** Spawns the player as soon as their respawn delay allows, as `shipClass` if given. */
  requestSpawn(player, shipClass) {
    if (player.ship) return;
    player.wantsSpawn = true;
    if (shipClass !== undefined && validClass(shipClass) !== player.shipClass) {
      player.shipClass = validClass(shipClass);
      this.outbox.roster.push(player); // everyone draws the new hull
    }
  }

  /**
   * Queues one input command. Commands must arrive with increasing sequence
   * numbers; anything stale, duplicated or sent while dead is dropped.
   */
  queueInput(player, seq, buttons, aim) {
    if (!player.ship || seq <= player.lastInputSeq) return;
    player.lastInputSeq = seq;
    player.inputs.push(seq, buttons, aim);
  }

  upgrade(player, stat) {
    return upgradeStat(player.ship, stat);
  }

  chooseWeapon(player, weapon) {
    return chooseWeapon(player.ship, weapon);
  }

  /* Simulation -------------------------------------------------------------- */

  step() {
    this.tick++;
    updateBodies(this);
    this.pruneEffects();
    updateFields(this);
    this.spawnWaitingPlayers();
    runBots(this);
    processShipInputs(this);
    updateShips(this);
    updateMedics(this);
    updateAliens(this);
    updateAsteroids(this);
    updateBullets(this);
    updatePickups(this);
    this.rebuildGrid();
    collideBullets(this);
    collideShips(this);
    collideAliens(this);
    applyFieldEffects(this);
    updateObjectives(this);
    updateRound(this, resetObjectives);
    maintainAsteroids(this);
    maintainBelts(this);
    maintainAliens(this);
    maintainPickups(this);
    maintainBots(this);
    this.sweep();
  }

  spawnWaitingPlayers() {
    for (const player of this.players.values()) {
      if (player.wantsSpawn && !player.ship && this.tick >= player.respawnTick) {
        player.wantsSpawn = false;
        player.inputs.clear();
        player.credits = 0;
        player.timeAnchored = false;
        const ship = spawnShip(this, player, spawnPoint(this, player, CLASSES[player.shipClass].radius, spawnScratch));
        if (ship && player.team >= 0 && this.match.perks[player.team]) {
          applyPerks(ship, this.match.perks[player.team]);
          ship.hp = ship.maxHp;
          ship.energy = ship.st.energyMax;
        }
      }
    }
  }

  pruneEffects() {
    const fx = this.fx;
    let n = 0;
    for (let i = 0; i < fx.length; i++) if (fx[i].tick > this.tick - SNAPSHOT_INTERVAL) fx[n++] = fx[i];
    fx.length = n;
  }

  /** Registers a new entity: assigns an id and makes it visible to grid queries immediately. */
  add(list, e) {
    e.id = this.entityIds.alloc();
    if (!e.id) return null;
    list.push(e);
    this.grid.insert(e);
    return e;
  }

  rebuildGrid() {
    const grid = this.grid;
    grid.clear();
    for (const list of this.lists) {
      for (let i = 0; i < list.length; i++) if (!list[i].dead) grid.insert(list[i]);
    }
  }

  /** Drops dead entities from the lists (swap-remove) and recycles their ids. */
  sweep() {
    for (const list of this.lists) {
      for (let i = list.length - 1; i >= 0; i--) {
        const e = list[i];
        if (!e.dead) continue;
        const last = list.pop();
        if (i < list.length) list[i] = last;
        this.entityIds.release(e.id);
      }
    }
  }

  /* Queries ------------------------------------------------------------------ */

  liveShipCount() {
    return this.ships.length;
  }

  /** Live ships sorted by score, highest first. */
  rankedShips() {
    return this.ships.filter((s) => !s.dead).sort((a, b) => b.score - a.score || a.spawnTick - b.spawnTick);
  }

  clearOutbox() {
    const o = this.outbox;
    o.roster.length = 0;
    o.rosterRemoved.length = 0;
    o.kills.length = 0;
    o.deaths.length = 0;
    o.announcements.length = 0;
  }
}
