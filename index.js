import { mkdirSync, appendFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, basename, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const name = 'dev-assistant';
// Board routing uses ctx.connection.fetch; declare it so Cordis exposes the
// service during activation instead of throwing on undeclared context access.
export const inject = ['tools', 'workingDirectory', 'connection'];

const TYPES = ['preset', 'convention', 'goal', 'preference'];
const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];

function lines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
const allLines = lines;
function append(dir, file, record) {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, file), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}
function safeRoot(ctx, config, exec) {
  // workingDirectory.get() takes a live Session object (it reads session
  // projections by identity), not a session id string: passing exec.agent.id
  // throws `session.snapshotEvents is not a function` inside the projection
  // cache and fails every dev_* tool.
  const session = exec?.agent?.session;
  const live = session === undefined ? undefined : ctx.workingDirectory?.get?.(session);
  const cwd = config.projectRoot || live || session?.header?.cwd || process.cwd();
  return resolve(cwd);
}
function storeFor(ctx, config, exec) {
  const root = safeRoot(ctx, config, exec);
  const dir = resolve(config.dataRoot || join(root, '.dsh-dev'));
  mkdirSync(dir, { recursive: true });
  return { root, dir, projectId: `project_${createHash('sha256').update(root).digest('hex').slice(0, 10)}` };
}
function recordTool(name, description, parameters, execute) {
  return { name, description, parameters, output: { schema: { type: 'object' }, render: (_args, value) => text(value) }, execute };
}
function allRecords(ctx, config, exec, file) { return lines(join(storeFor(ctx, config, exec).dir, file)); }
function latest(records, key) { const map = new Map(); for (const r of records) map.set(r[key], r); return [...map.values()]; }

const TASK_TERMINAL = new Set(['succeeded', 'cancelled']);
const COMPLETION_STATUSES = new Set(['partial', 'waiting-user', 'succeeded']);

// Last line wins within each log. Explicit terminal task states (including
// imported/legacy records) remain terminal; otherwise a recognized completion
// supplies the effective state. Both readers use this unwindowed projection.
function projectTasks(tasks, completions) {
  const byTask = new Map();
  for (const completion of completions) {
    if (typeof completion?.taskId === 'string') byTask.set(completion.taskId, completion);
  }
  return latest(tasks, 'taskId').map((record) => {
    const storedStatus = record.status ?? 'queued';
    const completionStatus = byTask.get(record.taskId)?.status ?? null;
    const status = !TASK_TERMINAL.has(storedStatus) && COMPLETION_STATUSES.has(completionStatus) ? completionStatus : storedStatus;
    return { ...record, storedStatus, status, completionStatus, closed: TASK_TERMINAL.has(status) };
  });
}

// A preset persona is one paragraph at the top of a context that grows to
// dozens of steps; by the time a turn is forty tool calls in, the model is
// reading tool results, not that paragraph. The measurement that motivated
// this: in a real session `dev_context_get` ran at +1s, but
// `dev_request_capture` only at +86s (after forty calls). A pre-step
// reminder rides in the request history instead of waiting to be remembered.
const REMINDER_EVERY_STEPS = 5;
const REMINDER_ORDER = [
  '用户带来新需求 → 先调用 dev_request_capture（原话 + 验收），再动业务文件；',
  '用户在评价或纠正上一轮结果 → 先调用 dev_feedback_record（保留原话，不加工措辞）；',
  '有可执行工作 → 调用 dev_task_plan 拆最少任务（验收 + 风险 + 依赖）；任务数为 0 时不要先写代码；',
  '每次改动 → 调用 dev_verify 记录真实命令与退出码；收口 → 调用 dev_complete。',
];
const REMINDER_RULE = '只记录真实发生的事：没调用过的工具、没跑过的命令、没被确认过的偏好，一律不得写成记录。';

function countRecords(dir) {
  // Close lines append to requests.jsonl for an existing requestId, so raw
  // line counts would inflate the reminder. Count records, not lines.
  const count = (file, key) => {
    const records = lines(join(dir, file));
    return key ? new Set(records.map((record) => record?.[key]).filter(Boolean)).size : records.length;
  };
  return {
    requests: count('requests.jsonl', 'requestId'),
    tasks: count('tasks.jsonl', 'taskId'),
    feedback: count('feedback.jsonl'),
    verifications: count('verifications.jsonl'),
    completions: count('completions.jsonl'),
  };
}

/** Render the per-step workflow reminder that carries the live record counts. */
export function renderReminder(counts) {
  return [
    `【研发闭环·运行期提醒】本会话已登记：需求 ${counts.requests} · 任务 ${counts.tasks} · 反馈 ${counts.feedback} · 验证 ${counts.verifications} · 完成 ${counts.completions}。`,
    '按顺序执行：',
    ...REMINDER_ORDER.map((line, index) => `${index + 1}) ${line}`),
    REMINDER_RULE,
  ].join('\n');
}

/**
 * Append the reminder to the request history at the first step of every turn
 * and every `reminderEverySteps` steps after that. Never throws into the agent
 * loop: a broken reminder must not cost the user a turn.
 * @returns disposer for the pre-step listener.
 */
export function installReminder(ctx, config = {}) {
  if (typeof ctx?.on !== 'function') return () => {};
  const every = Number.isInteger(config.reminderEverySteps) && config.reminderEverySteps > 0 ? config.reminderEverySteps : REMINDER_EVERY_STEPS;
  const handler = async (payload, next) => {
    const decision = await next();
    try {
      if (decision === undefined || decision.kind === 'reject' || payload?.signal?.aborted) return decision;
      const step = payload?.step ?? 1;
      if (every !== 1 && step !== 1 && step % every !== 1) return decision;
      const root = resolve(config.projectRoot || payload?.agent?.session?.header?.cwd || process.cwd());
      const dir = resolve(config.dataRoot || join(root, '.dsh-dev'));
      const text = renderReminder(countRecords(dir));
      const message = {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: name, form: 'snapshot', sections: [{ name, text }] },
      };
      return { ...decision, messages: [...(decision.messages ?? []), message] };
    } catch {
      return decision;
    }
  };
  const dispose = ctx.on('agent/pre-step', handler, { prepend: true });
  return typeof dispose === 'function' ? dispose : () => {};
}

/** Request statuses that leave the board's open 需求 column (latest line wins). */
const REQUEST_TERMINAL = new Set(['delivered', 'invalid', 'superseded']);

/**
 * Read one project's records into the shape the board renders.
 *
 * Read-only and additive: nothing here writes, rewrites, or "repairs" a record.
 * A completion is an outcome record, not necessarily a terminal result.
 * Board and context share effective states; only succeeded/cancelled close.
 */
export function readBoard(root, config = {}) {
  const absolute = resolve(root);
  const dir = resolve(config.dataRoot || join(absolute, '.dsh-dev'));
  const completions = lines(join(dir, 'completions.jsonl'));

  // One board for a 2-task project and one for a 200-request project cannot both
  // be "return every record": the second would ship megabytes to the browser and
  // render a wall of cards nobody scrolls. Closed work is windowed (newest first,
  // `closedLimit` per response) and the counts always describe the whole log, so
  // "7 of 212" stays honest while the payload stays small.
  const closedLimit = clampLimit(config.closedLimit, DEFAULT_CLOSED_LIMIT);
  const requestLimit = clampLimit(config.requestLimit, DEFAULT_REQUEST_LIMIT);

  // Only the newest feedback per target is carried, matching how deck-line kept
  // its task list readable: a task's history is the log's job, not the card's.
  const latestFeedback = new Map();
  for (const record of allLines(join(dir, 'feedback.jsonl'))) {
    const target = record?.taskId ? `task:${record.taskId}` : record?.requestId ? `request:${record.requestId}` : '';
    if (!target) continue;
    const previous = latestFeedback.get(target);
    if (previous === undefined || String(record.createdAt ?? '') >= String(previous.createdAt ?? '')) latestFeedback.set(target, record);
  }
  const feedbackFor = (target) => {
    const record = latestFeedback.get(target);
    return record === undefined ? null : { rawQuote: record.rawQuote ?? '', decision: record.decision ?? null, category: record.category ?? null, createdAt: record.createdAt ?? null };
  };

  const allRequests = latest(allLines(join(dir, 'requests.jsonl')), 'requestId')
    .map((record) => ({
      id: record.requestId,
      rawQuote: record.rawQuote ?? '',
      normalized: record.normalized ?? '',
      acceptance: record.acceptance ?? [],
      scope: record.scope ?? '',
      priority: record.priority ?? 'normal',
      status: record.status ?? 'captured',
      createdAt: record.createdAt ?? null,
      latestFeedback: feedbackFor(`request:${record.requestId}`),
    }))
    .sort(newestFirst);
  const openRequests = allRequests.filter((request) => !REQUEST_TERMINAL.has(request.status));
  const closedRequests = allRequests.filter((request) => REQUEST_TERMINAL.has(request.status));
  const allTasks = projectTasks(allLines(join(dir, 'tasks.jsonl')), completions).map((record) => {
    return {
      id: record.taskId,
      requestId: record.requestId ?? null,
      title: record.title ?? '',
      kind: record.kind ?? '',
      acceptance: record.acceptance ?? [],
      steps: record.steps ?? [],
      dependsOn: record.dependsOn ?? [],
      risk: record.risk ?? '',
      status: record.status,
      storedStatus: record.storedStatus,
      closed: record.closed,
      completionStatus: record.completionStatus,
      createdAt: record.createdAt ?? null,
      latestFeedback: feedbackFor(`task:${record.taskId}`),
    };
  }).sort(newestFirst);

  const openTasks = allTasks.filter((task) => !task.closed);
  const closedTasks = allTasks.filter((task) => task.closed);
  const requests = openRequests.slice(0, requestLimit);
  const tasks = [...openTasks, ...closedTasks.slice(0, closedLimit)];

  return {
    schemaVersion: 1,
    projectId: `project_${createHash('sha256').update(absolute).digest('hex').slice(0, 10)}`,
    root: absolute,
    counts: {
      requests: allRequests.length,
      openRequests: openRequests.length,
      closedRequests: closedRequests.length,
      tasks: allTasks.length,
      feedback: allLines(join(dir, 'feedback.jsonl')).length,
      verifications: allLines(join(dir, 'verifications.jsonl')).length,
      completions: completions.length,
      openTasks: openTasks.length,
      closedTasks: closedTasks.length,
    },
    // What was cut, so the board can offer "显示更多" without guessing.
    window: {
      requests: { shown: requests.length, total: openRequests.length, limit: requestLimit },
      closedTasks: { shown: Math.min(closedTasks.length, closedLimit), total: closedTasks.length, limit: closedLimit },
    },
    requests,
    tasks,
    generatedAt: now(),
  };
}

const DEFAULT_CLOSED_LIMIT = 30;
const DEFAULT_REQUEST_LIMIT = 40;
const MAX_LIMIT = 500;

function clampLimit(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_LIMIT);
}

/** Newest first; equal or missing timestamps keep their recorded order stable. */
function newestFirst(left, right) {
  return String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? ''));
}

export const BOARD_ROUTE = '/api/dsh-dev-assistant.board';

const boardResponse = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/**
 * Serve the board over one read-only route. `root` arrives from the browser, so
 * it is validated as a real directory before anything under it is read, and the
 * only paths ever opened are the six known JSONL files inside `<root>/.dsh-dev/`.
 */
export function registerBoardRoute(ctx, config = {}) {
  const mount = (scope) => {
    const registry = scope?.connection?.fetch;
    if (typeof registry?.register !== 'function') return () => {};
    let handle;
    try {
      handle = registry.register({
        path: BOARD_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request) => {
          let root = '';
          let closedLimit;
          let requestLimit;
          try {
            const url = new URL(request.url);
            root = url.searchParams.get('root') || '';
            closedLimit = url.searchParams.get('closedLimit') ?? undefined;
            requestLimit = url.searchParams.get('requestLimit') ?? undefined;
          } catch { root = ''; }
          if (!root) root = config.projectRoot || process.cwd();
          if (!isAbsolute(root)) return boardResponse({ error: 'root must be an absolute path' }, 400);
          let stat;
          try { stat = statSync(root); } catch { return boardResponse({ error: `root not found: ${root}` }, 400); }
          if (!stat.isDirectory()) return boardResponse({ error: `root is not a directory: ${root}` }, 400);
          try {
            return boardResponse(readBoard(root, { ...config, closedLimit, requestLimit }), 200);
          } catch (error) {
            return boardResponse({ error: `board read failed: ${error?.message ?? 'unknown'}` }, 500);
          }
        },
      });
    } catch (error) {
      // Fetch routes are exact-path unique per host. The same plugin can be
      // mounted twice (host-level board entry + session preset), and the
      // second registration then throws "already registered", failing that
      // entry's activation with a red "Problem" badge. The first owner
      // already serves the route, so degrade to a no-op instead.
      if (String(error?.message ?? error).includes('already registered')) return () => {};
      throw error;
    }
    return handle;
  };
  // The host hands `connection` to `apply`'s context when the row composes it;
  // when the service is not visible yet, wait for it instead of skipping the
  // route silently (a missing route shows up as an empty board).
  if (typeof ctx?.connection?.fetch?.register === 'function') return mount(ctx) ?? (() => {});
  if (typeof ctx?.inject === 'function') { ctx.inject(['connection'], (scope) => mount(scope)); return () => {}; }
  return () => {};
}

export function defineDevTools(ctx, config = {}) {
  const project = (exec) => storeFor(ctx, config, exec);
  return [
    recordTool('dev_context_get', '读取当前项目的目标、研发规范、用户偏好、未完成任务与最近反馈；返回有界摘要，不执行写入。', {
      type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false,
    }, async (args, exec) => {
      const p = project(exec); const limit = args?.limit ?? 10;
      const knowledge = latest(allRecords(ctx, config, exec, 'knowledge.jsonl'), 'knowledgeId').filter((x) => x.status === 'active' || x.status === 'proposed');
      // Filter completed outcomes BEFORE limiting the context window: newer
      // completed tasks must not evict older work that is still actionable.
      const tasks = projectTasks(lines(join(p.dir, 'tasks.jsonl')), lines(join(p.dir, 'completions.jsonl'))).filter((x) => !x.closed);
      const feedback = allRecords(ctx, config, exec, 'feedback.jsonl').slice(-limit);
      return { id: p.projectId, status: 'succeeded', projectId: p.projectId, context: { root: basename(p.root), knowledge: knowledge.slice(-limit), tasks: tasks.slice(-limit), feedback }, refs: { dataRoot: p.dir }, text: `项目 ${p.projectId}：${tasks.length} 个未完成任务，${knowledge.length} 条可引用知识。` };
    }),
    recordTool('dev_request_capture', '登记用户需求，保留原话；缺少验收条件时状态为 clarifying，不自动开工。', {
      type: 'object', required: ['rawQuote'], properties: { rawQuote: { type: 'string' }, normalized: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, scope: { type: 'string' }, priority: { type: 'string' } }, additionalProperties: false,
    }, async (args, exec) => { const p = project(exec); const r = append(p.dir, 'requests.jsonl', { schemaVersion: 1, requestId: id('req'), projectId: p.projectId, rawQuote: args.rawQuote, normalized: args.normalized ?? '', acceptance: args.acceptance ?? [], scope: args.scope ?? '', priority: args.priority ?? 'normal', sourceSessionId: exec?.agent?.id ?? null, status: args.acceptance?.length ? 'captured' : 'clarifying', createdAt: now() }); return { id: r.requestId, status: r.status, refs: { file: join(p.dir, 'requests.jsonl') }, text: `已登记需求 ${r.requestId}，状态 ${r.status}。` }; }),
    recordTool('dev_request_close', '给需求一个终态：delivered（已交付）/ invalid（已作废）/ superseded（已被取代）。append-only 追加状态行，不改历史；看板需求列不再陈列已终结需求。', {
      type: 'object', required: ['requestId', 'status'], properties: { requestId: { type: 'string' }, status: { type: 'string', enum: ['delivered', 'invalid', 'superseded'] }, note: { type: 'string' } }, additionalProperties: false,
    }, async (args, exec) => {
      const p = project(exec);
      const known = latest(allRecords(ctx, config, exec, 'requests.jsonl'), 'requestId');
      if (!known.some((record) => record.requestId === args.requestId)) throw new Error(`unknown requestId: ${args.requestId}`);
      const r = append(p.dir, 'requests.jsonl', { schemaVersion: 1, requestId: args.requestId, projectId: p.projectId, status: args.status, note: args.note ?? '', closedBy: exec?.agent?.id ?? null, closedAt: now() });
      return { id: r.requestId, status: r.status, refs: { file: join(p.dir, 'requests.jsonl') }, text: `需求 ${r.requestId} 已置为 ${r.status}。` };
    }),
    recordTool('dev_feedback_record', '追加记录用户反馈原话；不会自动修改代码或晋升长期知识。', {
      type: 'object', required: ['rawQuote'], properties: { rawQuote: { type: 'string' }, requestId: { type: 'string' }, taskId: { type: 'string' }, category: { type: 'string', enum: ['bug', 'quality', 'scope', 'preference', 'process'] }, decision: { type: 'string', enum: ['accept', 'reject', 'defer', 'needs-clarification'] }, evidenceRefs: { type: 'array', items: { type: 'string' } }, impact: { type: 'string' } }, additionalProperties: false,
    }, async (args, exec) => { const p = project(exec); const r = append(p.dir, 'feedback.jsonl', { schemaVersion: 1, feedbackId: id('fb'), projectId: p.projectId, ...args, actor: 'user', createdAt: now() }); return { id: r.feedbackId, status: 'recorded', refs: { file: join(p.dir, 'feedback.jsonl') }, text: `已记录反馈 ${r.feedbackId}。` }; }),
    recordTool('dev_task_plan', '创建可执行研发任务，记录验收、依赖与风险；默认 queued，破坏性范围可标记 waiting-user。', {
      type: 'object', required: ['title', 'acceptance'], properties: { requestId: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string' }, acceptance: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } }, dependsOn: { type: 'array', items: { type: 'string' } }, risk: { type: 'string' }, status: { type: 'string', enum: ['queued', 'waiting-user'] } }, additionalProperties: false,
    }, async (args, exec) => { const p = project(exec); const r = append(p.dir, 'tasks.jsonl', { schemaVersion: 1, taskId: id('task'), projectId: p.projectId, owner: 'agent', feedbackRefs: [], ...args, status: args.status ?? 'queued', createdAt: now(), changedRefs: [], verificationRefs: [] }); return { id: r.taskId, status: r.status, refs: { file: join(p.dir, 'tasks.jsonl') }, text: `已创建任务 ${r.taskId}：${r.title}` }; }),
    recordTool('dev_verify', '记录一次真实验证结果；调用方必须传入实际退出码，不接受伪造 succeeded。', {
      type: 'object', required: ['taskId', 'command', 'exitCode'], properties: { taskId: { type: 'string' }, command: { type: 'string' }, exitCode: { type: 'integer' }, result: { type: 'string' }, summary: { type: 'string' } }, additionalProperties: false,
    }, async (args, exec) => { const p = project(exec); const r = append(p.dir, 'verifications.jsonl', { schemaVersion: 1, verificationId: id('verify'), projectId: p.projectId, ...args, status: args.exitCode === 0 ? 'passed' : 'failed', createdAt: now() }); return { id: r.verificationId, status: r.status, refs: { file: join(p.dir, 'verifications.jsonl') }, text: `验证 ${r.status}：${args.command}` }; }),
    recordTool('dev_complete', '基于真实任务与验证记录生成完成总结；没有通过验证时只能 partial 或 blocked。', {
      type: 'object', required: ['taskId', 'summary'], properties: { taskId: { type: 'string' }, summary: { type: 'string' }, changedFiles: { type: 'array', items: { type: 'string' } }, risks: { type: 'array', items: { type: 'string' } }, unresolved: { type: 'array', items: { type: 'string' } }, nextSteps: { type: 'array', items: { type: 'string' } }, userAck: { type: 'boolean' } }, additionalProperties: false,
    }, async (args, exec) => { const p = project(exec); const checks = allRecords(ctx, config, exec, 'verifications.jsonl').filter((x) => x.taskId === args.taskId); const status = checks.length && checks.every((x) => x.exitCode === 0) ? (args.userAck ? 'succeeded' : 'waiting-user') : 'partial'; const r = append(p.dir, 'completions.jsonl', { schemaVersion: 1, completionId: id('completion'), projectId: p.projectId, ...args, status, verificationRefs: checks.map((x) => x.verificationId), createdAt: now() }); return { id: r.completionId, status, refs: { file: join(p.dir, 'completions.jsonl') }, text: `完成总结 ${r.completionId}：${status}` }; }),
    recordTool('dev_knowledge_promote', '在用户明确确认后，将带来源的目标、规范或偏好追加为可撤销知识；默认 proposed。', {
      type: 'object', required: ['type', 'content', 'sourceRefs'], properties: { type: { type: 'string', enum: TYPES }, content: { type: 'string' }, scope: { type: 'string', enum: ['user', 'project', 'repo'] }, sourceRefs: { type: 'array', items: { type: 'string' } }, confirmed: { type: 'boolean' }, expiresAt: { type: 'string' } }, additionalProperties: false,
    }, async (args, exec) => { const p = project(exec); const status = args.confirmed ? 'active' : 'proposed'; const r = append(p.dir, 'knowledge.jsonl', { schemaVersion: 1, knowledgeId: id('know'), projectId: p.projectId, ...args, status, version: 1, approvedBy: args.confirmed ? 'user' : null, validFrom: now(), createdAt: now() }); return { id: r.knowledgeId, status, refs: { file: join(p.dir, 'knowledge.jsonl') }, text: `知识候选 ${r.knowledgeId}：${status}` }; }),
  ];
}

export function apply(ctx, rawConfig = {}) {
  const config = rawConfig ?? {};
  const disposers = [];
  if (config.tools) {
    const runtime = ctx.get('tools');
    if (runtime?.register) {
      disposers.push(...defineDevTools(ctx, config).map((tool) => runtime.register(tool)));
      // The reminder names the tools, so it is only meaningful when they exist.
      if (config.reminder !== false) disposers.push(installReminder(ctx, config));
    }
  }
  // The board is read-only and useful on its own, so it mounts independently of
  // the tool row and of any preset that happens to be selected.
  if (config.board !== false) disposers.push(registerBoardRoute(ctx, config));
  if (disposers.length) ctx.on?.('dispose', () => disposers.forEach((dispose) => dispose?.()));
}
