# H3 原生提示词与参考编号核验（Issue #130）

## 为什么需要

已有四人车内关键帧正确，但自动扩写把参考编号对应错，视频仍换人、换座。episode 34 的任务 5066 实际 `refNameIndex` 中 William=3、Florence=4、Bill=5、Stella=6；持久请求却让 Picture 3 当驾驶员、Picture 4 当妈妈。这是提示词映射错误的实证，不能只归因于扩散模型，也不能把请求正确当成视频正确。

本说明补充现有接口与 adapter 能力，不新增 API、不切换模型或修改全局配置。制作角色仍只通过 hbwf 调产品 API，不直连供应商，不读写业务库。

## 先检查图像，再选择写法

1. 开实际生效首/中/尾帧与每张参考图，核验人数、身份、座位、成人尺度和物件接触。用户明确要求整集图像先通过时，必须完成该门槛才提交新视频；之后新增或更换图像应重新打开门槛，检查该镜及前后承接。Poster 按用户本轮要求审核，不将“所有项目先完成 Poster”扩大为通用视频前置条件。
2. 连续重试未奏效时，检查多视图参考与自动扩写的编号，不复制相同输入盲重试。可选产品内已有单人图，或以正确完整画面为唯一参考做小幅编辑；保留原版本。复杂换机位会造成身份漂移时，可在保留剧情、对白的前提下使用明确切镜与对应首帧，不靠人物变形完成转场。
3. 自动扩写能正确保持映射时继续使用常规描述。已证实扩写误认编号时，可人工编辑下面的原生格式；这仍经过产品的关键帧、签名、审核、预算与生成守卫。

## 原生格式（生产请求核验 [R]）

`services/adapters/h3-prompt.ts` 的 `buildH3Prompt` 检测到字面量 `integrated_multimodal_description:` 后跳过文本模型扩写，保留人工正文，仍由代码补首/中/尾帧对齐声明。不要手工编造对齐声明、实际量化时长或帧时间。

写入仍是 `PUT /storyboards/{id}` 的 `video_prompt`（也可浏览器保存后读回）；生成仍用 `POST /storyboards/{id}/generate-video` 或显式 ID 的 video-batch。示意文本（英语仅为本例对白，实际语言标记随原对白）：

```text
integrated_multimodal_description: [Shot 1] 3D CG animation. Fully preserve the two characters from <Picture 1>. S1 is the left child; S2 is the right child. The camera stays static. From 0 to 4 seconds, S1 raises one hand and says <d>[English] COOL!</d>. From 4 seconds to the end, S1 lowers the hand and S2 smiles. End on the last-frame guide.
overall_soundscape: Gentle room tone and light clothing rustle.
non_diegetic_music: N/A
```

按实际时长写连续动作；多镜切换用递增的 `[Shot N] At MM:SS.mmm, the camera cuts to ...`。角色外形以已读图片为准，文本只写动作、位置、视线、表情、运镜和声音。稳定用 S1/S2 指代同一人。对白保留原文、标点和语言；中文等其它语言不得套用 `[English]`。无对白就不添加台词。原生格式不保证模型遵循，也不豁免提示词结构检查、重新审核与成片检查。

## 编号：预计绑定与实际提交分别核验

- **提交前可见内容**：`GET /episodes/{e}/storyboards` 的实际 `keyframes`、`target_assets.video` 及其 `ref_no`、`video_prompt`、`transition_prompt`、`transition_enabled`。保存后重新读取；转场开启时也要检查转场的引用。这里是绑定/预期信息，**没有独立的最终扩写预览接口**。
- **构造顺序**（`services/storyboard-video.ts`）：生效首帧先入列表，占 Picture 1 但没有名字；随后是本镜实际视频目标绑定的场景、角色、道具，经 `indexRefs` 按 URL 去重。中间/尾帧是引导，不应擅自计作额外编号。不要从资产 ID、UI 显示顺序或另一任务复制编号；去重可能改变预期，必须逐镜计算。
- `@名字` 经产品映射；人工 `<Picture N>` 由作者负责对应。用完整首帧唯一参考时，按该图的前后/左右位置定义角色，不能把整幅图解释成某一个单人。精简引用后重新检查实际绑定，不因正文删了名字就假定额外绑定必然消失。
- **提交后证据**：`GET /tasks/{id}` 的 `params`（可能是 JSON 字符串）中 `referenceImageUrls` 与 `refNameIndex` 是实际参考列表与名字编号。白名单保存必要字段，避免凭据与认证 URL。核对正确后仍须打开成片检查。
- 该公共任务接口的 `remote_state` 可能只返回队列摘要，不保证有最终扩写全文；不得编造“已看扩写全文”。本案例维护角色用只读生产 DB 的持久请求作诊断，属于工程调查证据，不将 DB 路径或访问权限扩展给普通制作角色。缺少公开全文时如实标记证据不足，可选择人工原生正文后核验实际媒体。

## 返工与验收记录

提示词或绑定变化后记录 rework，重新 video_prompt_review；新图重新 keyframe_approval 与 confirm-keyframes。preview 返回全集时按本轮 ID 再过滤，不重出其它正确镜。发现映射已错且仍排队，可经产品取消并保留任务与原因，不能报成功或假称未计费。记录取消发生时的真实状态；不能从取消回执推断供应商收费为零。

记录项目/集/镜/任务 ID、保存读回、参考映射、实际已查看的帧、失败版本与请求证据。媒体检查至少包括首中尾、切镜/连续动作、人数身份与位置及原声音轨。`completed` 仅代表任务完成；只有内容通过才选择版本、审核并由产品合并。预计/实际文本调用与渲染数量分开，无法观察的调用数写未知，不估作实测。

## 本轮生产请求证据 [R]

2026-11-21：drama 26 / episode 34，batch 71，任务 5073–5076。维护角色只读持久请求，逐字核验四条人工正文（含已解析 @引用）在代码对齐声明与风格前缀之后保留。5074 实际 William=2、Florence=3，与人工 Picture2/3 一致；5075/5076 只有完整首帧一张，无命名引用。5073 仍带客厅/William/Florence 参考，正文只按完整首帧的位置定义 S1/S2，不将额外图片编号错指角色。此记录证明请求保留与映射，不提前宣称成片通过。
