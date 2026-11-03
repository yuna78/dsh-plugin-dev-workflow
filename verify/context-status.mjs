// Real exported tool chain with synthetic verification/acknowledgement inputs.
// No shell commands, model calls or real user approvals are performed.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineDevTools, readBoard } from '../index.js';

const results = [];
async function check(name, run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-context-status-'));
  const tools = new Map(defineDevTools({}, { projectRoot: root }).map(tool => [tool.name, tool]));
  const call = (name, args = {}) => tools.get(name).execute(args, {});
  const plan = title => call('dev_task_plan', { title, acceptance: ['synthetic fixture'] });
  const succeed = async title => {
    const task = await plan(title);
    const verification = await call('dev_verify', { taskId: task.id, command: 'synthetic record, NOT executed', exitCode: 0 });
    assert.equal(verification.status, 'passed');
    const completion = await call('dev_complete', { taskId: task.id, summary: 'synthetic fixture', userAck: true });
    assert.equal(completion.status, 'succeeded');
    return task.id;
  };
  try {
    const observation = await run({ call, plan, succeed, root });
    results.push({ name, pass: true, observation });
  } catch (error) {
    results.push({ name, pass: false, error: error.message });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await check('newer succeeded tasks must not evict an older unfinished task', async ({ call, plan, succeed, root }) => {
  const unfinished = await plan('unfinished first');
  const completedIds = [];
  for (let i = 0; i < 10; i += 1) completedIds.push(await succeed(`completed ${i}`));
  const context = await call('dev_context_get');
  const returnedIds = context.context.tasks.map(task => task.taskId);
  assert.deepEqual(returnedIds, [unfinished.id]);
  assert.ok(!returnedIds.some(id => completedIds.includes(id)));
  assert.match(context.text, /：1 个未完成任务/);
  assert.equal(readBoard(root).counts.openTasks, 1);
  assert.equal(readBoard(root).counts.closedTasks, 10);
  return { unfinishedReturned: true, completedReturned: 0, unfinishedCount: 1 };
});

await check('a project containing only succeeded tasks has no unfinished context', async ({ call, succeed }) => {
  for (let i = 0; i < 12; i += 1) await succeed(`completed ${i}`);
  const context = await call('dev_context_get');
  assert.deepEqual(context.context.tasks, []);
  assert.match(context.text, /：0 个未完成任务/);
  return { returned: 0, unfinishedCount: 0 };
});

await check('apply custom context limit after filtering, preserving latest open IDs and full count', async ({ call, plan, succeed }) => {
  const unfinishedIds = [];
  for (let i = 0; i < 4; i += 1) unfinishedIds.push((await plan(`unfinished ${i}`)).id);
  for (let i = 0; i < 20; i += 1) await succeed(`completed ${i}`);
  const context = await call('dev_context_get', { limit: 2 });
  assert.deepEqual(context.context.tasks.map(task => task.taskId), unfinishedIds.slice(-2));
  assert.match(context.text, /：4 个未完成任务/);
  return { returned: 2, unfinishedCount: 4, latestOpenIdsMatch: true };
});

console.log(JSON.stringify({ method: 'exported tool-chain regression with strict task-ID and completion-status assertions', results }, null, 2));
process.exitCode = results.every(result => result.pass) ? 0 : 1;
