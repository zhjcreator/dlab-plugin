# DSH Deep Learning Lab Plugin — 设计文档

> 项目代号：`dlab-plugin`
> 仓库根目录：`/home2/zhanghanjin/WorkSpace/dlab-plugin`
> 文档版本：v1.0（基于已确认的产品模型 + 当前 DSH 实际接口修正）

本文档是 DSH Deep Learning Lab 插件的**设计与实现规格**。它直接对应 Agent 的工作指令，告诉 Agent 如何一步步实现。

---

## 0. 项目定位

实现一个 DSH 插件，用于管理深度学习研究过程中大量并行的：

* 方案修改（Solution 修改）
* 消融实验（Ablation）
* 超参数实验（Hparam sweep）
* 临时验证（Spike）
* 方案分叉（Fork）
* 失败方案归档（Archive）
* 有效修改合并（Merge）
* 实验记录与代码版本追踪

插件不是 MLflow / W&B / SwanLab 的替代品。它的核心职责是管理：

> **方案代码生命周期 + Git 版本关系 + 实验运行 + 代码/结果对应关系**

核心抽象：

```text
Solution  = Git Branch + Git Worktree + 完整代码目录
Run       = Solution + 不可变 Git Snapshot + 共享 .venv + Command + Resources + Results
```

主工作流：

```text
                  Fork
                   │
                   ▼
Main ────────── Solution A
 │                 │
 │                 ├── Run A1
 │                 ├── Run A2
 │                 └── Run A3
 │
 │      验证有效
 │          │
 │          ▼
 └────── Merge
```

---

## 1. 关键术语修正（与原方案的差异）

原方案在写"workspaces"时把所有概念都叫 `workspaces/`，会和 DSH 既有的 `ctx.workspaceRegistry` 完全冲突。本文档将术语严格区分。

| 原方案用语       | 本项目最终用语 | 含义                                                           |
| ---------------- | -------------- | -------------------------------------------------------------- |
| `workspaces/<x>` | `solutions/<x>` | 一个 Solution = 一个 worktree = 一个目录                      |
| `.dsh-lab/`      | `.dsh-lab/`     | 本项目内部状态目录                                             |
| Solution = Workspace | **Solution** 是本项目自有概念；**Workspace** 是 DSH Workspace Registry 的持久记录 |
| 「DSH Workspace」 | `ctx.workspaceRegistry` 注册的 workspace = 一个 Solution 的目录 |

**最终语义：**

```text
<solution-root>/solutions/<slug>           # 一个 Solution 的代码目录（git worktree）
<solution-root>/.venv                      # 全部 Solution 共享的 Python 环境
<solution-root>/experiments/               # 全部 Run 共享的实验产物
<solution-root>/.dsh-lab/                  # 本插件的内部状态（git bare repo、SQLite、locks、cache）
```

每个 active Solution：

* 是一个 git worktree（由 `.dsh-lab/repo.git` 挂出）
* 同时通过 `ctx.workspaceRegistry.create(...)` 注册为一个 DSH Workspace
* 关联到该 Solution 的 Session（DSH 自动挂在该 workspace 下）

**这意味着「Active Solution」「Worktree」「DSH Workspace」三者 1:1:1。**

---

## 2. 总体目录布局

```text
MyProject/                                       ← 用户研究的根目录（solution-root）
│
├── solutions/                                   ← 所有 Solution 目录
│   ├── main/                                    ← Main Solution（git worktree from main branch）
│   │   ├── src/
│   │   ├── configs/
│   │   ├── train.py
│   │   └── ...
│   ├── agm-cosine/                              ← experiment solution（git worktree from exp/agm-cosine）
│   │   └── ...
│   ├── rae-depth4/
│   │   └── ...
│   └── query32/
│       └── ...
│
├── .venv/                                       ← 全部 Solution 共享
│   └── bin/python
│
├── experiments/                                 ← 全部 Run 共享产物
│   ├── run-000001/
│   ├── run-000002/
│   └── ...
│
└── .dsh-lab/                                    ← 本插件内部状态（普通研究操作不需要进入）
    ├── repo.git/                                ← git bare repo
    ├── lab.sqlite                               ← SQLite 主库
    ├── config.yaml                              ← 用户可见配置（首版也接受隐藏默认）
    │
    ├── run-worktrees/                           ← 运行中的 Run 用的 detached worktree
    │
    ├── locks/                                   ← 并发锁
    │
    └── cache/                                   ← 派生缓存（指纹快照等）
```

---

## 3. Git 模型

```text
                  .dsh-lab/repo.git
                         │
        ┌────────────────┼─────────────────┐
        │                │                 │
        ▼                ▼                 ▼
      main          exp/agm-cosine    exp/rae-depth4
        │                │                 │
        ▼                ▼                 ▼
solutions/main  solutions/agm-cosine  solutions/rae-depth4
```

* Branch 命名：`main`、`exp/<solution-slug>`
* Run 快照 ref：`refs/dsh/runs/<run-id>` —— 不进入普通 `git branch` 列表
* 每个 `solutions/<slug>` 目录都是 `.dsh-lab/repo.git` 的一个 worktree

**`main` 不再是特殊目录**，它只是 `role=main`、`slug=main`、`branch=main` 的一个 Solution。Worktree 模式保证所有方案在 Git 层面完全平等。

---

## 4. DSH 集成层

### 4.1 关系矩阵

| 本项目概念 | DSH 概念                          | 关系                                                        |
| ---------- | --------------------------------- | ----------------------------------------------------------- |
| Solution   | `ctx.workspaceRegistry` 中的 Workspace | 每个 active Solution 都注册成一个 DSH Workspace               |
| Run        | DSH 持久 Session                  | 每个 Run 在其 Solution workspace 内开一个 Session 跑训练       |
| Fork       | `ctx.workspaceRegistry.create()` + git worktree | 都是新 Solution 的副作用                                       |
| Archive    | `ctx.workspaceRegistry.delete()` + git worktree remove | 都是 archive 的副作用                                       |
| Lab Service | `ctx.lab` (本插件提供)              | 注册到 host composition                                       |
| Lab Tool   | `ctx.tools.register(lab_*_tool)`  | 暴露给模型的高层语义                                           |
| Lab UI     | `ctx.slots.register(...)` (Client) | 注册浏览器半 UI                                              |

### 4.2 严格遵守的硬规则（来自 dsh-plugin-dev / cordis-plugin-development）

1. **接口以生成为准。** `ctx.lab`、Tool 签名、Slot 名、Remote API 端点 — 全部从 `cordis_inspect_*` 真实查询得到，不靠记忆。
2. **所有贡献都是副作用。** 监听、Service、Tool、Slot、注册都用 `ctx.on` / `ctx.effect` / `ctx.slots.register` 等自动清理；模块作用域不创建进程级副作用。
3. **waterfall 监听器必须调用 `next()`。** 否则是有意短路。
4. **失败要响亮。** Schema 校验失败抛错；不允许静默 fall-back。
5. **必需依赖用 `inject`；可选依赖用 `ctx.get()`。** 不在 `inject` 里装未知服务。
6. **配置一律 Schemastery。** `Config` 是 `interface` + 同名 `Schema`，默认值进 schema。
7. **Tool `execute` 返回规范 JSON。** 人类文本放 `output.render`。
8. **新增任何模型可见内容都要可重建。** 落在持久会话事件或 prompt section 中。
9. **浏览器半调主进程用 `ctx.connection.rpc.handle/call`。** 不使用 `@Remote` / `TypertRemoteService`（npm 分发场景必坏）。

### 4.3 平台划分

| 关注点                                  | 平台 | 机制                                                  |
| --------------------------------------- | ---- | ----------------------------------------------------- |
| 文件、git、命令、Process、GPU、SQLite   | Host | `apply(ctx)`，注入 service 注册                       |
| Lab 浏览器面板（Solutions / Runs / Compare） | Client | `ctx.slots.register(...)`，渲染侧只读 ClientLabModel |
| Host ↔ Client 通信                      | Both | `ctx.connection.rpc.handle('/dlab', dispatch, {authority:'loopback'})` |

---

## 5. 插件拓扑（包结构）

首版推荐**单 bundle 包** `dsh-lab-plugin`，内含一个 `cordis.patch.yml`，把所有行都集中到一个 plugin 文件里；如需后续拆分（按 three-roles 设计），在已经有 CLI 验证的稳定核心之上拆分：

```text
dsh-lab-plugin/
├── package.json                    # dsh.bundle → ./cordis.patch.yml
├── cordis.patch.yml                # 全部 plugin 行
├── README.md                       # 安装 + 用法
└── src/
    ├── core/                       # 纯领域：Solution、Run、RunProfile；不依赖 DSH
    │   ├── types.ts
    │   ├── solution-service.ts
    │   ├── run-service.ts
    │   └── ...
    ├── git/                        # 唯一允许 exec("git …") 的位置
    │   └── git-service.ts
    ├── store/                      # SQLite repository
    │   └── sqlite-store.ts
    ├── runner/                     # 进程管理
    │   └── process-runner.ts
    ├── scheduler/                  # GPU 探测 + 资源 reservation
    │   └── gpu-scheduler.ts
    ├── host/                       # DSH Host 适配（注入 ctx.lab、注册 Tool、注册 RPC 端点）
    │   ├── lab-service.ts
    │   ├── rpc.ts                  # endpoint dispatch
    │   └── tools/
    │       ├── lab-status.ts
    │       ├── lab-solution.ts
    │       └── lab-run.ts
    ├── client/                     # 浏览器半（首版可空，后续加 UI）
    │   └── ui/
    │       └── lab-page.tsx
    └── cli/                        # dsh-lab 命令行（不依赖 DSH）
        └── dsh-lab.ts
```

原则：

* `core/` 完全不知道 DSH。
* `cli/` 直接调用 `core/`，验证完整生命周期。
* `host/` 是 DSH 适配层，只在 `apply(ctx)` 内做 Service/Tool/RPC 注册；不重写业务。
* `client/` 通过 `ctx.connection.rpc.call('/dlab', ...)` 与 Host 通信。

---

## 6. Solution 数据模型

```ts
type SolutionStatus =
  | 'active'      // 有 branch + worktree + DSH Workspace
  | 'archived'    // 有 branch；无 worktree；无 DSH Workspace
  | 'merged'      // 合并到其它 Solution；branch 保留；worktree 已移除
  | 'broken';     // DB 与 Git/FS 不一致；UI 显示 ⚠，提供 Repair

interface Solution {
  id: string;                  // ULID
  projectId: string;
  slug: string;                // 不可变：solutions/<slug>、exp/<slug>
  name: string;
  description?: string;
  hypothesis?: string;
  conclusion?: string;

  role: 'main' | 'experiment';
  status: SolutionStatus;

  branch: string;              // main 或 exp/<slug>，不可变
  worktreePath?: string;       // solutions/<slug>，仅 active 时存在
  workspaceId?: string;        // ctx.workspaceRegistry 注册后的 id，仅 active

  parentSolutionId?: string;
  forkCommit?: string;

  headCommit: string;
  worktreeHead?: string;       // 与 headCommit 不同 = dirty

  mergedIntoSolutionId?: string;
  mergeCommit?: string;

  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  mergedAt?: number;
}
```

`id` 用 ULID（顺序生成且包含时间戳，方便排序）。

---

## 7. Solution 状态机

```text
                   Fork
                    │
                    ▼
               ┌────────┐
               │ ACTIVE │
               └───┬─────┘
                   │
          ┌────────┴────────┐
          │                  │
       Archive             Merge
          │                  │
          ▼                  ▼
    ┌──────────┐        ┌────────┐
    │ ARCHIVED │        │ MERGED │
    └────┬─────┘        └────┬───┘
         │                   │
      Restore             Restore
         │                   │
         └────────► ACTIVE ◄─┘
```

状态约束：

* `ACTIVE` ⇔ `branch 存在 ∧ worktree 存在 ∧ DSH Workspace 注册`
* `ARCHIVED`/`MERGED` ⇔ `branch 存在 ∧ worktree 不存在 ∧ 无 DSH Workspace`
* `BROKEN` ⇔ DB 与 Git/DSH Registry 任一不一致；不静默修复

---

## 8. Fork Solution

参数：

```ts
interface ForkSolutionInput {
  sourceSolutionId: string;
  slug: string;
  name: string;
  description?: string;
  hypothesis?: string;
}
```

流程：

```text
validate slug, source status
  ↓
source 若 dirty → 默认 checkpoint 后再 fork（用户可选择 fork from HEAD）
  ↓
git branch exp/<slug> <source-head>
git worktree add solutions/<slug> exp/<slug>
  ↓
INSERT solution(...)
  ↓
ctx.workspaceRegistry.create(solutions/<slug>, <name>)  → 记 workspaceId
  ↓
ctx.emit('solution/forked', solutionId)
```

原子性：`git branch` / `worktree add` 先做，再写 DB；中途失败要 rollback（删除已创建的 branch / worktree）。

---

## 9. Checkpoint

```ts
checkpointSolution({ solutionId, message }) → commit SHA
```

* 默认 message：`[dsh-lab] checkpoint: <name>`
* Agent 可生成更详细 message
* 修改 `solutions/<slug>` 当前 branch 的 HEAD —— **不创建 ref**
* Run snapshot 永远不修改 branch

---

## 10. Archive

```text
Solution.active = true
  ↓
若 dirty → 自动 checkpoint
  ↓
保存 conclusion（用户输入）
  ↓
git worktree remove solutions/<slug>
  ↓
ctx.workspaceRegistry.delete(workspaceId)
  ↓
status = archived
```

Branch 保留；Experiments 全部保留；DSH Sessions 在该 Solution 内的历史日志保留（成为 Ungrouped）。

若仍有运行中 Run：允许 Archive，提示「Run #N 仍会跑完，run worktree 不受影响」。

---

## 11. Restore

```bash
git worktree add solutions/<slug> exp/<slug>
ctx.workspaceRegistry.create(solutions/<slug>, <name>)
status = active
```

---

## 12. Merge to Main

默认 `--no-ff`：

```bash
git merge --no-ff exp/<solution-slug>
```

Preflight：

* source branch 存在、solution 不 broken
* main 必须 clean（dirty 时禁止 merge）
* preflight 用 `git merge-tree` 探测冲突；若预计冲突则提示用户去 Open Merge Workspace 手动解决

完成后：

```text
source.status = merged
source.mergedIntoSolutionId = main.id
source.mergeCommit = <sha>

默认 archive source workspace（worktree 移除、DSH Workspace 删除）
branch 保留
```

---

## 13. Compare Solution

提供 `lab_solution_diff(solutionIdA, solutionIdB)`：

* fork 起点 → 当前 HEAD 的 commits
* changed files（来自 git diff）
* code diff（patch）
* 实验指标对比（来自 Run summary metrics）

---

## 14. Experiment Run 数据模型

```ts
type RunStatus =
  | 'queued' | 'starting' | 'running'
  | 'succeeded' | 'failed' | 'canceled' | 'lost';

interface ExperimentRun {
  id: string;                    // ULID, run-NNNNNN
  projectId: string;
  solutionId: string;

  snapshotCommit: string;         // refs/dsh/runs/<run-id>
  sourceHeadCommit: string;       // 启动时 solutions/<slug> HEAD

  status: RunStatus;
  title?: string;
  description?: string;
  tags: string[];

  command: string[];
  shellCommand?: string;          // 仅当用户创建 Shell Profile 才用
  runProfileId?: string;

  resources: RunResourceRequest;

  runDir: string;                 // experiments/run-NNNNNN/

  pid?: number;
  pgid?: number;
  exitCode?: number;

  environmentFingerprint: string;  // env:<hash>

  tracker?: ExternalTracker;

  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}
```

---

## 15. Snapshot Git 实现

启动 Run 时，使用临时 index（不污染当前 working tree 的 index）：

```bash
TMP=$(mktemp)
GIT_INDEX_FILE=$TMP git read-tree HEAD
GIT_INDEX_FILE=$TMP git add -A

TREE=$(GIT_INDEX_FILE=$TMP git write-tree)
PARENT=$(git rev-parse HEAD)

COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "[dsh-lab] run snapshot <run-id>")

git update-ref refs/dsh/runs/<run-id> "$COMMIT"
rm -f $TMP
```

* 捕获 tracked modified、staged、untracked（非 ignored）
* 不修改当前 branch、不修改 HEAD、不污染当前 index

随后：

```bash
git worktree add --detach .dsh-lab/run-worktrees/<run-id> <snapshotCommit>
```

Cwd = `.dsh-lab/run-worktrees/<run-id>/`。Run 继续修改 `solutions/<slug>` 不影响此 Run。

Run 完成后：

```bash
git worktree remove .dsh-lab/run-worktrees/<run-id>
```

`refs/dsh/runs/<run-id>` 永久保留。

---

## 16. Run 目录布局

```text
experiments/run-000123/
├── manifest.json
├── command.json
├── logs/
│   ├── stdout.log
│   └── stderr.log
├── environment/
│   ├── python.json
│   ├── system.json
│   └── requirements.txt
├── metrics/
│   ├── summary.json
│   └── metrics.jsonl
├── artifacts/
├── configs/
└── notes.md
```

---

## 17. Run Environment

所有 Run 通过 `ctx.shellEnv.register(...)` 注册本插件贡献的 `DSH_*` 变量，并在 spawn 时由 `ctx.subprocess` 写入：

```
DSH_LAB_PROJECT_ROOT
DSH_LAB_SOLUTION_ID
DSH_LAB_SOLUTION_SLUG
DSH_LAB_RUN_ID
DSH_LAB_RUN_DIR
DSH_LAB_SNAPSHOT_COMMIT
DSH_LAB_VENV=<absolute path to .venv>
```

`PYTHONPATH` 默认 = `<solution-root>`（指向 Solution 目录，避免 cwd 漂移），首版仅写 `cwd = <solution-root>` + `VIRTUAL_ENV=<root>/.venv` + `PATH=<root>/.venv/bin:$PATH`。

`.venv` 共享 mutable，但每次 Run 记录 `environmentFingerprint = hash(pythonVersion + pipFreeze + torchVersion + cudaVersion + gpuList)`。

---

## 18. Process 管理

```ts
interface ProcessInfo {
  pid: number;
  pgid?: number;
  host: string;
  startedAt: number;
}
```

通过 `ctx.subprocess.spawn(spec)` 走 DSH 的子进程 seam：

* `detached: true`（自己 process group）
* argv 直接传（不 shell-interpret），除非用户显式创建 Shell Profile
* stdio → 写到 `experiments/run-NNNNNN/logs/`
* 杀进程走 DSH 的 `terminate()`，ESRCH 容错

Plugin 重启后 reconcile：检查 PID 是否存活，更新 Run 状态（alive / lost）。

---

## 19. Resource Model & GPU Reservation

```ts
interface RunResourceRequest {
  mode: 'explicit' | 'auto';
  gpuIds?: number[];
  gpuCount?: number;
  minFreeVramMB?: number;
  env?: Record<string, string>;
}
```

* `mode=explicit` → 直接使用 `gpuIds`，写 `CUDA_VISIBLE_DEVICES=<ids>`
* `mode=auto` → 由本插件 GPU Scheduler 探测 `nvidia-smi`、按 `gpuCount` + `minFreeVramMB` 选 GPU
* reservation 通过 SQLite 表 `gpu_reservations(gpu_id PK, run_id, reserved_at)` 保证并发原子性
* 同一 `scheduler.lock` 串行化所有 reservation 操作，避免两个 Run 同时分配到同一张卡

---

## 20. SQLite Schema

`projects`、`solutions`、`solution_relations`、`runs`、`run_metrics`、`run_tags`、`run_profiles`、`environment_snapshots`、`gpu_reservations`、`events` —— 字段基本沿用原方案，但有这些修正：

* `solutions.workspace_id TEXT` —— 关联 `ctx.workspaceRegistry` 的 Workspace id
* `solutions.worktree_path TEXT` —— 相对 solution-root 的 `solutions/<slug>`
* 所有路径都用 `solution_root + relative`，启动时校验不越界
* `runs.run_dir TEXT` —— 相对路径 `experiments/run-NNNNNN/`
* `runs.worktree_path TEXT` —— 相对路径 `.dsh-lab/run-worktrees/run-NNNNNN/`
* `events.payload_json TEXT` —— 仅记录最小事件负载（`{solutionId, ...}`），不写大型对象

具体 DDL 见 `src/store/schema.sql`（实现时输出）。

---

## 21. Config（用户可编辑的 `config.yaml`）

```yaml
version: 1

project:
  name: PRISM

paths:
  solutions: solutions
  environment: .venv
  experiments: experiments
  lab_state: .dsh-lab

git:
  repository: .dsh-lab/repo.git
  main_branch: main
  experiment_branch_prefix: exp/
  run_ref_prefix: refs/dsh/runs/

merge:
  target: main
  strategy: no-ff
  archive_after_merge: true

scheduler:
  enabled: true
  gpu_poll_interval_seconds: 5

runs:
  worktree_root: .dsh-lab/run-worktrees
  default_python: .venv/bin/python

run_profiles:
  ffpp_train:
    name: FF++ Train
    command:
      - python
      - train.py
      - --config
      - configs/ffpp.yaml
    resources:
      gpu_count: 2
      min_free_vram_mb: 18000
```

---

## 22. 初始化流程

首次在 `<solution-root>` 启动插件：

1. 校验 `solutions/`、`experiments/`、`.venv` 路径都存在（不替用户创建 `.venv` —— 由用户/Agent 自行管理）
2. 若 `.dsh-lab/repo.git/` 不存在：
   * `git init --bare .dsh-lab/repo.git`
   * 若发现现有 git 仓库（用户原始的），先 `clone --bare` 到 `.dsh-lab/repo.git`，**不删除原仓库**
   * 默认 `git branch -f main <init-commit>`
3. 在 `.dsh-lab/repo.git` 上 worktree 出 `solutions/main`（branch=`main`）
4. INSERT `solutions` row：`role=main, slug=main, branch=main, status=active`
5. `ctx.workspaceRegistry.create(solutions/main, "Main")`
6. INSERT `projects` row
7. 初始化默认 run profiles

---

## 23. DSH 插件架构

### 23.1 注入与导出

主入口（host）：

```ts
// src/host/index.ts
export const name = 'dlab-plugin'
export const inject = [
  'workspaceRegistry',  // 注册/删除 Solution workspace
  'subprocess',         // 启动 Run
  'shellEnv',           // 注入 DSH_LAB_* 环境变量
  'tools',              // 注册 lab_* 工具
  'storageDomain',      // 持久化 SQLite 表
  'connection',         // 浏览器半 RPC
]

export const Config = Schema.object({
  solutionRoot: Schema.string().default(process.cwd()),
  configPath: Schema.string().optional(),  // 默认 <solutionRoot>/.dsh-lab/config.yaml
})

export async function apply(ctx: Context, config: Config) {
  const lab = new LabService(ctx, config)
  ctx.inject(['connection'], () => {
    ctx.effect(() => ctx.connection.rpc.handle('/dlab', dispatch.bind(null, lab), { authority: 'loopback' }))
  })
}
```

### 23.2 LabService 形态

```ts
class LabService extends Service {
  static inject = ['workspaceRegistry', 'subprocess', 'shellEnv', 'storageDomain', 'tools']
  constructor(ctx: Context) { super(ctx, 'lab') }

  solutions = {
    list(): SolutionView[]
    get(id): SolutionView
    fork(input): SolutionView
    checkpoint(input): { commit: string }
    archive(input): void
    restore(id): void
    mergeToMain(input): MergeResult
    diff(a, b): DiffView
  }

  runs = {
    list(filter?): RunView[]
    get(id): RunView
    start(input): RunView
    stop(id): void
    compare(ids: string[]): CompareView
  }

  resources = { snapshot(): ResourceView }
  environment = { get(): EnvironmentView }
  follow(clientId): AsyncIterable<LabIncrement>
}
```

### 23.3 Remote API（`/dlab` channel）

```ts
const RPC_CHANNEL = '/dlab'
type Endpoint =
  | 'project.get'
  | 'solutions.list' | 'solutions.get' | 'solutions.fork'
  | 'solutions.archive' | 'solutions.restore' | 'solutions.checkpoint'
  | 'solutions.merge' | 'solutions.diff'
  | 'runs.list' | 'runs.get' | 'runs.start' | 'runs.stop'
  | 'runs.compare' | 'resources.get' | 'environment.get'
  | 'follow'

type RpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }
```

首版直接用 `ctx.connection.rpc`，**不用 `@Remote` / `TypertRemoteService`**（npm 分发场景会失效）。

### 23.4 `lab.follow(clientId)`

返回第一帧 `LabBaseline`，随后推 `LabIncrement`：

```ts
type LabBaseline = {
  project: ProjectView
  solutions: SolutionView[]
  runs: RunView[]
  resources: ResourceView
  environment: EnvironmentView
}

type LabIncrement =
  | { kind: 'solution.upsert', solution: SolutionView }
  | { kind: 'solution.remove', id: string }
  | { kind: 'run.upsert', run: RunView }
  | { kind: 'run.metric', runId: string, name: string, value: number }
  | { kind: 'resources.update', resources: ResourceView }
  | { kind: 'environment.update', environment: EnvironmentView }
```

### 23.5 客户端模型（ClientLabModel）

React 通过 `useSyncExternalStore` 订阅。负责：

* 调 `lab.follow()` → baseline + increment 推
* 维护 `solutions / runs / selection / resources / environment` 的不可变快照
* 提供 `getSnapshot() / subscribe()` 给 React

### 23.6 Agent Tools（Model Tools）

```ts
ctx.tools.register(defineTool({ name: 'lab_status', ... }))
ctx.tools.register(defineTool({ name: 'lab_list_solutions', ... }))
ctx.tools.register(defineTool({ name: 'lab_get_solution', ... }))
ctx.tools.register(defineTool({ name: 'lab_solution_diff', ... }))
ctx.tools.register(defineTool({ name: 'lab_list_runs', ... }))
ctx.tools.register(defineTool({ name: 'lab_get_run', ... }))
ctx.tools.register(defineTool({ name: 'lab_compare_runs', ... }))
ctx.tools.register(defineTool({ name: 'lab_get_resources', ... }))

ctx.tools.register(defineTool({ name: 'lab_fork_solution', ... }))
ctx.tools.register(defineTool({ name: 'lab_checkpoint_solution', ... }))
ctx.tools.register(defineTool({ name: 'lab_archive_solution', ... }))
ctx.tools.register(defineTool({ name: 'lab_restore_solution', ... }))
ctx.tools.register(defineTool({ name: 'lab_merge_solution', ... }))
ctx.tools.register(defineTool({ name: 'lab_start_run', ... }))
ctx.tools.register(defineTool({ name: 'lab_stop_run', ... }))
ctx.tools.register(defineTool({ name: 'lab_update_solution_metadata', ... }))
```

每个 Tool 内部调用 `ctx.lab.*` —— Agent 不直接碰 git / sqlite / worktree。

### 23.7 Slot 注册

实际注册前先用 `cordis_inspect_query` 查真实 slot 名（`Slots.listSubTree`）。已知的候选：

* `sidebar.workspaces` —— 已由 `dsh-client-ui-workspace` 注册，可借 sidebar 入口
* `conversation.session.header.actions` —— 在 session header 放 actions
* `shell.overlay` —— 全局浮层入口

首版推荐：在 conversation session header 放一个 "Lab" 入口按钮，弹出 Lab 面板（覆盖 conversation 主区，或借用一个独立 panel slot）。

完整 slot 名列表以 inspect 实际结果为准。

---

## 24. CLI（`dsh-lab`）

脱离 DSH 即可运行（首版最重要的验证面）：

```bash
dsh-lab status
dsh-lab solution list
dsh-lab solution fork <source-id-or-slug> <new-slug>
dsh-lab solution checkpoint <slug> [--message ...]
dsh-lab solution archive <slug> [--conclusion ...]
dsh-lab solution restore <slug>
dsh-lab solution diff <slug-a> <slug-b>
dsh-lab solution merge <slug> --target main
dsh-lab run start <slug> [--profile <id>] [--title ...] [--tag ...]
dsh-lab run list
dsh-lab run stop <run-id>
```

CLI 直接调 `core/`。在 CLI 验证完 `Init → Fork → Modify → Archive → Restore → Merge → Run` 闭环之前，不要做大规模 UI。

---

## 25. Agent 当前 Solution 上下文注入

Agent 打开某个 Solution workspace 时，通过 `systemPrompt.section(...)` 注入一段：

```text
DSH LAB CONTEXT

Project: PRISM
Solution: AGM Cosine
Role: Experiment
Parent: Main
Branch: exp/agm-cosine
Workspace: <solution-root>/solutions/agm-cosine
Shared Environment: <solution-root>/.venv
Experiments: <solution-root>/experiments

Git Status: 3 modified files

Recent Runs:
  #141 succeeded AUC=0.927
  #145 running

Rules:
  Do not modify another Solution workspace directly.
  Use lab tools for fork / archive / merge.
  Experiment outputs should use DSH_LAB_RUN_DIR.
```

规则——Agent 不能用 `cd ../main && vim` 绕过 Solution 生命周期。

---

## 26. UI 信息架构（首版推荐）

主面板放在 conversation 主区之上的覆盖层（或借用可注册 panel slot）：

```text
┌────────────────────────────────────────────────────────────────┐
│ PRISM Lab       Environment: ✓     GPU: 2/4 free     + Fork   │
├───────────────────┬────────────────────────────────────────────┤
│ Solutions         │  Solution Detail                          │
│ ★ Main            │  AGM Cosine — Active                      │
│ ● AGM Cosine      │  Hypothesis: ...                          │
│ ● RAE Depth4      │  [Open] [Run] [Fork] [Compare]            │
│ ○ Query32            │  [Checkpoint] [Merge] [Archive]          │
│ ✓ New Loss        │  Recent Runs                              │
│                   │  #141  Running   GPU 2,3                  │
│                   │  #137  0.927     Success                  │
└───────────────────┴────────────────────────────────────────────┘
```

Tabs：

```text
Solutions | Experiments | Compare | Resources | Environment
```

具体 Slot/主题 token 取自实际 inspect 结果，首版用现成的 layout + shell.overlay 即可。

---

## 27. MVP 开发优先级

### Phase 1 — Core + CLI（**先做，先稳定**）

```text
domain types
SQLite schema + migrations
GitService (fork/checkpoint/worktree add-remove/branch/diff/merge)
SolutionService
init / fork / checkpoint / archive / restore / diff / merge
reconcile (启动时校对 Git/FS/DB)
CLI：dsh-lab status/solution/run
Git integration tests + crash tests + concurrency tests
```

### Phase 2 — DSH Host

```text
LabService (ctx.lab)
Remote API (/dlab channel via ctx.connection.rpc.handle)
Agent Tools (lab_*)
DSH Workspace bridge (fork→ctx.workspaceRegistry.create / archive→delete)
shellEnv 注册 DSH_LAB_*
```

### Phase 3 — Run

```text
snapshot git (临时 index)
run worktree
shared .venv + environment fingerprint
start/stop via ctx.subprocess
reconcile 启动时 PID
process reconciliation
```

### Phase 4 — UI

```text
ClientLabModel
slate 简单布局
Solution List + Detail
Experiments List + Run Detail
Compare
Resources
```

### Phase 5 — GPU Scheduler

```text
nvidia-smi 探测
queue
reservation
auto allocate
process recovery
```

### Phase 6 — 高级（先不做）

```text
merge conflict 工作流
自动 conclusion 总结
多用户、SSH 集群、SLURM
自动 HPO
完整 SwanLab/W&B 集成
```

---

## 28. 不在第一版做

明确禁止 scope creep：

* 完整 Slurm / SSH 集群
* Docker / K8s
* 自动 HPO / Optuna
* MLflow / SwanLab / W&B 替代
* 多环境管理
* 多人权限
* GitHub PR 管理
* merge conflict 自动解决
* 编辑 `solutions/<slug>` 之外的目录

先把 `Solution → Git Worktree → Snapshot → Run → Merge` 做稳定。

---

## 29. 验收标准（Scenario）

| 编号 | 场景                                              | 期望                                                                             |
| ---- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| A    | Fork `main` → `agm-cosine`                        | `solutions/agm-cosine/` 出现；`exp/agm-cosine` branch 存在；DSH Workspace 注册 |
| B    | 在 `solutions/agm-cosine/` 修改 + 启动 Run         | Run snapshot commit ≠ Run 启动后修改的 HEAD；Run 不受后续修改影响                |
| C    | Archive `agm-cosine`                              | `solutions/agm-cosine/` 删除；`exp/agm-cosine` branch 保留；`experiments/` 保留 |
| D    | Restore `agm-cosine`                              | `solutions/agm-cosine/` 重新出现；代码与 archive commit 一致                       |
| E    | Merge `agm-cosine` → main                         | main 包含 AGM 修改；git graph 保留 merge relation；branch 保留；worktree 移除      |
| F    | 同时 3 个 Agent 在 AGM / RAE / Query32 工作        | 代码不互相覆盖；`.venv` 共享；Run 都写 `experiments/`；互不抢 GPU                 |

---

## 30. 5 个不可妥协原则

1. **不要复制目录创建方案。** 必须 Git Worktree。
2. **不要让 Run 绑定可变 Working Tree。** 必须 Snapshot。
3. **不要让 Archive 删除 Git History。** Archive 只删 worktree + DSH Workspace。
4. **不要让 React/UI 成为业务状态 owner。** Host 是权威，DSH 当前架构本身也是 Host → Remote → Client Model → UI。
5. **不要让 DSH 成为 Core 的硬依赖。** `core/` 与 `cli/` 不依赖 DSH；`host/` 是 DSH 适配器。

---

## 31. 实现路径（Agent 第一阶段任务清单）

```text
1. 读取并理解本设计文档。
2. 在仓库下创建 src/core/, src/git/, src/store/, src/cli/ 子目录与 package.json。
3. 定义 domain types（src/core/types.ts）。
4. 实现 SQLite schema（src/store/schema.sql）+ migration runner（src/store/sqlite.ts）。
5. 实现 GitService（src/git/git-service.ts），封装所有 git 命令。
6. 实现 SolutionService（src/core/solution-service.ts）覆盖 init/fork/checkpoint/archive/restore/diff/merge。
7. 实现 reconcile：启动时对比 git worktree list / branch / DB。
8. 写 Git integration tests + crash tests + concurrency tests。
9. 实现 CLI（src/cli/dsh-lab.ts）—— 验证 Init → Fork → Modify → Archive → Restore → Merge 闭环。
10. CLI 稳定后，才开始接入 DSH Host Service / Remote / Client / UI。
11. 接入前先用 cordis_inspect_list 拿到真实的 Service/Event/Slot 列表，再用 cordis_inspect_query 查 ctx.workspaceRegistry.create/delete、ctx.subprocess.spawn、ctx.shellEnv.register、ctx.connection.rpc.handle、ctx.slots.register 的具体签名。
12. UI 阶段同样先用 Slots.listSubTree 拿到真实 slot 名，不要猜。
```

> 第 10 步之前不应开始大规模 UI 工作。这条顺序用来避免「UI 完整、生命周期不可靠」的陷阱。

---

## 附录 A：本设计文档与 DSH 当前版本的接口对齐

实际 DSH 接口（在写代码前**必须**用 `cordis_inspect_list` + `cordis_inspect_query` 二次确认）：

| 用途                       | 真实入口                                                                    |
| -------------------------- | --------------------------------------------------------------------------- |
| Workspace 注册              | `ctx.workspaceRegistry.create(path, title?)` 返回 Workspace；`delete(id)`  |
| Solution 状态展示在 sidebar | `dsh-client-ui-workspace` 注册 `sidebar.workspaces` slot                   |
| 启动 Run                    | `ctx.subprocess.spawn(spec)` 返回 SubprocessHandle；`spec.argv` 数组；不 shell-interpret |
| 注入 DSH_LAB_* 环境        | `ctx.shellEnv.register({ name, variables: { DSH_LAB_*: { description } }, resolve(execution) })` |
| Browser → Host              | `ctx.connection.rpc.handle('/dlab', dispatch, { authority: 'loopback' })` |
| Browser ← Host (Client) | `ctx.connection.rpc.call('/dlab', endpoint, args)` via `@deepseek-ai/dsh-client-connection/client` |
| 持久化                   | `ctx.storageDomain.open(spec)` 返回 Domain handle；Domain.put(key, value) / Domain.get(key) |
| Skills 文件型注册            | 在 `<solution-root>/.dsh/skills/<name>/SKILL.md` 写一个 Skill，filesystem provider 自动发现 |
| 配置                          | Schemastery `Config` schema；默认值在 schema；cordis.yml 顶层 config 传值 |

> 这些是当前 0.1.1-rc.2 实现的真实形状；Agent 在写代码前**必须**做一次 `cordis_inspect_*` 二次确认，因为 DSH 仍在快速演化。

---

## 附录 B：与原方案的关键修正对照表

| # | 原方案                                  | 本文档修订                                                                                            |
| - | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1 | 全部叫 `workspaces/`                   | Solution 目录改为 `solutions/`；DSH Workspace 概念严格分离                                            |
| 2 | 强制 SQLite                            | 改用 `ctx.storageDomain` 抽象域（默认 backend=json，本项目用 SQLite 实现需要后端）；首版 SQLite 直连更可控 |
| 3 | `@Remote` + TypertRemoteService        | 改用 `ctx.connection.rpc.handle/call`                                                                 |
| 5 | 浏览器半自己维护 React 数据           | 用 `ClientLabModel` + `useSyncExternalStore`；UI 是投影                                              |
| 6 | 没强调 Slot discovery                  | 首版必须先 `Slots.listSubTree` 取真实 slot 名                                                        |
| 7 | `ctx.lab.solutions.list()` 等直接假设 | 用 `Service` 子类暴露 `ctx.lab`；具体方法以 inspect 为准                                              |
| 8 | `nvidia-smi` 直接调用                  | 走 `ctx.subprocess` 沙箱 + 权限策略                                                                   |
| 9 | 没有提到 AGENTS.md / shellEnv / plan   | 明确：本插件贡献 `DSH_LAB_*` shellEnv 变量；不写自己 system prompt section，而是通过 `systemPrompt.section()` 注册 |
| 10 | 没有 reconcile / crash tests          | 列为 Phase 1 必须项                                                                                   |
| 11 | 没有提到 workspace 与 run worktree 区分 | `solutions/<slug>` 是 Solution；`.dsh-lab/run-worktrees/run-NNN` 是 Run —— 完全不混 |
| 12 | editable install 检查未说明           | 在 environment fingerprint 警告中体现                                                                  |

---

## 附录 C：开发者权威参考

实现时遇到问题，**按优先级**查：

1. **本设计文档** —— 项目级决策
2. **`/home2/zhanghanjin/WorkSpace/dlab-plugin/.dsh/skills/dsh-plugin-dev`** —— DSH 插件开发标准（含 references/ 下的 plugin-anatomy / services / tools / connection-rpc / events / config / packaging / workspace-package / seams / three-roles）
3. **`cordis_inspect_*` 实时查询** —— 当前 DSH 进程内的真实 Service / Event / Slot / Tool 签名
4. **`ctx.agentPresets.list()` + `read(id)`** —— 读 `standard` preset 看 host + agent plane 的边界划分

不要凭记忆写 `ctx.xxx.method()`。不要凭截图猜 Slot 名。

---

文档结束。