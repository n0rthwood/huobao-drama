# 地理底图数据来源与许可

本目录的 GeoJSON 全部来自 **Natural Earth**（1:50m / 50m 比例尺，Medium scale），
由 Natural Earth 声明为 **公有领域（Public Domain）**：
> All versions of Natural Earth raster + vector map data found on this website are in the public domain.
> You may use the maps in any manner, including modifying the content and design, electronic dissemination,
> and offset printing. The primary authors, Tom Patterson and Nathaniel Vaughn Kelso, and all other
> contributors renounce all financial claim to the maps and invites you to use them for personal,
> educational, and commercial purposes. No permission is needed to use Natural Earth.

官方说明：https://www.naturalearthdata.com/about/terms-of-use/

## 文件与下载来源（GeoJSON 由 nvkelso/natural-earth-vector 仓库分发）

| 文件 | 来源 URL |
| --- | --- |
| `ne_50m_land.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson |
| `ne_50m_coastline.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_coastline.geojson |
| `ne_50m_rivers_lake_centerlines.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson |
| `ne_50m_lakes.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson |
| `ne_50m_admin_0_countries.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson |
| `ne_50m_admin_1_states_provinces_lines.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces_lines.geojson |
| `ne_50m_populated_places.geojson` | https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_populated_places.geojson |

下载日期：2026-11-05。文件为原样入仓，未做任何几何简化或精度裁剪（扩散模型会改写海岸线/河道，
确定性底图必须保留原始几何，见 `backend/src/services/map-base-render.ts` 头注释）。

注意：`ne_50m_admin_0_countries` 是**现代**国界，纪录片里涉及历史疆域时只能当参考底稿，
不得直接当历史地图使用。

新增背景数据下载日期：2026-11-05；同为上述公有领域授权，原样离线入仓，无运行时下载。
SHA-256：
- admin_1_states_provinces_lines：`72cca93c850d412628a5da4bc5ebfe21ba4d376eb34611bde6b623ee73f0fdcf`
- populated_places：`da4662b7bbfeb897d02f228c5839131dce27acff5717630f91ccff4f67828ee7`

这两层**仅作现代定位参照**，不表示古代行政边界，也不成为已审核的历史地点。
50m 数据不是城市街道详图：安阳近景 bbox `[114.2,36,114.5,36.2]` 内有 1 条省界、0 个城市点；
既有豫北测试 bbox `[113,35.2,115.6,36.8]` 内有 5 条省界、1 个城市点（邯郸，不是安阳）。
渲染结果会回报实际覆盖数与缺层警告，不能填造缺失细节或宣称包含安阳城市背景点。
