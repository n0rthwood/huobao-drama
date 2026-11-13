---
name: map-workflow-drawing
description: 地图工作流·标注绘制阶段 — 用 LayerDoc 矢量图层自己作图：预览、看图自检、交付同一份合法文档；渲染与图层编辑器同一条链
---

# 地图工作流：用图层文档作图

这张图由你来画。你写一份 **LayerDoc（图层文档）**，代码用**同一条渲染链**把它渲染成图。图层编辑器和最终成图也用这条链，所以你在预览里看到的，就是最终成图。代码不会替你排版，也不会修改你的文档：文档里只要有一处不合法，就会被逐字段指出并拒收。

## 工作流程

1. 先想清楚这张图要表达什么（用途见需求）：哪些要素是主体，名称标签放在哪里，配色和字号怎么定，标题或图例要不要加。
2. 写 LayerDoc，用 `render_layer_doc` 预览（不消耗轮次）。返回结果里有两项：
   - 成图路径：用 `read_image` 看图。检查底图上的海岸、湖泊、河流是否还清楚可见，标签有没有重叠或遮挡，字能不能看清，主题是否突出，有没有元素落在画外；
   - `submit_check`：按交付标准预先检查出的问题，改到没有问题为止。
3. 满意之后，用 `submit_layer_doc` 交付**和最后一次预览完全相同**的那份文档（消耗一轮，本阶段共 3 轮）。
4. 如果底图本身不能用（例如取景不对、要素不在画面里），调用 `request_rollback` 回到 `base`；如果要素数据本身有错，回到 `research`。回退时写清楚原因。

## 交付标准

- 每个未在工具参数 `omitted` 中说明的要素都要有**一个**锚定几何图层：`anchor.semantic_id` 等于要素 id。类型对应 place→marker、route→polyline、region→polygon。`omitted` 是 render_layer_doc/submit_layer_doc 的独立参数，不是 LayerDoc 顶层字段。
- **底图必须看得见**：有效不透明度（`opacity × fill_opacity`）≥0.5 的 polygon 合计不能盖住超过 30% 的画面。画框或边框请用 polyline，或者把 polygon 的 `fill_opacity` 设为 0、只保留描边；不然 polygon 会被填成实心，把整张底图盖掉。
- 几何必须贴合要素的投影位置：使用提示中的归一化坐标或 geo_to_pixel 换算；数据集路线不得平滑、偏移或桥接断段。图层顶点可在投影容差内表达已有走向，但不能修改存储的数据集原始顶点。
- 确实不画某个要素时，在 `omitted` 里写 `{feature_id, reason}`，说明理由。
- 文字标签用 `label` 图层，可以锚定到同一要素（`anchor.semantic_id` 写要素 id）。标签不算几何图层。
- `base` 原样使用提示里给的骨架（`path`、`width`、`height`、`source_width`、`source_height`），不能改。
- `label_overflow` 是严格拒收项，预览交付和人工保存同口径。宽字=1em、空格=0.33em、其它=0.55em，行高=1.35em；label 有底板时四周留 0.3em。按实际宽度换行后，所需行数/高度不得超过 box，box（含旋转）不得越出画面。card 使用固定模板的字号和行位置，长标题不能横向穿出底板。错误会说明图层 id、需要的行数/高度与 box 高度；你必须调整 box、字号或内容，代码不会自动缩字或截断。
- 例：50字标题塞进 `box.w=0.2,box.h=0.03,size=0.03` 会被拒收；扩大标题底板并合理安排字号后重新预览。不要忽略错误、删校验或把标题隐藏来交付。
- 数据集不连通的河段已拆成同 id 前缀的多条路线，每段各用一个对应 id 的 polyline，不能拿跨空白的直线把它们硬接起来；存储的原始地理顶点不做平滑。
- `geometry_unverified` 在开始 drawing 和交付时再次检查；若出现待确认几何，用户应先在研究面板确认（去掉 proposed）、编辑或删除。不能通过隐藏图层或 omitted 绕过核验。

## LayerDoc 格式（严格：写全字段、取值合法、不写多余字段）

坐标都是**归一化值**：x 按画面宽、y 按画面高算，必须在 0–1 之间。所有尺寸（字号、线宽、点半径）都按**画面高度的比例**写，例如 0.03 表示画面高度的 3%。

```json
{
  "version": 1,
  "base": { "path": "…骨架里的路径…", "width": 3840, "height": 2160, "source_width": 3840, "source_height": 2160 },
  "theme": "archival",
  "layers": [ … 按 z 从小到大排列 … ]
}
```

`theme` 取值：`archival` / `clean` / `ink`，按需求里的风格选。

**每个图层都必须写**这些公共字段：
`id`（全文档唯一）、`type`、`name`（非空，最多 60 字）、`visible`（布尔）、`locked`（布尔）、`z`（0–9999 的整数，数组顺序必须按 z 从小到大）、`opacity`（0–1）、`rotation`（-360 到 360）。
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
- 一份文档最多 60 个图层，每个 polygon 或 polyline 最多 240 个点。
- marker 的 `color` 是点的填色，`text_color` 是点旁文字的颜色，`stroke` 同时是点的外圈和**文字描边**的颜色。描边应该用与文字反差大的浅色（例如底色 `#f4ecd8`）；如果描边和文字都用深色，粗体字会糊成一团。label 的 `stroke` 和 `stroke_width` 也是文字描边，用法相同。

## 作图建议（不是校验项，由你判断）

- 主体要素（例如运河主线）用醒目的颜色和较粗的线；背景或参照要素弱化处理。
- 标签不要盖住点和线，也不要互相重叠；名字较长时放到空白处，用较小字号。
- 示意性质的要素要让读者看得出来，例如用虚线，或在标签里写明「示意」。
