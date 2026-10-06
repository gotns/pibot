import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	SpotifyAction,
	SpotifyDeviceInfo,
	SpotifyItemType,
	SpotifyNowPlaying,
	SpotifyRpcRequest,
	SpotifyRpcResponse,
	SpotifySearchResult,
} from "../types.js";
import type { Logger } from "./logger.js";

// Spotify for a pibot account, held on the server: one PKCE login per account works from every
// device the account uses. Tokens live in the account's data dir, never in a browser.

const accountsUrl = "https://accounts.spotify.com";
const apiUrl = "https://api.spotify.com/v1";
const spotifyScopes = [
	"user-read-private",
	"user-read-playback-state",
	"user-modify-playback-state",
	"user-read-currently-playing",
	"streaming",
].join(" ");
const loginTimeoutMs = 10 * 60_000;
const noDeviceMessage =
	"No Spotify device is available. Open Spotify on a phone, computer or speaker, or press 'Use this browser as speaker' in the Spotify panel.";

interface StoredSpotify {
	clientId?: string;
	tokenClientId?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	displayName?: string;
	selectedDeviceId?: string;
	pendingLogin?: { state: string; verifier: string; redirectUri: string; clientId: string; createdAt: number };
}

export interface SpotifyServerStatus {
	clientId: string;
	connected: boolean;
	displayName?: string;
	devices: SpotifyDeviceInfo[];
	selectedDeviceId?: string;
}

export interface SpotifyService {
	status: (user: string) => Promise<SpotifyServerStatus>;
	setClientId: (user: string, clientId: string) => Promise<void>;
	beginLogin: (user: string, redirectUri: string) => Promise<string>;
	completeLogin: (user: string, callback: { code?: string; state?: string; error?: string }) => Promise<void>;
	disconnect: (user: string) => Promise<void>;
	loadDevices: (user: string) => Promise<SpotifyDeviceInfo[]>;
	selectDevice: (user: string, deviceId: string | undefined) => Promise<void>;
	useBrowserPlayer: (user: string, deviceId: string) => Promise<void>;
	accessToken: (user: string) => Promise<string>;
	handle: (user: string, payload: SpotifyRpcRequest, signal?: AbortSignal) => Promise<SpotifyRpcResponse>;
}

interface SpotifyTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
}

interface SpotifyImage {
	url: string;
}

interface SpotifyNamedUri {
	name: string;
	uri: string;
	type: string;
	images?: SpotifyImage[];
	album?: { images?: SpotifyImage[] };
	artists?: Array<{ name: string }>;
	owner?: { display_name?: string; id?: string };
	publisher?: string;
	show?: { name?: string; images?: SpotifyImage[] };
	audiobook?: { name?: string; images?: SpotifyImage[] };
}

type SpotifySearchResponse = Partial<Record<`${SpotifyItemType}s`, { items?: Array<SpotifyNamedUri | null> }>>;

interface SpotifyDevicesResponse {
	devices?: Array<{ id?: string | null; is_active?: boolean; name?: string; type?: string }>;
}

interface SpotifyPlaybackResponse {
	is_playing?: boolean;
	item?: SpotifyNamedUri | null;
}

class SpotifyApiError extends Error {
	readonly status: number;
	readonly reason: string | undefined;

	constructor(status: number, message: string, reason: string | undefined) {
		super(message);
		this.status = status;
		this.reason = reason;
	}
}

function nowPlayingFromItem(item: SpotifyNamedUri, isPlaying?: boolean): SpotifyNowPlaying {
	const subtitle =
		item.artists && item.artists.length > 0
			? item.artists.map((artist) => artist.name).join(", ")
			: (item.owner?.display_name ?? item.owner?.id ?? item.publisher ?? item.show?.name ?? item.audiobook?.name);
	return {
		title: item.name,
		subtitle,
		uri: item.uri,
		coverUrl:
			item.images?.[0]?.url ??
			item.album?.images?.[0]?.url ??
			item.show?.images?.[0]?.url ??
			item.audiobook?.images?.[0]?.url,
		isPlaying,
	};
}

function success(action: Exclude<SpotifyAction, "search">, playback?: SpotifyNowPlaying): SpotifyRpcResponse {
	return { ok: true, action, ...playback };
}

export function createSpotifyService(deps: {
	fileForUser: (user: string) => string;
	defaultClientId: string | undefined;
	logger: Logger;
}): SpotifyService {
	const logger = deps.logger.tag("spotify");
	const states = new Map<string, StoredSpotify>();
	const devices = new Map<string, SpotifyDeviceInfo[]>();
	const refreshes = new Map<string, Promise<string>>();

	async function load(user: string): Promise<StoredSpotify> {
		const cached = states.get(user);
		if (cached) return cached;
		let state: StoredSpotify = {};
		try {
			state = JSON.parse(await readFile(deps.fileForUser(user), "utf8")) as StoredSpotify;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		states.set(user, state);
		return state;
	}

	async function save(user: string, state: StoredSpotify): Promise<void> {
		states.set(user, state);
		const file = deps.fileForUser(user);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, "\t")}\n`, { mode: 0o600 });
		await rename(`${file}.tmp`, file);
	}

	function clientIdFor(state: StoredSpotify): string {
		return state.clientId ?? deps.defaultClientId ?? "";
	}

	async function requestToken(params: Record<string, string>): Promise<SpotifyTokenResponse> {
		const response = await fetch(`${accountsUrl}/api/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(params),
		});
		const data = (await response.json().catch(() => ({}))) as SpotifyTokenResponse;
		if (!response.ok || !data.access_token) {
			throw new Error(
				`Spotify authorization failed: ${data.error_description ?? data.error ?? `HTTP ${response.status}`}`,
			);
		}
		return data;
	}

	function withTokens(state: StoredSpotify, data: SpotifyTokenResponse, clientId: string): StoredSpotify {
		return {
			...state,
			tokenClientId: clientId,
			accessToken: data.access_token,
			refreshToken: data.refresh_token ?? state.refreshToken,
			expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000,
		};
	}

	async function accessToken(user: string): Promise<string> {
		const state = await load(user);
		if (state.accessToken && state.expiresAt && Date.now() < state.expiresAt) return state.accessToken;
		const refreshToken = state.refreshToken;
		if (!refreshToken)
			throw new Error("Spotify is not connected. Connect it in the Spotify panel on the setup page.");
		// Spotify rotates refresh tokens, so concurrent calls must share one refresh.
		let refresh = refreshes.get(user);
		if (!refresh) {
			refresh = (async () => {
				const clientId = state.tokenClientId ?? clientIdFor(state);
				const data = await requestToken({
					client_id: clientId,
					grant_type: "refresh_token",
					refresh_token: refreshToken,
				});
				await save(user, withTokens(await load(user), data, clientId));
				return data.access_token ?? "";
			})().finally(() => refreshes.delete(user));
			refreshes.set(user, refresh);
		}
		return await refresh;
	}

	async function api<T>(
		user: string,
		path: string,
		init: RequestInit = {},
		signal?: AbortSignal,
	): Promise<T | undefined> {
		const headers = new Headers(init.headers);
		headers.set("Authorization", `Bearer ${await accessToken(user)}`);
		headers.set("Content-Type", "application/json");
		const response = await fetch(`${apiUrl}${path}`, { ...init, headers, signal });
		if (response.status === 204) return undefined;
		const text = await response.text();
		let body: unknown;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			body = undefined;
		}
		if (!response.ok) {
			const error = (body as { error?: { message?: string; reason?: string } } | undefined)?.error;
			throw new SpotifyApiError(
				response.status,
				`Spotify API ${response.status}: ${error?.message ?? (text.slice(0, 200) || response.statusText)}`,
				error?.reason,
			);
		}
		return body as T | undefined;
	}

	async function loadDevices(user: string): Promise<SpotifyDeviceInfo[]> {
		const response = await api<SpotifyDevicesResponse>(user, "/me/player/devices");
		const list = (response?.devices ?? [])
			.filter((device) => Boolean(device.id))
			.map((device) => ({
				id: device.id ?? "",
				name: device.name ?? "Spotify device",
				type: device.type ?? "unknown",
				isActive: Boolean(device.is_active),
			}));
		devices.set(user, list);
		return list;
	}

	// Runs a player call on the selected device. A stale selection (e.g. a closed browser player) or no
	// active device falls back to the first device Spotify knows about for this account.
	async function onDevice(user: string, path: string, init: RequestInit, signal?: AbortSignal): Promise<void> {
		const run = (deviceId: string | undefined) =>
			api<void>(user, `${path}${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ""}`, init, signal);
		const selected = (await load(user)).selectedDeviceId;
		try {
			await run(selected);
			return;
		} catch (error) {
			if (!(error instanceof SpotifyApiError) || error.status !== 404) throw error;
		}
		if (selected) {
			logger.log(`[${user}] selected device ${selected} is gone; clearing it`);
			await save(user, { ...(await load(user)), selectedDeviceId: undefined });
		}
		const fallback = (await loadDevices(user)).find((device) => device.id !== selected);
		if (!fallback) throw new Error(noDeviceMessage);
		logger.log(`[${user}] playing on ${fallback.name} (${fallback.type})`);
		await run(fallback.id);
	}

	async function current(user: string, signal?: AbortSignal): Promise<SpotifyNowPlaying | undefined> {
		const response = await api<SpotifyPlaybackResponse>(
			user,
			"/me/player/currently-playing?market=from_token",
			{},
			signal,
		);
		return response?.item ? nowPlayingFromItem(response.item, Boolean(response.is_playing)) : undefined;
	}

	async function handle(user: string, payload: SpotifyRpcRequest, signal?: AbortSignal): Promise<SpotifyRpcResponse> {
		try {
			if (payload.action === "search") {
				const query = payload.query.trim();
				if (!query) throw new Error("Spotify query is required for search");
				const itemType = payload.itemType ?? "track";
				// Spotify caps search at 10 results since its February 2026 API change.
				const limit = String(Math.max(1, Math.min(10, Math.floor(payload.limit ?? 5))));
				const params = new URLSearchParams({ q: query, type: itemType, limit, market: "from_token" });
				const response = await api<SpotifySearchResponse>(user, `/search?${params.toString()}`, {}, signal);
				const results: SpotifySearchResult[] = (response?.[`${itemType}s`]?.items ?? [])
					.filter((item): item is SpotifyNamedUri => Boolean(item))
					.map((item) => ({ ...nowPlayingFromItem(item), type: itemType, uri: item.uri }));
				return { ok: true, action: "search", results };
			}
			if (payload.action === "play") {
				const uri = payload.uri.trim();
				if (!uri.startsWith("spotify:"))
					throw new Error("Spotify play requires a spotify: URI from spotify_search");
				const body =
					uri.startsWith("spotify:track:") || uri.startsWith("spotify:episode:")
						? { uris: [uri] }
						: { context_uri: uri };
				await onDevice(user, "/me/player/play", { method: "PUT", body: JSON.stringify(body) }, signal);
				logger.log(`[${user}] play ${uri}`);
				return success("play", (await current(user, signal)) ?? { uri, isPlaying: true });
			}
			if (payload.action === "pause") await onDevice(user, "/me/player/pause", { method: "PUT" }, signal);
			if (payload.action === "resume")
				await onDevice(user, "/me/player/play", { method: "PUT", body: "{}" }, signal);
			if (payload.action === "next") await onDevice(user, "/me/player/next", { method: "POST" }, signal);
			return success(payload.action, await current(user, signal));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.log(`[${user}] ${payload.action} failed: ${message}`);
			return { ok: false, error: message };
		}
	}

	return {
		status: async (user) => {
			const state = await load(user);
			return {
				clientId: clientIdFor(state),
				connected: Boolean(state.refreshToken),
				displayName: state.displayName,
				devices: devices.get(user) ?? [],
				selectedDeviceId: state.selectedDeviceId,
			};
		},
		setClientId: async (user, clientId) => {
			await save(user, { ...(await load(user)), clientId: clientId.trim() || undefined });
		},
		beginLogin: async (user, redirectUri) => {
			const state = await load(user);
			const clientId = clientIdFor(state);
			if (!clientId) throw new Error("Set a Spotify client ID first.");
			const verifier = randomBytes(64).toString("base64url");
			const oauthState = randomBytes(24).toString("base64url");
			await save(user, {
				...state,
				pendingLogin: { state: oauthState, verifier, redirectUri, clientId, createdAt: Date.now() },
			});
			const params = new URLSearchParams({
				client_id: clientId,
				response_type: "code",
				redirect_uri: redirectUri,
				scope: spotifyScopes,
				code_challenge_method: "S256",
				code_challenge: createHash("sha256").update(verifier).digest("base64url"),
				state: oauthState,
			});
			return `${accountsUrl}/authorize?${params.toString()}`;
		},
		completeLogin: async (user, callback) => {
			const { pendingLogin, ...state } = await load(user);
			if (!pendingLogin || pendingLogin.state !== callback.state) {
				throw new Error("This Spotify login was not started from this pibot account. Press Connect Spotify again.");
			}
			await save(user, state);
			if (Date.now() - pendingLogin.createdAt > loginTimeoutMs) {
				throw new Error("The Spotify login took too long. Press Connect Spotify again.");
			}
			if (callback.error || !callback.code) {
				throw new Error(`Spotify authorization failed: ${callback.error ?? "no code returned"}`);
			}
			const data = await requestToken({
				client_id: pendingLogin.clientId,
				grant_type: "authorization_code",
				code: callback.code,
				redirect_uri: pendingLogin.redirectUri,
				code_verifier: pendingLogin.verifier,
			});
			await save(user, withTokens(state, data, pendingLogin.clientId));
			const profile = await api<{ display_name?: string; id?: string }>(user, "/me");
			await save(user, { ...(await load(user)), displayName: profile?.display_name ?? profile?.id });
			logger.log(`[${user}] connected as ${profile?.display_name ?? profile?.id ?? "unknown"}`);
		},
		disconnect: async (user) => {
			await save(user, { clientId: (await load(user)).clientId });
			devices.delete(user);
			logger.log(`[${user}] disconnected`);
		},
		loadDevices,
		selectDevice: async (user, deviceId) => {
			await save(user, { ...(await load(user)), selectedDeviceId: deviceId || undefined });
		},
		useBrowserPlayer: async (user, deviceId) => {
			await save(user, { ...(await load(user)), selectedDeviceId: deviceId });
			await api<void>(user, "/me/player", {
				method: "PUT",
				body: JSON.stringify({ device_ids: [deviceId], play: false }),
			});
			await loadDevices(user);
		},
		accessToken,
		handle,
	};
}
