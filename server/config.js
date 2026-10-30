/** Runtime configuration from environment variables, with defaults for local play. */
const env = process.env;

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = Object.freeze({
  port: int(env.PORT, 3000), // not 5000: macOS reserves it for AirPlay Receiver
  host: env.HOST || '0.0.0.0',
  production: env.NODE_ENV === 'production',
  /** Human players (and spectators) per room before a new room opens. */
  maxPlayers: int(env.MAX_PLAYERS, 40),
  /** Bots fill each room up to this many players; 0 disables bots. */
  botTarget: int(env.BOTS, 10),
  maxConnectionsPerIp: int(env.MAX_CONNECTIONS_PER_IP, 8),
  /** Honour X-Forwarded-For (only behind a proxy you control, e.g. a load balancer). */
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
  /** Comma-separated list of allowed WebSocket origins; empty allows any. */
  allowedOrigins: (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});
