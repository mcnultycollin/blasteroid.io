/**
 * Builds one client's snapshot.
 *
 * Interest management: only entities inside the client's view (plus a margin)
 * are replicated. Each session remembers which entity objects it has been
 * sent (`session.known`, entity -> version), so a snapshot carries:
 *   - removals for known entities that died or left the view,
 *   - full records for new entities,
 *   - records for streamed entities (ships, aliens) every time,
 *   - records for predictable entities (asteroids, projectiles, pickups) only
 *     when their version changed.
 * Keying by object rather than id keeps recycled ids unambiguous.
 */
import { RemoveReason, VIEW_HEIGHT, VIEW_MARGIN, VIEW_WIDTH } from '../../shared/constants.js';
import { NO_ID, SnapFlag } from '../../shared/protocol.js';
import { viewScaleForLevel } from '../../shared/stats.js';
import { Mask } from '../game/entities.js';
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

  let flags = 0;
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

  visible.length = 0;
  game.grid.query(
    cx,
    cy,
    (VIEW_WIDTH * scale) / 2 + VIEW_MARGIN,
    (VIEW_HEIGHT * scale) / 2 + VIEW_MARGIN,
    Mask.ALL,
    visible,
  );
  const stamp = game.grid.stamp; // every entity returned by the query carries this stamp

  out.begin(game.tick, flags);
  if (ship) {
    out.self(ship, player.ackSeq);
    if (flags & SnapFlag.STATS) {
      out.stats(ship);
      session.statsShip = ship;
      session.statsVersion = ship.statsVersion;
    }
  } else {
    out.spectate(focus ? focus.id : NO_ID, cx, cy);
  }

  const known = session.known;
  out.beginList();
  for (const e of known.keys()) {
    if (e.dead || e._q !== stamp) {
      out.removal(e.id, e.dead ? e.removeReason : RemoveReason.GONE, e.collectorId);
      known.delete(e);
    }
  }
  out.endList();

  out.beginList();
  const viewerId = ship ? ship.id : NO_ID;
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i];
    if (e === ship) continue; // the SELF block covers it
    const sent = known.get(e);
    if (sent === undefined || (e.mask & STREAMED) !== 0 || e.streamed || sent !== e.version) {
      out.entity(e, viewerId, game.tick);
      known.set(e, e.version);
    }
  }
  out.endList();

  out.events(player ? player.events : NO_EVENTS);
  if (player) player.events.length = 0;
  return out.finish();
}

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
