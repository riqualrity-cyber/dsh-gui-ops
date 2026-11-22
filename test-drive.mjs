import { apply } from "./index.js";

// Minimal stand-in for the harness tool registry: record registrations, then let
// this script drive a single tool so the plugin can be smoke-tested without a
// harness reload.
const tools = new Map();
const ctx = {
	tools: {
		register(def) {
			tools.set(def.name, def);
		}
	},
	logger: { warn: (...a) => console.error("[warn]", ...a) }
};

apply(ctx, {});

const [name, ...rest] = process.argv.slice(2);
const tool = tools.get(name);
if (!tool) {
	console.error(`unknown tool ${name}; have: ${[...tools.keys()].join(", ")}`);
	process.exit(2);
}
const args = rest.length ? JSON.parse(rest.join(" ")) : {};
const value = await tool.execute(args);
console.log(value.text);
