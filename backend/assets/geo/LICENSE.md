# 地理底图数据来源与许可

本目录的 GeoJSON 全部来自 **Natural Earth**（1:50m / 50m 与 1:10m / 10m 比例尺），
由 Natural Earth 声明为 **公有领域（Public Domain）**：
> All versions of Natural Earth raster + vector map data found on this website are in the public domain.
> You may use the maps in any manner, including modifying the content and design, electronic dissemination,
> and offset printing. The primary authors, Tom Patterson and Nathaniel Vaughn Kelso, and all other
> contributors renounce all financial claim to the maps and invites you to use them for personal,
> educational, and commercial purposes. No permission is needed to use Natural Earth.

官方说明：https://www.naturalearthdata.com/about/terms-of-use/

## 文件与下载来源（GeoJSON 由 nvkelso/natural-earth-vector 仓库分发）

### 50m 基础底图（2026-11-05 入仓）

| 文件 | 来源 URL |
| --- | --- |
| `ne_50m_land.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson |
| `ne_50m_coastline.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_coastline.geojson |
| `ne_50m_rivers_lake_centerlines.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson |
| `ne_50m_lakes.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson |
| `ne_50m_admin_0_countries.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson |
| `ne_50m_admin_1_states_provinces_lines.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces_lines.geojson |
| `ne_50m_populated_places.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places.geojson |

### 10m 精度数据集与地理区域多边形（Issue #99 阶段②，2026-11-13 入仓）

| 文件 | 来源 URL | SHA-256 | 用途 |
| --- | --- | --- | --- |
| `ne_10m_rivers_lake_centerlines.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_rivers_lake_centerlines.geojson | `bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a` | 数据集检索的河流主源（10m 优先）：50m 缺 Tura、Chusovaya 等支流；regional/site 底图也改用这层，保证「数据集取来的河道」与底图河道是同一套几何 |
| `ne_50m_geography_regions_polys.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_geography_regions_polys.geojson | `33396643d8f0eed408e80bf5ca43dcdb7993f790fdc4eadae311660f8b91fe76` | `mountain`（Range/mtn，如 URAL MOUNTAINS / 乌拉尔山脉）与 `physical_region`（Plain/Plateau/Desert/Basin…）图层 |
| `ne_10m_populated_places_simple.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson | `fd3fa867a320cbd5c5b6bb5bc550afeec2939fb2cef688e508007282a55ac42f` | `place` 图层主源（10m 优先）：比 50m 多出托博尔斯克（Tobolsk, 68.264815 / 58.199793）等中小城市；4.9 MB，低于 10 MB 体积上限 |

新增三份文件均为**原样入仓**：未做几何简化、平滑或坐标裁剪；
`backend/src/modules/map-studio/geo/datasets.ts` 在加载时按上表 SHA-256 校验，
不一致就报错（避免文件被替换后检索结果与出处记录不符）。

下载日期：2026-11-13。

注意：`ne_50m_admin_0_countries` / `ne_50m_admin_1_states_provinces_lines` 是**现代**行政边界，
纪录片里涉及历史疆域时只能当参考底稿，不得直接当历史地图使用；
`ne_50m_geography_regions_polys` 的山脉/高原多边形是**自然地理**范围，不是历史政权疆界。

## 几何抽取与底图精度口径（Issue #99 阶段②）

- 引用 `ne:<文件简名>:<features 数组下标>` 以原始文件顺序为准，原文件不可重排。
- 检索优先 10m，50m 补足未命中的名称；同文件同名的 River / Lake Centerline 分别保留引用，
  River 优先展示，不把同名要素合成一个不再可追溯的引用。
- 不裁剪时逐个保留原始顶点。河流仅按**完全相等**的端点拼接；接缝的两份原始顶点均保留，
  不连通的链仍为独立 parts，绝不跨空白拉直线。
- `clip_bbox` 采用**原始顶点游程裁剪**：包含边界点，返回框内所有能构成线/面的连续游程；
  不插入交点，不平滑。面的游程用自身首个原始顶点闭合，多个游程分别返回。
  因此它不是 GIS 线段/多边形与矩形的精确交集；没有足够原始顶点时明确报「裁剪后为空」，
  让模型扩大范围。所有保留坐标值仍与源文件逐字相等。
- 含内环（孔洞/岛屿）的面不能由现行 MapSpec region 完整表达，抽取明确拒绝，
  不静默填洞或丢内环。多面各自的无孔外环分别返回；乌拉尔山脉为单外环，不受限制。
- regional/site 程序底图使用 10m 河流；legacy/overview 使用 50m，除非已采用的河流引用要求
  10m，此时 overview 也改为 10m。已采用的 50m 河流与所选 10m 底图冲突时明确拒绝，
  要求更换同源引用或改 overview（且不能同时含 10m 引用），不混画两套河道。
  产出 `provenance.river_source` 记录实际文件名、精度、选择原因及 SHA-256。


## 其它既有下载

下载日期：2026-11-05。文件为原样入仓，未做任何几何简化或精度裁剪（扩散模型会改写海岸线/河道，
确定性底图必须保留原始几何，见 `backend/src/modules/map-studio/geo/base-render.ts` 头注释）。

新增背景数据下载日期：2026-11-05；同为上述公有领域授权，原样离线入仓，无运行时下载。
SHA-256：
- admin_1_states_provinces_lines：`72cca93c850d412628a5da4bc5ebfe21ba4d376eb34611bde6b623ee73f0fdcf`
- populated_places：`da4662b7bbfeb897d02f228c5839131dce27acff5717630f91ccff4f67828ee7`

这两层**仅作现代定位参照**，不表示古代行政边界，也不成为已审核的历史地点。
50m 数据不是城市街道详图：安阳近景 bbox `[114.2,36,114.5,36.2]` 内有 1 条省界、0 个城市点；
既有豫北测试 bbox `[113,35.2,115.6,36.8]` 内有 5 条省界、1 个城市点（邯郸，不是安阳）。
渲染结果会回报实际覆盖数与缺层警告，不能填造缺失细节或宣称包含安阳城市背景点。
