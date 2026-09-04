/**
 * @dsh-lab/client — Research Evolution Graph (read-only dashboard).
 *
 * NOT a Git commit graph. This is a research decision graph:
 * hypothesis → modification → experiment → conclusion → merge to mainline.
 *
 * Layout: Main milestones on a horizontal line (the research baseline
 * evolution). Experiments branch above/below with fork/merge edges.
 * Delta metrics compare each experiment to its fork parent.
 *
 * All operations (fork, run, merge, archive) are agent-only via lab_* tools.
 * This UI is 100% read-only observation.
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
		var useCallback = React.useMemo;
		var useMemo = React.useMemo;
		var createPortal = require('react-dom').createPortal;

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
			blue: '#48f',
		};

		// ── RPC hook ─────────────────────────────────────────────────────────

		function useRpc(ctx) {
			return useMemo(function () {
				var rpc = ctx && ctx.connection && ctx.connection.rpc;
				return function (ep, p) {
					if (!rpc) return Promise.resolve({ ok: false, error: { message: 'No connection' } });
					return rpc.call(RPC, ep, p || {}).then(
						function (r) { return r && r.ok ? r : { ok: false, error: (r && r.error) || { message: 'RPC failed' } }; },
						function (e) { return { ok: false, error: { message: String((e && e.message) || e) } }; },
					);
				};
			}, [ctx]);
		}

		// ── workspace detection ──────────────────────────────────────────────

		function useWsMatch(ctx, sessionId, call) {
			var st = useState(null);
			var set = st[1];
			st = st[0];
			useEffect(function () {
				call('project.get').then(function (res) {
					if (!res.ok) { set(false); return; }
					var root = res.value.root;
					if (!root) { set(true); return; }
					var cwd = null;
					var sessions = ctx && ctx.get ? ctx.get('sessions') : undefined;
					if (sessions) {
						try {
							var b = sessions.binding(sessionId);
							if (b && b.cwd) cwd = b.cwd;
						} catch (e) {}
						if (!cwd) {
							try {
								var sc = sessions.scope(sessionId);
								if (sc && sc.header && sc.header.cwd) cwd = sc.header.cwd;
							} catch (e) {}
						}
					}
					if (!cwd) { set(true); return; }
					set(cwd === root || cwd.startsWith(root + '/'));
				});
			}, [call, sessionId]);
			return st;
		}

		// ── graph layout (pure computation, no React) ────────────────────────

		/**
		 * Compute x/y positions for the evolution graph.
		 * Main milestones: horizontal line at y=0.
		 * Experiments: lanes above (y<0) or below (y>0).
		 */
		function layoutGraph(data) {
			if (!data || !data.milestones || data.milestones.length === 0) return null;

			var MS_GAP = 160; // px between milestones
			var LANE_H = 55;  // px between experiment lanes
			var ms = data.milestones;
			var nodes = data.nodes || [];
			var edges = data.edges || [];

			// milestone positions
			var msPos = {};
			ms.forEach(function (m, i) {
				msPos[m.id] = { x: 60 + i * MS_GAP, y: 0, type: 'milestone', data: m };
			});

			// experiment nodes: group by their fork milestone
			var expByMs = {};
			nodes.forEach(function (n) {
				if (n.role === 'main') return;
				var forkFrom = n.parent || 'main';
				// find which milestone this forks from (use the milestone that
				// existed at fork time — approximate with parent's merge target
				// or 'v1' if parent is main)
				var msId = 'v1';
				if (forkFrom !== 'main') {
					// find the milestone that this experiment's parent merged into
					var parentNode = nodes.find(function (x) { return x.id === forkFrom; });
					if (parentNode && parentNode.mergedInto) {
						// the parent merged into main, so this forks from the milestone
						// AFTER that merge
						var mileIdx = ms.findIndex(function (m) { return m.source === forkFrom; });
						msId = mileIdx >= 0 ? ms[mileIdx].id : 'v1';
					}
				}
				if (!expByMs[msId]) expByMs[msId] = [];
				expByMs[msId].push(n);
			});

			// assign lanes (alternate above/below)
			var nodePos = {};
			Object.keys(expByMs).forEach(function (msId) {
				var exps = expByMs[msId];
				var base = msPos[msId] || msPos['v1'];
				if (!base) return;
				exps.forEach(function (exp, i) {
					var lane = Math.floor(i / 2) + 1;
					var side = i % 2 === 0 ? -1 : 1; // above / below
					var x = base.x + MS_GAP * 0.5; // between milestones
					// If merged, position between fork and merge milestones
					if (exp.mergedInto) {
						var mergeMs = ms.find(function (m) { return m.source === exp.id; });
						if (mergeMs && msPos[mergeMs.id]) {
							x = (base.x + msPos[mergeMs.id].x) / 2;
						}
					}
					nodePos[exp.id] = {
						x: x, y: side * lane * LANE_H,
						type: 'experiment', data: exp,
					};
				});
			});

			// compute SVG bounds
			var allPos = Object.values(nodePos).concat(Object.values(msPos));
			var minX = Math.min.apply(null, allPos.map(function (p) { return p.x; })) - 60;
			var maxX = Math.max.apply(null, allPos.map(function (p) { return p.x; })) + 60;
			var minY = Math.min.apply(null, allPos.map(function (p) { return p.y; })) - 40;
			var maxY = Math.max.apply(null, allPos.map(function (p) { return p.y; })) + 40;

			return { msPos: msPos, nodePos: nodePos, bounds: { minX: minX, maxX: maxX, minY: minY, maxY: maxY }, edges: edges };
		}

		// ── SVG graph renderer ───────────────────────────────────────────────

		function GraphSVG(props) {
			var layout = props.layout;
			var selected = props.selected;
			var onSelect = props.onSelect;
			if (!layout) return null;

			var b = layout.bounds;
			var w = b.maxX - b.minX;
			var ht = b.maxY - b.minY;
			var midY = -b.minY; // y=0 in SVG coords

			var ns = 'http://www.w3.org/2000/svg';

			function nodeColor(d) {
				if (d.type === 'milestone') return C.brand;
				var s = d.data.status;
				if (s === 'merged') return C.green;
				if (s === 'active') return C.blue;
				if (s === 'archived') return C.tx2;
				if (s === 'broken') return C.red;
				return C.tx2;
			}

			function edgeColor(e) {
				if (e.type === 'merge') return C.green;
				if (e.type === 'fork') return C.bd2;
				return C.bd;
			}

			return h('svg', {
				xmlns: ns,
				viewBox: b.minX + ' ' + b.minY + ' ' + w + ' ' + ht,
				style: { width: '100%', minHeight: '160px', display: 'block' },
			},
				// main line
				h('line', {
					x1: b.minX + 20, y1: 0, x2: b.maxX - 20, y2: 0,
					stroke: C.brand, strokeWidth: 2, opacity: 0.3,
				}),

				// edges
				layout.edges.map(function (e, i) {
					var from = layout.msPos[e.from] || layout.nodePos[e.from];
					var to = layout.msPos[e.to] || layout.nodePos[e.to];
					if (!from || !to) return null;
					var isMerge = e.type === 'merge';
					var isRunning = to.data && to.data.status === 'running';
					return h('path', {
						key: 'e' + i,
						d: 'M' + from.x + ',' + from.y + ' C' + from.x + ',' + (from.y + to.y) / 2 + ' ' + to.x + ',' + (from.y + to.y) / 2 + ' ' + to.x + ',' + to.y,
						fill: 'none',
						stroke: edgeColor(e),
						strokeWidth: isMerge ? 1.5 : 1,
						strokeDasharray: isRunning ? '4,3' : undefined,
						opacity: 0.6,
					});
				}),

				// milestone nodes
				Object.entries(layout.msPos).map(function (pair) {
					var id = pair[0], p = pair[1];
					var isSel = selected === id;
					var d = p.data;
					return h('g', {
						key: id,
						onClick: function () { onSelect(id, 'milestone', d); },
						style: { cursor: 'pointer' },
					},
						h('circle', {
							cx: p.x, cy: p.y, r: isSel ? 7 : 5,
							fill: C.brand, stroke: isSel ? C.brand : 'none', strokeWidth: 2,
						}),
						h('text', {
							x: p.x, y: p.y - 12,
							textAnchor: 'middle', fontSize: 10, fontWeight: 700,
							fill: C.brand, fontFamily: 'inherit',
						}, d.label),
						d.metric !== undefined ? h('text', {
							x: p.x, y: p.y + 18,
							textAnchor: 'middle', fontSize: 8,
							fill: C.tx2, fontFamily: 'ui-monospace,monospace',
						}, d.metric !== null && d.metric !== undefined ? d.metric.toFixed(3) : '—') : null);
				}),

				// experiment nodes
				Object.entries(layout.nodePos).map(function (pair) {
					var id = pair[0], p = pair[1];
					var isSel = selected === id;
					var d = p.data;
					var col = nodeColor(p);
					var isRunning = d.status === 'running' || d.lastRunAt && d.lastRunAt > Date.now() - 60000;
					var r = d.status === 'merged' ? 5 : 6;
					return h('g', {
						key: id,
						onClick: function () { onSelect(id, 'experiment', d); },
						style: { cursor: 'pointer' },
					},
						h('circle', {
							cx: p.x, cy: p.y, r: isSel ? r + 2 : r,
							fill: col,
							stroke: isSel ? C.brand : 'none', strokeWidth: 2,
							opacity: d.status === 'archived' ? 0.4 : 1,
						}),
						// running pulse ring
						isRunning ? h('circle', {
							cx: p.x, cy: p.y, r: r + 4,
							fill: 'none', stroke: C.blue, strokeWidth: 1,
							strokeDasharray: '2,3',
						}) : null,
						// label
						h('text', {
							x: p.x, y: p.y + (p.y < 0 ? -12 : 20),
							textAnchor: 'middle', fontSize: 9, fontWeight: 600,
							fill: C.tx, fontFamily: 'ui-monospace,monospace',
						}, short(d.label, 14)),
						// delta
						d.delta !== undefined && d.delta !== null ? h('text', {
							x: p.x, y: p.y + (p.y < 0 ? -22 : 30),
							textAnchor: 'middle', fontSize: 8, fontWeight: 600,
							fill: d.delta >= 0 ? C.green : C.red,
							fontFamily: 'ui-monospace,monospace',
						}, (d.delta >= 0 ? '+' : '') + d.delta.toFixed(3)) : null,
						// status icon
						d.status === 'merged' ? h('text', {
							x: p.x + 10, y: p.y - 4, fontSize: 8,
							fill: C.green,
						}, '✓') : null,
						d.status === 'archived' ? h('text', {
							x: p.x + 10, y: p.y - 4, fontSize: 8,
							fill: C.tx2,
						}, '×') : null);
				}),
			);
		}

		function short(s, n) {
			if (!s) return '';
			return s.length > n ? s.slice(0, n) + '…' : s;
		}

		// ── Inspector (click a node → detail) ────────────────────────────────

		function Inspector(props) {
			var sel = props.selected;
			if (!sel) return null;
			var d = sel.data;
			var isMs = sel.type === 'milestone';

			return h('div', {
				style: {
					padding: '10px 12px', background: C.nested,
					borderTop: '1px solid ' + C.bd, flexShrink: 0,
					fontSize: '11px', lineHeight: 1.5,
				},
			},
				// title row
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' } },
					h('span', { style: { fontWeight: 700, fontSize: '13px', color: C.tx } }, d.label || d.id),
					h('span', {
						style: {
							fontSize: '9px', fontWeight: 600, padding: '1px 6px', borderRadius: '999px',
							color: isMs ? C.brand : d.status === 'merged' ? C.green : d.status === 'active' ? C.blue : C.tx2,
							background: 'rgba(127,127,127,0.1)',
						},
					}, isMs ? 'Milestone' : (d.status || ''))),

				// hypothesis
				!isMs && d.hypothesis ? h('div', { style: { marginBottom: '4px' } },
					h('span', { style: { fontSize: '9px', fontWeight: 700, color: C.tx2, textTransform: 'uppercase' } }, 'Hypothesis '),
					h('span', { style: { fontStyle: 'italic', color: C.tx2 } }, short(d.hypothesis, 100))) : null,

				// conclusion
				!isMs && d.conclusion ? h('div', { style: { marginBottom: '4px' } },
					h('span', { style: { fontSize: '9px', fontWeight: 700, color: C.tx2, textTransform: 'uppercase' } }, 'Conclusion '),
					h('span', { style: { color: C.green } }, short(d.conclusion, 100))) : null,

				// metric + delta
				h('div', { style: { fontFamily: 'ui-monospace,monospace', fontSize: '10px', marginBottom: '4px' } },
					h('span', { style: { color: C.tx2 } }, 'metric  '),
					h('span', { style: { fontWeight: 700, color: C.tx } },
						d.metric !== undefined && d.metric !== null ? d.metric.toFixed(3) : '—'),
					d.delta !== undefined && d.delta !== null ? h('span', {
						style: { color: d.delta >= 0 ? C.green : C.red, fontWeight: 600, marginLeft: '6px' },
					}, (d.delta >= 0 ? '↑' : '↓') + ' ' + Math.abs(d.delta).toFixed(3)) : null),

				// git info
				!isMs ? h('div', { style: { fontFamily: 'ui-monospace,monospace', fontSize: '9px', color: C.tx2 } },
					d.branch, ' @ ', String(d.headCommit || '').slice(0, 8),
					d.runCount ? ' · ' + d.runCount + ' runs' : '') : null,

				h('div', {
					style: { fontSize: '9px', color: C.tx2, marginTop: '4px', fontStyle: 'italic' },
				}, 'All operations via agent — no buttons here.'));
		}

		// ── Activity feed ────────────────────────────────────────────────────

		function Activity(props) {
			var events = props.events || [];
			if (events.length === 0) return null;
			return h('div', { style: { padding: '4px 12px 8px' } },
				h('div', {
					style: { fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: C.tx2, marginBottom: '4px' },
				}, 'Activity'),
				events.slice(0, 8).map(function (e, i) {
					return h('div', {
						key: i,
						style: { fontSize: '10px', color: C.tx2, lineHeight: 1.6, display: 'flex', gap: '8px' },
					},
						h('span', {
							style: { fontFamily: 'ui-monospace,monospace', fontSize: '9px', color: C.tx2, flexShrink: 0 },
						}, fmtTime(e.time)),
						h('span', { style: { color: C.tx } }, e.text || e.type));
				}));
		}

		function fmtTime(ts) {
			if (!ts) return '';
			var d = new Date(ts);
			return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
		}

		// ── Main panel ───────────────────────────────────────────────────────

		function LabPanel(props) {
			var ctx = props.ctx;
			var call = useRpc(ctx);

			var st = useState({ loading: true, error: null, graph: null });
			var set = st[1];
			st = st[0];

			var selState = useState(null);
			var setSel = selState[1];
			selState = selState[0];

			var refresh = useCallback(function () {
				call('graph.get').then(function (res) {
					if (!res.ok) { set({ loading: false, error: res.error.message, graph: null }); return; }
					set({ loading: false, error: null, graph: res.value });
				});
			}, [call]);

			useEffect(function () {
				refresh();
				var t = setInterval(refresh, POLL_MS);
				return function () { clearInterval(t); };
			}, [refresh]);

			if (st.loading) {
				return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: C.tx2, fontSize: '12px' } },
					'Loading research graph…');
			}
			if (st.error) {
				return h('div', { style: { padding: '16px', fontSize: '11px' } },
					h('div', { style: { padding: '10px', borderRadius: '8px', background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.15)' } },
						h('div', { style: { fontWeight: 600, color: C.red, marginBottom: '4px' } }, '⚠ ', /initialized/i.test(st.error) ? 'Lab not initialized' : 'Error'),
						h('div', { style: { color: C.tx2, fontSize: '10px' } }, st.error)));
			}

			var g = st.graph;
			var layout = layoutGraph(g);
			var nodeCount = (g.nodes || []).length;
			var runningCount = (g.nodes || []).filter(function (n) { return n.status === 'running' || (n.lastRunAt && n.lastRunAt > Date.now() - 60000); }).length;

			function onSelect(id, type, data) {
				setSel(selState && selState.id === id ? null : { id: id, type: type, data: data });
			}

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
						h('div', { style: { fontWeight: 700, fontSize: '13px' } }, 'Research Evolution'),
						h('div', { style: { fontSize: '10px', color: C.tx2 } },
							nodeCount, ' solutions',
							runningCount > 0 ? ' · ' + runningCount + ' running' : ''),
					),
				),

				// graph (scrollable SVG)
				h('div', { style: { flex: 1, minHeight: 120, overflowX: 'auto', overflowY: 'hidden', padding: '8px 0' } },
					layout ? h(GraphSVG, { layout: layout, selected: selState ? selState.id : null, onSelect: onSelect }) :
					h('div', { style: { padding: '20px', textAlign: 'center', color: C.tx2, fontSize: '11px' } },
						'No solutions — ask the agent to initialize')),

				// inspector
				h(Inspector, { selected: selState }),

				// activity
				h(Activity, { events: g.activity || [] }),
			);
		}

		// ── header button ────────────────────────────────────────────────────

		function LabHeaderButton(props) {
			var ctx = props.ctx;
			var sessionId = props.sessionId;
			var call = useRpc(ctx);
			var openState = useState(false);
			var setOpen = openState[1];
			var open = openState[0];
			var wsMatch = useWsMatch(ctx, sessionId, call);

			if (wsMatch === false) return null;
			if (wsMatch === null && open) return null;

			function toggle() {
				var bs = ctx && ctx.get ? ctx.get('betterSidebar') : undefined;
				if (bs && typeof bs.openTab === 'function') { bs.openTab({ type: 'dsh-lab:lab' }); return; }
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
					title: 'DLab — Research Evolution Graph',
				}, '🔬'),
				open ? createPortal(
					h('div', {
						style: {
							position: 'fixed', top: '44px', right: '10px', bottom: '10px',
							width: 'min(420px, calc(100vw - 20px))', zIndex: 999,
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
			try {
				ctx.inject(['betterSidebar'], function (bsCtx) {
					bsCtx.effect(function () {
						return bsCtx.betterSidebar.registerTab({
							id: 'dsh-lab:lab',
							title: 'DLab',
							order: 150, single: true,
							icon: function (size) {
								return h('span', { style: { fontSize: Math.min(size, 18) + 'px' } }, '🔬');
							},
							component: function (tp) { return h(LabPanel, { ctx: tp.ctx }); },
						});
					}, 'dsh-lab: tab');
				});
			} catch (e) {}

			var slots = ctx.slots;
			if (!slots) return;
			slots.inject('conversation.session.header.actions', function () {
				return slots.register(
					{
						name: 'conversation.session.header.actions',
						id: 'dsh-lab', order: 30,
						inject: function (sessionId) { return { ctx: ctx, sessionId: sessionId }; },
					},
					function (sp) { return h(LabHeaderButton, { ctx: sp.ctx, sessionId: sp.sessionId }); },
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
