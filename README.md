# dsh-gui-ops

Reliable primitives for driving a Mac GUI from [DeepSeek Harness](https://github.com/deepseek-ai): OCR that returns **clickable point coordinates**, click-by-text, checkbox state read from pixels, verified window bounds — plus a small cross-session notebook for "this bit me once" lessons.

`dsh-computer-use` gives a model eyes and a finger. This adds aim and proof.

## Why

Screenshot-driven automation fails in ways that look like nothing happened:

| Symptom | Cause |
| --- | --- |
| Click at y=848 on a button spanning 827–847 does nothing | OCR boxes are padded text boxes, not control rectangles; their top edge sits 5–11 pt below the control |
| Clicking an option's label does nothing | The row label has no handler; only the radio/checkbox does |
| A 60 ms down/up is swallowed | The control waits for a longer press or debounces |
| A multi-select loses one option | OCR reads `□` as `D`, `口`, or drops the letter entirely |
| A click lands on the Dock instead of the page | macOS tiling re-applies asynchronously; coordinates came from a pre-resize screenshot |
| The wrong row gets clicked after scrolling | Scroll momentum — the screenshot predates the final position |

Every tool here therefore returns something checkable rather than assuming success.

## Tools

| Tool | Purpose |
| --- | --- |
| `gui_screen` | Display size in points, frontmost app |
| `gui_capture` | Screenshot to a file (optionally a region); no image enters the conversation |
| `gui_read` | OCR into lines with **centre** coordinates in points, reading order |
| `gui_click` | Click by text (capture → OCR → match → click) or by point; 150 ms hold; reports nearby text afterwards |
| `gui_checks` | Scan a vertical strip (default x 322–334 pt) and report each checkbox/radio row as on/off |
| `gui_window` | Activate an app, set window bounds, read them back |
| `gui_note` / `gui_recall` | Append a lesson / search the notebook |
| `gui_compact` | Merge near-duplicates, archive the weakest entries, rewrite a tag-grouped digest |

Coordinates are **screen points with a top-left origin**, the same space `CGEvent` uses — no pixel/point conversion.

## Install

Requires macOS and DeepSeek Harness. No npm dependencies; the native helper compiles on first use (`swiftc` from Xcode Command Line Tools).

**From the app:** Plugins → Add plugin → pick this directory.

**From a session:**

```text
plugin_manager action=install_bundle target=/absolute/path/to/dsh-gui-ops
```

Grant **DeepSeek Harness.app** these in System Settings → Privacy & Security:

1. **Accessibility** (synthetic clicks, window bounds)
2. **Screen Recording** (screenshots)

Child processes inherit the host app's TCC identity, so the terminal needs no separate grant.

## Usage

```text
gui_window app="Microsoft Edge" x=0 y=25 w=1470 h=860
gui_read   x=300 y=200 w=750 h=650      # lines with centre coordinates
gui_click  text="Next" anchor=center
gui_checks                              # verify the toggle actually changed
```

Multi-select: read row centres with `gui_checks`, click each row at `x=328`, read again. This sidesteps OCR letter loss entirely.

## Notebook

```text
gui_note   title="Vision box is padded" fix="click the bbox centre, then verify"
gui_recall query="OCR"
gui_compact                          # merge duplicates, archive, rewrite digest
```

Notes live in `~/.dsh/gui-ops/notes.jsonl` (one JSON per line) with `notes.md` as a readable digest and `archive.jsonl` for entries pushed out by the cap. Writes merge near-duplicates (a re-learned lesson increments `seen` instead of adding a line); the cap (default 200) archives the weakest entries rather than deleting them.

## Limits

- Main display only; multi-display coordinates are not handled.
- OCR is the local Vision model: vertical text, heavy stylisation, and low contrast can drop lines. Read important state with `gui_checks`, not from text.
- `gui_click` matches case-insensitive substrings; use `nth` or a region when a page repeats a label.

## Development

```sh
node test-drive.mjs gui_read '{"limit":8}'   # drives a tool without reloading the harness
```

`src/gui-ops.swift` is the native half; `bin/gui-ops` is rebuilt automatically when the source is newer.

## 中文

给 DeepSeek Harness 用的 macOS GUI 操作原语：OCR 直接返回可点击的**中心点坐标**、按文字点击、用像素扫描读勾选状态、窗口尺寸写入后回读，外加一本跨会话经验笔记。安装：插件 → 添加插件 → 选这个目录，或 `plugin_manager install_bundle`。需要给 DeepSeek Harness 授予「辅助功能」和「屏幕录制」。

## License

MIT
