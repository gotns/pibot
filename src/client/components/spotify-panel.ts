import type { SpotifyDeviceInfo } from "../../types.js";

export interface SpotifyPanelStatus {
	clientId: string;
	redirectUri: string;
	connected: boolean;
	displayName?: string;
	devices: SpotifyDeviceInfo[];
	selectedDeviceId?: string;
	browserPlayerReady: boolean;
}

export class SpotifyPanelElement extends HTMLElement {
	private currentStatus: SpotifyPanelStatus = {
		clientId: "",
		redirectUri: "",
		connected: false,
		devices: [],
		browserPlayerReady: false,
	};

	connectedCallback(): void {
		this.render();
	}

	set status(status: SpotifyPanelStatus) {
		this.currentStatus = status;
		this.render();
	}

	private render(): void {
		const status = this.currentStatus;
		this.className = "spotify-panel";
		const title = document.createElement("h2");
		title.textContent = "Spotify";

		const help = document.createElement("p");
		help.textContent =
			"Add this redirect URI in your Spotify app, paste the client ID, then connect. The connection is saved on the server for your pibot account, so it works on every device you log in from.";

		const redirectLabel = document.createElement("label");
		redirectLabel.textContent = "Redirect URI";
		const redirectCode = document.createElement("code");
		redirectCode.textContent = status.redirectUri || `${window.location.origin}${window.location.pathname}`;
		redirectLabel.append(redirectCode);

		const clientIdInput = document.createElement("input");
		clientIdInput.placeholder = "Spotify client_id";
		clientIdInput.value = status.clientId;
		clientIdInput.autocomplete = "off";
		clientIdInput.spellcheck = false;
		clientIdInput.addEventListener("change", () => {
			this.dispatchEvent(new CustomEvent("spotify-client-id", { detail: { clientId: clientIdInput.value } }));
		});

		const statusLine = document.createElement("div");
		statusLine.className = status.connected ? "spotify-status connected" : "spotify-status";
		statusLine.textContent = status.connected
			? `Connected${status.displayName ? ` as ${status.displayName}` : ""}.`
			: "Not connected.";

		const controls = document.createElement("div");
		controls.className = "controls";

		const connect = document.createElement("button");
		connect.textContent = status.connected ? "Reconnect" : "Connect Spotify";
		connect.addEventListener("click", () => {
			this.dispatchEvent(new CustomEvent("spotify-client-id", { detail: { clientId: clientIdInput.value } }));
			this.dispatchEvent(new Event("spotify-connect"));
		});
		controls.append(connect);

		if (status.connected) {
			const browserPlayer = document.createElement("button");
			browserPlayer.textContent = status.browserPlayerReady ? "Browser player ready" : "Use this browser as speaker";
			browserPlayer.disabled = status.browserPlayerReady;
			browserPlayer.addEventListener("click", () => this.dispatchEvent(new Event("spotify-browser-player")));
			controls.append(browserPlayer);

			const refreshDevices = document.createElement("button");
			refreshDevices.textContent = "Refresh devices";
			refreshDevices.addEventListener("click", () => this.dispatchEvent(new Event("spotify-refresh-devices")));
			controls.append(refreshDevices);

			const disconnect = document.createElement("button");
			disconnect.textContent = "Disconnect";
			disconnect.addEventListener("click", () => this.dispatchEvent(new Event("spotify-disconnect")));
			controls.append(disconnect);
		}

		const close = document.createElement("button");
		close.textContent = "Close";
		close.addEventListener("click", () => this.dispatchEvent(new Event("spotify-close")));
		controls.append(close);

		const children: Node[] = [title, help, redirectLabel, clientIdInput, statusLine, controls];
		if (status.connected) children.push(this.createDevicePicker(status));
		this.replaceChildren(...children);
	}

	private createDevicePicker(status: SpotifyPanelStatus): HTMLElement {
		const wrap = document.createElement("label");
		wrap.textContent = "Playback device";
		const select = document.createElement("select");
		const defaultOption = document.createElement("option");
		defaultOption.value = "";
		defaultOption.textContent = "Active/default Spotify device";
		select.append(defaultOption);
		for (const device of status.devices) {
			const option = document.createElement("option");
			option.value = device.id;
			option.textContent = `${device.name} (${device.type}${device.isActive ? ", active" : ""})`;
			select.append(option);
		}
		select.value = status.selectedDeviceId ?? "";
		select.addEventListener("change", () => {
			this.dispatchEvent(new CustomEvent("spotify-device", { detail: { deviceId: select.value || undefined } }));
		});
		wrap.append(select);
		return wrap;
	}
}

customElements.define("spotify-panel", SpotifyPanelElement);
