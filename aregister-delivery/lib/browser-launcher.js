'use strict';

const { chromium } = require('playwright');

/**
 * Concurrency-limited, hardened Chromium launcher.
 *
 * Every browser tab is ~200 MB. Under a burst — many customers hitting "Send
 * OTP" / verify at once, or PDF renders — unbounded `chromium.launch()` calls
 * would spawn dozens of Chromium processes and OOM the VM. This gates ALL
 * launches through a global semaphore: at most MPQR_MAX_CONCURRENT_BROWSERS run
 * at once; the rest queue and start as slots free up. A browser's slot is
 * released when it closes (we wrap .close()) OR when it disconnects (crash), so
 * a segfaulted Chromium can't permanently eat a slot and wedge the queue.
 */
const MAX = Math.max(1, parseInt(process.env.MPQR_MAX_CONCURRENT_BROWSERS || '4', 10));
const LAUNCH_TIMEOUT_MS = Math.max(10000, parseInt(process.env.MPQR_LAUNCH_TIMEOUT_MS || '30000', 10));

// Centralized launch hardening applied to EVERY launch:
//  - --disable-dev-shm-usage removes the Fly small-/dev/shm mid-render crash class.
//  - handleSIG*:false makes the app's own drainAndExit the sole teardown
//    orchestrator, so a deploy's SIGTERM stops pre-empting in-flight verifies.
//  - background-throttle flags relieve the shared vCPU across concurrent browsers.
//  - A hard launch timeout turns a hung launch into a normal rejection.
// NOTE: deliberately NO --no-sandbox — the Dockerfile keeps the sandbox (runuser→pwuser).
const HARDENED = {
  handleSIGINT: false,
  handleSIGTERM: false,
  handleSIGHUP: false,
  timeout: LAUNCH_TIMEOUT_MS,
  args: [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,BackForwardCache',
    '--no-first-run',
    '--mute-audio',
  ],
};

let active = 0;
const queue = [];

function _merge(opts) {
  return { ...HARDENED, ...opts, args: [...HARDENED.args, ...((opts && opts.args) || [])] };
}

function _pump() {
  while (active < MAX && queue.length) {
    const { opts, resolve, reject } = queue.shift();
    active++;
    chromium.launch(_merge(opts)).then(
      (browser) => {
        let released = false;
        const release = () => { if (!released) { released = true; active--; _pump(); } };
        const origClose = browser.close.bind(browser);
        browser.close = async (...args) => {
          try { return await origClose(...args); }
          finally { release(); }
        };
        // A killed/segfaulted Chromium emits 'disconnected' WITHOUT close() ever
        // running — release the slot here too, reusing the SAME `released` flag so
        // `active` can never go negative (double-release → over-launch → OOM).
        browser.on('disconnected', release);
        resolve(browser);
      },
      (err) => { active--; _pump(); reject(err); },
    );
  }
}

/** Drop-in for chromium.launch(opts) that respects the global concurrency cap. */
function launchBrowser(opts = {}) {
  return new Promise((resolve, reject) => { queue.push({ opts, resolve, reject }); _pump(); });
}

function browserStats() {
  return { active, queued: queue.length, max: MAX };
}

module.exports = { launchBrowser, browserStats };
