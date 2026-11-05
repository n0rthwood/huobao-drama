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

下载日期：2026-11-05。文件为原样入仓，未做任何几何简化或精度裁剪（扩散模型会改写海岸线/河道，
确定性底图必须保留原始几何，见 `backend/src/services/map-base-render.ts` 头注释）。

注意：`ne_50m_admin_0_countries` 是**现代**国界，纪录片里涉及历史疆域时只能当参考底稿，
不得直接当历史地图使用。
