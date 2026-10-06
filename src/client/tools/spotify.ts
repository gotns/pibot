import type { SpotifyDeviceInfo } from "../../types.js";
import type { ClientLogger } from "../logger.js";

// Spotify login and API calls live on the server (src/server/spotify.ts), per pibot account, so any
// device logged in to the account can use them. The browser only drives the setup panel and, on
// request, runs the Web Playback SDK as a speaker with access tokens fetched from the server.

interface SpotifySdkPayload {
	device_id?: string;
	message?: string;
}

interface SpotifyPlayer {
	connect(): Promise<boolean>;
	addListener(event: string, callback: (payload: SpotifySdkPayload) => void): void;
}

interface SpotifyPlayerConstructor {
	new (options: {
		name: string;
		getOAuthToken: (callback: (token: string) => void) => void;
		volume?: number;
	}): SpotifyPlayer;
}

declare global {
	interface Window {
		onSpotifyWebPlaybackSDKReady?: () => void;
		Spotify?: { Player: SpotifyPlayerConstructor };
	}
}

interface SpotifyServerStatus {
	clientId: string;
	connected: boolean;
	displayName?: string;
	devices: SpotifyDeviceInfo[];
	selectedDeviceId?: string;
}

export interface SpotifyStatus extends SpotifyServerStatus {
	redirectUri: string;
	browserPlayerReady: boolean;
}

export interface SpotifyTool {
	handleRedirectCallback: () => Promise<boolean>;
	refreshStatus: () => Promise<void>;
	getStatus: () => SpotifyStatus;
	setClientId: (clientId: string) => Promise<void>;
	login: () => Promise<void>;
	disconnect: () => Promise<void>;
	loadDevices: () => Promise<void>;
	selectDevice: (deviceId: string | undefined) => Promise<void>;
	startBrowserPlayer: () => Promise<void>;
}

function currentRedirectUri(): string {
	return `${window.location.origin}${window.location.pathname}`;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
	const response = await fetch(`/api/spotify/${path}`, {
		method,
		headers: body === undefined ? undefined : { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
	if (!response.ok) throw new Error(data.error ?? `Spotify request failed: HTTP ${response.status}`);
	return data;
}

export function createSpotifyTool(deps: { logger: ClientLogger; onStatusChange: () => void }): SpotifyTool {
	const logger = deps.logger.tag("spotify");
	let status: SpotifyServerStatus = { clientId: "", connected: false, devices: [] };
	let browserPlayerReady = false;
	let sdkReadyPromise: Promise<void> | undefined;
	let player: SpotifyPlayer | undefined;

	function setStatus(next: SpotifyServerStatus): void {
		status = next;
		deps.onStatusChange();
	}

	async function refreshStatus(): Promise<void> {
		setStatus((await call<{ status: SpotifyServerStatus }>("GET", "status")).status);
	}

	async function loadDevices(): Promise<void> {
		setStatus((await call<{ status: SpotifyServerStatus }>("GET", "devices")).status);
	}

	async function handleRedirectCallback(): Promise<boolean> {
		const params = new URLSearchParams(window.location.search);
		const state = params.get("state");
		if (!state || (!params.has("code") && !params.has("error"))) return false;
		window.history.replaceState({}, "", currentRedirectUri());
		await call("POST", "callback", {
			code: params.get("code") ?? undefined,
			state,
			error: params.get("error") ?? undefined,
		});
		await refreshStatus();
		logger.log(`connected${status.displayName ? ` as ${status.displayName}` : ""}`);
		return true;
	}

	function loadSdk(): Promise<void> {
		if (window.Spotify) return Promise.resolve();
		if (sdkReadyPromise) return sdkReadyPromise;
		sdkReadyPromise = new Promise((resolve) => {
			window.onSpotifyWebPlaybackSDKReady = () => resolve();
			const script = document.createElement("script");
			script.src = "https://sdk.scdn.co/spotify-player.js";
			document.body.append(script);
		});
		return sdkReadyPromise;
	}

	async function startBrowserPlayer(): Promise<void> {
		await loadSdk();
		if (!window.Spotify) throw new Error("Spotify Web Playback SDK did not load");
		if (player && browserPlayerReady) return;
		player = new window.Spotify.Player({
			name: "Pipi",
			getOAuthToken: (callback) => {
				void call<{ accessToken: string }>("GET", "token")
					.then((data) => callback(data.accessToken))
					.catch((error: unknown) => logger.log(`token request failed: ${String(error)}`));
			},
			volume: 0.45,
		});
		player.addListener("ready", (payload) => {
			if (!payload.device_id) return;
			browserPlayerReady = true;
			logger.log(`browser player ready device=${payload.device_id}`);
			void call("POST", "browser-player", { deviceId: payload.device_id })
				.then(loadDevices)
				.catch((error: unknown) => logger.log(`device transfer failed: ${String(error)}`));
		});
		player.addListener("not_ready", (payload) =>
			logger.log(`browser player not ready device=${payload.device_id ?? "unknown"}`),
		);
		player.addListener("initialization_error", (payload) =>
			logger.log(`SDK initialization error: ${payload.message ?? "unknown"}`),
		);
		player.addListener("authentication_error", (payload) =>
			logger.log(`SDK authentication error: ${payload.message ?? "unknown"}`),
		);
		player.addListener("account_error", (payload) =>
			logger.log(`SDK account error: ${payload.message ?? "unknown"}`),
		);
		const connected = await player.connect();
		if (!connected) throw new Error("Spotify browser player connection failed");
		deps.onStatusChange();
	}

	return {
		handleRedirectCallback,
		refreshStatus,
		getStatus: () => ({ ...status, redirectUri: currentRedirectUri(), browserPlayerReady }),
		setClientId: async (clientId) => {
			await call("POST", "client-id", { clientId });
			await refreshStatus();
		},
		login: async () => {
			window.location.href = (
				await call<{ url: string }>("POST", "login", { redirectUri: currentRedirectUri() })
			).url;
		},
		disconnect: async () => {
			await call("POST", "disconnect", {});
			browserPlayerReady = false;
			await refreshStatus();
			logger.log("disconnected");
		},
		loadDevices,
		selectDevice: async (deviceId) => {
			await call("POST", "device", { deviceId });
			await refreshStatus();
		},
		startBrowserPlayer,
	};
}
