/**
 * Web half of `dsh-plugin-dev-workflow`.
 *
 * Why this exists: the records are append-only JSONL, which is fine for a
 * machine and useless for a person. This renders the same records as a board —
 * 需求 / 待办 / 待确认 / 已完成 — that can be switched between 进行中 / 已完成 /
 * 全部.
 *
 * It only ever reads: the host route is GET-only and serves `<root>/.dsh-dev`,
 * so nothing here can change a record, and a broken board can never take the
 * conversation (or the `dev_*` tools) down with it.
 *
 * Written in the host's module-loader format: no build step, `require('react')`
 * provided by the shell.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-dev-workflow',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const ENDPOINT = '/api/dsh-dev-assistant.board';
    const PANEL_ID = 'dev-workflow-board';
    const ROOT_KEY = 'dsh-dev-workflow.board.root';

    const FILTERS = [
      { id: 'open', label: '进行中' },
      { id: 'closed', label: '已完成' },
      { id: 'all', label: '全部' },
    ];

    const COLUMNS = [
      { id: 'requests', title: '需求', hint: '用户原话 + 验收条件', filter: 'open' },
      { id: 'queued', title: '待办', hint: '待执行或部分完成、仍需处理', filter: 'open' },
      { id: 'waiting', title: '待确认', hint: '需要你点头才能继续（waiting-user）', filter: 'open' },
      { id: 'closed', title: '已完成', hint: '已完成或已取消的任务', filter: 'closed' },
    ];

    const STATUS_LABEL = {
      queued: '待办',
      partial: '部分完成',
      'waiting-user': '待确认',
      succeeded: '已完成',
      cancelled: '已取消',
    };

    const REQUEST_LABEL = {
      captured: '已登记',
      clarifying: '待补验收',
      delivered: '已交付',
      invalid: '已作废',
      superseded: '已取代',
    };

    /** The host supplies an effective status shared with the context reader. */
    function taskColumn(task) {
      if (task.closed) return 'closed';
      if (task.status === 'waiting-user') return 'waiting';
      return 'queued';
    }

    function shorten(text, limit) {
      const value = String(text ?? '').replace(/\s+/g, ' ').trim();
      return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
    }

    function shortTime(iso) {
      if (!iso) return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /**
     * Turn one host payload into column arrays plus counts for the active filter.
     * Pure on purpose: the preview harness and the smoke test render the exact
     * same view model the browser does.
     */
    const DEFAULT_OPEN_CAPS = { queued: 20, waiting: 20 };

    /**
     * Turn one host payload into column arrays plus counts for the active filter.
     * Pure on purpose: the preview harness and the smoke test render the exact
     * same view model the browser does.
     *
     * Windowing has two layers, because the two growth axes are different:
     * 已完成/需求 grow with history, so the HOST truncates them and the button
     * refetches with a bigger limit; 待办/待确认 are already in the payload, so
     * they are capped locally and the button just raises the cap — no round trip.
     */
    function collect(board, filter, caps = DEFAULT_OPEN_CAPS) {
      const requests = Array.isArray(board?.requests) ? board.requests : [];
      const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
      const columns = {
        requests: requests.map((request) => ({
          kind: 'request',
          id: request.id,
          title: shorten(request.rawQuote, 110),
          meta: `${(request.acceptance ?? []).length} 条验收 · ${REQUEST_LABEL[request.status] ?? request.status ?? '已登记'}`,
          note: request.scope ? `范围 · ${shorten(request.scope, 64)}` : '',
          feedback: request.latestFeedback ? shorten(request.latestFeedback.rawQuote, 90) : '',
          time: shortTime(request.createdAt),
        })),
        queued: [],
        waiting: [],
        closed: [],
      };
      for (const task of tasks) {
        columns[taskColumn(task)].push({
          kind: 'task',
          id: task.id,
          title: shorten(task.title, 90),
           meta: `${(task.acceptance ?? []).length} 条验收 · ${STATUS_LABEL[task.status] ?? task.status ?? '待办'}`,
          note: task.risk ? `风险 · ${shorten(task.risk, 64)}` : '',
          feedback: task.latestFeedback ? shorten(task.latestFeedback.rawQuote, 90) : '',
          time: shortTime(task.createdAt),
        });
      }

      const window = board?.window ?? {};
      const hostWindows = { requests: window.requests, closed: window.closedTasks };
      const visible = (column) => filter === 'all' || column.filter === filter;
      const visibleColumns = COLUMNS.filter((column) => visible(column)).map((column) => {
        const all = columns[column.id] ?? [];
        const hostSpan = hostWindows[column.id];
        if (hostSpan) {
          const total = hostSpan.total ?? all.length;
          return { ...column, items: all, more: total > all.length ? { shown: all.length, total, hidden: total - all.length } : null };
        }
        const cap = Number.isInteger(caps?.[column.id]) ? caps[column.id] : (DEFAULT_OPEN_CAPS[column.id] ?? all.length);
        if (all.length <= cap) return { ...column, items: all, more: null };
        return { ...column, items: all.slice(0, cap), more: { shown: cap, total: all.length, hidden: all.length - cap } };
      });

      // Chips describe the LOG, not the window: on a 200-request project
      // "全部 220" would be a lie when 500 records exist. Each column header
      // shows rendered/total whenever the window truncated it.
      const totals = board?.counts ?? {};
      // Host 0.2.6+ splits requests into open/closed; older hosts only report
      // the total, so every number has a fallback that keeps the chips honest.
      const totalRequests = Number.isInteger(totals.openRequests) ? totals.openRequests : columns.requests.length;
      const totalClosedRequests = Number.isInteger(totals.closedRequests) ? totals.closedRequests : 0;
      const totalAllRequests = Number.isInteger(totals.requests) ? totals.requests : totalRequests + totalClosedRequests;
      const totalOpen = Number.isInteger(totals.openTasks) ? totals.openTasks : columns.queued.length + columns.waiting.length;
      const totalClosed = Number.isInteger(totals.closedTasks) ? totals.closedTasks : columns.closed.length;
      const counts = { open: totalRequests + totalOpen, closed: totalClosed + totalClosedRequests, all: totalAllRequests + totalOpen + totalClosed };
      return { columns: visibleColumns, counts };
    }

    function cardNode(item) {
      return h('article', { className: 'dw-card', 'data-kind': item.kind, 'data-id': item.id },
        h('div', { className: 'dw-card-title' }, item.title || '（无标题）'),
        h('div', { className: 'dw-card-meta' }, item.meta),
        item.note ? h('div', { className: 'dw-card-note' }, item.note) : null,
        item.feedback ? h('div', { className: 'dw-card-fb' }, h('span', null, '最新反馈'), ' ', item.feedback) : null,
        h('div', { className: 'dw-card-foot' },
          h('code', null, item.id),
          h('span', null, item.time)));
    }

    function columnNode(column, onMore) {
      return h('section', { className: 'dw-col', 'data-col': column.id },
        h('header', { className: 'dw-col-head' },
          h('span', { className: 'dw-col-title' }, column.title),
          h('span', { className: 'dw-col-count' }, String(column.more ? `${column.items.length}/${column.more.total}` : column.items.length))),
        h('p', { className: 'dw-col-hint' }, column.hint),
        h('div', { className: 'dw-col-body' },
          column.items.length === 0
            ? h('div', { className: 'dw-empty' }, '这一列还没有记录')
            : column.items.map(cardNode)),
        column.more && onMore
          ? h('button', { type: 'button', className: 'dw-more', onClick: () => onMore(column.id) },
            `显示更多 · 还有 ${column.more.hidden} 条`)
          : null);
    }

    // Editorial, not dashboard: hairline rules and whitespace carry the
    // structure, so no card borders, no shadows, and no accent bars. Colours are
    // the shell's own ui-theme tokens with light fallbacks, so the board follows
    // the app's light/dark setting and the offline preview (no shell CSS) still
    // renders the light palette.
    const CSS = `
.dw-board{background:var(--dsw-alias-bg-base,#ffffff);color:var(--dsw-alias-label-primary,#17191c);
  font:13px/1.55 ui-sans-serif,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  height:100%;display:flex;flex-direction:column;min-height:0;-webkit-font-smoothing:antialiased}
.dw-bar{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:30px 36px 0;flex-wrap:wrap}
.dw-heading{min-width:0}
.dw-title{margin:0;font-size:20px;font-weight:600;letter-spacing:-.012em}
.dw-sub{margin:4px 0 0;color:var(--dsw-alias-label-tertiary,#8b8f96);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:62ch}
.dw-tools{display:flex;align-items:flex-end;gap:22px;flex-wrap:wrap}
.dw-tabs{display:flex;gap:20px;border-bottom:1px solid var(--dsw-alias-border-l2,#0000001a)}
.dw-tab{border:0;background:none;padding:0 0 11px;margin-bottom:-1px;color:var(--dsw-alias-label-tertiary,#8b8f96);font:inherit;font-size:13px;cursor:pointer;border-bottom:1px solid transparent}
.dw-tab:hover{color:var(--dsw-alias-label-primary,#17191c)}
.dw-tab[data-on="1"]{color:var(--dsw-alias-label-primary,#17191c);border-bottom-color:var(--dsw-alias-label-primary,#17191c)}
.dw-tab b{margin-left:6px;font-weight:400;color:inherit;opacity:.6;font-variant-numeric:tabular-nums}
.dw-select{appearance:none;-webkit-appearance:none;border:0;background-color:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:12.5px;
  padding:0 18px 12px 0;margin-bottom:-1px;max-width:260px;cursor:pointer;
  background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);
  background-position:calc(100% - 7px) 42%,calc(100% - 3px) 42%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.dw-select:hover{color:var(--dsw-alias-label-primary,#17191c)}
.dw-refresh{border:0;background:none;color:var(--dsw-alias-label-tertiary,#8b8f96);font:inherit;font-size:12.5px;padding:0 0 12px;cursor:pointer}
.dw-refresh:hover{color:var(--dsw-alias-label-primary,#17191c)}
.dw-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:44px;padding:26px 36px 48px;overflow:auto;flex:1;min-height:0;align-items:start;border-top:1px solid var(--dsw-alias-border-l2,#0000001a)}
.dw-col{min-height:140px}
.dw-col-head{display:flex;align-items:baseline;gap:9px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l3,#0000001f)}
.dw-col-title{font-size:13px;font-weight:600;letter-spacing:.01em}
.dw-col-count{font-size:12px;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-variant-numeric:tabular-nums}
.dw-col-hint{margin:10px 0 0;color:var(--dsw-alias-label-tertiary,#a0a5ab);font-size:11.5px}
.dw-col-body{display:flex;flex-direction:column}
.dw-card{padding:15px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#0000000f)}
.dw-card:last-child{border-bottom:0}
.dw-card-title{font-size:13.5px;font-weight:500;line-height:1.5;margin-bottom:6px;word-break:break-word}
.dw-card[data-kind="request"] .dw-card-title{font-weight:600}
.dw-card-meta{color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;font-variant-numeric:tabular-nums}
.dw-card-note{color:var(--dsw-alias-label-tertiary,#8b8f96);font-size:11.5px;margin-top:5px;line-height:1.55}
.dw-card-fb{margin-top:6px;color:var(--dsw-alias-label-secondary,#61666b);font-size:11.5px;line-height:1.55}
.dw-card-fb span{color:var(--dsw-alias-label-tertiary,#a0a5ab);margin-right:2px}
.dw-more{align-self:flex-start;margin-top:14px;border:0;background:none;padding:0;color:var(--dsw-alias-label-tertiary,#8b8f96);font:inherit;font-size:12px;cursor:pointer;border-bottom:1px solid var(--dsw-alias-border-l3,#0000001f);padding-bottom:2px}
.dw-more:hover{color:var(--dsw-alias-label-primary,#17191c);border-bottom-color:var(--dsw-alias-label-primary,#17191c)}
.dw-card-foot{display:flex;justify-content:space-between;gap:12px;margin-top:9px;color:var(--dsw-alias-label-tertiary,#a8adb3);font-size:10.5px;font-variant-numeric:tabular-nums}
.dw-card-foot code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px}
.dw-empty{color:var(--dsw-alias-label-tertiary,#a8adb3);font-size:12px;padding:20px 0}
.dw-state{color:var(--dsw-alias-label-secondary,#61666b);font-size:12.5px;padding:34px 36px;line-height:1.8}
.dw-state b{color:var(--dsw-alias-label-primary,#17191c);font-weight:600}
.dw-warn{color:var(--dsw-alias-state-error-primary,#c0392b);margin:4px 0}
`;

    /**
     * The shell's `workspaces.list` snapshot is an object — `{ items,
     * pinnedSessionIds, archivedSessionIds }` — not a bare array. Normalize
     * both shapes so one host version difference cannot empty the dropdown.
     */
    function workspaceItems(snapshot) {
      if (Array.isArray(snapshot)) return snapshot;
      if (Array.isArray(snapshot?.items)) return snapshot.items;
      return [];
    }

    function useWorkspaceStore(store) {
      const [list, setList] = React.useState(() => workspaceItems(store?.getSnapshot?.()));
      React.useEffect(() => {
        if (!store) return undefined;
        const read = () => setList(workspaceItems(store.getSnapshot?.()));
        read();
        if (typeof store.subscribe === 'function') return store.subscribe(read);
        return undefined;
      }, [store]);
      return list;
    }

    function Board(props) {
      const workspaces = useWorkspaceStore(props?.workspaceStore);
      const [root, setRoot] = React.useState(() => {
        try { return window.localStorage.getItem(ROOT_KEY) || ''; } catch { return ''; }
      });
      const [board, setBoard] = React.useState(null);
      // Windows, not a page number: 已完成 grows the closed window, 需求 grows the
      // request window, and the host keeps the payload bounded either way.
      const [limits, setLimits] = React.useState({ requestLimit: 40, closedLimit: 30 });
      const [openCaps, setOpenCaps] = React.useState({ queued: 20, waiting: 20 });
      const [error, setError] = React.useState('');
      const [loading, setLoading] = React.useState(false);
      const [filter, setFilter] = React.useState('open');
      const [tick, setTick] = React.useState(0);

      // A workspace may be created (or renamed) after the panel mounted, so the
      // remembered root is resolved against the live list on every render.
      const options = workspaces.map((workspace) => ({ id: workspace.path, label: workspace.title || workspace.path }));
      const active = options.some((option) => option.id === root) ? root : options[0]?.id ?? '';

      React.useEffect(() => {
        if (!active) return undefined;
        let cancelled = false;
        setLoading(true);
        setError('');
        const query = `root=${encodeURIComponent(active)}&requestLimit=${limits.requestLimit}&closedLimit=${limits.closedLimit}`;
        fetch(`${ENDPOINT}?${query}`, { cache: 'no-store' })
          .then(async (response) => {
            const body = await response.json().catch(() => null);
            if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
            return body;
          })
          .then((body) => { if (!cancelled) setBoard(body); })
          .catch((failure) => { if (!cancelled) { setBoard(null); setError(failure?.message || '读取失败'); } })
          .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
      }, [active, tick, limits.requestLimit, limits.closedLimit]);

      const showMore = (columnId) => {
        if (columnId === 'queued' || columnId === 'waiting') {
          setOpenCaps((previous) => ({ ...previous, [columnId]: (previous[columnId] ?? 20) + 30 }));
          return;
        }
        setLimits((previous) => (columnId === 'closed'
          ? { ...previous, closedLimit: previous.closedLimit + 50 }
          : { ...previous, requestLimit: previous.requestLimit + 50 }));
      };

      const choose = (next) => {
        setRoot(next);
        try { window.localStorage.setItem(ROOT_KEY, next); } catch { /* storage may be blocked */ }
      };

      const view = React.useMemo(() => collect(board, filter, openCaps), [board, filter, openCaps]);

      if (!workspaces.length) {
        return h('div', { className: 'dw-board' }, h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
          h('div', { className: 'dw-state' }, h('b', null, '还没有打开的工作区。'),
            h('div', null, '先在左侧打开一个项目目录，看板会读取该目录下的 .dsh-dev 记录。')));
      }

      return h('div', { className: 'dw-board' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h('div', { className: 'dw-bar' },
          h('div', { className: 'dw-heading' },
            h('h1', { className: 'dw-title' }, '研发看板'),
            h('p', { className: 'dw-sub', title: board?.root ?? '' },
              board?.projectId ? `${board.projectId} · ${board.root.split('/').pop()}` : '读取 .dsh-dev 记录')),
          h('div', { className: 'dw-tools' },
            h('div', { className: 'dw-tabs', role: 'tablist' }, FILTERS.map((option) => h('button', {
              key: option.id,
              type: 'button',
              className: 'dw-tab',
              'data-on': filter === option.id ? '1' : '0',
              onClick: () => setFilter(option.id),
            }, option.label, h('b', null, String(view.counts[option.id]))))),
            h('select', {
            className: 'dw-select',
            value: active,
            'aria-label': '选择工作区',
            onChange: (event) => choose(event.target.value),
          }, options.map((option) => h('option', { key: option.id, value: option.id }, option.label))),
            h('button', { type: 'button', className: 'dw-refresh', onClick: () => setTick((value) => value + 1) }, loading ? '刷新中…' : '刷新'))),
        error
          ? h('div', { className: 'dw-state' }, h('b', null, '看板读不到这台机器的记录。'), h('div', { className: 'dw-warn' }, error),
            h('div', null, '会话与 dev_* 工具不受影响；确认 dsh web 已重启到带看板版本的插件。'))
          : board === null
            ? h('div', { className: 'dw-state' }, loading ? '读取中…' : '暂无数据')
            : view.counts.all === 0
              ? h('div', { className: 'dw-state' }, h('b', null, '这个工作区还没有记录。'),
                h('div', null, '在选了「研发助手 · Dev Assistant」的会话里提一条需求，看板就会出现第一张卡片。'))
              : h('div', { className: 'dw-cols' }, view.columns.map((column) => columnNode(column, showMore))));
    }

    function PanelIcon(props) {
      const size = props?.size ?? 16;
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none' },
        h('rect', { x: 1.5, y: 2.5, width: 3.4, height: 11, rx: 1, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('rect', { x: 6.3, y: 2.5, width: 3.4, height: 7.5, rx: 1, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('rect', { x: 11.1, y: 2.5, width: 3.4, height: 9.5, rx: 1, stroke: 'currentColor', strokeWidth: 1.3 }));
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        // Resolved per render, not captured once: a profile that mounts the
        // workspace service late must still get a working dropdown, and one
        // without it gets the "no workspace" state instead of a broken panel.
        inject: () => ({ workspaceStore: ctx.get?.('workspaces')?.list }),
      }, Board));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 11,
        label: () => '研发看板',
      }, PanelIcon));
    }

    // Test / tooling surface: verify/preview.mjs renders these exact nodes with
    // this exact CSS offline, so the screenshot is not a hand-written mock.
    return {
      apply,
      inject: ['slots'],
      __board: { collect, columnNode, cardNode, taskColumn, CSS, FILTERS, COLUMNS, PANEL_ID, ENDPOINT },
    };
  },
});
