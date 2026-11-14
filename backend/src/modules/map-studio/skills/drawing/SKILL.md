---
name: map-workflow-drawing
description: 地图工作流·服务器草稿作图 — 小工具精确添加要素，排布标签、预览看图后交付；不传地理顶点
---

# 地图工作流：用图层文档作图

这张图由你来设计，但**要素几何永远留在服务器**。不要复制、发送或重写经纬度/投影顶点。服务器维护一份 LayerDoc 草稿，跨本阶段交付轮次保留；你用小工具增删改图层，预览、最终成图、人工编辑器共用渲染链。非法修改整笔拒收，原草稿保留，错误逐条回给你。

## 工作流程与工具

1. 从提示中的要素摘要选择主体，调用 `add_feature_layers({items:[{feature_id}]})`，**默认不要逐层写 style**。服务器按当前主题与 category 套用河流、海岸、路线、山地、区域与点样式；河流投影长度达到画面对角线 45% 时为主河，否则为支流。点默认 city；确有重要度依据时可传 `importance:"capital"|"city"|"settlement"`。单层 `style` 是覆盖补丁，仅用于明确的叙事强调。服务器精确投影存储几何，place→marker、route→polyline、region→polygon，自动锚定。marker.text 初始为要素名称。断段各自添加，不得桥接；响应只有 id、bbox、点数与样式，没有长顶点数组。
2. 标题及标签优先用 `add_label({tier:"title"|"region"|"city"|"river"|"note",text,box:{x,y,w,h},feature_id?})`：服务器套用主题的字号、字体、斜体、文字光晕与颜色；`style` 可按需覆盖。有 feature_id 时锚定要素，省略则是未锚定标题/说明。card、图例、画框等用 `add_layer({layer:{...}})`，公共字段必须完整。手画线面最多 200 点；要素几何只能用 add_feature_layers。
   add_feature_layers / add_label 快捷工具由服务器补齐公共字段，style 是与主题默认合并的补丁。点已有 marker.text；若另加同一点的 city 标签，先用 `update_layer({layer_id,patch:{text:""}})` 清空 marker 旁注，避免重复地名。
3. 用 `update_layer({layer_id,patch:{style:{...},box:{...},text:...,name:...,z:...,visible:...,opacity:...,rotation:...,fields:{...}}})` 小补丁修改。只传要改的字段，style 是合并补丁；type/anchor/id 不可改。锚定要素的 points/at 修改及非零 rotation 会整笔拒收，原草稿保留；非要素手画小形状可 patch.points/at（仍最多 200 点）。`remove_layer({layer_id})` 删除图层；删掉必画要素后仍须补回或在交付时说明 omitted。
4. `get_draft({include_points:false})` 查看草稿摘要与当前 layer_options；include_points 只影响手画非要素的小形状，**要素几何始终不返回顶点**。不要请求/输出完整 LayerDoc，也没有全量文档交付工具。
5. 调用 `auto_layout_labels({})` 在当前草稿贪心避让：点标签按 E、NE、SE、W、NW、SW、N、S，线标签优先最长段旁，面标签优先最大内切圆中心附近。标题、card、锁定标签不动；不删除、不缩字。返回 unresolved 表示没有可用候选，必须人工设计位置或修改 box/内容，不能当作成功。
6. `set_smoothing({layer_id,smooth:0..1})` 控制线面渲染平滑，详见下节。参数独立存入 `outputs.layer_options`，**不要塞进 LayerDoc 或 layer.style**。
7. `render_draft({})` 预览（不消耗轮次），返回成图 path 与 submit_check。用 `read_image({path,question})` 看实际图，检查底图可读、标签清晰、主题突出。修改草稿/平滑后必须重新预览。
8. 满意后 `submit_draft({omitted:[{feature_id,reason}]})` 交付**当前、已预览且未再改动**的草稿，消耗一轮，共 3 轮。几何/平滑/五类标签问题任一存在都会拒收；按错误修正后重新预览交付。
9. 底图不能用时 `request_rollback({stage:"base",reason:...})`；要素资料有错则回到 research。代码不替你猜经纬度，不把错误结果降级交付。

## 平滑：只改渲染副本

向心 Catmull-Rom（α=0.5）经过全部原始控制点，面闭合，线端点不外推。逐点模型/人工线面默认强度 1，dataset 默认 0；0 表示关闭。强度缩放曲线相对原折线的偏离，**不改存储顶点**。每段最大偏离必须 ≤ max(6px、画面长边×0.004、该段长度×0.12)，超出即 `smoothing_deviation` 拒收。你须用 set_smoothing 明确调低强度或关闭，再预览；代码绝不自动改强度。dataset 建议维持 0，避免偏离真实密集几何。输出 semantics 的线面取实际渲染曲线，editable_source 同时保留控制点与 layer_options。

## 交付标准

- 每个未在 `submit_draft.omitted` 中说明的要素都要有一个锚定几何图层（由 add_feature_layers 自动生成）。omitted 不是 LayerDoc 字段；没有可见几何的要素才可省略，不能同时画出和省略。
- **底图必须看得见**：有效不透明度（`opacity × fill_opacity`）≥0.5 的 polygon 合计不能盖住超过 30% 的画面。画框或边框请用 polyline，或者把 polygon 的 `fill_opacity` 设为 0、只保留描边；不然 polygon 会被填成实心，把整张底图盖掉。
- 几何必须贴合要素投影位置。add_feature_layers 保证原始精确投影；update_layer 不接受锚定要素的几何补丁。几何有误回退 research/base，人工确认的几何不能被模型覆盖。
- 确实不画某个要素时，在 `omitted` 里写 `{feature_id, reason}`，说明理由。
- 文字标签用 `label` 图层，可以锚定到同一要素（`anchor.semantic_id` 写要素 id）。标签不算几何图层。
- base 由服务器创建且不可修改；取景/底图有问题必须回退。
- `label_overflow` 是严格拒收项，预览交付和人工保存同口径。宽字=1em、空格=0.33em、其它=0.55em，行高=1.35em；label 有底板时四周留 0.3em。按实际宽度换行后，所需行数/高度不得超过 box，box（含旋转）不得越出画面。card 使用固定模板的字号和行位置，长标题不能横向穿出底板。错误会说明图层 id、需要的行数/高度与 box 高度；你必须调整 box、字号或内容，代码不会自动缩字或截断。
- 例：50字标题塞进 `box.w=0.2,box.h=0.03,size=0.03` 会被拒收；扩大标题底板并合理安排字号后重新预览。不要忽略错误、删校验或把标题隐藏来交付。
- `label_overlap`（文字包围盒相交）、`label_marker_overlap`（文字盖住其他要素点标记）、`label_out_of_frame`（含 1% 安全边越界）、`label_far_from_feature`（文字包围盒离其锚定的点/线/面超过画面对角线 6%）同为硬拒收。文字 bbox 使用与 layer-svg 相同的固定宽度/行高/基线模型，含旋转；marker 的旁注和 card 文字也检查。未锚定的标题不检查“远离要素”，但仍检查碰撞与越界。人工编辑保存和最终交付同口径。
- **底板遮挡也是硬拒收**：带底板的 label（`bg_opacity>0`）和 card 如果画在别的文字、点标记或其它要素的线之上（绘制顺序在它们后面），会以 `label_overlap` / `label_marker_overlap` 拒收（消息写明被盖住的图层）。标题、图例、说明卡要放在不压任何要素的空白处；图例条目写在图例底板**之上**（z 更大）是正常排版。自己要素的标签底板压住自己的线不算。
- 正例：两个标签同位 → auto_layout_labels → unresolved 为空 → render_draft 看图 → submit_draft。反例：把「喀什里克」放在远处乌拉尔山内部，即便文字未溢出，仍以 label_far_from_feature 拒收；不能隐藏/删掉标签、缩字或忽略 unresolved 来冒充完成。
- 数据集不连通的河段已拆成同 id 前缀的多条路线，每段各用一个对应 id 的 polyline，不能拿跨空白的直线把它们硬接起来；存储的原始地理顶点不做平滑。
- `geometry_unverified` 在开始 drawing 和交付时再次检查；若出现待确认几何，用户应先在研究面板确认（去掉 proposed）、编辑或删除。不能通过隐藏图层或 omitted 绕过核验。

## 非要素图层格式（add_layer；严格，不写未知字段）

坐标都是**归一化值**：x 按画面宽、y 按画面高算，必须在 0–1 之间。所有尺寸（字号、线宽、点半径）都按**画面高度的比例**写，例如 0.03 表示画面高度的 3%。

新增一层示例（位置与内容按实际需求设计，不是默认样式规范）：

```json
{"layer":{"id":"title","type":"label","name":"标题","visible":true,"locked":false,"z":20,"opacity":1,"rotation":0,"box":{"x":0.05,"y":0.05,"w":0.5,"h":0.1},"text":"地图标题","style":{"size":0.04}}}
```

五个主题家族都已采纳：atlas-tint、historical-schematic、relief-shading、ink-chinese、modern-clean。当前主题摘要由服务器提供。新任务 map_style:null 跟随模块默认（atlas-tint 初值），brief 阶段可自动采纳有理由的 high/medium 合法建议并写入 map_style 与 inferred；没有 map_style 字段的既有旧任务仍沿用 archival/clean/ink。默认在 base 阶段写入 map_spec.style.map_style，drawing 使用该解析值，LayerDoc theme 取家族的 theme_mapping。不另传 style_spec。人工已选主题不得改；需要提议时说明题材适用理由，回到 brief 确认/记录，不在 drawing 中偷偷换主题。默认用主题，**不要逐层手调**。

正例：区域河网图使用主题默认色，批量 add_feature_layers 只写 feature_id，再用 add_label 的 river/city/title 档位排字。反例：先给每条河流手写字号线宽、随后逐层改色，这会增加调用且破坏主题一致性。地形晕渲主题只提供样式，不能借此凭空画山或伪造地形。

**每个图层都必须写**这些公共字段：
`id`（全文档唯一）、`type`、`name`（非空，最多 60 字）、`visible`（布尔）、`locked`（布尔）、`z`（0–9999 的整数，服务器维护 z 排序）、`opacity`（0–1）、`rotation`（-360 到 360；锚定要素必须为 0）。
`anchor` 可选：`{"semantic_id": "要素 id", "semantic_name": "要素名称"}`，只写这两个键。

各类型的字段：

| type | 必需字段 | style 可用键（都可省略，写了就必须在范围内） |
|---|---|---|
| `polygon` | `points`：至少 3 个 `[x, y]` | `fill`、`fill_opacity` 0–1、`stroke`、`stroke_width` 0–0.05、`dash`（none/dash/dot） |
| `polyline` | `points`：至少 2 个 `[x, y]` | `stroke`、`width` 0–0.05、`dash`、`arrow_end`、`arrow_start`（布尔） |
| `marker` | `at`：`[x, y]`；`text`：点旁文字（不需要时写 `""`） | `dot_radius` 0–0.1、`color`、`text_color`、`stroke`、`size` 0.005–0.5、`font`、`bold`、`label_offset` 写 `[dx, dy]`（各在 -0.5 到 0.5） |
| `label` | `box`：`{x, y, w, h}`（x、y 在 0–1，w、h 在 0.005–2）；`text` | `font`、`size` 0.005–0.5、`color`、`stroke`、`stroke_width` 0–0.03、`bg`、`bg_opacity` 0–1、`align`（left/center/right）、`bold`、`italic`、`shadow` |
| `card` | `box`；`template`（name/year/chapter）；`fields`：`{title, sub, meta, years}` 四个键，每个最多 60 字 | `font`、`scale` 0.4–2.5、`bg`、`bg_opacity`、`color`、`accent`、`align` |

- 颜色写成 `#rrggbb` 这样的字符串。字体（font）取 `sans`、`serif`、`kai`、`hand` 之一。
- 文字只能用常用汉字、英文字母、数字和常见标点；生僻字没有字形，会渲染失败。
- 一份文档最多 60 层。非要素手画线面最多 200 点；只有服务器投影并验证精确性的已存储要素几何可超过通用 LayerDoc 的 240 点限制（含数据集及人工确认的密集几何），所有路径保留全量顶点，模型不传这些点。
- marker 的 `color` 是点的填色，`text_color` 是点旁文字的颜色，`stroke` 同时是点的外圈和**文字描边**的颜色。描边应该用与文字反差大的浅色（例如底色 `#f4ecd8`）；如果描边和文字都用深色，粗体字会糊成一团。label 的 `stroke` 和 `stroke_width` 也是文字描边，用法相同。

## 作图建议（不是校验项，由你判断）

- 主体要素（例如运河主线）用醒目的颜色和较粗的线；背景或参照要素弱化处理。
- 标签不要盖点、互相叠字或离锚点太远；先用 auto_layout_labels，再按 unresolved 逐条设计。不要把“缩字号/删除标签”当作自动避让。
- 示意性质的要素要让读者看得出来，例如用虚线，或在标签里写明「示意」。
