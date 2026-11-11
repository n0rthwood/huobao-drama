# 模板文本框设计定稿（Issue #96）

纪录片图层段与剧集 Poster 的文字图层由「类型 × 成套位置 × 容量」决定，AI 与用户只选类型、填字段。

- **机器规范（唯一事实来源）**：`backend/src/config/layer-text-spec.json`；排版/容量/检查引擎
  `backend/src/services/layer-text.ts`（前端同源 `frontend/app/utils/layerText.js`）。
- **设计文档**：`DESIGN.md`（语料归纳、类型库、写作规则、成套位置、同屏节奏、AI 填写规则）。文中提到的
  `out/report.json` 是设计阶段原型渲染器的产物；产品里的容量一律由引擎 `textCapacity()` 现算，
  与原型逐项一致（`backend/tests/layer-text.test.mjs` 覆盖全部套 × 类型）。
- **评审记录**：Astra（`openai-codex/gpt-5.6-terra`）设计，Fabel（`anthropic/claude-fable-5`）按预登记评分表
  `reviews/JUDGE-rubric.md` 只看渲染图打分：第 1 轮 7.5 → 第 2 轮 8.1 → 第 3 轮 8.4 PASS；Astra 复核终裁
  `reviews/astra-review-of-fabel.md`（同意 11、部分同意 2）。
- **对比图**：`images/`（现状 vs 新规范、16 套版式最坏尺寸线框）。

## 适用前提

- 横版规范用于宽 ≥ 高的成片（16:9、4:3、1:1）；竖版规范用于 9:16、3:4。**1:1 沿用横版规范，不含竖屏平台按钮避让**。
- 竖版安全区（x 11.1–88.9%、y 15–65%，右侧按钮栏 x>72.2% 且 y>43.75%）为抖音 / Reels / Shorts 官方模板并集；
  视频号、小红书无公开界面规范，该区域在每一边都严于可查到的跨平台最保守参考线（顶 14%、底 25%、侧 6%、按钮列 16%），
  不声称为平台官方数据。
- 不做按底图明度自动换样式：浅底可读性靠固定的纸白字 + 深墨描边/投影 + 局部柔光压暗，保证编辑器预览与服务端成图同源。
