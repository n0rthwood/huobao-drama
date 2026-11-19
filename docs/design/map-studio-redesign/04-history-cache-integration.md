# 04 历史兼容、底图模板缓存、主题简化与集成契约

> 设计主体：Astra（模型 `gpt-6-astra`，`omp -p --mode text`）。
> 留痕：`astra-calls/r4.md`（prompt）、`astra-calls/r4.response.md`（原始响应）。
> 初稿补写留痕：`astra-calls/r5a.md`、`r5a.response.md`（补原第4轮缺失开头）。
> r2 实质修订留痕：`astra-calls/r9.md`、`r11.md`、`r12.md` 及对应原始响应。
>
> 注：本文件第 7 节是 v2 条款 V1-V34 的验收映射；跨文档的逐条覆盖核对（设计元素 → 文档小节 →
> Astra 出处 → 待实施证据）见 `05-acceptance-mapping.md`。

（正文由 Astra 修订；事实以 `astra-calls/facts.md` §6–8 为准，行为验收全部未执行。）

## 1. 历史兼容三政策

V6 新任务、V7 旧任务再次生成、V8 已有成图与人工图层保留分别执行。查看、刷新、选择历史图片均为只读，不启动生成、迁移或样式重写。

### 1.1 新任务政策（V6）

| 项目 | 契约 |
|---|---|
| 默认样式 | 新生成要素固定 `atlas-tint` 家族，其 `theme_mapping='archival'` 已核实；新 style 复用既有 family/theme 字段记录，不新建样式系统。依据 `styles/families.json` 的 id 精确 JSON 读取（facts-final §8，事实底座未附行号）。 |
| 纸纹 | 新 drawing 不传、不消费旧 texture；style 保留阶段身份、不出纹理。现有 `run.ts:244` 置 null 不足以单独证明旧任务 drawing 不消费纹理，合成入口须一并整改。 |
| 底图 | 强化既有 `STORAGE_ROOT/map-bases` 缓存（`geo/base-render.ts:539-554`）；earth/image 保留既有文件复用（`geo/geometry.ts:567-763`）。 |
| 创建与查看 | 不自动出图；显式运行才生成。主题与纸纹只读信息不构成编辑入口。 |
| 来源展示 | 完整验证后才显示“模板缓存命中 / Template cache hit”；否则展示真实 miss/rebuilt/bypass，不用耗时推断。 |

“新生成使用默认 atlas-tint 要素样式，不使用纸纹。 / New renders use default atlas-tint feature styling without paper texture.”

### 1.2 旧任务再次生成政策（V7）

| 项目 | 契约 |
|---|---|
| 触发 | 用户显式合法回退、重做或恢复作图；打开旧任务不触发。 |
| 新输出 | 新构建的 layer_doc 使用默认家族；旧 `brief.style/map_style` 不参与有效默认解析；不消费旧 texture。 |
| 旧输出 | 原图、人工 layer_doc、texture 引用与 provenance 留在原快照，不原地套默认样式。 |
| 新 provenance | 记录实际解析样式及 `style_policy='atlas-tint-default-v1'`、`texture_policy='none'`；它们是新增生产契约，不声称现有字段已提供。 |
| 提示 | “再次生成将使用默认要素样式，不使用纸纹。 / Regeneration will use default feature styling without paper texture.” |
| 完成提示 | 仅所选新图片确有上述生产证据时显示“已按默认样式生成 / Generated with default styling”；选回旧图立即改读旧图事实。 |

保存其他 brief 字段保留历史主题值；该值仅是任务历史设置，不能自动认定为所选图片实际样式。

### 1.3 已有历史成图与人工编辑样式保留政策（V8）

图片事实以所选 `snapshot_id` 为准，不能以当前 task 字段反推。现有图片引用与历史载荷见 `types.ts:215-258`；旧交付 texture 仅有 path，来源可能不足（`delivery.ts:59`）。

| 所选图片证据 | 展示 |
|---|---|
| 同图记录证明使用 texture | “此图使用旧纸纹 / This image uses legacy paper texture”；仅显示已记录的来源，不补猜 provenance。 |
| 同图记录明确未使用 texture | “此图未使用纸纹 / This image uses no paper texture”。 |
| 字段未记录或不能证明同源 | “此图纸纹使用情况未记录 / Paper texture usage was not recorded for this image”。 |
| 同图记录实际样式 | 展示该样式；不覆盖成当前默认主题。 |
| 无同图样式记录 | “此图样式未记录 / Styling was not recorded for this image”；任务旧设置另列，不当图片事实。 |

以上三态与“再次生成不使用纸纹”是两个独立信息区。当前 `outputs.texture_image=null` 不能证明旧图无纹理。

显式重做流程：

1. 检查无活动 run、合法回退目标与剩余回退次数；现有上限为 2，回退会清当前 final/layer_doc（`run.ts:140-163`）。
2. 按 §5 durable pin 原图、人工 layer_doc、生产输入和 texture 来源；旧缺失字段如实记录，不能伪造。无法安全保存现有内容时阻断回退。
3. 用户确认警告后执行合法回退；不能绕过 `already_completed` 或回退限制（`run.ts:330-383`）。
4. 回退后停靠，由人核对并显式“渲染成图 / Render image”；不自动重渲。

警告：“重新作图将使用默认要素样式且不使用纸纹；当前人工样式不会自动带入，原版本将保留。 / Redrawing uses default feature styling without paper texture. Current manual styling will not carry over; the original version will be preserved.”

保护失败：“历史版本尚不可安全保留，暂不能重新作图。 / Redrawing is unavailable until the historical version can be safely preserved.”

只读查看、迁移及新版本生成之后，旧图片 sha 与旧人工文档内容哈希必须不变。现有 history 仅 30 条，不足以承担永久保护（`store.ts:51,400-420`）。

## 2. 纸纹残留迁移（V9/V10）

### 2.1 判定与只读清单

候选必须满足 `outputs.texture_image.provenance.source='diffusion-texture'`，并满足以下至少一项：

- R1：当前有效 base 的 `provenance.renderer` 含 `relief`。
- R2：texture 所属 run 早于最近实际产出 base 的 run。

不得按 run_id 字符串或数值大小推断先后。R2 必须有持久化运行时序或有序历史证据；失败且未产出 base 的 run 不算。R1 成立即可判候选；R1 不成立且无法证明 R2 时为 `undetermined`。

逐行报告至少包含：

`task_id, title, revision, status, texture_path, texture_run_id, latest_base_run_id, base_renderer, reason[], chronology_evidence, skip, skip_reason, texture_before_sha256, active_migration_id`。

title 与运行时序的物理读取映射仍须工具落地时确定；不是新增业务字段的理由。null、来源不匹配、running、无法判定分别计数。

### 2.2 dry-run 报告

拟议工具入口：`map-studio texture-migration --dry-run --export <报告目录>`。

输出 JSON 与 CSV：报告 ID/哈希、工具版本、扫描范围、时间、逐任务原字段哈希、判定证据、拟执行动作、跳过原因及统计。dry-run 必须零 DB 写、零产物改写、零业务 history 创建。报告中的路径仅供运维，不直接展示给普通用户。

apply 只能引用审阅过的报告；报告后 revision、原字段或判定证据改变，必须重新 dry-run，不能静默扩大批次。

### 2.3 apply、备份与回滚

**最小存储扩展：**复用 §5 的 snapshot 载荷，在 task state 增加独立于滚动 history 的 durable pin 及迁移 journal 引用/记录；通过既有整份 state CAS 写入。journal 不放在会被 `slice(-30)` 淘汰的 history 中。此为本 Issue 新增字段，不是假称现有 migration 接口已经存在（`types.ts:215-258`、`store.ts:400-420`、`db.ts:68-77`）。

每条 journal 包含：

`migration_id, policy_id, report_id, previous_migration_id, status, before_snapshot_id, before_texture, before_sha256, after_texture, after_sha256, applied_revision, rolled_back_revision, actor, timestamps, reason[]`。

`status` 仅用 `applied | rolled_back`；revision 为写后业务 revision，不建立第二套版本号。

| 动作 | 判定与原子边界 |
|---|---|
| apply | 重读并校验报告 revision、texture 完整原值哈希及候选条件；先确保被备份文件已 durable pin 且内容校验通过。 |
| 并发保护 | 用 `mutateTask(requireIdle, expectedRevision)`，由 `db.ts:168-186` 整份 state/map_spec/brief CAS 决胜；启动 run 与迁移竞争时，CAS 失败方重读并报告冲突/在飞。仅扫描时跳过 running 不够。 |
| 一次提交 | 在同一次 state CAS 中写入备份载荷/pin 引用、journal 的 applied 记录、history 审计条目并将当前 texture 置 null；不得分成“先记成功再清引用”两次写。 |
| 文件前置 | 文件保留先完成、再提交引用；CAS 失败留下未引用文件不等于迁移成功，不得清源文件。本工具不引入跨文件与数据库的虚构事务。 |
| 重复 apply | 只有仍有效的 applied 记录且当前字段匹配其 after 状态，才判 `already-applied`，零写、零 revision 增量。null 但无对应有效记录只能判 `no-texture`，不能伪称本迁移已完成。 |
| rollback | 校验有效 applied 记录、备份完整性、引用文件以及当前仍为该记录的 after 状态和允许的 revision；后续业务写入则冲突跳过。一次 CAS 恢复 before.texture，改 journal 为 rolled_back，追加审计；revision 单调增加。 |
| 重复 rollback | 记录已 rolled_back 且当前字段符合已恢复状态时零写；当前不符则冲突，不覆盖。 |
| rollback 后再 apply | 新 dry-run、新报告、新 migration_id，`previous_migration_id` 指向前次；允许相同 before hash 再迁移。历史同 hash 不构成永久跳过条件。 |

并发依据为 `store.ts:334-453`、`run.ts:365`、`db.ts:168-186`；没有共享锁或额外事务 API。durable journal 与 pin 不随 history 淘汰；引用图片、人工 layer_doc、texture provenance 的保护与清引用处于同一 state 提交边界。迁移不改 spec、图像字节、人工 layer_doc 或宿主版本。

回滚仅恢复引用，不恢复旧 drawing 纹理消费政策。

### 2.4 用户可见影响与证据

当前任务设置：“再次生成不使用纸纹 / Regeneration will not use paper texture”。

有有效迁移记录时可补：“旧纸纹引用已归档，已生成图片未改变。 / The legacy texture reference is archived; existing images are unchanged.”

所选历史图片仍按 §1.3 三态显示，不能因当前 null 而改标签。旧 texture 深链只读定位对应快照；不可用时显示“该版本的纸纹来源未记录或不可读取 / Texture provenance for this version was not recorded or cannot be read”，不自动恢复字段。

证据分开保存：旧图 sha、人工文档哈希、完整 texture 备份；新 drawing 合成输入无纹理及新 provenance；两图各自 snapshot/run/发布 revision。默认样式变化不得全部归因于纸纹移除。

### 2.5 专用样本与生产执行边界

遵守现行 AGENTS §9，区分实现期隔离自测与最终生产验收；不重渲任务 1 或其他真实历史任务。

| 层次 | 环境与允许操作 | 证据效力 |
|---|---|---|
| 实现期单元／行为自测 | 隔离 fixture 可注入旧状态，验证迁移判定、CAS、幂等、故障与回滚逻辑；注入仅作用于隔离数据，不伪造生产 DB/API 状态 | 证明对应隔离案例，不替代最终生产验收，不构成生产 apply 批准 |
| 最终生产兼容验收 | 在生产专用新建测试项目内，经合法 API 创建专用任务，使用可依法复刻的专用样本；记录创建请求、项目／任务身份与产物证据 | 只证明实际完成的生产场景；无法合法复刻的历史条件明确列为门禁阻断、未执行 |
| 生产 apply | 独立授权、独立批次；先通过快照保留、新无纹理合成链及回滚样本，再按审阅报告执行 | 未取得授权即阻断、未执行；部署、隔离通过或文档修订均不授权 apply |

下表保留完整案例要求。需要注入旧状态或故障的部分先在隔离 fixture 自测；最终生产对应场景只能通过合法 API 和专用样本取证，不能为补齐覆盖而直接改生产 DB 或伪造 API 状态。

| 样本 | 预期 |
|---|---|
| diffusion-texture + relief，texture 比 base 晚 | R1 成立，可迁移。 |
| diffusion-texture + 非 relief，texture 早于最近有效 base | R2 成立，可迁移。 |
| 非 relief 且 texture 更晚；或来源非 diffusion-texture | 不迁移。 |
| running；或 dry-run 后 run 抢先启动 | 跳过/冲突，备份与清引用无半提交。 |
| 时序缺失且 R1 不成立 | undetermined，零写。 |
| texture=null | 无操作，不制造成功记录。 |
| 旧人工 layer_doc、旧图、旧主题 | apply/rollback 后原图与文档哈希不变。 |
| 重复 apply、重复 rollback | 各自零多余写。 |
| rollback 后新 dry-run/apply | 新关联记录成功，revision 单调。 |
| 超过 30 条普通 history 后回滚 | durable journal、pin 与原纹理仍可读。 |
| CAS 冲突、备份文件缺失、写入中断 | 不留下已迁移假状态，不覆盖新业务值。 |

证据逐项标明“隔离自测／生产专用样本验收／生产 apply”、实际执行状态及授权范围。无法通过合法 API 复刻历史条件时，保留对应 G8/E05 阻断并注明未执行，不将隔离通过转换为生产验收通过。尚未取得生产 apply 授权时同样保留阻断，不以合法创建测试任务推导 apply 已获授权。

工具交付与生产 apply 分开验收。生产 apply 前必须先通过快照保留、新无纹理合成及回滚样本；部署不自动 apply。本轮为纯设计，未执行工具、隔离样本、生产验收、任何 API 或生产 apply。

清理按样本创建清单执行：隔离 fixture 仅清理其隔离数据／目录，无合法删除入口时可销毁隔离环境；生产专用项目／任务仅使用既有合法且获授权的清理入口，无入口则保留并登记，不直接删除生产 DB／文件，不新增宿主删除权限。

## 3. 底图模板缓存（V25-V27）

### 3.1 范围与完整键

本节是**强化现有签名缓存**，不是新建缓存系统。现有 `mapBaseSignature` 与 `map-bases/<sig>.png`、同名 JSON 已存在；缺内容指纹、读 sha 校验、原子发布与单飞（`geo/base-render.ts:483-643`）。

仅缓存 program 纯底图；任务标题、标签、图层文档、纸纹、pip 与 KMZ 不并入缓存。`createProgramBase` 清空要素几何后渲染，但命名河可来自 routes refs，因此不能断言“任何任务要素变化都必然命中”（`geo/geometry.ts:496-566`；本轮补充核实的 `geo/named-rivers.ts:113-171`）。

| 键分量 | 必须记录的实际输入 |
|---|---|
| 键格式 | `schema_version`；格式变化换键，不兼容误读旧 sidecar。 |
| 空间与尺寸 | 实际 `projection` 及有效参数、bbox、width、height；不新增 bbox/投影舍入。 |
| 渲染配置 | `layers, role, anchors, params, maxRank, lakeRank, lineScale, underSvg, overSvg` 的实际有效值；显式区分缺省解析结果，不拿 UI 标签替代。 |
| 河流输入 | 实际 resolved 的 `exemptRivers/namedRivers` 和加载顺序、命中数据来源；不得无证据改成数学集合。 |
| NE | 实际使用的 land/lakes/rivers 文件内容 sha，含实际 fallback 文件；不得只记路径、mtime 或清单名称。 |
| DEM | 实际 manifest 指纹及使用瓦片内容指纹；manifest 不能覆盖内容变更时必须补内容清单。 |
| OSM 与河流回退 | 实际命中的 OSM 包、v2 数据、legacy file、v1 manifest fallback 及其内容指纹；影响选择的清单也记录。未使用源明确为 none，不制造共用 unknown 指纹。 |
| renderer | 影响像素的代码、固定色板、配置及依赖内容/构建指纹；手写常量 renderer=3 不足。 |
| 其他既有输入 | `spec.version` 等现有字段必须审计：影响渲染则作为有效输入保留，仅 schema 身份则纳入格式版本；不能无证据删除像素输入。 |

固定色板不受 theme/family 影响，删除这两个伪失效分量（`geo/relief-render.ts:30-38`、`geo/base-render.ts:507-508`）。没有独立像素输入的 `atlas_version` 删除，不保留占位字段。

依据：`geo/relief-render.ts:341-380,452-461`、`geo/base-render.ts:527-539`、`geo/datasets.ts:155-159`、`geo/terrain-cache.ts`。数据指纹须对应本次真正读取的内容；若解析与渲染间输入变化，重新解析/计算，不能用旧键发布新像素。

### 3.2 无损 canonical、目录与 manifest

数值契约：

- 只接受有限 IEEE754 binary64；拒绝 NaN、Infinity 与 -Infinity。
- 使用 `JSON.stringify` 的最短往返十进制表示，不使用固定小数位或容差合并。
- `1` 与 `1.0` 是同一 binary64，键相同；`1` 与 `1.0000000000000002` 不同，键不同。
- `-0` 仅在对应 renderer 输入已证明与 `+0` 等价时规范为 0；未证明时不能让 JSON 的自动归零隐藏差异，应阻断该输入进入缓存或保留显式负零编码。
- 对象固定字段顺序，嵌套对象按键排序；数组保留执行顺序，除非已有执行逻辑证明其集合等价。
- 不做 Unicode NFC、去重、额外大小写折叠或河名别名归并。

可直接作为验收 oracle 的表达式：`JSON.stringify(1)` 与 `JSON.stringify(1.0)` 均为 `"1"`；`JSON.stringify(1.0000000000000002)` 为 `"1.0000000000000002"`。NaN 不允许进入 stringify 后被当成 null。对象属性插入顺序变化经 canonical 后相同；数组 `[1,2]` 与 `[2,1]` 保持不同。

河名补充依据：现有 `canonicalReliefOptions` 对河名 `toLowerCase().sort()`、params 转 String（`geo/base-render.ts:465-479`）；实际加载还区分 `osm:ID` 直取、v2 `foldRiverName` 别名、legacy file 与 v1 fallback（`geo/named-rivers.ts:113-171`）。旧 canonical 的归并不能直接当作执行等价证明。以实际 resolved options 和命中文件为权威；循环中的重复项/顺序可能影响结果，未经证明不归并。params 使用 renderer 实际消费类型，不另造字符串/数值等价规则。

沿用 `STORAGE_ROOT/map-bases` 与 PNG/sidecar 产物关系。新 key 为 canonical 有效输入的 SHA-256；不创建 `map-data/base-cache` 第二套目录。

sidecar manifest 新增并完整记录：

- `schema_version,key,key_components,source_inputs`；
- 实际数据文件内容指纹与 renderer/依赖指纹；
- `artifact {path,width,height,sha256}`，path 仅为缓存根内安全相对路径；
- `registration`、生产时间；registration 必须对应相同有效输入。

任务证据对象统一为 `base_cache {status,reason,key,sha,manifest}`：

| 字段 | 契约 |
|---|---|
| status | `hit | miss | rebuilt | bypass | failed`。 |
| reason | 必填稳定原因，如 `verified_hit, not_found, corrupt, permission_error, render_error, publish_race_winner, cache_write_failure, task_publish_failure, fingerprint_unavailable`。 |
| key | 完整 key；无法安全构造时为 null，不填伪键。 |
| sha | 当前任务实际底图文件 sha；未产生有效文件时 null。 |
| manifest | 缓存 manifest 的只读引用与 `sha256`；无已发布缓存则 null，另在任务 provenance 保存实际输入指纹。 |

成功时随 `outputs.base_image.provenance` 发布；失败时随该次 base 失败详情保留，不能伪造有效 base_image。命中绑定当前任务/run，不继承缓存生产者身份。只读证据入口不泄漏绝对路径。

### 3.3 完整性、原子发布与单飞

有效 hit 必须同时验证：key 全量分量、manifest 结构与摘要、图片 sha、解码尺寸、registration 及实际数据/renderer 指纹。仅 exists、sidecar 可解析、reused 标志或等待结束均不足。

沿用同目录产物关系，采用临时文件 + rename；manifest 作为发布提交点。为避免 PNG/JSON 两文件被误认为单次原子提交，manifest 引用不可变的实际 PNG 文件名；PNG 完整写入并校验后先 rename，最后原子 rename manifest。读者只读取已提交 manifest 指向的文件。原 `<sig>.png/.json` 条目可以验证后迁入新格式或 miss 重建，不对旧条目无校验报 hit。该扩展仍在既有 map-bases 内，不建立第二套缓存。

竞争者各写独立 tmp；发现已有有效赢家后必须重新完整验证，再使用赢家。不可覆盖一个已验证 manifest 所引用的 PNG。多进程不保证只渲染一次，不新增跨进程锁平台。

进程内 key→pending 单飞覆盖 lookup/渲染/发布。某等待任务取消只解除其绑定，不取消他人依赖的共享计算；所有成功/失败出口都移除 pending。失败后新请求可重新计算。

| 失败类别 | 任务行为与证据 |
|---|---|
| lookup miss | 新渲染成功并安全发布：`miss/not_found`；不是 hit。 |
| corrupt | 不使用坏文件；重渲成功为 `rebuilt/corrupt`。重渲失败则 base failed。 |
| permission error | 缓存不可读写但可安全生成独立任务产物：`bypass/permission_error`；否则 base failed。 |
| render error | base failed，记录 renderer 错误，不回落坏缓存伪成功。 |
| publish race | 完整验证赢家后可 `hit/publish_race_winner`；赢家无效则不得复用，继续安全发布或 bypass。 |
| cache write failure | 渲染有效且任务独立产物发布成功：`bypass/cache_write_failure`、manifest=null；不能写 hit。 |
| task artifact publish failure | 即使缓存有效也不能宣称任务 base 就绪；`failed/task_publish_failure`。 |

错误展示：“底图生成失败 / Base rendering failed”；缓存旁路：“已生成底图，未写入模板缓存 / Base rendered without caching”。详细原因放 AI 活动或证据入口，不默认铺主界面。

### 3.4 保留策略与可见语义

任务底图必须有独立生命周期的文件或硬链接；缓存清理不能使任务与历史快照失效。snapshot pin 保护任务产物，不把缓存路径当永久历史档案。

本 Issue 不新增 TTL、自动 GC、版本平台或全局锁。保留既有无自动淘汰政策；运维清理不得删除已提交任务产物或正在发布文件。

来源标签按真实证据区分：“模板缓存命中 / Template cache hit”“新渲染 / Newly rendered”“缓存校验失败后重建 / Rebuilt after cache verification failure”“未使用模板缓存 / Template cache bypassed”。耗时仅辅助，不是命中证明。

### 3.5 缓存验收断言

| 案例 | 必须观察 |
|---|---|
| 完整命中 | key、manifest、图片 sha、尺寸与 registration 全一致；第二请求不调用 renderer。 |
| 分量失效 | §3.1 每个实际像素输入单独变化不误复用；theme/family 单独变化不造成纯底图伪失效。 |
| 数值 canonical | 1=1.0；相邻 binary64 不同键；非有限数拒绝；无 bbox 舍入；负零按已证明语义处理。 |
| 河流语义 | `osm:ID`、v2 别名、legacy、v1 fallback 分别留实际命中证据；不假设大小写、NFC、顺序、重复均等价。 |
| 纯底图边界 | 不影响 resolved 底图输入的任务内容变化可复用；routes refs 改变命名河有效输入时不得误复用。 |
| 损坏与权限 | 图片、manifest 分别损坏及读写权限失败均按 §3.3 执行，不输出坏文件。 |
| 原子与竞争 | 中断任一发布步骤不形成假 hit；竞争验证赢家；缓存写失败仍能安全发布任务产物时为 bypass。 |
| 单飞 | 同进程同键一个共享计算；等待者取消不伤其他任务；失败 pending 移除后可重试。 |
| 独立保留 | 删除隔离缓存不影响已发布任务图和 pinned 历史图。 |

以上全部未执行。

## 4. 主题简化（V28、Issue 阶段 3）

### 4.1 UI、请求与服务端消费边界

隐藏选择器不足以消除旧副作用：缺 map_style 的 brief 会回落旧 style，主题差异触发 base 重做且进入缓存键（`styles/index.ts:137-143`；`drawing.ts:113-117`；`run.ts:476-478,526-533`；`geo/base-render.ts:507-508`）。

| 入口 | 目标处理 |
|---|---|
| 创建任务 | 新 UI 不发送主题字段；兼容客户端合法旧值可存为历史记录，但不参与新默认解析。缺省/null 都使用固定有效默认。 |
| 更新任务/brief | 新 UI 白名单不含主题；合法兼容值保留记录，主题单改不触发 base/drawing 重建；保存其他字段不清旧值。 |
| settings | 移除 default_style 编辑 UI；合法兼容值仍存记录，但不改变固定有效默认、不失效产物。 |
| 非法输入 | 继续既有 schema 的枚举、类型及未知字段校验，不无条件接受。 |
| GET /styles | 保留兼容 API/既有消费者；新 UI 不提供任务主题选择。 |
| 新样式 | 已核实 `atlas-tint → theme_mapping archival`（`styles/families.json`，facts-final §8 精确 JSON 证据）；新 style 用既有 family/theme 字段记录家族和内部 theme，不增额外样式系统。 |
| 历史图/人工文档 | 加载不重写；显式重做才构建默认样式新文档，旧图事实仍读旧快照。 |

调用链必须同时收敛：normalize 区分历史记录与有效输入；brief_hash 使用有效生产输入；presentationOnly/reframed 不因无效主题记录差异调度重建；纯底图键去 theme/family；drawing 与显式 restyle 使用一致默认，不留旧 brief.style 隐式回退（`routes.ts:118-121`）。

其他有效像素输入仍按既有口径失效，不放宽几何校验，不默认化已有人工 layer_doc。

### 4.2 技能与提示词

删除选主题、询问主题、修改默认主题的推荐分支。统一说明：

“新生成使用默认 atlas-tint 要素样式，底图色板固定，历史主题仅供记录。 / New renders use default atlas-tint feature styling. The base palette is fixed; legacy themes are retained for reference only.”

实施范围包含既有 `AGENTS.md` 地图说明、`docs/skills/huobao-director` 地图 API 点、模块提示词与相关说明。明确 guided 两终点、高级 auto 可越过核对、几何保存不等于渲染交付；不推荐浏览器串发 manual 模拟一键检索。

本轮只修设计，不声称已修改或审阅技能正文。

### 4.3 只读展示与验收

需求表单保留 `subject/era/location/purpose/notes/reference_image/detail_level/schematic/base_mode` 的既有能力；更多信息只读显示：

- “有效默认样式：atlas-tint / Effective default style: atlas-tint”；
- “历史主题：{value}，仅供记录 / Legacy theme: {value}, reference only”；
- 所选图片样式另按 §1.3 展示，不能拿历史 brief 值冒充图片来源。

分别测创建、更新、settings 的缺省/null/合法旧值/非法值；主题单独变化不使 base 失效，不自动出图；混合其他字段更新仍按实际变化失效。只打开前后 revision 不变，保存其他字段旧值不丢。四语 locales 同步，本文中英为源文案。

## 5. 图层描述查看器契约（V14/V16、Issue 阶段 4）

### 5.1 唯一快照方案与身份

选定**模块自存、复用 history snapshot 载荷形状、task state durable pinned 载荷/索引**。不建立第二套版本系统，不选宿主历史只读投影作为并行快照来源，不跨边界直查宿主库。

现有 history 包含 brief/map_spec/outputs/research，但只有 snapshot:true 捕获，最多30条（`types.ts:242-258`；`store.ts:364-372,400-420`）；模块 delivery 只有 sha/result（`db.ts:68-77`；`store.ts:551-567`）。二者不能独立提供永久同图档案。

- `snapshot_id` 由 `task_id + published_revision + artifact_kind` 唯一定位。
- published_revision 使用任务发布 CAS 的 revision；同一 run 的多次 draft 独立发布，分别取得 revision。artifact_kind 区分 draft/final/delivery 及已有受保护产物类型。
- 不增加 spec_revision、brief_revision、options_revision；输入内容 hash 仅校验一致性，不是版本号。
- detail 提供图片身份与 snapshot 引用；只读 `GET /map-studio/tasks/:id/snapshots/:snapshot_id` 返回同任务授权范围内冻结载荷及安全 URL。
- 当前图、上一版、历史入口、交付、迁移引用的 pin 不随 history30 淘汰；引用文件独立保留，不依赖缓存存活。不增 GC。
- 旧图只有可证明同图的现存载荷才可读取；确实缺失则标未记录，不从当前 props/spec 拼补。

### 5.2 最低冻结载荷与初始描述生产

| 类别 | 必需内容 |
|---|---|
| 身份 | snapshot_id、task_id、run_id、published_revision、artifact_kind；image sha、尺寸和不可变安全文件引用。 |
| 输入 | 实际消费的 brief、map_spec、layer_options 正文及内容指纹，复用现有 snapshot 形状。 |
| 图层 | 同次生产 layer_doc，draft 不借用后来的 final 文档。 |
| 语义 | points/lines/regions、精确 ID 关联、description/keywords 的当时值或明确无事实状态，以及实际 manual/name_manual/source。 |
| 研究 | 冻结 features、sources、feature_id/source_ids、basis、coordinate_basis、excerpt、dataset_ref 等实际可用依据。 |
| 图像依据 | base 身份/sha、registration、实际样式、texture 使用/未使用及来源；旧未知如实记录，新生产不能漏记实际输入。 |
| 交付关联 | delivery 快照另含对应宿主版本关联、幂等交付身份及 frozen_semantics/sources；不把宿主版本 ID 当任务 revision。 |

**描述必须在生产时生成，不能在 GET 时按当前状态临时拼接。**

#125 的真实生产者是 `services/map-semantic-annotations.ts:67-97 semanticAnnotationsOf`：feature_id 精确关联；basis + coordinate_basis 说明 + excerpt + source_ids 对应的最多3个来源标题，合成到500字；keywords 只取 category。无可用事实省略，不调模型，不用名称模糊匹配、别名或分词补关键词。

新增契约将这段纯描述 formatter 通过平台/契约注入模块，宿主和模块复用同一逻辑，**模块不直接 import 宿主 service，不复制一套实现**。drawing 的 draft/final 发布方针对该次冻结 features/sources 生成初始描述，和实际图层、图片身份一起冻结。共享 formatter 可用与注入边界仍须实施，不冒称现状已有。

description 可选不等于允许生产系统漏存整份语义。快照完整且无事实时可几何摘要降级；未冻结输入、来源断裂或缺载荷属于发布不完整，不能通过 G2/G4。

### 5.3 生命周期、事务与最终交付语义

共同边界：先写完、校验并独立保留不可变文件，再一次 state CAS 发布图片引用、冻结载荷与 pin。清旧引用的**同一次 CAS**保留旧 pin。文件预写与数据库提交不是跨资源事务；预写失败不得清旧引用，CAS 失败不宣称发布成功。

| 事件 | 保存方及操作 | 不可变/恢复约束 |
|---|---|---|
| draft 发布 | 模块渲染发布方冻结实际输入，用注入 formatter 生成初始描述，再发布新 snapshot | 每张预览独立，后续 agent 编辑不改变旧描述；render_draft 现有，冻结新增（`drawing.ts:321-322`）。 |
| final 发布 | 阶段引擎同 CAS 发布 final、layer_doc/options、冻结描述、来源与 pin | 替换前保留旧图；输出现有，保护新增（`run.ts:252-261`）。 |
| 人工 layer-doc | 先保护旧图/文档，再将重渲结果发布新身份；如保留自动交付，进入下述最终语义流程 | 明示“保存图层并重渲交付 / Save layers, render and deliver”；不覆盖旧人工文档（`run.ts:608-639`）。 |
| clear/overwrite | 具体 mutation 方在清引用同 CAS 保存被替换载荷/pin | 引用文件不随当前字段清除删除。 |
| rollback | 回退清 final/layer_doc 前同 CAS pin | 恢复/重做不修改原快照（`run.ts:140-163`）。 |
| migration | 工具同 CAS 写备份、pin、durable journal、清 texture | history 只审计，超过30条仍可回滚，见 §2。 |
| delivery | 宿主冻结最终语义并回传，模块以新发布 revision 保存 delivery 快照 | 与 drawing final 同 image sha；原 drawing 快照不修改。pip 按 complete 实际产物关联，不伪装提前存在。 |

**当前 #125 仍缺最终语义冻结：** master `map-studio-host.ts:65-69` 先写原 d.semantics 到版本 params.geometry，`:78-85` 才 `withGeneratedSupplements` 生成/保留人工字段写 props。不能把当前 params 或人工所有权当成已完成的图片快照。

**唯一目标交付顺序：**

1. 模块构建同图交付载荷，携冻结 features/sources、图层及图像身份，不用后续当前研究替换。
2. 宿主在事务内先检查既有 task+png_sha+pip_key 幂等结果；命中直接返回该版本已冻结的最终语义与来源。
3. 首次交付在该事务内，基于本次冻结输入生成补充，并按 `withGeneratedSupplements` 保护已有对应 `manual/name_manual` 字段，得到一次确定的最终 semantics。
4. **先得到最终语义，再写成图版本 params.geometry 及同图 sources/关联版本**；当前 props.semantics 使用同一最终值。版本、资产更新、引用登记保持宿主事务边界。
5. 最小扩展 `MapStudioDeliveryResult`：保留 version_ids/message，新增只读 frozen_semantics、sources 及对应成图版本关联；关联须能区分底图、主成图和实际 pip 版本，不能按数组位置猜测。
6. 模块持久化该结果，并用新的任务 published_revision 发布 delivery snapshot，关联原 final snapshot、相同主图 sha 及交付身份。原 drawing 初始描述保持原值。
7. 宿主已提交但模块登记失败：重试取回**同一最终冻结语义**再补记；不得从当前 props 重算。模块已登记同幂等交付则返回原结果与原 snapshot，不反复增加发布 revision。

宿主与模块不是同一事务；以宿主幂等版本结果解决跨边界恢复（既有键见 `map-studio-host.ts:32-34`；`delivery.ts:69-86`）。旧版本若没有最终冻结字段，只能标未记录，不能假装回算等价。新增返回、params 供给与模块持久化仍为 G2/G4 门禁。

### 5.4 查看器与人工字段

只在所选 snapshot 内以**类别 + semantic_id**精确关联，feature_id 保持生产对应关系。不按名称猜测；多层引用同一语义显示同一冻结描述。多匹配、类别不明或 ID 失效退层自身摘要并提示关联问题。

| 情况 | 展示 |
|---|---|
| 唯一锚定且有 description | 显示冻结描述；keywords 可选，缺关键词不降级描述。 |
| 快照完整、描述无事实 | 冻结名称、类型、几何摘要；展示实际冻结来源，不补写事实。 |
| 无锚定层 | 图层 name/类型/几何摘要，不虚构语义。 |
| manual=true | “描述/关键词已人工维护 / Description/keywords manually maintained”。 |
| name_manual=true | “名称已人工维护 / Name manually maintained”。 |
| source=cv/vlm/manual | 独立来源说明，不证明描述作者，不覆盖所有权徽标。 |
| 历史缺元数据 | “该版本的图层描述未记录 / Layer descriptions were not recorded for this version”。 |
| 同源校验失败 | “图层元数据与图片不匹配 / Layer metadata does not match the image”；保留图片，拒绝拼接。 |

manual/name_manual 含义及比较保护见 `asset-semantics.ts:42-62,141-146,394-474`。人工维护不表示从零手写，也不等于不可变图片档案。

当前 spec/语义变化不改变任何旧 draft/final/delivery 快照。图片过期显示“图与当前几何不一致 / Image differs from current geometry”；旧图编辑入口禁用并提示“请切换到当前可编辑版本 / Switch to the current editable version”。定位当前几何须独立证明对应，不能因禁用编辑而隐藏旧图。

来源仅解释性 tooltip，不新增来源管理、复制或来源深链。

### 5.5 #125 集成门禁

已核实：origin/master 为 `cdb2a8540445eb8bc33d3b6e8e4c29346dfdac94`，含 #125；本 #126 分支仍基于 `2d9655b1`，尚未集成（facts-final §7）。字段、生产者与文件交集不再待猜。

G2/G4 必须取得真实证据：

1. 先将 #125 集成到 #126，按 §6.3 逐交集文件串行保留契约。
2. 注入真实共享 formatter，用冻结 features/sources 产出三类初始描述并随 drawing 发布。
3. 宿主事务先形成最终人工保护语义，再写版本 params，结果回传模块并发布同 sha 的新 delivery 快照。
4. 宿主成功/模块失败重试得到同 version_ids、同 frozen_semantics/sources；不重复插行、不从当前 props 重算。
5. 改当前 spec、研究来源和 props 语义，再分别读取旧 drawing 与 delivery 快照，其描述、来源、所有权和值保持原样。
6. 覆盖共享要素、无锚定、冲突/失效 ID、无可用描述、缺 keywords、manual/name_manual 与 source 独立组合。
7. 实读图片 sha、snapshot_id、published_revision、冻结载荷指纹和浏览器展示相互对应。

手写字段夹具不能替代真实生产闭环；旧缺失降级不能关闭新冻结能力门禁。全部尚未执行。

## 6. 范围与写权限（V28-V30）

### 6.1 运行、保存与交付

| 范围 | 唯一契约 |
|---|---|
| 前端边界 | 只经 /map-studio API，不 import 宿主业务模块；formatter 经平台/契约注入。 |
| guided | `/run {mode:'guided',stop_at:'base'|'drawing',expected_revision}`；双终点同版实施；不建能力发现或永久 manual 降级。 |
| 停靠 | base 完成停 style/awaiting_review；drawing 完成停 complete/awaiting_review；取消不推进，续跑保留并校验原边界。 |
| V5 | 默认 base 停靠、既有要素确认、显式渲染；无 reviewedInputKey 或整体复核正式门槛。服务端仍不强制。 |
| auto | 只在 AI 活动抽屉明确启动，警告可能越过核对至交付；事实见 `run.ts:191-199,291-300`。 |
| 保存几何 | 页面唯一 specDraft+layerOptionsDraft；地点/弹窗有效编辑共享，关闭零提交；一次 PUT 整份 map_spec+layer_options+expected_revision。 |
| 保存整改 | 旧 options 分支有 layer_doc 时会重渲交付（`run.ts:444-449,608-639`）；必须拆成默认只保存/失效，不隐式渲染交付。 |
| 人工图层 | 专用 PUT layer-doc 如保留副作用，按钮明确“保存图层并重渲交付 / Save layers, render and deliver”。 |
| 正常交付 | `/advance {expected_revision}` 异步启动 complete；pip→buildDeliverable→deliverCurrent→completed（`run.ts:264-275`）。启动200不是交付成功。 |
| 成功观察 | 轮询 detail/delivery，匹配本次图像/pip/版本及冻结快照；交付成功与 workflow completed 分别核实。 |
| 补交付 | `/deliver` 无 CAS、宿主/complete/非 running，不重渲 pip、不负责 workflow 收尾（`routes.ts:141-148`；`delivery.ts:69-86`）。 |
| 不变边界 | 不增宿主名称/描述写权限、不改分镜引用、底图源或服务端几何闸门；不自动确认、不自动调平滑。 |

API 统一 expected_revision；内部 expectedRevision 不进入网络示例。保存成功以规范化 spec/options/revision 建基线；未知结果先 GET 完整匹配，冲突保留5d副本，不盲重发、不宣称未落盘。首次 options 保存/消费已存在（`run.ts:440-467,258`；`drawing.ts:87-95`；`task.vue:963-972`）。

待核对统一 geometryUnverified，含 dataset_missing（`accuracy.ts:88-95`）；若另显 proposed===true 数量，只称“AI 候选数 / AI candidate count”。

### 6.2 宿主只读字段投影

唯一新增路径：**contract.describe 的 target 扩展 description/reference_images → 模块 detail.host.target.description/reference_images**。不并存 host_info.*，不增加宿主写权限。

| 展示项 | 来源及目标字段 | 边界 |
|---|---|---|
| 宿主标题/副标题/返回路径 | 既有 describe 字段，经 detail.host.target 展示 | 只读，保留既有能力。 |
| 宿主描述 | props.description → describe target.description → detail.host.target.description | 当前只作 notes 默认值，尚未透出（`map-studio-host.ts:100`）；不能用 notes 替代。 |
| 宿主参考图 | props.reference_images → describe target.reference_images → detail.host.target.reference_images | 字段存在但未透出（`sqlite-schema.ts:389`）；安全 URL 与授权由宿主提供。 |
| 任务配准图 | brief.reference_image | 含控制点（`types.ts:58-64`），不是宿主 reference_images；保持既有编辑。 |
| 任务需求 | subject/era/location/purpose/notes/reference_image/detail_level/schematic/base_mode | 仅既有 writeBrief。 |
| 历史主题 | style/map_style/default_style | 只读展示，兼容写请求按 §4.1；不参与有效新样式选择。 |
| 图片描述 | 所选 snapshot 的冻结 semantics | 不从宿主当前描述、notes 或当前 props.semantics 补旧图。 |

缺值显示“宿主描述未提供 / Host description not provided”“宿主参考图未提供 / Host reference images not provided”。整体标题“宿主资产信息 · 只读 / Host asset information · Read-only”；任务图明确“任务配准参考图 / Task registration reference image”。

### 6.3 #125 真实交集与集成次序

删除“两 Issue 文件不相交”的承诺。facts-final §7 已确认交集：

- `frontend/app/map-studio/api.ts`
- `frontend/app/map-studio/components/MapPipResults.vue`
- 四语 `frontend/app/locales/{zh,en,ja,ko}.json`
- `backend/src/modules/map-studio/delivery.ts`
- `backend/src/modules/map-studio/base.ts`
- `backend/src/modules/map-studio/pip/frames.ts`
- `backend/src/modules/map-studio/pip/usage.ts`
- `backend/src/services/map-studio-host.ts`
- `AGENTS.md` 与 director skill

master 已含 #125，但本分支未集成。实施先集成 #125，再对上述文件逐文件串行协调修改，保留类别/ID、描述限制、manual/name_manual、pip 与来源契约，不做双份 formatter 或重复实现。此清单是已核实交集，不是推测“可能冲突”。

guided 双终点、保存分支整改、快照保护、宿主最终语义回传、只读字段投影与 UI 同版切换。#99 边界、四语文案、技能/API说明、精确基线和真实行为证据纳入 E15/E16。本轮未修改代码或技能，未执行集成。

## 7. V1-V34 验收映射

E01–E18 与 05 §2 同号、同范围；34条逐条落点见05 §1。以下全部尚未执行，事实核实与修订写入不计行为通过。

最终验收遵守现行 AGENTS §9，在生产专用新建测试项目／专用样本上执行，不重渲真实历史任务。实现期隔离 fixture 可做单元／行为自测；迁移逻辑及旧状态注入仅在隔离 fixture 中验证，不伪造生产 DB/API 状态，不替代最终生产验收。无法经合法 API 复刻的历史条件或未授权的生产 apply，明确保留对应门禁阻断、未执行；隔离通过不是生产批准。生产 apply 独立晚于快照保留、新无纹理合成链与回滚样本通过。

| 证据号 | 条款 | 落点 | 必须实测与保存的证据 |
|---|---|---|---|
| E01 | V1–V3、V5、V34 | 02 §1–3、§7–8 | 阶段×状态×模式唯一动作；guided 双终点、style 起点、pending、失败修复、取消/续跑原边界；不串发 manual；默认确认后显式渲染；高级 auto 警告及连续至交付。 |
| E02 | V4、V11、V19–V21 | 02 §4–6；03 §5、§10 | 地点行/全部地点/线面顶点分别编辑；共享草稿、完成/关闭零 PUT；整 spec+options 一次 expected_revision CAS；规范化基线、409/拒绝、未知结果匹配/冲突、刷新；有 layer_doc 的默认保存零渲染/交付。 |
| E03 | V3、V5、V34 | 02 §3.3、§10；04 §6 | advance 启动与真正交付分时记录；轮询对应 delivery/冻结结果，complete pip→交付→completed；失败与重复版本；deliver 无 CAS、不重渲 pip、不收尾 workflow；独立任务空 version_ids 合法。 |
| E04 | V6–V8、V28 | 04 §1、§4 | 新建/重做/保留分别测；atlas-tint/archival 既有字段、新图无纹理；旧图sha与人工文档hash不变；纹理三态；创建/更新/settings兼容与主题单改不伪失效。最终使用生产专用项目内合法API创建/依法复刻的专用样本，不重渲真实历史任务。 |
| E05 | V9–V10、V34 | 04 §2 | 隔离fixture自测迁移逻辑/注入旧状态：dry-run零写、apply/run竞争、备份pin与清引用同CAS、有效状态幂等、重复rollback、rollback后新报告再apply、history超30仍可回滚。最终生产兼容另用专用新建测试项目、合法API创建任务/依法复刻样本取证，不伪造生产DB/API状态、不重渲真实历史。无法合法复刻或未获生产apply授权时，对应门禁阻断、未执行；隔离通过不算生产批准。生产apply独立晚于快照/新合成链/回滚样本通过。 |
| E06 | V8、V13–V14 | 02 §8.2；04 §5 | draft/final/上一版/空态；task+published_revision+artifact_kind身份；state durable pinned载荷/索引、`GET /map-studio/tasks/:id/snapshots/:snapshot_id`、文件先独立保留、载荷/pin/引用同state CAS；clear/overwrite/rollback/迁移后及history30淘汰后仍可读；delivery新revision同sha不改drawing快照；不建新payload表。 |
| E07 | V15 | 01 §6.5；02 §8.2 | drawing阶段render_draft/final_image落盘、detail首次读到对应快照、浏览器实际显示三时间戳；落盘→实际可见≤5s，包含detail发布、轮询、加载及终态；3秒轮询不算证明，不扩所有pip逐产物硬指标。 |
| E08 | V16、V29–V30 | 04 §5–6 | 集成真实#125 formatter，经注入生成冻结初始描述；事务先合成最终人工保护语义再写params，回传并发布delivery快照；幂等重试同最终语义；改当前spec/研究/props后旧快照不漂；三类精确ID、异常锚点、缺字段、manual/name_manual与source独立组合；唯一宿主只读字段投影。 |
| E09 | V3、V12 | 03 §1.1、§2 | 核对③最大、成图②最大；普通布局完整操作；TAB仅画/命中当前类；事务切换三分支零写。 |
| E10 | V17–V18、V31 | 03 §3、§9、§11.1 | 独立registration oracle；viewport/meet/zoom/pan/指针与预期实测；03 fixture每轴viewBox误差≤1e−6px、经纬度≤1e−7°，另验回投影≤0.5 CSS px；鼠标/触摸/笔/键盘新建追加、选边插点、消歧、平移、焦点；取消/无变化零提交。 |
| E11 | V21 | 03 §4.2、§11；02 §6 | 线2点/面3点删除拒绝有反馈；双客户端冲突不覆盖；保存刷新一致。 |
| E12 | V22–V24 | 03 §7、§10.2.1；02 §5 | 14步算法、阈值与同舍入超限；suggested=0不外推非零无解；点击改草稿、全曲线复算和残余；无layer_doc首次消费/刷新、有layer_doc保存零暗交付；统一待核对计数含dataset_missing。 |
| E13 | V25、V27 | 04 §3.1–3.2、§3.5 | 完整键逐分量、实际fallback内容指纹、binary64 oracle；不改河流匹配/顺序/重复语义；theme不伪失效；key+manifest+sha+registration命中证据。 |
| E14 | V26–V27 | 04 §3.3–3.5 | miss/corrupt/permission/render/race/cache-write/task-publish失败；发布中断、验证赢家、进程内单飞/取消/失败清除；bypass独立产物，坏文件零成功复用。 |
| E15 | V28–V30 | 04 §4、§6 | #99、brief白名单、只读零写；先集成#125，逐真实交集文件保留契约；formatter注入无宿主import；技能/API/四语一致。 |
| E16 | V31 | 03 §11；04 §8 | 同commit/环境精确基线测试名及错误签名；新行为通过、差集识别回归，不用约数豁免。 |
| E17 | V32 | 03 §5.3、§11.2、§12.5 | 行绑定目标已保存坐标canonical hash；hash变而行合法退要素级、task revision变而hash不变仍定位、有坐标草稿不生成行链；刷新/新标签/关闭/失效/zoom各自零update、markManual、保存、生成、确认、交付。 |
| E18 | V33 | 02 §2.4、§10；01 §8 | 新多轮失败run切走重开完整回看；逐轮核对runs/rounds/attempts/calls/messages/problems/steps_used身份与数量；旧缺失可提示，新失败记录缺失阻断。 |

坐标 oracle 独立于被测函数；无 registration 不猜映射。截图附 task/run/snapshot 或实体身份，文件 sha 实读，不只信数据库声明。跨文档按同一契约收敛；表中落点是设计文档索引，不是实现验收。本次纯设计不执行任何 API。

## 8. 实施顺序与风险

### 8.1 实施顺序

1. 在本 #126 分支先集成已在 master cdb2a854 的 #125；对 §6.3 真实交集逐文件串行保留契约，记录精确基线。不再调查已知 manual 字段或承诺文件不相交。
2. 落实共享纯 formatter 注入、state pinned 载荷/索引、只读 GET、文件保护及迁移 journal。同 CAS 保护就绪前不启用清旧输出的重做/迁移。
3. 修正宿主事务顺序与最小返回：最终人工保护语义先写版本 params，再回传模块；实现同sha新delivery快照与幂等故障恢复。此项与快照供给共同受G2/G4约束。
4. guided双终点、唯一主动作、取消续跑、保存副作用拆分与UI同版切换；不建能力探测或永久manual流程。
5. 编辑器统一草稿、坐标/TAB、首次平滑、结果未知恢复及坐标hash深链；接通宿主唯一只读投影。
6. 默认atlas-tint/archival、无纹理合成、既有缓存强化与技能说明收敛；工具交付与生产apply分离。生产apply必须晚于快照保护、新无纹理合成、并发与回滚样本通过。
7. 提交E01–E18实际证据；未执行项不能由文档索引或调用留痕代替。

### 8.2 风险控制

| 风险 | 控制 |
|---|---|
| #125已合master被误认已在本分支 | 明确两个commit与实际集成门禁；先集成再逐交集文件改动。 |
| 人工所有权冒充图片快照 | drawing初始、delivery最终分别冻结；不从可变props回补。 |
| 宿主成功、模块失败 | 返回同幂等版本内冻结语义补记；不重算、不重复插版本。 |
| history淘汰或缓存清理 | durable pin与引用文件独立保留，30条仅审计窗口。 |
| 启动200冒充交付成功 | 轮询匹配delivery记录及冻结结果，workflow终态另验；deliver不收尾。 |
| 普通保存暗交付 | 拆旧options分支；专用layer-doc按钮明示副作用。 |
| 迁移与run竞争 | requireIdle+整state CAS，失败重读；无共享锁或虚构跨资源事务。 |
| 河流规范化误命中 | 保留真实resolved输入、顺序与实际分支内容指纹，不新增匹配语义。 |
| 深链选错顶点 | 已保存坐标hash而非任意task revision，失配退要素级。 |

全部风险控制是待实施要求；本轮未执行集成、测试、API调用或生产验收。

## 9. G1–G9 状态与阻断条件

修订要求已写入不等于功能已验收；所有E证据尚未执行。

| 编号 | 状态 | 剩余阻断/关闭依据 |
|---|---|---|
| G1 | 实施阻断 | guided双终点、合法起点、取消续跑边界、唯一主动作与同版切换须E01；无能力发现或永久manual替代。 |
| G2 | 供给与实施阻断 | 模块history形状+state durable pin、同CAS保护、独立文件、只读GET、task发布revision身份、初始/最终两类快照须E06；drawing/final≤5s须E07；最终语义回传与G4共同阻断。 |
| G3 | 事实已核实，行为未验 | complete交付与deliver边界已知（`run.ts:264-275`；`delivery.ts:69-86`；`routes.ts:141-148`）；advance异步启动、delivery轮询判成功、workflow独立收尾须E03。 |
| G4 | 实际集成与同图验收阻断 | master已含#125、本分支未集成；字段/生产者已知。共享formatter注入、先最终语义后params、返回frozen_semantics/sources/关联版本、幂等冻结恢复、宿主只读投影及真实交集整合须E08/E15。 |
| G5 | 已裁定，行为未验 | 保证范围=默认UI/guided；服务端仍不强制。既有要素确认+显式渲染，无整体复核键；auto可至交付。E01待执行。 |
| G6 | 事实已核实，整改未验 | 首次options保存/消费已存在（`run.ts:440-467,258`；`drawing.ts:87-95`）；旧有layer_doc保存副作用必须拆开；整页CAS、结果未知、两类保存样本须E02/E12。 |
| G7 | 观测验收阻断 | 新失败run历史多轮完整回看须E18；诚实缺失提示不能替代新记录完整性。 |
| G8 | 缓存/迁移实施阻断 | 缓存完整键与安全失败须E13/E14；迁移durable journal、整state CAS、有效幂等、rollback再apply、超30条保留须E05；生产apply未执行且晚于样本通过。 |
| G9 | 规则已写入，行为阻断 | msggeorev=要素已保存坐标canonical hash；hash变退要素级、普通状态变化不失效、有坐标草稿不生成行链；全部恢复零写须E17。 |

默认token不再未知：atlas-tint→archival，复用既有字段（`styles/families.json`，facts-final §8精确JSON证据）。迁移时序不足跳过；缓存指纹不足可安全bypass，但不能因此判缓存验收通过。不得宣称G全部关闭。

