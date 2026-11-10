---
name: map-workflow-research
description: 地图工作流·资料检索阶段 — 用真实检索工具找资料，逐字引用出处，提交带依据的地理要素；被拒收时逐条修正
---

# 地图工作流：资料检索

你要为一张历史地图找资料，并提交地图上需要的地理要素（地点、路线、示意范围）。检索、阅读、取舍都由你来做；代码只会检查你交付的东西，**不会替你修正任何一个字段**。

## 工作方法

1. 用 `search_sources` 检索。`wikipedia-zh`、`wikipedia-en`、`europeana`、`smithsonian` 四个来源**每个至少检索一次**，零命中也算检索过。维基用条目名或关键词；Europeana 和 Smithsonian 用英文。命中会登记为 S1、S2…
2. 需要逐字引用时，先用 `read_source` 读正文，再从读到的文字里复制原句。
3. 整理要素后用 `submit_features` 交付。每交付一次消耗一轮，本阶段共 3 轮，所以交付前先自己核对一遍。
4. 如果问题出在需求本身（例如时代、地域写错，导致资料互相矛盾），而本阶段无法解决，调用 `request_rollback` 回到 `brief`，并写清楚原因。

## 要素字段（每一项都要写对，不合格整批拒收）

| 字段 | 要求 |
|---|---|
| `kind` | `place`（单点）/ `route`（线）/ `region`（面） |
| `name` | 要素名称，同类不重名 |
| `lon` / `lat` | **只有 place 写**，必须是真实的 WGS84 十进制度数字。不能写字符串、占位符或 `0`；route 和 region 不写这两个字段，或写 `null` |
| `points` | **只有 route 和 region 写**：`[[经度, 纬度], ...]`。route 至少 2 个不同的点；region 至少 3 个不共线的点 |
| `coordinate_basis` | `excerpt`：资料正文里确有原句支撑；`well_known`：现代地名的公认位置；`approximate_schematic`：只能给出大致方位的示意 |
| `supporting_excerpt` | basis 为 `excerpt` 时，必须从所引来源里**逐字复制**原句，至少 6 个字 |
| `source_ids` | 至少引用一条本阶段检索到的来源，例如 `["S3"]` |
| `basis` | 用一句话说明这个坐标是怎么来的 |
| `uncertainty` | `high` / `medium` / `low`，拿不准就写 high |
| `approximate` | 是否近似位置（布尔值） |
| `conflicts` | 不同来源给出的位置不一致时写在这里：`[{source_id, lon, lat, note}]`，不要自行取舍 |
| `far_from_others_reason` | 只在该要素确实远离其它要素时填写，说明依据 |

## 硬规则

- **示意图模式没开时，不要提交 region。** 资料确实描述了某个范围（例如湖泊、谷地），就改成一个 place：给出能代表它的经纬度（例如范围中心）并写明依据；否则就不画。
- 历史疆域、辖境不得凭几个地点随意圈出来。
- 坐标明显离群（例如抄了占位值，或填错半球）会被拒收：核对后改正；确属远处的要素，填写 `far_from_others_reason`。
- 已由人工确认的要素不能改写，也不要再提交。
- `uncertainties` 列出读者需要知道的不确定之处，`notes` 写其它说明。
