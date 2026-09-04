/**
 * @dlab/lab-client browser half.
 *
 * Format: the DSH client-module bundle shape — a
 * `window.__ModuleLoader__.load({ id, factory })` wrapper whose factory
 * receives `require` for externals (react / react-dom are provided by the
 * module system; everything else arrives via `ctx` services). No bundler is
 * involved: the build copies this file verbatim to lib/client.js.
 *
 * Dual-mode UI (DESIGN §26):
 *   1. dsh-better-sidebar PRESENT  → a "DLab" tab in the right sidebar via
 *      ctx.betterSidebar.registerTab. The registration lives inside a
 *      ctx.inject(['betterSidebar'], …) sub-plugin: it activates when the
 *      service appears and disposes automatically when it goes away, so the
 *      sidebar is never a hard dependency.
 *   2. better-sidebar ABSENT       → the always-registered "DLab" button in
 *      the conversation session header opens a fixed overlay panel. When
 *      the sidebar service IS available the same button opens the tab.
 *
 * All data flows through the /dlab Connection RPC channel served by
 * @dlab/lab-host. Plain React.createElement (no JSX — this file is not
 * transformed by any compiler).
 */

/* eslint-disable */

window.__ModuleLoader__.load({
	id: '@dlab/lab-client',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		var React = require('react');
		var createElement = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;
		var createPortal = require('react-dom').createPortal;

		var RPC_CHANNEL = '/dlab';
		var POLL_MS = 5000;

		// ── /dlab RPC client ──────────────────────────────────────────────────

		function makeRpc(ctx) {
			var rpc = ctx && ctx.connection && ctx.connection.rpc;
			return function call(endpoint, payload) {
				if (!rpc) {
					return Promise.resolve({ ok: false, error: { code: 'no-connection', message: 'Connection service unavailable' } });
				}
				return rpc
					.call(RPC_CHANNEL, endpoint, payload == null ? {} : payload)
					.then(
						function (raw) {
							var res = raw;
							if (res && res.ok) return res;
							return { ok: false, error: (res && res.error) || { code: 'bad-envelope', message: 'Malformed RPC result' } };
						},
						function (err) {
							return { ok: false, error: { code: 'transport', message: String((err && err.message) || err) } };
						},
					);
			};
		}

		// ── styles (theme-agnostic: inherit colors, no hardcoded palette) ──────

		var S = {
			panel: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: '12px', color: 'inherit' },
			header: { display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 10px', borderBottom: '1px solid currentColor', opacity: 0.9 },
			title: { fontWeight: 600, flex: 1 },
			body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 10px' },
			section: { margin: '10px 0 4px', fontWeight: 600, opacity: 0.75, textTransform: 'uppercase', letterSpacing: '0.04em', fontSize: '10px' },
			row: { display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', borderRadius: '6px', cursor: 'pointer' },
			rowSel: { background: 'rgba(127,127,127,0.18)' },
			slug: { fontFamily: 'ui-monospace,monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
			dim: { opacity: 0.55 },
			badge: { fontSize: '10px', border: '1px solid currentColor', borderRadius: '8px', padding: '0 5px', opacity: 0.7 },
			actions: { display: 'flex', flexWrap: 'wrap', gap: '4px', margin: '6px 0 0' },
			btn: { font: 'inherit', padding: '2px 8px', borderRadius: '6px', border: '1px solid currentColor', background: 'transparent', color: 'inherit', cursor: 'pointer' },
			btnPrimary: { background: 'rgba(127,127,127,0.2)' },
			detail: { margin: '6px 0', padding: '6px 8px', borderRadius: '6px', border: '1px solid rgba(127,127,127,0.35)', lineHeight: 1.5 },
			kv: { fontFamily: 'ui-monospace,monospace', fontSize: '11px', wordBreak: 'break-all' },
			err: { margin: '6px 0', padding: '6px 8px', borderRadius: '6px', border: '1px solid currentColor', opacity: 0.85 },
			overlay: {
				position: 'fixed', top: '48px', right: '16px', bottom: '16px', width: 'min(440px, 92vw)', zIndex: 60,
				borderRadius: '10px', border: '1px solid rgba(127,127,127,0.4)',
				background: 'var(--ds-bg-elevated, Canvas)', color: 'inherit',
				boxShadow: '0 8px 32px rgba(0,0,0,0.35)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
			},
			headerBtn: { font: 'inherit', color: 'inherit', background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 6px', borderRadius: '6px', display: 'flex', alignItems: 'center', gap: '4px' },
			close: { font: 'inherit', background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', padding: '2px 6px' },
		};

		var STATUS_ICON = { active: '●', archived: '○', merged: '✓', broken: '⚠', main: '★' };
		var RUN_ICON = { running: '◐', succeeded: '✔', failed: '✖', canceled: '⊘', lost: '·', queued: '·', starting: '◐' };
		var RUN_COLOR = { running: '#3b82f6', succeeded: '#22c55e', failed: '#ef4444', canceled: '#a16207', lost: '#9ca3af', queued: '#9ca3af', starting: '#3b82f6' };

		// ── the Lab panel (one shared component for both modes) ────────────────

		function LabPanel(props) {
			var ctx = props.ctx;
			var call = makeRpc(ctx);

			var data = useState(null);
			var setData = data[1];
			data = data[0];
			var errState = useState(null);
			var setError = errState[1];
			errState = errState[0];
			var busyState = useState(null);
			var setBusy = busyState[1];
			busyState = busyState[0];
			var selState = useState(null);
			var setSelected = selState[1];
			selState = selState[0];

			var refresh = useCallback(
				function () {
					return Promise.all([call('project.get'), call('solutions.list'), call('runs.list')]).then(
						function (rs) {
							if (!rs[0].ok || !rs[1].ok || !rs[2].ok) {
								var bad = !rs[0].ok ? rs[0] : !rs[1].ok ? rs[1] : rs[2];
								throw new Error((bad.error && bad.error.message) || 'RPC failed');
							}
							setData({ project: rs[0].value, solutions: rs[1].value.solutions, runs: rs[2].value.runs });
							setError(null);
						},
						function (e) {
							setError(String((e && e.message) || e));
						},
					);
				},
				[call],
			);

			useEffect(
				function () {
					refresh();
					var t = setInterval(refresh, POLL_MS);
					return function () {
						clearInterval(t);
					};
				},
				[refresh],
			);

			function act(endpoint, payload, confirmMsg) {
				if (confirmMsg && !window.confirm(confirmMsg)) return;
				setBusy(endpoint);
				call(endpoint, payload).then(
					function (res) {
						setBusy(null);
						if (!res.ok) {
							window.alert('Lab: ' + ((res.error && res.error.message) || 'operation failed'));
						}
						refresh();
					},
					function (e) {
						setBusy(null);
						setError(String((e && e.message) || e));
					},
				);
			}

			function forkFlow(source) {
				var slug = window.prompt('New solution slug (kebab-case):', '');
				if (!slug) return;
				act('solutions.fork', { source: source, slug: slug, name: slug });
			}

			if (!data) {
				var hint = errState && /initialized|no lab state/i.test(errState);
				return createElement(
					'div',
					{ style: S.panel },
					errState
						? createElement(
								'div',
								{ style: S.err },
								String(errState),
								hint
									? createElement(
											'div',
											{ style: S.actions },
											createElement('button', { style: S.btn, onClick: function () { act('project.init', {}); } }, 'Initialize lab'),
										)
									: createElement('div', { style: S.dim }, 'Is @dlab/lab-host mounted in this profile?'),
							)
						: createElement('div', { style: S.dim }, 'Loading…'),
				);
			}

			var project = data.project || {};
			var solutions = data.solutions || [];
			var runs = (data.runs || []).slice(0, 30);
			var sel = selState ? solutions.find(function (s) { return s.slug === selState; }) : null;

			return createElement(
				'div',
				{ style: S.panel },
				createElement(
					'div',
					{ style: S.header },
					createElement('span', { style: S.title }, '🧪 ', project.name || 'DLab'),
					createElement('span', { style: S.dim }, solutions.length, ' sol · ', runs.length, ' runs'),
					busyState ? createElement('span', { style: S.dim }, '⏳') : null,
					createElement('button', { style: S.btn, onClick: refresh, title: 'Refresh' }, '⟳'),
					createElement(
						'button',
						{ style: Object.assign({}, S.btn, S.btnPrimary), onClick: function () { forkFlow('main'); }, title: 'Fork a new experiment from main' },
						'+ Fork',
					),
				),
				createElement(
					'div',
					{ style: S.body },
					errState ? createElement('div', { style: S.err }, String(errState)) : null,

					createElement('div', { style: S.section }, 'Solutions'),
					solutions.map(function (s) {
						return createElement(
							'div',
							{
								key: s.slug,
								style: Object.assign({}, S.row, selState === s.slug ? S.rowSel : null),
								onClick: function () {
									setSelected(selState === s.slug ? null : s.slug);
								},
							},
							createElement('span', null, STATUS_ICON[s.role === 'main' ? 'main' : s.status] || '·'),
							createElement('span', { style: S.slug }, s.slug),
							s.dirty ? createElement('span', { style: S.badge }, 'dirty') : null,
							s.runCount ? createElement('span', { style: S.dim }, s.runCount + 'r') : null,
						);
					}),

					sel ? solutionDetail(sel, act, forkFlow) : null,

					createElement('div', { style: S.section }, 'Recent runs'),
					runs.map(function (r) {
						return createElement(
							'div',
							{ key: r.id, style: S.row },
							createElement('span', { style: { color: RUN_COLOR[r.status] || 'inherit', fontWeight: 700 } }, RUN_ICON[r.status] || '·'),
							createElement('span', { style: S.slug }, r.id.replace(/^run-/, '#'), ' ', r.solutionSlug || ''),
							r.exitCode != null ? createElement('span', { style: S.dim }, 'exit=' + r.exitCode) : null,
							r.summaryMetrics && r.summaryMetrics.auc != null ? createElement('span', { style: S.badge }, 'auc ' + r.summaryMetrics.auc) : null,
						);
					}),
					runs.length === 0 ? createElement('div', { style: S.dim }, 'No runs yet') : null,
				),
			);
		}

		function solutionDetail(s, act, forkFlow) {
			var isMain = s.role === 'main';
			var active = s.status === 'active';
			var restorable = s.status === 'archived' || s.status === 'merged';
			return createElement(
				'div',
				{ style: S.detail, key: s.slug },
				createElement(
					'div',
					{ style: S.kv },
					createElement('b', null, s.name || s.slug),
					' — ',
					s.status,
					s.parentSlug ? createElement('span', { style: S.dim }, ' ← ' + s.parentSlug) : null,
				),
				createElement('div', { style: S.kv }, s.branch, ' @ ', String(s.headCommit || '').slice(0, 8)),
				s.hypothesis ? createElement('div', { style: S.dim }, '❓ ', s.hypothesis) : null,
				s.conclusion ? createElement('div', { style: S.dim }, '📌 ', s.conclusion) : null,
				createElement(
					'div',
					{ style: S.actions },
					active
						? createElement('button', { style: S.btn, onClick: function () { act('solutions.checkpoint', { solution: s.slug }); } }, 'Checkpoint')
						: null,
					!isMain && active
						? createElement('button', { style: S.btn, onClick: function () { forkFlow(s.slug); } }, 'Fork')
						: null,
					!isMain && active
						? createElement(
								'button',
								{
									style: S.btn,
									onClick: function () {
										var conclusion = window.prompt('Conclusion (optional):', '');
										act('solutions.archive', { solution: s.slug, conclusion: conclusion || undefined },
											'Archive "' + s.slug + '"? Branch and experiments are preserved.');
									},
								},
								'Archive',
							)
						: null,
					restorable
						? createElement('button', { style: S.btn, onClick: function () { act('solutions.restore', { solution: s.slug }); } }, 'Restore')
						: null,
					!isMain && active
						? createElement(
								'button',
								{
									style: Object.assign({}, S.btn, S.btnPrimary),
									onClick: function () {
										act('solutions.merge', { source: s.slug, target: 'main', mode: 'into-target' },
											'Merge "' + s.slug + '" into main? The source workspace is archived afterwards.');
									},
								},
								'Merge → main',
							)
						: null,
				),
			);
		}

		// ── header button (always registered; opens tab or overlay) ────────────

		function LabHeaderButton(props) {
			var openState = useState(false);
			var setOpen = openState[1];
			var open = openState[0];
			var ctx = props.ctx;

			function toggle() {
				var bs = ctx && ctx.get ? ctx.get('betterSidebar') : undefined;
				if (bs && typeof bs.openTab === 'function') {
					bs.openTab({ type: 'dlab:lab' });
					return;
				}
				setOpen(!open);
			}

			return createElement(
				React.Fragment,
				null,
				createElement(
					'button',
					{ style: S.headerBtn, onClick: toggle, title: 'Deep Learning Lab (solutions, runs, merges)' },
					'🧪',
				),
				open
					? createPortal(
							createElement(
								'div',
								{ style: S.overlay },
								createElement(
									'div',
									{ style: S.header },
									createElement('span', { style: S.title }, '🧪 DLab'),
									createElement('button', { style: S.close, onClick: function () { setOpen(false); } }, '✕'),
								),
								createElement(LabPanel, { ctx: ctx }),
							),
							document.body,
						)
					: null,
			);
		}

		// ── plugin wiring ──────────────────────────────────────────────────────

		var inject = ['slots', 'connection'];

		function apply(ctx) {
			// 1) better-sidebar tab — activates only while the service exists and
			//    disposes with it (HMR). Never a hard dependency.
			try {
				ctx.inject(['betterSidebar'], function (bsCtx) {
					bsCtx.effect(
						function () {
							return bsCtx.betterSidebar.registerTab({
								id: 'dlab:lab',
								title: 'DLab',
								order: 150,
								single: true,
								icon: function (size) {
									return createElement('span', { style: { fontSize: Math.min(size, 18) + 'px' } }, '🧪');
								},
								component: function (tabProps) {
									return createElement(LabPanel, { ctx: tabProps.ctx });
								},
							});
						},
						'dlab-lab-client: sidebar tab',
					);
				});
			} catch (e) {
				// cordis builds that reject unknown inject names degrade to the
				// header-button-only mode instead of failing the whole plugin.
			}

			// 2) header button — the always-available entry point
			var slots = ctx.slots;
			if (!slots) return;
			slots.inject('conversation.session.header.actions', function () {
				return slots.register(
					{
						name: 'conversation.session.header.actions',
						id: 'dlab-lab',
						order: 30,
						inject: function () {
							return { ctx: ctx };
						},
					},
					function (slotProps) {
						return createElement(LabHeaderButton, { ctx: slotProps.ctx });
					},
				);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
