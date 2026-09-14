/**
 * @dsh-lab/client — DLab panel in the official native right Sidebar.
 *
 * Registers through the native sidebar's public two-stage path (the same one
 * the shipped tab types use):
 *   1. ctx.sidebarRightTabs.register — a page tab type (kind 'dsh-lab') with
 *      a guide entry, so the sidebar's guide page offers a DLab capsule
 *   2. ctx.slots.register({ name: 'sidebar.right.pane.tab', key }) — the tab
 *      body, receiving useTabInfo (visible / actions) from the slot framework
 * Plus a 🧪 quick-entry button in conversation.session.header.actions that
 * opens the tab through ctx.sidebarRight.openTab.
 *
 * The research evolution renders as a commit list: each row is one event in
 * the lab's history (run / fork / merge / archive / init). The left graph
 * cell draws the branch lanes — main on lane 0, one lane per experiment —
 * with bezier connectors at fork/merge points, like a git graph. Right
 * columns: message, author badge (the owning solution), short hash (gold
 * monospace), date.
 *
 * All operations (fork, run, merge, archive) are agent-only via lab_* tools.
 * This UI is 100% read-only observation.
 *
 * Workspace scoping: the tab resolves the session cwd (sessions service) and
 * renders a "not a lab workspace" empty state when it sits outside the lab
 * project root, so unrelated workspaces no longer surface the (single) lab
 * project's data.
 */

/* eslint-disable */

window.__ModuleLoader__.load({
	id: '@dsh-lab/client',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		var React = require('react');
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;
		var useMemo = React.useMemo;
		var useRef = React.useRef;

		var RPC = '/dsh-lab';
		var POLL_MS = 8000;

		var C = {
			bg: 'var(--dsw-alias-bg-base, #f8f9fa)',
			card: 'var(--dsw-alias-bg-layer-1, #fff)',
			nested: 'var(--dsw-alias-bg-layer-2, #f0f1f3)',
			overlay: 'var(--dsw-alias-bg-overlay, #fff)',
			bd: 'var(--dsw-alias-border-l1, #e0e0e0)',
			bd2: 'var(--dsw-alias-border-l2, #c0c0c0)',
			brand: 'var(--dsw-alias-brand-primary, #2563eb)',
			tx: 'var(--dsw-alias-label-primary, #1a1a2e)',
			tx2: 'var(--dsw-alias-label-secondary, #667)',
			red: 'var(--dsw-alias-state-error-primary, #d33)',
			green: 'var(--dsw-alias-state-success-primary, #2a2)',
			yellow: 'var(--dsw-alias-state-warn-primary, #d70)',
		};

		/** Branch-lane palette (git-graph style; index = lane number). */
		var LANES = ['#1a7f37', '#bc4c00', '#8250df', '#1b7c83', '#bf3989', '#9a6700', '#0969da', '#6e7781', '#116329', '#953800'];
		var MAIN_COLOR = LANES[0];
		var HASH_COLOR = '#b08800';
		var GRAY = '#8c959f';

		var ROW_H = 30;

		var STYLE = [
			// cosmetic-only classes — all layout-critical styling is inline, so
			// the panel survives even if this <style> tag is stripped
			'.dlabg-row:hover{background:rgba(127,127,127,0.09);}',
			'.dlabg-row.dlabg-sel{background:rgba(72,143,255,0.13);}',
			'@keyframes dlabg-pulse{0%{opacity:0.85}70%{opacity:0.15}100%{opacity:0.85}}',
			'.dlabg-pulse{animation:dlabg-pulse 1.6s ease-in-out infinite;}',
		].join('\n');

		// ── small helpers ────────────────────────────────────────────────────

		function short(s, n) {
			if (!s) return '';
			return s.length > n ? s.slice(0, n) + '…' : s;
		}

		var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

		function pad2(n) { return (n < 10 ? '0' : '') + n; }

		function fmtDate(ts) {
			if (!ts) return '';
			var d = new Date(ts);
			var now = new Date();
			var day = d.getDate() + ' ' + MON[d.getMonth()];
			var hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
			return d.getFullYear() === now.getFullYear() ? day + ' ' + hm : day + ' ' + d.getFullYear();
		}

		function fmtDur(ms) {
			if (ms === undefined || ms === null || isNaN(ms)) return '';
			if (ms < 1000) return Math.round(ms) + 'ms';
			var s = Math.round(ms / 1000);
			if (s < 60) return s + 's';
			var m = Math.floor(s / 60);
			s = s % 60;
			if (m < 60) return m + 'm ' + pad2(s) + 's';
			var hr = Math.floor(m / 60);
			return hr + 'h ' + pad2(m % 60) + 'm';
		}

		function laneColor(l) { return LANES[l % LANES.length]; }

		function initials(slug) {
			var parts = String(slug || '?').split(/[-_]/).filter(Boolean);
			var out = parts.slice(0, 2).map(function (w) { return w.charAt(0).toUpperCase(); }).join('');
			return out || '?';
		}

		function hashShort(hash) { return String(hash || '').slice(0, 8); }

		/**
		 * Collapse an argv into a readable one-liner: interpreters become
		 * `python`, absolute paths inside the lab root become project-relative,
		 * other absolute paths degrade to their basename. Turns
		 * `/home/x/PRD/.venv/bin/python train.py --config /home/x/PRD/configs/a.yaml`
		 * into `python train.py --config configs/a.yaml`.
		 */
		function prettyCommand(argv, projectRoot) {
			if (!argv || !argv.length) return '';
			var root = projectRoot ? String(projectRoot).replace(/\/+$/, '') : null;
			function prettyArg(a) {
				var s = String(a);
				if (s.indexOf('/') !== 0) return s;
				if (/(^|\/)(python|python3(\.\d+)?|node|bash|sh)$/.test(s)) {
					var m = s.match(/(python3(\.\d+)?|python|node|bash|sh)$/);
					return m ? m[1] : s;
				}
				if (root && (s === root || s.indexOf(root + '/') === 0)) {
					var rel = s === root ? '.' : s.slice(root.length + 1);
					return './' + rel;
				}
				var base = s.slice(s.lastIndexOf('/') + 1);
				return base || s;
			}
			return argv.map(prettyArg).join(' ');
		}

		/** Containment of cwd in the lab root; null when either is unknown. */
		function workspaceMatch(root, cwd) {
			if (!root || !cwd) return null;
			var r = String(root).replace(/\/+$/, '');
			var w = String(cwd).replace(/\/+$/, '');
			return w === r || w.indexOf(r + '/') === 0;
		}

		/** Module-level cache of the lab root — lets the synchronous
		 *  `available` predicate work before the first RPC resolves. */
		var rootCache = { root: null };

		// ── RPC hook ─────────────────────────────────────────────────────────

		/**
		 * RPC helper. `cwd` (the sidebar session's working directory) rides in
		 * every payload so the host resolves the lab project dynamically: the
		 * configured root when the cwd sits inside it, else the nearest
		 * ancestor holding an initialized `.dsh-lab/lab.sqlite`.
		 */
		function useRpc(ctx, cwd) {
			return useMemo(function () {
				var rpc = ctx && ctx.connection && ctx.connection.rpc;
				return function (ep, p) {
					if (!rpc) return Promise.resolve({ ok: false, error: { message: 'No connection' } });
					var payload = Object.assign({}, p || {});
					if (cwd) payload.cwd = cwd;
					return rpc.call(RPC, ep, payload).then(
						function (r) { return r && r.ok ? r : { ok: false, error: (r && r.error) || { message: 'RPC failed' } }; },
						function (e) { return { ok: false, error: { message: String((e && e.message) || e) } }; },
					);
				};
			}, [ctx, cwd]);
		}

		/** Measured container width (0 = unknown → render every column).
		 *  `rekey` re-arms the observer when the measured node mounts late
		 *  (e.g. after the loading state finishes). */
		function useWidth(ref, rekey) {
			var st = useState(0);
			var set = st[1];
			st = st[0];
			useEffect(function () {
				var el = ref.current;
				if (!el || typeof ResizeObserver === 'undefined') return;
				var ro = new ResizeObserver(function (entries) {
					var w = entries && entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0;
					set(Math.round(w));
				});
				ro.observe(el);
				return function () { ro.disconnect(); };
			}, [ref, rekey]);
			return st;
		}

		// ── model: rows + lanes (pure computation, no React) ─────────────────

		function emptyModel() {
			return {
				project: {}, nodes: [], runs: [], events: [],
				bySlug: {}, slugByLane: { 0: 'main' },
				rows: [], laneCount: 1, laneOf: { main: 0 },
				xOf: function () { return 14; }, graphW: 30,
				tipRow: {}, topIdx: {}, botIdx: {}, topIsTerminal: {}, branchByLane: { 0: 'main' },
				resources: null,
				counts: { solutions: 0, running: 0 },
			};
		}

		/**
		 * Merge runs + solution lifecycle events into one chronological row
		 * list (newest first) and assign branch lanes (main = lane 0, one
		 * lane per experiment in fork order).
		 */
		function buildModel(data) {
			if (!data) return emptyModel();
			var project = data.project || {};
			var graph = data.graph || {};
			var nodes = graph.nodes || [];
			var runs = data.runs || [];
			var events = data.events || [];
			var milestones = graph.milestones || [];

			if (nodes.length === 0 && runs.length === 0) return emptyModel();

			var bySlug = {};
			nodes.forEach(function (n) { bySlug[n.id] = n; });

			// event time maps (first occurrence wins)
			var forkTime = {}, mergeTime = {}, archiveTime = {};
			events.forEach(function (e) {
				if (!e || !e.entityId) return;
				if (e.type === 'SolutionForked' && forkTime[e.entityId] === undefined) forkTime[e.entityId] = e.time;
				else if (e.type === 'SolutionMerged' && mergeTime[e.entityId] === undefined) mergeTime[e.entityId] = e.time;
				else if (e.type === 'SolutionArchived' && archiveTime[e.entityId] === undefined) archiveTime[e.entityId] = e.time;
			});

			var exps = nodes.filter(function (n) { return n.role !== 'main'; });

			// oldest / newest run per slug (for synthesized event times)
			var oldestRun = {}, newestRun = {};
			runs.forEach(function (r) {
				var s = r.solutionSlug;
				if (!s) return;
				if (oldestRun[s] === undefined || r.createdAt < oldestRun[s]) oldestRun[s] = r.createdAt;
				if (newestRun[s] === undefined || r.createdAt > newestRun[s]) newestRun[s] = r.createdAt;
			});

			// lane assignment: experiments in fork-time order → lanes 1..n
			var order = exps.map(function (n, i) {
				var t = forkTime[n.id] !== undefined ? forkTime[n.id]
					: oldestRun[n.id] !== undefined ? oldestRun[n.id] - 1
					: (n.lastRunAt || 0) - 1;
				return { n: n, i: i, t: t };
			});
			order.sort(function (a, b) { return (a.t - b.t) || (a.i - b.i); });
			var laneOf = { main: 0 };
			order.forEach(function (o, i) { laneOf[o.n.id] = i + 1; });
			var laneCount = exps.length + 1;

			// ── rows ──────────────────────────────────────────────────────────
			var rows = [];

			// Lifecycle events only: a run is NOT a history row — runs live in
			// the Runs tab. The graph answers "what did the research do"
			// (init / fork / merge / archive), not "what executed".

			// fork rows — synthesized for every experiment so each lane has a
			// visible branch point off its parent lane
			exps.forEach(function (n) {
				var parent = n.parent || 'main';
				var t = forkTime[n.id];
				if (t === undefined) t = (oldestRun[n.id] !== undefined ? oldestRun[n.id] : (n.lastRunAt || 0)) - 1;
				rows.push({
					kind: 'fork', time: t, lane: laneOf[n.id],
					parentLane: laneOf[parent] !== undefined ? laneOf[parent] : 0,
					slug: n.id, parent: parent, hash: n.headCommit,
				});
			});

			// merge rows — dot on the target lane, curve from the source lane
			exps.forEach(function (n) {
				if (!n.mergedInto) return;
				var t = mergeTime[n.id];
				if (t === undefined) t = (newestRun[n.id] !== undefined ? newestRun[n.id] : (n.lastRunAt || 0)) + 1;
				var vLabel = '';
				milestones.forEach(function (m) { if (m.source === n.id) vLabel = m.label; });
				rows.push({
					kind: 'merge', time: t,
					lane: laneOf[n.mergedInto] !== undefined ? laneOf[n.mergedInto] : 0,
					srcLane: laneOf[n.id], slug: n.id, target: n.mergedInto, vLabel: vLabel,
				});
			});

			// archive rows — terminal dot on the solution's own lane
			exps.forEach(function (n) {
				if (n.status !== 'archived' || n.mergedInto) return;
				var t = archiveTime[n.id];
				if (t === undefined) t = (newestRun[n.id] !== undefined ? newestRun[n.id] : (n.lastRunAt || 0)) + 1;
				rows.push({ kind: 'archive', time: t, lane: laneOf[n.id], slug: n.id });
			});

			// init row — the root commit on main
			var minT = Date.now();
			rows.forEach(function (r) { if (r.time < minT) minT = r.time; });
			rows.push({ kind: 'init', time: minT - 1, lane: 0, slug: 'main' });

			rows.sort(function (a, b) { return b.time - a.time; });

			// ── lane geometry ─────────────────────────────────────────────────
			var laneGap = laneCount <= 1 ? 0 : Math.min(13, Math.max(8, Math.floor(150 / (laneCount - 1))));
			var xOf = function (l) { return 14 + l * laneGap; };
			var graphW = laneCount <= 1 ? 30 : xOf(laneCount - 1) + 14;

			// branch-tip row + lane span ends
			var slugByLane = { 0: 'main' };
			order.forEach(function (o) { slugByLane[laneOf[o.n.id]] = o.n.id; });

			var tipRow = {};
			var botIdx = {}; // fork row = bottom (oldest) end of a lane
			var topIdx = {}; // terminal (merge/archive) row = top end when present
			var topIsTerminal = {}; // whether the top end is a merge/archive row
			rows.forEach(function (r, i) {
				if (r.kind === 'fork') botIdx[r.lane] = i;
				if (r.kind === 'merge' && topIdx[r.srcLane] === undefined) { topIdx[r.srcLane] = i; topIsTerminal[r.srcLane] = true; }
				if (r.kind === 'archive' && topIdx[r.lane] === undefined) { topIdx[r.lane] = i; topIsTerminal[r.lane] = true; }
			});
			for (var l = 1; l < laneCount; l++) {
				// tip row: the lane's newest activity (merge > run > fork)
				var tip = -1;
				for (var ri = 0; ri < rows.length; ri++) {
					var rr = rows[ri];
					var isTip = (rr.lane === l && rr.kind === 'run') || (rr.kind === 'merge' && rr.slug === slugByLane[l]);
					if (isTip) { tip = ri; break; }
				}
				if (tip >= 0) tipRow[l] = tip;
				if (topIdx[l] === undefined) {
					var newestRunIdx = -1;
					for (var ri2 = 0; ri2 < rows.length; ri2++) {
						if (rows[ri2].lane === l && rows[ri2].kind === 'run') { newestRunIdx = ri2; break; }
					}
					topIdx[l] = newestRunIdx >= 0 ? newestRunIdx : botIdx[l];
					topIsTerminal[l] = false;
				}
			}
			// main's tip: its newest row (a merge commit is main's head when it
			// is the newest main-lane row; with no merges that is init itself)
			// — never overwritten, so an experiment never claims main's pill
			tipRow[0] = rows.length > 0 ? rows.length - 1 : 0;

			// branch name owning each lane (drives the tip branch pill)
			var branchByLane = { 0: 'main' };
			order.forEach(function (o) { branchByLane[laneOf[o.n.id]] = o.n.branch; });

			var running = runs.filter(function (r) { return r.status === 'running' || r.status === 'starting'; }).length;

			return {
				project: project, nodes: nodes, runs: runs, events: events,
				bySlug: bySlug, slugByLane: slugByLane,
				rows: rows, laneCount: laneCount, laneOf: laneOf,
				xOf: xOf, graphW: graphW, tipRow: tipRow, topIdx: topIdx, botIdx: botIdx,
				topIsTerminal: topIsTerminal, branchByLane: branchByLane,
				resources: data.resources || null,
				counts: { solutions: nodes.length, running: running },
			};
		}

		// ── graph cell SVG ───────────────────────────────────────────────────

		/**
		 * One absolutely-positioned SVG behind the row list. Main is a single
		 * spine through every row; each experiment lane draws through-lines
		 * between its terminal (top) and fork (bottom) rows, a fork bezier
		 * off its parent lane, and a merge bezier into its target lane.
		 */
		function GraphSVG(props) {
			var m = props.model;
			var rows = m.rows;
			var laneCount = m.laneCount;
			var H = rows.length * ROW_H;
			var els = [];

			// main spine: one vertical through the whole list
			if (rows.length > 0) {
				var x0 = m.xOf(0);
				els.push(h('line', {
					key: 'main',
					x1: x0, y1: ROW_H / 2, x2: x0, y2: H - ROW_H / 2,
					stroke: MAIN_COLOR, strokeWidth: 2,
				}));
			}

			for (var i = 0; i < rows.length; i++) {
				var row = rows[i];
				var y = i * ROW_H;
				var ym = y + ROW_H / 2;
				var y0 = y;
				var y1 = y + ROW_H;

				// experiment-lane through-lines. Rows are newest-first, so a
				// lane's history (top = terminal/tip … bot = fork) is drawn
				// with git-graph semantics:
				//   fork row (bottom end)  — half line UP from the dot, plus
				//                            the bezier off the parent lane
				//   rows between           — full through-line
				//   terminal row (merge/   — half line DOWN from the terminal
				//   archive top end)         into the history below
				//   run-tip top end        — no line above: the branch ends
				//                            at the tip dot
				for (var l = 1; l < laneCount; l++) {
					var top = m.topIdx[l];
					var bot = m.botIdx[l];
					if (bot === undefined) continue;
					var x = m.xOf(l);
					if (i === bot) {
						// fork row: the branch begins at this dot
						els.push(h('line', { key: 'lb' + i + '_' + l, x1: x, y1: y0, x2: x, y2: ym, stroke: laneColor(l), strokeWidth: 2 }));
						continue;
					}
					if (i < top || i > bot) continue;
					if (i === top) {
						if (!m.topIsTerminal[l]) continue; // run tip: line ends at the dot
						els.push(h('line', { key: 'lt' + i + '_' + l, x1: x, y1: ym, x2: x, y2: y1, stroke: laneColor(l), strokeWidth: 2 }));
					} else {
						els.push(h('line', { key: 'll' + i + '_' + l, x1: x, y1: y0, x2: x, y2: y1, stroke: laneColor(l), strokeWidth: 2 }));
					}
				}

				// fork connector: parent lane bottom edge → this lane's dot
				if (row.kind === 'fork') {
					var xp = m.xOf(row.parentLane);
					var xc = m.xOf(row.lane);
					els.push(h('path', {
						key: 'f' + i,
						d: 'M' + xp + ',' + y1 + ' C' + xp + ',' + ym + ' ' + xc + ',' + ym + ' ' + xc + ',' + ym,
						fill: 'none', stroke: laneColor(row.lane), strokeWidth: 2,
					}));
				}

				// merge connector: source lane center → target lane dot
				if (row.kind === 'merge') {
					var xs = m.xOf(row.srcLane);
					var xt = m.xOf(row.lane);
					els.push(h('path', {
						key: 'm' + i,
						d: 'M' + xs + ',' + ym + ' C' + (xs + (xt - xs) / 2) + ',' + ym + ' ' + (xt - (xt - xs) / 2) + ',' + ym + ' ' + xt + ',' + ym,
						fill: 'none', stroke: laneColor(row.srcLane), strokeWidth: 2,
					}));
				}

				// dots
				var dotX = null, dotCol = null, dotR = 4.5, pulse = false;
				if (row.kind === 'run') {
					dotX = m.xOf(row.lane); dotCol = laneColor(row.lane);
					var stt = row.run.status;
					if (stt === 'running' || stt === 'starting') { dotCol = '#0969da'; pulse = true; }
					else if (stt === 'queued') dotCol = '#9a6700';
					else if (stt === 'failed') dotCol = '#cf222e';
					else if (stt === 'canceled' || stt === 'lost') dotCol = GRAY;
				} else if (row.kind === 'fork') {
					dotX = m.xOf(row.lane); dotCol = laneColor(row.lane); dotR = 4;
				} else if (row.kind === 'merge') {
					dotX = m.xOf(row.lane); dotCol = laneColor(row.lane); dotR = 5;
				} else if (row.kind === 'archive') {
					dotX = m.xOf(row.lane); dotCol = GRAY;
				} else if (row.kind === 'init') {
					dotX = m.xOf(0); dotCol = MAIN_COLOR; dotR = 5;
				}
				if (dotX !== null) {
					if (pulse) {
						els.push(h('circle', { key: 'p' + i, cx: dotX, cy: ym, r: dotR + 4, fill: 'none', stroke: dotCol, strokeWidth: 1.5, 'class': 'dlabg-pulse' }));
					}
					els.push(h('circle', {
						key: 'd' + i, cx: dotX, cy: ym,
						r: props.selected === i ? dotR + 1.5 : dotR,
						fill: dotCol,
						stroke: props.selected === i ? String(C.brand) : 'transparent', strokeWidth: 2,
					}));
				}
			}

			return h('svg', {
				xmlns: 'http://www.w3.org/2000/svg',
				width: m.graphW, height: H,
				viewBox: '0 0 ' + m.graphW + ' ' + H,
				style: { position: 'absolute', left: 0, top: 0, display: 'block' },
			}, els);
		}

		// ── one row of the commit list ───────────────────────────────────────

		function Row(props) {
			var m = props.model;
			var row = props.row;
			var i = props.index;
			var sel = props.selected === i;
			var n = m.bySlug[row.slug] || {};
			var col = laneColor(row.lane);

			// status chip on run rows / dirty chip on solutions
			var chipStyle = function (c) {
				return { display: 'inline-block', fontSize: 9, fontWeight: 600, lineHeight: 1, padding: '2px 6px', borderRadius: 999, marginLeft: 6, verticalAlign: 1, color: c[0], background: c[1] };
			};
			var chips = [];
			if (row.kind === 'run') {
				var st = row.run.status;
				var map = {
					running: ['#0969da', 'rgba(9,105,218,0.12)'],
					starting: ['#0969da', 'rgba(9,105,218,0.12)'],
					queued: ['#9a6700', 'rgba(154,103,0,0.13)'],
					failed: ['#cf222e', 'rgba(207,34,46,0.11)'],
					canceled: [GRAY, 'rgba(127,127,127,0.14)'],
					lost: [GRAY, 'rgba(127,127,127,0.14)'],
				};
				if (map[st]) chips.push(h('span', { key: 'c', style: chipStyle(map[st]) }, st));
				// sweep convention: `<param>=<value>` tags render as param pills
				// (e.g. lr=0.01); sweep/<name> group tags stay in the Runs tab
				var paramShown = 0;
				var tags = row.run.tags || [];
				for (var ti = 0; ti < tags.length && paramShown < 2; ti++) {
					var tag = String(tags[ti]);
					if (/^[^/=\s]+=[^\s]+$/.test(tag)) {
						chips.push(h('span', { key: 'p' + ti, style: chipStyle(['#0969da', 'rgba(9,105,218,0.08)']), title: tag }, tag));
						paramShown++;
					}
				}
			}
			if (n.dirty) chips.push(h('span', { key: 'd', style: chipStyle(['#9a6700', 'rgba(154,103,0,0.13)']) }, 'dirty'));

				// branch pill on each lane's tip row; milestone label on merges
				var pillStyle = { display: 'inline-block', fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 9, lineHeight: 1, padding: '3px 6px', borderRadius: 999, background: 'rgba(127,127,127,0.13)', color: 'var(--dsw-alias-label-secondary,#556)', marginLeft: 6, verticalAlign: 1 };
				var pill = null;
				// a milestone label wins, but the branch pill still shows when the
				// merge row is also a lane tip (no run rows on that lane)
				var bpillNeeded = m.tipRow[row.lane] === i && m.branchByLane[row.lane];
				var bpill = bpillNeeded ? h('span', { key: 'b', style: pillStyle }, m.branchByLane[row.lane]) : null;
				if (row.kind === 'merge' && row.vLabel) {
					pill = h('span', { key: 'v', style: Object.assign({}, pillStyle, { color: MAIN_COLOR, fontWeight: 700 }) }, row.vLabel);
					if (bpill) pill = [pill, bpill];
				} else {
					pill = bpill;
				}

			// message text
			var msg = '';
			if (row.kind === 'run') msg = row.title;
			else if (row.kind === 'fork') msg = 'fork ' + row.slug + ' ← ' + row.parent;
			else if (row.kind === 'merge') msg = 'merge ' + row.slug + ' → ' + row.target;
			else if (row.kind === 'archive') msg = 'archive ' + row.slug;
			else if (row.kind === 'init') msg = 'init ' + (m.project.name || 'lab') + ' · v1';

			return h('div', {
				'class': 'dlabg-row' + (sel ? ' dlabg-sel' : ''),
				style: {
					display: 'flex', alignItems: 'center', minHeight: ROW_H,
					fontSize: 12, lineHeight: 1.35, cursor: 'pointer',
					paddingLeft: m.graphW + 8, paddingRight: 10, gap: 8,
				},
				onClick: function () { props.onSelect(i); },
				title: msg,
			},
				h('span', {
					style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary,#1a1a2e)' },
				},
					h('span', { style: { fontWeight: row.kind === 'run' ? 400 : 600 } }, msg),
					chips, pill),
				h('span', {
					style: { width: 17, height: 17, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, color: '#fff', flex: '0 0 auto', letterSpacing: '0.02em', background: col, opacity: n.status === 'archived' ? 0.45 : 1 },
					title: row.slug,
				}, initials(row.slug)),
				(props.width > 0 && props.width <= 470) || m.counts.solutions <= 1 ? null
					: h('span', { style: { color: C.tx2, fontSize: 11, flex: '0 0 auto', maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.slug),
				row.hash
					? h('span', { style: { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 11, color: HASH_COLOR, flex: '0 0 auto' } }, hashShort(row.hash))
					: h('span', { style: { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 11, flex: '0 0 auto', opacity: 0 } }, '········'),
				(props.width > 0 && props.width <= 380) ? null
					: h('span', { style: { color: 'var(--dsw-alias-label-secondary,#667)', fontSize: 11, flex: '0 0 auto', whiteSpace: 'nowrap' } }, fmtDate(row.time)),
			);
		}

		// ── bottom-tab contents ──────────────────────────────────────────────

		function KV(props) {
			return h('div', { style: { display: 'flex', gap: 8, lineHeight: 1.7 } },
				h('span', { style: { flex: '0 0 76px', color: C.tx2, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', paddingTop: 2 } }, props.k),
				h('span', {
					style: {
						minWidth: 0, color: C.tx, overflow: 'hidden',
						whiteSpace: props.wrap ? 'normal' : 'nowrap',
						textOverflow: 'ellipsis', wordBreak: 'break-word',
					},
				}, props.v));
		}

		function StatusChip(props) {
			var st = props.status;
			var col = C.tx2, bg = 'rgba(127,127,127,0.13)';
			if (st === 'active') { col = '#1a7f37'; bg = 'rgba(26,127,55,0.11)'; }
			else if (st === 'merged') { col = '#0969da'; bg = 'rgba(9,105,218,0.11)'; }
			else if (st === 'archived') { col = GRAY; }
			else if (st === 'broken') { col = '#cf222e'; bg = 'rgba(207,34,46,0.1)'; }
			else if (st === 'running' || st === 'starting') { col = '#0969da'; bg = 'rgba(9,105,218,0.12)'; }
			else if (st === 'succeeded') { col = '#1a7f37'; bg = 'rgba(26,127,55,0.11)'; }
			else if (st === 'failed') { col = '#cf222e'; bg = 'rgba(207,34,46,0.1)'; }
			else if (st === 'queued') { col = '#9a6700'; bg = 'rgba(154,103,0,0.13)'; }
			return h('span', { 'class': 'dlabg-chip', style: { color: col, background: bg, marginLeft: 8 } }, st);
		}

		function gb(mb) { return (mb / 1024).toFixed(1) + 'G'; }

		/** GPU status block: one compact row per GPU + queue depth. Wide panels
		 *  with many GPUs fold into a two-column grid to save vertical space. */
		function ResourceSection(props) {
			var gpus = props.resources.gpus || [];
			var queued = (props.resources.queued || []).length;
			if (!gpus.length && !queued) return null;
			var twoCol = !!props.twoCol && gpus.length >= 4;
			var rows = gpus.map(function (g) {
				var busy = (g.runningRunIds || []).length;
				var frac = g.totalVramMB > 0 ? g.freeVramMB / g.totalVramMB : 1;
				var col = busy > 0 ? '#0969da' : frac < 0.1 ? '#9a6700' : '#1a7f37';
				return h('div', { key: g.id, style: Object.assign({
					display: 'flex', alignItems: 'center', gap: 8, minHeight: 24, padding: '2px 8px', margin: '0 -8px', borderRadius: 6,
				}, twoCol ? { width: '50%', boxSizing: 'border-box' } : {}) },
					h('span', { style: { width: 8, height: 8, borderRadius: 8, background: col, flex: '0 0 auto' } }),
					h('span', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 11, color: 'var(--dsw-alias-label-primary,#1a1a2e)', flex: '0 0 auto' } }, 'GPU' + g.id),
					h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary,#667)', flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, g.model || ''),
					h('span', { style: { flex: '1 1 auto' } }),
					h('span', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 10.5, color: 'var(--dsw-alias-label-secondary,#667)', flex: '0 0 auto' } }, gb(g.freeVramMB) + ' / ' + gb(g.totalVramMB)),
					h('span', { style: { fontSize: 10.5, color: busy ? '#0969da' : 'var(--dsw-alias-label-secondary,#667)', flex: '0 0 auto', minWidth: 44, textAlign: 'right' } }, busy ? busy + ' run' + (busy > 1 ? 's' : '') : 'idle'),
				);
			});
			return [
				h('div', { key: 'rh', style: { marginTop: 10, marginBottom: 2, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.tx2 } },
					'Resources' + (queued ? ' · ' + queued + ' queued' : '')),
				h('div', { key: 'rrows', style: twoCol ? { display: 'flex', flexWrap: 'wrap', rowGap: 2 } : undefined }, rows),
			];
		}

		/** Accented quote block for hypothesis / conclusion text. */
		function Quote(props) {
			return h('div', {
				style: {
					margin: '8px 0 2px', padding: '6px 10px',
					borderLeft: '3px solid ' + props.color,
					background: 'rgba(127,127,127,0.06)',
					borderRadius: '0 6px 6px 0',
				},
			},
				h('div', { style: { fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.tx2, marginBottom: 2 } }, props.k),
				h('div', { style: { fontStyle: 'italic', color: 'var(--dsw-alias-label-primary,#1a1a2e)', lineHeight: 1.5, wordBreak: 'break-word', whiteSpace: 'pre-wrap' } }, props.v));
		}

		/** Change-file chip: colored status letter + mono path. */		function FileChip(props) {
			var sc = props.status === 'A' ? '#1a7f37' : props.status === 'D' ? '#cf222e' : '#9a6700';
			return h('span', {
				title: props.path,
				style: {
					display: 'inline-flex', alignItems: 'center', maxWidth: '100%',
					fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 10,
					padding: '2px 6px', borderRadius: 4,
					background: 'rgba(127,127,127,0.09)', color: 'var(--dsw-alias-label-primary,#1a1a2e)',
					overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
				},
			},
				h('span', { style: { color: sc, fontWeight: 700, marginRight: 5, flex: '0 0 auto' } }, props.status),
				h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, props.path));
		}

		/**
		 * Promotion gate: fork first, merge to main only with evidence.
		 *
		 * Mirrors the lab workflow the tools enforce — an experiment line is
		 * created by a FORK, and it may only be merged into `main` after it has
		 * produced at least one succeeded run. A failed/canceled-only line is
		 * shown as not mergeable, so the panel answers "can I promote this?"
		 * without reading the CLI.
		 */
		function MergeGate(props) {
			var sol = props.sol || {};
			var runs = props.runs || [];
			if (!sol.id || sol.role === 'main') return null;

			var isFork = !!sol.parent && sol.parent !== sol.id;
			var succeeded = runs.filter(function (r) { return r.status === 'succeeded'; }).length;
			var failed = runs.filter(function (r) { return r.status === 'failed' || r.status === 'canceled' || r.status === 'lost'; }).length;
			var live = runs.filter(function (r) { return r.status === 'running' || r.status === 'starting' || r.status === 'queued'; }).length;

			var verdict, tone;
			if (sol.mergedInto) { verdict = 'merged into ' + sol.mergedInto; tone = '#0969da'; }
			else if (!isFork) { verdict = 'not forked — fork before experimenting'; tone = '#9a6700'; }
			else if (succeeded === 0) { verdict = live > 0 ? 'running — no evidence yet' : 'no successful run — not mergeable'; tone = '#9a6700'; }
			else { verdict = 'eligible to merge (' + succeeded + ' successful run' + (succeeded > 1 ? 's' : '') + ')'; tone = '#1a7f37'; }

			function step(label, state, detail) {
				var col = state === 'ok' ? '#1a7f37' : state === 'bad' ? '#cf222e' : state === 'todo' ? '#9a6700' : GRAY;
				return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, lineHeight: 1.6 } },
					h('span', { style: { width: 7, height: 7, borderRadius: 7, background: col, flex: '0 0 auto' } }),
					h('span', { style: { color: 'var(--dsw-alias-label-primary,#1a1a2e)', flex: '0 0 auto' } }, label),
					h('span', { style: { color: C.tx2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, detail || ''));
			}

			return h('div', { style: { marginTop: 10 } },
				h('div', { style: { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.tx2, marginBottom: 4 } }, 'Promotion'),
				step('fork', isFork ? 'ok' : 'todo', isFork ? ('from ' + sol.parent) : 'no parent — fork first'),
				step('experiment', runs.length > 0 ? 'ok' : 'todo',
					runs.length + ' run' + (runs.length === 1 ? '' : 's') + (live ? ' · ' + live + ' live' : '') + (failed ? ' · ' + failed + ' failed/canceled' : '')),
				step('evidence', succeeded > 0 ? 'ok' : (live > 0 ? 'wait' : 'bad'),
					succeeded > 0 ? (succeeded + ' succeeded') : 'no successful run yet'),
				step('merge to main', sol.mergedInto ? 'ok' : (succeeded > 0 ? 'wait' : 'bad'), verdict),
			);
		}

		var LOG_PRE = {
			margin: 0, padding: '6px 8px', borderRadius: 6,
			background: 'var(--dsw-alias-bg-layer-2,#f0f1f3)',
			fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 10, lineHeight: 1.45,
			maxHeight: 170, overflowY: 'auto', overflowX: 'hidden',
			whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary,#1a1a2e)',
		};

		/**
		 * Lazy tail of a selected run's output via the runs.log RPC. Refreshes
		 * every 4s while the run is live; static after settlement. stdout first,
		 * stderr dimmed below (progress bars often live there).
		 */
		function RunLogSection(props) {
			var call = props.call;
			var run = props.run;
			var runId = run ? run.id : null;
			var runStatus = run ? run.status : null;
			var st0 = useState(null);
			var st = st0[0];
			var set = st0[1];
			useEffect(function () {
				if (!call || !runId) { set(null); return undefined; }
				var alive = true;
				var fetchLog = function () {
					call('runs.log', { runId: runId, maxLines: 40 }).then(function (res) {
						if (!alive) return;
						if (res.ok) set({ stdout: res.value.stdout || '', stderr: res.value.stderr || '', error: null });
						else set({ stdout: '', stderr: '', error: res.error.message });
					});
				};
				fetchLog();
				if (runStatus !== 'running' && runStatus !== 'starting') {
					return function () { alive = false; };
				}
				var t = setInterval(fetchLog, 4000);
				return function () { alive = false; clearInterval(t); };
			}, [call, runId, runStatus]);
			if (!run || !run.runDir) return null;
			var live = runStatus === 'running' || runStatus === 'starting';
			var text = st ? st.stdout : '';
			var err = st ? st.stderr : '';
			var inner;
			if (!st) inner = h('div', { style: { padding: '6px 8px', fontSize: 10, color: C.tx2 } }, 'loading…');
			else if (st.error) inner = h('div', { style: { padding: '6px 8px', fontSize: 10, color: C.tx2 } }, st.error);
			else if (!text && !err) inner = h('div', { style: { padding: '6px 8px', fontSize: 10, color: C.tx2 } }, 'no output yet');
			else inner = [
				text ? h('pre', { key: 'out', style: LOG_PRE }, text.replace(/\r/g, '\n')) : null,
				err ? h('pre', { key: 'err', style: Object.assign({}, LOG_PRE, { marginTop: text ? 6 : 0, color: 'var(--dsw-alias-label-secondary,#667)' }) }, err.replace(/\r/g, '\n')) : null,
			];
			return h('div', { style: { marginTop: 10 } },
				h('div', { style: { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.tx2, marginBottom: 4 } },
					'Output tail' + (live ? ' · live' : '')),
				inner,
			);
		}

		function OverviewTab(props) {
			var m = props.model;
			var sel = props.selected;
			var call = props.call;
			var root = m.project && m.project.root;
			var body;

			// detail header: explicit way back to the project summary (the same
			// toggle remains available by re-clicking the row, and the breadcrumb
			// above the list always carries a Back button)
			function detailHeader(key, titleText, chipEl) {
				var follow = props.onFollow;
				return h('div', { key: key, style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
					h('button', {
						title: 'Back to the project overview', onClick: props.onBack,
						style: {
							font: 'inherit', fontSize: 11, lineHeight: 1, flex: '0 0 auto',
							border: '1px solid ' + C.bd, background: C.nested, color: C.tx2,
							cursor: 'pointer', padding: '4px 9px', borderRadius: 6,
						},
					}, '← Back'),
					follow
						? h('button', {
							title: 'Open the solution this line belongs to', onClick: follow,
							style: {
								font: 'inherit', fontSize: 11, lineHeight: 1, flex: '0 0 auto',
								border: '1px solid ' + C.bd, background: C.nested, color: C.tx2,
								cursor: 'pointer', padding: '4px 9px', borderRadius: 6,
							},
						}, 'solution →')
						: null,
					h('span', {
						title: titleText,
						style: { fontWeight: 700, color: C.tx, minWidth: 0, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
					}, titleText),
					chipEl,
				);
			}

			// lazy "what does this solution change vs main" — the concrete
			// answer to 修改了什么, straight from the two branches' git diff
			var diffKey = sel && sel.kind === 'solution' && sel.slug ? sel.slug : '';
			var diff0 = useState(null);
			var setDiff = diff0[1];
			var diffState = diff0[0];
			useEffect(function () {
				if (!diffKey || !call) { setDiff(null); return undefined; }
				var n = m.bySlug[diffKey];
				if (!n || n.role === 'main') { setDiff(null); return undefined; }
				var alive = true;
				setDiff({ slug: diffKey, loading: true });
				call('solutions.diff', { a: 'main', b: diffKey }).then(function (res) {
					if (!alive) return;
					if (res.ok) setDiff({ slug: diffKey, files: res.value.changedFiles || [] });
					else setDiff({ slug: diffKey, error: res.error.message });
				});
				return function () { alive = false; };
			}, [diffKey, call]);

			if (sel && sel.kind === 'run') {
				var r = sel.run;
				var rsol = m.bySlug[r.solutionSlug] || {};
				body = [
					detailHeader('t', r.title || prettyCommand(r.command, root) || r.id, h(StatusChip, { status: r.status })),
					h(KV, { key: 'id', k: 'run', v: r.id }),
					h(KV, { key: 'sol', k: 'solution', v: r.solutionSlug }),
					h(KV, { key: 'cmd', k: 'command', v: prettyCommand(r.command, root) || '—' }),
					h(KV, { key: 'dur', k: 'duration', v: fmtDur(r.durationMs) || (r.status === 'running' && r.startedAt ? 'running…' : '—') }),
					h(KV, { key: 'gpu', k: 'gpus', v: r.gpuIds && r.gpuIds.length ? r.gpuIds.join(', ') : '—' }),
					r.tags && r.tags.length ? h(KV, { key: 'tags', k: 'tags', v: r.tags.join('  ') }) : null,
					h(KV, { key: 'hash', k: 'snapshot', v: hashShort(r.snapshotCommit) }),
					h(KV, { key: 'dir', k: 'run dir', v: r.runDir || '—' }),
					r.summaryMetrics && Object.keys(r.summaryMetrics).length ? h(KV, {
						key: 'met', k: 'metrics',
						v: Object.keys(r.summaryMetrics).map(function (k) { return k + '=' + r.summaryMetrics[k]; }).join('  '),
					}) : null,
					// promotion gate — a run's outcome decides whether its line of
					// work may merge into main
					h(MergeGate, { key: 'gate', sol: rsol, runs: (m.runs || []).filter(function (x) { return x.solutionSlug === r.solutionSlug; }) }),
					h(RunLogSection, { key: 'log', call: call, run: r }),
				];
			} else if (sel && sel.slug && m.bySlug[sel.slug]) {
				var n = m.bySlug[sel.slug];
				var ds = diffState && diffState.slug === sel.slug ? diffState : null;
				body = [
					detailHeader('t', n.label || n.id, h(StatusChip, { status: n.status })),
					n.description ? h('div', { key: 'd', style: { color: 'var(--dsw-alias-label-primary,#1a1a2e)', lineHeight: 1.5, marginBottom: 4, wordBreak: 'break-word' } }, n.description) : null,
					n.hypothesis ? h(Quote, { key: 'h', k: 'hypothesis', v: n.hypothesis, color: '#8250df' }) : null,
					n.conclusion ? h(Quote, { key: 'c', k: 'conclusion', v: n.conclusion, color: '#1a7f37' }) : null,
					// promotion gate — the fork/evidence/merge state of this line
					h(MergeGate, { key: 'gate', sol: n, runs: (m.runs || []).filter(function (x) { return x.solutionSlug === sel.slug; }) }),
					// what this solution changes relative to the mainline
					n.role !== 'main' ? h('div', { key: 'chg', style: { marginTop: 10 } },
						h('div', { style: { fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.tx2, marginBottom: 4 } },
							'Changes vs main' + (ds && ds.files ? ' · ' + ds.files.length + ' file' + (ds.files.length > 1 ? 's' : '') : '')),
						ds ? (
							ds.error ? h('div', { style: { fontSize: 10, color: C.tx2 } }, ds.error)
							: ds.files ? (
								ds.files.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' } },
									ds.files.slice(0, 12).map(function (f, i) { return h(FileChip, { key: i, status: f.status, path: f.path }); }),
									ds.files.length > 12 ? h('span', { style: { fontSize: 10, color: C.tx2 } }, '+' + (ds.files.length - 12) + ' more') : null)
								: h('div', { style: { fontSize: 10, color: C.tx2 } }, 'no file changes vs main yet'))
							: h('div', { style: { fontSize: 10, color: C.tx2 } }, 'loading…')
						) : null,
					) : null,
					h(KV, {
						key: 'm', k: 'metric', v: (n.metric !== undefined && n.metric !== null ? n.metric.toFixed(3) : '—') +
							(n.delta !== undefined && n.delta !== null ? '  (' + (n.delta >= 0 ? '+' : '') + n.delta.toFixed(3) + ' vs parent)' : ''),
					}),
					h(KV, { key: 'b', k: 'branch', v: n.branch + ' @ ' + hashShort(n.headCommit) }),
					h(KV, { key: 'r', k: 'runs', v: String(n.runCount || 0) + (n.dirty ? '  · uncommitted changes' : '') }),
					n.role !== 'main' && n.parent && n.parent !== n.id ? h(KV, { key: 'p', k: 'forked from', v: n.parent }) : null,
					n.mergedInto ? h(KV, { key: 'mg', k: 'merged into', v: n.mergedInto }) : null,
				];
			} else {
				// project summary + one clickable card per solution
				var cards = m.nodes.map(function (sol) {
					var l = m.laneOf[sol.id];
					if (l === undefined) return null;
					var cardCol = l === 0 ? MAIN_COLOR : laneColor(l);
					var isSel = sel && sel.kind === 'solution' && sel.slug === sol.id;
					return h('div', {
						key: sol.id,
						'class': 'dlabg-row' + (isSel ? ' dlabg-sel' : ''),
						style: {
							display: 'flex', alignItems: 'center', gap: 8, minHeight: 30,
							padding: '2px 8px', margin: '0 -8px', borderRadius: 6, cursor: 'pointer',
						},
						onClick: function () { props.onPickSolution && props.onPickSolution(sol.id); },
					},
						h('span', {
							style: { width: 17, height: 17, borderRadius: '50%', background: cardCol, color: '#fff', fontSize: 8, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto', letterSpacing: '0.02em', opacity: sol.status === 'archived' ? 0.45 : 1 },
						}, initials(sol.id)),
						h('span', { style: { fontWeight: 600, color: 'var(--dsw-alias-label-primary,#1a1a2e)', flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, sol.label || sol.id),
						h(StatusChip, { status: sol.status }),
						sol.metric !== undefined && sol.metric !== null ? h('span', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 11, color: 'var(--dsw-alias-label-primary,#1a1a2e)', flex: '0 0 auto' } }, sol.metric.toFixed(3)) : null,
						h('span', { style: { flex: '1 1 auto' } }),
						h('span', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 10.5, color: 'var(--dsw-alias-label-secondary,#667)', flex: '0 0 auto' } }, (sol.branch || '') + ' @ ' + hashShort(sol.headCommit)),
						h('span', { style: { fontSize: 10.5, color: 'var(--dsw-alias-label-secondary,#667)', flex: '0 0 auto' } }, (sol.runCount || 0) + ' runs'),
					);
				});
				body = [
					h('div', { key: 't', style: { fontWeight: 700, marginBottom: 6, color: C.tx } },
						m.project.name || 'Lab', m.counts.running ? h('span', { style: { fontWeight: 400, color: C.tx2, marginLeft: 8, fontSize: 11 } }, m.counts.running + ' running') : null),
					h(KV, { key: 'root', k: 'root', v: m.project.root || '—' }),
					h('div', { key: 'sh', style: { marginTop: 10, marginBottom: 2, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: C.tx2 } }, 'Solutions'),
					h('div', { key: 'cards' }, cards),
					m.resources ? h('div', { key: 'res' }, ResourceSection({
						resources: m.resources,
						twoCol: !(props.width > 0 && props.width <= 380),
					})) : null,
					h('div', { key: 'h', style: { marginTop: 12, fontSize: 10, color: C.tx2, fontStyle: 'italic' } },
						'click a row above or a card here for details · all operations via agent (lab_* tools)'),
				];
			}

			return h('div', { style: { padding: '10px 12px 16px', fontSize: 11.5 } }, body);
		}

		function RunsTab(props) {
			var runs = props.model.runs;
			if (!runs.length) {
				return h('div', { style: { padding: '10px 12px', color: C.tx2, fontSize: 11 } }, 'No runs yet — ask the agent to start one.');
			}

			// Group runs per solution by explicit `sweep/<name>` tag first, then
			// by sourceHeadCommit (same code state). Groups keep newest-first
			// order of their newest run; headers show only for named sweeps or
			// multi-run groups so stray single runs stay uncluttered.
			var groups = [];
			var byKey = {};
			var order = {};
			runs.forEach(function (r) {
				var sweep = null;
				(r.tags || []).forEach(function (t) {
					if (sweep === null && String(t).indexOf('sweep/') === 0) sweep = String(t);
				});
				// runs of different solutions NEVER share a group key, so
				// several active experiments stay apart in the list
				var key = r.solutionSlug + '|' + (sweep || 'snap:' + (r.sourceHeadCommit || r.snapshotCommit));
				if (!byKey[key]) {
					byKey[key] = { key: key, sweep: sweep, slug: r.solutionSlug, runs: [] };
					order[key] = groups.length;
					groups.push(byKey[key]);
				}
				byKey[key].runs.push(r);
			});

			// sequence index for the sweep chip ("3/4 variants")
			groups.forEach(function (g) { g.runs.forEach(function (r, i) { r._seq = i + 1; }); });

			// Lanes with activity first — the active experiment's group is not
			// pushed under main's history by a newer main run.
			var laneOf = props.model.laneOf;
			groups.sort(function (a, b) {
				var la = laneOf[a.slug], lb = laneOf[b.slug];
				var na = la === undefined ? 999 : la;
				var nb = lb === undefined ? 999 : lb;
				if (na !== nb) return na - nb;
				return (order[a.key] || 0) - (order[b.key] || 0);
			});

			var children = [];
			groups.forEach(function (g) {
				var named = g.sweep || g.runs.length >= 2;
				if (named) {
					var gl = laneOf[g.slug];
					var head = g.runs[0] && (g.runs[0].title || prettyCommand(g.runs[0].command, props.model.project && props.model.project.root));
					children.push(h('div', { key: 'h' + g.key, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px 2px' } },
						h('span', { 'class': 'dlabg-badge', style: { background: laneColor(gl === undefined ? 1 : gl) }, title: g.slug }, initials(g.slug)),
						h('span', { style: { fontWeight: 700, fontSize: 11, color: 'var(--dsw-alias-label-primary,#1a1a2e)' } }, g.slug),
						g.sweep ? h('span', { style: { fontSize: 10, color: C.tx2, fontFamily: 'ui-monospace,monospace' } }, g.sweep) : null,
						h('span', { style: { fontSize: 10, color: C.tx2 } }, g.runs.length + ' run' + (g.runs.length > 1 ? 's' : '')),
						h('span', {
							title: head || '',
							style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 10, color: C.tx2, textAlign: 'right' },
						}, head || ''),
					));
				}
				g.runs.forEach(function (r, ri) {
					var dotCol = GRAY;
					if (r.status === 'running' || r.status === 'starting') dotCol = '#0969da';
					else if (r.status === 'succeeded') dotCol = '#1a7f37';
					else if (r.status === 'failed') dotCol = '#cf222e';
					else if (r.status === 'queued') dotCol = '#9a6700';
					var selRun = props.selected && props.selected.kind === 'run' && props.selected.run.id === r.id;
					// per-run param tags (sweep variants), plus the run ordinal
					// inside its group — makes the "which variant is this" clear
					var pills = [];
					if (named) {
						pills.push(h('span', { key: 'seq', style: { fontFamily: 'ui-monospace,monospace', fontSize: 9, color: C.tx2, marginLeft: 6, flex: '0 0 auto' } }, (ri + 1) + '/' + g.runs.length));
					}
					(r.tags || []).forEach(function (t, ti) {
						var tag = String(t);
						if (/^[^/=\s]+=[^\s]+$/.test(tag)) {
							pills.push(h('span', { key: ti, style: { display: 'inline-block', fontFamily: 'ui-monospace,monospace', fontSize: 9, lineHeight: 1, padding: '2px 6px', borderRadius: 999, marginLeft: 6, color: '#0969da', background: 'rgba(9,105,218,0.08)' } }, tag));
						}
					});
					children.push(h('div', {
						key: r.id,
						'class': 'dlabg-row' + (selRun ? ' dlabg-sel' : ''),
						style: { display: 'flex', alignItems: 'center', minHeight: 26, padding: '3px 12px 3px 10px', gap: 8, cursor: 'pointer', marginLeft: named ? 14 : 0 },
						onClick: function () { props.onPick(r); },
					},
						h('span', { style: { width: 8, height: 8, borderRadius: 8, background: dotCol, flex: '0 0 auto' } }),
						h('span', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 11, flex: '0 0 auto', color: 'var(--dsw-alias-label-primary,#1a1a2e)' } }, r.id),
						h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary,#1a1a2e)' } },
							r.title || prettyCommand(r.command, props.model.project && props.model.project.root) || '', pills),
						h('span', { style: { color: 'var(--dsw-alias-label-secondary,#667)', fontSize: 11, flex: '0 0 auto', whiteSpace: 'nowrap' } }, fmtDur(r.durationMs)),
					));
				});
			});
			return h('div', { style: { padding: '4px 0' } }, children);
		}

		function ActivityTab(props) {
			var events = props.model.events || [];
			if (!events.length) {
				return h('div', { style: { padding: '10px 12px', color: C.tx2, fontSize: 11 } }, 'No activity recorded.');
			}
			return h('div', { style: { padding: '4px 0' } },
				events.slice(0, 50).map(function (e, i) {
					return h('div', { key: i, style: { display: 'flex', gap: 8, padding: '2px 12px', fontSize: 11, lineHeight: 1.6 } },
						h('span', { style: { color: 'var(--dsw-alias-label-secondary,#667)', fontSize: 11, flex: '0 0 auto', whiteSpace: 'nowrap' } }, fmtDate(e.time)),
						h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--dsw-alias-label-primary,#1a1a2e)' } }, e.text || e.type));
				}));
		}

		// ── "not a lab workspace" empty state ────────────────────────────────

		function ForeignWorkspace(props) {
			return h('div', {
				style: {
					height: '100%', display: 'flex', flexDirection: 'column',
					alignItems: 'center', justifyContent: 'center', gap: 6,
					padding: 24, textAlign: 'center', color: C.tx2, fontSize: 12,
					background: C.bg,
				},
			},
				h('div', { style: { fontSize: 26 } }, '🧪'),
				h('div', { style: { fontWeight: 700, color: C.tx, fontSize: 13 } }, 'Not a lab workspace'),
				h('div', null, 'No initialized lab project (.dsh-lab) found in'),
				h('div', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 10.5, color: C.tx, wordBreak: 'break-all' } }, props.cwd || 'this session'),
				h('div', { style: { maxWidth: 320, marginTop: 4 } },
					'or any parent directory. Open a session inside a lab project (or one of its solutions) and this panel follows it automatically.'),
			);
		}

		// ── main panel ───────────────────────────────────────────────────────

		function LabPanel(props) {
			var ctx = props.ctx;
			var scope = props.scope || {};
			var active = props.visible !== false; // sidebar tabs pause when hidden
			var call = useRpc(ctx, scope.cwd);

			var st0 = useState({ loading: true, error: null, wsMatch: null, data: null });
			var set = st0[1];
			var st = st0[0];

			var sel0 = useState(null);
			var setSel = sel0[1];
			var selState = sel0[0];

			var tab0 = useState('overview');
			var setTab = tab0[1];
			var tab = tab0[0];

			var listRef = useRef(null);
			var listW = useWidth(listRef, st.loading ? 'loading' : 'ready');

			var refresh = useCallback(function () {
				Promise.all([
					call('project.get'),
					call('graph.get'),
					call('runs.list'),
					call('events.list', { limit: 100 }),
					call('resources.get'),
				]).then(function (res) {
					var proj = res[0], graph = res[1], runs = res[2], evs = res[3];
					if (!proj.ok) {
						set({ loading: false, error: proj.error.message, wsMatch: null, data: null });
						return;
					}
					// the host resolved the lab for THIS session's cwd; a null
					// root (source 'none') means the cwd belongs to no lab
					// project — show the dynamic empty state, no data fetch
					if (!proj.value.root) {
						set({ loading: false, error: null, wsMatch: false, data: null });
						return;
					}
					rootCache.root = proj.value.root;
					var match = true;
					if (!graph.ok || !runs.ok || !evs.ok) {
						var msg = graph.ok ? (runs.ok ? evs.error.message : runs.error.message) : graph.error.message;
						set({ loading: false, error: msg, wsMatch: match, data: null });
						return;
					}
					// resources are non-fatal: an unavailable scheduler must not
					// blank the graph
					var resources = res[4] && res[4].ok ? res[4].value : null;
					set({
						loading: false, error: null, wsMatch: match,
						data: {
							project: proj.value,
							graph: graph.value,
							runs: runs.value.runs || [],
							// events.list returns raw store rows (createdAt) —
							// normalize to the {time,type,entityId,text} shape
							events: (evs.value || []).map(function (e) {
								return { time: e.createdAt || e.time, type: e.type, entityId: e.entityId, text: e.text };
							}),
							resources: resources,
						},
					});
				});
			}, [call, scope.cwd]);

			useEffect(function () {
				if (!active) return;
				refresh();
				var t = setInterval(refresh, POLL_MS);
				return function () { clearInterval(t); };
			}, [refresh, active]);

			// model is built unconditionally — hooks must not sit behind returns
			var m = useMemo(function () { return buildModel(st.data); }, [st.data]);

			if (st.loading && !st.data) {
				return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: C.tx2, fontSize: 12 } },
					'Loading lab history…');
			}
			if (st.error && !st.data) {
				return h('div', { style: { padding: 16, fontSize: 11 } },
					h('div', { style: { padding: 10, borderRadius: 8, background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.15)' } },
						h('div', { style: { fontWeight: 600, color: C.red, marginBottom: 4 } }, '⚠ ', /initialized/i.test(st.error) ? 'Lab not initialized' : 'Error'),
						h('div', { style: { color: C.tx2, fontSize: 10 } }, st.error)));
			}
			if (st.wsMatch === false) {
				return h(ForeignWorkspace, { cwd: scope.cwd || '' });
			}

			function onSelect(i) {
				var row = m.rows[i];
				if (!row) return;
				var next;
				if (row.kind === 'run') next = { kind: 'run', run: row.run, slug: row.slug };
				else next = { kind: 'solution', slug: row.slug };
				var same = selState && selState.kind === next.kind &&
					(next.kind === 'run' ? selState.run && selState.run.id === next.run.id : selState.slug === next.slug);
				setSel(same ? null : next);
				setTab('overview');
			}

			function pickRun(r) {
				setSel({ kind: 'run', run: r, slug: r.solutionSlug });
				setTab('overview');
			}

			function pickSolution(slug) {
				setSel({ kind: 'solution', slug: slug });
				setTab('overview');
			}

			/** Explicit way back from a run/solution detail to the summary. */
			function clearSelection() {
				setSel(null);
			}

			/** Follow a fork/merge row to the solution it points at. */
			function followSelection() {
				var s = selState;
				if (!s) return;
				if (s.kind === 'solution' && s.parent && s.parent !== s.slug) {
					pickSolution(s.parent);
					return;
				}
				if (s.kind === 'solution' && m.bySlug[s.slug] && m.bySlug[s.slug].mergedInto) {
					pickSolution(m.bySlug[s.slug].mergedInto);
					return;
				}
				if (s.kind === 'run') pickSolution(s.slug);
			}

			// selected graph row index (for highlight)
			var selIdx = -1;
			if (selState && selState.kind === 'run') {
				m.rows.forEach(function (r, i) { if (r.kind === 'run' && r.run.id === selState.run.id) selIdx = i; });
			}

			var tabs = [['overview', 'Overview'], ['runs', 'Runs'], ['activity', 'Activity']];

			// breadcrumb: project ▸ <current> — always visible, so the way back
			// never depends on remembering how you got here
			var crumbTail = null;
			if (selState && selState.kind === 'run') {
				crumbTail = h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
					h('span', { style: { color: C.tx2 } }, '▸'),
					h('span', {
						title: selState.slug,
						style: { fontFamily: 'ui-monospace,monospace', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
					}, selState.slug),
					h('span', { style: { color: C.tx2 } }, '▸'),
					h('span', { style: { fontFamily: 'ui-monospace,monospace', fontSize: 10.5, color: C.tx2 } }, selState.run.id));
			} else if (selState && selState.kind === 'solution') {
				crumbTail = h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 } },
					h('span', { style: { color: C.tx2 } }, '▸'),
					h('span', {
						title: selState.slug,
						style: { fontFamily: 'ui-monospace,monospace', fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
					}, selState.slug));
			}

			var crumb = h('div', {
				style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, padding: '4px 12px', background: C.card, borderBottom: '1px solid ' + C.bd },
			},
				selState
					? h('button', {
						title: 'Back to the project overview', onClick: clearSelection,
						style: {
							font: 'inherit', fontSize: 11, lineHeight: 1, flex: '0 0 auto',
							border: '1px solid ' + C.bd, background: C.nested, color: C.tx,
							cursor: 'pointer', padding: '3px 8px', borderRadius: 6,
						},
					}, '← Back')
					: null,
				h('button', {
					title: 'Project overview', onClick: clearSelection,
					style: {
						font: 'inherit', fontSize: 10.5, flex: '0 1 auto', minWidth: 0,
						border: 'none', background: 'transparent', color: selState ? C.tx2 : C.tx,
						cursor: 'pointer', padding: 0, fontWeight: selState ? 400 : 600,
						overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
					},
				}, m.project.name || 'Lab'),
				crumbTail,
			);

			return h('div', {
				style: {
					display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
					width: '100%', alignSelf: 'stretch',
					background: C.bg, color: C.tx, fontSize: 12, fontFamily: 'inherit',
				},
			},
				h('style', null, STYLE),

				// header — current-branch row, like "✓ master <message>"
				h('div', {
					style: {
						display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
						padding: '9px 12px', background: C.card, borderBottom: '1px solid ' + C.bd,
					},
				},
					h('span', { style: { width: 9, height: 9, borderRadius: 9, background: MAIN_COLOR, flexShrink: 0 } }),
					h('span', { style: { fontWeight: 700, fontSize: 12.5, fontFamily: 'ui-monospace,monospace' } }, m.branchByLane[0] || 'main'),
					h('span', { style: { color: C.tx2, fontSize: 11.5, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
						(m.project.name || '') + ' · ' + m.counts.solutions + ' solutions' + (m.counts.running ? ' · ' + m.counts.running + ' running' : '')),
					h('button', {
						title: 'Refresh', onClick: refresh,
						style: {
							font: 'inherit', fontSize: 13, border: 'none', background: 'transparent',
							color: C.tx2, cursor: 'pointer', padding: '2px 6px', borderRadius: 4,
						},
					}, '⟳'),
				),

				// breadcrumb — the always-visible way back from any detail view
				crumb,

				// commit list — content-sized (scrolls when history grows);
				// leftover space flows to the detail section below
				h('div', { ref: listRef, style: { flex: '0 1 auto', minHeight: 120, overflowY: 'auto', overflowX: 'hidden', position: 'relative', background: C.card } },
					m.rows.length <= 1
						? h('div', { style: { padding: '18px 14px 18px ' + (m.graphW + 12) + 'px', color: C.tx2, fontSize: 11.5 } },
							'No experiments yet — ask the agent to fork the mainline.')
						: h('div', { style: { position: 'relative', minHeight: m.rows.length * ROW_H } },
							h(GraphSVG, { model: m, selected: selIdx }),
							m.rows.map(function (r, i) {
								return h(Row, { key: i, model: m, row: r, index: i, selected: selIdx, width: listW, onSelect: onSelect });
							}))),

				// bottom tab bar (like Commit | Changes | File Tree)
				h('div', {
					style: {
						display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0,
						padding: '0 12px', background: C.card, borderTop: '1px solid ' + C.bd,
					},
				},
					tabs.map(function (t) {
						var on = tab === t[0];
						return h('button', {
							key: t[0],
							style: {
								font: 'inherit', fontSize: 11.5, padding: '0 2px',
								background: 'none', border: 'none', cursor: 'pointer', height: 30,
								borderBottom: '2px solid ' + (on ? 'var(--dsw-alias-brand-primary,#2563eb)' : 'transparent'),
								color: on ? 'var(--dsw-alias-label-primary,#1a1a2e)' : 'var(--dsw-alias-label-secondary,#667)',
								fontWeight: on ? 600 : 400,
							},
							onClick: function () { setTab(t[0]); },
						}, t[1]);
					}),
					h('span', { style: { flex: 1 } }),
					h('span', { style: { fontSize: 9.5, color: C.tx2, fontStyle: 'italic' } }, 'read-only · ops via agent'),
				),

				// tab content — takes all remaining space
				h('div', { style: { flex: '1 1 0', minHeight: 140, overflowY: 'auto', background: C.card, borderTop: '1px solid ' + C.bd } },
					tab === 'overview' ? h(OverviewTab, { model: m, selected: selState, onPickSolution: pickSolution, onBack: clearSelection, onFollow: followSelection, call: call, width: listW })
						: tab === 'runs' ? h(RunsTab, { model: m, selected: selState, onPick: pickRun })
						: h(ActivityTab, { model: m })),
			);
		}

		/**
		 * The session's working directory read off the sessions service, or
		 * null when unknown.
		 *
		 * The authoritative client-side source is the sessions LIST summary —
		 * the host projects the session header's cwd onto every list row
		 * (`ctx.sessions.list.getSnapshot().byId[id].cwd`). Older DSH builds
		 * exposed it on the scope/binding faces instead, so those stay as
		 * fallbacks; without a cwd the panel cannot tell which lab project the
		 * session belongs to and falls back to the "not a lab workspace" state.
		 */
		function readSessionCwd(ctx, sessionId) {
			var sessions = ctx && ctx.get ? ctx.get('sessions') : undefined;
			if (!sessions || !sessionId) return null;
			try {
				var list = sessions.list;
				var snap = list && typeof list.getSnapshot === 'function' ? list.getSnapshot() : null;
				var summary = snap && snap.byId ? snap.byId[sessionId] : null;
				if (summary && summary.cwd) return summary.cwd;
			} catch (e) {}
			try {
				var b = sessions.binding ? sessions.binding(sessionId) : null;
				if (b && b.cwd) return b.cwd;
			} catch (e) {}
			try {
				var sc = sessions.scope ? sessions.scope(sessionId) : null;
				if (sc && sc.header && sc.header.cwd) return sc.header.cwd;
			} catch (e) {}
			return null;
		}

		/**
		 * Subscribe to the sessions list store and report cwd changes. The list
		 * hydrates asynchronously (page load, reconnect), so a single mount-time
		 * read can latch "no cwd" forever; this re-notifies when it arrives.
		 * Returns an unsubscribe function.
		 */
		function watchSessionCwd(ctx, sessionId, onChange) {
			var sessions = ctx && ctx.get ? ctx.get('sessions') : undefined;
			var list = sessions && sessions.list;
			if (!list || typeof list.subscribe !== 'function') return function () {};
			var last = readSessionCwd(ctx, sessionId);
			var stop = list.subscribe(function () {
				var next = readSessionCwd(ctx, sessionId);
				if (next === last) return;
				last = next;
				onChange(next);
			});
			return function () {
				if (typeof stop === 'function') { try { stop(); } catch (e) {} }
			};
		}

		/** Session cwd as state (re-read on session change and on list updates). */
		function useSessionCwd(ctx, sessionId) {
			var st = useState(null);
			var set = st[1];
			var cwd = st[0];
			useEffect(function () {
				set(readSessionCwd(ctx, sessionId));
				return watchSessionCwd(ctx, sessionId, function (next) { set(next); });
			}, [ctx, sessionId]);
			return cwd;
		}

		/** Header-button workspace gate: session cwd vs lab project root. */
		function useWsMatch(ctx, sessionId, call) {
			var st = useState(null);
			var set = st[1];
			st = st[0];
			useEffect(function () {
				call('project.get').then(function (res) {
					if (!res.ok) { set(false); return; }
					rootCache.root = res.value.root || null;
					if (!res.value.root) { set(true); return; }
					var cwd = readSessionCwd(ctx, sessionId);
					if (!cwd) { set(true); return; }
					set(workspaceMatch(res.value.root, cwd));
				});
			}, [call, sessionId]);
			return st;
		}

		// ── header button (opens the native-sidebar DLab tab) ────────────────

		function LabHeaderButton(props) {
			var ctx = props.ctx;
			var sessionId = props.sessionId;
			var call = useRpc(ctx);
			var wsMatch = useWsMatch(ctx, sessionId, call);

			if (wsMatch === false) return null;

			function open() {
				var sr = ctx.sidebarRight || (ctx.get ? ctx.get('sidebarRight') : undefined);
				if (sr && typeof sr.openTab === 'function') sr.openTab(TAB_KIND);
			}

			return h('button', {
				style: {
					font: 'inherit', fontSize: '14px', color: 'inherit',
					background: 'transparent', border: 'none', cursor: 'pointer',
					padding: '4px 6px', borderRadius: '4px',
					display: 'flex', alignItems: 'center',
				},
				onClick: open,
				title: 'DLab — Research Evolution Graph',
			}, '🧪');
		}

		// ── plugin wiring: the official native right Sidebar ─────────────────

		/** The tab type's identity in the native sidebar registry. */
		var TYPE_ID = '@dsh-lab/client';
		/** The page kind the guide entry and the header button open. */
		var TAB_KIND = 'dsh-lab';

		var inject = ['slots', 'connection', 'sidebarRightTabs', 'sidebarRight'];

		/** The tab body: adapts the native sidebar's tab info to LabPanel. */
		function LabTabBody(props) {
			var useTabInfo = props.useTabInfo;
			var info = null;
			try { if (useTabInfo) info = useTabInfo(); } catch (e) {}
			var tab = (info && info.tab) || {};
			var cwd = useSessionCwd(props.ctx, props.sessionId);
			return h(LabPanel, {
				ctx: props.ctx,
				scope: { cwd: cwd || undefined },
				visible: tab.visible !== false,
			});
		}

		function apply(ctx) {
			// Stage 1 — the tab type: a page type opened by kind, with a guide
			// entry so the sidebar's guide page offers the DLab capsule.
			ctx.effect(function () {
				return ctx.sidebarRightTabs.register({
					id: TYPE_ID,
					kind: TAB_KIND,
					// page type: no patterns, opened by kind via openTab('dsh-lab')
					title: function () { return 'DLab'; },
					guide: [{
						order: 150,
						title: function () { return 'DLab'; },
						description: function () {
							return 'Deep Learning Lab — solutions, runs, research evolution graph';
						},
						icon: function (p) {
							return h('span', { style: { fontSize: ((p && p.size) || 22) + 'px', lineHeight: 1 } }, '🧪');
						},
					}],
				});
			}, 'dsh-lab: tab type');

			var slots = ctx.slots;
			if (!slots) return;

			// Stage 2 — the tab body, keyed by the type id: the public path
			// every native tab type goes through.
			ctx.effect(function () {
				return slots.inject('sidebar.right.pane.tab', function () {
					return slots.register({
						name: 'sidebar.right.pane.tab',
						key: TYPE_ID,
						inject: function (sessionId) { return { ctx: ctx, sessionId: sessionId }; },
					}, LabTabBody);
				});
			}, 'dsh-lab: tab body');

			// Quick-entry: a 🧪 button in the conversation header that opens
			// the DLab page tab in the native right sidebar.
			ctx.effect(function () {
				return slots.inject('conversation.session.header.actions', function () {
					return slots.register(
						{
							name: 'conversation.session.header.actions',
							id: 'dsh-lab', order: 30,
							inject: function (sessionId) { return { ctx: ctx, sessionId: sessionId }; },
						},
						function (sp) { return h(LabHeaderButton, { ctx: sp.ctx, sessionId: sp.sessionId }); },
					);
				});
			}, 'dsh-lab: header button');
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.TYPE_ID = TYPE_ID;
		exports.TAB_KIND = TAB_KIND;
		// exported for tests: pure row/lane computation behind the git graph
		exports.buildModel = buildModel;
		exports.workspaceMatch = workspaceMatch;
		// exported for tests: readable argv rendering for run rows
		exports.prettyCommand = prettyCommand;
		// exported for tests: session-cwd resolution against the sessions service
		exports.readSessionCwd = readSessionCwd;
		exports.watchSessionCwd = watchSessionCwd;
		return module.exports;
	},
});
