# 叠加图层渲染字体（Issue #48）

服务端渲染（`services/layer-render.ts` → sharp/librsvg/pango）**只用这里的字体**：
`services/layer-fonts.ts` 启动时生成一份只包含本目录的 fontconfig 配置并指向它，
所以同一份 `LayerDoc` 在任何机器上渲染出的字形完全一致，不会落到系统回退字体。
编辑器画布通过 `GET /api/v1/layer-docs/fonts/<file>` 用同一批字体做 `@font-face`，
保证「所见即所得」。

| 文件 | 字族 | 字重 | 大小 |
| --- | --- | --- | --- |
| `NotoSansSC-Regular.otf` | Noto Sans SC | 400 | 5.8 MB |
| `NotoSansSC-Bold.otf` | Noto Sans SC | 700 | 5.9 MB |
| `NotoSerifSC-Regular.otf` | Noto Serif SC | 400 | 8.1 MB |
| `NotoSerifSC-Bold.otf` | Noto Serif SC | 700 | 8.4 MB |
| `LXGWWenKai-Regular.ttf` | LXGW WenKai | 400 | 12.7 MB |
| `LXGWWenKai-Medium.ttf` | LXGW WenKai | 700（Medium） | 12.6 MB |
| `MaShanZheng-Regular.ttf` | Ma Shan Zheng | 400 | 5.8 MB |

合计 ≈ 58 MB。Poster（Issue #72）的四族字体：`sans` = Noto Sans SC、`serif` = Noto Serif SC、
`kai` = LXGW WenKai、`hand` = Ma Shan Zheng；服务端 fontconfig 与编辑器 `@font-face` 都用这一批文件。

## 为什么是「子集」而不是全量，也不是更小的常用字表

- 上游已是 SC 子集（`notofonts/noto-cjk` 的 `Sans|Serif/SubsetOTF/SC/`），本目录在此基础上
  再按下表的码位区间子集化，去掉了扩展 B/C、韩文音节、竖排专用备选等纪录片画面用不到的部分。
- **没有**退到「通用规范汉字表 8105 字」那种更小的子集：纪录片画面大量出现历史地名与人名
  （噶尔丹策零、额尔齐斯、塞米巴拉金斯克…），少一个字就是一个豆腐块，而渲染端已经约定
  「宁可报错也不出豆腐块」，字表越小越容易把正常文案判成不可渲染。

## 覆盖的码位

子集化时**申请**的区间是：

```
U+0020-007E 基本拉丁 / U+00A0-00FF 拉丁补充 / U+2000-206F 常用标点 / U+2190-21FF 箭头
U+2460-24FF 带圈数字 / U+25A0-25FF 几何图形 / U+3000-30FF 中日标点与假名
U+4E00-9FFF CJK 统一汉字基本区 / U+FF00-FFEF 全角字符
```

但 `pyftsubset` 只保留源字体里**本来就有**的字形：这几个区间里有 78 个标点、87 个箭头、
57 个几何图形、以及 U+9FF0–9FFF 等共计 ~250 个码位在 Noto CJK 里根本不存在。所以
`services/layer-svg.ts` 的 `FONT_CHAR_RANGES` **不是**上面的申请区间，而是四件字体
cmap 的**交集**（21902 个码位、47 段），由下面的命令生成后粘贴进 TS 与
`frontend/app/utils/layerSvg.js`（两端必须一致，`backend/tests/layer-render.test.mjs`
会用真实渲染抽查每一段）：

```bash
/tmp/fontsub/bin/python -c "
from fontTools.ttLib import TTFont
names=['NotoSansSC-Regular','NotoSansSC-Bold','NotoSerifSC-Regular','NotoSerifSC-Bold']
declared=[(0x20,0x7e),(0xa0,0xff),(0x2000,0x206f),(0x2190,0x21ff),(0x2460,0x24ff),
          (0x25a0,0x25ff),(0x3000,0x30ff),(0x4e00,0x9fff),(0xff00,0xffef)]
inter=set.intersection(*[set(TTFont(n+'.otf').getBestCmap()) for n in names])
have=sorted(c for lo,hi in declared for c in range(lo,hi+1) if c in inter)
out=[]
for c in have:
    if out and c==out[-1][1]+1: out[-1][1]=c
    else: out.append([c,c])
print('\n'.join('  [0x%04x, 0x%04x],'%(a,b) for a,b in out))
"
```

覆盖之外的字符（扩展 B 生僻字、韩文、emoji、未收录的箭头/符号等）会让
`POST /layer-docs/render` 返回 400 并列出具体字符，不会渲染成豆腐块。扩大覆盖要同时改
申请区间、重新子集化、重新生成 `FONT_CHAR_RANGES`，并更新本文件的大小表。

**kai / hand 的覆盖较小**：LXGW WenKai 子集约 21945 个码位，Ma Shan Zheng 子集约 7001 个码位
（多为 GB2312 常用字）。这两族字体在 `layer-svg.ts` 里排在其字族栈的第二位
（`'LXGW WenKai', serif` / `'Ma Shan Zheng', sans-serif`），fontconfig 只认识本目录，
所以缺字会回退到打包的 Noto Sans/Serif SC，不会出豆腐块；渲染前的 `FONT_CHAR_RANGES`
检查仍以 Noto 四件的交集为准（21902 个码位），不因新增手写/楷体字体而缩小。

## 新增字体的重新生成（Issue #72）

```bash
cd /tmp
curl -sL -O https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf
curl -sL -O https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Medium.ttf
curl -sL -O https://raw.githubusercontent.com/google/fonts/main/ofl/mashanzheng/MaShanZheng-Regular.ttf
UNI='U+0020-007E,U+00A0-00FF,U+2000-206F,U+2190-21FF,U+2460-24FF,U+25A0-25FF,U+3000-30FF,U+4E00-9FFF,U+FF00-FFEF'
for f in LXGWWenKai-Regular LXGWWenKai-Medium MaShanZheng-Regular; do
  /tmp/fontsub/bin/pyftsubset $f.ttf --unicodes="$UNI" \
    --layout-features=kern,vert,vrt2,liga,calt --name-IDs='*' --output-file=$f.sub.ttf
done
```

LXGW WenKai 上游没有 Bold，700 字重用 `LXGWWenKai-Medium.ttf` 注册（`layer-fonts.ts` 的
`LAYER_FONT_FILES` 与编辑器 `@font-face` 同步改）。

## 重新生成（需要 fonttools，装在仓库外的临时环境里）

```bash
uv venv /tmp/fontsub && uv pip install --python /tmp/fontsub/bin/python fonttools
cd /tmp && for f in Sans/SubsetOTF/SC/NotoSansSC-Regular.otf Sans/SubsetOTF/SC/NotoSansSC-Bold.otf \
                   Serif/SubsetOTF/SC/NotoSerifSC-Regular.otf Serif/SubsetOTF/SC/NotoSerifSC-Bold.otf; do
  curl -sL -O "https://github.com/notofonts/noto-cjk/raw/main/$f"
done
UNI='U+0020-007E,U+00A0-00FF,U+2000-206F,U+2190-21FF,U+2460-24FF,U+25A0-25FF,U+3000-30FF,U+4E00-9FFF,U+FF00-FFEF'
for f in NotoSansSC-Regular NotoSansSC-Bold NotoSerifSC-Regular NotoSerifSC-Bold; do
  /tmp/fontsub/bin/pyftsubset $f.otf --unicodes="$UNI" \
    --layout-features=kern,vert,vrt2,liga,calt --name-IDs='*' --output-file=$f.sub.otf
done
```

子集化后 `name` 表里的字族名保持 `Noto Sans SC` / `Noto Serif SC`（fontconfig 按这两个名字匹配），
改这一点会让自检失败。

## 许可

- Noto Sans SC / Noto Serif SC：SIL Open Font License 1.1，见同目录 `OFL.txt`
  （取自 `notofonts/noto-cjk` 的 `Sans/LICENSE`，与 `Serif/LICENSE` 内容一致）。
- LXGW WenKai：SIL Open Font License 1.1，见 `OFL-LXGW-WenKai.txt`（取自 `lxgw/LxgwWenKai`）。
- Ma Shan Zheng：SIL Open Font License 1.1，见 `OFL-MaShanZheng.txt`（取自 Google Fonts
  `google/fonts/ofl/mashanzheng`）。
