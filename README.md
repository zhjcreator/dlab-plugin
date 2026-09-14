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

## Phase 1 goal

Before any UI work: a CLI that can complete

```
init → fork → modify → checkpoint → archive → restore → merge → run
```

including fork-to-fork merges (`into-fork` / `into-target` / `consolidate`).
