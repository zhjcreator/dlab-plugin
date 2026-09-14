# dsh-lab — Deep Learning Lab plugin for DSH

Monorepo for a DSH plugin managing parallel deep-learning research solutions:
solution lifecycle (fork / checkpoint / archive / restore / merge), experiment
runs with immutable git snapshots, and a shared Python environment.

Lab resolution is **per session cwd** (v0.1.3+): every consumer — `lab_*`
tools, the `lab:context` prompt section, `DSH_LAB_*` shell variables, the
browser panel — operates on the lab project that owns the session's working
directory (any directory holding an initialized `.dsh-lab/lab.sqlite`).
No root is hardcoded; a deployment may optionally pin a primary
`solutionRoot` that wins only for sessions inside it. See
`docs/DESIGN.md` §5.7.

See `docs/DESIGN.md` for the full design specification.

## Layout

| Package | Role | DSH-dependent |
| ------- | ---- | ------------- |
| `packages/shared` | pure types, ids, paths, errors | no |
| `packages/core` | business use cases (ports + services) | no |
| `packages/git` | LocalGitPort (`git` CLI) | no |
| `packages/store` | SqliteStore (`better-sqlite3`) | no |
| `packages/runner` | LocalRunner (process spawn/logs) | no |
| `packages/scheduler` | GPU discovery + reservation | no |
| `packages/lab-host` | DSH host bundle (`ctx.lab`, RPC, tools, shellEnv, prompt) | yes |
| `packages/lab-client` | DSH browser bundle (ClientLabModel + slot UI) | yes |
| `packages/preset-lab` | agent preset granting lab_* tools per session | yes (agent plane) |
| `packages/cli` | `dsh-lab` CLI (no DSH runtime needed) | no |
| `tests/` | unit / integration / e2e / concurrency suites | mixed |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Integration and e2e tests exercise the sibling test sandbox at
`/home2/zhanghanjin/WorkSpace/dsh-scholar` (see `.dsh/skills/dsh-scholar`).

## Run execution is a DSH background job

`lab_start_run` registers every run it launches in the generic job registry
(`ctx.jobs`, the same registry `bash run_in_background` uses) as kind
`lab-run`, **owned by the calling agent**:

- the mounted job controller delivers an in-session completion notice when the
  run settles, and wakes an idle owning session (`followup`) — the agent no
  longer has to poll `lab_list_runs` to learn that training finished;
- `job_output <lab-run-N>` streams the run's `stdout.log` (byte cursor, one
  consumer), `job_kill` / `lab_stop_run` SIGTERM the detached process group;
- disposing the owning session cancels its runs, mirroring background bash.

The bridge is best-effort: without a jobs service (or without a controller
serving the owner) the run executes exactly as before and only the wake-up is
lost. Registry records are process-local; runs adopted after a host restart
finish through the store's cross-process finalize. See
`packages/lab-host/src/run-jobs.ts`.

## Panel (read-only observation)

The DLab page tab in the native right sidebar shows the research evolution
graph, a Runs list and an Activity feed. Run/solution details carry an explicit
**← Back** button, run titles fall back to a readable argv rendering
(`.venv/bin/python train.py --config /lab/configs/a.yaml` →
`python train.py --config ./configs/a.yaml`), and each run's detail shows the
live **output tail** (stdout + stderr) via `runs.log`.

## Phase 1 goal

Before any UI work: a CLI that can complete

```
init → fork → modify → checkpoint → archive → restore → merge → run
```

including fork-to-fork merges (`into-fork` / `into-target` / `consolidate`).
