/**
 * Shared dev-server bring-up for every tool in tools/.
 *
 * WHY THIS EXISTS. The tools used to default to port 5173 and reuse whatever was
 * already listening. That is fine for one developer and actively wrong once
 * more than one process is working in the same checkout:
 *
 *   1. The squatting server has HMR on. Anything saving a file mid-run
 *      navigates the page out from under playwright, and the tool dies with
 *      "Execution context was destroyed, most likely because of a navigation"
 *      or a waitForFunction timeout.
 *   2. Worse, and silently: that server serves ITS OWN working tree, so a
 *      screenshot can be a picture of somebody's half-saved edit and nothing in
 *      the output would say so.
 *
 * (1) cost real time more than once, and serving `dist/` instead is only a
 * workaround. So: unless a caller passes an explicit --port, every tool now
 * brings up its OWN vite, HMR disabled, on a private port.
 *
 *   const { port, server } = await startServer({ explicitPort: args.port });
 *   ... use `http://127.0.0.1:${port}/` ...
 *   stopServer(server);
 *
 * `server?.kill()` (what every existing caller does) still works — the module
 * reaps anything still live on exit, on SIGINT/SIGTERM/SIGHUP and on an uncaught
 * throw, so callers do not have to be updated one by one. See `stopServer`.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import net from 'node:net';

export const portOpen = (port) =>
  new Promise((res) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => (s.destroy(), res(true)));
    s.on('error', () => res(false));
    s.setTimeout(400, () => (s.destroy(), res(false)));
  });

async function freePort() {
  for (let i = 0; i < 300; i++) {
    const p = 5200 + Math.floor(Math.random() * 700);
    if (!(await portOpen(p))) return p;
  }
  throw new Error('no free port in 5200-5900');
}

/**
 * @param {object} opts
 * @param {number|string} [opts.explicitPort] honour a caller-supplied port and
 *        reuse whatever is listening there (opt in to the old behaviour).
 * @param {string} [opts.root] repo root; defaults to the parent of tools/.
 * @returns {Promise<{port:number, server:import('node:child_process').ChildProcess|null}>}
 */
export async function startServer({ explicitPort, root } = {}) {
  const ROOT = root ?? resolve(import.meta.dirname, '..', '..');

  if (explicitPort) {
    const p = Number(explicitPort);
    if (await portOpen(p)) return { port: p, server: null };
    return { port: p, server: await spawnVite(ROOT, p) };
  }

  const port = await freePort();
  return { port, server: await spawnVite(ROOT, port) };
}

/**
 * Every server this module starts, so they can all be reaped on the way out.
 * @type {Set<import('node:child_process').ChildProcess>}
 */
const LIVE = new Set();

/**
 * Kill a server AND everything it spawned.
 *
 * `server.kill()` alone leaks. It signals the direct child only, and it never
 * runs at all when the tool is interrupted — a bash timeout, a Ctrl-C, an
 * uncaught throw — so orphaned vites accumulate silently in the checkout.
 *
 * They are not harmless. Each one keeps a file watcher and an esbuild worker
 * alive, and MEASURED here: ten strays took `perfcheck` from
 * 43 fps to 18. Every performance number taken after that is fiction, and there
 * is nothing in any tool's output to say so. That makes this the most expensive
 * kind of bug — one that corrupts other people's measurements rather than
 * failing loudly.
 *
 * So: the child gets its own process group (`detached: true`) and the GROUP is
 * killed, which takes vite's own workers with it.
 */
export function stopServer(server) {
  if (!server) return;
  // Deliberately NOT gated on `server.killed`. The 39 existing callers all do
  // `server?.kill()`, which sets `killed = true` immediately whether or not the
  // process actually died — so gating on it would skip the group kill for every
  // caller in the repo and fix nothing. `_owReaped` records that THIS function
  // has taken the group down, which is the thing that is actually idempotent.
  if (server._owReaped) return;
  server._owReaped = true;
  LIVE.delete(server);
  try {
    // Negative pid = the whole process group.
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    try { server.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

let hooked = false;
function hookCleanup() {
  if (hooked) return;
  hooked = true;
  const reap = () => { for (const s of [...LIVE]) stopServer(s); };
  process.on('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { reap(); process.exit(130); });
  }
  process.on('uncaughtException', (e) => { reap(); console.error(e); process.exit(1); });
}

async function spawnVite(ROOT, port) {
  hookCleanup();
  const server = spawn(
    resolve(ROOT, 'node_modules/.bin/vite'),
    ['--port', String(port), '--strictPort'],
    {
      cwd: ROOT,
      stdio: 'ignore',
      // Own process group, so stopServer can take the whole tree down.
      detached: true,
      // vite.config.js turns HMR off when this is set.
      env: { ...process.env, OW_NO_HMR: '1' },
    }
  );
  server.unref();
  LIVE.add(server);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await portOpen(port)) return server;
  }
  stopServer(server);
  throw new Error(`vite failed to start on ${port}`);
}
