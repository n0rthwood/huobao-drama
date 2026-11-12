// huobao-workflow-gate — omp extension enforcing the Huobao production workflow (Issue #97).
//
// Scope: sessions (main and subagents) whose cwd is inside a production root
// (HUOBAO_WF_ROOT, colon-separated; default ~/projects/history_project).
// Inside that scope every Huobao business call must go through `hbwf call`, which re-derives
// state from Huobao and refuses steps whose prerequisites are unmet. This extension blocks
// the bypasses: direct API access from bash/eval, scripts that post to the API, edits of the
// workflow state/ledger/decision files, and UI-mutating browser actions.
// Install: cp <skill>/workflow/omp-extension/huobao-workflow-gate.ts ~/.omp/agent/extensions/
// (hbwf refuses writes when the installed copy differs from the skill copy).
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

type ToolInput = Record<string, unknown>;

interface DerivedShot {
	id: number;
	next: string;
}

interface DerivedState {
	drama_id?: number;
	episode_id?: number;
	derived_at?: string;
	poster?: unknown;
	batches?: unknown;
	final_gate?: string[];
	shots?: DerivedShot[];
}

const ROOTS = (process.env.HUOBAO_WF_ROOT ?? join(homedir(), "projects/history_project"))
	.split(":")
	.filter(Boolean)
	.map(r => resolve(r));
const HBWF = join(homedir(), ".omp/agent/managed-skills/huobao-director/workflow/hbwf.py");
const API_RE = /\/huobao\/api\/|:5679\/api\/|huobao[\w.-]*\/api\/v1/i;
const WRITE_HINT_RE = /\b(POST|PUT|DELETE|PATCH)\b|method\s*=|--data|\s-d\s|-X\s*(POST|PUT|DELETE|PATCH)|\bdata\s*=|json\s*=/;
const HBWF_IMPORT_RE = /\b(import\s+hbwf|from\s+hbwf|run_path\([^)]*hbwf|importlib[^\n]*hbwf|spec_from_file_location[^\n]*hbwf)/;
const WF_FILE_RE = /workflow\/(workflow\.json|state\.json|ledger\.jsonl|decisions\.jsonl|attribution\.json|bodies\/|\.lock)/;
const WF_MUTATE_RE = />|\btee\b|sed\s+-i|\brm\b|\bmv\b|\bcp\b|truncate|\bpython|\bnode\b|\bperl\b|\bbun\b/;
const BROWSER_MUTATE_DEVICE_RE = /^xd:\/\/mcp__(agent_browser_(click|fill|type|press|select|check|uncheck)|browser39_(submit|fill|click))$/;
const BROWSER_MUTATE_CLI_RE = /agent-browser[^\n|;&]*\s(click|fill|type|press|select|check|uncheck|upload|drag|keyboard)\b/;
const SCRIPT_TOKEN_RE = /[\w./~-]+\.(py|js|mjs|cjs|ts|sh)\b/g;
const WF_WRITE_IN_CODE_RE = /write|open\([^)]*['"][wa]|unlink|rename|Bun\.write/;

const RULE =
	"Huobao workflow is enforced in this directory: business calls go only through " +
	`\`python3 ${HBWF} call METHOD PATH --body-file ... --intent ...\` (reads: \`hbwf get\`, state: \`hbwf check\`). ` +
	"Record approvals/rework/exceptions with `hbwf decide`. See skill://huobao-director/references/workflow.md.";

function str(input: ToolInput, key: string): string {
	const v = input[key];
	return typeof v === "string" ? v : "";
}

function inScope(cwd: string): boolean {
	const c = resolve(cwd);
	return ROOTS.some(r => c === r || c.startsWith(`${r}/`));
}

function findProject(cwd: string): string | undefined {
	let p = resolve(cwd);
	while (true) {
		if (existsSync(join(p, "workflow/workflow.json"))) return p;
		const parent = dirname(p);
		if (parent === p) return undefined;
		p = parent;
	}
}

function scriptBypass(command: string, cwd: string): string | undefined {
	for (const token of command.match(SCRIPT_TOKEN_RE) ?? []) {
		if (token.endsWith("hbwf.py")) continue;
		const file = token.startsWith("~/") ? join(homedir(), token.slice(2)) : isAbsolute(token) ? token : join(cwd, token);
		if (!existsSync(file) || statSync(file).size > 2_000_000) continue;
		const text = readFileSync(file, "utf8");
		if ((API_RE.test(text) || /api_base/.test(text)) && WRITE_HINT_RE.test(text)) return token;
		if (HBWF_IMPORT_RE.test(text)) return token;
	}
	return undefined;
}

function block(reason: string) {
	return { block: true, reason: `${reason}\n${RULE}` };
}

function summarizeState(project: string): string {
	const p = join(project, "workflow/state.json");
	if (!existsSync(p)) return `No derived state yet for ${project}; run \`python3 ${HBWF} check\` first.`;
	let s: DerivedState;
	try {
		s = JSON.parse(readFileSync(p, "utf8")) as DerivedState; // written by hbwf derive; shape owned by hbwf
	} catch (err) {
		return `workflow/state.json unreadable (${String(err)}); run \`hbwf check\`.`;
	}
	const groups = new Map<string, number[]>();
	for (const r of s.shots ?? []) {
		const list = groups.get(r.next) ?? [];
		list.push(r.id);
		groups.set(r.next, list);
	}
	return [
		`Huobao workflow state for drama ${s.drama_id} episode ${s.episode_id} (derived ${s.derived_at}; re-derive with \`hbwf check\` before acting — this snapshot may be stale):`,
		`poster: ${JSON.stringify(s.poster)}`,
		`batches: ${JSON.stringify(s.batches)}`,
		...[...groups.entries()].map(([k, v]) => `  ${k}: ${v.length} ${JSON.stringify(v.slice(0, 40))}${v.length > 40 ? "…" : ""}`),
		`final gate problems (non-shot): ${JSON.stringify((s.final_gate ?? []).filter(g => !g.startsWith("shot ")))}`,
	].join("\n");
}

function checkTool(tool: string, input: ToolInput, cwd: string): string | undefined {
	if (tool === "bash") {
		const command = str(input, "command");
		if (API_RE.test(command)) return "Blocked: direct Huobao API access from bash. Use hbwf (get/check/call).";
		if (HBWF_IMPORT_RE.test(command)) return "Blocked: importing hbwf internals bypasses its guard. Use the hbwf CLI.";
		if (WF_FILE_RE.test(command) && WF_MUTATE_RE.test(command) && !/hbwf\.py/.test(command))
			return "Blocked: workflow state/ledger/decision files are written only by hbwf.";
		if (BROWSER_MUTATE_CLI_RE.test(command))
			return "Blocked: UI-mutating browser actions bypass the workflow ledger; browser use is read-only here.";
		const script = scriptBypass(command, cwd);
		if (script) return `Blocked: ${script} sends Huobao writes (or imports hbwf) outside hbwf.`;
		return undefined;
	}
	if (tool === "eval") {
		const code = str(input, "code");
		if (API_RE.test(code)) return "Blocked: direct Huobao API access from eval. Use hbwf via bash.";
		if (HBWF_IMPORT_RE.test(code)) return "Blocked: importing hbwf internals bypasses its guard.";
		if (WF_FILE_RE.test(code) && WF_WRITE_IN_CODE_RE.test(code)) return "Blocked: workflow files are written only by hbwf.";
		if (/\/huobao\//.test(code) && /\bbrowser\b|\btab\./.test(code))
			return "Blocked: driving the Huobao UI from eval bypasses the workflow ledger.";
		return undefined;
	}
	if (tool === "write" || tool === "edit") {
		const path = str(input, "path");
		if (BROWSER_MUTATE_DEVICE_RE.test(path)) return "Blocked: UI-mutating browser action.";
		const content = str(input, "content") || str(input, "input");
		if (WF_FILE_RE.test(path)) return "Blocked: workflow state/ledger/decision files are written only by hbwf.";
		if (tool === "edit" && WF_FILE_RE.test(content.split("\n").filter(l => l.startsWith("[")).join("\n")))
			return "Blocked: workflow state/ledger/decision files are written only by hbwf.";
		if (content && (((API_RE.test(content) || /api_base/.test(content)) && WRITE_HINT_RE.test(content)) || HBWF_IMPORT_RE.test(content)))
			return "Blocked: writing a script that calls Huobao write APIs (or imports hbwf) outside hbwf.";
	}
	return undefined;
}

export default function huobaoWorkflowGate(pi: ExtensionAPI) {
	pi.setLabel("Huobao workflow gate");

	pi.on("tool_call", async (event, ctx) => {
		const input = (event.input ?? {}) as ToolInput; // per-tool input shapes differ; only string fields are read via str()
		const sessionCwd = ctx.cwd ?? process.cwd();
		const cwd = str(input, "cwd") ? resolve(sessionCwd, str(input, "cwd")) : sessionCwd;
		if (!inScope(sessionCwd) && !inScope(cwd)) return undefined;
		const reason = checkTool(event.toolName, input, cwd);
		return reason ? block(reason) : undefined;
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const cwd = ctx.cwd ?? process.cwd();
		if (!inScope(cwd)) return undefined;
		const project = findProject(cwd);
		const content = project
			? `${RULE}\n${summarizeState(project)}`
			: `${RULE}\nNo workflow/workflow.json found above ${cwd}: initialise one with \`hbwf init\` before any Huobao production write.`;
		return { message: { customType: "huobao-workflow-state", content, display: false } };
	});
}
