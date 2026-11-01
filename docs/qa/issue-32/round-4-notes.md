# Issue #32 — 画像转外貌、审定名册与补充质量验收

## 结论

工程链路已补齐，**图像质量验收仍未全绿，本 Issue 不应标为全部通过或关闭**。
本次新增链路后的图像验证只做了 **1 轮**（沿用目录编号 round-4，不是把旧三轮算作新链路的迭代）；
在要求收尾时停止，不声称达到「模型上限」：A4 仍有读图错误，且没有两轮新链路无改善的证据。

## 1. 基线与隔离

分支已 rebase 到 `origin/master` **35a62cf**（#34 资产名规范化）；重放后的两笔既有提交为
`494ac06`、`2e52a36`，新增第一笔实现为 `306bf3c`。
冲突仅为 extract-tools 的两个新增 import，保留两者；引入 #34 后，citation 名字比较也去掉 `_`，
防止「带空格的检索名」对不上「空格已变下划线的资产名」。

所有生成、重提取与 UI 操作均在隔离数据库副本；静态目录为真实副本，不是 live symlink。
覆盖复跑又各用一份独立 SQLite 备份；副本中的活动媒体任务标为 failed，防止重复消费远端结果。
未操作 live DB、未重启 pm2、未合并或推送 master。

## 2. 人可操作的画像 → appearance

角色详情 → 史料参考 →「按史料画像补充外貌」。
无画像时禁用并提示先入库；完成后外貌文本立即回填，旧最终提示词及来源标记清空，需重新生成提示词。

接口：

- `POST /characters/:id/appearance-from-portrait {episode_id, text_config_id?}`：异步文本任务 `portrait_appearance`。
- `GET /characters/:id/appearance-from-portrait?episode_id=N`：按角色查询本次来源、模型、结果与错误；集号可选。

视觉配置按启用中的 text 配置优先级探测并缓存；本副本实测 GLM 5.3 对 image_url 返回400，
DeepSeek V4.1 Flash 1017 配置通过红/蓝/绿三色辨认测试，实际三个人物的任务均为
`source=vision, model=deepseek-chat`。没有使用禁用中的 Qwen 配置。
输入包含入库画像（最多两张、长边1024）、Commons元数据及 Wikipedia 正文；结果仅写 appearance，
出处写 research_citations，**不写 reference_images**。不可读图时明确显示文字资料路径。

UI 真正执行了 Peter 的 Commons 检索、入库、补充外貌、回填与提示词失效；过程中修好了
状态轮询漏传 episode_id 导致的400。截图已经逐张打开检查：

- `shots/13-portrait-appearance-done.webp`：模型、已更新提示、外貌与出处；
- `shots/14-portrait-appearance-disabled.webp`：Likharev无画像，按钮禁用；
- `shots/15-roster-review-draft.webp`、`16-roster-approved.webp`：名册编辑与确认。

编辑期间的热更新曾产生暂态 Vue 警告；全改动完成后清空 console 并整页 reload，
新 console 仅有 Vite/Suspense 信息与正常200请求，未再见 roster/isDocumentary 未定义警告。
`agent-browser errors` 返回空白错误条目，不能据此宣称整场历史错误计数为零。

## 3. 覆盖稳定性的真实边界

只有「先登记名册，再保存对账」仍不确定：首次三次独立副本为 **15 / 15 / 13**。
第三次名册本身漏了 S18 的受审者沃尔孔斯基、S23 的死刑判决当事人阿列克谢，
不是 save 工具漏写。原失败证据保留在 `coverage-verification.json`。

因此加入**持久、可人工编辑确认、绑定剧本指纹的名册契约**：

1. 资产页「选角名册」可编辑姓名、依据、理由并增删成员；AI首次只产生待复核草稿，不自动审批。
2. `GET/PUT /episodes/:id/character-roster` 保存 draft/approved 与当前 script_content/content 的SHA256。
3. 重提取读取有效名册，不重新裁定成员；未列入者不写入；别名归入既有成员；缺人回报对账。
4. 剧本改变后名册过期，须由人复核。单资产重新提取只核对该人物，不要求重做其余成员。

测试时将第一次真实AI运行的15人名册作为草稿导入副本，在 UI 查看依据、编辑姓名空白并点
「确认名册」；服务端按#34规范化，保存15人approved名册。随后从这份相同剧本与审定名册
复制出3份无角色行副本，分别重新提取：**15 / 15 / 15**，全部 completed，姓名集合均与
名册逐项相等。证据 `approved-cast-roster.json`、`approved-cast-verification.json`。

这证明的是**审定名册下重提取稳定**，不是声称AI首次自动选角天然确定。
四语纪录片技能、UI文案及任务类型标签同批更新；非纪录片路径不要求名册。

## 4. 画像身份核对与抽样

4角色：Peter（52）、Kangxi（54）、Alexei（59）、Likharev（51）；3场景与3道具均真实重提取、
经火宝提示词API生成后，用同一已配置Qwen图像模型生成，任务 **568–576、578**。
10个请求返回的 reference_images 全为空，全部最终提示词无来源URL；4角色均含特写+三视图+纯白格式。
详见 `round-4-manifest.json`、`round-4-field-checks.json`、`samples/round-4/`。

只有3组可信史料画像：Peter的Nattier摹本、Kangxi朝服像、Alexei的Tannauer系画像。
Likharev在本期允许的Wikipedia/Commons范围内未找到可信画像，不伪造第四组比对；协调者已同意此边界。
搜索得到的 `Portrait of Prince Matvey Gagarin.jpg` 实为 **Matvey Alexeyevich (1725–1793)**，
不是本集 **Matvey Petrovich (1659–1721)**：发现后立即从副本删除，未据其写appearance、未计分。
核对来源：<https://commons.wikimedia.org/wiki/File:Portrait_of_Prince_Matvey_Gagarin.jpg>。

## 5. 真正看图的外部评审（Astra fallback）

Fabel显式命令 `--model anthropic/claude-fable-5`（以及slow别名）均因Anthropic缺少API key/登录失效失败。
`completion(model='slow')`纯文本调用可用，但接口不接受图像内容块，故不把它冒充视觉评审。
按允许的fallback，用 **openai-codex/gpt-5.6-terra**，无工具、独立会话，实际附上13张图
（4角色、3场景、3道具、3原始画像）做严格成对比较；完整原文 `astra-round-4-review.txt`。
所有13张图也由执行者逐张打开检查。

| 指标 | Astra看图结果 | 本期判定 |
| --- | --- | --- |
| B1 | 4/4 | 格式保持通过 |
| B2 | 宽口径4/4；Peter答「高阶欧洲军政人物/受勋军官」，Kangxi答「东亚皇帝」 | Issue要求帝王/皇室/高级军事贵族；Peter答案不够明确，**不冒称严格B2双样本全通过** |
| B4 Peter | 髭须0、发型0、脸型0：0/3 | 未达标 |
| B4 Kangxi | 髭须1、发型不可判0、脸型1：2/3 | 达标 |
| B4 Alexei | 髭须0、发型1、脸型0：1/3 | 未达标 |
| B4合计 | 3/9 | 未达标；不能拿单个Kangxi通过替代全体 |
| A4 | 读图→字段的链路已执行，但Peter方长脸/浓髭、Alexei无髭等提炼仍有偏差；评审A4表部分又按渲染图而非原画像评价 | **不能确认≥90%**；需保留未通过 |

所以不能把B4失败单归因于生图模型：读图模型/提炼规则本身也仍有错误；本轮不足以断言文本级忠实已到顶。

### 第3轮规则的实际图像验证

- **年代限定词**：四角色未被评为明确穿越件；仍有影视道具化细节。
- **场景风化/使用痕迹**：木堡灰化开裂、盐尘已出现，但塔楼像悬空箱、支撑与墙体不可信；
  书房旧化弱，牙帐仍像整齐新搭旅游营地。评审场景小计5/10，非全通过。
- **白底无影**：鼓与火枪仍有投影，文书背景通过；不能只看prompt写了「无影」就给通过。
- **道具结构**：鼓可用；火枪通条落在枪托侧槽、全长前托/通条管/箍管不可信；
  文书虽有纸张蜡封，但伪拉丁花体不能当1719俄文谕令。评审道具小计3/9，非全通过。

## 6. 要求的检查

`test-comparison.json`保存规范化后的not-ok名称集合。

| 检查 | Issue分支 | 主检出 | 差异 |
| --- | --- | --- | --- |
| 后端 node --test tests/*.test.* | 147项：136 pass / 11 fail | 130项：119 pass / 11 fail | not-ok姓名集合完全相同 |
| 后端 tsc --noEmit -p . | exit0 | — | 类型检查通过 |
| 前端 node --test tests/*.test.mjs | 23项：5 pass / 18 fail | 23项：5 pass / 18 fail | not-ok姓名集合完全相同 |

抽出共用near-name函数后同步更新结构测试以检查新单一来源，而非保留对已删除私有函数的匹配。
没有把基线已失败的测试说成全通过，也未运行生产发布或合并。

## 7. 仍未满足的质量门槛

A4准确率、Peter/Alexei B4、Peter严格身份辨识，以及场景旧化/木堡结构、道具无影/火枪结构/俄文真实性
仍需后续规则与真实生成验证。此次用户要求收尾，因此没有启动第二轮，也没有补丁式修改任一资产输出。
代码功能、3次审定名册稳定性、重基线与测试比较均已有证据；**质量未达标必须保留为未达标**。

收尾：QA 浏览器已关闭，隔离主后端、3个覆盖后端及遗留隔离前端均已按各自服务句柄/PID停止。
