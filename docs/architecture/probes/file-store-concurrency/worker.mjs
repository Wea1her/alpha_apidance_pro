import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const [repositoryRoot, artifactRootInput, writer] = process.argv.slice(2);
if (!repositoryRoot || !artifactRootInput || !['a', 'b'].includes(writer)) {
  throw new Error('Usage: worker.mjs <repository-root> <artifact-root> <a|b>');
}
const artifactRoot = resolve(artifactRootInput);
const originalReadFile = fs.readFile;
let active;
let blockedRead;

function safeTarget(filePath) {
  const target = resolve(filePath);
  if (!target.startsWith(`${artifactRoot}${sep}`)) {
    throw new Error('Refusing a data path outside this isolated artifact directory');
  }
  return target;
}

function send(message) {
  process.send?.({ ...message, writer });
}

// The store code is unchanged. Only the return of this exact synthetic-file
// read is paused, after the operating system has supplied its real contents.
fs.readFile = async function (...args) {
  const contents = await originalReadFile.apply(this, args);
  if (active?.controlled && !active.readCaptured && typeof args[0] === 'string'
      && resolve(args[0]) === active.filePath) {
    active.readCaptured = true;
    const raw = String(contents);
    const recordsSeen = active.store === 'project-state'
      ? Object.keys(JSON.parse(raw).projects).length
      : raw.split('\n').filter((line) => line.trim()).length;
    await new Promise((resume) => {
      blockedRead = { caseId: active.caseId, resume };
      send({ type: 'snapshot-read', caseId: active.caseId, recordsSeen, bytesRead: Buffer.byteLength(raw) });
    });
  }
  return contents;
};
syncBuiltinESMExports();

const { AnalysisArchiveStore } = await import(pathToFileURL(join(repositoryRoot, 'src/analysis-archive-store.ts')).href);
const { AnalysisTaskQueue } = await import(pathToFileURL(join(repositoryRoot, 'src/analysis-task-queue.ts')).href);
const { ProjectStateStore } = await import(pathToFileURL(join(repositoryRoot, 'src/project-state-store.ts')).href);

const timestamp = '2026-01-01T00:00:00.000Z';

async function operate(command) {
  const key = `synthetic-${command.caseId}-${writer}`;
  const messageId = writer === 'a' ? 1 : 2;
  if (command.store === 'archive') {
    const store = new AnalysisArchiveStore({ filePath: command.filePath });
    await store.upsert({
      version: 1,
      recordType: 'analysis',
      sourceTaskKey: key,
      projectKey: key,
      title: `Synthetic fixture ${writer}`,
      content: 'Synthetic local fixture only; no external requests.',
      link: `https://example.invalid/${key}`,
      mainPushedAt: timestamp,
      archivedAt: timestamp,
      analysisCreatedAt: timestamp,
      star: 1,
      count: 1,
      channelMessage: { chatId: -1000000001, messageId },
      discussionAnalysisMessage: { chatId: -1000000002, messageId },
      analysisText: `Synthetic analysis ${writer}`
    });
    return { key, acknowledged: true };
  }
  if (command.store === 'queue') {
    const queue = new AnalysisTaskQueue({
      filePath: command.filePath,
      deadLetterPath: join(dirname(command.filePath), 'synthetic-dead-letter.jsonl'),
      lockDir: join(dirname(command.filePath), 'synthetic-locks')
    });
    const acknowledged = await queue.enqueue({
      taskKey: key,
      projectKey: key,
      channelChatId: -1000000001,
      channelMessageId: messageId,
      title: `Synthetic fixture ${writer}`,
      content: 'Synthetic local fixture only; no external requests.',
      link: `https://example.invalid/${key}`,
      mainPushedAt: timestamp,
      count: 1,
      star: 1,
      kind: 'standard'
    }, new Date(timestamp));
    return { key, acknowledged };
  }
  if (command.store === 'project-state') {
    const store = new ProjectStateStore({ filePath: command.filePath });
    const state = await store.load();
    state.projects[key] = { star: 1, pushCount: 1, updatedAt: timestamp };
    await store.save(state);
    return { key, acknowledged: true };
  }
  throw new Error(`Unknown store: ${command.store}`);
}

process.on('message', (message) => {
  if (message.type === 'release-read') {
    if (!blockedRead || blockedRead.caseId !== message.caseId) {
      send({ type: 'protocol-error', error: 'No matching paused read', caseId: message.caseId });
      return;
    }
    const { resume } = blockedRead;
    blockedRead = undefined;
    resume();
    return;
  }
  if (message.type === 'shutdown') {
    if (active) {
      send({ type: 'protocol-error', error: 'Shutdown requested while an operation is active' });
      return;
    }
    fs.readFile = originalReadFile;
    syncBuiltinESMExports();
    process.disconnect();
    return;
  }
  if (message.type !== 'run') return;
  if (active) {
    send({ type: 'protocol-error', error: 'Overlapping operations in one worker', caseId: message.caseId });
    return;
  }
  active = { ...message, filePath: safeTarget(message.filePath), readCaptured: false };
  void (async () => {
    try {
      const result = await operate(active);
      const completed = { type: 'complete', caseId: active.caseId, ...result, error: null };
      active = undefined;
      send(completed);
    } catch (error) {
      const completed = {
        type: 'complete', caseId: active.caseId,
        acknowledged: false,
        error: { name: error.name, message: error.message, code: error.code ?? null }
      };
      active = undefined;
      send(completed);
    }
  })();
});

send({ type: 'ready', pid: process.pid });
