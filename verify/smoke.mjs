import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defineDevTools, installReminder, renderReminder, readBoard, registerBoardRoute, BOARD_ROUTE } from '../index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'assets/icon.svg'];
for (const file of required) {
  if (!existsSync(join(root, file))) throw new Error(`missing required file: ${file}`);
}
if (pkg.name !== 'dsh-plugin-dev-workflow') throw new Error(`unexpected package name: ${pkg.name}`);
if (pkg.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('invalid dsh.bundle.patch');
if (pkg.dsh?.client?.platform !== 'web') throw new Error('client half must declare platform web');
if (pkg.exports?.['./client'] !== './client.js') throw new Error('client half must be exported as ./client');
if (!pkg.files?.includes('client.js')) throw new Error('client.js must ship in the package');
if (pkg.icon !== 'assets/icon.svg') throw new Error('icon must be declared');
if (!pkg.files?.includes('assets/icon.svg')) throw new Error('icon must be included in files');
if (!pkg.files?.includes('CHANGELOG.md')) throw new Error('CHANGELOG.md must ship in the package');
// Release notes and docs must name the published version, or consumers retag wrongly.
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
if (!readme.includes(pkg.version)) throw new Error(`README.md does not mention version ${pkg.version}`);
if (!changelog.includes(`## [${pkg.version}]`)) throw new Error(`CHANGELOG.md has no section for ${pkg.version}`);
const check = spawnSync(process.execPath, ['--check', join(root, 'index.js')], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status ?? 1);
const clientCheck = spawnSync(process.execPath, ['--check', join(root, 'client.js')], { stdio: 'inherit' });
if (clientCheck.status !== 0) process.exit(clientCheck.status ?? 1);

// --- preset composition: the web shell disables host-plane tool rows, so a
// preset that cannot run commands can never satisfy dev_verify's contract.
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
for (const row of ['dsh-plugin-dev-workflow', 'dsh-tool-bash', 'dsh-tool-pwsh', 'dsh-tool-fs', 'dsh-agent-instructions']) {
  if (!patch.includes(row)) throw new Error(`preset is missing required row: ${row}`);
}
if (!patch.includes('id: dev-assistant')) throw new Error('preset id dev-assistant missing');

// --- behaviour: tools must run against a real host-shaped execution context ---
const dir = mkdtempSync(join(tmpdir(), 'dsh-dev-smoke-'));
try {
  // Mimic @deepseek-ai/dsh-session-projection: stateOf(session) reads the live
  // Session object. Passing a string id is exactly the regression this guards.
  const session = { header: { cwd: dir }, snapshotEvents() { return []; } };
  const ctx = {
    workingDirectory: {
      get(candidate) {
        if (typeof candidate?.snapshotEvents !== 'function') {
          throw new TypeError('session.snapshotEvents is not a function');
        }
        return candidate.header.cwd;
      },
    },
  };
  const exec = { agent: { id: 'session-smoke', session } };
  const tools = new Map(defineDevTools(ctx).map((tool) => [tool.name, tool]));
  for (const name of ['dev_context_get', 'dev_request_capture', 'dev_request_close', 'dev_feedback_record', 'dev_task_plan', 'dev_verify', 'dev_complete', 'dev_knowledge_promote']) {
    if (!tools.has(name)) throw new Error(`missing tool: ${name}`);
  }

  const request = await tools.get('dev_request_capture').execute(
    { rawQuote: '把登录页的错误提示改得更清楚', acceptance: ['空密码显示字段级提示'] },
    exec,
  );
  if (request.status !== 'captured') throw new Error(`request not captured: ${request.status}`);

  const feedback = await tools.get('dev_feedback_record').execute(
    { rawQuote: '文案要短一些', requestId: request.id, category: 'quality', decision: 'accept' },
    exec,
  );
  if (feedback.status !== 'recorded') throw new Error(`feedback not recorded: ${feedback.status}`);

  const task = await tools.get('dev_task_plan').execute(
    { requestId: request.id, title: '更新登录错误提示', acceptance: ['单元测试覆盖两种错误分支'] },
    exec,
  );
  if (task.status !== 'queued') throw new Error(`task not queued: ${task.status}`);

  const verify = await tools.get('dev_verify').execute(
    { taskId: task.id, command: 'npm test -- smoke', exitCode: 0, summary: 'all green' },
    exec,
  );
  if (verify.status !== 'passed') throw new Error(`verification not passed: ${verify.status}`);

  const complete = await tools.get('dev_complete').execute({ taskId: task.id, summary: '登录错误提示已更新' }, exec);
  if (complete.status !== 'waiting-user') throw new Error(`completion should await user ack: ${complete.status}`);

  const context = await tools.get('dev_context_get').execute({}, exec);
  if (context.context.tasks.length !== 1) throw new Error('context did not report the task');
  if (context.context.feedback.length !== 1) throw new Error('context did not report the feedback');

  // --- runtime reminder: the persona paragraph is one line at the top of a
  // long context. A real session proved it is not enough (dev_context_get at
  // +1s, dev_request_capture only at +86s), so the reminder must ride in the
  // request history — and it must carry the counts it claims.
  if (!/^\s*reminder:\s*true$/m.test(patch)) throw new Error('preset must enable the runtime reminder');
  if (!/^\s*reminderEverySteps:\s*5$/m.test(patch)) throw new Error('preset must declare reminderEverySteps');
  for (const directive of ['dev_request_capture', 'dev_feedback_record', '前 2 次工具调用内必须']) {
    if (!patch.includes(directive)) throw new Error(`persona is missing the ordering directive: ${directive}`);
  }

  const listeners = [];
  installReminder({ on(event, listener) { listeners.push({ event, listener }); return () => listeners.pop(); } }, { reminderEverySteps: 5 });
  if (listeners.length !== 1) throw new Error('reminder must register exactly one pre-step listener');
  if (listeners[0].event !== 'agent/pre-step') throw new Error(`reminder hooked ${listeners[0].event}`);
  const preStep = listeners[0].listener;
  const turnStep = (step) => preStep({ agent: { session: { header: { cwd: dir } } }, step }, async () => ({ kind: 'continue', messages: [] }));

  const firstStep = await turnStep(1);
  if (firstStep.messages.length !== 1) throw new Error('reminder missing on step 1');
  const injected = firstStep.messages[0];
  if (injected.role !== 'user') throw new Error(`reminder must be a user-role message, got ${injected.role}`);
  const injectedText = injected.content[0].text;
  for (const needle of ['运行期提醒', '需求 1', '反馈 1', '任务 1', 'dev_verify', '不得写成记录']) {
    if (!injectedText.includes(needle)) throw new Error(`reminder text is missing ${needle}`);
  }
  if (injected.source?.kind !== 'dev-assistant') throw new Error('reminder must attribute its source');

  if ((await turnStep(3)).messages.length !== 0) throw new Error('reminder must be throttled between reminder steps');
  if ((await turnStep(6)).messages.length !== 1) throw new Error('reminder must repeat at the configured interval');

  const rejected = await preStep({ agent: { session: { header: { cwd: dir } } }, step: 1 }, async () => ({ kind: 'reject' }));
  if (rejected.kind !== 'reject') throw new Error('reminder must not disturb a rejecting pre-step');

  if (!renderReminder({ requests: 0, tasks: 0, feedback: 0, verifications: 0, completions: 0 }).includes('任务数为 0 时不要先写代码')) {
    throw new Error('reminder must warn when no task exists');
  }

  // --- board: reads the same records, never rewrites them -------------------
  const openTask = await tools.get('dev_task_plan').execute(
    { requestId: request.id, title: '看板空态文案', acceptance: ['无记录时给出解释'] },
    exec,
  );
  const board = readBoard(dir, {});
  if (board.requests.length !== 1) throw new Error(`board requests = ${board.requests.length}, expected 1`);
  if (board.tasks.length !== 2) throw new Error(`board tasks = ${board.tasks.length}, expected 2`);
   const waiting = board.tasks.find((item) => item.id === task.id);
   if (waiting.closed || waiting.status !== 'waiting-user') throw new Error('unacknowledged completion must remain waiting-user and open');
  const stillOpen = board.tasks.find((task) => task.id === openTask.id);
  if (stillOpen.closed) throw new Error('queued task must stay open');
  if (stillOpen.completionStatus !== null) throw new Error('open task must not claim a completion');
   if (board.counts.openTasks !== 2 || board.counts.closedTasks !== 0) {
    throw new Error(`board task counts wrong: ${JSON.stringify(board.counts)}`);
  }
  // Latest-wins: appending a newer record for the same task must not duplicate it.
  const before = readBoard(dir, {}).tasks.length;
  await tools.get('dev_task_plan').execute({ requestId: request.id, title: '看板空态文案', acceptance: ['无记录时给出解释'] }, exec);
  if (readBoard(dir, {}).tasks.length !== before + 1) throw new Error('each planned task must be its own record');

  // --- request terminal state: closing leaves the open 需求 column ----------
  const closedRequest = await tools.get('dev_request_close').execute(
    { requestId: request.id, status: 'delivered', note: 'shipped with the login-error fix' },
    exec,
  );
  if (closedRequest.status !== 'delivered') throw new Error(`request not closed: ${closedRequest.status}`);
  const closedRequestBoard = readBoard(dir, {});
  if (closedRequestBoard.requests.some((item) => item.id === request.id)) throw new Error('closed request must leave the open column');
  if (closedRequestBoard.counts.closedRequests !== 1 || closedRequestBoard.counts.openRequests !== 0) {
    throw new Error(`request counts wrong: ${JSON.stringify(closedRequestBoard.counts)}`);
  }
  if (closedRequestBoard.counts.requests !== 1) throw new Error('total request count must stay unique per requestId');
  let closeError = null;
  try { await tools.get('dev_request_close').execute({ requestId: 'req_missing', status: 'invalid' }, exec); } catch (error) { closeError = error; }
  if (!closeError) throw new Error('closing an unknown request must throw');
  await tools.get('dev_request_close').execute({ requestId: request.id, status: 'delivered' }, exec);
  if (readBoard(dir, {}).counts.closedRequests !== 1) throw new Error('latest close must win without duplicating');

  // --- board route: validates the browser-supplied root before reading ------
  let route = null;
  const mounting = { connection: { fetch: { register(spec) { route = spec; return () => { route = null; }; } } } };
  registerBoardRoute(mounting, {});
  if (!route) throw new Error('board route was not registered on the connection service');
  if (route.path !== BOARD_ROUTE) throw new Error(`unexpected route path: ${route.path}`);
  if (route.requestBody !== 'buffered') throw new Error('route must declare buffered body handling');

  const call = (url) => route.fetch(new Request(url));
  const ok = await call(`http://127.0.0.1:1${BOARD_ROUTE}?root=${encodeURIComponent(dir)}`);
  if (ok.status !== 200) throw new Error(`route status ${ok.status} for a real project dir`);
  const okBody = await ok.json();
  if (okBody.tasks.length !== readBoard(dir, {}).tasks.length) throw new Error('route payload disagrees with readBoard');
  if (!ok.headers.get('cache-control')?.includes('no-store')) throw new Error('route must not be cached');

  const relative = await call(`http://127.0.0.1:1${BOARD_ROUTE}?root=relative/path`);
  if (relative.status !== 400) throw new Error('relative root must be rejected');
  const missing = await call(`http://127.0.0.1:1${BOARD_ROUTE}?root=${encodeURIComponent(join(dir, 'nope'))}`);
  if (missing.status !== 400) throw new Error('missing root must be rejected');
  const file = await call(`http://127.0.0.1:1${BOARD_ROUTE}?root=${encodeURIComponent(join(dir, 'package.json'))}`);
  if (file.status !== 400) throw new Error('a file path must be rejected as a root');

  // --- client half: same view model, loaded through the real module wrapper --
  let registered = null;
  const win = { localStorage: { getItem: () => null, setItem: () => {} }, __ModuleLoader__: { load(definition) { registered = definition; } } };
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value }),
  };
  new Function('window', 'require', readFileSync(join(root, 'client.js'), 'utf8'))(win, (name) => {
    if (name !== 'react') throw new Error(`client asked for an unexpected module: ${name}`);
    return fakeReact;
  });
  if (!registered) throw new Error('client.js never registered with the module loader');
  if (registered.id !== 'dsh-plugin-dev-workflow') throw new Error(`client module id = ${registered.id}`);
  const clientExports = registered.factory((name) => fakeReact);
  const view = clientExports.__board;
  if (typeof view?.collect !== 'function') throw new Error('client is missing its view model');
  if (!clientExports.inject?.includes('slots')) throw new Error('client must inject slots');

  const payload = await (await call(`http://127.0.0.1:1${BOARD_ROUTE}?root=${encodeURIComponent(dir)}`)).json();
  const openView = view.collect(payload, 'open');
  const closedView = view.collect(payload, 'closed');
  const allView = view.collect(payload, 'all');
  if (openView.columns.length !== 3) throw new Error(`open filter must show 3 columns, got ${openView.columns.length}`);
  if (closedView.columns.length !== 1) throw new Error('closed filter must show only closed');
  if (allView.columns.length !== 4) throw new Error('all filter must show every column');
  if (openView.counts.open + openView.counts.closed !== openView.counts.all) throw new Error('filter counts must add up');
  if (allView.counts.all !== payload.counts.requests + payload.counts.tasks) {
    throw new Error(`all count ${allView.counts.all} != records ${payload.counts.requests + payload.counts.tasks}`);
  }
  const emptyView = view.collect({ requests: [], tasks: [] }, 'all');
  if (emptyView.counts.all !== 0) throw new Error('empty payload must count zero');
  const columnNode = view.columnNode({ id: 'closed', title: '已完成', hint: 'h', items: [{ kind: 'task', id: 'task_1', title: 't', meta: 'm', note: '', time: '' }] });
  const body = columnNode.props.children[2];
  const cards = body.props.children.flat();
  if (cards[0]?.type !== 'article' || cards[0].props?.className !== 'dw-card') throw new Error('column must render its cards');
  if (view.columnNode({ id: 'queued', title: '待办', hint: 'h', items: [] }).props.children[2].props.children.flat().length === 0) {
    throw new Error('empty column must still render its placeholder');
  }

  // --- scale: a 200-request project must not ship megabytes or a wall of cards
  const bigRoot = mkdtempSync(join(tmpdir(), 'dsh-dev-scale-'));
  try {
    const bigDir = join(bigRoot, '.dsh-dev');
    mkdirSync(bigDir, { recursive: true });
    const stamp = (index) => new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString();
    const buckets = new Map();
    const push = (file, row) => buckets.set(file, [...(buckets.get(file) ?? []), JSON.stringify(row)]);
    for (let index = 0; index < 200; index += 1) {
      push('requests.jsonl', { schemaVersion: 1, requestId: `req_big_${index}`, rawQuote: `需求 ${index}：把第 ${index} 个页面的空状态补齐`, acceptance: ['空态可读', '不误导'], status: 'captured', createdAt: stamp(index) });
    }
    for (let index = 0; index < 300; index += 1) {
      push('tasks.jsonl', { schemaVersion: 1, taskId: `task_big_${index}`, requestId: `req_big_${index % 200}`, title: `任务 ${index}`, acceptance: ['可验证'], status: 'queued', createdAt: stamp(index) });
    }
    for (let index = 0; index < 150; index += 1) {
      push('completions.jsonl', { schemaVersion: 1, completionId: `completion_big_${index}`, taskId: `task_big_${index}`, status: 'succeeded', createdAt: stamp(index) });
    }
    for (let index = 0; index < 3; index += 1) {
      push('feedback.jsonl', { schemaVersion: 1, feedbackId: `fb_big_${index}`, taskId: 'task_big_250', rawQuote: `第 ${index} 版反馈`, createdAt: stamp(index) });
    }
    for (const [file, rows] of buckets) writeFileSync(join(bigDir, file), `${rows.join('\n')}\n`);

    const started = Date.now();
    const big = readBoard(bigRoot);
    const elapsed = Date.now() - started;
    if (big.counts.requests !== 200) throw new Error(`scale requests = ${big.counts.requests}`);
    if (big.counts.tasks !== 300) throw new Error(`scale tasks = ${big.counts.tasks}`);
    if (big.counts.closedTasks !== 150 || big.counts.openTasks !== 150) throw new Error(`scale split wrong: ${JSON.stringify(big.counts)}`);
    if (big.window.requests.shown !== 40 || big.window.requests.total !== 200) throw new Error(`request window wrong: ${JSON.stringify(big.window.requests)}`);
    if (big.window.closedTasks.shown !== 30 || big.window.closedTasks.total !== 150) throw new Error(`closed window wrong: ${JSON.stringify(big.window.closedTasks)}`);
    if (big.requests.length !== 40) throw new Error(`default board must ship 40 requests, got ${big.requests.length}`);
    if (big.tasks.filter((task) => task.closed).length !== 30) throw new Error('default board must ship 30 closed tasks');
    if (big.tasks.filter((task) => !task.closed).length !== 150) throw new Error('open tasks must all ship');
    const newestRequest = big.requests[0];
    if (newestRequest.id !== 'req_big_199') throw new Error(`requests must be newest-first, got ${newestRequest.id}`);
    const bytes = Buffer.byteLength(JSON.stringify(big));
    if (bytes > 260 * 1024) throw new Error(`default window payload is ${Math.round(bytes / 1024)} kB, expected a bounded response`);
    if (elapsed > 2000) throw new Error(`readBoard took ${elapsed}ms on 500 records`);

    const history = big.tasks.find((task) => task.id === 'task_big_250');
    if (history?.latestFeedback?.rawQuote !== '第 2 版反馈') throw new Error('board must carry only the newest feedback per task');

    const wide = readBoard(bigRoot, { requestLimit: 500, closedLimit: 500 });
    if (wide.requests.length !== 200) throw new Error('raising requestLimit must return every request');
    if (wide.tasks.filter((task) => task.closed).length !== 150) throw new Error('raising closedLimit must return every closed task');

    // the client must both offer the window and count it honestly
    const bigView = view.collect(big, 'all');
    const closedColumn = bigView.columns.find((column) => column.id === 'closed');
    const requestColumn = bigView.columns.find((column) => column.id === 'requests');
    if (closedColumn.more?.hidden !== 120) throw new Error(`closed footer must say 120 hidden, got ${closedColumn.more?.hidden}`);
    if (requestColumn.more?.hidden !== 160) throw new Error(`request footer must say 160 hidden, got ${requestColumn.more?.hidden}`);
    const queuedColumn = bigView.columns.find((column) => column.id === 'queued');
    if (queuedColumn.items.length !== 20) throw new Error(`待办 column must cap at 20 cards, got ${queuedColumn.items.length}`);
    if (queuedColumn.more?.hidden !== 130) throw new Error(`待办 footer must say 130 hidden, got ${queuedColumn.more?.hidden}`);
    if (bigView.columns.find((column) => column.id === 'queued').more && view.collect(big, 'all', { queued: 40, waiting: 20 }).columns.find((column) => column.id === 'queued').items.length !== 40) {
      throw new Error('raising the local cap must reveal more cards without a refetch');
    }
    if (bigView.counts.closed !== 150) throw new Error(`closed chip must describe the log: ${bigView.counts.closed}`);
    if (bigView.counts.open !== 350) throw new Error(`open chip must describe the log: ${bigView.counts.open}`);
    if (bigView.counts.all !== 500) throw new Error(`all chip must describe the log: ${bigView.counts.all}`);
    if (closedColumn.items.length !== 30) throw new Error('closed column must render only the window');
    const footer = view.columnNode(closedColumn, () => {}).props.children;
    const moreButton = footer.find?.((child) => child?.props?.className === 'dw-more');
    if (!moreButton) throw new Error('truncated column must render a 显示更多 button');
    if (!String(moreButton.props.children).includes('120')) throw new Error('显示更多 must state how many are hidden');
    if (view.columnNode(closedColumn).props.children.some?.((child) => child?.props?.className === 'dw-more')) {
      throw new Error('without a handler the column must not render a dead button');
    }
  } finally {
    rmSync(bigRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`smoke passed: ${pkg.name}@${pkg.version}`);
