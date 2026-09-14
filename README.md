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
| `packages/preset-lab` | 深度学习实验 agent preset — the deployable preset directory (`standard` + DL protocol + `lab_*` tool row + bundled `dlab` skill) | yes (agent plane) |
| `packages/cli` | `dsh-lab` CLI (no DSH runtime needed) | no |
| `tests/` | unit / integration / e2e / concurrency suites | mixed |

## Initialization

End-to-end setup from a clean checkout: build the plugin, install it into a dsh
profile, install the agent preset, restart the Host, and select the preset.

### 1. Build and pack the runtime packages

```bash
pnpm install
pnpm build
for p in shared core git store runner scheduler lab-host lab-client cli; do
  (cd "packages/$p" && pnpm pack --pack-destination "$PWD/../../dist-tb")
done
```

`dist-tb/` ends up holding one `@dsh-lab/*.tgz` per runtime package.

### 2. Install the plugin into a dsh profile

Point the profile's dependencies at those tarballs, pin the same versions under
`overrides:` in its `pnpm-workspace.yaml` (they fix the `@dsh-lab` family for
nested deps), and name the two bundles that must be composed:

```jsonc
// ~/.dsh/profiles/<name>/package.json
{
  "dependencies": {
    "@dsh-lab/core": "file:/…/dlab-plugin/dist-tb/dsh-lab-core-0.2.2.tgz"
    // … git, store, runner, scheduler, shared, host, client, cli
  },
  "dsh": { "profile": { "bundles": [ "…", "@dsh-lab/host", "@dsh-lab/client" ] } }
}
```

```bash
cd ~/.dsh/profiles/<name> && pnpm install
```

`@dsh-lab/host` supplies `ctx.lab`, the `lab_*` tools, the `/dlab` RPC channel,
the `DSH_LAB_*` shell variables and the `lab:context` prompt section — all
**host-plane**, shared by every session. `@dsh-lab/client` serves the browser
panel. Host rows load once at process start, so **restart `dsh web`** after
changing them.

### 3. Install the agent preset (深度学习实验, id `dlab`)

DSH discovers presets as directories under the harness home; the directory name
is the preset id. The preset is **not** installed as a profile bundle:

```bash
./scripts/install-preset.sh            # → $DSH_HOME/.agent-presets/dlab
```

or by hand:

```bash
DEST="${DSH_HOME:-$HOME/.dsh}/.agent-presets/dlab"
rm -rf "$DEST" && mkdir -p "$DEST"
cp packages/preset-lab/agent.cordis.yml packages/preset-lab/preset.yml "$DEST/"
cp -r packages/preset-lab/skills "$DEST/skills"
```

Copy, do not symlink: discovery only accepts real directories, and the bundled
`skills/` root is resolved relative to the copy. The composition is `standard`
plus the DL operating protocol (directional calls go to the `subagent_sol`
advisor, a new direction and any merge back to `main` need human confirmation,
a submitted run ends the turn) plus the `lab_*` tool row and the `dlab` skill.
Pass an id (`./scripts/install-preset.sh my-dlab`) to keep it side by side with
another preset.

### 4. Select it and restart

```bash
dsh web
```

Pick **深度学习实验** in the preset picker, or make it the session default:

```yaml
# ~/.dsh/settings.yaml
agent-presets:
  default: dlab
```

Editing a preset file does **not** hot-reload into a running Host — a mounted
preset keeps the composition it was mounted with. Re-run step 3 and restart.

### 5. Optional: the `dlab` skill user-globally

The preset already carries the skill. To let sessions on *other* presets see it
too, install it in the harness skill root:

```bash
mkdir -p ~/.dsh/skills/dlab && cp packages/preset-lab/skills/dlab/SKILL.md ~/.dsh/skills/dlab/
```

## Deployment (per-profile tarball installs)

Runtime packages ship as tarballs from `dist-tb/` into a dsh profile
(`~/.dsh/profiles/<name>`): add `@dsh-lab/*` as `file:dist-tb/*.tgz` deps,
mirror the same tarballs in `pnpm-workspace.yaml` `overrides:` (they pin the
@dsh-lab family for nested deps), `pnpm install`, then **restart `dsh web`** —
server rows load once at process start; source edits and repacks do not hot-reload.

To expose the `dsh-lab` CLI on PATH in such a deployment, also depend on
`@dsh-lab/cli` (it declares `bin/dsh-lab`) and link the profile's shim once:

```bash
ln -sf ~/.dsh/profiles/<name>/node_modules/.bin/dsh-lab ~/.local/bin/dsh-lab
```

The `dlab` usage skill travels with the agent preset (see
[Initialization](#initialization)); step 5 there installs it user-globally so
every session, in any lab project, sees it in its skill catalog.

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

## Experiment first, promote only what worked

A merge **into `main`** is gated (v0.1.4+): the source must be a fork of some
solution **and** have produced at least one succeeded run. The refusal happens
before any git operation, so nothing is touched:

```
refusing to merge "exp-a" into "main": the line produced only 2 failed/canceled runs.
Run it first and promote only what succeeded, or pass allowUnevidenced to override deliberately.
```

* experiment → experiment merges stay ungated (combining two half-finished
  lines is legitimate exploration);
* `allowUnevidenced: true` on `lab_merge_solution`, or `--allow-unevidenced`
  on `dsh-lab solution merge`, is the explicit override;
* `solutions.mergeEvidence(slug)` / `solutions.evidence` (RPC) return the raw
  counts (`runs` / `succeeded` / `failed` / `live` / `forked`) the gate and the
  panel's **Promotion** block read.

## Shared documents live once, at the project root

Every solution is a git worktree, so a document kept inside one is copied at
fork time and then frozen — shared knowledge diverges into one stale copy per
experiment and comes back through merges. The layout therefore splits documents
by scope:

| Where | What | Versioned |
| ----- | ---- | --------- |
| `<root>/docs/` | **shared**: charter, roadmap, baseline references, cross-cutting lessons | yes — `refs/dsh/docs` (the root is outside every worktree, so it is snapshotted explicitly) |
| `<root>/docs/local/<slug>/` | conclusions promoted out of a solution | yes, same ref; mirrored on every archive |
| `<root>/docs/.dlab/` | generated: snapshots + index state | no (git-ignored, excluded from the version snapshot) |
| `<solution>/notes/` | **private** to one experiment | on that solution's branch |
| `<solution>/docs` | a LINK to `<root>/docs` | the link only |

`docs/` means the same thing wherever you stand: in the project root it is the
directory, in any solution it is `docs -> ../../docs`. One physical copy, no
per-experiment forks of shared knowledge.

```bash
dsh-lab docs layout                  # paths + per-solution link status
dsh-lab docs list | read <path>      # inspect
dsh-lab docs history                 # version commits (refs/dsh/docs)
dsh-lab docs adopt                   # retrofit an existing project
dsh-lab docs migrate <sol> [--apply] # move in-solution docs into the shared root
dsh-lab docs promote <sol>           # keep a solution's conclusions
dsh-lab docs repair                  # re-link worktrees
```

Agent-side equivalents: `lab_docs`, `lab_write_doc`, `lab_promote_docs`,
`lab_migrate_docs`, with `DSH_LAB_DOCS` / `DSH_LAB_DOCS_LINK` in the shell
environment and the rule stated in the lab prompt section. Promotions during
`lab_archive_solution` are automatic, so archiving never loses what was learned.
Merge uses `-X ours`, so a promotion can never revert the mainline's shared
documents.

## Panel (read-only observation)

The DLab page tab in the native right sidebar has three parts:

* **Evolution list** — *lifecycle only*: `init`, `fork`, `merge`, `archive`
  rows on a git-style lane graph. Runs are **not** history rows; they live in
  the Runs tab, so the list answers "what did the research do" instead of
  repeating the run list.
* **Runs tab** — grouped per solution (lane order first, so the active
  experiment is not buried under main's history), newest first, with a
  `n/N` variant ordinal inside graded groups; each run's detail shows the live
  **output tail** (stdout + stderr) via `runs.log`.
* **Docs tab** — lists the project-wide documents (path, size, age) and
  previews the selected one; read-only, writes go through the agent.
* **Details** — always reachable back: a breadcrumb bar (`← Back · PRD ▸
  solution ▸ run`) sits under the header, and the detail header repeats
  `← Back` plus `solution →`. Titles fall back to a readable argv rendering
  (`.venv/bin/python train.py --config /lab/configs/a.yaml` →
  `python train.py --config ./configs/a.yaml`), and solution details carry a
  **Promotion** block mirroring the merge gate (fork / experiment / evidence /
  merge-to-main).

## Phase 1 goal

Before any UI work: a CLI that can complete

```
init → fork → modify → checkpoint → archive → restore → merge → run
```

including fork-to-fork merges (`into-fork` / `into-target` / `consolidate`).
