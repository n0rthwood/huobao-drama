# r2 外部读取台账

本轮仅做设计文档与源码调查。**未调用 Huobao 业务 API、未写生产 DB/媒体、未生成媒体、未重启/发布/修改全局配置。**
无业务人工批准或生产验收声明。下面保留 GitHub CLI 读取；它们不是 Huobao API smoke。

|编号|intent|exact request / body_keys|status|content_type|first_choice|needed_source|exact response evidence|
|---|---|---|---|---|---|---|---|
|Q1|读取 #126 评论及 Fabel M1–M16|`gh issue view 126 --repo n0rthwood/huobao-drama --comments`；body_keys=[]|CLI exit 0；CLI未暴露底层HTTP状态|CLI文本（HTTP Content-Type未捕获）|N/A|Issue #126 v2及Fabel设计评审|`r2-issue-comments.txt`；评审正文另见 `r2-fabel-review.md`|
|Q2|核对关联 #125 当时的 Issue 合同|`gh issue view 125 --repo n0rthwood/huobao-drama`；body_keys=[]；命令输出取前80行|CLI exit 0；HTTP状态未捕获|CLI文本（HTTP Content-Type未捕获）|N/A|#125 description/keywords生产链|本执行会话同名工具返回（`history://DesignRev126`）；不能把该早期 OPEN 输出当作后来 master 的合并状态，后续事实以 facts §7 为准|
|Q3|补读 #126 正文，避免评论替代正文|`gh issue view 126 --repo n0rthwood/huobao-drama --json title,body,url`；body_keys=[]|CLI exit 0；HTTP状态未捕获|CLI JSON（HTTP Content-Type未捕获）|N/A|原始用户目标及原验收项|`r2-issue-body.json`（原样CLI JSON）；来源 artifact://772|

GitHub CLI 会自行处理鉴权；没有保存命令环境、Authorization 或凭据。CLI未提供的 HTTP 状态/头不作推断。
Astra 模型调用单独记录于 `calls.md` 的 r2 增补节，原始响应含实际错误（如有），不以调用完成当作行为验收。
