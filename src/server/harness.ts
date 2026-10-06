import {
	AgentHarness,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	JsonlSessionRepo,
	shouldCompact,
} from "@earendil-works/pi-agent-core";
import type { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	type Api,
	type AssistantMessage,
	getModel,
	getModels,
	getProviders,
	isContextOverflow,
	type KnownProvider,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai";
import type { LocalLlmConfig, LocalLlmId } from "./llama.js";
import { localLlmConfigs } from "./llama.js";
import type { Logger } from "./logger.js";
import type { RadioService } from "./radio.js";
import type { RobotClient } from "./robot-client.js";
import { createRobotTools, pruneImagesForContext } from "./tools/index.js";
import type { MemoryStore } from "./tools/memory.js";
import type { SpotifyHandler } from "./tools/spotify.js";

const LOCAL_PROVIDER = "llama-cpp-local";
const LOCAL_API_KEY = "EMPTY";
// JsonlSessionRepo groups session files by a cwd key; each user has their own sessions dir, so one fixed key.
const SESSION_CWD = "pibot";
const compactionInstructions =
	"This is a spoken conversation between a user and a small voice robot, not a coding session. Under Goal, list the topics and requests discussed. Record facts the user shared about themselves, their preferences, what the robot did with its tools, what it promised, and open questions. Write (none) for anything about files or code.";
const overflowRetryPrompt =
	"Internal continuation: the conversation history was too long and has just been compacted into a summary. Answer the user's last message now, briefly, in English.";

function createLocalModel(config: LocalLlmConfig, baseUrl: string, contextWindow: number): Model<"openai-completions"> {
	return {
		id: config.modelFile,
		name: config.name,
		api: "openai-completions",
		provider: LOCAL_PROVIDER,
		baseUrl,
		reasoning: false,
		input: [...config.input],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens: config.maxTokens,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
		},
	};
}

function selectModel(localLlm: LocalLlmId, localBaseUrl: string, localContextWindow: number): Model<Api> {
	const provider = process.env.PI_PROVIDER ?? LOCAL_PROVIDER;
	const modelId = process.env.PI_MODEL ?? localLlmConfigs[localLlm].modelFile;
	if (provider === LOCAL_PROVIDER) {
		const config = localLlmConfigs[localLlm];
		if (modelId !== config.modelFile) throw new Error(`Unknown PI_MODEL for ${provider}/${localLlm}: ${modelId}`);
		return createLocalModel(config, localBaseUrl, localContextWindow);
	}
	if (!getProviders().includes(provider as KnownProvider)) throw new Error(`Unknown PI_PROVIDER: ${provider}`);
	const models = getModels(provider as KnownProvider);
	if (!models.some((model) => model.id === modelId)) throw new Error(`Unknown PI_MODEL for ${provider}: ${modelId}`);
	return getModel(provider as KnownProvider, modelId as never) as Model<Api>;
}

function formatMemories(memories: string[]): string {
	if (memories.length === 0) return "No stored memories yet.";
	return memories.map((memory, index) => `${index}: ${memory}`).join("\n");
}

const robotInstructions = `You are the brain of a small robot with a smartphone. Always answer in English. Be playful, friendly, and safe. Your text is sent directly to a plain-text speech synthesizer: do not use Markdown, lists, code blocks, headings, or emojis. Write numbers so that a speech synthesizer reads them naturally: avoid digits with thousands or decimal separators like 6,400 or 1.23; write spoken forms instead, such as six thousand four hundred or one point two three. Use the movement tools only for short durations. The movement tools stop automatically after their duration. The hardware can only drive forward and turn counterclockwise; there is no reverse and no right turn. For approximate turn angles use turn_left_degrees. If a task requires a tool, call it immediately via a tool call before you answer; do not just announce it. For internet radio, use radio_search (searchBy tag for a genre or style, name for a specific station), then radio_play with a stationuuid from the results; pick a fitting station yourself instead of reading the list aloud, unless the user asks for options. Use radio_control to stop, pause, resume, make it louder or quieter, or say what is playing.${
	process.env.BRAVE_API_KEY
		? " If you need current facts or information from the internet, use web_search. If you need details from a search result, use fetch_page_content with the URL."
		: " You have no web search: answer from your own knowledge, and use fetch_page_content only for a URL the user gives you."
}`;

const spotifyInstructions =
	" Use spotify_search for specific songs, artists, albums, playlists, children's songs, podcasts, or audiobooks when you do not know the exact Spotify URI yet; request at least five results unless the user explicitly asks for fewer; then play the chosen URI with spotify_play. Spotify itemType values are exactly track, album, playlist, show, episode, or audiobook; for podcasts use show, for podcast episodes use episode, never podcast. Use spotify_control to pause, resume, skip, or check the current playback. Prefer Spotify for specific items and the radio for genres and stations.";
const noSpotifyInstructions =
	" Spotify is not connected, so you cannot play a specific song, album, or podcast on demand; offer a fitting radio station instead.";
const spotifyToolNames = ["spotify_search", "spotify_play", "spotify_control"];

const memoryToolInstructions = `Memory tool:
- Use the memory tool through the tool-calling interface, not as text in your answer.
- Never write tool calls like memory(...) or JSON for tools into your normal answer text.
- When you should read memories, call memory with action read or without arguments.
- When you should store something, call memory with action append and text. Only claim it was stored after that.
- When you should delete a memory, call memory with action remove and index.`;

function hasRobotNameMemory(memories: string[]): boolean {
	return memories.some((memory) => /\b(roboter|robot)\b.*\b(heißt|is called)\b/i.test(memory));
}

function hasUserNameMemory(memories: string[]): boolean {
	return memories.some((memory) => /\b(nutzer|user)\b.*\b(heißt|is called)\b/i.test(memory));
}

async function buildSystemPrompt(memoryStore: MemoryStore, spotifyActive: boolean): Promise<string> {
	const instructions = `${robotInstructions}${spotifyActive ? spotifyInstructions : noSpotifyInstructions}`;
	const memories = await memoryStore.list();
	const hasRobotName = hasRobotNameMemory(memories);
	const hasUserName = hasUserNameMemory(memories);
	if (!hasRobotName || !hasUserName) {
		return `${instructions}

First-time setup:
- Setup is not finished for this user yet. You must first store your robot name and then store the user's name.
- Do not handle any other tasks and do not use any other tools until both names are stored.
- If no robot name is stored yet, ask briefly and kindly what the user would like to call you. Do not ask for the user's name yet.
- When the user tells you your robot name, immediately call the memory tool with action append and a text in the format The robot is called NAME. Only then answer briefly that you remembered your name, and then ask for the user's name.
- If your robot name is already stored but the user's name is missing, ask briefly and kindly: And what is your name? Mention that you will also take a look at a photo so you can recognize the user later.
- When the user tells you their name and your robot name is already stored, first call take_photo. Briefly describe for yourself what you see about the user in the photo, without inventing uncertain traits.
- Then immediately call the memory tool with action append. Store the name and the photo impression together in one text in the format The user is called NAME. In the photo I see: DESCRIPTION.
- Only after storing, answer briefly that you remembered the name and the photo impression.
- Once both names are stored, normal mode with the stored memories applies from the next user turn on.

Persistent memories:
${formatMemories(memories)}

${memoryToolInstructions}`;
	}
	return `${instructions}

Persistent memories:
${formatMemories(memories)}

${memoryToolInstructions}`;
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((entry): entry is TextContent => entry.type === "text")
		.map((entry) => entry.text)
		.join("")
		.trim();
}

export type RobotHarnessEvent =
	| { type: "assistant_start" }
	| { type: "assistant_delta"; text: string }
	| { type: "tool_start"; name: string; args: unknown }
	| { type: "tool_end"; name: string; result: unknown; isError: boolean }
	| { type: "assistant_end"; text: string }
	| { type: "session_reset"; reason: string };

export interface RobotHarness {
	current: () => AgentHarness;
	prompt: (text: string) => Promise<AssistantMessage>;
	model: () => Model<Api>;
	rebuildSession: (reason: string) => Promise<void>;
}

export async function createRobotHarness(deps: {
	env: NodeExecutionEnv;
	logger: Logger;
	memoryStore: MemoryStore;
	localLlm: LocalLlmId;
	localBaseUrl: string;
	localContextWindow: number;
	maxContextImages: number;
	sessionsDir: string;
	robot: RobotClient;
	spotify: SpotifyHandler;
	spotifyConnected: () => Promise<boolean>;
	radio: RadioService;
	onEvent: (event: RobotHarnessEvent) => void | Promise<void>;
	beforeTool: (name: string, args: unknown) => void | Promise<void>;
}): Promise<RobotHarness> {
	const sessionRepo = new JsonlSessionRepo({ fs: deps.env, sessionsRoot: deps.sessionsDir });
	const tools = createRobotTools(deps.robot, deps.memoryStore, deps.spotify, deps.radio);
	const contextLogger = deps.logger.tag("context");
	const emit = async (event: RobotHarnessEvent): Promise<void> => {
		try {
			await deps.onEvent(event);
		} catch (error) {
			console.error(`[harness] event handler failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	const selectedModel = selectModel(deps.localLlm, deps.localBaseUrl, deps.localContextWindow);
	// Conversations persist as JSONL under the user's dir; on startup continue the newest one.
	const [latestSession] = await sessionRepo.list({ cwd: SESSION_CWD });
	let session = latestSession ? await sessionRepo.open(latestSession) : await sessionRepo.create({ cwd: SESSION_CWD });
	if (latestSession) {
		contextLogger.log(`resumed conversation ${latestSession.path} (~${await contextTokens()} tokens)`);
	}
	let harness = buildHarness();
	// Threshold compaction runs after a reply, while it is being spoken; the next prompt waits for it.
	let pendingCompaction: Promise<void> = Promise.resolve();

	async function contextTokens(): Promise<number> {
		const { messages } = await session.buildContext();
		const summary = messages.find((message) => message.role === "compactionSummary");
		// Replies kept from before a compaction carry usage that still counts the compacted-away history.
		if (
			summary &&
			!messages.some((message) => message.role === "assistant" && message.timestamp > summary.timestamp)
		) {
			return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
		}
		return estimateContextTokens(messages).tokens;
	}

	// Same policy as the pi coding agent: compact once the context passes window - reserveTokens,
	// or unconditionally after the server rejected a request as too long.
	async function compactIfNeeded(afterOverflow: boolean): Promise<void> {
		try {
			const tokens = await contextTokens();
			if (!afterOverflow && !shouldCompact(tokens, selectedModel.contextWindow, DEFAULT_COMPACTION_SETTINGS)) return;
			contextLogger.log(
				`compacting ${afterOverflow ? "after context overflow" : "at threshold"}: ~${tokens} tokens`,
			);
			const result = await harness.compact(compactionInstructions);
			contextLogger.log(`compacted: ${result.tokensBefore} tokens -> ~${await contextTokens()} tokens`);
		} catch (error) {
			contextLogger.log(`compaction failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function buildHarness(): AgentHarness {
		const newHarness = new AgentHarness({
			env: deps.env,
			session,
			model: selectedModel,
			getApiKeyAndHeaders: async (model) => {
				const envName = `${model.provider.toUpperCase()}_API_KEY`.replaceAll("-", "_");
				const apiKey = process.env[envName] ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY;
				if (apiKey) return { apiKey };
				if (model.provider === LOCAL_PROVIDER) return { apiKey: LOCAL_API_KEY };
				return undefined;
			},
			tools,
			systemPrompt: async ({ activeTools }) =>
				buildSystemPrompt(
					deps.memoryStore,
					activeTools.some((tool) => tool.name === "spotify_search"),
				),
		});
		newHarness.on("tool_call", async (event) => {
			await deps.beforeTool(event.toolName, event.input);
			return undefined;
		});
		newHarness.on("context", async (event) => {
			const context = pruneImagesForContext(event.messages, deps.maxContextImages);
			if (context.removedImages > 0) {
				contextLogger.log(`removed ${context.removedImages} old image(s), kept ${deps.maxContextImages}`);
			}
			return { messages: context.messages };
		});
		newHarness.subscribe(async (event) => {
			if (event.type === "message_start" && event.message.role === "assistant")
				await emit({ type: "assistant_start" });
			if (
				event.type === "message_update" &&
				event.message.role === "assistant" &&
				event.assistantMessageEvent.type === "text_delta"
			) {
				await emit({ type: "assistant_delta", text: event.assistantMessageEvent.delta });
			}
			if (event.type === "tool_execution_start") {
				await emit({ type: "tool_start", name: event.toolName, args: event.args });
			}
			if (event.type === "tool_execution_end") {
				await emit({ type: "tool_end", name: event.toolName, result: event.result, isError: event.isError });
			}
			if (event.type === "message_end" && event.message.role === "assistant") {
				await emit({ type: "assistant_end", text: extractAssistantText(event.message) });
			}
		});
		return newHarness;
	}

	return {
		current: () => harness,
		prompt: async (text) => {
			await pendingCompaction;
			// Spotify tools only while this account's Spotify is connected; otherwise the bot reaches for
			// them on every music request and fails. Changed only on transitions (each change is logged).
			const spotifyWanted = await deps.spotifyConnected();
			const active = harness.getActiveTools().map((tool) => tool.name);
			if (spotifyWanted !== active.includes("spotify_search")) {
				const others = tools.map((tool) => tool.name).filter((name) => !spotifyToolNames.includes(name));
				await harness.setActiveTools(spotifyWanted ? [...others, ...spotifyToolNames] : others);
			}
			await compactIfNeeded(false);
			let message = await harness.prompt(text);
			if (isContextOverflow(message, selectedModel.contextWindow)) {
				await compactIfNeeded(true);
				message = await harness.prompt(overflowRetryPrompt);
			}
			pendingCompaction = compactIfNeeded(false);
			return message;
		},
		model: () => selectedModel,
		rebuildSession: async (reason) => {
			// The old conversation stays on disk; start a new file.
			session = await sessionRepo.create({ cwd: SESSION_CWD });
			harness = buildHarness();
			await emit({ type: "session_reset", reason });
		},
	};
}
