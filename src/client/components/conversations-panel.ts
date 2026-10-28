interface ConversationSummary {
	id: string;
	startedAt: string;
	lastAt: string;
	turns: number;
	preview: string;
	current: boolean;
}

interface ConversationLine {
	role: "user" | "assistant" | "note";
	text: string;
}

async function api<T>(method: string, path: string): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: method === "POST" ? { "content-type": "application/json" } : undefined,
		body: method === "POST" ? "{}" : undefined,
	});
	const data = (await response.json().catch(() => ({}))) as { error?: string } & T;
	if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
	return data;
}

function when(iso: string): string {
	const date = new Date(iso);
	const today = new Date();
	const sameDay = date.toDateString() === today.toDateString();
	return sameDay
		? `Today ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
		: date.toLocaleString([], {
				weekday: "short",
				day: "numeric",
				month: "short",
				hour: "2-digit",
				minute: "2-digit",
			});
}

// Past conversations: start a new one, read an old one, or pick it up where it left off.
export class ConversationsPanelElement extends HTMLElement {
	private conversations: ConversationSummary[] = [];
	private openId: string | undefined;
	private lines: ConversationLine[] = [];

	async open(): Promise<void> {
		this.hidden = false;
		this.openId = undefined;
		await this.reload();
		this.scrollIntoView({ behavior: "smooth", block: "start" });
	}

	private async reload(): Promise<void> {
		try {
			this.conversations = (
				await api<{ conversations: ConversationSummary[] }>("GET", "/api/conversations")
			).conversations;
		} catch {
			this.conversations = [];
		}
		this.render();
	}

	private async show(id: string): Promise<void> {
		if (this.openId === id) {
			this.openId = undefined;
			this.render();
			return;
		}
		this.openId = id;
		this.lines = [];
		this.render();
		try {
			this.lines = (
				await api<{ lines: ConversationLine[] }>("GET", `/api/conversations/${encodeURIComponent(id)}`)
			).lines;
		} catch {
			this.lines = [{ role: "note", text: "Could not load this conversation." }];
		}
		this.render();
	}

	private async startNew(): Promise<void> {
		await api("POST", "/api/conversations/new");
		this.dispatchEvent(new Event("conversation-changed"));
		await this.reload();
	}

	private async continueWith(id: string): Promise<void> {
		await api("POST", `/api/conversations/${encodeURIComponent(id)}/continue`);
		this.dispatchEvent(new Event("conversation-changed"));
		await this.reload();
	}

	private render(): void {
		this.className = "panel conversations-panel";
		const head = document.createElement("div");
		head.className = "panel-head";
		const title = document.createElement("h2");
		title.textContent = "Conversations";
		const close = document.createElement("button");
		close.type = "button";
		close.className = "close";
		close.textContent = "Close";
		close.addEventListener("click", () => {
			this.hidden = true;
		});
		head.append(title, close);

		const start = document.createElement("button");
		start.type = "button";
		start.textContent = "Start a new conversation";
		start.addEventListener("click", () => void this.startNew());

		const list = document.createElement("ol");
		list.className = "conversation-list";
		for (const conversation of this.conversations) {
			const item = document.createElement("li");
			item.className = conversation.current ? "current" : "";
			const button = document.createElement("button");
			button.type = "button";
			button.className = "conversation-item";
			button.setAttribute("aria-expanded", String(this.openId === conversation.id));
			const heading = document.createElement("span");
			heading.className = "conversation-when";
			heading.textContent = `${when(conversation.lastAt)}${conversation.current ? " - current" : ""}`;
			const preview = document.createElement("span");
			preview.className = "conversation-preview";
			preview.textContent = conversation.preview || "(nothing said yet)";
			const meta = document.createElement("span");
			meta.className = "muted";
			meta.textContent = `${conversation.turns} ${conversation.turns === 1 ? "message" : "messages"}`;
			button.append(heading, preview, meta);
			button.addEventListener("click", () => void this.show(conversation.id));
			item.append(button);
			if (this.openId === conversation.id) item.append(this.transcript(conversation));
			list.append(item);
		}
		const empty = document.createElement("p");
		empty.className = "muted";
		empty.textContent = "No saved conversations yet.";
		this.replaceChildren(head, start, this.conversations.length ? list : empty);
	}

	private transcript(conversation: ConversationSummary): HTMLElement {
		const box = document.createElement("div");
		box.className = "transcript";
		for (const line of this.lines) {
			const row = document.createElement("p");
			row.className = `line ${line.role}`;
			row.textContent = line.role === "note" ? `(${line.text})` : line.text;
			box.append(row);
		}
		if (this.lines.length === 0) {
			const loading = document.createElement("p");
			loading.className = "muted";
			loading.textContent = "Loading...";
			box.append(loading);
		}
		if (!conversation.current) {
			const resume = document.createElement("button");
			resume.type = "button";
			resume.textContent = "Continue this conversation";
			resume.addEventListener("click", () => void this.continueWith(conversation.id));
			box.append(resume);
		}
		return box;
	}
}

customElements.define("pibot-conversations", ConversationsPanelElement);
