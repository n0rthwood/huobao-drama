Note: plan.defaultOnStartup is ignored in print mode (no interactive surface to review the plan). Use --plan-yolo for a headless plan flow.
Working...
## 1. 历史兼容三政策

V6、V7、V8 分别约束新任务、旧任务再次生成、已有历史成图与人工编辑产物，不能合并为一次主题迁移。新任务直接采用默认主题、无纸纹与底图缓存；旧任务只有显式再次生成时，才对本次新输出应用新政策。旧的已交付产物永不改写，既有成图与人工 PUT 的 layer_doc 原样保留，不能以默认主题覆盖人工样式。只有用户显式动作才产生新视觉，打开、刷新、查看历史均不触发生成、样式重建或迁移写入。历史兼容验收使用新建测试任务复刻旧状态，不重渲真实历史任务。

### 1.1 新任务政策（V6）

| 项目 | 可执行规则 |
|---|---|
| 适用范围 | 新建且无历史产物的任务；已有成图、交付版本或人工 PUT 的 layer_doc 不归入本政策，分别按 V7/V8 处理。 |
| 用户可见行为 | 不设主题选择器；“更多 → 制图信息”只读显示“制图主题：默认（atlas-tint） / Map theme: Default (atlas-tint)”。说明“新生成的要素使用默认主题；底图色板不随主题变化。 / Newly generated features use the default theme; the base palette does not change.”底图就绪后，按本次产物的真实来源显示“底图来源：模板缓存命中 / Base source: Template cache hit”或“底图来源：新渲染 / Base source: Newly rendered”，旁设“查看来源 / View provenance”入口；尚未取得来源证据时不预先标命中。 |
| 新任务的处理 | 创建与查看任务本身不触发出图；用户显式启动流程后应用本政策。质感底纹显示“纸纹：不使用 / Paper texture: Not used”，不显示空缩略图或可点击的空预览；底图未就绪时显示“底图尚未就绪 / Base not ready”。 |
| 内部行为 | 固定 `resolveMapStyle` 返回默认家族 `atlas-tint`，不受任务主题或模块 `default_style` 切换影响。新 `spec.style` 记录解析后的默认样式，家族身份为 `atlas-tint`，字段结构沿用 §4 契约；**实施前提**：现有 `spec.style` 内部字段及 `theme` 枚举须按实际 schema 映射，不把家族名擅自当作 `theme` 值。style（质感底纹）保留阶段身份但不出图，`outputs.texture_image=null`，drawing（作图）不传、不消费纹理路径。base（底图）仅按完整键读取纯底图缓存：bbox + 像素尺寸 + 投影 + DEM/NE/OSM manifest 指纹 + renderer 版本 + 叙事河豁免集（`exemptRivers/namedRivers`）；不缓存任务要素。缓存经 sha256 校验有效才复用，未命中或损坏则新渲染，并记录本次产物来源。 |
| brief 兼容 | `brief.map_style` 仅作只读记录，不提供创建或编辑入口，不作为默认样式解析输入；新任务不依赖该字段存在。若输入已有该值，保留记录但不据此切换主题，不为落实默认主题而回写该字段或宿主资产。 |
| 验收 | 使用专用新任务检查：brief 无主题输入入口；`spec.style` 对应 `atlas-tint` 默认样式；`outputs.texture_image=null`；作图合成输入无纹理路径。截图覆盖只读主题、无选择器、纸纹不使用及底图来源。以隔离缓存执行完整键相同的冷、热两次底图请求，分别留存 miss/hit、完整缓存键、manifest 记录、产物 sha 和对应 run/revision；热请求产物 sha 与缓存记录一致。另验证 manifest、renderer 或豁免集任一变化均不误复用；截图与字段均为待验收要求，不代表已通过。 |
| 禁止 | 不以耗时作为命中证据；不创建纸纹；不把默认主题写回宿主资产；不改底图色板；不因打开、刷新或查看历史而执行生成或保存。 |

证据入口展示实际 base 产物的来源，不能拿当前环境缓存状态覆盖过去 run 的来源。旧产物无记录显示“未记录模板来源 / Template provenance unavailable”。
