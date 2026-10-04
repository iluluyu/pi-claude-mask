/**
 * pi-claude-mask — make selected providers look like Claude Code on the wire.
 *
 * Not tied to any relay. ~/.pi/agent/pi-claude-mask.json lists provider ids.
 * Models, base URLs, and API keys stay in models.json / auth.json. Providers
 * that are not listed are untouched, including ones that do not restrict the
 * calling client.
 *
 * Some gateways require the official Claude Code identity sentence and a
 * current Claude Code user agent. That sentence stays in system[0]; Pi's own
 * prompt follows it. Tool names are mapped to mcp__pi__<name> and restored
 * on the response. Transport uses node:https so the TLS stack matches Claude
 * Code. Pi's SDK still supplies the x-stainless-* headers.
 */
import {
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const FALLBACK_CC_VERSION = "2.1.288";
const PI_PREFIX = "mcp__pi__";
const EPHEMERAL = { type: "ephemeral" };
const PROVIDER_ID = /^[A-Za-z0-9._-]+$/;

function claudeCodeVersion(): string {
	const fromEnv = process.env.PI_CLAUDE_MASK_CC_VERSION?.trim();
	if (fromEnv && /^\d+\.\d+\.\d+/.test(fromEnv)) return fromEnv;
	try {
		const which = execFileSync("which", ["claude"], { encoding: "utf8", timeout: 2000 }).trim();
		const resolved = basename(fs.realpathSync(which));
		if (/^\d+\.\d+\.\d+$/.test(resolved)) return resolved;
	} catch {
		// no local claude binary; the fallback is the last version that passed
	}
	return FALLBACK_CC_VERSION;
}

const CC_VERSION = claudeCodeVersion();

const BASE_HEADERS: Record<string, string> = {
	"User-Agent": `claude-cli/${CC_VERSION} (external, sdk-cli)`,
	"x-app": "cli",
	"anthropic-beta":
		"claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,per-turn-control-2026-07-01,mid-conversation-tool-changes-2026-07-01,advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,effort-2025-11-24,fallback-credit-2026-06-01",
};

const CONFIG_PATH = () => join(getAgentDir(), "pi-claude-mask.json");
const DEFAULT_RETRY_PATTERNS = ["rate limit", "too many requests", "overloaded", "\\b429\\b", "\\b529\\b"];
let retryPatterns = compilePatterns(DEFAULT_RETRY_PATTERNS);

function compilePatterns(patterns: string[]): RegExp[] {
	const compiled: RegExp[] = [];
	for (const pattern of patterns) {
		try {
			compiled.push(new RegExp(pattern, "i"));
		} catch {
			console.warn(`[pi-claude-mask] ignoring invalid retry pattern: ${pattern}`);
		}
	}
	return compiled;
}

function isRetryable(message: string): boolean {
	return retryPatterns.some((pattern) => pattern.test(message));
}

function parseProviders(raw: unknown, path: string): string[] {
	const providers = (raw as { providers?: unknown }).providers;
	if (!Array.isArray(providers)) {
		console.warn(`[pi-claude-mask] ${path}: "providers" must be an array of provider ids; mask disabled`);
		return [];
	}
	const ids = [...new Set(providers.map((id) => String(id).trim()).filter(Boolean))];
	const bad = ids.filter((id) => !PROVIDER_ID.test(id));
	if (bad.length > 0) {
		console.warn(`[pi-claude-mask] ignoring invalid provider ids: ${bad.join(", ")}`);
	}
	return ids.filter((id) => PROVIDER_ID.test(id));
}

function loadConfig(): string[] {
	const path = CONFIG_PATH();
	try {
		const raw = JSON.parse(fs.readFileSync(path, "utf8")) as { retryPatterns?: unknown };
		const configured = raw.retryPatterns;
		retryPatterns = compilePatterns(
			Array.isArray(configured)
				? configured.map((pattern) => String(pattern)).filter(Boolean)
				: DEFAULT_RETRY_PATTERNS,
		);
		return parseProviders(raw, path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		retryPatterns = compilePatterns(DEFAULT_RETRY_PATTERNS);
		console.warn(
			code === "ENOENT"
				? `[pi-claude-mask] no ${path}; mask disabled`
				: `[pi-claude-mask] could not read ${path}; mask disabled`,
		);
		return [];
	}
}

function saveProviders(providers: string[]): void {
	const path = CONFIG_PATH();
	let existing: Record<string, unknown> = {};
	try {
		existing = JSON.parse(fs.readFileSync(path, "utf8"));
	} catch {
		existing = {};
	}
	existing.providers = providers;
	fs.writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`);
}

const hex = (n: number): string =>
	Array.from(crypto.getRandomValues(new Uint8Array(n)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

function readDevice(file: string): string | undefined {
	try {
		const existing = fs.readFileSync(file, "utf8").trim();
		if (/^[0-9a-f]{64}$/.test(existing)) return existing;
	} catch {
		return undefined;
	}
	return undefined;
}

/** Stable per-provider device id. A changed id busts the prompt-cache prefix. */
function loadDeviceId(provider: string): string {
	const file = join(getAgentDir(), "pi-claude-mask", "devices", provider);
	const current = readDevice(file);
	if (current) return current;
	const legacy = fileURLToPath(new URL(`./.${provider}-device`, import.meta.url));
	const migrated = readDevice(legacy);
	const id = migrated ?? hex(32);
	try {
		fs.mkdirSync(dirname(file), { recursive: true });
		fs.writeFileSync(file, id);
	} catch {
		// still use the id for this process if the agent dir is not writable
	}
	return id;
}

function ccSessionIdFor(provider: string, piSessionId: string | undefined): string {
	if (!piSessionId) return crypto.randomUUID();
	const d = createHash("sha256").update(`${provider}:${piSessionId}`).digest("hex").slice(0, 32);
	return `${d.slice(0, 8)}-${d.slice(8, 12)}-${d.slice(12, 16)}-${d.slice(16, 20)}-${d.slice(20, 32)}`;
}

const toWireName = (name: string): string => (name.startsWith("mcp__") ? name : PI_PREFIX + name);
const fromWireName = (name: string): string => (name.startsWith(PI_PREFIX) ? name.slice(PI_PREFIX.length) : name);

interface WireTool {
	name: string;
	description?: string;
	input_schema?: unknown;
	cache_control?: unknown;
	[key: string]: unknown;
}

const cleanTool = (tool: Record<string, unknown>): WireTool => ({
	name: toWireName(String(tool.name)),
	...(tool.description !== undefined ? { description: tool.description } : {}),
	...(tool.input_schema !== undefined ? { input_schema: tool.input_schema } : {}),
});

/** Rewrite the outgoing payload into a Claude Code-shaped Messages request. */
function rewritePayload(params: Record<string, any>, userId: string): Record<string, any> {
	const { betas: _dropped, temperature: _temp, ...rest } = params;

	if (Array.isArray(rest.tools) && rest.tools.length > 0) {
		rest.tools = rest.tools.map((tool: Record<string, unknown>) => cleanTool(tool));
		rest.tools[rest.tools.length - 1].cache_control = EPHEMERAL;
	}

	const system = (Array.isArray(rest.system) ? rest.system : []).map((block: any) => {
		if (block && typeof block === "object") delete block.cache_control;
		return block;
	});
	if (system[0]?.text !== CC_IDENTITY) system.unshift({ type: "text", text: CC_IDENTITY });
	if (system.length > 1) system[system.length - 1].cache_control = EPHEMERAL;

	if (Array.isArray(rest.messages) && rest.messages.length > 0) {
		for (const msg of rest.messages) {
			if (!Array.isArray(msg?.content)) continue;
			for (const block of msg.content) {
				if (block?.type === "tool_use") block.name = toWireName(String(block.name));
				if (block?.cache_control?.ttl) block.cache_control = EPHEMERAL;
			}
		}
		const last = rest.messages[rest.messages.length - 1];
		if (last && Array.isArray(last.content) && last.content.length > 0) {
			const lastBlock = last.content[last.content.length - 1];
			if (lastBlock && typeof lastBlock === "object" && !lastBlock.cache_control) {
				lastBlock.cache_control = EPHEMERAL;
			}
		}
	}

	return {
		...rest,
		system,
		metadata: { user_id: userId },
	};
}

function restorePiToolNames(event: any): any {
	if (event?.type === "toolcall_start" || event?.type === "toolcall_delta" || event?.type === "toolcall_end") {
		const partial = event.partial;
		if (partial && Array.isArray(partial.content)) {
			for (const block of partial.content) {
				if (block?.type === "toolCall" && typeof block.name === "string") {
					block.name = fromWireName(block.name);
				}
			}
		}
		if (event.toolCall && typeof event.toolCall.name === "string") {
			event.toolCall.name = fromWireName(event.toolCall.name);
		}
	}
	return event;
}

function assistantError(model: Model<Api>, message: string) {
	return {
		role: "assistant" as const,
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error" as const,
		errorMessage: message,
		timestamp: Date.now(),
	};
}

/** node:https matches Claude Code's TLS stack. undici's JA3 is a separate gate. */
function nodeHttpsFetch(input: any, init?: any): Promise<Response> {
	return new Promise((resolve, reject) => {
		const url = String(input instanceof Request ? input.url : input);
		const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
		const headerObj: Record<string, string> = {};
		const h = init?.headers ?? (input instanceof Request ? input.headers : undefined);
		if (h) {
			if (typeof (h as Headers).forEach === "function") {
				(h as Headers).forEach((value: string, key: string) => {
					headerObj[key] = value;
				});
			} else if (Array.isArray(h)) {
				for (const [key, value] of h as [string, string][]) headerObj[key] = value;
			} else {
				Object.assign(headerObj, h as Record<string, string>);
			}
		}
		const body = init?.body as string | undefined;
		const u = new URL(url);
		const req = https.request(
			{
				hostname: u.hostname,
				port: u.port ? Number(u.port) : 443,
				path: u.pathname + u.search,
				method,
				headers: body !== undefined ? { ...headerObj, "content-length": Buffer.byteLength(body) } : headerObj,
			},
			(res) => {
				resolve(
					new Response(Readable.toWeb(res) as unknown as ReadableStream, {
						status: res.statusCode,
						statusText: res.statusMessage,
						headers: res.headers as any,
					}),
				);
			},
		);
		req.on("error", reject);
		if (init?.signal) {
			const signal = init.signal as AbortSignal;
			if (signal.aborted) req.destroy(new Error("aborted"));
			else signal.addEventListener("abort", () => req.destroy(new Error("aborted")));
		}
		if (body !== undefined) req.end(body);
		else req.end();
	});
}

function streamAsClaudeCode(
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	deviceId: string,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		try {
			const outerOnPayload = options?.onPayload;
			const provider = String(model.provider);
			const sessionId = ccSessionIdFor(provider, options?.sessionId);
			const userId = JSON.stringify({
				device_id: deviceId,
				account_uuid: "",
				session_id: sessionId,
			});
			const streamOptions: SimpleStreamOptions = {
				...options,
				fetch: nodeHttpsFetch as any,
				headers: {
					...BASE_HEADERS,
					"x-claude-code-session-id": sessionId,
					...options?.headers,
				},
				onPayload: async (payload: any, m: any) => {
					const rewritten = rewritePayload(payload, userId);
					return outerOnPayload ? outerOnPayload(rewritten, m) : rewritten;
				},
			};
			const MAX_ATTEMPTS = 3;
			let lastErrorEvent: any = null;
			for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
				let retryable = false;
				let forwardedAny = false;
				try {
					const inner = anthropicMessagesApi().streamSimple(
						model as Model<"anthropic-messages">,
						context,
						streamOptions,
					);
					for await (const event of inner) {
						if (event?.type === "error") {
							const msg = String(event.error?.errorMessage ?? "");
							if (!forwardedAny && isRetryable(msg)) {
								retryable = true;
								lastErrorEvent = event;
								break;
							}
							stream.push(event);
							continue;
						}
						forwardedAny = true;
						stream.push(restorePiToolNames(event));
					}
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					if (!forwardedAny && attempt < MAX_ATTEMPTS && isRetryable(msg)) {
						retryable = true;
					} else {
						stream.push({ type: "error", reason: "error", error: assistantError(model, msg) });
					}
				}
				if (!retryable) {
					stream.end();
					return;
				}
				if (attempt < MAX_ATTEMPTS) {
					await new Promise((r) => setTimeout(r, 2500 * attempt));
				}
			}
			stream.push(
				lastErrorEvent ?? {
					type: "error",
					reason: "error",
					error: assistantError(model, "relay blocked after retries"),
				},
			);
			stream.end();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: "error", error: assistantError(model, message) });
			stream.end();
		}
	})();
	return stream;
}

const activeProviders = new Set<string>();

function scopeLabel(providers: Iterable<string>): string {
	const names = [...providers].sort();
	return names.length === 0 ? "mask: off" : `mask: ${names.join(", ")}`;
}

function registerMask(pi: ExtensionAPI, provider: string): void {
	const deviceId = loadDeviceId(provider);
	pi.registerProvider(provider, {
		api: "anthropic-messages",
		streamSimple: (model, context, options) => streamAsClaudeCode(model, context, options, deviceId),
	});
	activeProviders.add(provider);
}

/** Apply a saved provider list. Only Anthropic Messages calls on those ids are rewritten. */
function applyProviderScope(pi: ExtensionAPI, next: string[]): void {
	const wanted = new Set(next);
	for (const name of [...activeProviders]) {
		if (wanted.has(name)) continue;
		pi.unregisterProvider(name);
		activeProviders.delete(name);
	}
	for (const name of wanted) {
		if (!activeProviders.has(name)) registerMask(pi, name);
	}
}

function anthropicProviderIds(models: readonly { provider: string; api: string }[]): string[] {
	const ids = new Set<string>(activeProviders);
	for (const model of models) {
		if (model.api === "anthropic-messages") ids.add(model.provider);
	}
	return [...ids].filter((id) => PROVIDER_ID.test(id)).sort();
}

export default function (pi: ExtensionAPI): void {
	const initial = loadConfig();
	if (initial.length > 0) {
		console.warn(`[pi-claude-mask] masking ${initial.join(", ")} as claude-cli/${CC_VERSION}`);
		applyProviderScope(pi, initial);
	}

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("claude-mask", scopeLabel(activeProviders));
	});

	pi.registerCommand("claude-mask", {
		description: "Choose which providers use the Claude Code mask",
		handler: async (_args, ctx) => {
			const selected = new Set(activeProviders);
			for (;;) {
				const providers = anthropicProviderIds(ctx.modelRegistry.getAll());
				const current = [...selected].sort().join(", ") || "(none)";
				const choice = await ctx.ui.select(
					`Claude mask scope: ${current}\nToggle a provider, then Done. Esc cancels. Other providers stay on Pi's normal client.`,
					[
						...providers.map((id) => `${selected.has(id) ? "[x]" : "[ ]"} ${id}`),
						"Done",
					],
				);
				if (!choice) return;
				if (choice === "Done") break;
				const id = choice.replace(/^\[[ x]\] /, "");
				if (!PROVIDER_ID.test(id)) continue;
				if (selected.has(id)) selected.delete(id);
				else selected.add(id);
			}
			const next = [...selected].sort();
			saveProviders(next);
			applyProviderScope(pi, next);
			ctx.ui.setStatus("claude-mask", scopeLabel(next));
			ctx.ui.notify(next.length === 0 ? "Claude mask off" : `Claude mask: ${next.join(", ")}`, "info");
		},
	});
}
