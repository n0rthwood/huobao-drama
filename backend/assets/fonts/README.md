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

合计 ≈ 28 MB（上游 SubsetOTF 原始四件 ≈ 40 MB，子集化省掉约 30%）。

## 为什么是「子集」而不是全量，也不是更小的常用字表

- 上游已是 SC 子集（`notofonts/noto-cjk` 的 `Sans|Serif/SubsetOTF/SC/`），本目录在此基础上
  再按下表的码位区间子集化，去掉了扩展 B/C、韩文音节、竖排专用备选等纪录片画面用不到的部分。
- **没有**退到「通用规范汉字表 8105 字」那种更小的子集：纪录片画面大量出现历史地名与人名
  （噶尔丹策零、额尔齐斯、塞米巴拉金斯克…），少一个字就是一个豆腐块，而渲染端已经约定
  「宁可报错也不出豆腐块」，字表越小越容易把正常文案判成不可渲染。

## 覆盖的码位区间

与 `services/layer-svg.ts` 的 `FONT_CHAR_RANGES` 必须保持一致（渲染前用它判断文字是否可渲染）：

```
U+0020-007E  基本拉丁
U+00A0-00FF  拉丁补充
U+2000-206F  常用标点（——、……、“”）
U+2190-21FF  箭头
U+2460-24FF  带圈数字
U+25A0-25FF  几何图形
U+3000-30FF  中日标点、假名
U+4E00-9FFF  CJK 统一汉字基本区
U+FF00-FFEF  全角字符
```

超出范围的字符（扩展 B 的生僻字、韩文、emoji 等）会让 `POST /layer-docs/render` 返回
400 并列出具体字符，不会渲染成豆腐块。需要扩大范围时改上面的区间、重新子集化、同步
`FONT_CHAR_RANGES`，并更新本文件的大小表。

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

SIL Open Font License 1.1，见同目录 `OFL.txt`（取自 `notofonts/noto-cjk` 的 `Sans/LICENSE`，
与 `Serif/LICENSE` 内容一致）。
