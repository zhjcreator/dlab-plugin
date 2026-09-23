# dsh-lab — Deep Learning Lab plugin for DSH

> 一个 DSH 插件：让 Agent 在你当前项目里并行做深度学习实验。
> A DSH plugin that lets an Agent run parallel deep-learning experiments
> inside your current project, by talking to it in natural language.

![Overview: lifecycle graph + ACTIVE/MERGED/ARCHIVED solutions](docs/screenshots/overview.png)

![Resources: 8× NVIDIA GeForce 24 GB panel](docs/screenshots/resources.png)

## 这是什么 / What is this

### 中文

`dlab-plugin` 是给 [DeepSeek Harness](https://github.com/deepseek-ai) (DSH)
写的一个插件，把「做深度学习研究」——这些原本散落在 shell、git、tmux、
conda、`nvidia-smi` 里的事情——整合成一个由 **Agent** + **只读 Web 面板**
协作完成的工作流。

你用自然语言告诉 Agent「我想换一下 loss 看看」——Agent 会：

1. 在当前项目里 fork 一条新的 git branch（一条独立的 worktree）
2. 把你的修改提交成一次 checkpoint
3. 调度空闲的 GPU 跑训练
4. 训练过程被记为一次 Experiment run；一条 branch 上可以跑很多次
5. 训完看结果，结论好就合回 main，不好就封存成 archive

Web 面板（见上方两张截图）给你看「现在有几条 branch、每条上跑了几次、
哪张 GPU 在用」，但**所有写操作都过 `lab_*` 工具**——面板本身只读。

适用：一台多卡的实验室 / 个人 GPU 服务器 / 一台机器 8 卡的人。
不适用：跨机多节点训练（调度器是单机设计的，多机需要扩展 scheduler）。

### English

`dlab-plugin` is a plugin for DeepSeek Harness (DSH) that turns "doing
deep-learning research" — the part that normally lives scattered across
shell, git, tmux, conda, and `nvidia-smi` — into a workflow split between
an **Agent** and a **read-only Web panel**.

You tell the Agent in natural language "let's try replacing the loss with X" —
the Agent:

1. forks a new git branch (an independent worktree) in your current project
2. commits your change as a checkpoint
3. schedules an idle GPU to run the training
4. the training is recorded as one Experiment run — a branch can host many
5. when training settles, look at the results; good → merge back to main,
   bad → archive the branch

The Web panel (screenshots above) shows "how many branches are alive, how
many runs each carries, which GPUs are busy" — but **all writes go through
the `lab_*` tools**. The panel is read-only.

Fits: a single multi-GPU box, a lab server, a personal 8-GPU workstation.
Does not fit: multi-node training across machines (the scheduler is
single-host; extending it is non-trivial).

## 核心思路 / Core Idea

### 中文

- **方案 (solution) = git worktree**。每条实验是 `main` 的一个 worktree，
  独立 branch、独立依赖锁，互不污染。
- **运行 (run) = 子进程 + 日志**。每次训练 fork 一个 detached 进程，stdout
  落到 run 目录里，断电也不丢。
- **证据门 (evidence gate)**。合回 `main` 必须有过 succeeded 的训练结果，
  否则默认拒绝（带 `--allow-unevidenced` 显式 override）。半成品不上主干。
- **共享文档一次写**。`docs/` 在所有 solution 之间共享；worktree 里的
  `docs/` 是软链接，永远不会变成多份过时副本。
- **GPU 排队而不是失败**。卡满就排队，等着新 run 自动接管释放出来的卡。
- **Agent 即接口**。面板只读，所有写操作都得通过 Agent 的 `lab_*` 工具，
  任何改动都过 DSH 的会话日志，可重建。

### English

- **Solution = git worktree**. Each experiment is its own worktree off
  `main`, with its own branch and dependency lock; nothing leaks between them.
- **Run = subprocess + log**. Each training spawns a detached process whose
  stdout lands in the run directory; survives reboots.
- **Evidence gate**. A merge into `main` requires at least one succeeded
  run on that branch — half-finished work doesn't land on trunk. Pass
  `--allow-unevidenced` to override deliberately.
- **Shared docs, written once**. `docs/` is shared across all solutions;
  a worktree's `docs/` is a symlink to it — never multiple stale copies.
- **GPU queue, not failure**. Full machine → queued. New runs take over
  GPUs as they're released.
- **The Agent is the interface**. Panel is read-only; every write goes
  through the Agent's `lab_*` tools, so every change is reconstructable
  from the DSH session log.

## 主要功能 / Features

### 中文

| 功能 | 说明 |
| --- | --- |
| 分支生命周期面板 | 主面板上半部（左列轨道图 + 右列事件列表）。`init` / `fork` / `merge` / `archive` 用 git-style lane graph 可视化。 |
| 解决方案状态分类 | 主面板下半部 Overview：ACTIVE / MERGED INTO MAIN / ARCHIVED 三大类，每条 branch 显示状态、branch@commit、run 数。 |
| 多 GPU 资源视图 | RESOURCES 区显示当前机器所有 GPU（截图为 8× GeForce 24GB），每张显示已用 / 总量 + 占用方。点 GPU 行可过滤到该卡上的所有 run。 |
| 训练任务面板 | Runs tab（截图里 347 个 run）：按 solution 分组折叠，活跃 run 置顶，每条 run 显示提交时间、状态、GPU 占用、metrics。 |
| 文档视图 | Docs tab：项目共享文档 + 每个 solution 的私有 notes；选中 solution 后该 solution 的内容置顶。 |
| 活动流 | Activity tab：原始 event log，类型彩色点 + 名称（非 id），按时间倒序。 |
| Agent 操作面板 | 面板本身只读；所有操作通过 DSH 会话里的 `lab_*` 工具（`fork` / `checkpoint` / `archive` / `restore` / `merge` / `start_run` …）。 |

### English

| Feature | What it does |
| --- | --- |
| Lifecycle panel | Top of the panel: a git-style lane graph (left) + an event list (right). `init`, `fork`, `merge`, `archive` events drawn on lanes. |
| Solution status | Bottom of the panel (Overview): ACTIVE / MERGED INTO MAIN / ARCHIVED sections. Each row shows status, branch@commit, run count. |
| Multi-GPU resources | The RESOURCES section shows every GPU on the box (8× GeForce 24 GB in the screenshot) with used/total + occupant. Click a GPU row to filter Runs to that card. |
| Training runs | Runs tab (347 runs in the screenshot): grouped + folded by solution; live runs pinned to the top of each group; each row shows submit time, status, GPU, metrics. |
| Documents | Docs tab: shared project documents + each solution's private notes. When a solution is selected, that solution's content goes on top. |
| Activity | Activity tab: raw event log; type-coloured dots + names (not opaque ids); newest first. |
| Agent surface | The panel itself is read-only. Every write goes through the `lab_*` tools (`fork`, `checkpoint`, `archive`, `restore`, `merge`, `start_run`, …) inside a DSH session. |

## 快速上手 / Quick Start

### 中文

1. **克隆并构建**：
   ```bash
   git clone https://github.com/zhjcreator/dlab-plugin.git
   cd dlab-plugin
   pnpm install
   pnpm build
   ```
2. **装到 DSH**：把 `dist-tb/` 里的 tarball 挂到你的 dsh profile 下并 `pnpm install`（详见「技术参考 / Initialization」）。
3. **装 preset**：`./scripts/install-preset.sh` 把 `dlab` 智能体套装复制到 `~/.dsh/.agent-presets/`。
4. **启动 DSH 并选 preset**：`dsh web`，在预设选择器里选「深度学习实验 / dlab」。
5. **开干**：在 DSH 里用自然语言告诉 Agent 你想试的实验想法。

### English

1. **Clone and build**:
   ```bash
   git clone https://github.com/zhjcreator/dlab-plugin.git
   cd dlab-plugin
   pnpm install
   pnpm build
   ```
2. **Install into DSH**: wire the tarballs in `dist-tb/` into your dsh profile and run `pnpm install` (see "Technical Reference / Initialization" below).
3. **Install the preset**: `./scripts/install-preset.sh` copies the `dlab` agent preset into `~/.dsh/.agent-presets/`.
4. **Run DSH and pick the preset**: `dsh web`, then select "dlab / 深度学习实验" from the preset picker.
5. **Go**: in a DSH session, tell the Agent the experiment you want to try.

---

# 技术参考 / Technical Reference

> 以下章节面向实现者与运维人员——架构、部署、安装、调试细节。
> 普通用户只看上半部分就够了。

Lab resolution is **per session cwd** (v0.1.3+): every consumer — `lab_*`
tools, the `lab:context` prompt section, `DSH_LAB_*` shell variables, the
browser panel — operates on the lab project that owns the session's working
directory (any directory holding an initialized `.dsh-lab/lab.sqlite`).
No root is hardcoded; a deployment may optionally pin a primary
`solutionRoot` that wins only for sessions inside it. See
`docs/DESIGN.md` §5.7.

See `docs/DESIGN.md` for the full design specification.

## 工作环境 / Working Environment

本插件是针对**多 GPU Linux 服务器**开发与测试的，目标场景是在同一台机器上
并发跑多个深度学习实验（训练、对比、checkpoint、合并）。代码本身不强制
Linux 内核特性，但以下假设一旦不满足，请按各自的工作环境调整：

| 项 | 作者的开发 / 测试环境 | 备注 |
| --- | --- | --- |
| 操作系统 | Linux (Ubuntu 22.04+) | 在 macOS / WSL2 上未做完整验证；Windows 原生不支持 |
| Node.js | `>= 22.x`（实测 22.23） | 仓库根 `package.json` 锁定 `@types/node ^22.10` |
| 包管理器 | `pnpm >= 11`（实测 11.22） | 仓库使用 `pnpm-workspace.yaml`；npm / bun 未验证 |
| Git | `>= 2.30`（实测 2.34） | `packages/git` 走 `git` CLI，要求 worktree、refs 等基础命令 |
| Python | 用户项目自备（dlab 不绑定 .venv） | 训练入口由用户在 `train.py` / 配置里指定 |
| GPU | NVIDIA + `nvidia-smi` 在 PATH | `packages/scheduler` 通过 `nvidia-smi` 发现并预留 GPU；其它厂商需要替换 `packages/scheduler/src/` 里的发现实现 |
| DSH Host | DeepSeek Harness (`dsh`) 的 web / profile 体系 | 需要把构建产物打成 tarball 后挂到对应 profile |

> **你需要根据实际环境改的地方：**
> - 如果 `nvidia-smi` 不在 PATH、或者用 AMD / 其它加速器，请改写 `packages/scheduler` 的 GPU 发现逻辑。
> - 如果 DSH 安装路径不是默认的 `~/.dsh/`（例如设了 `DSH_HOME`），所有 `~/.dsh/...` 都要换成对应位置。
> - 如果训练脚本不是 Python / CUDA，runner 部分（`packages/runner`）按需调整命令拼接与日志解析。
> - 多 GPU 调度模型（`gpuIds` pinning、wait-queue 等）是为单机多卡设计的；多机场景需要扩展 scheduler。

下文所有命令示例都按作者的实际环境写出，请把对应路径按你的环境替换
后再跑——README 不会替你做这件事。

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

> **Before you start, confirm your environment** — `node -v` (≥ 22)、`pnpm -v`
> (≥ 11)、`git --version` (≥ 2.30)、`which nvidia-smi`、`dsh --version`、
> `echo $DSH_HOME`。如果命令不在 PATH 或版本低于上表，请先解决再往下走。
> 整个流程在作者的开发机（多 GPU Linux 服务器，详见「工作环境」一节）
> 上验证通过；环境差异请按本机情况调整路径与版本。

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

`@dsh-lab/host` contributes two **host-plane** rows — `ctx.lab` (the per-project
service and its persistence) and the `/dlab` RPC channel the browser panel reads.
Everything model-facing travels with the agent preset instead: the `lab_*` tools
(`@dsh-lab/host/tools-agent`), the `lab:context` prompt section and the
`DSH_LAB_*` shell variables. `@dsh-lab/client` serves the browser panel, which
resolves the session's lab per request and hides itself outside one. Host rows
load once at process start, so **restart `dsh web`** after changing them (and
re-install the preset — see step 3 — because a mounted preset keeps the
composition it was mounted with).

That split is what keeps dlab invisible to non-research work: a session on
`standard` composes no lab row at all, while a `dlab` session whose workspace is
not a lab project registers no `lab_*` tool either (see
[Where dlab is visible](#where-dlab-is-visible)).

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

Integration and e2e tests exercise a sibling research project used as the
integration sandbox (the path is local to each developer — see
`.dsh/skills/dsh-scholar/SKILL.md` for what that project is expected to
provide). If you do not have that sibling repo, point the tests at any empty
git repo you control by exporting `DLAB_SANDBOX_ROOT=/path/to/sandbox`
before running vitest, or skip those two suites (`pnpm test:unit`). With the
env var unset, the tests fall back to the OS temp dir
(`os.tmpdir()/dlab-sandbox/<test-prefix>-<random>`).

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

**Settlement follows the store, not the process.** A run can reach a terminal
status without this host ever seeing its exit — a lazy reader closing a stuck
launch, a cross-process finalize, a run adopted after a restart. The job
watcher therefore takes the in-process exit as the fast path and re-checks the
store every 5 s, so the per-run job and the session's umbrella still settle
(and the single wake still fires) when the process was never observed.

**A submission that never ran is never `lost`.** The queue pump claims
`queued → starting` before it allocates; every exit from that claim now leaves
a definite state (promoted, failed, or requeued), a `starting` row that never
reached the launch step goes back to the wait queue instead of being finalized
as a phantom `lost`, and a boot sweeps claims orphaned by the previous process.
A run that did spawn and died without an exit code is still `lost` — that is
what the status means.

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

## Where dlab is visible

One deployment serves many workspaces, and most of them are not research
projects. **The preset is the gate** — the simplest one that covers the case
that matters:

| Surface | Gate |
| ------- | ---- |
| `lab_*` tools | **Preset only**: mounted by `packages/preset-lab/agent.cordis.yml`, never by the host composition — a session on `standard` has no lab tool in its catalog |
| `lab:context` prompt section, `DSH_LAB_*` shell variables | **Host plane**, resolving per agent: the section renders one short “no lab here” hint outside a lab, and the shell env contributes nothing at all, so both are inert for non-research work |
| Browser panel + the `🧪` header button | **Workspace**: the panel resolves the session's lab over RPC and renders “not a lab workspace” (button hidden) elsewhere |
| `dlab` skill, DL operating protocol | **Preset** only |

Consequences worth knowing:

* a session on `standard` in a lab project sees **no** lab tool — pick
  **深度学习实验** (preset `dlab`) for research work;
* a session on `dlab` gets exactly what it always had: the toolset, the lab
  context section and `DSH_LAB_*`;
* a `dlab` session whose workspace owns no lab gets tools that report “no lab
  project” — that is the accepted price of not gating per agent, and every tool
  fails loudly and harmlessly;
* a deployment that wants the toolset in *every* session can compose
  `@dsh-lab/host/tools` in the host patch, accepting the catalog cost.

**Not composed: per-agent workspace gating.** `@dsh-lab/host/tools-agent`
registers the toolset in each agent's own scope, and only when that agent's cwd
owns a lab. It is implemented and unit-tested (workspace gate, once per agent,
contained failures) but deliberately stays out of every composition: its first
version registered from `agent/created` — inside the session-creation dispatch —
and with it composed, sessions stored with the `dlab` preset could no longer be
reopened (the click loaded the session and the UI immediately fell back to a new
session, with nothing in the host log and the stored session healthy). Use it
only with a real open-a-session repro to validate against; the preset-only gate
above already keeps dlab out of non-research sessions.

## Panel (read-only observation)

The DLab page tab in the native right sidebar has three parts:

* **Evolution list** — *lifecycle only*: `init`, `fork`, `merge`, `archive`
  rows on a git-style lane graph. Runs are **not** history rows; they live in
  the Runs tab, so the list answers "what did the research do" instead of
  repeating the run list. Every row is dated from the authoritative source: a
  fork from the solution row's `createdAt`, a merge/archive from
  `mergedAt`/`archivedAt`, `init` from main's creation time (the event table is
  capped, and merges were not recorded there before the row was). A value older
  than 2000 counts as missing and renders blank — never `1 Jan 1970`.
  **Selecting a solution scopes the list to that line**: only it and the lines
  forked from it are drawn (the focused line becomes the trunk, keeping its own
  colour), with a `scope · show all` bar to get the whole lab tree back.
  The graph draws **rails**, not per-row stubs: the trunk spans the list, an
  active line's rail runs on to the newest row (it is still alive) while a
  merged/archived line stops at its terminal row, and a parent's rail reaches
  the fork row of anything forked from it — so every connector leaves a drawn
  line and nothing dangles. Lanes are handed out **newest-innermost**, which
  is what keeps a branch's connector from crossing another line's rail, and
  colour follows fork order rather than the lane index, so forking a new line
  never recolours the existing ones.
* **Runs tab** — folded per solution: click a header to collapse it, lines with
  a live run come first, and inside a line the live runs are pinned above the
  settled ones (newest first). Within a solution the `sweep/<name>` / same-code
  -state grouping stays, with a `n/N` variant ordinal. Selecting a solution
  scopes the tab to that line's runs; `docs` follows the same selection.
  Clicking a GPU in Resources opens the tab **filtered to that card** (a banner
  names it and clears the filter).
* **Docs tab** — the project-wide documents, folded into one header (count
  included) so a long inventory never buries anything. With a solution
  selected, that line's own material comes first: its **private notes**
  (`notes/`, `local/`) and then whatever it **promoted to shared**
  (`local/<slug>/`); the shared inventory stays folded below. A solution's
  `docs/` is a symlink to the shared tree, so its contents are never counted
  as private — one file, one entry. Selecting one previews it
  (`docs.readSolution` for a private note, `docs.read` for a shared one).
  Read-only, writes go through the agent.
* **Activity tab** — the raw event log with a type-colored dot per row; labels
  name the lane, not the opaque `solution_…` id.
* **Details** — card sections under a title bar (monogram + name + status):
  hypothesis/conclusion quotes, a **Metrics** block (the newest succeeded
  run's summary metrics, with the delta vs the parent line), a **Promotion**
  block mirroring the merge gate (fork / experiment / evidence / merge-to-main),
  **Changes vs main** file chips, and a **Details** fact list (branch @ hash,
  runs, fork/merge/update dates). The breadcrumb bar (`← Back · PRD ▸ solution
  ▸ run`) under the header is the single way back — the title bar does not
  repeat it. Titles fall back to a readable argv rendering
  (`.venv/bin/python train.py --config /lab/configs/a.yaml` →
  `python train.py --config ./configs/a.yaml`).

## Phase 1 goal

Before any UI work: a CLI that can complete

```
init → fork → modify → checkpoint → archive → restore → merge → run
```

including fork-to-fork merges (`into-fork` / `into-target` / `consolidate`).
