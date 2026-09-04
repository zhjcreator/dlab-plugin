/**
 * @dsh-lab/client — read-only research dashboard.
 *
 * Design philosophy: the UI is a VIEW, not a controller. All operations
 * (fork, merge, archive, run) go through the agent's lab_* tools. The panel
 * visualizes the research graph, recent runs, and tells the agent what
 * commands are available.
 *
 * Mounting (DESIGN §26.1):
 *   dsh-better-sidebar present → "DLab" tab in the right sidebar
 *   absent → 🔬 header button opens a fixed overlay
 *
 * Workspace detection: the button only renders when the current session's
 * workspace matches the lab root (via slot-injected sessionId →
 * ctx.sessions.binding/scope → cwd comparison with RPC project.get root).
 *
 * Theme: uses --dsw-alias-* tokens with hardcoded fallbacks; no color-mix()
 * (browser compat); every state renders something (no blank boxes).
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
		var createPortal = require('react-dom').createPortal;

		var RPC = '/dsh-lab';
		var POLL_MS = 5000;

		// ── theme (hardcoded fallbacks, no color-mix for compat) ─────────────
		var C = {
			bg:     'var(--dsw-alias-bg-base, #f8f9fa)',
			card:   'var(--dsw-alias-bg-layer-1, #ffffff)',
			nested: 'var(--dsw-alias-bg-layer-2, #f1f3f5)',
			overlay:'var(--dsw-alias-bg-overlay, #ffffff)',
			bd:     'var(--dsw-alias-border-l1, #e0e0e0)',
			bd2:    'var(--dsw-alias-border-l2, #ccc)',
			brand:  'var(--dsw-alias-brand-primary, #2563eb)',
			tx:     'var(--dsw-alias-label-primary, #1a1a2e)',
			tx2:    'var(--dsw-alias-label-secondary, #6b7280)',
			red:    'var(--dsw-alias-state-error-primary, #dc2626)',
			green:  'var(--dsw-alias-state-success-primary, #16a34a)',
			yellow: 'var(--dsw-alias-state-warn-primary, #d97706)',
			blue:   '#3b82f6',
		};

		// ── helpers ──────────────────────────────────────────────────────────

		function fmtDur(ms) {
			if (ms == null) return '';
			var s = Math.floor(ms / 1000);
			if (s < 60) return s + 's';
			var m = Math.floor(s / 60);
			if (m < 60) return m + 'm' + (s % 60) + 's';
			return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
		}

		function short(s, n) {
			if (!s) return '';
			return s.length > n ? s.slice(0, n) + '…' : s;
		}

		// ── status visual vocabulary ─────────────────────────────────────────

		var SOL_ST = {
			active:   { dot: '●', color: C.green,  label: 'Active' },
			archived: { dot: '○', color: C.tx2,    label: 'Archived' },
			merged:   { dot: '✓', color: C.brand,  label: 'Merged' },
			broken:   { dot: '⚠', color: C.red,    label: 'Broken' },
		};
		var RUN_ST = {
			running:   { dot: '◐', color: C.blue,   label: 'Running' },
			queued:    { dot: '·', color: C.tx2,    label: 'Queued' },
			starting:  { dot: '◐', color: C.blue,   label: 'Starting' },
			succeeded: { dot: '✓', color: C.green,  label: 'OK' },
			failed:    { dot: '✕', color: C.red,    label: 'Failed' },
			canceled:  { dot: '⊘', color: C.yellow, label: 'Canceled' },
			lost:      { dot: '?', color: C.tx2,    label: 'Lost' },
		};

		function Tag(props) {
			var s = props.st || {};
			return h('span', {
				style: {
					display: 'inline-flex', alignItems: 'center', gap: '2px',
					fontSize: '9px', fontWeight: 600, lineHeight: '1.4',
					padding: '1px 6px', borderRadius: '999px',
					color: s.color || C.tx2,
					background: 'rgba(127,127,127,0.1)',
					border: '1px solid rgba(127,127,127,0.2)',
					whiteSpace: 'nowrap', flexShrink: 0,
				},
			}, (s.dot || '·') + ' ' + (s.label || '?'));
		}

		function MetricBadge(props) {
			return h('span', {
				style: {
					fontSize: '9px', fontWeight: 600,
					fontFamily: 'ui-monospace,monospace',
					padding: '1px 5px', borderRadius: '4px',
					background: 'rgba(127,127,127,0.08)',
					border: '1px solid rgba(127,127,127,0.15)',
					color: C.tx, whiteSpace: 'nowrap',
				},
			}, props.name, ' ', props.value);
		}

		// ── RPC hook ─────────────────────────────────────────────────────────

		function useRpc(ctx) {
			return useMemo(function () {
				var rpc = ctx && ctx.connection && ctx.connection.rpc;
				return function (ep, payload) {
					if (!rpc) return Promise.resolve({ ok: false, error: { message: 'No connection' } });
					return rpc.call(RPC, ep, payload || {}).then(
						function (r) { return r && r.ok ? r : { ok: false, error: (r && r.error) || { message: 'RPC failed' } }; },
						function (e) { return { ok: false, error: { message: String((e && e.message) || e) } }; },
					);
				};
			}, [ctx]);
		}

		// ── workspace detection ──────────────────────────────────────────────

		/**
		 * Determine whether the current session's workspace matches the lab
		 * root. Tries session binding → session scope → fallback show.
		 */
		function useWorkspaceMatch(ctx, sessionId, call) {
			var st = useState(null); // null=checking, true=match, false=mismatch
			var set = st[1];
			st = st[0];

			useEffect(function () {
				if (!call) return;
				call('project.get').then(function (res) {
					if (!res.ok) { set(false); return; }
					var labRoot = res.value.root;
					if (!labRoot) { set(true); return; }

					var cwd = null;
					// Method 1: session binding → workspace path
					try {
						if (sessionId && ctx.sessions && ctx.sessions.binding) {
							var b = ctx.sessions.binding(sessionId);
							if (b) {
								if (b.cwd) cwd = b.cwd;
								else if (b.workspacePath) cwd = b.workspacePath;
								else if (b.workspace && b.workspace.path) cwd = b.workspace.path;
							}
						}
					} catch (e) { /* try next */ }
					// Method 2: session scope → header.cwd
					if (!cwd) {
						try {
							if (sessionId && ctx.sessions && ctx.sessions.scope) {
								var sc = ctx.sessions.scope(sessionId);
								if (sc) {
									if (sc.header && sc.header.cwd) cwd = sc.header.cwd;
									else if (sc.session && sc.session.header && sc.session.header.cwd) cwd = sc.session.header.cwd;
								}
							}
						} catch (e) { /* fallback */ }
					}

					if (!cwd) { set(true); return; } // can't determine → show
					// match if cwd is the lab root or inside it
					set(cwd === labRoot || cwd.startsWith(labRoot + '/'));
				});
			}, [call, sessionId]);

			return st;
		}

		// ── research graph (the core visualization) ─────────────────────────

		/**
		 * Build a git-log-style tree from solution parent/merge relations.
		 */
		function buildTree(solutions, runs) {
			var byId = {};
			solutions.forEach(function (s) { byId[s.id] = s; });

			var runsBySol = {};
			runs.forEach(function (r) {
				if (!runsBySol[r.solutionId]) runsBySol[r.solutionId] = [];
				runsBySol[r.solutionId].push(r);
			});

			var bestMetric = {};
			solutions.forEach(function (s) {
				var rs = (runsBySol[s.id] || []).filter(function (r) { return r.status === 'succeeded'; });
				if (rs.length > 0 && rs[0].summaryMetrics) {
					var entries = Object.entries(rs[0].summaryMetrics);
					if (entries.length > 0) bestMetric[s.id] = { name: entries[0][0], value: entries[0][1] };
				}
			});

			function meta(s) {
				return {
					sol: s,
					metric: bestMetric[s.id],
					runCount: (runsBySol[s.id] || []).length,
					lastRun: (runsBySol[s.id] || [])[0],
				};
			}

			var main = solutions.find(function (s) { return s.role === 'main'; });
			if (!main) return [];

			var byParent = {};
			solutions.forEach(function (s) {
				if (s.role === 'main') return;
				var parentSlug = s.parentSlug || 'main';
				if (!byParent[parentSlug]) byParent[parentSlug] = [];
				byParent[parentSlug].push(s);
			});

			var rows = [];
			function walk(slug, prefix, depth) {
				var children = (byParent[slug] || []).slice().sort(function (a, b) {
					var rank = function (s) { return s.status === 'active' ? 0 : s.status === 'merged' ? 1 : 2; };
					return rank(a) - rank(b);
				});
				children.forEach(function (child, i) {
					var isLast = i === children.length - 1;
					rows.push(Object.assign(meta(child), {
						prefix: prefix + (isLast ? '\u2514\u2500 ' : '\u251C\u2500 '),
						depth: depth,
						isLast: isLast,
					}));
					walk(child.slug, prefix + (isLast ? '   ' : '\u2502  '), depth + 1);
				});
			}

			var rootRow = Object.assign(meta(main), { prefix: '', depth: 0, isMain: true });
			walk('main', '', 1);
			return [rootRow].concat(rows);
		}

		function TreeView(props) {
			var rows = props.rows;
			if (rows.length === 0) {
				return h('div', { style: { padding: '20px', textAlign: 'center', color: C.tx2, fontSize: '11px' } },
					'No solutions — ask the agent to initialize the lab');
			}
			return h('div', { style: { padding: '8px 6px' } },
				rows.map(function (row) {
					return h(TreeRow, { key: row.sol.id, row: row });
				}));
		}

		function TreeRow(props) {
			var row = props.row;
			var s = row.sol;
			var st = SOL_ST[s.status] || SOL_ST.active;
			var isMain = row.isMain;

			return h('div', {
				style: {
					fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
					fontSize: '11px', lineHeight: '1.8',
					padding: '0 4px',
					whiteSpace: 'pre',
					color: C.tx,
				},
			},
				h('span', { style: { color: C.bd2 } }, row.prefix),
				h('span', {
					style: { color: st.color, fontWeight: 700, marginRight: '4px', fontSize: isMain ? '13px' : '11px' },
				}, isMain ? '\u2605' : st.dot),
				h('span', {
					style: { fontWeight: 600, color: C.tx, fontFamily: isMain ? 'inherit' : 'ui-monospace,monospace' },
				}, s.name || s.slug),

				'  ',
				h(Tag, { st: st }),

				row.metric ? h('span', { style: { marginLeft: '6px' } },
					h(MetricBadge, { name: row.metric.name, value: typeof row.metric.value === 'number' ? row.metric.value.toFixed(3) : row.metric.value })) : null,

				row.runCount > 0 ? h('span', { style: { marginLeft: '6px', fontSize: '9px', color: C.tx2 } },
					row.runCount + ' run' + (row.runCount > 1 ? 's' : '')) : null,

				s.dirty ? h('span', { style: { marginLeft: '4px', fontSize: '9px', color: C.yellow } }, '\u270e') : null,

				s.hypothesis ? h('div', {
					style: {
						fontSize: '9px', color: C.tx2, lineHeight: 1.4,
						paddingLeft: (row.prefix.length * 6 + 24) + 'px',
						fontStyle: 'italic', fontFamily: 'inherit', whiteSpace: 'normal',
					},
				}, '\u2753 ', short(s.hypothesis, 70)) : null,

				s.conclusion ? h('div', {
					style: {
						fontSize: '9px', color: C.green, lineHeight: 1.4,
						paddingLeft: (row.prefix.length * 6 + 24) + 'px',
						fontFamily: 'inherit', whiteSpace: 'normal',
					},
				}, '\uD83D\uDCA1 ', short(s.conclusion, 70)) : null,
			);
		}

				// ── runs list (compact) ──────────────────────────────────────────────

		function RunsList(props) {
			var runs = props.runs;
			if (runs.length === 0) {
				return h('div', { style: { padding: '8px 18px', fontSize: '10px', color: C.tx2, fontStyle: 'italic' } },
					'No runs yet');
			}
			return h('div', { style: { padding: '4px 8px' } },
				runs.slice(0, 10).map(function (r) {
					var st = RUN_ST[r.status] || RUN_ST.lost;
					var metrics = r.summaryMetrics || {};
					var mEntries = Object.entries(metrics).slice(0, 2);
					return h('div', {
						key: r.id,
						style: {
							display: 'flex', alignItems: 'center', gap: '6px',
							padding: '3px 8px', fontSize: '10px',
							borderBottom: '1px solid rgba(127,127,127,0.06)',
						},
					},
						h('span', { style: { color: st.color, fontWeight: 700, fontSize: '10px', width: '14px', textAlign: 'center' } }, st.dot),
						h('span', { style: { fontWeight: 600, color: C.tx, fontFamily: 'ui-monospace,monospace', fontSize: '10px' } },
							'#' + r.id.replace(/^run-/, '')),
						h('span', { style: { color: C.tx2, fontSize: '10px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
							r.solutionSlug || ''),
						r.durationMs != null ? h('span', { style: { color: C.tx2, fontSize: '9px' } }, fmtDur(r.durationMs)) : null,
						r.exitCode != null ? h('span', { style: { color: r.exitCode === 0 ? C.green : C.red, fontSize: '9px' } },
							'exit ' + r.exitCode) : null,
						mEntries.map(function (e) {
							return h(MetricBadge, { key: e[0], name: e[0], value: typeof e[1] === 'number' ? e[1].toFixed(3) : e[1] });
						}),
					);
				}));
		}

		// ── agent commands reference ─────────────────────────────────────────

		var AGENT_HELP = [
			['lab_fork_solution', '"从 main fork 一个新实验叫 lr-sweep"'],
			['lab_checkpoint_solution', '"checkpoint 当前方案的修改"'],
			['lab_merge_solution', '"把 lr-sweep 合并到 main"'],
			['lab_archive_solution', '"归档 query32，结论是没效果"'],
			['lab_start_run', '"在 agm-cosine 上跑 train.py"'],
			['lab_stop_run', '"停掉 run-000003"'],
			['lab_list_solutions', '"列出所有方案"'],
			['lab_solution_diff', '"对比 agm-cosine 和 main"'],
		];

		function AgentRef() {
			return h('div', {
				style: {
					padding: '8px 12px', borderTop: '1px solid ' + C.bd,
					background: C.nested,
				},
			},
				h('div', {
					style: { fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.tx2, marginBottom: '4px' },
				}, '🤖 Agent commands'),
				h('div', {
					style: { display: 'flex', flexWrap: 'wrap', gap: '3px' },
				},
					AGENT_TOOLS.map(function (t) {
						return h('span', {
							key: t,
							style: {
								fontSize: '9px', fontFamily: 'ui-monospace,monospace',
								padding: '1px 5px', borderRadius: '3px',
								background: 'rgba(127,127,127,0.08)',
								border: '1px solid rgba(127,127,127,0.12)',
								color: C.tx2,
							},
						}, t);
					})),
				h('div', {
					style: { fontSize: '9px', color: C.tx2, marginTop: '4px', lineHeight: 1.4 },
				}, 'All operations are performed by the agent via these tools.'));
		}

		// ── main panel (read-only dashboard) ─────────────────────────────────

		function LabPanel(props) {
			var ctx = props.ctx;
			var call = useRpc(ctx);

			var st = useState({ loading: true, error: null, data: null });
			var set = st[1];
			st = st[0];

			var helpState = useState(false);
			var setHelp = helpState[1];
			helpState = helpState[0];
			var help = helpState;

			var refresh = useCallback(function () {
				Promise.all([call('project.get'), call('solutions.list'), call('runs.list')]).then(function (rs) {
					var bad = rs.find(function (r) { return !r.ok; });
					if (bad) { set({ loading: false, error: bad.error.message, data: null }); return; }
					set({ loading: false, error: null, data: { project: rs[0].value, solutions: rs[1].value.solutions || [], runs: rs[2].value.runs || [] } });
				});
			}, [call]);

			useEffect(function () {
				refresh();
				var t = setInterval(refresh, POLL_MS);
				return function () { clearInterval(t); };
			}, [refresh]);

			// spinner keyframes
			useEffect(function () {
				var el = document.createElement('style');
				el.textContent = '@keyframes dshlab-rot{to{transform:rotate(360deg)}}';
				document.head.appendChild(el);
				return function () { try { document.head.removeChild(el); } catch (e) {} };
			}, []);

			if (st.loading) {
				return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '8px', color: C.tx2, fontSize: '12px' } },
					h('span', { style: { width: '14px', height: '14px', borderRadius: '50%', border: '2px solid ' + C.bd, borderTopColor: C.brand, animation: 'dshlab-rot .8s linear infinite' } }),
					'Loading…');
			}

			if (st.error) {
				var uninit = /initialized|no lab state/i.test(st.error);
				return h('div', { style: { padding: '16px', fontSize: '11px' } },
					h('div', { style: { padding: '10px', borderRadius: '8px', background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.15)', color: C.tx } },
						h('div', { style: { fontWeight: 600, color: C.red, marginBottom: '4px' } }, '⚠ ', uninit ? 'Lab not initialized' : 'Connection error'),
						h('div', { style: { color: C.tx2, fontSize: '10px' } }, st.error)));
			}

			var d = st.data;
			var tree = buildTree(d.solutions, d.runs);
			var activeCount = d.solutions.filter(function (s) { return s.status === 'active'; }).length;
			var runningCount = d.runs.filter(function (r) { return r.status === 'running' || r.status === 'starting'; }).length;

			return h('div', {
				style: {
					display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
					background: C.bg, color: C.tx, fontSize: '12px', fontFamily: 'inherit',
				},
			},
				// header
				h('div', {
					style: {
						display: 'flex', alignItems: 'center', gap: '8px',
						padding: '10px 12px', background: C.card,
						borderBottom: '1px solid ' + C.bd, flexShrink: 0,
					},
				},
					h('span', { style: { fontSize: '15px' } }, '🔬'),
					h('div', { style: { flex: 1, minWidth: 0 } },
						h('div', { style: { fontWeight: 700, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
							d.project.name || 'DLab'),
						h('div', { style: { fontSize: '10px', color: C.tx2 } },
						activeCount, ' solutions · ', d.runs.length, ' runs',
						runningCount > 0 ? ' · ' + runningCount + ' running' : ''),
					),
				),

				// content (scrollable)
				h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
					h(TreeView, { rows: tree }),

					// runs section
					h('div', {
						style: { fontSize: '9px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: C.tx2, padding: '10px 12px 4px', borderTop: '1px solid ' + C.bd, marginTop: '4px' },
					}, 'Recent Runs'),
					h(RunsList, { runs: d.runs }),
				),

				// agent reference footer
				h(AgentRef));
		}

		// ── header button ────────────────────────────────────────────────────

		function LabHeaderButton(props) {
			var ctx = props.ctx;
			var sessionId = props.sessionId;
			var call = useRpc(ctx);

			var openState = useState(false);
			var setOpen = openState[1];
			var open = openState[0];

			var wsMatch = useWorkspaceMatch(ctx, sessionId, call);

			// hide when workspace doesn't match
			if (wsMatch === false) return null;
			if (wsMatch === null && open) return null; // still checking → don't flash

			function toggle() {
				var bs = ctx && ctx.get ? ctx.get('betterSidebar') : undefined;
				if (bs && typeof bs.openTab === 'function') {
					bs.openTab({ type: 'dsh-lab:lab' });
					return;
				}
				setOpen(!open);
			}

			return h(React.Fragment, null,
				h('button', {
					style: {
						font: 'inherit', fontSize: '14px', color: 'inherit',
						background: 'transparent', border: 'none', cursor: 'pointer',
						padding: '4px 6px', borderRadius: '4px',
						display: 'flex', alignItems: 'center',
					},
					onClick: toggle,
					title: 'DLab — research solutions & experiments',
				}, '🔬'),
				open ? createPortal(
					h('div', {
						style: {
							position: 'fixed', top: '44px', right: '10px', bottom: '10px',
							width: 'min(400px, calc(100vw - 20px))', zIndex: 999,
							borderRadius: '10px', border: '1px solid ' + C.bd2,
							background: C.overlay,
							boxShadow: '0 12px 40px rgba(0,0,0,0.15)',
							overflow: 'hidden', display: 'flex', flexDirection: 'column',
						},
					},
						h('div', { style: { position: 'absolute', top: 4, right: 4, zIndex: 1 } },
							h('button', {
								style: {
									font: 'inherit', fontSize: '13px', padding: '3px 7px',
									background: 'rgba(127,127,127,0.1)', border: 'none',
									color: C.tx2, cursor: 'pointer', borderRadius: '4px',
								},
								onClick: function () { setOpen(false); },
							}, '✕')),
						h(LabPanel, { ctx: ctx })),
					document.body) : null);
		}

		// ── plugin wiring ────────────────────────────────────────────────────

		var inject = ['slots', 'connection'];

		function apply(ctx) {
			// better-sidebar tab (optional)
			try {
				ctx.inject(['betterSidebar'], function (bsCtx) {
					bsCtx.effect(function () {
						return bsCtx.betterSidebar.registerTab({
							id: 'dsh-lab:lab',
							title: 'DLab',
							order: 150,
							single: true,
							icon: function (size) {
								return h('span', { style: { fontSize: Math.min(size, 18) + 'px' } }, '🔬');
							},
							component: function (tp) {
								return h(LabPanel, { ctx: tp.ctx });
							},
						});
					}, 'dsh-lab: tab');
				});
			} catch (e) { /* header-button-only mode */ }

			// header button (always)
			var slots = ctx.slots;
			if (!slots) return;
			slots.inject('conversation.session.header.actions', function () {
				return slots.register(
					{
						name: 'conversation.session.header.actions',
						id: 'dsh-lab',
						order: 30,
						inject: function (sessionId) {
							return { ctx: ctx, sessionId: sessionId };
						},
					},
					function (sp) {
						return h(LabHeaderButton, { ctx: sp.ctx, sessionId: sp.sessionId });
					},
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
