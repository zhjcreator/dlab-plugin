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

> **命名记录（2026-09-04）**：npm scope `@dlab` 已被他人注册（`@dlab/core` 存在 7 个版本，owner 为第三方），
> 存在发布阻断 + 依赖混淆风险，全部包已从 `@dlab/*` 重命名为 `@dsh-lab/*`（npm 组织名 `dsh-lab` 未注册，可创建）。
> 映射：`@dlab/lab-host → @dsh-lab/host`、`@dlab/lab-client → @dsh-lab/client`、`@dlab/preset-lab → @dsh-lab/preset`、
> 其余 `@dlab/X → @dsh-lab/X`；RPC 通道 `/dlab → /dsh-lab`。仓库目录名（packages/lab-host 等）与本地路径不变。

按 **three-roles** + `seams.md` 服务归属规则，插件拆分为 9 个内部包 / 仓库根 layout。设计原则：服务归属判断以 *seams.md* 表为准——「模型提供方/执行者/存储后端」放 host-plane 行，跨 session 共享的东西放 host composition；preset 只贡献会话内的 tool / persona / prompt section。

```text
dlab-plugin/                                  ← 仓库根(pnpm workspace)
├── package.json                              # private root, scripts: build/test/lint
├── pnpm-workspace.yaml                       # 9 个内部包
├── tsconfig.base.json
├── README.md
├── docs/
│   └── DESIGN.md                             # 本文档
├── .gitignore
├── .dsh/skills/                              # 项目级 skills
│   ├── dsh-plugin-dev/                       # DSH 插件开发参考
│   └── dsh-scholar/                          # 测试沙地说明(指向 /home2/.../dsh-scholar/)
├── packages/
│   ├── shared/                               # 仅类型 + ULID + 错误基类 + zod schema, 无 DSH 依赖
│   │   ├── package.json
│   │   └── src/
│   │       ├── ids.ts                        # ULID 生成、Solution/Run id 校验
│   │       ├── errors.ts                     # LabError 基类 + 子类
│   │       ├── paths.ts                      # slug/path 校验, 防止 ../ 越界
│   │       └── types.ts                      # SolutionStatus、RunStatus、ExperimentRun、Solution 等纯领域类型
│   │
│   ├── core/                                 # 业务用例编排;不依赖 DSH
│   │   ├── package.json
│   │   └── src/
│   │       ├── solution-service.ts           # init/fork/checkpoint/archive/restore/diff/merge
│   │       ├── run-service.ts                # snapshot/start/stop/compare
│   │       ├── reconcile.ts                  # 启动时校对 Git / FS / SQLite / DSH Workspace
│   │       ├── events.ts                     # core 内部事件 (非 Cordis 事件)
│   │       └── ports.ts                      # 抽象端口:GitPort、StorePort、RunnerPort、SchedulerPort、WorkspacePort(DSH)
│   │
│   ├── git/                                  # 唯一允许执行 `git ...` 的位置
│   │   ├── package.json
│   │   └── src/
│   │       └── git-port.ts                   # GitPort 的本机实现:execFile('git', ...)
│   │
│   ├── store/                                # SQLite 持久化
│   │   ├── package.json
│   │   └── src/
│   │       ├── schema.sql                    # 完整 DDL
│   │       ├── migrations.ts                 # 启动期 idempotent migration
│   │       ├── sqlite-store.ts               # StorePort 实现, 含 schema cache
│   │       └── repository/                   # projects/solutions/runs/metrics/tags/profiles/env/reservations/events
│   │
│   ├── runner/                               # 进程管理
│   │   ├── package.json
│   │   └── src/
│   │       ├── local-runner.ts               # RunnerPort 的本机实现:ctx.subprocess 包装
│   │       ├── log-tee.ts                    # stdout/stderr → 文件 + tail buffer
│   │       └── reconcile.ts                  # 启动时 PID 存活探测
│   │
│   ├── scheduler/                            # GPU 资源调度
│   │   ├── package.json
│   │   └── src/
│   │       ├── nvidia-smi.ts                 # 解析 `nvidia-smi --query-gpu=...`
│   │       ├── gpu-scheduler.ts              # SchedulerPort 实现:queue + reservation
│   │       └── reconcile.ts                  # reservation 表 reconcile
│   │
│   ├── lab-host/                             # ★ DSH Host composition bundle
│   │   ├── package.json                      # dsh.bundle → ./cordis.patch.yml
│   │   ├── cordis.patch.yml                  # 全部 host-plane 行
│   │   └── src/
│   │       ├── lab-service.ts                # ctx.lab (Service 子类)
│   │       ├── rpc.ts                        # /dlab channel dispatch
│   │       ├── tools/                        # lab_* Model Tools
│   │       │   ├── lab-status.ts
│   │       │   ├── lab-solutions.ts
│   │       │   ├── lab-runs.ts
│   │       │   └── lab-resources.ts
│   │       ├── system-prompt.ts              # systemPrompt.section() 注册 Lab Context
│   │       └── shell-env.ts                  # shellEnv.register(DSH_LAB_*)
│   │
│   ├── lab-client/                           # ★ DSH Client composition bundle
│   │   ├── package.json                      # dsh.bundle (client row)
│   │   ├── cordis.patch.yml                  # dsh.client 行
│   │   └── src/
│   │       ├── client.ts                     # dsh.client.inject apply()
│   │       ├── lab-model.ts                  # ClientLabModel (snapshot + subscribe)
│   │       └── ui/                           # 浏览器半 React 组件,slots.register
│   │           ├── lab-button.tsx            # 注册到 conversation.session.header.actions
│   │           ├── lab-panel.tsx             # 主面板,内容组件通过 slots.inject 注入
│   │           └── tabs/                     # Solutions / Experiments / Compare / Resources / Environment
│   │
│   ├── cli/                                  # ★ dsh-lab CLI 单独 npm package, 不依赖 DSH
│   │   ├── package.json
│   │   ├── bin/
│   │   │   └── dsh-lab                       # #!/usr/bin/env node → dist/cli.js
│   │   └── src/
│   │       ├── index.ts                      # commander entry
│   │       └── commands/                     # status / solution / run
│   │
│   └── preset-lab/                           # ★ Agent preset bundle — 把 lab_* tools 加到每个 session
│       ├── package.json                      # dsh.bundle (agent preset row)
│       ├── preset.yml                        # name + description
│       ├── agent.cordis.yml                  # 单行 tool-grant,所有 lab_* tool 注册到 ctx.tools
│       └── skills/                           # bundled skills(可选,跟 plugin 一起分发)
│           └── dlab-using/SKILL.md
│
└── tests/
    ├── unit/                                 # core/store/shared 纯单测
    ├── integration/                          # GitService + SQLite 真实 git/fs 操作(用 dsh-scholar 作为 fixture 根)
    ├── e2e/                                  # CLI + LabService 完整闭环
    └── concurrency/                          # 两个 Run 并发、merge 期间 fork 等场景
```

### 5.1 拆分理由（不再做单 bundle）

第 5 节原版「单 bundle」是早期收敛选择的写法，但 9 包拆分已经在工程上明显更稳：

| 拆开的好处                                            | 体现为                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------- |
| **DSH Host plane 与 Core 严格解耦**                    | `core/`、`git/`、`store/`、`runner/`、`scheduler/`、`cli/`、 `shared/` 完全不 import `@deepseek-ai/cordis` 或任何 `@deepseek-ai/dsh-*` |
| **DSH Client plane 与 Host plane 严格解耦**           | `lab-client/` 只被 `dsh web` 加载,`lab-host/` 只被 host 加载       |
| **按 three-roles 角色命名**                            | `core/` = Service Definition 角色;`git/`、`store/`、`runner/`、`scheduler/` = Service Provider 角色;`lab-host/` 与 `lab-client/` = Consumer + Slot 注册 |
| **能并行开发/独立发版**                                | 每个包一个 `package.json`,未来能 npm publish;现阶段用 pnpm workspace |
| **测试金字塔与生产代码一一对应**                      | `tests/{unit,integration,e2e,concurrency}` 与每个 src 包对应       |

### 5.2 服务归属（按 seams.md）

| ctx 键                       | 归属包         | plane     | 说明                                  |
| ---------------------------- | -------------- | --------- | ------------------------------------- |
| `ctx.lab`                    | `lab-host`     | host      | 全 process 唯一实例                   |
| `ctx.labClientRpc`           | `lab-host`     | host      | `/dlab` channel handle                |
| `ctx.labHostConfig`          | `lab-host`     | host      | 配置 + `solutionRoot` 解析            |
| `ctx.workspaceRegistry.create/delete` 的桥接 | `lab-host` | host      | 只 host 调, 不能放 preset              |
| Lab 浏览器半 slots (`sidebar.*` / `shell.overlay` / `conversation.*`) | `lab-client` | client | `dsh.client.inject` 入口, slots.register |
| `systemPrompt.section()` 注册 Lab Context | `lab-host`    | host      | 写到 host 的 prompt 段落；按 assembly 的 agent session cwd 解析对应 lab；用 scope 局部覆盖时由 preset 切 |
| `shellEnv.register(DSH_LAB_*)`           | `lab-host`    | host      | host plane 注册,跨 session 共享；值按每次 shell 调用的 agent session cwd 解析 |
| Agent preset 中的 tool 注册                | `preset-lab`  | agent     | 多个 session 共享 host tools 注册,必须放在 preset realm 之外(preset 仅消费, 不发布服务) |

### 5.3 为什么不把 `core/`/`git/`/`store/` 拆成独立 npm 包

首版选择 **pnpm workspace（仓库内单仓 monorepo）**，因为：

* Phase 1 主要靠 `cli/` 验证生命周期,发版节奏跟着 DSH 走
* `core/` 与 `git/`/`store/` 之间的接口紧（`GitPort` 是 interface,但实现只在 git/ 包内）
* 减少 install / link / version pin 的复杂度

未来若 `core/` 被多个 bundle 复用、或有外部插件想提供自己的 `GitPort` 实现,再把 `core/` 拆成独立 `@dsh-lab/core` npm 包;此时把 `ports.ts` 拆成 `@dsh-lab/ports`。

### 5.4 Phase 1 的最小可验证闭环

首版**必须**先在 CLI 上跑通：

```text
1.  dsh-lab status                  (无 lab state 时给出 init 引导)
2.  dsh-lab init --root /home2/.../dsh-scholar
3.  dsh-lab solution fork main agm-cosine
4.  (在 solutions/agm-cosine/ 改代码)
5.  dsh-lab solution checkpoint agm-cosine -m "AGM cosine schedule"
6.  dsh-lab solution merge agm-cosine --target pgu-cosine --mode into-fork
7.  dsh-lab solution archive agm-cosine
8.  dsh-lab solution restore agm-cosine
9.  dsh-lab environment fingerprint   (打印 env:<hash>)
```

以上跑通且 Scenario A-I 全部通过,才进入 Phase 2。

### 5.5 cordis.patch.yml 写法示例（lab-host）

```yaml
# packages/lab-host/cordis.patch.yml
- insert:
    - id: lab-store
      name: '@dsh-lab/host/store-row'

    - id: lab-storage-domain
      name: '@dsh-lab/host/storage-domain-row'

    - id: lab-git
      name: '@dsh-lab/host/git-row'

    - id: lab-runner
      name: '@dsh-lab/host/runner-row'

    - id: lab-scheduler
      name: '@dsh-lab/host/scheduler-row'

    - id: lab-shell-env
      name: '@dsh-lab/host/shell-env-row'

    - id: lab-system-prompt
      name: '@dsh-lab/host/system-prompt-row'

    - id: lab-tools
      name: '@dsh-lab/host/tools-row'

    - id: lab-rpc
      name: '@dsh-lab/host/rpc-row'
      inject: [connection]

    - id: lab-service
      name: '@dsh-lab/host/lab-service-row'
      inject:
        - workspaceRegistry
        - tools
        - storageDomain
        - sessionPersistence
```

每个 `*-row` 行是同一个 `lab-host/src/index.ts` 导出的不同 config entry,组合时按 id 区分,这样 HMR 时能单独热替换每行。

> **注**：上面第 5 节开头到 5.5 的示例，实际源码已演进为 **pnpm workspace monorepo**（见 §5 树 + README），实现以 `packages/` 下的真实目录为准，本节示例保留用于说明 cordis.yml 行内按 `role` 区分的单模块多行写法。

### 5.6 DSH 服务/工具/Slot 的实际接线摘要

| 接线点 | lab-host | lab-client | preset-lab | 备注 |
| ------ | -------- | ---------- | ---------- | ----- |
| `ctx.lab` Service | `LabService extends Service` | — | — | host 唯一实例 |
| `/dlab` RPC channel | `ctx.connection.rpc.handle('/dlab', dispatch)` | `ctx.connection.rpc.call('/dlab', …)` | — | 信封 `RpcResult<T>` |
| `DSH_LAB_*` env | `ctx.shellEnv.register` | — | — | 每次 shell 调用按 agent session cwd 解析后注入 |
| lab context prompt | `systemPrompt.section()` | — | — | 按 assembly 的 agent session cwd 解析对应 lab |
| `lab_*` tools | 注册（execute 按该调用的 agent session cwd 经 `ctx.lab.surface()` 解析） | — | `tool-dlab-lab` 行 grant 到 preset | preset 只放 tool 行 |
| Lab 入口按钮 + 面板 | — | slots.register（名以 inspect 为准） | — | `dsh.client` 行 |
| Agent preset | — | — | `agent.cordis.yml` | 不发布服务 → 无需 realm |

> 原则（与 §5.2 服务归属一致）：提供服务的行一律在 host plane（`lab-host`）；preset-plane 只放「消费 host tools 注册」的 tool 行；浏览器半只放 slot 注册。`preset-lab` 不提供任何服务，因此其 tool 行不需要 isolate realm（skill: editing-cordis-compositions）。

### 5.7 Lab 根目录解析（per-session cwd，v0.1.3 起）

所有消费方（`lab_*` 工具、`lab:context` prompt 段、`DSH_LAB_*` shell 变量、浏览器面板 RPC）都通过同一条 `LabService.surface(cwd)` 解析，规则一致：

1. **可选的 `solutionRoot` 配置**仅在会话 cwd 位于其内（或调用方无 cwd，如无 agent 的执行）时生效——部署可以用它钉一个主 lab；
2. 否则从 cwd **向上查找**最近的持有 `.dsh-lab/lab.sqlite` 的目录（`findLabRoot`，上限 15 层），每个检测到的 lab 有自己的 `LabCore`/surface（detected lab 的项目名从其 store 权威读取）；
3. 都没有 → 该会话**无 lab**：`lab_status` 软失败（`initialized:false` + hint），其余工具抛清晰错误，prompt 段退化为两行 no-lab 提示，`DSH_LAB_*` 变量省略。

cwd 的来源：工具执行与 shell 调用取 `exec.agent.session.header.cwd`；prompt assembly 取 `AssembleContext.agent`（dsh-agent 的 runtime 增强）；浏览器面板在 RPC payload 里显式携带。`cordis.patch.yml` 不再写死任何根目录——在哪个项目里打开会话，lab 就跟到哪个项目。

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
          ┌────────┼─────────────┐
          │        │             │
       Archive   Merge to     Merge Fork
          │      Main           to Fork
          │        │             │
          │        ▼             ▼
          │   ┌────────┐    ┌────────┐
          │   │ MERGED │    │ MERGED │
          │   └────┬───┘    └────┬───┘
          │        │             │
          │     Restore       Restore
          │        │             │
          │        └──────┬──────┘
          │               │
          │               ▼
          │          ┌────────┐
          │          │ ACTIVE │（保留 worktree，可继续迭代）
          │          └────────┘
          │
          ▼
    ┌──────────┐
    │ ARCHIVED │
    └────┬─────┘
         │
      Restore
         │
         └────────► ACTIVE ◄────（同上）
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

## 12.1 Merge Fork → Fork（合并两个实验方案）

合并不仅限于「实验方案 → main」。两个实验方案经常需要互相合入（例如 `agm-cosine` 想吸收 `pgu-cosine` 的改动做组合实验），或者一个方案想合入另一个方案作为其下一步迭代的基线。

支持三种模式：

### 12.1.1 Merge mode = `into-target`

把 source 方案的全部提交合入 target 方案的 branch。target 方案的 worktree 保留并刷新，source 方案标记为 merged 并被默认 archive。

```text
Merge A → B
─────────────────────────
mergeBase  = git merge-base A B
result     = git merge --no-ff B A  （在 B 的 worktree 里执行）

B.head_commit  = merge commit
B.worktree     = 保留（worktree 路径下执行 merge）
A.status       = merged
A.mergedIntoSolutionId = B.id
A.mergeCommit  = merge commit
A.worktree     = 默认 archive
```

使用场景：B 想吸收 A 的修改作为后续迭代起点。

### 12.1.2 Merge mode = `into-fork`（推荐默认）

把 source 方案的 commit 历史移植到 target 方案 branch 上，**保留 source 的所有 commit 与作者**。语义等价于「把 source branch 当成 target 的一个 topic branch」。这是实验方案互相合入最常见的诉求。

实现：

```text
Merge A → B (into-fork)
─────────────────────────
mergeBase  = git merge-base A B
result     = git merge --no-ff B A   （在 B 的 worktree 里执行；B 是 target）

B.head_commit = merge commit
A 保持 active；B 上现在带有 A 的所有 commit（通过 merge commit）
```

**A 不变成 merged 状态**——它的所有 commit 现在存在于 B 的历史中，但 A 自己的 branch 仍然可以继续修改、跑 Run、再合入 main。这是「继续 fork 多方向」的常见需求。

### 12.1.3 Merge mode = `consolidate`

把 source 方案的 commit 历史 squash 后合入 target。**仅当用户明确选择**才提供，因为会丢失 source 的逐 commit 信息：

```text
git merge --squash A
git commit -m "[dsh-lab] consolidate <source-slug> into <target-slug>"
```

不推荐默认使用；UI 显式勾选 `Squash commits` 才走这条路径。

### 12.1.4 输入

```ts
interface MergeSolutionInput {
  sourceSolutionId: string;                // 必填；A
  targetSolutionId: string;                // 必填；B；不能等于 source
  mode: 'into-target' | 'into-fork' | 'consolidate';
  message?: string;
  archiveSource?: boolean;                 // 仅 into-target / consolidate 默认 true；into-fork 默认 false
}
```

`LabService.solutions.merge(input)` 的语义：

* `into-target`：source 标记为 merged；默认 archive source workspace。
* `into-fork`：source 保持 active（branch + worktree + DSH Workspace 都在），但其 HEAD 之上多了一次合入；source 不再「孤立」，其 commit 历史已嵌入 target branch。
* `consolidate`：source 标记为 merged；squash 后只留下一个 commit 在 target。

### 12.1.5 双向合并与 cross-branch conflicts

实验方案互相合入容易出冲突。preflight 必须执行：

```bash
git merge-tree --write-tree B A
```

* 若预计冲突：UI 显示 `Merge conflicts detected` 列表；提供「Open Merge Workspace」让用户在 source worktree 里手动解决，再回来点「Resume Merge」。
* 禁止自动 commit 出 conflict 状态让用户事后才发现。

### 12.1.6 与「merge into main」的关系

* 「Merge to Main」是 `into-target` 的特化：`target = main, archiveSource = true`。
* 「Merge Fork → Fork」是 `into-target` / `into-fork` / `consolidate` 的三种模式，目标不是 main。
* 同一份 `mergeSolutions(input)` API 处理所有情形；UI 上拆成两种入口「Merge to Main」与「Merge to Another Fork」。

### 12.1.7 CLI / Tool 改动

CLI：

```bash
dsh-lab solution merge <source-slug> --target <target-slug> [--mode into-fork] [--no-archive] [--message ...]
```

Tool：

```ts
ctx.tools.register(defineTool({
  name: 'lab_merge_solution',
  // 与 mergeToMain 复用同一工具；通过 targetSolutionId 是否 = "main" 区分
  parameters: {
    sourceSolutionId: { type: 'string', required: true },
    targetSolutionId: { type: 'string', required: true },
    mode: { type: 'string', enum: ['into-target', 'into-fork', 'consolidate'], default: 'into-fork' },
    archiveSource: { type: 'boolean', default: undefined },
    message: { type: 'string' },
  },
}))
```

UI：Solution Detail 页面增加「Merge into…」按钮，弹出 Solution 选择器，默认 mode `into-fork`。

### 12.1.8 状态机修正

合并 fork → fork 不应总是把 source 推到 merged/archived。新增不变式：

* `into-target` 且 `archiveSource=true`：source 走 merged → 可选 archived。
* `into-target` 且 `archiveSource=false`：source 走 merged 但保留 worktree 与 branch。
* `into-fork`：source 保持 active；target.head_commit 更新。
* `consolidate`：source 走 merged；默认 archive。

`merged_into_solution_id` 表达合并方向；`merge_commit` 记录这次合入产生的提交。

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

### 18.1 Run 即 DSH 后台任务（v0.1.4 起）

Run 完成必须能**唤醒 agent**，而不是让 agent 轮询 `lab_list_runs`。做法是把每次
`lab_start_run` 注册进 DSH 通用任务注册表 `ctx.jobs`（与 `bash run_in_background`
同一个）：

```ts
jobs.start({
  kind: 'lab-run',                 // id 形如 lab-run-3
  label: `${run.id} · ${title} · ${command}`,
  owner: exec.agent,               // 由调用 agent 拥有 —— 唤醒的关键
  outputLimitBytes: 12 * 1024,
  run: () => ({
    cancel: () => { killProcess(); stop(); },   // 必须同步发起 SIGTERM
    done,                                        // run 进程退出并 finalize 后 settle
    readOutput: () => stdoutDelta(),             // 流式 stdout 游标
  }),
})
```

契约要点：

* **owner 决定投递**：`dsh-tool-jobs` 注册的完成监听器按 owner 投递通知 —— idle 的
  属主会话被 `followup` 唤醒（消耗一次 wake 预算），否则 `inject` 一条 notice。
  没有 owner（RPC/CLI 调用）则不注册，行为与今天一致。
* **`jobs.start` 前置检查 controller**：若挂载的 preset 没有 `tool-jobs`，注册会抛
  "no job controller serves this agent"；桥接层吞掉异常并返回 undefined，run 照常执行，
  只丢失唤醒能力。
* **`done` 必须是最终状态**：`RunService.onRunExit` 在 `finalize()` **之后**触发，桥接
  再去读 run 记录，因此 completed/killed/failed 与面板一致。
* **`cancel` 必须同步**：jobs 契约要求 `cancel()` 同步发出终止；`LocalRunner.stop()`
  在首个 await 之前就对进程组发 SIGTERM，随后 `stop()` 做状态/GPU/worktree 收尾。
* **属主销毁即取消**：agent 被 dispose 时注册表会 cancel 其 owned job —— 会话销毁会停掉
  它启动的训练，与后台 bash 语义一致。
* **进程内生命周期**：注册表记录与 runner 的 live map 一样是进程内的；宿主重启后 adopt
  的 run 不被观察，仍由 `.exit_code` 驱动的跨进程 finalize 收尾。

被唤醒之外的读取路径同样复用通用工具：`job_output <lab-run-N>` 流式读 run 的
`stdout.log`，`job_kill` 与 `lab_stop_run` 等价。实现见
`packages/lab-host/src/run-jobs.ts`，另有 `runs.log` RPC 端点供面板读尾部日志。

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
    merge(input: MergeSolutionInput): MergeResult       // 统一入口：target=main 表示 merge-to-main
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
dsh-lab solution merge <source-slug> --target <target-slug> [--mode into-fork|into-target|consolidate] [--no-archive] [--message ...]
dsh-lab run start <slug> [--profile <id>] [--title ...] [--tag ...]
dsh-lab run list
dsh-lab run stop <run-id>
```

CLI 直接调 `core/`。在 CLI 验证完 `Init → Fork → Modify → Archive → Restore → Merge (任意两个 Solution) → Run` 闭环之前，不要做大规模 UI。

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

### 26.1 浏览器半与 dsh-better-sidebar 的兼容（Phase 4 落地）

lab-client 与 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 双模兼容——**有它则集成、无它则自立**，且它永远不是硬依赖：

| 场景 | 行为 |
| ---- | ---- |
| better-sidebar **已安装** | `ctx.inject(['betterSidebar'], …)` 子插件调用 `ctx.betterSidebar.registerTab({id:'dlab:lab', single:true, …})` 把 Lab 面板注册进右侧栏；服务消失（HMR/卸载）时注册随 fiber 自动撤销 |
| better-sidebar **未安装** | 会话头部的「🧪 DLab」按钮（`conversation.session.header.actions` slot，常驻注册）打开一个 fixed 浮层面板 |
| 两者**同时**可用 | 头部按钮优先调用 `betterSidebar.openTab({type:'dlab:lab'})` 打开侧边栏 tab（浮层不出现） |

实现要点：

* better-sidebar **不进** `dsh.client.inject`（那是硬依赖列表，缺席会导致 bundle 永不加载）；tab 注册走 `ctx.inject(['betterSidebar'], cb)` 子插件——服务出现即激活、消失即 dispose，天然 HMR 安全。
* bundle 为手写的 `window.__ModuleLoader__.load({id, factory})` 格式（与 better-sidebar 的 tsdown 产物同构），`require('react')`/`require('react-dom')` 由模块系统提供，无打包器参与；宿主半是 no-op 行，仅为让 client-modules 扫描器发现包的 `dsh.client` 声明。
* `dsh.client.inject = ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-conversation']`——connection 提供 `/dlab` RPC 通道，后两者提供 slots 服务与 header.actions 槽位树。
* 面板单组件 `LabPanel` 双模共用；数据全部经 `/dlab` RPC（5s 轮询 + 操作后刷新）；未初始化的 lab 显示 Initialize 按钮（`project.init` 端点）。
* 样式只继承 currentColor/透明度，不硬编码主题色，适配亮暗主题。

---

## 27. MVP 开发优先级

### Phase 1 — Core + CLI（**先做，先稳定**）

```text
domain types
SQLite schema + migrations
GitService (fork/checkpoint/worktree add-remove/branch/diff/merge)
SolutionService
init / fork / checkpoint / archive / restore / diff / merge
  merge: 同一 API 接受 target=main（merge-to-main）与 target=其他 solution（merge-fork-to-fork）
  mode: into-target | into-fork | consolidate
  preflight: git merge-tree 探测冲突
reconcile (启动时校对 Git/FS/DB)
CLI：dsh-lab status/solution/run
Git integration tests + crash tests + concurrency tests
```

**Phase 1 必须**包含针对 fork → fork merge 的专项测试：

* 两个 fork 都从 main 分出，互不相关 → merge 干净（no conflict）
* 两个 fork 修改同一文件同一区域 → merge-tree 报告冲突 → UI/CLI 抛错，不写半成品
* into-fork 后 source 仍能继续 commit + 跑 Run
* consolidate 后 source 的 commit 历史 squash 后只剩 1 个 commit
* merge 进行中 DSH 崩溃 → 启动 reconcile 探到 orphan merge state → 报 broken

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
| G    | Merge `agm-cosine` → `pgu-cosine`（into-fork）    | `pgu-cosine` HEAD 上多一个 no-ff merge commit；`agm-cosine` 保持 active；两条 branch 都在；都能继续 run |
| H    | Merge 两个 fork 修改同一文件同一行（into-target）  | preflight 报 conflict；DB 状态不写半成品；提示用户去 Open Merge Workspace         |
| I    | Merge `agm-cosine` → `pgu-cosine`（consolidate）  | `pgu-cosine` 上多一个 squash commit；`agm-cosine` 标记 merged；`agm-cosine` branch 保留但默认 archive |

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
5. 实现 GitService（src/git/git-service.ts），封装所有 git 命令，包括 merge-tree preflight 与 no-ff merge。
6. 实现 SolutionService（src/core/solution-service.ts）覆盖 init/fork/checkpoint/archive/restore/diff/merge。
   - merge 统一入口：mergeToMain 与 mergeForkToFork 共享同一个底层 mergeSolutions(input: MergeSolutionInput)。
   - mode = into-target | into-fork | consolidate；archiveSource 控制 source 后续动作。
7. 实现 reconcile：启动时对比 git worktree list / branch / DB；orphan merge state 标 broken。
8. 写 Git integration tests + crash tests + concurrency tests；
   必须覆盖 Scenario G/H/I（fork → fork merge、conflict、consolidate）。
9. 实现 CLI（src/cli/dsh-lab.ts）—— 验证 Init → Fork → Modify → Archive → Restore → Merge (含 fork → fork) → Run 闭环。
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