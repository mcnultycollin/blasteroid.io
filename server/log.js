/** Minimal levelled logger. Set LOG_LEVEL to debug, info, warn, error or silent. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function emit(level, write, message) {
  const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
  if (LEVELS[level] >= threshold) write(`${new Date().toISOString()} ${level.toUpperCase()} ${message}`);
}

export const log = {
  debug: (message) => emit('debug', console.log, message),
  info: (message) => emit('info', console.log, message),
  warn: (message) => emit('warn', console.warn, message),
  error: (message) => emit('error', console.error, message),
};
