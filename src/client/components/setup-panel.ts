export type SetupPanelMode = "idle" | "starting" | "started";

// The home screen's buttons: talk, past conversations, settings, logout.
export class RobotSetupPanelElement extends HTMLElement {
	private startButton: HTMLButtonElement | undefined;
	private name = "Pipi";
	private currentMode: SetupPanelMode = "idle";

	connectedCallback(): void {
		if (!this.startButton) this.render();
	}

	set mode(mode: SetupPanelMode) {
		this.currentMode = mode;
		this.updateStart();
	}

	set robotName(name: string) {
		this.name = name;
		this.updateStart();
	}

	private updateStart(): void {
		if (!this.startButton) return;
		this.startButton.disabled = this.currentMode === "starting";
		this.startButton.textContent =
			this.currentMode === "starting"
				? "Starting..."
				: this.currentMode === "started"
					? `Back to ${this.name}`
					: `Talk to ${this.name}`;
	}

	private render(): void {
		this.classList.add("panel");
		this.startButton = document.createElement("button");
		this.startButton.className = "primary";
		this.startButton.addEventListener("click", () => this.dispatchEvent(new Event("start-robot")));
		this.updateStart();
		const controls = document.createElement("div");
		controls.className = "controls";
		const button = (label: string, event: string) => {
			const element = document.createElement("button");
			element.type = "button";
			element.textContent = label;
			element.addEventListener("click", () => this.dispatchEvent(new Event(event)));
			return element;
		};
		controls.append(
			button("Conversations", "open-conversations"),
			button("Settings", "open-settings"),
			button("Logout", "logout"),
		);
		this.replaceChildren(this.startButton, controls);
	}
}

customElements.define("robot-setup-panel", RobotSetupPanelElement);
