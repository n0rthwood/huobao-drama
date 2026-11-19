# Astra 调用留痕（阶段 0 设计）

模型：`gpt-6-astra`（`omp -p --model gpt-6-astra --mode text --no-session`，`--max-time 25–40m`，均为一次性、无会话调用）。
执行目录：`/tmp/astra126`（临时工作区）；结果复制为本目录文件。所有 prompt 与原始响应逐字保留。

| 轮次 | 目的 | prompt | 原始响应 | 墙钟 | 响应字节 | 状态 |
|---|---|---|---|---|---:|---|
| R1 | 信息架构、结果优先主界面、成图快照、AI 活动抽屉、主动作矩阵、一键检索契约、深链、组件分解、文案 | `r1.md` | `r1.response.md` | 352.4s | 56,032 | 正常 |
| R2 | 工作流停靠状态表（阶段 × 运行状态 × manual/guided/auto）、三个停靠点、完成编辑 vs 确认几何、失效矩阵、CAS、V5 订正、刷新并发 | `r2.md` | `r2.response.md` | 315.6s | 47,972 | 正常 |
| R3 | 点线面编辑器详设：TAB、zoom/pan 三级坐标、删点、点列表弹窗、地点完整编辑、条目完成按钮、平滑警告、数据集徽标、键盘、组件分解 | `r3.md` | `r3.response.md` | 262.5s | 37,654 | 正常 |
| R4 | 历史兼容三政策、纸纹迁移、底图缓存、主题简化、图层描述契约、范围与写权限、V1–V34 验收映射 | `r4.md` | `r4.response.md` | 382.5s | 46,243 | **开头损坏**（缺 §1 章标题与 §1.1），其余完整 |
| R5A | 补写 R4 被截断的 §1 章标题 + §1.1「新任务政策（V6）」 | `r5a.md` | `r5a.response.md` | 35.1s | 4,098 | 正常（已拼入 `04`） |
| R5B | 自检 R1/R2 文档：V1–V5、V13–V16、V32–V34 覆盖判定、跨文档矛盾、guided 契约收敛 | `r5b.md` | `r5b.response.md` | 217.2s | 30,640 | 正常（C2/C3/C4/C5–C12 已应用） |
| R5C | 自检 R3/R4 文档：V11/V12/V17–V27 覆盖判定、TAB/尺寸/字段口径矛盾、事实错误、映射补正 | `r5c.md` | `r5c.response.md` | 185.8s | 19,888 | 正常（B1–B4、C1–C7、E 已应用） |

共 7 次 Astra 调用；R5B 与 R5C 与 R5A 并发执行。

## 命令

```bash
export PATH="$HOME/.local/bin:$PATH"
cd /tmp/astra126
omp -p @r1.md @facts.md --model gpt-6-astra --mode text --no-session --max-time 30m > r1.response.md
omp -p @r2.md @facts.md --model gpt-6-astra --mode text --no-session --max-time 35m > r2.response.md
omp -p @r3.md @facts.md --model gpt-6-astra --mode text --no-session --max-time 35m > r3.response.md
omp -p @r4.md @facts.md --model gpt-6-astra --mode text --no-session --max-time 35m > r4.response.md
omp -p @r5a.md @facts.md @r4.head-context.md --model gpt-6-astra --mode text --no-session --max-time 25m > r5a.response.md
omp -p @r5b.md @facts.md @01-information-architecture.md @02-workflow-state-table.md \
    --model gpt-6-astra --mode text --no-session --max-time 40m > r5b.response.md
omp -p @r5c.md @facts.md @03-geo-editor.md @04-history-cache-integration.md \
    --model gpt-6-astra --mode text --no-session --max-time 40m > r5c.response.md
```

`facts.md` 是各轮共享的事实底座（Issue #126 用户目标、v2 条款 V1–V34 编号、仓库前端/服务端 file:line
证据、结构性张力）。它同时被保留在此目录，便于核对哪些事实进入了设计。

## 处理说明

- 响应第 1–2 行为 omp CLI 提示（`Note: plan.defaultOnStartup ...` / `Working...`），拼入文档时删除。
- R4 原始响应开头损坏（从 §1.2 表格中间开始）；用 R5A 重写的 §1 + §1.1 替换，再把 R4 的 §1.2 起原样
  接续，得到 `04` 的正文（`/tmp/astra126/r4.fixed.md` → `04-history-cache-integration.md`）。
- R5B/R5C 的建议以替换文本形式给出，应用时逐条落到 01–04 对应小节；未改写设计结论，只执行收敛与
  事实修正。应用清单见 `05-acceptance-mapping.md` 第 0 节与各文档头部注记。
- `facts.md` 中标注「已核实」的条目均给出 `file:line`；设计文档凡引用事实处保持同一口径。

## r2 修订调用（Fabel M1–M16，R6–R12）

设计主体仍为 Astra，首选模型始终 `gpt-6-astra`，**未回退模型、未另做一次 Fabel 评审**。
组织者仅提供主 agent 裁定、读源码补证并机械应用 Astra 小节。执行目录 `/tmp/astra126b`；
正文见 README、01–05，M1–M16 逐条闭合索引见 05 §5。事实补证见 `facts.md` §6–8。

|轮次|目的|prompt|原始响应|工具记录墙钟|响应留痕字节|结果|
|---|---|---|---|---:|---:|---|
|R6|README/01 首轮修订：布局、默认停靠、交付及快照生命周期|`r6.md` + `r2-shared.md`|`r6.response.md`|451.00s|72,488|正常，exit=0；stderr另存 `r6.stderr.txt`|
|R7|02 全状态组合、唯一CAS、失败修复与真实complete交付|`r7.md` + `r2-shared.md`|`r7.response.md`|429.22s|69,774|正常；PATH准备失败的一次命令未触达模型，另见 `r7.setup-error.txt`|
|R8|03 大编辑区、单草稿、完整输入设备路径、坐标oracle和版本深链|`r8.md` + `r2-shared.md`|`r8.response.md`|320.59s|50,314|正常|
|R9|04/05 历史/缓存/迁移、V/G映射与M闭合表|`r9.md` + `r2-shared.md`|`r9.response.md`|447.42s|70,841|正常|
|R10|README/01 最终合同收敛，消除能力发现与隐式交付分支矛盾|`r10.md` + `r2-shared.md`|`r10.response.md`|547.75s|99,396|正常|
|R11|02–05 接入#125最终字段事实，冻结缺口、宿主只读投影和几何hash深链|`r11.md` + `r2-shared.md`|`r11.response.md`|528.73s|88,668|正常|
|R12|跨文档最后对齐：state pinned载荷、计数、draft/final时限、生产样本与M表索引|`r12.md`|`r12.response.md`|339.39s|47,111|正常|

初稿7次 + r2的7次 = **14次模型调用**。R7 的 command-not-found 是环境准备错误，不算模型调用；
补齐 PATH 后仍使用首选 Astra。调用完成不等于设计通过外部评审，更不等于行为验收。

### 精确命令与输入快照

每条命令均先 `export PATH="$HOME/.local/bin:$PATH"`。R6 实际 `--max-time 40m`（实际451s内结束）；
R7–R12 均 `--max-time 30m`。下列 `facts.md` 指当时工作目录输入，存档为 `r2-facts-initial.md`，
不是随后继续增补的当前事实文件；R10和R11/R12的事实输入另分别存档为 `facts-latest.md`、`facts-final.md`。

```bash
omp -p @r6.md @r2-shared.md @facts.md @README.md @01-information-architecture.md --model gpt-6-astra --mode text --no-session --max-time 40m
omp -p @r7.md @r2-shared.md @facts.md @02-workflow-state-table.md --model gpt-6-astra --mode text --no-session --max-time 30m
omp -p @r8.md @r2-shared.md @facts.md @03-geo-editor.md --model gpt-6-astra --mode text --no-session --max-time 30m
omp -p @r9.md @r2-shared.md @facts.md @04-history-cache-integration.md @05-acceptance-mapping.md --model gpt-6-astra --mode text --no-session --max-time 30m
omp -p @r10.md @r2-shared.md @facts-latest.md @README.md @01-information-architecture.md --model gpt-6-astra --mode text --no-session --max-time 30m
omp -p @r11.md @r2-shared.md @facts-final.md @02-workflow-state-table.md @03-geo-editor.md @04-history-cache-integration.md @05-acceptance-mapping.md --model gpt-6-astra --mode text --no-session --max-time 30m
omp -p @r12.md @facts-final.md @README.md @01-information-architecture.md @04-history-cache-integration.md @05-acceptance-mapping.md --model gpt-6-astra --mode text --no-session --max-time 30m
```

R6–R9 输入为初稿；R10输入已应用R6的README/01；R11输入已应用R7/R8/R9的02–05；
R12输入已应用R10/R11的README/01/04/05。提示词保留权威约束、核实事实与当时的冲突说明。

### 应用与闭合记录

- R6、R7、R8、R9、R10、R11：按 START/END 标题锚点机械替换（END标题不包含在替换内）。
- R12 输出未包含请求的 `<<<REPLACE` 开头，并将 END 用作末行而非下一节标题；组织者逐块确认唯一锚点，
  按其实际格式**包含END行**替换。R12 的05旧header锚点因组织者已经更新调用来源而未命中，仅跳过这块
  元数据；其余设计正文均使用 Astra 原文，不由组织者代写主体。
- 组织者更新各文件头部的来源轮次、基线/评审引用和14次调用计数；这些为留痕元数据，不是另起设计。
- 主 agent 三项裁定已落地：默认UI/guided人工停靠；页面唯一CAS保存；阶段驱动编辑/成图最大空间。
- 重要纠错：已有底图成品缓存；complete会交付；首次平滑可保存；已有图层的平滑保存会重渲交付；
  #125已合入master但本分支未包含、manual/name_manual是独立所有权、版本params尚未冻结最终描述；
  真实文件交集不能再说“不相交”。完整证据均在 `facts.md` §6–8。
- 05 §5逐条列M1–M16落点、证据、剩余阻断；G1–G9不因本文修订而宣称实施闭合。
- 本轮**未跑build/lint/tests/formatter，未做Huobao API或媒体验收，未做发布/重启/全局配置变更**。
  所有E01–E18为待实施验收要求；没有新增人类批准。

外部读取请求台账见 `r2-request-ledger.md`，完整评论与正文见 `r2-issue-comments.txt`、`r2-issue-body.json`；
Fabel设计评审原文另见 `r2-fabel-review.md`。不保存凭据或鉴权头。
