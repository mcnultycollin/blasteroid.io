/**
 * Builds one client's snapshot.
 *
 * Interest management: only entities inside the client's view (plus a margin)
 * are replicated. Each session remembers which entity objects it has been
 * sent (`session.known`, entity -> version), so a snapshot carries:
 *   - removals for known entities that died or left the view,
 *   - full records for new entities,
 *   - records for streamed entities (ships, aliens) every time; ships the
 *     client already knows get a compact motion-only record, unless their
 *     level or weapon changed,
 *   - records for predictable entities (asteroids, projectiles, pickups) only
 *     when their version changed,
 *   - nearby visual effects (blasts, abilities), except the viewer's own,
 *   - the match state (scores, outposts, flares) when it changed,
 *   - the singularities in view, which clients need for prediction.
 * Keying by object rather than id keeps recycled ids unambiguous.
 *
 * Enemies hidden in a nebula are treated as out of view (they are never sent,
 * so a modified client cannot reveal them), except to a pilot close by.
 */
import { NO_TEAM, RemoveReason, VIEW_HEIGHT, VIEW_MARGIN, VIEW_WIDTH } from '../../shared/constants.js';
import { NO_ID, SnapFlag } from '../../shared/protocol.js';
import { viewScaleForLevel } from '../../shared/stats.js';
import { Mask } from '../game/entities.js';
import { hiddenFrom } from '../game/objectives.js';
import { seconds } from '../game/tuning.js';

const STREAMED = Mask.SHIP | Mask.ALIEN;
const FOLLOW_KILLER = seconds(8);
const LINGER_ON_WRECK = seconds(2.5);
const NO_EVENTS = [];
const visible = [];

/**
 * Writes the snapshot for `session` with `out` (a SnapshotWriter) and returns
 * the encoded bytes. `leader` is the top-scoring ship, used as the default
 * camera target for spectators.
 */
export function buildSnapshot(game, session, out, leader) {
  const player = session.player;
  const ship = player && player.ship && !player.ship.dead ? player.ship : null;
  const team = player ? player.team : NO_TEAM;

  let flags = 0;
  if (session.matchVersion !== game.match.version) flags |= SnapFlag.WORLD;
  let cx;
  let cy;
  let scale = 1;
  let focus = null;
  if (ship) {
    cx = ship.x;
    cy = ship.y;
    scale = viewScaleForLevel(ship.level);
    flags |= SnapFlag.SELF;
    if (session.statsShip !== ship || session.statsVersion !== ship.statsVersion) flags |= SnapFlag.STATS;
  } else {
    focus = spectateTarget(game, session, leader);
    if (focus) {
      session.camX = focus.x;
      session.camY = focus.y;
    }
    cx = session.camX;
    cy = session.camY;
    flags |= SnapFlag.SPECTATE;
  }

  const hw = (VIEW_WIDTH * scale) / 2 + VIEW_MARGIN;
  const hh = (VIEW_HEIGHT * scale) / 2 + VIEW_MARGIN;
  visible.length = 0;
  game.grid.query(cx, cy, hw, hh, Mask.ALL, visible);
  const stamp = game.grid.stamp; // every entity returned by the query carries this stamp

  out.begin(game.tick, flags);
  if (ship) {
    // Stats first: the client must derive its ship's new stats before it replays its inputs from the self block.
    if (flags & SnapFlag.STATS) {
      out.stats(ship);
      session.statsShip = ship;
      session.statsVersion = ship.statsVersion;
    }
    out.self(ship, player.ackSeq, player.timeOffset);
  } else {
    out.spectate(focus ? focus.id : NO_ID, cx, cy);
  }
  if (flags & SnapFlag.WORLD) {
    out.world(game.match);
    session.matchVersion = game.match.version;
  }

  const known = session.known;
  out.beginList();
  for (const e of known.keys()) {
    if (e.dead || e._q !== stamp || (e.mask === Mask.SHIP && hiddenFrom(e, ship, team))) {
      out.removal(e.id, e.dead ? e.removeReason : RemoveReason.GONE, e.collectorId);
      known.delete(e);
    }
  }
  out.endList();

  out.beginList();
  const viewerId = ship ? ship.id : NO_ID;
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i];
    if (e === ship || (e.mask === Mask.SHIP && hiddenFrom(e, ship, team))) continue; // SELF covers our own ship
    const sent = known.get(e);
    if (e.mask === Mask.SHIP) {
      const info = shipInfo(e);
      out.entity(e, viewerId, game.tick, sent === info);
      known.set(e, info);
    } else if (sent === undefined || (e.mask & STREAMED) !== 0 || e.streamed || sent !== e.version) {
      out.entity(e, viewerId, game.tick);
      known.set(e, e.version);
    }
  }
  out.endList();

  out.events(player ? player.events : NO_EVENTS);
  if (player) player.events.length = 0;
  out.effects(game.fx, viewerId, cx, cy, hw, hh);
  out.fields(game.fields, cx, cy, hw, hh);
  return out.finish();
}

/** What a full ship record carries beyond its motion, as one number (its owner never changes). */
const shipInfo = (ship) => ship.level | (ship.weapon << 8);

/** Camera target while not playing: the killer for a while after death, otherwise the leader. */
function spectateTarget(game, session, leader) {
  const player = session.player;
  if (player && player.deathTick >= 0) {
    const sinceDeath = game.tick - player.deathTick;
    if (player.killer && !player.killer.dead && sinceDeath < FOLLOW_KILLER) return player.killer;
    if (sinceDeath < LINGER_ON_WRECK) {
      session.camX = player.deathX;
      session.camY = player.deathY;
      return null;
    }
  }
  if (!session.spectating || session.spectating.dead) session.spectating = leader;
  return session.spectating && !session.spectating.dead ? session.spectating : null;
}
