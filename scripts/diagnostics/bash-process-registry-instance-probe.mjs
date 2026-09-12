/**
 * Probe: is the bash process registry one instance per process, or one per bundle?
 *
 * Loads the two shipped bundles that each initialise the registry in ONE process:
 *   - dist/bash-process-registry-<hash>.mjs   (the shared chunk the Gateway imports)
 *   - dist/worker/worker.mjs                  (a self-contained bundle: no import of the chunk)
 *
 * Each module evaluation publishes its own test API into the SAME global symbol, so the
 * number of publications is the number of registry instances that ran their module body.
 * `resetProcessRegistryForTests()` closes over that instance's own Maps, so calling one
 * instance's reset and observing the other instance's state proves whether they are shared.
 */
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DIST = "/opt/homebrew/lib/node_modules/openclaw/dist";
const SYMBOL = Symbol.for("openclaw.bashProcessRegistryTestApi");

// The registry only publishes its test API under VITEST (the dist guard is
// `process.env.VITEST || false`, the NODE_ENV branch having been compiled out).
process.env.VITEST = "1";
// Worker bundle entry refuses unexpected argv, and prewarm mode loads without running work.
process.argv = [process.argv[0], "worker.mjs", "--internal-worker-prewarm"];

const publications = [];
let current;
Object.defineProperty(globalThis, SYMBOL, {
  configurable: true,
  enumerable: false,
  get: () => current,
  set: (value) => {
    publications.push(value);
    current = value;
  },
});

const chunkFile = readdirSync(DIST).find(
  (name) => name.startsWith("bash-process-registry-") && name.endsWith(".mjs"),
);

const chunk = await import(pathToFileURL(`${DIST}/${chunkFile}`).href);
const afterChunk = publications.length;
const chunkApi = current;

await import(pathToFileURL(`${DIST}/worker/worker.mjs`).href);
const afterWorker = publications.length;
const workerApi = current;

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

record(
  "each bundle evaluated its own registry module",
  afterChunk === 1 && afterWorker === 2,
  `test-API publications: after chunk=${afterChunk}, after worker=${afterWorker}`,
);
record(
  "the two readers hold different module-instance handles",
  Boolean(chunkApi) && Boolean(workerApi) && chunkApi !== workerApi,
  `chunk instance ${chunkApi === workerApi ? "===" : "!=="} worker instance`,
);

const SESSION_ID = "probe-session-1";
const SCOPE_KEY = "agent:main:probe-scope";
chunk.addSession({
  id: SESSION_ID,
  command: "probe",
  scopeKey: SCOPE_KEY,
  cleanupMs: 60_000,
  aggregated: "",
  tail: "",
  backgrounded: true,
  exited: false,
  truncated: false,
  cursorKeyMode: "unknown",
  startedAt: Date.now(),
});

const chunkSeesIt = chunk.listRunningSessions().some((s) => s.id === SESSION_ID);
const chunkScopeSeesIt = chunk.listRunningSessions().some((s) => s.scopeKey === SCOPE_KEY);

// Reset through the OTHER instance. If the Maps were shared this would clear the session.
workerApi.resetProcessRegistryForTests();
const afterWorkerReset = chunk.listRunningSessions().some((s) => s.id === SESSION_ID);

record(
  "a session admitted through one instance is visible to that instance",
  chunkSeesIt && chunkScopeSeesIt,
  `listRunningSessions() has id=${chunkSeesIt} scopeKey=${chunkScopeSeesIt}`,
);
record(
  "resetting the other instance does NOT clear it (state is not shared)",
  afterWorkerReset === true,
  afterWorkerReset
    ? "session survived the other instance's reset -> separate Maps"
    : "session was cleared by the other instance's reset -> shared Maps",
);

// Control: resetting the SAME instance must clear it, or the check above proves nothing.
chunkApi.resetProcessRegistryForTests();
const afterOwnReset = chunk.listRunningSessions().some((s) => s.id === SESSION_ID);
record(
  "control: resetting the owning instance DOES clear it",
  afterOwnReset === false,
  afterOwnReset ? "own reset did not clear -> probe is unsound" : "own reset cleared the session",
);

console.log(JSON.stringify({ chunkFile, publications: publications.length, results }, null, 2));
process.exit(results.every((r) => r.ok) ? 0 : 1);
