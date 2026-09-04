/**
 * @dsh-lab/client browser half — the DLab panel UI.
 *
 * Bundle format: `window.__ModuleLoader__.load({ id, factory })` — the DSH
 * client-module bundle shape. `require('react')` / `require('react-dom')`
 * are provided by the module system; everything else arrives via `ctx`.
 * The build copies this file verbatim to lib/client.js (no compiler).
 *
 * Dual-mode mounting (DESIGN §26.1):
 *   dsh-better-sidebar present → "DLab" tab in the right sidebar
 *   absent                      → 🔬 header button opens a fixed overlay
 *
 * Design: all colors ride the DSH theme tokens (--dsw-alias-*), so the
 * panel matches the active light/dark theme. Layout is card-based with
 * tab navigation, colored status chips, and clearly-labeled actions.
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

		// ════════════════════════════════════════════════════════════════════
		//  Theme tokens (with graceful fallbacks for non-themed hosts)
		// ════════════════════════════════════════════════════════════════════

		var T = {
			bg: 'var(--dsw-alias-bg-base, #fafafa)',
			surface: 'var(--dsw-alias-bg-layer-1, #ffffff)',
			surfaceNested: 'var(--dsw-alias-bg-layer-2, #f4f4f5)',
			overlay: 'var(--dsw-alias-bg-overlay, #ffffff)',
			border: 'var(--dsw-alias-border-l1, #e4e4e7)',
			borderStrong: 'var(--dsw-alias-border-l2, #d4d4d8)',
			brand: 'var(--dsw-alias-brand-primary, #2563eb)',
			text: 'var(--dsw-alias-label-primary, #18181b)',
			textMuted: 'var(--dsw-alias-label-secondary, #71717a)',
			error: 'var(--dsw-alias-state-error-primary, #dc2626)',
			success: 'var(--dsw-alias-state-success-primary, #16a34a)',
			warn: 'var(--dsw-alias-state-warn-primary, #d97706)',
		};

		var STATUS = {
			active: { color: T.success, icon: '●', label: 'Active' },
			archived: { color: T.textMuted, icon: '○', label: 'Archived' },
			merged: { color: T.brand, icon: '✓', label: 'Merged' },
			broken: { color: T.error, icon: '⚠', label: 'Broken' },
		};
		var RUN_STATUS = {
			running: { color: '#3b82f6', icon: '◐', label: 'Running' },
			queued: { color: T.textMuted, icon: '…', label: 'Queued' },
			starting: { color: '#3b82f6', icon: '◐', label: 'Starting' },
			succeeded: { color: T.success, icon: '✓', label: 'OK' },
			failed: { color: T.error, icon: '✕', label: 'Failed' },
			canceled: { color: T.warn, icon: '⊘', label: 'Canceled' },
			lost: { color: T.textMuted, icon: '?', label: 'Lost' },
		};

		// ════════════════════════════════════════════════════════════════════
		//  Helpers
		// ════════════════════════════════════════════════════════════════════

		function fmtDuration(ms) {
			if (ms == null) return '';
			var s = Math.floor(ms / 1000);
			if (s < 60) return s + 's';
			var m = Math.floor(s / 60);
			if (m < 60) return m + 'm ' + (s % 60) + 's';
			return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
		}

		function fmtAgo(ts) {
			if (!ts) return '';
			var d = Date.now() - ts;
			if (d < 60e3) return 'just now';
			if (d < 3600e3) return Math.floor(d / 60e3) + 'm ago';
			if (d < 86400e3) return Math.floor(d / 3600e3) + 'h ago';
			return Math.floor(d / 86400e3) + 'd ago';
		}

		// ════════════════════════════════════════════════════════════════════
		//  Reusable UI atoms
		// ════════════════════════════════════════════════════════════════════

		function Chip(props) {
			var s = props.status || {};
			return h('span', {
				style: {
					display: 'inline-flex', alignItems: 'center', gap: '3px',
					fontSize: '10px', fontWeight: 600, lineHeight: 1,
					padding: '3px 7px', borderRadius: '999px',
					color: s.color || T.textMuted,
					background: 'color-mix(in srgb, ' + (s.color || T.textMuted) + ' 12%, transparent)',
					border: '1px solid color-mix(in srgb, ' + (s.color || T.textMuted) + ' 25%, transparent)',
					whiteSpace: 'nowrap',
				},
			}, s.icon || '·', ' ', s.label || props.fallback || '—');
		}

		function Btn(props) {
			var variant = props.variant || 'ghost';
			var styles = {
				ghost: { background: 'transparent', color: T.text, border: '1px solid ' + T.border },
				primary: { background: T.brand, color: '#fff', border: '1px solid ' + T.brand },
				danger: { background: 'transparent', color: T.error, border: '1px solid color-mix(in srgb, ' + T.error + ' 30%, transparent)' },
			};
			return h('button', {
				style: Object.assign({
					display: 'inline-flex', alignItems: 'center', gap: '4px',
					font: 'inherit', fontSize: '11px', fontWeight: 500,
					padding: '4px 10px', borderRadius: '6px',
					cursor: props.disabled ? 'not-allowed' : 'pointer',
					opacity: props.disabled ? 0.5 : 1,
					transition: 'opacity .15s, filter .15s',
				}, styles[variant] || styles.ghost),
				onClick: props.disabled ? undefined : props.onClick,
				title: props.title || '',
			}, props.icon ? h('span', { style: { fontSize: '12px' } }, props.icon) : null, props.label);
		}

		function EmptyState(props) {
			return h('div', {
				style: {
					display: 'flex', flexDirection: 'column', alignItems: 'center',
					gap: '8px', padding: '32px 16px', textAlign: 'center', color: T.textMuted,
				},
			},
				h('div', { style: { fontSize: '28px', opacity: 0.5 } }, props.icon || '📭'),
				h('div', { style: { fontSize: '13px', fontWeight: 600, color: T.text } }, props.title || 'Nothing here'),
				h('div', { style: { fontSize: '11px', maxWidth: '240px', lineHeight: 1.5 } }, props.hint || ''));
		}

		function Spinner(props) {
			return h('div', {
				style: {
					display: 'flex', alignItems: 'center', justifyContent: 'center',
					gap: '8px', padding: '32px', color: T.textMuted, fontSize: '12px',
				},
			},
				h('span', {
					style: {
						width: '16px', height: '16px', borderRadius: '50%',
						border: '2px solid ' + T.border, borderTopColor: T.brand,
						animation: 'dshlab-spin 0.8s linear infinite',
					},
				}),
				props.label || 'Loading…');
		}

		// ════════════════════════════════════════════════════════════════════
		//  Data hook
		// ════════════════════════════════════════════════════════════════════

		function useLabData(ctx) {
			var call = useMemo(function () {
				var rpc = ctx && ctx.connection && ctx.connection.rpc;
				return function (endpoint, payload) {
					if (!rpc) return Promise.resolve({ ok: false, error: { message: 'Connection unavailable — is @dsh-lab/host mounted?' } });
					return rpc.call(RPC, endpoint, payload || {}).then(function (raw) {
						return raw && raw.ok ? raw : { ok: false, error: (raw && raw.error) || { message: 'RPC failed' } };
					}, function (e) {
						return { ok: false, error: { message: String((e && e.message) || e) } };
					});
				};
			}, [ctx]);

			var state = useState({ loading: true, error: null, data: null });
			var set = state[1];
			state = state[0];

			var refresh = useCallback(function () {
				return Promise.all([call('project.get'), call('solutions.list'), call('runs.list')]).then(function (rs) {
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

			var busy = useState(false);
			var setBusy = busy[1];
			busy = busy[0];

			function act(endpoint, payload, opts) {
				opts = opts || {};
				if (opts.confirm && !window.confirm(opts.confirm)) return Promise.resolve();
				setBusy(true);
				return call(endpoint, payload).then(function (res) {
					setBusy(false);
					if (!res.ok) window.alert('⚠ Lab: ' + res.error.message);
					return refresh();
				});
			}

			return { data: state.data, loading: state.loading, error: state.error, refresh: refresh, act: act, busy: busy };
		}

		// ════════════════════════════════════════════════════════════════════
		//  Solutions tab
		// ════════════════════════════════════════════════════════════════════

		function SolutionsTab(props) {
			var lab = props.lab;
			var solutions = lab.data.solutions;
			var sel = useState(null);
			var setSel = sel[1];
			sel = sel[0];

			function forkFrom(source) {
				var slug = window.prompt('Create new experiment\n\nSource: ' + source + '\nSlug (kebab-case):', '');
				if (!slug) return;
				lab.act('solutions.fork', { source: source, slug: slug, name: slug });
			}

			var main = solutions.filter(function (s) { return s.role === 'main'; });
			var experiments = solutions.filter(function (s) { return s.role !== 'main'; });

			return h('div', { style: { padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' } },
				h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '6px' } },
					h(Btn, {
						variant: 'primary', icon: '＋', label: 'New experiment',
						title: 'Fork a new experiment from main',
						onClick: function () { forkFrom('main'); },
						disabled: lab.busy || main.length === 0,
					})),

				main.map(function (s) {
					return h(SolutionCard, { key: s.slug, solution: s, lab: lab, selected: sel === s.slug, onToggle: function () { setSel(sel === s.slug ? null : s.slug); }, isMain: true });
				}),

				experiments.length > 0 ? h('div', {
					style: { fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.textMuted, padding: '6px 4px 0' },
				}, 'Experiments · ' + experiments.length) : null,

				experiments.map(function (s) {
					return h(SolutionCard, { key: s.slug, solution: s, lab: lab, selected: sel === s.slug, onToggle: function () { setSel(sel === s.slug ? null : s.slug); } });
				}),

				experiments.length === 0 && main.length > 0 ? h(EmptyState, {
					icon: '🧪', title: 'No experiments yet',
					hint: 'Click "New experiment" to fork main — each experiment gets its own isolated worktree and branch.',
				}) : null,
			);
		}

		function SolutionCard(props) {
			var s = props.solution;
			var lab = props.lab;
			var isMain = props.isMain;
			var active = s.status === 'active';
			var st = STATUS[s.status] || STATUS.active;
			var expanded = props.selected;

			return h('div', {
				key: s.slug,
				style: {
					background: T.surface,
					border: '1px solid ' + (expanded ? T.brand : T.border),
					borderRadius: '8px', overflow: 'hidden',
					cursor: 'pointer', transition: 'border-color .15s',
					boxShadow: expanded ? '0 2px 8px rgba(0,0,0,0.06)' : 'none',
				},
				onClick: props.onToggle,
			},
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px' } },
					h('span', { style: { fontSize: '14px', color: isMain ? T.warn : st.color } }, isMain ? '★' : st.icon),
					h('div', { style: { flex: 1, minWidth: 0 } },
						h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
							h('span', { style: { fontWeight: 600, fontSize: '13px', color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.name || s.slug),
							h(Chip, { status: st }),
							s.dirty ? h(Chip, { status: { color: T.warn, icon: '✎', label: 'Dirty' } }) : null,
						),
						h('div', { style: { fontSize: '10px', color: T.textMuted, fontFamily: 'ui-monospace,monospace', marginTop: '2px' } },
							s.branch, ' @ ', String(s.headCommit || '').slice(0, 8),
							s.parentSlug ? ' · ← ' + s.parentSlug : ''),
					),
					h('div', { style: { textAlign: 'right', fontSize: '10px', color: T.textMuted, lineHeight: 1.4 } },
						h('div', { style: { fontWeight: 700, fontSize: '14px', color: active ? T.text : T.textMuted } }, s.runCount || 0),
						h('div', null, 'runs'),
					),
					h('span', { style: { color: T.textMuted, fontSize: '10px', transition: 'transform .15s', transform: expanded ? 'rotate(90deg)' : '' } }, '▶'),
				),

				expanded ? h('div', {
					style: { borderTop: '1px solid ' + T.border, padding: '10px', background: T.surfaceNested },
					onClick: function (e) { e.stopPropagation(); },
				},
					s.hypothesis ? h('div', { style: { marginBottom: '8px' } },
						h('div', { style: { fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: T.textMuted, marginBottom: '3px' } }, 'Hypothesis'),
						h('div', { style: { fontSize: '11px', color: T.text, lineHeight: 1.5, fontStyle: 'italic' } }, s.hypothesis)) : null,

					s.conclusion ? h('div', { style: { marginBottom: '8px' } },
						h('div', { style: { fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: T.textMuted, marginBottom: '3px' } }, 'Conclusion'),
						h('div', { style: { fontSize: '11px', color: T.text, lineHeight: 1.5 } }, s.conclusion)) : null,

					h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '5px', marginTop: s.hypothesis || s.conclusion ? '4px' : '0' } },
						active ? h(Btn, {
							icon: '💾', label: 'Checkpoint',
							title: 'Commit all current changes on this branch',
							disabled: lab.busy,
							onClick: function () { lab.act('solutions.checkpoint', { solution: s.slug }); },
						}) : null,
						!isMain ? h(Btn, {
							icon: '🍴', label: 'Fork',
							title: 'Fork a new experiment from this solution',
							disabled: lab.busy,
							onClick: function () {
								var slug = window.prompt('Fork from "' + s.slug + '"\nNew slug:', '');
								if (slug) lab.act('solutions.fork', { source: s.slug, slug: slug, name: slug });
							},
						}) : null,
						!isMain && active ? h(Btn, {
							variant: 'primary', icon: '🔀', label: 'Merge → main',
							title: 'Merge this experiment into main (--no-ff, preserves history)',
							disabled: lab.busy,
							onClick: function () {
								lab.act('solutions.merge', { source: s.slug, target: 'main', mode: 'into-target' }, {
									confirm: 'Merge "' + s.slug + '" into main?\n\n• Source branch is preserved\n• Source workspace is archived after merge',
								});
							},
						}) : null,
						!isMain && active ? h(Btn, {
							variant: 'danger', icon: '📦', label: 'Archive',
							title: 'Remove workspace, keep branch + experiment history',
							disabled: lab.busy,
							onClick: function () {
								var c = window.prompt('Archive "' + s.slug + '"\n\nConclusion (optional):', '');
								lab.act('solutions.archive', { solution: s.slug, conclusion: c || undefined }, {
									confirm: 'Archive "' + s.slug + '"?\n\n• Worktree is removed\n• Branch and all experiments are preserved\n• Restore anytime',
								});
							},
						}) : null,
						(s.status === 'archived' || s.status === 'merged') ? h(Btn, {
							icon: '♻', label: 'Restore',
							title: 'Re-create the worktree at the branch HEAD',
							disabled: lab.busy,
							onClick: function () { lab.act('solutions.restore', { solution: s.slug }); },
						}) : null,
					),
				) : null,
			);
		}

		// ════════════════════════════════════════════════════════════════════
		//  Runs tab
		// ════════════════════════════════════════════════════════════════════

		function RunsTab(props) {
			var lab = props.lab;
			var runs = lab.data.runs;
			var sel = useState(null);
			var setSel = sel[1];
			sel = sel[0];

			var running = runs.filter(function (r) { return r.status === 'running' || r.status === 'starting'; });
			var done = runs.filter(function (r) { return r.status !== 'running' && r.status !== 'starting'; });

			return h('div', { style: { padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } },
				running.length > 0 ? h('div', {
					style: { fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#3b82f6', padding: '4px 4px 0' },
				}, '● Running · ' + running.length) : null,
				running.map(function (r) { return h(RunCard, { key: r.id, run: r, lab: lab, expanded: sel === r.id, onToggle: function () { setSel(sel === r.id ? null : r.id); } }); }),

				done.length > 0 ? h('div', {
					style: { fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: T.textMuted, padding: '6px 4px 0' },
				}, 'History · ' + done.length) : null,
				done.map(function (r) { return h(RunCard, { key: r.id, run: r, lab: lab, expanded: sel === r.id, onToggle: function () { setSel(sel === r.id ? null : r.id); } }); }),

				runs.length === 0 ? h(EmptyState, {
					icon: '🏃', title: 'No runs yet',
					hint: 'Start an experiment run with lab_start_run or the dsh-lab CLI — each run snapshots the code at launch.',
				}) : null,
			);
		}

		function RunCard(props) {
			var r = props.run;
			var lab = props.lab;
			var st = RUN_STATUS[r.status] || RUN_STATUS.lost;
			var isRunning = r.status === 'running' || r.status === 'starting';
			var metrics = r.summaryMetrics || {};
			var metricEntries = Object.entries(metrics).slice(0, 4);

			return h('div', {
				key: r.id,
				style: {
					background: T.surface,
					border: '1px solid ' + (props.expanded ? T.brand : T.border),
					borderRadius: '8px', overflow: 'hidden',
					cursor: 'pointer', transition: 'border-color .15s',
				},
				onClick: props.onToggle,
			},
				h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '7px 10px' } },
					h(Chip, { status: st }),
					h('div', { style: { flex: 1, minWidth: 0 } },
						h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px' } },
							h('span', { style: { fontWeight: 600, fontSize: '12px', color: T.text } }, '#' + r.id.replace(/^run-/, '')),
							h('span', { style: { fontSize: '11px', color: T.textMuted } }, r.solutionSlug || ''),
							r.title ? h('span', { style: { fontSize: '10px', color: T.textMuted, fontStyle: 'italic' } }, r.title) : null,
						),
						h('div', { style: { fontSize: '10px', color: T.textMuted, fontFamily: 'ui-monospace,monospace', marginTop: '1px' } },
							isRunning ? 'running…' : (r.durationMs != null ? fmtDuration(r.durationMs) : fmtAgo(r.createdAt)),
							r.exitCode != null ? ' · exit ' + r.exitCode : ''),
					),
					metricEntries.length > 0 ? h('div', { style: { display: 'flex', gap: '3px' } },
						metricEntries.map(function (e) {
							return h('span', {
								key: e[0],
								style: {
									fontSize: '9px', fontWeight: 600, fontFamily: 'ui-monospace,monospace',
									padding: '2px 5px', borderRadius: '4px',
									background: T.surfaceNested, color: T.text, border: '1px solid ' + T.border,
								},
							}, e[0], ' ', typeof e[1] === 'number' ? e[1].toFixed(3) : e[1]);
						})) : null,
				),

				props.expanded ? h('div', {
					style: { borderTop: '1px solid ' + T.border, padding: '10px', background: T.surfaceNested },
					onClick: function (e) { e.stopPropagation(); },
				},
					h('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', fontSize: '10px', fontFamily: 'ui-monospace,monospace' } },
						h('span', { style: { color: T.textMuted } }, 'snapshot'),
						h('span', { style: { color: T.text, wordBreak: 'break-all' } }, r.snapshotCommit),
						h('span', { style: { color: T.textMuted } }, 'command'),
						h('span', { style: { color: T.text, wordBreak: 'break-all' } }, (r.command || []).join(' ')),
						r.startedAt ? h('span', { style: { color: T.textMuted } }, 'started') : null,
						r.startedAt ? h('span', { style: { color: T.text } }, new Date(r.startedAt).toLocaleString()) : null,
					),
					isRunning ? h('div', { style: { marginTop: '8px' } },
						h(Btn, {
							variant: 'danger', icon: '⏹', label: 'Stop run',
							disabled: lab.busy,
							onClick: function () { lab.act('runs.stop', { runId: r.id }, { confirm: 'Stop ' + r.id + '?' }); },
						})) : null,
				) : null,
			);
		}

		// ════════════════════════════════════════════════════════════════════
		//  Main LabPanel
		// ════════════════════════════════════════════════════════════════════

		function LabPanel(props) {
			var ctx = props.ctx;
			var lab = useLabData(ctx);

			var tabState = useState('solutions');
			var setTab = tabState[1];
			tabState = tabState[0];

			useEffect(function () {
				var style = document.createElement('style');
				style.textContent = '@keyframes dshlab-spin{to{transform:rotate(360deg)}}';
				document.head.appendChild(style);
				return function () { document.head.removeChild(style); };
			}, []);

			var project = (lab.data && lab.data.project) || {};
			var solutions = (lab.data && lab.data.solutions) || [];
			var runs = (lab.data && lab.data.runs) || [];
			var activeCount = solutions.filter(function (s) { return s.status === 'active'; }).length;
			var runningCount = runs.filter(function (r) { return r.status === 'running' || r.status === 'starting'; }).length;

			return h('div', {
				style: {
					display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
					background: T.bg, color: T.text, fontSize: '12px', fontFamily: 'inherit',
				},
			},
				h('div', {
					style: {
						display: 'flex', alignItems: 'center', gap: '8px',
						padding: '10px 12px', background: T.surface,
						borderBottom: '1px solid ' + T.border,
					},
				},
					h('span', { style: { fontSize: '16px' } }, '🔬'),
					h('div', { style: { flex: 1, minWidth: 0 } },
						h('div', { style: { fontWeight: 700, fontSize: '13px', color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, project.name || 'DLab'),
						h('div', { style: { fontSize: '10px', color: T.textMuted } }, activeCount, ' active · ', runningCount, ' running'),
					),
					lab.busy ? h('span', { style: { fontSize: '10px', color: T.textMuted } }, '⏳') : null,
					h('button', {
						style: {
							font: 'inherit', fontSize: '13px', padding: '4px 7px',
							background: 'transparent', border: '1px solid ' + T.border,
							borderRadius: '6px', color: T.textMuted, cursor: 'pointer',
						},
						onClick: lab.refresh, title: 'Refresh',
					}, '⟳'),
				),

				h('div', {
					style: { display: 'flex', background: T.surface, borderBottom: '1px solid ' + T.border },
				},
					['solutions', 'runs'].map(function (t) {
						var isSel = tabState === t;
						var count = t === 'solutions' ? solutions.length : runs.length;
						return h('button', {
							key: t,
							style: {
								font: 'inherit', fontSize: '12px', fontWeight: isSel ? 600 : 400,
								padding: '7px 14px', background: 'transparent', border: 'none',
								borderBottom: '2px solid ' + (isSel ? T.brand : 'transparent'),
								color: isSel ? T.text : T.textMuted, cursor: 'pointer',
								display: 'flex', alignItems: 'center', gap: '5px',
							},
							onClick: function () { setTab(t); },
						},
							t === 'solutions' ? 'Solutions' : 'Runs',
							h('span', {
								style: {
									fontSize: '9px', fontWeight: 600, padding: '1px 5px', borderRadius: '999px',
									background: isSel ? T.brand : T.surfaceNested,
									color: isSel ? '#fff' : T.textMuted,
								},
							}, count));
					})),

				h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto' } },
					lab.loading ? h(Spinner, { label: 'Loading lab…' }) :
					lab.error ? h(ErrorPanel, { error: lab.error, lab: lab }) :
					tabState === 'solutions' ? h(SolutionsTab, { lab: lab }) : h(RunsTab, { lab: lab })),
			);
		}

		function ErrorPanel(props) {
			var lab = props.lab;
			var isUninit = /initialized|no lab state/i.test(props.error);
			return h('div', { style: { padding: '16px' } },
				h('div', {
					style: {
						padding: '12px', borderRadius: '8px',
						background: 'color-mix(in srgb, ' + T.error + ' 8%, transparent)',
						border: '1px solid color-mix(in srgb, ' + T.error + ' 25%, transparent)',
						color: T.text, fontSize: '12px', lineHeight: 1.5,
					},
				}, h('div', { style: { fontWeight: 600, marginBottom: '4px', color: T.error } }, '⚠ ', isUninit ? 'Lab not initialized' : 'Connection error'),
					h('div', { style: { color: T.textMuted, fontSize: '11px' } }, props.error)),
				isUninit ? h('div', { style: { marginTop: '10px', textAlign: 'center' } },
					h(Btn, {
						variant: 'primary', icon: '🚀', label: 'Initialize lab',
						disabled: lab.busy,
						onClick: function () { lab.act('project.init', {}); },
					})) : null);
		}

		// ════════════════════════════════════════════════════════════════════
		//  Header button
		// ════════════════════════════════════════════════════════════════════

		function LabHeaderButton(props) {
			var openState = useState(false);
			var setOpen = openState[1];
			var open = openState[0];
			var ctx = props.ctx;

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
						padding: '4px 7px', borderRadius: '6px',
						display: 'flex', alignItems: 'center',
					},
					onClick: toggle,
					title: 'Deep Learning Lab — solutions, experiments, runs',
				}, '🔬'),
				open ? createPortal(
					h('div', {
						style: {
							position: 'fixed', top: '44px', right: '12px', bottom: '12px',
							width: 'min(420px, calc(100vw - 24px))', zIndex: 1000,
							borderRadius: '12px', border: '1px solid ' + T.borderStrong,
							background: T.overlay,
							boxShadow: '0 16px 48px rgba(0,0,0,0.2)',
							overflow: 'hidden', display: 'flex', flexDirection: 'column',
						},
					},
						h('div', {
							style: {
								display: 'flex', justifyContent: 'flex-end', padding: '4px',
								position: 'absolute', top: 0, right: 0, zIndex: 1,
							},
						},
							h('button', {
								style: {
									font: 'inherit', fontSize: '14px', padding: '4px 8px',
									background: 'transparent', border: 'none',
									color: T.textMuted, cursor: 'pointer', borderRadius: '4px',
								},
								onClick: function () { setOpen(false); },
							}, '✕')),
						h(LabPanel, { ctx: ctx })),
					document.body) : null);
		}

		// ════════════════════════════════════════════════════════════════════
		//  Plugin wiring
		// ════════════════════════════════════════════════════════════════════

		var inject = ['slots', 'connection'];

		function apply(ctx) {
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
							component: function (tabProps) {
								return h(LabPanel, { ctx: tabProps.ctx });
							},
						});
					}, 'dsh-lab-client: sidebar tab');
				});
			} catch (e) {
				// degrade to header-button-only mode
			}

			var slots = ctx.slots;
			if (!slots) return;
			slots.inject('conversation.session.header.actions', function () {
				return slots.register(
					{
						name: 'conversation.session.header.actions',
						id: 'dsh-lab',
						order: 30,
						inject: function () { return { ctx: ctx }; },
					},
					function (slotProps) {
						return h(LabHeaderButton, { ctx: slotProps.ctx });
					},
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
