/**
 * Client entry point: wires networking, prediction, rendering, HUD, audio
 * and input together and runs the frame loop.
 *
 * Input is sampled and predicted in fixed 60 Hz steps (matching the server),
 * independent of the display refresh rate; rendering interpolates between the
 * last two predicted steps, so high-refresh displays stay smooth.
 */
import {
  AlienKind,
  Announce,
  BLAST_HALF_ANGLE,
  BLAST_RANGE,
  BodyKind,
  BulletKind,
  Button,
  EntityType,
  EventKind,
  Feature,
  FxKind,
  KickReason,
  KillCause,
  NO_TEAM,
  PROTOCOL_VERSION,
  Perk,
  PickupKind,
  RemoveReason,
  RoundPhase,
  ShipFlag,
  TICK_MS,
  TICK_RATE,
  WORLD_SIZE,
  isPowerup,
} from '../shared/constants.js';
import { clamp, wrapDelta, wrapLerp } from '../shared/math.js';
import { StepResult, computeShots } from '../shared/physics.js';
import { NO_ID, dqAngle, qAngle } from '../shared/protocol.js';
import { Ability, CLASSES, SINGULARITY, ShipClass, WEAPON_CHOICES, Weapon, viewScaleForLevel } from '../shared/stats.js';
import { Sound } from './audio.js';
import { Color, Effects, hueColor } from './effects.js';
import { FlightPath } from './flightpath.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Connection } from './net.js';
import { Predictor } from './prediction.js';
import { Renderer, playerColor } from './renderer.js';
import { MULTI_NAMES, STREAK_NAMES, StreakTracker } from './streaks.js';
import { Ui } from './ui.js';
import { ClientWorld, TEAM_NAMES } from './world.js';

const State = Object.freeze({ CONNECTING: 0, MENU: 1, PLAYING: 2, DEAD: 3 });
const MAX_STEPS_PER_FRAME = 8;
const DEATH_SCREEN_DELAY_MS = 1400;
const GREY = 'rgba(255,255,255,0.6)';
const POWERUP_NAMES = {
  [PickupKind.SHIELD]: ['SHIELD', '#5cf2ff'],
  [PickupKind.RAPID]: ['RAPID FIRE', '#ff8c42'],
  [PickupKind.REPAIR]: ['HULL REPAIRED', '#7dff6a'],
  [PickupKind.OVERDRIVE]: ['OVERDRIVE', '#ff5cf2'],
};
const PERK_TEXT = {
  [Perk.FORGE]: 'Forge: +15% weapon damage for your team',
  [Perk.REFINERY]: 'Refinery: +50% energy recharge for your team',
  [Perk.SHIPYARD]: 'Shipyard: your team respawns on this outpost',
};
const PULSE_RANGE = CLASSES[ShipClass.MEDIC].ability.range;
const LOW_FUEL = 0.2; // share of the tank that triggers the low-fuel warning
const WELL_LOOKAHEAD_S = 3; // the flight path is computed when a well is this many seconds away
const KICK_MESSAGES = {
  [KickReason.SERVER_FULL]: 'Server is full. Try again in a moment.',
  [KickReason.OUTDATED]: 'A new version is available. Refresh the page to play.',
  [KickReason.SHUTDOWN]: 'Server restarting. Reconnecting…',
  [KickReason.IDLE]: 'Disconnected for inactivity. Refresh to play again.',
  [KickReason.ABUSE]: 'Disconnected by the server.',
};

class GameClient {
  constructor() {
    this.canvas = document.getElementById('game');
    this.renderer = new Renderer(this.canvas);
    this.hud = new Hud();
    this.effects = new Effects();
    this.sound = new Sound();
    this.predictor = new Predictor();
    this.world = new ClientWorld(this.worldEvents());
    this.ui = new Ui({
      play: (name) => this.play(name),
      thrusterMode: (mode) => this.input?.setThrusterMode(mode),
    });
    this.input = new Input(this.canvas, this.inputActions());
    this.input.setThrusterMode(this.ui.thrusters);
    this.net = new Connection(this.netHandlers());

    this.state = State.CONNECTING;
    this.myPlayerId = NO_ID;
    this.self = null; // latest authoritative self block (hp, shield, energy, flags)
    this.stats = null; // latest stats block, plus receivedTick
    this.spectateFocus = { id: NO_ID, x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
    this.cam = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2, leadX: 0, leadY: 0 };
    this.selfView = {
      rx: 0, ry: 0, ra: 0, dx: 0, dy: 0, flags: 0, hpFrac: 1,
      playerId: NO_ID, level: 1, weapon: Weapon.BLASTER, hitFlash: 0, thrusters: 0,
    };
    this.shipScreen = { x: innerWidth / 2, y: innerHeight / 2 };
    this.flight = new FlightPath();
    this.lockView = { body: null, radius: 0, dir: 1 };
    this.reticleView = { x: 0, y: 0, ready: false, color: '#fff' };
    this.shots = [];
    this.acc = 0;
    this.last = performance.now();
    this.alpha = 0;
    this.fps = 60;
    this.deathTimer = 0;
    this.lastLevel = 0;
    this.hadWeaponChoice = false;
    this.debug = null; // netgraph data while F3 is toggled on
    this.devTools = false; // server allows testing aids (stealth)
    this.teams = false; // team rounds (vs free-for-all)
    this.trajectory = false; // full trajectory planner (T); otherwise the path shows only before a touchdown or crash
    this.streaks = new StreakTracker();
    this.fuelWarning = 0; // 0 fine, 1 low, 2 empty: the last fuel warning shown
    this.myTeam = NO_TEAM;
    this.flareBurned = -1; // start tick of the last flare whose burn we announced
    this.traffic = { at: performance.now(), bytes: 0, snapshots: 0, kbps: 0, snapshotsPerSecond: 0 };

    this.predictor.fields = this.world.gravityFields; // enemy singularities pull our ship too
    this.ui.setPlayEnabled(false);
    this.net.connect();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  /* Session flow -------------------------------------------------------------- */

  play(name) {
    this.sound.unlock();
    if (!this.net.isOpen || this.predictor.active) return;
    this.net.join(name, this.ui.shipClass());
    this.ui.setStatus('Launching…');
  }

  netHandlers() {
    return {
      open: () => {
        this.state = State.MENU;
        this.ui.hideToast();
        this.ui.hideDeath();
        this.ui.showMenu();
        this.ui.setPlayEnabled(true);
        this.ui.setStatus('');
      },
      close: () => {
        this.world.reset();
        this.streaks.clear(); // player ids are recycled: a new connection starts every streak afresh
        this.predictor.stop();
        this.input.enabled = false;
        this.state = State.CONNECTING;
        this.self = null;
        this.stats = null;
        this.hud.leaderboard = null;
        this.ui.setPlayEnabled(false);
        if (!this.net.stopped) this.ui.showToast('Connection lost. Reconnecting…');
      },
      welcome: (w) => {
        if (w.version !== PROTOCOL_VERSION) this.ui.showToast(KICK_MESSAGES[KickReason.OUTDATED]);
        this.devTools = (w.features & Feature.DEV_TOOLS) !== 0;
        this.ui.setDevTools(this.devTools);
        this.world.setBodies(w.bodies);
        this.world.setTerrain(w.nebulae, w.outposts);
        this.predictor.bodies = this.world.planets;
        this.teams = (w.features & Feature.TEAMS) !== 0;
        this.ui.setTeams(this.teams);
      },
      joined: (id) => {
        this.myPlayerId = id;
        this.setMyTeam(this.world.playerTeam(id));
      },
      snapshot: (reader) => this.world.applySnapshot(reader, performance.now()),
      roster: (list) => {
        for (const p of list) {
          this.world.setPlayer(p.id, p.name, p.team, p.shipClass);
          if (p.id === this.myPlayerId) this.setMyTeam(p.team);
        }
      },
      rosterRemove: (id) => {
        this.world.roster.delete(id);
        this.streaks.forget(id);
      },
      leaderboard: (lb) => {
        this.hud.leaderboard = lb;
        if (this.state === State.MENU) this.ui.setStatus(`${lb.total} ${lb.total === 1 ? 'pilot' : 'pilots'} online`);
      },
      kill: (k) => this.onKill(k),
      death: (d) => this.onDeath(d),
      announce: (a) => this.onAnnounce(a),
      kick: (reason) => {
        this.ui.showToast(KICK_MESSAGES[reason] ?? 'Disconnected.');
      },
    };
  }

  worldEvents() {
    return {
      self: (s, tick) => this.onSelf(s, tick),
      stats: (s, tick) => this.onStats(s, tick),
      spectate: (id, x, y) => {
        this.spectateFocus.id = id;
        this.spectateFocus.x = x;
        this.spectateFocus.y = y;
        // Deaths arrive as a DEATH message first; losing the ship without one means it was
        // removed (e.g. idle for too long), so return to the menu instead of freezing.
        if (this.predictor.active) this.onDespawned();
      },
      created: (e) => {
        if (e.type === EntityType.BULLET && e.fresh && !e.own) {
          this.sound.fire(e.kind === BulletKind.CANNON || e.kind === BulletKind.MOTHERSHIP, e.x, e.y, false);
        }
      },
      removed: (e, reason, collectorId) => this.onRemoved(e, reason, collectorId),
      damaged: () => {},
      predictedImpact: (x, y) => this.effects.spark(x, y, Color.ORANGE),
      event: (ev) => this.onEvent(ev),
      effect: (kind, x, y, angle, sourceId) => this.playEffect(kind, x, y, angle, 0, 0, false, sourceId),
      match: (m, previous) => this.onMatch(m, previous),
    };
  }

  /** Muzzle distance of a known ship's class (for drawing its blast at its prow). */
  noseOf(shipId) {
    const e = this.world.entities.get(shipId);
    return CLASSES[e ? this.world.playerClass(e.playerId) : 0].nose;
  }

  setMyTeam(team) {
    this.myTeam = team;
    this.predictor.team = team;
  }

  /**
   * Draws and plays a blast or class ability. Our own are predicted and
   * played the moment the key is pressed; others' arrive as effects.
   */
  playEffect(kind, x, y, angle, vx, vy, mine, source = NO_ID) {
    const fx = this.effects;
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    switch (kind) {
      case FxKind.BLAST: {
        const nose = mine ? this.predictor.st.nose : this.noseOf(source);
        fx.blast(x + c * nose, y + sn * nose, angle, BLAST_RANGE, BLAST_HALF_ANGLE, vx, vy);
        this.sound.blast(x, y, mine);
        if (mine) fx.addShake(5);
        return;
      }
      case FxKind.DASH:
        fx.dash(x, y, mine ? vx : c, mine ? vy : sn);
        this.sound.ability(Ability.DASH, x, y, mine);
        return;
      case FxKind.RAM:
        fx.ram(x, y, angle);
        this.sound.ability(Ability.RAM, x, y, mine);
        if (mine) fx.addShake(6);
        return;
      case FxKind.PULSE:
        fx.pulse(x, y, PULSE_RANGE);
        this.sound.ability(Ability.PULSE, x, y, mine);
        return;
      case FxKind.SINGULARITY:
        fx.singularity(x, y, SINGULARITY.range * 0.7);
        this.sound.ability(Ability.SINGULARITY, x, y, mine);
        return;
    }
  }

  /** Match updates: outposts changing hands and rounds ending or starting. */
  onMatch(m, previous) {
    if (!previous || !this.teams) return;
    const now = performance.now();
    const mine = this.myTeam;
    for (let i = 0; i < m.outposts.length; i++) {
      const before = previous.outposts[i];
      const after = m.outposts[i];
      if (!before || before.owner === after.owner) continue;
      const def = this.world.outposts[i];
      const name = def ? def.name.toUpperCase() : 'OUTPOST';
      if (after.owner !== NO_TEAM && after.owner === mine) {
        this.hud.announce('OUTPOST CAPTURED', `${name} · ${PERK_TEXT[def?.perk] ?? ''}`, playerColor(this.world.playerHue(this.myPlayerId)), now);
        this.sound.capture(true);
      } else if (before.owner !== NO_TEAM && before.owner === mine) {
        this.hud.announce('OUTPOST LOST', name, '#ff4d4d', now);
        this.sound.capture(false);
      } else if (after.owner !== NO_TEAM) {
        this.hud.notice(`${TEAM_NAMES[after.owner]} TOOK ${name}`, '#ff8c42', now);
      }
    }
    if (m.phase !== previous.phase) {
      if (m.phase === RoundPhase.INTERMISSION) {
        const won = mine !== NO_TEAM && m.winner === mine;
        const title = mine === NO_TEAM ? `${TEAM_NAMES[m.winner]} WIN` : won ? 'VICTORY' : 'DEFEAT';
        this.hud.announce(title, `${TEAM_NAMES[m.winner]} win the round${won ? ' · +300 score' : ''}`, won ? '#ffd166' : '#ff4d4d', now);
        if (won) this.sound.levelUp();
      } else {
        this.hud.announce('NEW ROUND', 'Outposts are neutral again: capture and hold them', '#fff', now);
      }
    }
    if (m.flare && (!previous.flare || previous.flare.start !== m.flare.start)) this.sound.flareWarning();
  }

  onSelf(s, tick) {
    const p = this.predictor;
    if (!p.active) {
      // Our first command reaches the server about one round trip after this snapshot left it.
      p.start(s, tick + (this.net.rtt * TICK_RATE) / 1000 + 1);
      this.state = State.PLAYING;
      this.input.enabled = true;
      this.ui.hideMenu();
      this.ui.hideDeath();
      clearTimeout(this.deathTimer);
      this.cam.leadX = this.cam.leadY = 0;
    } else {
      p.reconcile(s);
    }
    const stealth = (s.flags & ShipFlag.STEALTH) !== 0;
    if (this.self && stealth !== ((this.self.flags & ShipFlag.STEALTH) !== 0)) {
      this.hud.announce(stealth ? 'STEALTH ON' : 'STEALTH OFF', stealth ? 'Bots and aliens ignore you. Press I to reappear.' : '', '#b48cff', performance.now());
    }
    this.self = { hp: s.hp, shield: s.shield, energy: s.energy, boostLock: s.boostLock, flags: s.flags };
  }

  onStats(s, tick) {
    // Stats arrive before the self block, so a new life is recognised by its spawn tick.
    const newLife = !this.stats || this.stats.spawnTick !== s.spawnTick;
    this.stats = {
      score: s.score,
      kills: s.kills,
      level: s.level,
      points: s.points,
      statLevels: Uint8Array.from(s.statLevels),
      weapon: s.weapon,
      weaponChoice: s.weaponChoice,
      powerups: Uint16Array.from(s.powerups),
      spawnTick: s.spawnTick,
      shipClass: s.shipClass,
      perks: s.perks,
      receivedTick: tick,
    };
    this.predictor.setStats(s);
    const now = performance.now();
    if (!newLife && s.level > this.lastLevel) {
      this.hud.announce(`LEVEL ${s.level}`, s.points > 0 ? 'Upgrade with 1-8' : '', '#ffd166', now);
      this.sound.levelUp();
    }
    if (!newLife && s.weaponChoice && !this.hadWeaponChoice) {
      this.hud.announce('NEW WEAPON', 'Choose one with Z / X / C', '#ffd166', now);
    }
    this.lastLevel = s.level;
    this.hadWeaponChoice = s.weaponChoice;
  }

  onDespawned() {
    this.predictor.stop();
    this.world.ghosts.length = 0;
    this.input.enabled = false;
    this.input.releaseAll();
    this.sound.setThrust(false, false);
    this.state = State.MENU;
    this.ui.showMenu();
    this.ui.setStatus('You were idle for too long. Press Play to rejoin.');
  }

  onDeath(d) {
    const p = this.predictor;
    const x = p.renderX(this.alpha);
    const y = p.renderY(this.alpha);
    this.effects.explosion(x, y, 1.4, Color.WHITE);
    if (d.cause === KillCause.STAR) this.effects.supernova(x, y);
    this.effects.addShake(d.cause === KillCause.STAR ? 18 : 14);
    this.sound.explosion(2, x, y);
    this.sound.setThrust(false, false);
    p.stop();
    this.world.ghosts.length = 0;
    this.input.enabled = false;
    this.input.releaseAll();
    this.state = State.DEAD;
    const killer = d.killerId !== NO_ID ? this.world.playerName(d.killerId) : null;
    const cause = {
      [KillCause.SHIP]: killer ? `Shot down by ${killer}` : 'Shot down',
      [KillCause.RAM]: killer ? `Rammed by ${killer}` : 'Collision',
      [KillCause.ASTEROID]: killer ? `Pushed into an asteroid by ${killer}` : 'You hit an asteroid',
      [KillCause.PLANET]: killer ? `Pushed into a planet by ${killer}` : 'You crashed into a planet',
      [KillCause.STAR]: killer ? `Shoved into the star by ${killer}` : 'You flew into the star',
      [KillCause.FLARE]: killer ? `Caught by a solar flare after a fight with ${killer}` : 'Caught in the open by a solar flare',
      [KillCause.SINGULARITY]: killer ? `Crushed in ${killer}'s singularity` : 'Crushed in a singularity',
      [KillCause.ALIEN]: 'Shot down by an alien saucer',
      [KillCause.MOTHERSHIP]: 'Obliterated by the Mothership',
    }[d.cause];
    const seconds = Math.floor(d.aliveTicks / TICK_RATE);
    const info = {
      title: 'DESTROYED',
      cause,
      stats: [
        ['score', d.score.toLocaleString('en-US')],
        ['level', String(d.level)],
        ['kills', String(d.kills)],
        ['survived', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`],
      ],
    };
    clearTimeout(this.deathTimer);
    this.deathTimer = setTimeout(() => {
      if (this.state === State.DEAD) this.ui.showDeath(info);
    }, DEATH_SCREEN_DELAY_MS);
  }

  onKill(k) {
    const w = this.world;
    const name = (id) => ({ text: w.playerName(id), color: id === this.myPlayerId ? '#fff' : playerColor(w.playerHue(id)) });
    const text = (t) => ({ text: t, color: GREY });
    const victim = name(k.victimId);
    const killer = k.killerId !== NO_ID ? name(k.killerId) : null;
    let parts;
    switch (k.cause) {
      case KillCause.SHIP:
        parts = killer ? [killer, text(' destroyed '), victim] : [victim, text(' was destroyed')];
        break;
      case KillCause.RAM:
        parts = killer ? [killer, text(' rammed '), victim] : [victim, text(' collided')];
        break;
      case KillCause.ASTEROID:
        parts = killer ? [killer, text(' smashed '), victim, text(' into a rock')] : [victim, text(' hit an asteroid')];
        break;
      case KillCause.MOTHERSHIP:
        parts = [victim, text(' was obliterated by the Mothership')];
        break;
      case KillCause.PLANET:
        parts = killer ? [killer, text(' smashed '), victim, text(' into a planet')] : [victim, text(' crashed into a planet')];
        break;
      case KillCause.STAR:
        parts = killer ? [killer, text(' shoved '), victim, text(' into the star')] : [victim, text(' burned up in the star')];
        break;
      case KillCause.FLARE:
        parts = [victim, text(' was scorched by a solar flare')];
        break;
      case KillCause.SINGULARITY:
        parts = killer ? [killer, text(' crushed '), victim, text(' in a singularity')] : [victim, text(' was crushed in a singularity')];
        break;
      default:
        parts = [victim, text(' was shot down by aliens')];
    }
    const now = performance.now();
    this.hud.addKill(parts, now);
    if (k.cause === KillCause.STAR && k.victimId !== this.myPlayerId) this.starDeath(k.victimId);
    this.announceStreaks(k, name, text, now);
  }

  /** Another pilot swallowed by the star: a fireball where their ship is drawn. */
  starDeath(playerId) {
    for (const e of this.world.entities.values()) {
      if (e.type !== EntityType.SHIP || e.playerId !== playerId) continue;
      this.effects.supernova(e.rx, e.ry);
      this.sound.explosion(2.5, e.rx, e.ry);
      this.shakeNear(e.rx, e.ry, 12);
      return;
    }
  }

  /** Kill confirmations, multi-kills and streak call-outs (see StreakTracker). */
  announceStreaks(k, name, text, now) {
    const { streak, multi, ended } = this.streaks.record(k.killerId, k.victimId, now);
    const mine = k.killerId === this.myPlayerId && k.victimId !== this.myPlayerId;
    if (mine) {
      const title = multi >= 2 ? (MULTI_NAMES[multi] ?? 'MULTI KILL') : 'KILL';
      this.hud.announce(title, this.world.playerName(k.victimId), '#ff4d4d', now);
      if (multi >= 2) this.sound.levelUp();
    }
    if (ended >= 3 && k.killerId !== NO_ID && k.killerId !== k.victimId) {
      this.hud.addKill([name(k.killerId), text(' ended '), name(k.victimId), text(`'s ${ended}-kill streak`)], now);
    }
    const label = STREAK_NAMES.get(streak);
    if (label) {
      this.hud.addKill([name(k.killerId), text(` is on a ${label.toLowerCase()} (${streak})`)], now);
      if (mine) this.hud.announce(label, `${streak} kills without dying`, '#ffd166', now);
    }
  }

  onAnnounce(a) {
    const now = performance.now();
    switch (a.code) {
      case Announce.MOTHERSHIP_INBOUND:
        this.hud.announce('MOTHERSHIP INBOUND', 'Destroy it for a huge bounty. Check the minimap.', '#ff5cf2', now);
        this.sound.alarm();
        break;
      case Announce.MOTHERSHIP_DESTROYED:
        this.hud.announce(
          'MOTHERSHIP DESTROYED',
          a.playerId !== NO_ID ? `Final blow: ${this.world.playerName(a.playerId)}` : '',
          '#ffd166',
          now,
        );
        break;
      case Announce.MOTHERSHIP_ESCAPED:
        this.hud.announce('THE MOTHERSHIP ESCAPED', '', '#b48cff', now);
        break;
    }
  }

  onRemoved(e, reason, collectorId) {
    const x = e.rx;
    const y = e.ry;
    const fx = this.effects;
    switch (e.type) {
      case EntityType.SHIP:
        if (reason === RemoveReason.DESTROYED) {
          fx.explosion(x, y, 1.2, hueColor(this.world.playerHue(e.playerId)));
          this.sound.explosion(1.6, x, y);
          this.shakeNear(x, y, 8);
        }
        break;
      case EntityType.ASTEROID:
        if (reason === RemoveReason.DESTROYED) {
          fx.burst(x, y, 8 + e.size * 9, 120 + e.size * 50, Color.ROCK, 0.9, 0.06);
          fx.burst(x, y, 4 + e.size * 3, 80, Color.WHITE, 0.4, 0);
          this.sound.explosion(0.4 + e.size * 0.45, x, y);
          this.shakeNear(x, y, e.size * 1.5);
        }
        break;
      case EntityType.ALIEN:
        if (reason === RemoveReason.DESTROYED) {
          const big = e.kind === AlienKind.MOTHERSHIP;
          const color = e.kind === AlienKind.HUNTER ? Color.RED : big ? Color.MAGENTA : Color.GREEN;
          fx.explosion(x, y, big ? 3.5 : 1.1, color);
          this.sound.explosion(big ? 3 : 1.3, x, y);
          this.shakeNear(x, y, big ? 16 : 5);
        } else if (reason === RemoveReason.EXPIRED) {
          fx.burst(x, y, 40, 500, Color.VIOLET, 0.6, 0.08);
        }
        break;
      case EntityType.BULLET:
        if (reason === RemoveReason.HIT && !e.own && e.visible) {
          fx.spark(x, y, e.kind >= BulletKind.ALIEN ? Color.GREEN : Color.WHITE);
          this.sound.hit(x, y);
        }
        break;
      case EntityType.PICKUP:
        if (reason === RemoveReason.COLLECTED) {
          const mine = collectorId === this.world.myShipId && this.predictor.active;
          const collector = mine ? this.selfView : this.world.entities.get(collectorId);
          const color = isPowerup(e.kind) ? Color.CYAN : Color.GOLD;
          if (collector) fx.converge(x, y, collector.rx, collector.ry, color);
          if (mine) {
            this.sound.pickup(isPowerup(e.kind));
            const named = POWERUP_NAMES[e.kind];
            if (named) this.hud.announce(named[0], '', named[1], performance.now());
          }
        }
        break;
    }
  }

  onEvent(ev) {
    switch (ev.kind) {
      case EventKind.SCORE:
        this.effects.text(ev.x, ev.y - 20, `+${ev.amount}`, '#ffd166', 15);
        break;
      case EventKind.HIT: {
        this.world.takeOwnProjectile(ev.seq, ev.muzzle);
        this.effects.spark(ev.x, ev.y, ev.killed ? Color.GOLD : Color.CYAN);
        if (ev.damage > 0) {
          const jitter = (Math.random() - 0.5) * 24;
          this.effects.text(ev.x + jitter, ev.y - 8, String(ev.damage), ev.killed ? '#ff4d4d' : '#ffffff', 12);
          this.sound.hitConfirm();
        }
        break;
      }
      case EventKind.HEAL:
        this.effects.text(ev.x, ev.y - 22, `+${ev.amount}`, '#7dff6a', 13);
        this.effects.heal(ev.x, ev.y);
        break;
      case EventKind.DAMAGE:
        this.hud.addDamage(ev.angle, performance.now());
        this.effects.addShake(Math.min(9, 2 + ev.amount / 4));
        this.selfView.hitFlash = 1;
        this.sound.hurt();
        break;
    }
  }

  shakeNear(x, y, amount) {
    const d = Math.hypot(wrapDelta(x - this.cam.x, WORLD_SIZE), wrapDelta(y - this.cam.y, WORLD_SIZE));
    if (d < 900) this.effects.addShake(amount * (1 - d / 900));
  }

  inputActions() {
    return {
      upgrade: (stat) => {
        if (this.state === State.PLAYING && this.stats?.points > 0) this.net.upgrade(stat);
      },
      weapon: (index) => {
        if (this.state === State.PLAYING && this.stats?.weaponChoice) this.net.chooseWeapon(WEAPON_CHOICES[index]);
      },
      respawn: () => {
        if (this.state === State.DEAD && this.ui.deathVisible) this.play(this.ui.name());
      },
      toggleStealth: () => {
        if (this.state !== State.PLAYING) return;
        if (!this.devTools) {
          this.hud.announce('STEALTH UNAVAILABLE', 'Dev tools are turned off on this server', '#b48cff', performance.now());
          return;
        }
        this.net.toggleStealth();
      },
      toggleTrajectory: () => {
        this.trajectory = !this.trajectory;
        const sub = this.trajectory ? 'Your coasting path is always drawn in gravity wells' : 'The path shows only before a touchdown or crash';
        this.hud.notice(`TRAJECTORY PLANNER ${this.trajectory ? 'ON' : 'OFF'} · ${sub}`, '#9fb3c8', performance.now());
      },
      toggleDebug: () => {
        this.debug = this.debug ? null : {};
      },
      toggleMute: () => {
        const muted = this.sound.toggleMute();
        this.hud.announce(muted ? 'SOUND OFF' : 'SOUND ON', 'Press M to toggle', '#fff', performance.now());
      },
      hudPress: (x, y) => {
        if (this.state !== State.PLAYING) return null;
        const action = this.hud.hitTest(x, y);
        if (!action) return null;
        if (action.type === 'upgrade') this.net.upgrade(action.stat);
        else if (action.type === 'weapon') this.net.chooseWeapon(WEAPON_CHOICES[action.weapon]);
        return action; // 'blast' and 'lock' buttons are handled by the input layer
      },
    };
  }

  /* Loop ----------------------------------------------------------------------- */

  frame(now) {
    requestAnimationFrame(this.frame);
    let dt = now - this.last;
    this.last = now;
    if (dt > 250) dt = 250; // returning from a background tab: don't fast-forward
    if (dt > 0) this.fps += (1000 / dt - this.fps) * 0.05;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      this.fixedStep();
      if (++steps >= MAX_STEPS_PER_FRAME) {
        this.acc = 0;
        break;
      }
    }
    this.alpha = this.acc / TICK_MS;
    this.render(now, dt);
  }

  /** One 60 Hz input step: sample, predict, send. */
  fixedStep() {
    const p = this.predictor;
    if (!p.active || this.state !== State.PLAYING || !this.net.isOpen) return;
    this.input.sample(this.shipScreen.x, this.shipScreen.y, p.state.angle);
    const aimQ = qAngle(this.input.aim);
    const buttons = this.input.buttons;
    const result = p.step(buttons, dqAngle(aimQ)); // predict with exactly what the server will see
    this.net.sendInput(p.seq, buttons, aimQ);
    // Everything below is predicted feedback: it plays the moment the key is pressed.
    const s = p.state;
    if (result & StepResult.FIRED) this.firePredicted();
    if (result & StepResult.BLAST) this.playEffect(FxKind.BLAST, s.x, s.y, s.angle, s.vx, s.vy, true);
    if (result & StepResult.ABILITY) this.useAbility(s, p.st.ability);
    if (result & StepResult.LOCKED) this.onLocked();
    if (result & StepResult.UNLOCKED) {
      this.sound.lock(false);
      this.hud.notice('ORBIT RELEASED', '#9fb3c8', performance.now());
    }
    if (result & StepResult.LOCK_FAILED) {
      this.sound.denied();
      this.hud.notice('NO GRAVITY WELL IN RANGE', '#ff8c42', performance.now());
    }
    if (result & StepResult.IMPACT) {
      if (p.bodies[s.contactBody]?.kind === BodyKind.STAR) {
        this.effects.burn(s.x, s.y);
        this.sound.sizzle();
      } else if (s.impact > 40) {
        // Touchdowns and crashes give feedback without waiting for the server.
        this.effects.burst(s.x, s.y, Math.min(24, 4 + Math.round(s.impact / 25)), 60 + s.impact * 0.4, Color.ROCK, 0.5, 0.03);
        this.sound.thud(s.impact / 400);
      }
    }
    if (result & StepResult.THRUST) this.exhaust(s, buttons, (result & StepResult.BOOST) !== 0);
    this.checkFuel();
  }

  /** Our class ability fired (predicted): the effect plays at once, the server applies it. */
  useAbility(s, ability) {
    switch (ability) {
      case Ability.DASH:
        this.playEffect(FxKind.DASH, s.x, s.y, s.angle, s.vx, s.vy, true);
        break;
      case Ability.RAM:
        this.playEffect(FxKind.RAM, s.x, s.y, s.angle, s.vx, s.vy, true);
        break;
      case Ability.PULSE:
        this.playEffect(FxKind.PULSE, s.x, s.y, s.angle, s.vx, s.vy, true);
        break;
      case Ability.SINGULARITY: {
        const x = s.x + Math.cos(s.angle) * SINGULARITY.distance;
        const y = s.y + Math.sin(s.angle) * SINGULARITY.distance;
        this.playEffect(FxKind.SINGULARITY, x, y, s.angle, 0, 0, true);
        break;
      }
    }
  }

  /** Exhaust puffs from whichever thrusters are firing, blowing opposite their push. */
  exhaust(s, buttons, boost) {
    const c = Math.cos(s.angle);
    const sn = Math.sin(s.angle);
    const fx = this.effects;
    const r = this.predictor.st.radius;
    const mx = (buttons & Button.MOVE_RIGHT ? 1 : 0) - (buttons & Button.MOVE_LEFT ? 1 : 0);
    const my = (buttons & Button.MOVE_DOWN ? 1 : 0) - (buttons & Button.MOVE_UP ? 1 : 0);
    if ((mx !== 0 || my !== 0) && Math.random() < 0.6) {
      const a = Math.atan2(-my, -mx); // screen thrusters blow opposite their push
      fx.exhaust(s.x + Math.cos(a) * r * 0.8, s.y + Math.sin(a) * r * 0.8, a, s.vx, s.vy, false, 0.8);
    }
    if ((boost || buttons & Button.THRUST) && (boost || Math.random() < 0.6)) {
      fx.exhaust(s.x - c * r * 0.8, s.y - sn * r * 0.8, s.angle + Math.PI, s.vx, s.vy, boost);
    }
    if (buttons & Button.BACK && Math.random() < 0.5) {
      fx.exhaust(s.x + c * r * 0.9, s.y + sn * r * 0.9, s.angle, s.vx, s.vy, false, 0.7);
    }
    if (buttons & Button.STRAFE_LEFT && Math.random() < 0.5) {
      fx.exhaust(s.x - sn * r * 0.7, s.y + c * r * 0.7, s.angle + Math.PI / 2, s.vx, s.vy, false, 0.6);
    }
    if (buttons & Button.STRAFE_RIGHT && Math.random() < 0.5) {
      fx.exhaust(s.x + sn * r * 0.7, s.y - c * r * 0.7, s.angle - Math.PI / 2, s.vx, s.vy, false, 0.6);
    }
  }

  onLocked() {
    const p = this.predictor;
    const body = p.bodies[p.state.lockBody];
    const s = p.state;
    this.effects.ring(s.x, s.y, 46, p.st.radius * 1.6, 0.35, Color.CYAN);
    this.sound.lock(true);
    if (body) this.hud.notice(`ORBIT LOCKED · ${body.name.toUpperCase()}`, '#5cf2ff', performance.now());
  }

  /** Where the Graviton's singularity would form, and whether it is ready (see Renderer.drawReticle). */
  reticle(sv) {
    const p = this.predictor;
    const r = this.reticleView;
    r.x = sv.rx + Math.cos(sv.ra) * SINGULARITY.distance;
    r.y = sv.ry + Math.sin(sv.ra) * SINGULARITY.distance;
    r.ready = p.state.abilityCooldown === 0 && p.state.energy >= p.st.abilityCost;
    r.color = playerColor(this.world.playerHue(this.myPlayerId));
    return r;
  }

  /** True if a gravity well (or singularity) is within a few seconds' flight, so the path may bend. */
  nearWell(s) {
    const reach = Math.hypot(s.vx, s.vy) * WELL_LOOKAHEAD_S;
    for (const list of [this.world.planets, this.world.gravityFields]) {
      for (const b of list) {
        const d = Math.hypot(wrapDelta(b.x - s.x, WORLD_SIZE), wrapDelta(b.y - s.y, WORLD_SIZE));
        if (d < b.range + reach) return true;
      }
    }
    return false;
  }

  /** Warns once as the tank runs low and again when it runs dry. */
  checkFuel() {
    const p = this.predictor;
    const frac = p.state.fuel / p.st.fuelMax;
    const level = p.state.fuel === 0 ? 2 : frac < LOW_FUEL ? 1 : 0;
    if (level > this.fuelWarning) {
      const now = performance.now();
      if (level === 2) {
        this.hud.notice('OUT OF FUEL · reserve thrusters only: land on a planet to refuel', '#ff4d4d', now);
        this.sound.denied();
      } else {
        this.hud.notice('LOW FUEL · land on a planet, reach your outpost or grab a fuel cell', '#ffb347', now);
      }
    }
    this.fuelWarning = level;
  }

  firePredicted() {
    const p = this.predictor;
    const n = computeShots(p.state, p.weapon, p.st, this.shots);
    const tick = p.commandTick(p.seq);
    const heavy = p.weapon === Weapon.CANNON;
    const kind = heavy ? BulletKind.CANNON : BulletKind.PLAYER;
    for (let i = 0; i < n; i++) {
      // Leave the muzzle where the ship is drawn, even while a correction is still being blended out.
      const ghost = this.world.addGhost(p.seq, i, this.shots[i], kind, p.st.bulletLife, tick);
      ghost.offsetX = p.errorX;
      ghost.offsetY = p.errorY;
    }
    this.sound.fire(heavy, 0, 0, true);
  }

  render(now, dt) {
    const { world, predictor: p, renderer, cam } = this;
    this.effects.update(dt / 1000);
    world.decayOffsets(p.decayError(dt));
    const renderTick = world.clock.renderTick(now, dt);
    // The present is our own ship's command time, between the last two predicted steps.
    const presentTick = p.active ? p.commandTick(p.seq - 1) + this.alpha : world.clock.serverTick(now);
    world.updatePresentation(renderTick, presentTick);

    let selfView = null;
    let viewScale = 1;
    const ease = 1 - Math.exp(-dt / 140);
    if (p.active && this.self) {
      const sv = this.selfView;
      sv.rx = p.renderX(this.alpha);
      sv.ry = p.renderY(this.alpha);
      sv.ra = p.renderAngle(this.alpha);
      const local = p.lastResult;
      const held = p.lastButtons;
      sv.flags =
        (this.self.flags & ~(ShipFlag.THRUST | ShipFlag.BOOST | ShipFlag.BRAKE | ShipFlag.LOCKED | ShipFlag.ABILITY)) |
        (local & StepResult.THRUST && (local & StepResult.BOOST || held & Button.THRUST) ? ShipFlag.THRUST : 0) |
        (local & StepResult.BOOST ? ShipFlag.BOOST : 0) |
        (p.state.lockBody >= 0 ? ShipFlag.LOCKED : 0);
      sv.thrusters = local & StepResult.THRUST ? held & (Button.BACK | Button.STRAFE_LEFT | Button.STRAFE_RIGHT) : 0;
      sv.shipClass = p.st.shipClass;
      sv.moveX = (held & Button.MOVE_RIGHT ? 1 : 0) - (held & Button.MOVE_LEFT ? 1 : 0);
      sv.moveY = (held & Button.MOVE_DOWN ? 1 : 0) - (held & Button.MOVE_UP ? 1 : 0);
      if (!(local & StepResult.THRUST)) sv.moveX = sv.moveY = 0;
      if (p.st.ability === Ability.RAM && p.state.abilityTime > 0) sv.flags |= ShipFlag.ABILITY;
      sv.playerId = this.myPlayerId;
      sv.level = this.stats?.level ?? 1;
      sv.weapon = p.weapon;
      sv.hitFlash = Math.max(0, sv.hitFlash - dt / 250);
      selfView = sv;
      viewScale = viewScaleForLevel(sv.level);
      // Look slightly ahead of the ship in the direction of travel.
      const leadEase = 1 - Math.exp(-dt / 350);
      cam.leadX += (clamp(p.state.vx * 0.18, -150, 150) - cam.leadX) * leadEase;
      cam.leadY += (clamp(p.state.vy * 0.18, -110, 110) - cam.leadY) * leadEase;
      cam.x = sv.rx + cam.leadX;
      cam.y = sv.ry + cam.leadY;
      this.sound.setThrust((local & StepResult.THRUST) !== 0, (local & StepResult.BOOST) !== 0);
    } else {
      const focus = world.entities.get(this.spectateFocus.id);
      const tx = focus ? focus.rx : this.spectateFocus.x;
      const ty = focus ? focus.ry : this.spectateFocus.y;
      const far = Math.abs(wrapDelta(tx - cam.x, WORLD_SIZE)) + Math.abs(wrapDelta(ty - cam.y, WORLD_SIZE)) > 2500;
      cam.x = far ? tx : wrapLerp(cam.x, tx, ease, WORLD_SIZE);
      cam.y = far ? ty : wrapLerp(cam.y, ty, ease, WORLD_SIZE);
    }

    let flight = null;
    let lock = null;
    if (selfView) {
      flight = this.flight;
      if (this.nearWell(p.state)) {
        flight.update(p.state, p.st, world.planets, p.commandTick(p.seq), selfView.rx, selfView.ry, world.gravityFields, this.myTeam, p.shipId);
      } else {
        flight.clear(); // no well within reach: nothing to plan
      }
      flight.shown = this.trajectory || flight.contact;
      const body = p.state.lockBody >= 0 ? world.planets[p.state.lockBody] : null;
      if (body) {
        lock = this.lockView;
        lock.body = body;
        lock.radius = p.state.lockRadius;
        lock.dir = p.state.lockDir;
      }
    }

    const flare = world.match?.flare;
    if (flare && presentTick >= flare.start && this.flareBurned !== flare.start) {
      this.flareBurned = flare.start;
      this.sound.flareBurn();
      this.effects.addShake(6);
    }

    renderer.setViewScale(viewScale);
    if (this.debug) this.updateDebug(now);
    const shake = this.effects.shake;
    const shakeX = shake ? (Math.random() - 0.5) * shake : 0;
    const shakeY = shake ? (Math.random() - 0.5) * shake : 0;
    this.sound.setListener(cam.x, cam.y);
    renderer.draw({
      camX: cam.x,
      camY: cam.y,
      shakeX,
      shakeY,
      world,
      self: selfView,
      effects: this.effects,
      time: now / 1000,
      tick: presentTick,
      flight,
      lock,
      reticle: selfView && p.st.ability === Ability.SINGULARITY ? this.reticle(selfView) : null,
    });
    if (selfView) renderer.toScreen(selfView.rx, selfView.ry, cam.x, cam.y, this.shipScreen);

    this.hud.draw({
      ctx: renderer.ctx,
      width: renderer.width,
      height: renderer.height,
      dpr: renderer.dpr,
      now,
      playing: this.state === State.PLAYING && p.active && this.self !== null,
      self: this.self,
      stats: this.stats,
      st: p.st,
      world,
      myPlayerId: this.myPlayerId,
      camX: cam.x,
      camY: cam.y,
      scale: renderer.scale,
      ping: this.net.rtt,
      fps: this.fps,
      serverTick: world.clock.serverTick(now),
      touch: this.input.touchMode,
      planets: world.planets,
      flight,
      blastReady: p.active && p.state.blastCooldown === 0 && p.state.energy >= p.st.blastCost,
      blastCharge: p.active ? 1 - p.state.blastCooldown / p.st.blastInterval : 0,
      abilityReady: p.active && p.state.abilityCooldown === 0 && p.state.energy >= p.st.abilityCost,
      abilityCharge: p.active ? 1 - p.state.abilityCooldown / p.st.abilityCooldown : 0,
      shipClass: p.st.shipClass,
      team: this.myTeam,
      teams: this.teams,
      perks: this.stats?.perks ?? 0,
      fuel: p.active ? p.state.fuel : 0,
      fuelMax: p.st.fuelMax,
      refueling: p.active && (p.lastResult & StepResult.REFUEL) !== 0,
      trajectory: this.trajectory,
      shipX: selfView ? selfView.rx : 0,
      shipY: selfView ? selfView.ry : 0,
      touchStick: this.input.touchMode && this.input.stick.id !== -1 ? this.input.stick : null,
      shipScreen: this.shipScreen,
      debug: this.debug,
    });
  }

  updateDebug(now) {
    const t = this.traffic;
    if (now - t.at >= 1000) {
      const seconds = (now - t.at) / 1000;
      t.kbps = (this.net.bytesIn - t.bytes) / 1024 / seconds;
      t.snapshotsPerSecond = Math.round((this.world.snapshotCount - t.snapshots) / seconds);
      t.bytes = this.net.bytesIn;
      t.snapshots = this.world.snapshotCount;
      t.at = now;
    }
    const { world, predictor: p } = this;
    Object.assign(this.debug, {
      rtt: this.net.rtt,
      jitter: world.clock.jitter,
      delay: world.clock.delay,
      kbps: t.kbps,
      snapshotsPerSecond: t.snapshotsPerSecond,
      entities: world.entities.size,
      pending: p.pendingCount,
      corrections: p.corrections,
      lastCorrection: p.lastCorrection,
      ...world.netStats,
    });
  }
}

// Exposed for debugging from the console and for automated browser tests.
window.blasteroid = new GameClient();
