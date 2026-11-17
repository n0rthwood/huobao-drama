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

> Issue #107 阶段 1（2026-11-16）起，程序底图**不再画省界与城市点**：这两层只剩数据集检索
> （`search_dataset` 的 coast / place 图层）用途，底图只有自然地理。

## 底图渲染数据（Issue #107 阶段 1，2026-11-16 入仓）

底图（局部相对起伏晕渲 + 分级水系）用的矢量与高程数据：

| 文件 | 来源 URL | SHA-256 | 用途 |
| --- | --- | --- | --- |
| `ne_10m_land.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson | `1ac90796408bc6ad6911d69448485d3c4dbf2190370080368a09976e1c9f7416` | 陆海掩码：**用陆地多边形判定陆海**，不能用高程判 0（里海北岸低于海平面，按高程会画成海） |
| `ne_10m_lakes.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_lakes.geojson | `2d036f53dedec578001c5c30c2959ee7d4eebc1306900fa4367c49929ec8f2d9` | 湖泊填充与湖岸；`featurecla=Reservoir` 的现代水库（雷宾斯克等）一律剔除，否则会把 20 世纪水库画进 1480 年的地图 |
| `ne_10m_rivers_lake_centerlines.geojson`（既有） | 同上 | `bb854a900ecbd3b408df46d5e16e3e0f974ba55993f9d8b5c26e855273c0905a` | 分级水系：按 `scalerank` 分主干/次干/支流三档线宽，**整条河按名显隐**（避免一条河被剪成碎片） |
| `ne_50m_geography_regions_polys.geojson`（既有） | 同上 | `33396643d8f0eed408e80bf5ca43dcdb7993f790fdc4eadae311660f8b91fe76` | 山形符号落点：只在 `featurecla` 为 Range/mtn 的山脉多边形内 |

新增两份 10m 文件同样为**原样入仓**（未简化、未裁剪），SHA-256 由
`backend/src/modules/map-studio/geo/datasets.ts` 的文件表校验，不符即报错。

### 高程：AWS Terrain Tiles（terrarium PNG）

- 来源模板：`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`（公开，无需密钥）。
- 数据来源与署名：**Terrain data: AWS Terrain Tiles, SRTM / GMTED2010 / ETOPO1 (public domain)**。
- 编码：`h = R*256 + G + B/256 - 32768`（米），标准 Web Mercator 256×256 瓦片。
- 位置：**数据目录**（不入仓）`$HUOBAO_DATA_DIR/map-data/dem/<z>/<x>/<y>.png`，同目录
  `manifest.json` 记录每张瓦片的 URL、sha256、抓取时间与字节数。`provenance.relief` 会记 manifest 指纹。
- 预取：`node --import tsx scripts/prefetch-map-data.ts --bbox w,s,e,n`（只下缺失瓦片，并发 8、失败重试）。
  **渲染阶段只读本地缓存**：缺瓦片直接报出 `z/x/y` 与这条命令，绝不静默联网。

### 命名河流补充包：OSM（ODbL 1.0）

区域河流预取范围为东经 20–100°、北纬 40–70°，仅包括有 `name` 的
`waterway=river` ways；以同名且端点相连分组，并按 manifest 的容差简化。数据来源与署名：
**© OpenStreetMap contributors, ODbL 1.0**（https://www.openstreetmap.org/copyright）。

- 在 `backend/` 执行 `node --import tsx scripts/prefetch-river-region.ts`；Overpass 请求带自定义
  User-Agent，逐 1° 方块限速、重试，块数据保存在 `DATA_ROOT/map-data/osm-rivers/chunks/` 以便续抓。
  两块样本（56–57°N、60–62°E）在经纬度平面按 1° 跨度对应 3840 px 换算，0.0001° 最大偏差
  约 0.384 px；0.001°/0.002°/0.005° 分别约 3.84/7.68/19.19 px，因此选 0.0001°。
  这是该尺度的平面估算，不保证任意投影和更小取景框仍小于 1 px。
  同一样本在 Mercator、`fitExtent`、bbox `[55,51,68,61]`、3840×2160 下逐顶点投影到简化线的
  最大偏差为 0.0213 px；未超过细节图 2 px 阈值，不增加原始几何档。该数字不保证其他取景。
- 成品 manifest 记录来源、抓取时间、区域、简化容差、sha256、条数、字节数和 gzip 字节数。
  数据不超过 50 MiB 时放 `backend/assets/geo/osm-rivers/rivers.json`；超过时放
  `DATA_ROOT/map-data/osm-rivers/rivers.json`，仓库保留 manifest。读取顺序先仓库后数据目录。
  迁移：在真实区域包完成前保留旧版三河 v1（旧图仍可读取，研究阶段只查 NE 并提示预取）；
  区域包完成后先将完整数据与 v2 manifest 原子部署并校验 sha256，再删除旧的三个单河 JSON 和 v1
  manifest，禁止把仅两块的样本 manifest 当作全区数据部署。预取源是持续变化的数据，部署应复制
  与 manifest 对应的同一份数据成品；重新向 Overpass 抓取不能保证得到相同 sha256。
- 运行期只读、校验 sha256，不从 OSM 联网；缺失缓存时提示上述预取命令。新画中画细节版本
  记录各自来源与署名，历史版本不回写。

底图成品的署名（provenance.attribution）必须包含：
`Natural Earth（公共领域）· AWS Terrain Tiles, SRTM / GMTED2010 / ETOPO1（公共领域）`，
用到命名河流时再加 `· 河流补充 © OpenStreetMap contributors（ODbL 1.0）`。
