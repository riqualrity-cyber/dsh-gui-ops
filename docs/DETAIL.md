# GUI ops

Precise, verifiable GUI automation for macOS. The point is not "take a screenshot and click"; it is "know exactly where to click, and know whether it worked".

## What it does

| Tool | Purpose |
| --- | --- |
| `gui_screen` | Display size in points, pixel scale, frontmost app |
| `gui_capture` | Screenshot to a file (optionally a region); no image enters the conversation |
| `gui_read` | OCR into text lines with centre coordinates in points, in reading order |
| `gui_click` | Click by text (capture → OCR → match → click) or by explicit point; 150 ms hold; reports the nearest text afterwards |
| `gui_checks` | Scan a vertical strip (default x 322–334 pt) and report each checkbox/radio row as on/off |
| `gui_window` | Activate an app, set its window bounds, read the bounds back |
| `gui_note` / `gui_recall` | Shared lesson notebook: append one lesson, or search by text/tags |
| `gui_compact` | Merge near-duplicates, archive the weakest entries over the cap, rewrite a tag-grouped digest |

Coordinates are screen points with the top-left origin — the same space `CGEvent` uses — so no pixel/point conversion is required.

## Why the workflow is shaped this way

Screenshot-driven automation fails in ways that look like nothing happened:

- OCR boxes are padded text boxes, not control rectangles, so clicking a box's top edge can miss a button by one point.
- Many web controls ignore a 60 ms down/up pair; they need a longer hold.
- File inputs and option rows often respond only to the control itself, not the surrounding label.
- macOS window tiling applies asynchronously, so coordinates computed from a screenshot taken before the relayout are stale.
- OCR drops or mangles checkbox glyphs, so letters at line starts cannot be trusted to address an option.

Every tool therefore returns something checkable: `gui_read` returns centres, `gui_click` re-observes the screen, `gui_checks` reads state from pixels, and `gui_window` reports whether the resize actually stuck.

## Usage

```text
gui_window app="Microsoft Edge" x=0 y=25 w=1470 h=860
gui_read   x=300 y=200 w=750 h=650
gui_click  text="下一题" anchor=center
gui_checks                                  # confirm the toggle before continuing
```

Multi-select rows: read the row centres with `gui_checks`, click each at `x=328` with the row's `y`, then read again — this avoids OCR letter loss entirely.

## Lessons between sessions

`gui_note` appends one lesson (title, symptom, cause, fix, tags, example) to `~/.dsh/gui-ops/notes.jsonl`; `gui_recall` searches it. Notes are merged on write (a re-learned lesson increments a `seen` counter instead of adding a line), and `gui_compact` archives the weakest entries once the notebook passes its cap, leaving a readable `notes.md` digest. The notebook is plain JSONL, readable by both people and models.

## Limitations

- The main display only; multi-display coordinates are not handled.
- OCR is the local Vision model: vertical text, heavy stylisation, and low contrast can drop lines, so state that matters is read with `gui_checks`, not from text.
- `gui_click` text matching is a case-insensitive substring; use `nth` or a region when a page repeats the same label.
- Requires Accessibility (synthetic input, window bounds) and Screen Recording (screenshots) for DeepSeek Harness.
