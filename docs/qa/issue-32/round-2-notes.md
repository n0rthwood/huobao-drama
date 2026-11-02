# Issue #32 质量闭环 — 第 2 轮（提取不收敛的定位 + α/β 评分）

环境同第 1 轮（worktree `/home/joysort/projects/huobao-drama-issue-32`，后端 `:5722`，前端 `:3056`，
`SQLITE_PATH` 指向本 worktree 的副本；`data/static` 是 live 的**真实副本**，不是符号链接）。

## 0. 浏览器 QA 的真正障碍（第 1 轮记为「首屏空白」）

前端构建期常量 `HUOBAO_BASE_PATH` 默认 `/huobao/`（`frontend/nuxt.config.ts:7`），
`apiBase()` 因此是 `/huobao/api/v1`（`frontend/app/utils/url.ts:17`），
而 vite dev 的代理键只有 `/api` 与 `/static`（`nuxt.config.ts:55-58`）——`/huobao/api/...` 不匹配任何代理规则，
请求落到 nuxt 自己身上返回 SPA HTML，页面因此是空的。

隔离 worktree 的启动命令必须加 `HUOBAO_BASE_PATH=/`：

```
cd frontend && env -u PORT HUOBAO_BASE_PATH=/ HUOBAO_DEV_PORT=3056 \
  HUOBAO_DEV_BACKEND=http://localhost:5722 npx nuxt dev
```

实测：`curl -s -o /dev/null -w '%{http_code}' http://localhost:3056/api/v1/dramas/3` → `200`，
页面正常渲染（截图见 `shots/`）。

## 1. 「提取不收敛」的定位 — 不是代码缺陷

用 `backend/diag-extract.mts`（临时脚本，交付前删除）直接驱动 `extractor`，逐步打印
`finishReason` / `usage` / 工具调用（技能 `huobao-worktree-isolated-qa` 的 runAgent 诊断配方）。
整集角色提取，`maxSteps=20`，`AI_MAX_TOKENS=131072`：

| step | 秒 | finishReason | 工具 | 输出 tokens（含推理） |
| --- | --- | --- | --- | --- |
| 1 | 7 | tool-calls | readScriptForExtraction, readExistingCharacters | 97（推理 71） |
| 2 | 129 | tool-calls | wiki_search × 11 | 7 293（推理 6 731） |
| 3 | 160 | tool-calls | wiki_summary × 8, wiki_extract × 1 | 1 000（推理 579） |
| 4 | 367 | tool-calls | **saveDedupCharacters** | 14 750（推理 11 068） |
| 5 | 382 | stop | — | 738 |

结果：`finishReason=stop`，`created=14 merged=0`，总计 168 008 tokens（cacheRead 113 728），
**全程没有一次 `finish=length`，保存工具在第 4 步被调用**。

结论：
1. 带 addendum 的提取**会收敛**，单类资产约 **6.4 分钟 / 17 万 tokens**（基线短剧无 addendum 时 ~70 秒、
   `reasoning_chars` 3k–7k）。贵，但不是死循环。
2. 第 1 轮观察到的「95 974 reasoning_chars 仍不产出」是**同一现象的中段快照**：`reasoning_chars`
   是整次运行的累计量，第 4 步那一次 11k 推理 token 的长保存调用正好落在观察窗口里。
   任务 549 的推理落盘文件 `data/text-tasks/549.reasoning.txt`（133 KB）末尾正是
   「逐个角色定稿、准备保存」的内容——被中途放弃，而不是卡死。
3. 真正放大问题的是**并发**：第 1 轮一次性起了 characters/scenes/props 三个提取任务
   （sys_task 546/547/548 同一秒启动），而维基工具是**全进程单队列、最小间隔 1.1 s**
   （`config/research.ts` `RESEARCH_MIN_INTERVAL_MS`），每个运行各自还有 24 次预算
   → 三倍调用量串行排队，三个任务一起被拖慢。隔离闭环里按类型**串行**跑提取。

### 据此做的规则级修正（已落库，不改单条产出）

- `RESEARCH_MAX_CALLS_PER_RUN` 24 → **14**，`RESEARCH_MAX_RESULTS` 8 → **5**，
  `RESEARCH_MAX_TEXT_CHARS` 4000 → **2500**（`backend/src/config/research.ts`）。
- 「怎么查」从技能正文移进**工具描述**（`RESEARCH_PROTOCOL`，`agents/tools/research-tools.ts`）：
  每个对象最多 search 1 次 + summary 1 次，只有要可画细节才追加 extract，
  剧本写清楚的不查，degraded 不重试。模型每一步都看得到工具描述，技能正文只出现一次。
- 字段写法清单进 `save_dedup_characters` 的字段 `describe()`（`agents/tools/extract-tools.ts`）。
- `documentary-extraction/SKILL.md` 从 5 387 → 约 3 200 字符，只留题材硬规则。

**改后复跑**（同一脚本、同一集、每次先把资产行删空）两次，三次运行对比：

| 运行 | 规则 | 检索调用 | 步数 | 秒 | 总 tokens | finishReason | created |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 改前 | 原 addendum，预算 24 | 21（11 search + 9 summary + 1 extract） | 5 | 382 | 168 008 | stop | 14 |
| 改后 1 | 去密度 addendum，预算 14 | 7 | 6 | 418 | 151 193 | stop | 11 |
| 改后 2 | 再加「谁该建卡」条款 | 16（预算用尽，2 次 degraded） | 6 | 646 | 180 447 | stop | 8 |

可以确定的结论只有一条：**三次都收敛**（`finishReason=stop`、保存工具都被调用、无 `finish=length`），
检索调用次数可以被预算与工具描述有效压住。
**不能**据此声称成本下降：去密度后第一次是 -10%，加了覆盖条款的第二次反而 +7%，
每次运行的推理量在 GLM 5.3 上波动很大（单步推理 6k–16k token），样本量不足以给出成本结论。

## 2. 第 2 轮抽样（4 角色 + 3 场景 + 3 道具）

每轮先删本集资产行再重跑提取（`DELETE /characters|scenes|props/:id` 为软删除，
`deleted_at` 置位并清集关联），本轮角色 14 / 场景 20 / 道具 11，全部由火宝 Agent 产出。
抽样图归档在 `samples/round-2/`（原图 1920×1088，仓库内存的是 1280 宽 JPEG）。

### 量表 α（字段/提示词层）

| 项 | 判据 | 结果 |
| --- | --- | --- |
| A1 身份词入 final_prompt | 4/4 角色的提示词含身份词（俄国君主 / 清代皇帝 / 准噶尔贵族 / 近卫团军官） | 通过 |
| A2 ≥2 项可穿戴/可持有符号 | styling 内符号数 4/5/4/3，提示词内 4/6/5/5 | 通过 |
| A3 年代正确 | 文本层全部带年代（1719/1720/康熙朝/十八世纪初） | 通过 |
| A4 体貌与画像提炼描述一致 | **不适用/未达标**：`appearance` 写足了 ≥3 项体貌特征（卷发及肩、一字短髭、方圆脸宽下颌），但这些是提取 Agent 从维基**文本**推出的，不是从入库画像提炼的——本轮画像是提取之后才入库的，流程里没有把画像特征回写字段的环节（详见 B4 与止损判定） |
| A5 三视图格式 + 无背景词 | 4/4 含「角色设定参考图 / 正脸特写 / 三张等高全身视图 / 纯白背景」，正文无任何场景词 | **100%** |
| A6 无来源污染 | 角色 role/description/appearance/styling/final_prompt + 场景 + 道具全字段无 URL、无来源标注 | **100%** |
| A7 溯源抽查 | 利哈列夫 1676—1728、加加林 1659—1721 首任西伯利亚总督、布赫戈尔 1671—1741 均可在该资产的「资料来源」条目中找到 | 通过 |
| A8 字段分工 | role 均为短标签（≤12 字，含分隔符最长 13 字符）；description 四要素齐；appearance/styling 只写可画内容 | 通过 |

场景：3/3 的 `time` 为时段且原样出现在 final_prompt，年代/地域/功能三要素齐，无现代物件词。
道具：3/3 的 description 含年代 + 用途 + 材质工艺，提示词均写白底。

### 量表 β（图像层，Fabel = Anthropic opus / Astra = gpt-5.6-terra，**只看图、不给人名**）

| 项 | 结果 |
| --- | --- |
| B1 版式（1 特写 + 3 等高全身 + 纯白背景） | 4/4，两位评审一致判「是」 — **100%** |
| **B2 盲测身份可辨** | 彼得一世：Fabel「高级军事贵族」/ Astra「君主」；康熙：Fabel「君主（帝王规格）」/ Astra「君主」。**两个样本在两位评审处双通过** |
| B3 符号兑现 | 彼得一世：浅蓝绶带 + 军礼服 + 佩剑 + 三角帽；康熙：明黄龙袍 + 朝珠 + 朝冠金顶 + 龙纹带扣；均 ≥2 项可见 |
| B4 与 Commons 画像比对 | **0/3 — 不达标**。把入库画像（`samples/round-2/ref-commons-peter-nattier.jpg`）与生成图成对交给两位评审逐项比对：髭须、发型、脸型轮廓，Fabel 与 Astra **都判 0 项一致**（参考像是青年卵圆脸、中长松散波卷；生成图是方颌宽中面、更长更密的卷发） |
| B5/B6 风格一致 | 4 个角色样本同为纯白底设定图质感，`documentary-archival` 前缀未污染背景（白底未被改成外景） |

### 验收 7 的判定与**未结清的缺口**

- 已达标：A5 = 100%、A6 = 100%、A1/A2/A3/A7/A8 全部通过、**B1 = 100%**、
  **B2 彼得一世与康熙在两位评审处双通过**。
- **未达标且仍然开放**：**A4** 与 **B4**。
- **不能据此宣布止损分支成立**。Issue 验收 7 的止损条件是「**α 全绿**而 B2/B4 **连续**无改善」，
  这里两个前提都不成立：
  1. α 并非全绿 —— A4 本身没通过；
  2. B4 只有**一轮**成对比对证据（第 2 轮），谈不上「连续无改善」。
  所以现在的正确结论不是「文本提示词已到上限」，而是：**这条链路上游缺一个环节，
  使得 A4 从未被真正执行过，B4 因此也从未在「体貌确实来自画像」的条件下被测过。**
- 已定位的上游缺口（本轮实测得到的事实）：本轮的 `appearance` 是提取 Agent 从维基**文本**
  推出来的（「方圆脸、宽下颌」），而 Commons 画像是**提取之后**才由人在 UI 里入库的；
  提示词 addendum 里的「`has_archival_reference` 时按画像特征落地」只约束提示词 Agent，
  约束不到更早的提取环节，**全链路没有任何一步把画像里的可见特征回写进 `appearance`**。
- 因此本 Issue 把 A4/B4 作为**未结清项**交出，建议的下一步按顺序是：
  1. 补「入库画像后按画像重写体貌」的单资产动作（上游修复，使 A4 可执行）；
  2. 修复后重测 B4；若仍不达标且连续无改善，才触发 Q2 预设的
     「画像 → 设定图」图生图实验（qwen-jobs 只有 `image_edit`、无人脸 identity-adapter，
     而画像按 Q2 的硬约束不得进 `reference_images`）。

### 盲评指出的残留缺陷（不影响达标，作为定稿前的规则加严依据）

1. **利哈列夫（char-26）**：Fabel 判「剪裁与弯柄佩刀属 1780–1800 年」。
   对照彼得一世的提示词带「十八世纪初俄式」年代限定词、被判无穿越物件 →
   **服装段每一件都要带年代限定词**。
2. **火枪（prop-52）**：Fabel 判「枪管自锁体之后完全裸露、无前托无通条，结构不成立」，
   且背景「带渐变的米灰色调并有投影」；另外 description 写的是火绳枪，图上是燧发机 →
   **白底要写死「纯白无影、无渐变」，承重结构要逐项写，机构按年代写死**。
3. **军鼓 / 谕令文书**：两位评审都指出背景「近白但有投影与灰度渐变」→ 同上。
4. **亚梅什盐湖堡（scene-38）**：Fabel 判「墙体原木过于新鲜、锯切面平直、无风化与苔痕，
   像复建景点」→ **场景必须写出风化与使用痕迹**。
