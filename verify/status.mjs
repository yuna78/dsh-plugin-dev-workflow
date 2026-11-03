// Synthetic records only. No commands, user approvals, model or DSH server.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineDevTools, readBoard, registerBoardRoute } from '../index.js';

let definition;
new Function('window', readFileSync(new URL('../client.js', import.meta.url), 'utf8'))({
  __ModuleLoader__: { load(value) { definition = value; } },
});
const view = definition.factory(() => ({ createElement: (type, props, ...children) => ({ type, props, children }) })).__board;
const results = [];
const temporaryRoots = [];
const temporaryRoot = prefix => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};
async function check(name, run) {
  try { await run(); results.push({ name, pass: true }); }
  catch (error) { results.push({ name, pass: false, error: error.message }); }
}
function fixture(tasks, completions, dataRoot) {
  const root = temporaryRoot('dsh-status-contract-');
  const dir = dataRoot ?? join(root, '.dsh-dev');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'tasks.jsonl'), tasks.map(t => JSON.stringify({ acceptance: ['synthetic'], title: t.taskId, ...t })).join('\n') + '\n');
  writeFileSync(join(dir, 'completions.jsonl'), completions.map(t => JSON.stringify(t)).join('\n') + '\n');
  const tools = new Map(defineDevTools({}, { projectRoot: root, dataRoot }).map(t => [t.name, t]));
  return { root, dir, context: () => tools.get('dev_context_get').execute({ limit: 20 }, {}) };
}

for (const [stored, completion, status, closed, column, label] of [
  ['queued', null, 'queued', false, 'queued', '待办'],
  ['waiting-user', null, 'waiting-user', false, 'waiting', '待确认'],
  ['queued', 'waiting-user', 'waiting-user', false, 'waiting', '待确认'],
  ['queued', 'partial', 'partial', false, 'queued', '部分完成'],
  ['queued', 'succeeded', 'succeeded', true, 'closed', '已完成'],
  ['succeeded', null, 'succeeded', true, 'closed', '已完成'],
  ['cancelled', null, 'cancelled', true, 'closed', '已取消'],
  ['cancelled', 'waiting-user', 'cancelled', true, 'closed', '已取消'],
  ['succeeded', 'partial', 'succeeded', true, 'closed', '已完成'],
  ['queued', 'unknown', 'queued', false, 'queued', '待办'],
]) {
  await check(`${stored} + ${completion}: ${status}`, async () => {
    const f = fixture([{ taskId: 'task', status: stored }], completion ? [{ taskId: 'task', status: completion }] : []);
    const before = ['tasks.jsonl', 'completions.jsonl'].map(file => readFileSync(join(f.dir, file), 'utf8'));
    const board = readBoard(f.root);
    const task = board.tasks[0];
    assert.equal(task.status, status);
    assert.equal(task.storedStatus, stored);
    assert.equal(task.closed, closed);
    assert.equal(view.taskColumn(task), column);
    assert.equal(board.counts.openTasks, closed ? 0 : 1);
    assert.equal(board.counts.closedTasks, closed ? 1 : 0);
    const context = (await f.context()).context.tasks;
    assert.equal(context.length, closed ? 0 : 1);
    if (!closed) assert.equal(context[0].status, status);
    for (const filter of ['open', 'closed', 'all']) {
      const v = view.collect(board, filter);
      const items = v.columns.flatMap(c => c.items);
      assert.equal(items.length, filter === 'all' || (filter === 'closed') === closed ? 1 : 0);
      if (items.length) assert.equal(items[0].meta, `1 条验收 · ${label}`);
      assert.deepEqual(v.counts, { open: closed ? 0 : 1, closed: closed ? 1 : 0, all: 1 });
    }
    assert.deepEqual(['tasks.jsonl', 'completions.jsonl'].map(file => readFileSync(join(f.dir, file), 'utf8')), before);
  });
}
await check('last completion line wins, including transition back to partial', async () => {
  for (const statuses of [['partial', 'waiting-user', 'succeeded'], ['succeeded', 'partial']]) {
    const f = fixture([{ taskId: 'task', status: 'queued' }], statuses.map(status => ({ taskId: 'task', status })));
    const task = readBoard(f.root).tasks[0];
    assert.equal(task.status, statuses.at(-1));
    assert.equal((await f.context()).context.tasks.length, task.closed ? 0 : 1);
  }
});
await check('duplicate task lines and orphan completions do not inflate counts', async () => {
  const f = fixture([{ taskId: 'task', status: 'queued' }, { taskId: 'task', status: 'waiting-user' }], [{ taskId: 'missing', status: 'succeeded' }]);
  assert.equal(readBoard(f.root).counts.tasks, 1);
  assert.equal(readBoard(f.root).tasks[0].status, 'waiting-user');
});
await check('custom dataRoot and registered HTTP route agree with context', async () => {
  const dir = temporaryRoot('dsh-status-custom-');
  const f = fixture([{ taskId: 'task', status: 'queued' }], [{ taskId: 'task', status: 'waiting-user' }], dir);
  let route;
  registerBoardRoute({ connection: { fetch: { register(spec) { route = spec; } } } }, { dataRoot: dir });
  const response = await route.fetch(new Request(`http://localhost/api/dsh-dev-assistant.board?root=${encodeURIComponent(f.root)}`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).tasks[0].status, (await f.context()).context.tasks[0].status);
});
await check('context filtering occurs before limit; board windows never hide open tasks', async () => {
  const tasks = Array.from({ length: 60 }, (_, i) => ({ taskId: `task_${i}`, status: 'queued' }));
  const completions = tasks.map((t, i) => ({ taskId: t.taskId, status: i < 10 ? 'waiting-user' : 'succeeded' }));
  const f = fixture(tasks, completions);
  const board = readBoard(f.root, { closedLimit: 1 });
  assert.equal(board.counts.openTasks, 10);
  assert.equal(board.counts.closedTasks, 50);
  assert.equal(board.tasks.filter(t => !t.closed).length, 10);
  assert.equal(board.tasks.filter(t => t.closed).length, 1);
  assert.equal(board.window.closedTasks.total, 50);
  const context = (await f.context()).context.tasks;
  assert.equal(context.length, 10);
  assert.ok(context.every(t => t.status === 'waiting-user'));
});
for (const name of ['real-wordfall', 'real-existing-project']) {
  await check(`equivalent redacted historical replay: ${name}`, async () => {
    const history = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));
    const f = fixture(history.tasks.map(t => ({ taskId: t.id, status: t.status })), history.tasks.filter(t => t.completionStatus).map(t => ({ taskId: t.id, status: t.completionStatus })));
    const board = readBoard(f.root);
    assert.equal(board.counts.closedTasks, 0);
    assert.equal(board.counts.openTasks, history.tasks.length);
    const context = (await f.context()).context.tasks;
    assert.equal(context.length, history.tasks.length);
    assert.equal(view.collect(board, 'open', { queued: 20, waiting: 20 }).columns.find(c => c.id === 'waiting').items.length, history.tasks.filter(t => t.completionStatus === 'waiting-user').length);
    assert.deepEqual(board.tasks.map(t => [t.id, t.status]).sort(), context.map(t => [t.taskId, t.status]).sort());
  });
}
console.log(JSON.stringify({ method: 'real host exports and client view-model; synthetic and equivalent redacted historical fixtures', results }, null, 2));
for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
process.exitCode = results.every(r => r.pass) ? 0 : 1;
