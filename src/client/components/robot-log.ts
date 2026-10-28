import type { LogOrigin } from "../../types.js";

const tagColors = ["#45d9ff", "#d783ff", "#ffd166", "#6ee7a8", "#7aa2ff", "#ff6b7a", "#9ca3af"];

function tagColor(tag: string): string {
	let hash = 0;
	for (let i = 0; i < tag.length; i++) hash = (hash * 31 + tag.charCodeAt(i)) | 0;
	return tagColors[Math.abs(hash) % tagColors.length]!;
}

const maxLines = 400;

export class RobotLogElement extends HTMLElement {
	private autoScroll = true;

	connectedCallback(): void {
		this.addEventListener("scroll", this.handleScroll);
	}

	disconnectedCallback(): void {
		this.removeEventListener("scroll", this.handleScroll);
	}

	private readonly handleScroll = (): void => {
		this.autoScroll = this.scrollTop + this.clientHeight >= this.scrollHeight - 4;
	};

	appendLine(origin: LogOrigin, tags: string[], message: string): void {
		const shouldScroll = this.autoScroll || this.scrollTop + this.clientHeight >= this.scrollHeight - 4;
		const line = document.createElement("div");
		const displayTags = [origin, ...tags.filter((tag, index) => index !== 0 || tag !== origin)];
		line.append(`${new Date().toLocaleTimeString()} `);
		for (const tag of displayTags) {
			const span = document.createElement("span");
			span.textContent = `[${tag}]`;
			span.style.color = tagColor(tag);
			line.append(span);
		}
		line.append(` ${message}`);
		line.className = displayTags.join(" ");
		this.append(line);
		// Every line is a DOM node; hours of use would otherwise slow a phone down.
		while (this.childElementCount > maxLines) this.firstElementChild?.remove();
		if (shouldScroll) this.scrollTop = this.scrollHeight;
	}
}

customElements.define("robot-log", RobotLogElement);
