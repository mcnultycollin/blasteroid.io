/**
 * Teams and rounds. Two teams, Helios and Polaris, fight over outposts; the
 * first to the round's target score wins (or the leader when time runs out),
 * then a short intermission resets the objectives. Pilots keep their ships
 * and levels from round to round.
 *
 * In free-for-all mode (`teams` = 0) every player is on NO_TEAM, `allies()`
 * is always false and there are no rounds.
 */
import { NO_TEAM, RoundPhase, TEAM_COUNT } from '../../shared/constants.js';
import { awardScore } from './combat.js';
import { ROUND } from './tuning.js';

/** True if `a` and `b` (ships, players or fields: anything with `team`) fight on the same side. */
export const allies = (a, b) => a.team !== NO_TEAM && a.team === b.team;

/** The match state replicated to clients (see SnapshotWriter.world). */
export function createMatch(teams, tick) {
  return {
    teams, // number of teams, 0 for free-for-all
    phase: RoundPhase.PLAYING,
    phaseEnd: tick + ROUND.duration,
    winner: NO_TEAM,
    round: 1,
    scores: new Array(teams).fill(0),
    perks: new Array(teams).fill(0), // Perk bits each team holds through its outposts
    outposts: [], // per outpost: { owner, progress, contested }; see objectives.js
    flare: null, // the coming or active solar flare: { angle, halfWidth, start, end }
    version: 1, // bumped on every change, so snapshots carry the match only when needed
  };
}

/** The team a new player joins: the smaller one, then the one with fewer humans. */
export function pickTeam(game, isBot) {
  if (!game.match.teams) return NO_TEAM;
  const players = new Array(TEAM_COUNT).fill(0);
  const humans = new Array(TEAM_COUNT).fill(0);
  for (const p of game.players.values()) {
    if (p.team === NO_TEAM || p.retiring) continue;
    players[p.team]++;
    if (!p.isBot) humans[p.team]++;
  }
  if (players[0] !== players[1]) return players[0] < players[1] ? 0 : 1;
  if (!isBot && humans[0] !== humans[1]) return humans[0] < humans[1] ? 0 : 1;
  return game.rng() < 0.5 ? 0 : 1;
}

/** Counts active (non-retiring) players per team, optionally bots only. */
export function teamSizes(game, botsOnly = false) {
  const sizes = new Array(TEAM_COUNT).fill(0);
  for (const p of game.players.values()) {
    if (p.team === NO_TEAM || p.retiring || (botsOnly && !p.isBot)) continue;
    sizes[p.team]++;
  }
  return sizes;
}

export function addTeamScore(game, team, points) {
  const m = game.match;
  if (team === NO_TEAM || !m.teams || m.phase !== RoundPhase.PLAYING || points <= 0) return;
  m.scores[team] += points;
  m.version++;
}

/** Ends the round when a team reaches the target or time runs out, and starts the next. */
export function updateRound(game, resetObjectives) {
  const m = game.match;
  if (!m.teams) return;
  if (m.phase === RoundPhase.INTERMISSION) {
    if (game.tick >= m.phaseEnd) {
      m.phase = RoundPhase.PLAYING;
      m.phaseEnd = game.tick + ROUND.duration;
      m.winner = NO_TEAM;
      m.round++;
      m.scores.fill(0);
      resetObjectives(game);
      m.version++;
    }
    return;
  }
  let winner = m.scores.findIndex((s) => s >= ROUND.winScore);
  if (winner < 0 && game.tick >= m.phaseEnd && m.scores[0] !== m.scores[1]) winner = m.scores[0] > m.scores[1] ? 0 : 1;
  if (winner < 0) return; // tied at the buzzer: sudden death until someone scores
  m.phase = RoundPhase.INTERMISSION;
  m.phaseEnd = game.tick + ROUND.intermission;
  m.winner = winner;
  m.version++;
  for (const ship of game.ships) {
    if (!ship.dead && ship.team === winner) awardScore(game, ship, ROUND.winBonus, ship.x, ship.y);
  }
}
