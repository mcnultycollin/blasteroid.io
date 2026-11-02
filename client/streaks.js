/**
 * Kill streaks and multi-kills, derived from the kill feed alone, so they cost
 * no server state or bandwidth. A streak counts a pilot's kills since their
 * last death; a multi-kill counts kills landed within MULTI_WINDOW_MS of each other.
 */
import { NO_ID } from '../shared/protocol.js';

export const MULTI_WINDOW_MS = 4000;
/** Streak lengths worth calling out, with their names. */
export const STREAK_NAMES = new Map([
  [3, 'KILLING SPREE'],
  [5, 'RAMPAGE'],
  [8, 'UNSTOPPABLE'],
  [12, 'GODLIKE'],
]);
export const MULTI_NAMES = ['', '', 'DOUBLE KILL', 'TRIPLE KILL'];

export class StreakTracker {
  constructor() {
    this.pilots = new Map(); // playerId -> { streak, multi, lastKill }
  }

  /**
   * Records a kill at time `now` (ms). Returns what happened: the killer's
   * streak and multi-kill counts (0 when no pilot got the kill) and the length
   * of the victim's streak that just ended.
   */
  record(killerId, victimId, now) {
    const ended = this.pilots.get(victimId)?.streak ?? 0;
    this.pilots.delete(victimId);
    if (killerId === NO_ID || killerId === victimId) return { streak: 0, multi: 0, ended };
    let p = this.pilots.get(killerId);
    if (!p) this.pilots.set(killerId, (p = { streak: 0, multi: 0, lastKill: -Infinity }));
    p.streak++;
    p.multi = now - p.lastKill <= MULTI_WINDOW_MS ? p.multi + 1 : 1;
    p.lastKill = now;
    return { streak: p.streak, multi: p.multi, ended };
  }

  forget(playerId) {
    this.pilots.delete(playerId);
  }

  clear() {
    this.pilots.clear();
  }
}
