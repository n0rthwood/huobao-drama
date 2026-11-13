---
name: map-workflow-research
description: 地图工作流·资料检索阶段 — 用真实检索工具找资料，逐字引用出处，提交带依据的地理要素；被拒收时逐条修正
---

# 地图工作流：资料检索

你要为一张历史地图找资料，并提交地图上需要的地理要素（地点、路线、示意范围）。检索、阅读、取舍都由你来做；代码只会检查你交付的东西，**不会替你修正任何一个字段**。

## 工作方法

1. 用 `search_sources` 检索。`wikipedia-zh`、`wikipedia-en`、`europeana`、`smithsonian` 四个来源**每个至少检索一次**，零命中也算检索过。维基用条目名或关键词；Europeana 和 Smithsonian 用英文。命中会登记为 S1、S2…
2. 用 `search_dataset({layer,query,bbox?})` 找离线 **Natural Earth（公有领域）**原始几何。layer 为 `river/lake/coast/mountain/physical_region/place`；山脉用 mountain，平原/高原/沙漠等用 physical_region。多语名称、大小写、变音和连字符均参与匹配。河流 10m 优先（如 Tura），地名可找 Tobolsk，山脉可找 Ural Mountains / 乌拉尔山脉。每次查询都会登记在 `research.dataset_queries` 供缺失声明核对；结果最多 10 条，带稳定 ref、名称、类别、bbox、顶点数、长度/面积。按名称和范围核对后采用，不要自己描河。
   - **河流/湖泊优先用组引用 `ne-group:…`**：Natural Earth 把一条河拆成 `River` 要素加若干 `Lake Centerline`（水库段）要素，单个 ref 只含其中一段，裁剪后会碎成互不相连的碎片。带 `group` 字段的候选覆盖同名同 rivernum 的全部要素，代码把端点相同或相差不超过 0.01°（约 1.1 km，4K 画幅上约 1 像素）的链首尾相接成一条河，只追加原始顶点、不插入新顶点，每个被缝合的接缝都计入 `group.joined_parts`。
   - 组候选的 `group.chains` 是拼接后仍不连通的链数，`group.shortest_chain_km` 是最短链长度。链数多、短链很短（例如支汊或另一处同名河段）说明 clip_bbox 该收紧；**代码不会静默丢弃任何链或顶点**，要排除就显式收紧 `clip_bbox`。真实地理间断（例如河口三角洲分汊）本来就该保持分开。
3. 需要逐字引用时先 `read_source`，从读到的正文复制原句。除坐标外，还要抽取距离、方位、近河等相对位置证据。
4. 用 `submit_features({extent,features,relations?,uncertainties?,notes?})` 交付。`extent=[west,south,east,north]` 必填，依据地域与资料；经度左右各留 `(east-west)×2%`，纬度上下各留 `(north-south)×2%`，全部顶点包括已确认几何都必须落在留边后的范围内。每次交付消耗一轮，本阶段共 3 轮。
5. 如果问题出在需求本身（例如时代、地域写错），而本阶段无法解决，调用 `request_rollback` 回到 `brief`，写清原因。

## 要素字段（每一项都要写对，不合格整批拒收）

| 字段 | 要求 |
|---|---|
| `kind` | `place`（单点）/ `route`（线）/ `region`（面） |
| `name` | 要素名称，同类不重名 |
| `category` | 必填：`river/lake/coast/mountain/settlement/route/territory/other`，与 kind 分别表达地物类别和几何形状 |
| `geometry_source` | 必填：`dataset/source/model`；声明几何来源，不等于核验通过 |
| `dataset_ref` | dataset 必填 `{ref,clip_bbox?}`；**不得再写 points/lon/lat**。河流/湖泊用 `ne-group:…` 组引用，单个 `ne:…` 只覆盖一个原始要素。代码提取原始顶点，裁剪只取实际几何、不平滑；拼接后仍不连通的河段会拆成同 id 前缀的独立线条，代码不会替你删掉任何一段 |
| `dataset_missing` | 自然要素找不到时写 `{queries:[\"实际查过的检索式\"],reason}`；必须先真正查过 search_dataset，不能明有同名候选却声称缺失。接受后标 needs_user，不会自动进入成图 |
| `acknowledge` | 可选 `[{code,reason}]`，code 为实际返回的 `relation_conflict` 或 `lon_lat_similar`。必须有实质理由；不是确认几何，结论与理由原样交给用户，仍阻断自动出图 |
| `lon` / `lat` | **只有非 dataset 的 place 写**，WGS84 十进制度数字，不能用占位符或 (0,0)；route/region 不写 |
| `points` | **只有非 dataset 的 route/region 写**：`[[经度,纬度],...]`；线至少 2 个不同点，面至少 3 个不共线点 |
| `coordinate_basis` | 每条必填（包括 dataset）：`excerpt` 原句支撑 / `well_known` 公认位置 / `approximate_schematic` 示意；dataset 的实际核验依据仍是 ref |
| `supporting_excerpt` | basis 为 `excerpt` 时，必须从所引来源里**逐字复制**原句，至少 6 个字 |
| `source_ids` | 非 dataset 至少引用一条本阶段来源，如 `["S3"]`；dataset 可为空数组 |
| `basis` | 每条必填，用一句话说明坐标怎么来；dataset 写所选数据集与地物 |
| `uncertainty` | 每条必填 `high/medium/low`，拿不准写 high；approximate 为可选布尔值 |
| `conflicts` | 不同来源给出的位置不一致时写在这里：`[{source_id, lon, lat, note}]`，不要自行取舍 |
| `far_from_others_reason` | 只在该要素确实远离其它要素时填写，说明依据 |

## 硬规则

- 自然要素 river/lake/coast/mountain 必须取自 dataset，只有合格的 dataset_missing 才可交用户裁决。真实数据集面（如山脉/湖泊）不受示意图开关限制；非 dataset 面仍必须开启示意图模式。
- 历史疆域、辖境不得凭几个地点随意圈出来。
- 坐标明显离群（例如抄了占位值，或填错半球）会被拒收：核对后改正；确属远处的要素，填写 `far_from_others_reason`。
- 已由人工确认的要素不能改写，也不要再提交。
- `uncertainties` 列出读者需要知道的不确定之处，`notes` 写其它说明。

## 相对位置与核验

顶层 `relations` 为 `[{id,subject,object,relation,value_km?,tolerance_km?,excerpt,source_id}]`。subject/object 用本次要素或已核验/人工确认要素的**名称**，引用的名称必须能唯一定位，重名应先明确区分。要素 id 由代码在接受后生成，后续作图用提示里给出的 id。relation 为 `distance_km/east_of/west_of/north_of/south_of/near_river`。距离需 value_km；容差如实声明。excerpt 必须逐字出自 source_id 正文，不能自己写推理句冒充来源。

- 距离偏差大于 `max(tolerance_km,声明距离×30%,5km)`、方向相反，或 near_river 离数据集河道超过 `max(tolerance_km,15km)`，返回 `relation_conflict` 并给出计算值。
- 非 dataset 点的 `|lon-lat|<0.25°` 返回 `lon_lat_similar`；extent 外若互换后在范围内，则硬拒收「疑似经纬度互换」。
- 修正真实坐标可以消除冲突；确有理由不改时用 acknowledge 明确 code/reason，接受的仍是**待人裁决**状态，不能当已核验。
- 已核验仅来自数据集、逐字引文中可解析且与该点相差≤0.1°的经纬度，或与已核验/人工确认要素之间有逐字引用且计算一致的关系。经纬度支持 `68.4°E 58.1°N`、东经/北纬前缀及度分秒；度分秒按 `度+分/60+秒/3600`，西经/南纬取负，坐标顺序始终 `[lon,lat]`。只引用地名、well_known、示意位置都不足以核验。
- 例：喀什里克 (58.2,58.16) 与数据集 Tobolsk 声称约20km会冲突；核实后改为 (68.4,58.1)，原文确称约20km且明确 tolerance_km=10 时关系可一致。不要改写原文或无限扩大容差来掩盖错坐标。
- 未核验/冲突/needs_user 在 research 结束处以 `geometry_unverified` 阻断；用户需在研究面板确认所选/全部、编辑或删除。**用户确认的持久化动作是通过带修订号 CAS 的 PUT map_spec 去掉 proposed**；人工新增/移动为 manual+confirmed。模型不能代替用户确认。base/drawing/交付都会再次检查，drawing 的 omitted 不能绕过此门禁。

