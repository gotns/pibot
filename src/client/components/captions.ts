import type { RobotState } from "../../types.js";

// Subtitles for the talk screen: what the robot heard (live while you speak), what it answers, and what it
// is doing right now. Readable from across a room, and the only place errors are spelled out.

const toolLabels: Record<string, string> = {
	web_search: "Searching the web",
	fetch_page_content: "Reading a web page",
	radio_search: "Looking for radio stations",
	radio_play: "Tuning the radio",
	radio_control: "Adjusting the radio",
	memory: "Remembering",
	take_photo: "Taking a photo",
	spotify_search: "Searching Spotify",
	spotify_play: "Starting Spotify",
	spotify_control: "Controlling Spotify",
	move_forward: "Driving",
	turn_left: "Turning",
	turn_left_degrees: "Turning",
	sleep: "Waiting",
};

// Long answers scroll by; the captions keep the end of the text.
const maxReplyChars = 260;

export class CaptionsElement extends HTMLElement {
	private heard = document.createElement("p");
	private reply = document.createElement("p");
	private status = document.createElement("p");

	connectedCallback(): void {
		this.classList.add("captions");
		this.setAttribute("aria-live", "polite");
		this.heard.className = "caption-heard";
		this.reply.className = "caption-reply";
		this.status.className = "caption-status";
		this.replaceChildren(this.heard, this.reply, this.status);
	}

	showInterim(text: string): void {
		this.heard.textContent = text;
		this.heard.classList.add("interim");
		this.reply.textContent = "";
	}

	showTyped(text: string): void {
		this.heard.textContent = text;
		this.heard.classList.remove("interim");
		this.reply.textContent = "";
		this.setStatus("Thinking");
	}

	showState(state: RobotState): void {
		if (state.phase === "hearing") {
			this.heard.classList.add("interim");
			if (!this.heard.textContent) this.heard.textContent = "...";
			this.reply.textContent = "";
			this.setStatus("");
			return;
		}
		if (state.phase === "thinking") {
			if (state.heardText) {
				this.heard.textContent = state.heardText;
				this.heard.classList.remove("interim");
			}
			this.showReply(state.assistantText);
			this.setStatus(state.assistantText ? "" : "Thinking");
			return;
		}
		if (state.phase === "tool") {
			this.showReply(state.assistantText);
			this.setStatus(toolLabels[state.name] ?? "Working");
			return;
		}
		if (state.phase === "speaking") {
			this.showReply(state.assistantText);
			this.setStatus("");
			return;
		}
		if (state.phase === "error") {
			this.setStatus(state.message, true);
			return;
		}
		if (state.phase === "listening") {
			// Keep the last exchange on screen; only drop a dangling "..." or status.
			if (this.heard.textContent === "...") this.heard.textContent = "";
			this.heard.classList.remove("interim");
			this.setStatus("");
		}
	}

	clear(): void {
		this.heard.textContent = "";
		this.reply.textContent = "";
		this.setStatus("");
	}

	private showReply(text: string): void {
		this.reply.textContent = text.length > maxReplyChars ? `...${text.slice(-maxReplyChars)}` : text;
	}

	private setStatus(text: string, isError = false): void {
		this.status.textContent = text && !isError ? `${text}...` : text;
		this.status.classList.toggle("error", isError);
	}
}

customElements.define("talk-captions", CaptionsElement);
