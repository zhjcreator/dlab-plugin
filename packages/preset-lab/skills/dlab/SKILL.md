---
name: dlab
description: 在 Deep Learning Lab（dlab）项目里做深度学习实验的标准用法：发起训练（lab_start_run）、GPU 分配与排队、等待批次唤醒、检查/对比 run、checkpoint 与合并、参数扫描、文档纪律。当会话位于含 .dsh-lab/ 的项目、需要跑训练/实验、提交 lab_* 工具调用、或遇到 GPU 排队/预约/卡选择问题时触发。 The standard for running experiments in a Deep Learning Lab project — launching training runs, GPU allocation and queueing, batch wake, inspecting and diffing runs, checkpoints and merges, sweeps, and docs discipline.
metadata:
  author: dlab-plugin
  version: "0.2.2"
---

# dlab 实验工作标准

## 心智模型

一个 lab 项目 = **solutions**（每个是一份 git worktree：`main` 是基线，实验从它 fork）+
**experiments**（run 记录，不可变快照 + 产出目录）+ **共享文档**（项目根 `docs/`，所有
solution 通过 `docs/` 链接共享一份）。

## 发起训练（最重要的一节）

```
lab_start_run(solution, command, gpuCount)
```

- **命令必须 card-agnostic**：命令/脚本里绝不赋值 `CUDA_VISIBLE_DEVICES`（提交会被拒；
  仅在日志/诊断/grep 里**提及**变量名没问题）。dlab 负责选卡并注入该变量。
- **选卡三档**：`gpuCount: N`（任意 N 张空卡，默认选择）；`gpuIds: [3]`（钉死指定卡，
  忙则排队等它们）；`minFreeVramMB`（卡上最低空闲显存门槛）。
- **满卡即排队**：`status: 'queued'`，FIFO + first-fit，卡一空自动提升——**不需要也不应该**
  重试或轮询；一次把整批任务全部提交。
- **提交即快照**：排队等卡期间改代码不影响该 run（跑的是提交那一刻的树）；要改就停掉重提。
- **多进程启动器**（torchrun 等）配 `gpuCount: N`：进程内卡重编号为 0..N-1，worker 无感。
- **结果字段**：`dshJobId`（`job_output` 流式读该 run 的 stdout，`job_kill` 停它）；
  `batchJobId`（`job_output` 交错读全部活跃 run）。
- **一次唤醒**：本会话所有 lab run（含排队的）全部结算后才唤醒**一次**，附全部结果汇总。
  等待期间不要 `lab_list_runs` 轮询；停止最后一个活跃 run 也会结算批次并唤醒。
- 排队中的 run：`job_output(dshJobId)` 首次读返回一行排队状态；`lab_stop_run` 直接取消。

## 实验迭代循环

1. 在**自己的** solution worktree 里改代码（`solutions/<slug>/`）——绝不直接改别的 solution。
2. `lab_start_run` 发起（见上）。被唤醒后：
3. `lab_get_run` 看终态与指标；`lab_run_diff` 对比两个 run 的快照差（扫描调参的核心工具）。
4. `lab_checkpoint_solution` 记录有效进展；`lab_merge_solution` 合回 main——
   **门禁**：没有成功 run 的分支不许合（`allowUnevidenced` 是刻意的显式豁免）。
5. 假设变了才 fork 新 solution；只是调参就在同一 solution 上继续（见扫描约定）。

## 参数扫描约定

同一 solution 上为每个变体各发一个 run：共享一个 `sweep/<name>` tag + 每 run 一个
`<param>=<value>` tag（如 `lr=0.01`）。**不要**为每个变体 checkpoint——每个 run 的快照
已含其配置；只 checkpoint 赢家。`lab_run_diff` 直接给出两 run 的配置差。

## 产出落盘

进程内环境变量 `DSH_LAB_RUN_DIR` 指向 `experiments/run-NNNNNN/`：日志写 `logs/`，
指标写 `metrics/summary.json`（`{"auc": 0.93}` 或 `{"f1": {"value": 0.88, "dataset": "x",
"split": "test"}}`，run 结束自动入库，`lab_get_run` / 面板可见）。

## 文档纪律

公共知识（章程、路线图、基线引用、跨实验经验）只写在项目根 `docs/`（每个 solution 里
的 `docs/` 是同一个目录的链接，不是拷贝）。实验内笔记留在 solution，结论用
`lab_promote_docs` 提升进公共区（archive 时自动提升）。

## GPU 资源与排查

- `lab_get_resources`：每卡空闲显存 + 挂着的 run + **等待队列**（按序）。
  已提交未起显存的卡也计为占用（卡从提交持有到结束）。
- run 显示 `lost`：宿主重启等导致跨进程收尾，`.exit_code` 驱动，读一次即自愈。
- 提交被拒 "ASSIGNS CUDA_VISIBLE_DEVICES"：命令里真赋值了该变量——去掉，改传
  gpuCount/gpuIds。
- "not enough free GPUs"：请求在该机器上永不可能（卡数超机器/gpuIds 不存在），立即失败；
  单纯满卡是排队而不是报错。

## CLI 旁路（无 agent 会话时）

`dsh-lab --root <项目根> status | run start -c <argv...> --gpu-count N | solution checkpoint <slug>`
——与 agent 工具同一套 core；排队/预约/释放语义完全一致。
