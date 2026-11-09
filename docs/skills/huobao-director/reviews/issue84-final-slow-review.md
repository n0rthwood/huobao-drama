# Issue84 final skill documentation review — role `slow`

Stateless completion; pasted requirements, capability notes, current SKILL/references and prior review/disposition only; no tools/history. Exact vendor/model identity not exposed. First transport attempt died with no output; this is the retried single review, not a second opinion. Earth Clean/import retests were still pending; reviews the documentation contract, not acceptance success.

## 一、五项结论

1. **更好思路**：不需要推翻现有结构。「铁律框 → 阶段正文（SKILL.md §S2-84）→ 参数目录（api-catalog §3.84）→ 历史参考只读」的分层是对的；上一轮封闭评审的 P0/P1（人决定点同步进铁律 2/§1.3、map_spec 整体替换语义、四源固定枚举、image 5% 残差阈值、run/advance/mode 优先级、文本预算量化 3+1/≤9）已逐项核实落入文本。最优路径是只做两处最小一致性修复（见 P1），不新增 API、不造 preview/opened 参数、不扩范围、不重评 Issue 方案。
2. **过度设计**：未发现应削减项。revision CAS、129×129 控制网格与 sidecar、60 图层/240 顶点上限、观测留痕、独立导入复制，均有防伪/证据/预算动机；SKILL 与目录的双写是 64KB 限制下的刻意分层，其漂移风险恰是 P1-1 要修的对象，不是删减理由。
3. **遗漏需求**：用户四条需求均有明确落点（见 §二逐条）。仅两处小缺口：① 中央预算枚举（铁律 3、§1.2「计费文本 LLM 额度」）未点名地图 brief/research 文本调用——§S2-84 已绑定 §1.2 并给出口径，属枚举不同步（P1-2）；② Earth 清洁影像复验（1336 链）与导入误点（1343）修复的最终状态 ID 按约定评审后追加，追加前不得推断通过——这是留白不是遗漏，追加时须保留失败记录不删。
4. **擅定决定**：未发现文档层面的越权授予。候选采纳（去 `proposed`）、路线/风格/示意模式、跳过底纹、rollback/cancel、map→prop 降级在铁律 2、§1.3 清单、§S2-84 三处一致归人；auto 候选制图明确标注「不是人工批准」；complete「没有 opened 参数，不要自造」且「不是人批准史实」；1009 命名明确为用户指定、「不把一次指定推广为自动日期格式」（fixed-case 首段），与授权口径一致。
5. **调查不足**：本评审闭卷，无法验证服务端实际行为；文档自身诚实划界——cancel/skip-style/类型降级等仍 `[S]`，1287–1291 旧调用不得回填，「生产入口已可用，但仍须检查实际部署版本」，1008 首轮「通过」只覆盖明列调用（fixed-case 已写明）。残余缺口 = Earth Clean 复验与 1343 修复的生产重测（进行中）及未触发分支；文档已如实声明，不构成虚报。本评审不等于、也不签发生产验收。

## 二、逐条需求合规

| 需求 | 判定 | 依据 |
|---|---|---|
| R1 地图专门类型，仅该类型有地图字段/流程 | 合规 | SKILL §S2-84「类型」「项目范围」「唯一工作入口」；api-catalog §3.84「类型与持久化」：`asset_type:"map"`、非地图调用返回 `not_a_map`、降级需 `confirm_asset_type_change:true` 且数据保留、`register-upload` 仍填 `"prop"` 的同名异义陷阱已写明；地图不受集剧本门禁、「不能为地图伪造 `script_content` 或确认剧本」符合笔记 |
| R2 串联 AI 流程、信息充分性与缺失提示 | 合规 | 六阶段持久化（brief→research→base→style→drawing→complete）；「殷墟车马坑可由 AI 解释隐含时代与位置、京杭运河通州段缺时代必须补齐」逐字落入 §S2-84「需求与缺失分级」；§3.84 brief 条款「缺时代不能擅自默认」「已知字段不得用模型猜测覆盖」；`issues[].blocking` 阻断补需求 |
| R3 权威检索、三路底图、美化、绘制 | 合规 | 四源固定（wikipedia-zh/en、europeana、smithsonian，`research.queries[]`，凭据由设置页保管不落盘）；「不能完全补齐也没关系」→单源失败/非关键缺失记风险，全源无结果≠已完成检索；program / earth（真实载入 KMZ+实测控制网格 ≤3px、漂移 ≤0.25px、必需 Clean、不得程序图冒充）/ image（上传示意图+≥3 非共线控制点+来源许可+对角线 5% 残差上限）三路齐备；「美化」收窄为扩散仅产无地理内容底纹（默认 35% alpha）+程序叠加点线面文字，是铁律 7/§4.1 忠实素材边界的保守执行，兼容「基于底图美化」，并留人工 skip 选项 |
| R4 自动/手动、逐步审核回退、手工编辑点位、自动绘制 | 合规 | run auto（连续到完成或阻断，须先授权+预扣）/manual、advance 单步（唯一支持 skip 且仅 style）、rollback 快照、`awaiting_review` 语义；mfocus/mview 只读恢复 UI 不触发写入；画布拖动按实际配准反算、保存后回 drawing 复用底图底纹；全自动已有 185/root1335 实测记载。「UI 乱」的产品整改超出技能文档，但文档提供了人审所需深链与阶段语义 |
| 额外授权（生产验收、不逐次索批、1009） | 合规 | §1.2 第二条「范围内直接持续执行并记账，不逐任务/逐阶段重复索要预算批准」+「本轮测试使用 1009，不是历史 1008」；fixed-case 命名条款 |
| 契约笔记对照 | 合规 | drama_id 建图不关联集 ✓；run 省略默认 manual、不沿用已存 auto ✓（§3.84「mode 优先级」）；PUT map_spec 整体替换/brief 合并 ✓；cancel 无 expected_revision ✓；complete 技术采用、无 opened ✓；3 文本+1 底纹、未钉选预留 ≤9、钉选不切端点 ✓（185 实测「三次文本、图片1338」互证）；#86/#87 保留、#88 未闭 ✓（S5-87「覆盖边界」）；旧任务不回填 ✓ |

## 三、新目标干跑：授权的「明代京杭大运河·通州段」地图（纸面推演，非执行记录，不得标 `[R]`）

前提：用户已授权本图及选项——时代=明代、base_mode=program、style=archival、schematic:false 均为人已决定；预算 `{images:1, videos:0, tts:0, text_calls:9}`（钉选 `text_config_id` 则预期 3 次）；在授权测试项目 `{d}` 内，不使用文档中的 177/181/184/185 等既有 ID。

1. 开工（§1.1）：`GET /health` → `GET /tasks/active` → `GET /dramas/{d}`；记录授权原话与台账。
2. `POST /props {drama_id:{d}, name:"明代京杭大运河·通州段示意图", description:"对象=京杭大运河通州段；时代=明代；用途=概览；粒度=regional", asset_type:"map"}` → 读回 `{p}`；不传 episode_id，不触碰任何剧本/确认。
3. `GET /props/{p}/map-workflow` → `revision=r0, stage=brief, status=idle`。
4. `PUT …/map-workflow {expected_revision:r0, brief:{subject, era:"明代", location:"北京通州", purpose:"概览示意", detail_level:"regional", schematic:false, base_mode:"program", style:"archival"}}`（brief 合并）→ 读回 r1。
5. `POST …/run {mode:"manual", expected_revision:r1}`：brief 充分性 1 次文本（未钉选单次最多试 3 端点，按实耗记账）；轮询 `GET /tasks/{task_id}`+工作流。时代已给，预期无 blocking；若 `issues[].blocking` → 停、原样呈报，不默认。
6. `POST …/advance {expected_revision}` 进 research：2 次文本；读 `research.queries` 四源 hits/error（单源无命中仅记风险；四源全空=检索未完成→阻断）；`sources/features` 的出处、uncertainty、conflicts 原样呈报；AI 并入的点线面带 `proposed:true`。
7. 人工采纳（人决定）：人逐项裁定后，agent `GET` 完整 map_spec → 仅改获准项、未动项全量带回（**整体替换**）→ `PUT` 带当前 `expected_revision` → 读回 before/after；409 → 保留草稿、重读、交人合并，不盲投。
8. advance 进 base：program 确定性底图（0 文本 0 GPU）；下载打开 `outputs.base_image` 核对 bbox/配准。
9. style：先查台账（images=1）→ advance 发 1 次底纹任务（`texture_image.task_id` 计 images→0）；打开 texture。失败重试=新额度，余额 0 停下问人；重启续跑认领 `params.map_texture_task_id` 不重复下单。若人要求原貌 → `advance {skip:true}`（仅 style、仅人令）。
10. advance 进 drawing：确定性绘制+label 避让；超 60 层/240 顶点 → 阻断呈报，不丢点不钳边。
11. complete（manual）：推进前下载打开 `outputs.final_image`，核对图例/点位/来源/底纹不改地理，`requests.jsonl` 记录实际打开路径+SHA-256；advance 完成=技术采用——无 opened 参数（不得自造），不是史实/许可批准；`faithful_source` 保留原始底图版本。
12. 收尾：读 `outputs.layer_doc` 与风险清单；对账（文本实际 N≤9、图 1）；交人做史实/许可/发布审核，completed≠验收。后续手工编辑：拖点配准反算 → GET+PUT（CAS）→ 回 drawing 复用底图底纹重绘；改投影/bbox/背景层才重做 base；rollback/cancel 仅人令（cancel 不退已发底纹费）。

## 四、反例与参数准确性

- anti-patterns.md 21 条与现行契约无冲突（AI combo 仅首填、merge 显式 IDs、未开图不批、停止优先等与 §2/铁律一致）；§3.84 地图正/反例准确（真实地图不进 `generate-image`；检索命中≠坐标证据；配准失败不得拿程序图标成 Earth；completed≠史实/版权通过）。
- 参数核对一致：brief 字段枚举、regions ≥3 非共线且闭合末点=首点副本、run/advance/rollback/cancel 请求体、`409 revision_conflict|workflow_busy`、`already_completed` 不重复计费、texture 计 images 而 base/final 确定性版本不计 GPU、`not_a_map`、导入独立副本复制 sidecar/标定工件。
- 非阻断小偏差（无需改）：SKILL §S2-84 写「相机漂移时阻断」未带 0.25px 数值（目录 §3.84 有，且 SKILL 指向目录）；SKILL 写底纹「上限 60%」目录未重复（不冲突）。

## 五、裁定与最小 P0/P1

**裁定：通过（有条件）。无 P0。** 安全性评估：按本套文档，助手可以安全操作地图——人决定点三处同步、预算台账与 3+1 口径、CAS 与整体替换警示、忠实素材禁扩散、Earth 门槛+必需 Clean+不得程序替代、completed≠批准等护栏齐备，且与当前契约笔记逐项相符。本评审不认证生产验收：Earth 复验与 1343 修复重测进行中，cancel/skip/降级等分支仍 `[S]`，最终状态 ID 评审后追加、不得预判为通过。

- **P1-1 版本/状态戳不一致**：api-catalog.md §0「本轮证据」行写「#84 代码 `ff09732` / release `20261109T015027Z`…三路线验收进行中」，与同文件 §3.84「来源与状态」及 SKILL.md 头注 Issue #84 块（`3c469b7` / `20261109T050538Z`，程序177/外部181/副本184/全自动185 已实测）矛盾，且均落后当前 `4d9ac2c` / `20261109T052007Z`。风险：证据引用错位、把已测分支误判未测而重复计费重测。最小修复：将 §0 该行改为与 §3.84 一致（或一句声明以 §3.84 为准），追加最终状态 ID 时统一刷新。
- **P1-2 中央预算枚举缺地图项**：SKILL.md 铁律 3 与 §1.2「计费文本 LLM 额度」条的枚举（改写/inspect-narration/骨架/填卡/关键帧/视频提示词/资产提取审核）未列地图工作流 brief/research 文本调用；操作口径现仅在 §S2-84「调用量与模式」与 §3.84。风险：只读中央台账的弱模型漏预扣。最小修复：两处枚举各补一短句「地图工作流 brief/research 文本调用（未钉选含端点重试）与 style 底纹图片任务」。

（范围声明：仅依据所贴材料的闭卷文档评审；未使用工具、未读仓库；不重复原 Fabel 一次性方案评审；不构成生产验收结论。）