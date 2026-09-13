import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const artifactRoot = await fs.mkdtemp(join(tmpdir(), 'alpha-file-store-stress-'));
const repositoryRoot = resolve(process.argv[2] ?? process.cwd());
const runDirectory = await fs.mkdtemp(join(artifactRoot, 'run-'));
const workers = [];
const cases = [];
const sourcePaths = [
  'src/analysis-archive-store.ts',
  'src/analysis-task-queue.ts',
  'src/project-state-store.ts'
];

function startWorker(writer) {
  const child = spawn(process.execPath, [
    '--experimental-strip-types',
    join(scriptRoot, 'worker.mjs'),
    repositoryRoot, artifactRoot, writer
  ], {
    cwd: repositoryRoot,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const pending = [];
  const history = [];
  const worker = { child, writer, stdout: '', stderr: '', exitCode: null, exitSignal: null };
  child.stdout.on('data', (chunk) => { worker.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { worker.stderr += chunk.toString(); });
  child.on('message', (message) => {
    const index = pending.findIndex((waiter) => waiter.matches(message));
    if (index === -1) history.push(message);
    else {
      const [waiter] = pending.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  worker.exited = new Promise((resolveExit) => {
    child.on('exit', (code, signal) => {
      worker.exitCode = code;
      worker.exitSignal = signal;
      for (const waiter of pending.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`Worker ${writer} exited before expected IPC response: ${code}/${signal}`));
      }
      resolveExit();
    });
  });
  child.on('error', (error) => {
    for (const waiter of pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });
  worker.waitFor = (type, caseId) => {
    const matches = (message) => message.type === type && (caseId === undefined || message.caseId === caseId);
    const index = history.findIndex(matches);
    if (index !== -1) return Promise.resolve(history.splice(index, 1)[0]);
    return new Promise((resolveMessage, reject) => {
      const waiter = { matches, resolve: resolveMessage, reject };
      waiter.timer = setTimeout(() => {
        const pendingIndex = pending.indexOf(waiter);
        if (pendingIndex !== -1) pending.splice(pendingIndex, 1);
        reject(new Error(`Timed out waiting for worker ${writer}: ${type}/${caseId ?? ''}`));
      }, 10_000);
      pending.push(waiter);
    });
  };
  worker.send = (message) => child.send(message);
  workers.push(worker);
  return worker;
}

async function seedFixture(store, filePath) {
  const contents = store === 'project-state' ? '{"version":1,"projects":{}}\n' : '';
  await fs.writeFile(filePath, contents, 'utf8');
}

async function inspectFixture(store, filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  if (store === 'project-state') return Object.keys(JSON.parse(raw).projects).sort();
  const records = raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  return records.map((record) => store === 'archive' ? record.sourceTaskKey : record.taskKey).sort();
}

let harnessError = null;
try {
  const a = startWorker('a');
  const b = startWorker('b');
  await Promise.all([a.waitFor('ready'), b.waitFor('ready')]);

  for (const store of ['archive', 'queue', 'project-state']) {
    for (const mode of ['sequential', 'controlled-overlap']) {
      const caseId = `${store}-${mode}`;
      const directory = join(runDirectory, caseId);
      await fs.mkdir(directory);
      const filePath = join(directory, store === 'project-state' ? 'fixture.json' : 'fixture.jsonl');
      await seedFixture(store, filePath);
      const run = { type: 'run', caseId, store, filePath, controlled: mode === 'controlled-overlap' };
      const completions = [];
      const snapshots = [];
      if (mode === 'sequential') {
        a.send(run);
        completions.push(await a.waitFor('complete', caseId));
        b.send(run);
        completions.push(await b.waitFor('complete', caseId));
      } else {
        a.send(run);
        b.send(run);
        snapshots.push(...await Promise.all([
          a.waitFor('snapshot-read', caseId),
          b.waitFor('snapshot-read', caseId)
        ]));
        // Both processes have read the real empty file. A commits completely,
        // then B commits its already-read stale snapshot. No writes are mocked.
        a.send({ type: 'release-read', caseId });
        completions.push(await a.waitFor('complete', caseId));
        b.send({ type: 'release-read', caseId });
        completions.push(await b.waitFor('complete', caseId));
      }
      const expectedKeys = ['a', 'b'].map((writer) => `synthetic-${caseId}-${writer}`);
      const actualKeys = await inspectFixture(store, filePath);
      const errors = completions.filter((item) => item.error).map((item) => ({ writer: item.writer, ...item.error }));
      const result = {
        caseId, store, mode, fixtureFile: filePath,
        expectedRecordCount: expectedKeys.length,
        actualRecordCount: actualKeys.length,
        acknowledgedOperations: completions.filter((item) => item.acknowledged).length,
        expectedKeys, actualKeys,
        missingKeys: expectedKeys.filter((key) => !actualKeys.includes(key)),
        errors, snapshots, completions,
        lostUpdateReproduced: mode === 'controlled-overlap' && errors.length === 0
          && completions.every((item) => item.acknowledged) && actualKeys.length < expectedKeys.length
      };
      cases.push(result);
      process.stdout.write(`${caseId}: expected=${result.expectedRecordCount} actual=${result.actualRecordCount} acknowledged=${result.acknowledgedOperations} errors=${errors.length}\n`);
    }
  }
} catch (error) {
  harnessError = { name: error.name, message: error.message };
} finally {
  for (const worker of workers) {
    if (worker.child.exitCode === null && worker.child.connected) {
      if (harnessError) worker.child.kill('SIGTERM');
      else worker.send({ type: 'shutdown' });
    }
  }
  await Promise.all(workers.map((worker) => worker.exited));
}

const sourceHashes = {};
for (const relativePath of sourcePaths) {
  sourceHashes[relativePath] = createHash('sha256').update(await fs.readFile(join(repositoryRoot, relativePath))).digest('hex');
}
const reproducedStores = cases.filter((item) => item.lostUpdateReproduced).map((item) => item.store);
const interpretation = reproducedStores.length
  ? `Acknowledged lost updates were reproduced for: ${reproducedStores.join(', ')}. Inspect actualKeys and missingKeys for the exact retained and lost records.`
  : 'No acknowledged lost update was reproduced in completed cases. Check harnessError and individual outcomes before drawing a conclusion.';
const summary = {
  experiment: 'Controlled two-process lost-update reproduction using current real file stores',
  executedAt: new Date().toISOString(),
  repositoryRoot, runDirectory, nodeVersion: process.version,
  childProcessCount: workers.length,
  totalSyntheticRecordSubmissions: cases.length * 2,
  noNetworkOrRealServiceOperations: true,
  sourceHashes,
  interpretation,
  method: 'Pause only the return of a real read of an isolated synthetic fixture, until both processes have the old snapshot; complete writer A, then release writer B. All store validation, record construction, writes and renames are real and unchanged.',
  limitation: 'This controlled schedule can establish an allowed lost-update interleaving. It is not a throughput benchmark, a measured production incident rate, or a validation of frontend SLOs.',
  projectStateScope: 'ProjectStateStore load-edit-save is a caller-level read/modify/write sequence; save is a whole-state replacement API. This demonstrates absence of a store-provided concurrent merge guarantee.',
  cases,
  workers: workers.map(({ writer, exitCode, exitSignal, stdout, stderr }) => ({ writer, exitCode, exitSignal, stdout, stderr })),
  harnessError
};
await fs.writeFile(join(runDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
const table = [
  '| Store | Scheduling | Expected records | Actual records | Acknowledged writes | Errors |',
  '| --- | --- | ---: | ---: | ---: | ---: |',
  ...cases.map((item) => `| ${item.store} | ${item.mode} | ${item.expectedRecordCount} | ${item.actualRecordCount} | ${item.acknowledgedOperations} | ${item.errors.length} |`)
].join('\n');
const markdown = [
  'Controlled reproduction: concurrent file-store updates',
  '',
  `Executed: ${summary.executedAt}; Node ${process.version}; two reusable child processes; ${summary.totalSyntheticRecordSubmissions} synthetic record submissions.`,
  '',
  summary.method,
  '',
  table,
  '',
  summary.limitation,
  '',
  summary.projectStateScope,
  '',
  'Sequential controls read after the preceding writer has committed. Controlled-overlap cases force both writers to read the original empty fixture before either commits.',
  '',
  interpretation,
  '',
  `Reproduce: node ${join(scriptRoot, 'reproduce.mjs')} ${repositoryRoot}`,
  '',
  'The runner creates a new isolated directory under the OS temporary directory for each invocation. It never opens configured production data files and never invokes the service, model client, Telegram client, or a worker poll loop.',
  '',
  `Harness error: ${harnessError ? JSON.stringify(harnessError) : 'none'}`,
  ''
].join('\n');
await fs.writeFile(join(runDirectory, 'summary.md'), markdown, 'utf8');
process.stdout.write(`SUMMARY_JSON=${join(runDirectory, 'summary.json')}\nSUMMARY_MARKDOWN=${join(runDirectory, 'summary.md')}\n`);
if (harnessError || cases.length !== 6 || cases.some((item) => item.errors.length)
    || cases.some((item) => item.mode === 'sequential' && item.actualRecordCount !== 2)) {
  process.exitCode = 1;
}
