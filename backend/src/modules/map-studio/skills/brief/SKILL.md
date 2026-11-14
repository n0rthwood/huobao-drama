---
name: map-studio-brief-theme
description: 地图需求审核中的主题选择：尊重人工选择，按题材说明提议理由；不逐层设计样式
---

# 地图需求：制图主题

语义充分性仍只审核 subject / era / location / purpose，不把主题当作开工阻断项。

- 五个已采纳主题：`atlas-tint` 古典地图集淡彩／铜版，`historical-schematic` 专题图解／历史分区，`relief-shading` 地形晕渲，`ink-chinese` 旧图墨色／手绘，`modern-clean` 现代纪录片简洁。具体名称、用途、色板以当前提示与模块 API 为准。
- 人工已选 `brief.map_style` 时，绝不修改、替换或在 inferred 里提议其它主题。
- 新需求 `map_style:null` 时可按题材提议主题，写入审核 JSON 的 `inferred`：`{"field":"map_style","value":"historical-schematic","basis":"以迁徙与领土分区为主题，适合弱化无关地形","confidence":"high"}`。理由必须非空，value 必须是合法主题 id；低置信度提议不采纳。
- 新任务创建入口保证初始化为 `map_style:null`；缺字段专指既有旧任务。服务端 `judgeBrief` 只在当前值仍为 null 时，自动采纳 high/medium 且 id 合法、basis 非空的建议：写回 `brief.map_style`，并在 `brief.inferred` 保留该条理由。low 不采纳。之后任何已选值（包括先前 AI 建议）都保持不变；并发人工修改使原审核结果过期，不得覆盖新值。
- 默认在底图阶段解析并写入 `map_spec.style.map_style`；后续底纹与 drawing 使用该值，避免中途改模块默认导致同次产物混用主题。
- 不提议时使用模块 `default_style`（初值 atlas-tint）。旧需求没有 map_style 字段时保留其 archival / clean / ink；不借审核偷偷迁移旧任务的样式。
- 主题决定后，绘制使用主题默认线型、点标记与标签层级；**不要逐层手调**。只在明确的叙事强调时覆盖单层样式。
- 主题不改变几何或证据。relief-shading 不能凭空补造真实地形；旧图参考不能作为古代疆界的证据。

正例：新建领土迁移示意图，提议 historical-schematic 并解释叙事理由；审核只记录主题，不输出每层手写样式。

反例：用户已选 modern-clean，却以「历史题材」为由改成 atlas-tint；或仅写「更好看」而不解释题材适用性；或把缺少主题列入 missing 阻塞需求。
