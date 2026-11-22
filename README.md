# dsh-gui-ops

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的 macOS GUI 操作原语：**OCR 直接返回可点击的中心点坐标**、按文字点击、用像素扫描读勾选状态、窗口尺寸写入后回读，外加一本跨会话的经验笔记。

`dsh-computer-use` 让模型「看得见、点得动」；这个插件补的是「点得准、点完知道成没成」。

## 为什么需要它

纯截图驱动的自动化，失败起来往往「看起来什么都没发生」：

| 现象 | 原因 |
| --- | --- |
| 按钮在 y=827–847，点 y=848 毫无反应 | OCR 返回的是带行距的文本框，不是控件矩形，顶边比控件低 5–11pt |
| 点选项文字没用，点圆圈才生效 | 行标签没有绑定事件 |
| 60ms 的按下/抬起被吞 | 控件在等 pointerup 或做了防抖 |
| 多选题莫名漏勾一个 | OCR 把 `□` 认成 `D`/`口`，甚至整个字母消失 |
| 点击落到 Dock 上 | macOS 分屏异步生效，坐标来自重排前的截图 |
| 滚动后点错行 | 滚动有惯性，截图早于最终位置 |

所以这里的每个工具都返回**可核对的东西**，而不是假设成功。

## 工具

| 工具 | 作用 |
| --- | --- |
| `gui_screen` | 屏幕尺寸（pt）、前台 App |
| `gui_capture` | 截图存文件（可截区域），**不把图片塞进上下文** |
| `gui_read` | OCR → 每行文字 + 中心坐标（pt），按阅读顺序 |
| `gui_click` | 按文字或坐标点击；默认 150ms 长按；点完回报最近文字 |
| `gui_checks` | 扫一条竖条（默认 x 322–334），读出复选框/单选框 on/off |
| `gui_window` | 激活 App、设窗口位置尺寸，并回读确认是否生效 |
| `gui_note` / `gui_recall` | 经验笔记：写一条 / 按关键词或标签查 |
| `gui_compact` | 合并重复、归档最弱的条目、重写按标签分组摘要 |

## 坐标模型

全部是**屏幕点（pt）**，原点在主屏左上角，和 `CGEvent` 一致 —— 不需要在「截图像素」和「屏幕点」之间换算。

注意：`computer_*` 系列用的是**截图像素**，两者不要混用。

## 安装

需要 macOS 和 DeepSeek Harness，没有 npm 依赖。

**在 App 里**：插件 → 添加插件 → 选这个目录。

**在会话里**：

```text
plugin_manager action=install_bundle target=/absolute/path/to/dsh-gui-ops
```

原生助手会在第一次调用时用 `swiftc` 自动编译（需要 Xcode Command Line Tools）。

给 **DeepSeek Harness.app** 两项权限：

1. **辅助功能** —— 合成点击、窗口控制
2. **屏幕录制** —— 截图

子进程会继承宿主 App 的 TCC 责任身份，终端不用单独授权。

## 用法

```text
gui_window app="Microsoft Edge" x=0 y=25 w=1470 h=860
gui_read   x=300 y=200 w=750 h=650        # 读题，拿到选项的中心坐标
gui_click  text="下一题" anchor=center
gui_checks                                # 确认勾选真的变了再继续
```

多选题：先 `gui_checks` 读出每一行的 y，再按 `x=328` + 行 y 逐个点击，最后再读一次复核 —— 这样完全不依赖 OCR 识别字母。

## 经验笔记

```text
gui_note   title="Vision 的框是带行距的" fix="点 bbox 中心，点完用 gui_checks 复核"
gui_recall query="OCR"
gui_compact                                   # 合并重复、归档、重写摘要
```

笔记存在 `~/.dsh/gui-ops/`：

| 文件 | 内容 |
| --- | --- |
| `notes.jsonl` | 源数据，一行一条 JSON，写入即最新 |
| `notes.md` | 按标签分组的人读摘要，压缩时重写 |
| `archive.jsonl` | 超过上限被归档的条目（不删除） |

写入时会先和已有条目比相似度，命中就只把 `seen` 加一，不再追加一行；条数超过上限（默认 200）时按「被重复验证的次数 + 新旧 + 是否有示例」排序，保留 75%，其余归档。

## 局限

- 只处理主屏，多显示器坐标未支持
- OCR 是本地 Vision 模型：竖排、花体、低对比度会漏行 —— 重要状态请用 `gui_checks` 读，不要靠文字
- 文字匹配是大小写不敏感的子串；同页重复文案用 `nth` 或区域限定

## 开发

```sh
node test-drive.mjs gui_read '{"limit":8}'   # 不重载 harness 也能单独驱动某个工具
```

`src/gui-ops.swift` 是原生部分，源文件比 `bin/gui-ops` 新时会自动重新编译。

---

# dsh-gui-ops (English)

Reliable primitives for driving a Mac GUI from DeepSeek Harness. `dsh-computer-use` gives a model eyes and a finger; this adds **aim and proof**.

## Why

Screenshot-driven automation fails in ways that look like nothing happened:

| Symptom | Cause |
| --- | --- |
| A click at y=848 on a button spanning 827–847 does nothing | OCR boxes are padded text boxes, not control rectangles; the top edge sits 5–11 pt below the control |
| Clicking an option's label does nothing | The row label has no handler; only the radio does |
| A 60 ms down/up is swallowed | The control waits for a longer press or debounces |
| A multi-select loses one option | OCR reads `□` as `D`, `口`, or drops it entirely |
| A click lands on the Dock | macOS tiling re-applies asynchronously; coordinates came from a stale screenshot |
| The wrong row gets clicked after scrolling | Scroll momentum; the screenshot predates the final position |

Every tool therefore returns something checkable rather than assuming success.

## Tools

| Tool | Purpose |
| --- | --- |
| `gui_screen` | Display size in points, frontmost app |
| `gui_capture` | Screenshot to a file (optionally a region); no image enters the conversation |
| `gui_read` | OCR into lines with **centre** coordinates in points |
| `gui_click` | Click by text or by point; 150 ms hold; reports nearby text afterwards |
| `gui_checks` | Scan a vertical strip and report each checkbox/radio row as on/off |
| `gui_window` | Activate an app, set window bounds, read them back |
| `gui_note` / `gui_recall` | Append a lesson / search the notebook |
| `gui_compact` | Merge duplicates, archive weak entries, rewrite the digest |

Coordinates are **screen points with a top-left origin**, the same space `CGEvent` uses. (`computer_*` tools use screenshot pixels — do not mix them.)

## Install

macOS + DeepSeek Harness, no npm dependencies. Either **Plugins → Add plugin → pick this directory**, or:

```text
plugin_manager action=install_bundle target=/absolute/path/to/dsh-gui-ops
```

Grant **DeepSeek Harness.app** Accessibility (synthetic input) and Screen Recording (screenshots). The native helper compiles itself with `swiftc` on first use.

## Usage

```text
gui_window app="Microsoft Edge" x=0 y=25 w=1470 h=860
gui_read   x=300 y=200 w=750 h=650
gui_click  text="Next" anchor=center
gui_checks
```

For multi-select, read row centres with `gui_checks`, click each row at `x=328`, then read again — this sidesteps OCR letter loss.

## Notebook

Notes live in `~/.dsh/gui-ops/` as `notes.jsonl` (source), `notes.md` (tag-grouped digest) and `archive.jsonl` (entries pushed out by the cap). Writes merge near-duplicates — a re-learned lesson increments `seen` instead of adding a line — and the cap (default 200) archives the weakest entries rather than deleting them.

## Limits

Main display only; OCR is the local Vision model, so read important state with `gui_checks` rather than from text; text matching is a case-insensitive substring.

## License

MIT
