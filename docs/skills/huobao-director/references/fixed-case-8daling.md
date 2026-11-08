# 生产验收固定案例：八达岭长城测试 1008（历史+现行固定定义）

> 本文件从 `SKILL.md` §4.6 原样移出，仅为满足 managed skill 单文件 64,000 bytes 上限，内容未删减；授权边界、固定 224 字正文与证据纪律照旧有效。`SKILL.md` §4.6 保留入口链接与要点。
### 4.6 生产验收固定案例：八达岭长城测试 1008（`AGENTS.md` §9/§10）

**为什么用它做生产验收**：隔离 worktree（独立端口 + DB 副本）从 2026-11-08 起不再作为验收依据——它跑的是副本数据与副本静态目录，掩盖过生产独有的路径前缀、任务队列与真实模型行为。验收必须在生产入口 + 生产后端 + 生产库上留痕，又绝不能碰既有真实项目（尤其 drama 3《利哈列夫远征》）。固定一个**主题、篇幅、命名都确定**的新项目，既保证每轮验收覆盖同样的链路、可横向对比，又把写入限制在一次性测试项目里。

- **主题**：八达岭长城对明朝防御的作用。
- **原始内容（固定文本，正文 224 字，去空白计；只进第一步 `PUT /episodes/{e} {content}`）**：长度刻意压在 200–300 字，是为了让旁白骨架、配音、设计卡在可控镜数内跑完，GPU 成本可预算。正文（内容为公有领域历史常识整理，可公开）：

  > 八达岭长城位于北京西北的军都山关沟北口，是明代长城中规制最高、保存最完整的段落之一。明永乐以后，蒙古诸部屡次南下，朝廷把京师北面的防线层层加厚：外有宣府、大同，内有居庸关，而八达岭扼守关沟最窄处，成为居庸关的前哨。城墙依山脊起伏，以条石为基、青砖包砌，顶部宽处可容五马并行，便于快速调兵。沿线每隔数百米设敌台与烽燧，守军以烟火与号炮为信，警讯昼夜之间即可传到京城。它的作用不只是阻挡，更是把进攻者逼入狭窄山道，使明军能以较少兵力守住通往北京的咽喉。

  正文之后再**另起一行**附这条**故意保留的非旁白出处行**（它不是旁白，用来触发 #80 的检测；不计入上面的 224 字）：

  > 资料来源：公有领域历史常识整理；本行为出处说明，不作为朗读稿。

  导入时两段一起写进 `content`（原始材料保留出处是 S1 的要求）；AI 改写走第二步，改写与保存前的检测应当把这条出处行识别为 `source`/`not_narration` 并给出可定位的 `findings`，正文 224 字不得被改写删减。
- **项目命名**：`八达岭长城测试 1008`；同名已存在时追加序号（`八达岭长城测试 1008-2`）。**不复用旧测试项目**；实际 `drama_id`/`episode_id` 以创建结果为准并写进报告。
- **链路**：建项目（`project_type=documentary` + `documentary_rules=on`）→ 原始内容 → AI 改写 → 旁白稿检查（#80）→ 人工确认 → 资产提取/审核 → 旁白骨架（#81）→ 配音 → 设计卡（#82）→ 图层段/关键帧 → 视频 → 合成 → 导出。本轮验收涉及的阶段必须真实跑通，不涉及的阶段写明「未覆盖」。
- **本案例要覆盖的新功能**：
  1. `POST /episodes/{e}/script-rewrite/inspect-narration`：在原始内容尾部刻意保留一条出处/链接行，验证 AI 识别、`locatable` 判定与「删除可定位片段 / 保留」两条人工路径；
  2. `fidelity.v2` 的 `ai_exclusions` 与 `adjusted_baseline_chars`：改写报告能看到被剔除片段与调整后基线；
  3. `PUT …/narration-skeleton {validate_only:true}`：缺口坐标、`excerpts`、三种缺口处置；
  4. 骨架 `tts.audio_url` / `audio_version`：配音后逐镜试听，并验证改动旁白后旧音频转为 `valid:false` 不可试听；
  5. `POST …/design-cards/fill` 的 AI combo 与 combo-only 补选（含「已有 combo 不被覆盖」）；
  6. `GET …/design-cards/audit` 的 `tts.duration_ms`、`unresolved_layers`、`video_generated`，以及确认失败时可读的 `issues[].message`。
- **证据清单**：`drama_id`/`episode_id`/各阶段 `task_id`；每个关键阶段的浏览器截图（读图后再下结论）；只读 DB 查询（状态与产物路径）；失败任务的日志片段；消耗台账需**分列** GPU（图片/视频/TTS 条数）与计费文本 LLM 调用（改写/`inspect-narration`/骨架/填卡/提示词生成的次数与授权出处）。报告必须给出这些 ID 与证据路径，不能只写「已验证」。
- **纪律**：生产测试消耗真实额度，任何计费生成任务先取得用户同意；严禁修改、生成、删除既有真实项目数据；DB 一律只读；失败不隐瞒，保留证据。

#### 首次执行结果（2026-11-08，`[R]`）

- **对象**：drama **10**「八达岭长城测试 1008」/ episode **16**；生产入口 `http://172.30.3.164/huobao/`；证据目录 `docs/qa/8daling-1008-20261108T061008Z/`（`report.md` + `requests.jsonl` + 截图）。
- **规模与预算**：6 镜；旁白覆盖 **241/241**；图片 **11/16**（资产 1226、1230–1233、1245–1246；关键帧 1248–1251）、视频 **2/2**（1254 #01、1255 #04）、TTS **6/8**（batch 1228）。无超预算、无失败后追加 GPU。
- **成片**：compose 6/6 `unchanged`+`exportable`，merge **27** completed，媒体 `static/merged/c9bbd119-b086-42a6-8eaf-6ce63ed185fa.mp4`，浏览器实开 **960×544 / 65.44s**（本环境无 ffprobe，时长依据为浏览器媒体元数据，已如实标注）。
- **#80 通过**：旧入口 `POST /agent/script_rewriter/chat` 对纪录片真实返回 400 → 改走 `POST /episodes/16/script-rewrite`（run 3 / task 1212）。`inspect-narration` 在原稿命中 1 条可定位 finding（出处行），`fidelity.v2` 基线 224 / 输出 224 / `adjusted_baseline_chars=224`，prepared 阶段 raw 256→224；定稿再跑 `findings=[]`。
- **#81 通过**：骨架 task 1227 出 6 镜、无 gap；`validate_only:true` 在正常草稿返回空，在人为删掉第 2 镜首字「它」后返回精确 `{start:42,end:43,chars:1,text:"它",next_index:1}` 且**未写库**；配音后 6 镜 `tts.valid=true`，`audio_url`/`audio_version`/`duration_ms`（8800/3840/14400/9920/10240/8800）齐全，UI 可试听。
- **#82 通过**：`design-cards/fill` 在 6 个空 combo 的镜上真实写入 AI 初选（#01 C、#02 D、#03–#06 C）；audit 返回非零 `tts.duration_ms`（UI 显示「实测 8.8s」而非 0.0s）；`unresolved_layers` 给出资产 ID/名称与 `available_semantics`（如 asset 161「八达岭区位示意图」，`available_semantics=[]`），`issues[].message` 可读，未虚构语义名。
- **失败与偏差（保留，不隐瞒）**：① #02 的关键帧提示词在 GLM、DeepSeek local、DeepSeek cloud 三种已配置模型下均失败 → 经 combo impact 后改为确定性 **A**，由 #04 C 维持第二条生成视频，**未追加 GPU 预算**；② 图层 draft 首次全部 `missing_base`，先按设计卡生成真实 base 再重 draft/render（1234–1239、1256–1259）；③ 资产初审 6 项缺失，补提取 1218–1223 后新建 scene 90 / prop 166 补齐，终审 22 total / 17 have / 4 added / 1 not_needed / 0 missing；④ 文档 merge 路径错误导致 200+HTML，改用 `/merge/episodes/:id/merge` 成功（已回写 S11）；⑤ 本环境无 ffprobe/ffmpeg，未伪报 ffprobe 结论。
- **性质**：以上为**技术验收**；史实/画面/声音的艺术验收仍待用户审核（`…/huobao/drama/10/episode/1?panel=export`）。

