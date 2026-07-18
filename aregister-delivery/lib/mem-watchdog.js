'use strict';

/**
 * RSS-ceiling memory watchdog.
 * Each live headless Chromium is ~150-350 MB; a burst can push the 2 GB VM to an
 * uncontrolled kernel OOM-kill (SIGKILL bypasses graceful drain → every in-flight
 * verify dies). This watches RSS and, before that point, (a) sheds NEW work and
 * (b) once nothing is in flight, triggers an ORDERLY drained restart.
 *
 * MUST gate the exit on inflight===0 (and warming===0) or it becomes the very
 * interruption it prevents. The ceiling must sit above real steady-state RSS or
 * it restart-loops.
 */
function startMemWatchdog({
  ceilingMb = Number(process.env.MPQR_RSS_CEILING_MB || 1600),
  intervalMs = 15000,
  getInflight = () => 0,
  getWarming = () => 0,
  onShed = () => {},
  onDrain = () => {},
  logger = console,
} = {}) {
  const ceil = ceilingMb * 1024 * 1024;
  let shedding = false;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss <= ceil) {
      if (shedding) { shedding = false; onShed(false); }
      return;
    }
    if (!shedding) { shedding = true; onShed(true); (logger.warn || logger.log)('[mem] RSS ceiling exceeded — shedding new work', Math.round(rss / 1048576) + 'MB'); }
    const inflight = Number(getInflight() || 0);
    const warming = Number(getWarming() || 0);
    if (inflight === 0 && warming === 0) {
      (logger.warn || logger.log)('[mem] idle at high RSS — orderly drain+restart');
      onDrain('RSS');
    }
  }, intervalMs);
  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

module.exports = { startMemWatchdog };
