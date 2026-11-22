/**
 * dsh-gui-ops — reliable primitives for GUI work on macOS.
 *
 * Why this exists: driving a browser or a native app through screenshots alone
 * is a coordinate-calibration game. The host tools (`computer_*`) are great for
 * "look and poke", but every step costs an image block, and OCR boxes are not
 * click targets. This plugin adds the missing half:
 *
 *   - text extraction into *point* coordinates (centres, not top edges),
 *   - clicking by text instead of by remembered pixels,
 *   - checkbox/radio state reads, so a click can be verified instead of assumed,
 *   - window bounds with a read-back (macOS retiles asynchronously),
 *   - a tiny JSONL notebook for "this bit me once" lessons.
 *
 * No npm dependencies: it loads from a plain directory, and the native half is
 * a single Swift binary compiled on first use.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "gui-ops";
export const inject = ["tools"];

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, "bin", "gui-ops");
const SOURCE = join(HERE, "src", "gui-ops.swift");
const HOME = homedir();
const DATA = join(HOME, ".dsh", "gui-ops");
const SHOTS = join(DATA, "shots");
const NOTES = join(DATA, "notes.jsonl");
const ARCHIVE = join(DATA, "archive.jsonl");
const DIGEST = join(DATA, "notes.md");
const DETAIL_DOC = join(HERE, "docs", "DETAIL.md");
const DETAIL_MARK = "<!-- gui-ops:notes -->";

const TEXT_OUT = {
	type: "object",
	properties: { text: { type: "string" } },
	required: ["text"]
};
const renderText = (_args, value) => [{ type: "text", text: value.text }];

function run(file, args, options = {}) {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024, ...options }, (err, stdout, stderr) => {
			if (err) {
				reject(new Error(`${file} failed: ${String(stderr || "").trim() || err.message}`));
				return;
			}
			resolve(String(stdout));
		});
	});
}

async function ensureHelper() {
	if (existsSync(HELPER)) {
		const [bin, src] = await Promise.all([stat(HELPER), stat(SOURCE).catch(() => undefined)]);
		if (src === undefined || bin.mtimeMs >= src.mtimeMs) return;
	}
	const building = `${HELPER}.building-${process.pid}`;
	await run("swiftc", ["-O", SOURCE, "-o", building], { timeout: 180000 });
	await run("mv", [building, HELPER]);
}

async function ops(...args) {
	await ensureHelper();
	const out = await run(HELPER, args.map(String));
	const parsed = JSON.parse(out);
	if (parsed.ok !== true) throw new Error(parsed.error ?? "gui-ops failed");
	return parsed;
}

async function pruneShots() {
	try {
		const files = (await readdir(SHOTS)).filter((f) => /\.(png|jpg)$/.test(f)).sort();
		// Screen PNGs run to ~3 MB at 2x; JPEG keeps OCR usable at a tenth of that.
		for (const stale of files.slice(0, Math.max(0, files.length - 12))) {
			await unlink(join(SHOTS, stale));
		}
	} catch {}
}

/** Capture the main display (or a region) to a PNG and return its path. */
async function capture({ region } = {}) {
	await mkdir(SHOTS, { recursive: true });
	const file = join(SHOTS, `${Date.now()}.jpg`);
	const args = ["-x", "-t", "jpg"];
	if (region) {
		const [x, y, w, h] = region;
		args.push("-R", `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`);
	}
	args.push(file);
	await run("screencapture", args);
	await pruneShots();
	return file;
}

/** OCR a file; returns lines in reading order with centred point coordinates. */
async function ocrFile(file, region) {
	const args = ["ocr", file];
	if (region) args.push(...region.map(Math.round).map(String));
	return ops(...args);
}

/** Build a compact, stable text rendering of OCR lines. */
function renderLines(res, { limit = 60 } = {}) {
	const lines = res.lines.slice(0, limit);
	const width = Math.max(...lines.map((l) => String(Math.round(l.y)).length), 3);
	return lines
		.map((l) => `${String(Math.round(l.y)).padStart(width)}  ${String(Math.round(l.x)).padStart(5)}  ${l.text}`)
		.join("\n");
}

function noteId() {
	const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
	return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Notes are written by a model, so near-duplicates are the norm: the same lesson
 * gets rediscovered next month in different words. Merge on write instead of
 * letting the file rot.
 *
 * Similarity is character-bigram Jaccard after stripping punctuation: no
 * tokenizer needed, works for Chinese and English alike.
 */
function normText(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(value) {
	const chars = [...value];
	const out = new Set();
	for (let i = 0; i < chars.length - 1; i += 1) out.add(chars[i] + chars[i + 1]);
	if (chars.length === 1) out.add(chars[0]);
	return out;
}

function similarity(a, b) {
	const A = bigrams(normText(a));
	const B = bigrams(normText(b));
	if (!A.size || !B.size) return 0;
	let shared = 0;
	for (const gram of A) if (B.has(gram)) shared += 1;
	return shared / (A.size + B.size - shared);
}

function sameLesson(a, b) {
	if (normText(a.title) && normText(a.title) === normText(b.title)) return true;
	const tagsA = (a.tags ?? []).map((t) => t.toLowerCase());
	const tagsB = (b.tags ?? []).map((t) => t.toLowerCase());
	const shareTag = !tagsA.length || !tagsB.length || tagsA.some((t) => tagsB.includes(t));
	// Rephrased titles are the common case; require a shared tag so that two
	// different lessons about the same app are not folded together.
	if (shareTag && similarity(a.title, b.title) >= 0.62) return true;
	return similarity(`${a.title} ${a.fix}`, `${b.title} ${b.fix}`) >= 0.72;
}

/** Value score: how often it was relearned, how recent, and whether it is actionable. */
function noteScore(note) {
	const seen = Number(note.seen) || 1;
	const stamp = Date.parse(note.updated ?? note.ts ?? 0) || 0;
	const ageDays = Math.max(0, (Date.now() - stamp) / 86_400_000);
	const recency = Math.max(0, 1 - ageDays / 90);
	return seen * 3 + recency + (note.example ? 0.8 : 0) + (note.tags?.length ? 0.4 : 0);
}

async function writeNotes(notes) {
	await mkdir(DATA, { recursive: true });
	await writeFile(NOTES, notes.map((n) => JSON.stringify(n)).join("\n") + (notes.length ? "\n" : ""));
}

async function archiveNotes(notes) {
	if (!notes.length) return;
	await mkdir(DATA, { recursive: true });
	const stamped = notes.map((n) => ({ archivedAt: new Date().toISOString(), ...n }));
	await writeFile(ARCHIVE, stamped.map((n) => JSON.stringify(n)).join("\n") + "\n", { flag: "a" });
}

/**
 * Two passes:
 *   1. merge near-duplicates, summing their `seen` counter;
 *   2. if still over the limit, archive the weakest tail (keep the top `keep`).
 * Also rewrites notes.md, a human/model-readable digest grouped by tag.
 */
async function compactNotes({ limit, keep, dryRun = false } = {}) {
	const notes = await readNotes();
	const merged = [];
	for (let i = 0; i < notes.length; i += 1) {
		const base = { ...notes[i] };
		if (!merged.some((m) => sameLesson(m, base))) {
			base.seen = Number(base.seen) || 1;
			merged.push(base);
			continue;
		}
		const host = merged.find((m) => sameLesson(m, base));
		host.seen += Number(base.seen) || 1;
		host.updated = base.updated ?? base.ts;
		host.tags = [...new Set([...(host.tags ?? []), ...(base.tags ?? [])])];
		if (!host.example && base.example) host.example = base.example;
		if (!host.cause && base.cause) host.cause = base.cause;
	}

	const cap = Number.isFinite(limit) ? limit : 200;
	const floor = Number.isFinite(keep) ? keep : Math.floor(cap * 0.75);
	const ranked = [...merged].sort((a, b) => noteScore(b) - noteScore(a));
	const kept = ranked.slice(0, Math.max(floor, 0));
	const dropped = ranked.slice(kept.length);

	const summary = {
		before: notes.length,
		after: kept.length,
		merged: notes.length - merged.length,
		archived: dropped.length
	};
	if (dryRun) return summary;

	kept.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
	await writeNotes(kept);
	await archiveNotes(dropped);
	await writeDigest(kept);
	await refreshDetail();
	return summary;
}

async function writeDigest(notes) {
	const byTag = new Map();
	for (const note of notes) {
		const tags = note.tags?.length ? note.tags : ["untagged"];
		for (const tag of tags) {
			if (!byTag.has(tag)) byTag.set(tag, []);
			byTag.get(tag).push(note);
		}
	}
	const sections = [...byTag.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.map(([tag, items]) => {
			const lines = items
				.sort((a, b) => noteScore(b) - noteScore(a))
				.map((n) => `- ${n.title} — ${n.fix}${n.seen > 1 ? ` (seen x${n.seen})` : ""}`);
			return `## ${tag}\n${lines.join("\n")}`;
		});
	const md = `# GUI ops notebook\n\n${notes.length} entries, generated ${new Date().toISOString()}\n\n${sections.join("\n\n")}\n`;
	await writeFile(DIGEST, md);
}

/**
 * Keep the bundle's detail document (what the Plugins page shows) in sync with
 * the notebook. Everything after the marker is generated; the prose above it is
 * hand-written and left alone. Best effort: a read-only install must not break
 * gui_note.
 */
async function refreshDetail() {
	try {
		const doc = await readFile(DETAIL_DOC, "utf8");
		const head = doc.split(DETAIL_MARK)[0].trimEnd();
		const all = [...(await readNotes())].sort((a, b) => noteScore(b) - noteScore(a));
		// The detail document is a scrollable page and the manager's limit is 1 MiB,
		// so show the whole notebook; the guard only stops a pathological file.
		const shown = all.slice(0, 300);
		const body = shown
			.map((n) => {
				const tags = (n.tags ?? []).length ? `  ·  ${(n.tags ?? []).join(", ")}` : "";
				const seen = n.seen > 1 ? `  ·  seen x${n.seen}` : "";
				return `- ${n.title} — ${n.fix}${seen}${tags}`;
			})
			.join("\n");
		const header = all.length > shown.length
			? `${shown.length} of ${all.length} entries shown (most useful first); the rest are in \`~/.dsh/gui-ops/notes.jsonl\`.`
			: `All ${all.length} entries, most useful first. Source of truth: \`~/.dsh/gui-ops/notes.jsonl\`; rewritten whenever \`gui_note\` records a lesson.`;
		await writeFile(
			DETAIL_DOC,
			`${head}\n\n${DETAIL_MARK}\n\n## Notebook\n\n${header}\n\n${body || "- (nothing recorded yet)"}\n`
		);
	} catch {}
}

async function readNotes() {
	try {
		const raw = await readFile(NOTES, "utf8");
		return raw
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return undefined;
				}
			})
			.filter(Boolean);
	} catch {
		return [];
	}
}

export async function refreshDetailForTest() {
	return refreshDetail();
}

export function apply(ctx, config = {}) {
	const noteLimit = Number.isFinite(config.noteLimit) ? config.noteLimit : 200;
	ctx.tools.register({
		name: "gui_screen",
		description:
			"Report the main display size in points, the pixel scale of a screenshot, and the frontmost app. " +
			"Coordinates used by every gui_* tool are points in this same space.",
		parameters: { type: "object", properties: {} },
		output: { schema: TEXT_OUT, render: renderText },
		async execute() {
			const [screen, front] = await Promise.all([ops("screen"), ops("front")]);
			return {
				text: `display ${screen.width_pt}x${screen.height_pt} pt; frontmost ${front.app} (${front.bundle})`
			};
		}
	});

	ctx.tools.register({
		name: "gui_capture",
		description:
			"Take a screenshot to a file (whole screen or a point-space region) and return the path. " +
			"No image is attached, so this is cheap: pair it with gui_read to get text, or with gui_click by text.",
		parameters: {
			type: "object",
			properties: {
				x: { type: "number", description: "region left edge in points" },
				y: { type: "number", description: "region top edge in points" },
				w: { type: "number", description: "region width in points" },
				h: { type: "number", description: "region height in points" }
			}
		},
		output: { schema: TEXT_OUT, render: renderText },
		async execute(args) {
			const region = ["x", "y", "w", "h"].every((k) => Number.isFinite(args[k]))
				? [args.x, args.y, args.w, args.h]
				: undefined;
			const file = await capture({ region });
			return { text: `captured ${region ? `region ${region.map(Math.round).join(",")}` : "full screen"} → ${file}` };
		}
	});

	ctx.tools.register({
		name: "gui_read",
		description:
			"OCR a screenshot and return text lines with CENTRE coordinates in points, sorted by reading order. " +
			"Give a file from gui_capture, or omit it to capture a fresh frame. Pass a region (points) to only read part of the screen.",
		parameters: {
			type: "object",
			properties: {
				file: { type: "string", description: "image path from gui_capture; omit to capture now" },
				x: { type: "number" },
				y: { type: "number" },
				w: { type: "number" },
				h: { type: "number" },
				limit: { type: "integer", description: "max lines to return, default 60" }
			}
		},
		output: { schema: TEXT_OUT, render: renderText },
		async execute(args) {
			const region = ["x", "y", "w", "h"].every((k) => Number.isFinite(args[k]))
				? [args.x, args.y, args.x + args.w, args.y + args.h]
				: undefined;
			const file = args.file || (await capture());
			const res = await ocrFile(file, region);
			const head = `${res.count} lines (${Math.round(res.width_pt)}x${Math.round(res.height_pt)} pt) from ${file}`;
			const body = renderLines(res, { limit: Number.isInteger(args.limit) ? args.limit : 60 });
			return { text: `${head}\ny  x  text\n${body}` };
		}
	});

	ctx.tools.register({
		name: "gui_click",
		description:
			"Click by TEXT (capture → OCR → match → click, so coordinates are never stale) or by explicit point. " +
			"Text mode defaults to the left edge of the match, which is where checkbox/radio controls sit; " +
			"use anchor=center for buttons. Holds the button 150 ms by default because many web controls ignore shorter presses. " +
			"After clicking it re-captures and reports the nearest text, so a silent miss is visible.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "substring to match (case-insensitive)" },
				nth: { type: "integer", description: "which match to use, 1-based, default 1" },
				exact: { type: "boolean", description: "require the whole OCR line to equal text" },
				anchor: { type: "string", enum: ["left", "center", "right"], description: "default left" },
				dx: { type: "number", description: "offset in points from the anchor" },
				dy: { type: "number", description: "offset in points from the anchor" },
				hold_ms: { type: "integer", description: "button hold, default 150" },
				x: { type: "number", description: "explicit point x (skips text matching)" },
				y: { type: "number", description: "explicit point y" },
				x0: { type: "number", description: "restrict text matching to this region" },
				y0: { type: "number" },
				x1: { type: "number" },
				y1: { type: "number" }
			}
		},
		output: { schema: TEXT_OUT, render: renderText },
		async execute(args) {
			const hold = Number.isInteger(args.hold_ms) && args.hold_ms > 0 ? args.hold_ms : 150;
			let point;
			let label;
			if (Number.isFinite(args.x) && Number.isFinite(args.y)) {
				point = { x: args.x, y: args.y };
				label = `point (${args.x}, ${args.y})`;
			} else {
				if (typeof args.text !== "string" || args.text.trim() === "") {
					throw new Error("gui_click needs either text or x/y");
				}
				const file = await capture();
				const region =
					Number.isFinite(args.x0) && Number.isFinite(args.y0) && Number.isFinite(args.x1) && Number.isFinite(args.y1)
						? [args.x0, args.y0, args.x1, args.y1]
						: undefined;
				const res = await ocrFile(file, region);
				const needle = args.text.trim().toLowerCase();
				const hits = res.lines.filter((l) =>
					args.exact ? l.text.trim().toLowerCase() === needle : l.text.toLowerCase().includes(needle)
				);
				const pick = hits[(Number.isInteger(args.nth) && args.nth > 0 ? args.nth : 1) - 1];
				if (!pick) {
					const near = res.lines.slice(0, 12).map((l) => l.text).join(" | ");
					throw new Error(`no OCR line matched ${JSON.stringify(args.text)}; saw: ${near}`);
				}
				const anchor = args.anchor === "center" ? pick.x : args.anchor === "right" ? pick.x + pick.w / 2 : pick.x - pick.w / 2;
				point = { x: anchor + (args.dx ?? 0), y: pick.y + (args.dy ?? 0) };
				label = `"${pick.text.slice(0, 32)}" → (${Math.round(point.x)}, ${Math.round(point.y)})`;
			}
			await ops("click", Math.round(point.x * 10) / 10, Math.round(point.y * 10) / 10, hold);
			await new Promise((r) => setTimeout(r, 450));
			let after = "";
			try {
				const file2 = await capture();
				const res2 = await ocrFile(file2);
				const nearest = res2.lines
					.map((l) => ({ l, d: Math.abs(l.y - point.y) + Math.abs(l.x - point.x) }))
					.sort((a, b) => a.d - b.d)[0];
				if (nearest) after = `\nnow nearest text: ${nearest.l.text}`;
			} catch {}
			return { text: `clicked ${label} (hold ${hold} ms)${after}` };
		}
	});

	ctx.tools.register({
		name: "gui_checks",
		description:
			"Read checkbox/radio state by scanning a narrow vertical strip (default x 322-334 pt) and reporting " +
			"each row's y centre plus on/off (green = on). Use it after gui_click to VERIFY a toggle instead of assuming it landed. " +
			"Rows are detected from pixels, so OCR dropping a letter cannot break it.",
		parameters: {
			type: "object",
			properties: {
				file: { type: "string", description: "image path; omit to capture now" },
				x0: { type: "number", description: "strip left, default 322" },
				x1: { type: "number", description: "strip right, default 334" },
				y0: { type: "number", description: "scan top, default 0" },
				y1: { type: "number", description: "scan bottom, default screen height" }
			}
		},
		output: { schema: TEXT_OUT, render: renderText },
		async execute(args) {
			const file = args.file || (await capture());
			const res = await ops(
				"boxes",
				file,
				Number.isFinite(args.x0) ? args.x0 : 322,
				Number.isFinite(args.x1) ? args.x1 : 334,
				Number.isFinite(args.y0) ? args.y0 : 0,
				Number.isFinite(args.y1) ? args.y1 : 956
			);
			const rows = res.rows.map((r, i) => `${i + 1}. y=${Math.round(r.y)} ${r.on ? "ON" : "off"}`);
			return { text: `${rows.length} control(s):\n${rows.join("\n")}` };
		}
	});

	ctx.tools.register({
		name: "gui_window",
		description:
			"Activate an app and set its front window bounds in points, then read the bounds back. " +
			"macOS window tiling can revert a resize asynchronously; the reply says whether the request stuck, " +
			"so never compute click coordinates from a pre-resize screenshot.",
		parameters: {
			type: "object",
			properties: {
				app: { type: "string", description: "localized app name, e.g. Microsoft Edge" },
				x: { type: "number" },
				y: { type: "number" },
				w: { type: "number" },
				h: { type: "number" }
			},
			required: ["app"]
		},
		output: { schema: TEXT_OUT, render: renderText },
		async execute(args) {
			await run("open", ["-a", args.app]).catch(() => {});
			await new Promise((r) => setTimeout(r, 350));
			const haveRect = ["x", "y", "w", "h"].every((k) => Number.isFinite(args[k]));
			if (!haveRect) return { text: `${args.app} activated` };
			const res = await ops("window", args.app, args.x, args.y, args.w, args.h);
			const a = res.actual;
			return {
				text: `${args.app} window → ${Math.round(a.w)}x${Math.round(a.h)} at (${Math.round(a.x)}, ${Math.round(a.y)}) pt; ` +
					`request ${res.matched ? "stuck" : "was overridden by the window manager"}`
			};
		}
	});

	ctx.tools.register({
		name: "gui_note",
		description:
			"Append a lesson to the shared GUI notebook (~/.dsh/gui-ops/notes.jsonl): what went wrong, why, the fix, " +
			"and optionally a reusable example. Search it later with gui_recall. Write these liberally — one line is enough.",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string", description: "short handle, e.g. 'Vision box is 11pt above the button'" },
				symptom: { type: "string", description: "what you observed" },
				cause: { type: "string", description: "why it happened" },
				fix: { type: "string", description: "what to do instead" },
				tags: { type: "array", items: { type: "string" }, description: "e.g. ['ocr','coordinate']" },
				example: { type: "string", description: "copy-pasteable snippet or command" }
			},
			required: ["title", "fix"]
		},
		output: { schema: TEXT_OUT, render: renderText },
		async execute(args) {
			await mkdir(DATA, { recursive: true });
			const entry = {
				id: noteId(),
				ts: new Date().toISOString(),
				title: args.title,
				symptom: args.symptom ?? "",
				cause: args.cause ?? "",
				fix: args.fix,
				tags: Array.isArray(args.tags) ? args.tags : [],
				example: args.example ?? "",
				seen: 1
			};
			const notes = await readNotes();
			const twin = notes.find((n) => sameLesson(n, entry));
			if (twin) {
				twin.seen = (Number(twin.seen) || 1) + 1;
				twin.updated = entry.ts;
				twin.tags = [...new Set([...(twin.tags ?? []), ...entry.tags])];
				if (entry.example && !twin.example) twin.example = entry.example;
				if (entry.cause && !twin.cause) twin.cause = entry.cause;
				await writeNotes(notes);
				await refreshDetail();
				return { text: `merged into #${twin.id} "${twin.title}" (seen x${twin.seen}); nothing appended` };
			}
			await writeFile(NOTES, `${JSON.stringify(entry)}\n`, { flag: "a" });
			let note = "";
			if (notes.length + 1 > noteLimit) {
				const sum = await compactNotes({ limit: noteLimit });
				note = `; compacted ${sum.before}→${sum.after} (merged ${sum.merged}, archived ${sum.archived})`;
			}
			await refreshDetail();
			return { text: `noted ${entry.id}: ${entry.title}${note}` };
		}
	});

	ctx.tools.register({
		name: "gui_recall",
		description:
			"Search the GUI notebook by free text (matches title/symptom/cause/fix/tags) or tags, newest first. " +
			"Use it before starting a GUI task to avoid re-learning the same lessons.",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string" },
				tags: { type: "array", items: { type: "string" } },
				limit: { type: "integer", description: "default 5" }
			}
		},
		output: { schema: TEXT_OUT, render: renderText },
		async execute(args) {
			const notes = await readNotes();
			const needle = (args.query ?? "").trim().toLowerCase();
			const tags = Array.isArray(args.tags) ? args.tags.map((t) => t.toLowerCase()) : [];
			const hits = notes
				.filter((n) => {
					const hay = [n.title, n.symptom, n.cause, n.fix, n.example, ...(n.tags ?? [])].join(" ").toLowerCase();
					if (needle && !hay.includes(needle)) return false;
					if (tags.length && !tags.every((t) => (n.tags ?? []).map((x) => x.toLowerCase()).includes(t))) return false;
					return true;
				})
				.sort((a, b) => noteScore(b) - noteScore(a))
				.slice(0, Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 5);
			if (!hits.length) return { text: `no notes matched (${notes.length} in notebook)` };
			const body = hits
				.map(
					(n) =>
						`#${n.id} ${n.title}${n.seen > 1 ? ` [seen x${n.seen}]` : ""}\n  symptom: ${n.symptom || "-"}\n  cause: ${n.cause || "-"}\n  fix: ${n.fix}` +
						(n.example ? `\n  example: ${n.example}` : "") +
						`\n  tags: ${(n.tags ?? []).join(", ") || "-"}`
				)
				.join("\n\n");
			return { text: `notebook: ${NOTES} (${notes.length} entries)\n\n${body}` };
		}
	});

	ctx.tools.register({
		name: "gui_compact",
		description:
			"Maintain the notebook: merge near-duplicate lessons (summing a seen counter), archive the weakest entries " +
			"into archive.jsonl when over the cap, and rewrite notes.md as a tag-grouped digest. " +
			"Auto-runs when gui_note pushes the file past the cap (default 200, config noteLimit). " +
			"Use dry_run to preview counts without touching files.",
		parameters: {
			type: "object",
			properties: {
				limit: { type: "integer", description: "cap before archiving, default 200" },
				keep: { type: "integer", description: "how many to keep when over the cap, default 75% of limit" },
				dry_run: { type: "boolean" }
			}
		},
		output: { schema: TEXT_OUT, render: renderText },
		async execute(args) {
			const sum = await compactNotes({
				limit: Number.isInteger(args.limit) ? args.limit : noteLimit,
				keep: Number.isInteger(args.keep) ? args.keep : undefined,
				dryRun: args.dry_run === true
			});
			const verb = args.dry_run === true ? "would compact" : "compacted";
			return {
				text: `${verb}: ${sum.before} → ${sum.after} entries (merged ${sum.merged} duplicates, archived ${sum.archived}). ` +
					`notebook ${NOTES}; archive ${ARCHIVE}; digest ${DIGEST}`
			};
		}
	});
}
