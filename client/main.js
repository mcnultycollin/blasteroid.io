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
  PROTOCOL_VERSION,
  PickupKind,
  RemoveReason,
  SHIP_NOSE,
  SHIP_RADIUS,
  ShipFlag,
  TICK_MS,
  TICK_RATE,
  WORLD_SIZE,
  isPowerup,
} from '../shared/constants.js';
import { clamp, wrapDelta, wrapLerp } from '../shared/math.js';
import { StepResult, computeShots } from '../shared/physics.js';
import { NO_ID, dqAngle, qAngle } from '../shared/protocol.js';
import { WEAPON_CHOICES, Weapon, viewScaleForLevel } from '../shared/stats.js';
import { Sound } from './audio.js';
import { Color, Effects, hueColor } from './effects.js';
import { FlightPath } from './flightpath.js';
import { Hud } from './hud.js';
import { Input } from './input.js';
import { Connection } from './net.js';
import { Predictor } from './prediction.js';
import { Renderer, playerColor } from './renderer.js';
import { Ui } from './ui.js';
import { ClientWorld } from './world.js';

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
    this.ui = new Ui({ play: (name) => this.play(name) });
    this.input = new Input(this.canvas, this.inputActions());
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
    this.traffic = { at: performance.now(), bytes: 0, snapshots: 0, kbps: 0, snapshotsPerSecond: 0 };

    this.ui.setPlayEnabled(false);
    this.net.connect();
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }

  /* Session flow -------------------------------------------------------------- */

  play(name) {
    this.sound.unlock();
    if (!this.net.isOpen || this.predictor.active) return;
    this.net.join(name);
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
        this.predictor.bodies = this.world.planets;
      },
      joined: (id) => {
        this.myPlayerId = id;
      },
      snapshot: (reader) => this.world.applySnapshot(reader, performance.now()),
      roster: (list) => {
        for (const p of list) this.world.setPlayer(p.id, p.name);
      },
      rosterRemove: (id) => this.world.roster.delete(id),
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
      effect: (kind, x, y, angle) => {
        if (kind === FxKind.BLAST) {
          this.effects.blast(x + Math.cos(angle) * SHIP_NOSE, y + Math.sin(angle) * SHIP_NOSE, angle, BLAST_RANGE, BLAST_HALF_ANGLE);
          this.sound.blast(x, y, false);
        }
      },
    };
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
      this.lastLevel = 0;
      this.hadWeaponChoice = false;
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
      receivedTick: tick,
    };
    this.predictor.setStats(s);
    const now = performance.now();
    if (this.lastLevel && s.level > this.lastLevel) {
      this.hud.announce(`LEVEL ${s.level}`, s.points > 0 ? 'Upgrade with 1-8' : '', '#ffd166', now);
      this.sound.levelUp();
    }
    if (s.weaponChoice && !this.hadWeaponChoice) {
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
    this.effects.addShake(14);
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
      default:
        parts = [victim, text(' was shot down by aliens')];
    }
    const now = performance.now();
    this.hud.addKill(parts, now);
    if (k.killerId === this.myPlayerId && k.victimId !== this.myPlayerId) {
      this.hud.announce('KILL', w.playerName(k.victimId), '#ff4d4d', now);
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
    if (result & StepResult.BLAST) {
      const c = Math.cos(s.angle);
      const sn = Math.sin(s.angle);
      this.effects.blast(s.x + c * SHIP_NOSE, s.y + sn * SHIP_NOSE, s.angle, BLAST_RANGE, BLAST_HALF_ANGLE, s.vx, s.vy);
      this.effects.addShake(5);
      this.sound.blast(s.x, s.y, true);
    }
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
  }

  /** Exhaust puffs from whichever thrusters are firing, blowing opposite their push. */
  exhaust(s, buttons, boost) {
    const c = Math.cos(s.angle);
    const sn = Math.sin(s.angle);
    const fx = this.effects;
    const r = SHIP_RADIUS;
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
    this.effects.ring(s.x, s.y, 46, SHIP_RADIUS * 1.6, 0.35, Color.CYAN);
    this.sound.lock(true);
    if (body) this.hud.notice(`ORBIT LOCKED · ${body.name.toUpperCase()}`, '#5cf2ff', performance.now());
  }

  firePredicted() {
    const p = this.predictor;
    const n = computeShots(p.state, p.weapon, p.st, this.shots);
    const tick = p.commandTick(p.seq);
    const heavy = p.weapon === Weapon.CANNON;
    const kind = heavy ? BulletKind.CANNON : BulletKind.PLAYER;
    for (let i = 0; i < n; i++) this.world.addGhost(p.seq, i, this.shots[i], kind, p.st.bulletLife, tick);
    this.sound.fire(heavy, 0, 0, true);
  }

  render(now, dt) {
    const { world, predictor: p, renderer, cam } = this;
    this.effects.update(dt / 1000);
    p.decayError(dt);
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
        (this.self.flags & ~(ShipFlag.THRUST | ShipFlag.BOOST | ShipFlag.BRAKE | ShipFlag.LOCKED)) |
        (local & StepResult.THRUST && (local & StepResult.BOOST || held & Button.THRUST) ? ShipFlag.THRUST : 0) |
        (local & StepResult.BOOST ? ShipFlag.BOOST : 0) |
        (p.state.lockBody >= 0 ? ShipFlag.LOCKED : 0);
      sv.thrusters = local & StepResult.THRUST ? held & (Button.BACK | Button.STRAFE_LEFT | Button.STRAFE_RIGHT) : 0;
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
      flight.update(p.state, p.st, world.planets, p.commandTick(p.seq), selfView.rx, selfView.ry);
      const body = p.state.lockBody >= 0 ? world.planets[p.state.lockBody] : null;
      if (body) {
        lock = this.lockView;
        lock.body = body;
        lock.radius = p.state.lockRadius;
        lock.dir = p.state.lockDir;
      }
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
      flight,
      lock,
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
