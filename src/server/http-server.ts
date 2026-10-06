import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, relative, resolve } from "node:path";
import type { UserAuthService } from "./auth.js";
import type { RadioService } from "./radio.js";
import type { SpotifyService } from "./spotify.js";

export interface HttpServer {
	server: Server;
}

function contentTypeFor(file: string): string {
	const extension = extname(file);
	if (extension === ".js") return "text/javascript; charset=utf-8";
	if (extension === ".css") return "text/css; charset=utf-8";
	if (extension === ".mp3") return "audio/mpeg";
	if (extension === ".wav") return "audio/wav";
	if (extension === ".webm") return "audio/webm";
	return "text/html; charset=utf-8";
}

async function serveStaticFile(
	req: IncomingMessage,
	res: ServerResponse,
	publicDir: string,
	version: string,
	pathOverride?: string,
): Promise<void> {
	const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
	const path = pathOverride ?? (url.pathname === "/" ? "/index.html" : url.pathname);
	const publicRoot = resolve(publicDir);
	const file = resolve(publicRoot, `.${path}`);
	const relativePath = relative(publicRoot, file);
	if (relativePath.startsWith("..") || relativePath.startsWith("/") || relativePath === "") {
		res.writeHead(403).end();
		return;
	}
	try {
		const data = await readFile(file);
		const extension = extname(file);
		res.writeHead(200, {
			"content-type": contentTypeFor(file),
			"cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
			pragma: "no-cache",
			expires: "0",
		});
		if (extension === ".html") {
			res.end(
				data
					.toString("utf8")
					.replaceAll("style.css?v=dev", `style.css?v=${version}`)
					.replaceAll("app.js?v=dev", `app.js?v=${version}`),
			);
			return;
		}
		res.end(data);
	} catch {
		res.writeHead(404).end("not found");
	}
}

function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
	res.end(JSON.stringify(data));
}

function sendUnauthorizedAdmin(res: ServerResponse): void {
	res.writeHead(401, { "www-authenticate": 'Basic realm="Pipi admin"', "cache-control": "no-store" });
	res.end("admin credentials required");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.byteLength;
		if (total > 16 * 1024) throw new Error("Request body too large");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return undefined;
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function credentialsFromBody(body: unknown): { name: string; password: string } | undefined {
	if (!body || typeof body !== "object") return undefined;
	const record = body as Record<string, unknown>;
	if (typeof record.name !== "string" || typeof record.password !== "string") return undefined;
	return { name: record.name, password: record.password };
}

export function createHttpServer(deps: {
	publicDir: string;
	version: string;
	auth: UserAuthService;
	spotify: SpotifyService;
	radio: RadioService;
}): HttpServer {
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		try {
			if (url.pathname === "/__version" && req.method === "GET") {
				res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
				res.end(JSON.stringify({ version: deps.version }));
				return;
			}
			if (url.pathname === "/api/me" && req.method === "GET") {
				const user = await deps.auth.authenticateRequest(req);
				if (!user) {
					sendJson(res, 401, { ok: false, error: "not authenticated" });
					return;
				}
				sendJson(res, 200, { ok: true, user: { name: user.name } });
				return;
			}
			if (url.pathname === "/api/login" && req.method === "POST") {
				const credentials = credentialsFromBody(await readJson(req));
				if (!credentials) {
					sendJson(res, 400, { ok: false, error: "name and password are required" });
					return;
				}
				const user = await deps.auth.verifyUser(credentials.name, credentials.password);
				if (!user) {
					sendJson(res, 401, { ok: false, error: "invalid name or password" });
					return;
				}
				const token = await deps.auth.createSession(user.name);
				sendJson(
					res,
					200,
					{ ok: true, user: { name: user.name } },
					{ "set-cookie": deps.auth.sessionCookie(token) },
				);
				return;
			}
			// Relays plain-http radio streams that the https page may not load directly (mixed content).
			if (url.pathname.startsWith("/api/radio/stream/") && req.method === "GET") {
				if (!(await deps.auth.authenticateRequest(req))) {
					sendJson(res, 401, { ok: false, error: "not authenticated" });
					return;
				}
				await deps.radio.relay(decodeURIComponent(url.pathname.slice("/api/radio/stream/".length)), req, res);
				return;
			}
			if (url.pathname.startsWith("/api/spotify/")) {
				const user = await deps.auth.authenticateRequest(req);
				if (!user) {
					sendJson(res, 401, { ok: false, error: "not authenticated" });
					return;
				}
				const route = `${req.method} ${url.pathname.slice("/api/spotify/".length)}`;
				const body = (req.method === "POST" ? await readJson(req) : undefined) ?? {};
				const field = (name: string): string | undefined => {
					const value = (body as Record<string, unknown>)[name];
					return typeof value === "string" ? value : undefined;
				};
				const spotify = deps.spotify;
				if (route === "GET status") {
					sendJson(res, 200, { ok: true, status: await spotify.status(user.name) });
				} else if (route === "GET devices") {
					await spotify.loadDevices(user.name);
					sendJson(res, 200, { ok: true, status: await spotify.status(user.name) });
				} else if (route === "GET token") {
					sendJson(res, 200, { ok: true, accessToken: await spotify.accessToken(user.name) });
				} else if (route === "POST client-id") {
					await spotify.setClientId(user.name, field("clientId") ?? "");
					sendJson(res, 200, { ok: true });
				} else if (route === "POST login") {
					const redirectUri = field("redirectUri");
					if (!redirectUri?.startsWith("https://")) {
						sendJson(res, 400, { ok: false, error: "redirectUri must be an https URL" });
						return;
					}
					sendJson(res, 200, { ok: true, url: await spotify.beginLogin(user.name, redirectUri) });
				} else if (route === "POST callback") {
					await spotify.completeLogin(user.name, {
						code: field("code"),
						state: field("state"),
						error: field("error"),
					});
					sendJson(res, 200, { ok: true });
				} else if (route === "POST disconnect") {
					await spotify.disconnect(user.name);
					sendJson(res, 200, { ok: true });
				} else if (route === "POST device") {
					await spotify.selectDevice(user.name, field("deviceId"));
					sendJson(res, 200, { ok: true });
				} else if (route === "POST browser-player") {
					const deviceId = field("deviceId");
					if (!deviceId) {
						sendJson(res, 400, { ok: false, error: "deviceId is required" });
						return;
					}
					await spotify.useBrowserPlayer(user.name, deviceId);
					sendJson(res, 200, { ok: true });
				} else {
					sendJson(res, 404, { ok: false, error: "not found" });
				}
				return;
			}
			if (url.pathname === "/api/logout" && req.method === "POST") {
				await deps.auth.logout(req);
				sendJson(res, 200, { ok: true }, { "set-cookie": deps.auth.clearSessionCookie() });
				return;
			}
			if (url.pathname === "/api/admin/users") {
				if (!deps.auth.isAdminRequest(req)) {
					sendUnauthorizedAdmin(res);
					return;
				}
				if (req.method === "GET") {
					sendJson(res, 200, { ok: true, users: await deps.auth.listUsers() });
					return;
				}
				if (req.method === "POST") {
					const credentials = credentialsFromBody(await readJson(req));
					if (!credentials) {
						sendJson(res, 400, { ok: false, error: "name and password are required" });
						return;
					}
					const user = await deps.auth.addUser(credentials.name, credentials.password);
					sendJson(res, 200, { ok: true, user });
					return;
				}
			}
			if (url.pathname.startsWith("/api/admin/users/") && req.method === "DELETE") {
				if (!deps.auth.isAdminRequest(req)) {
					sendUnauthorizedAdmin(res);
					return;
				}
				const name = decodeURIComponent(url.pathname.slice("/api/admin/users/".length));
				if (!(await deps.auth.removeUser(name))) {
					sendJson(res, 404, { ok: false, error: "user not found" });
					return;
				}
				sendJson(res, 200, { ok: true });
				return;
			}
			if (
				(url.pathname === "/admin" || url.pathname === "/admin/" || url.pathname === "/admin.html") &&
				!deps.auth.isAdminRequest(req)
			) {
				sendUnauthorizedAdmin(res);
				return;
			}
			await serveStaticFile(
				req,
				res,
				deps.publicDir,
				deps.version,
				url.pathname === "/admin" || url.pathname === "/admin/" ? "/admin.html" : undefined,
			);
		} catch (error) {
			sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});
	return { server };
}
