import { Modal, Notice, requestUrl } from "obsidian";
import {
	CONNECT_PROTOCOL_VERSION,
	ConnectPoll,
	ConnectStart,
	PLUGIN_CONNECT_PATH,
} from "./api";
import type RoleCallSyncPlugin from "./main";

/**
 * Device-code activation (rolecall-meta/contracts/plugin-connect.md).
 *
 * Instead of generating a token on the website and pasting it into settings,
 * the plugin asks the server for a code pair, opens the browser on the
 * approval page — where the GM can sign in OR create an account and a
 * campaign named after this vault — and polls until the request resolves.
 * On approval the fresh `rc_` token is written into settings exactly as if
 * it had been pasted.
 *
 * Review-guideline constraints honoured here: everything is user-initiated
 * (no network on load), the DOM is built with `createEl` (no innerHTML), and
 * the sync that would actually upload vault content only runs from the
 * explicit "Push now" button — connecting alone transmits nothing from the
 * vault beyond its name as a naming hint.
 */

export function startConnectFlow(
	plugin: RoleCallSyncPlugin,
	opts: { onConnected?: () => void } = {},
): void {
	void (async () => {
		const baseUrl = plugin.settings.apiBaseUrl.trim().replace(/\/+$/, "");
		if (!baseUrl) {
			new Notice("Set the API base URL in the plugin settings first");
			return;
		}

		let start: ConnectStart;
		try {
			const res = await requestUrl({
				url: `${baseUrl}${PLUGIN_CONNECT_PATH}`,
				method: "POST",
				headers: { Accept: "application/json", "Content-Type": "application/json" },
				body: JSON.stringify({
					protocol_version: CONNECT_PROTOCOL_VERSION,
					plugin: "obsidian",
					client_version: plugin.manifest.version,
					name_hint: plugin.app.vault.getName().slice(0, 80) || undefined,
				}),
				throw: false,
			});

			if (res.status === 429) {
				new Notice("Too many connect attempts — wait a few minutes and retry");
				return;
			}
			if (res.status === 409) {
				new Notice("This plugin version is out of date — update RoleCall Sync");
				return;
			}
			if (res.status !== 201) {
				new Notice(`RoleCall returned HTTP ${res.status}`);
				return;
			}
			start = res.json as ConnectStart;
		} catch (err) {
			console.error("RoleCall Sync: connect failed", err);
			new Notice(`Couldn't reach RoleCall: ${baseUrl}`);
			return;
		}

		window.open(start.connect_url);
		new ConnectModal(plugin, baseUrl, start, opts.onConnected).open();
	})();
}

class ConnectModal extends Modal {
	private statusEl: HTMLElement | null = null;
	private intervalId: number | null = null;
	private deadline = 0;
	private pollBusy = false;
	private settled = false;

	constructor(
		private readonly plugin: RoleCallSyncPlugin,
		private readonly baseUrl: string,
		private readonly start: ConnectStart,
		private readonly onConnected?: () => void,
	) {
		super(plugin.app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Connect to RoleCall" });
		contentEl.createEl("p", {
			text: "Finish in the browser tab that just opened — sign in (or create a free account) and approve. If no tab opened, use the link below.",
		});
		// No plugin stylesheet ships (the sample styles.css was removed), so
		// the code stays plain semantic markup rather than a styled banner.
		contentEl.createEl("h3", { text: this.start.user_code });

		const linkP = contentEl.createEl("p");
		linkP.createEl("a", {
			text: this.start.connect_url,
			href: this.start.connect_url,
		});

		contentEl.createEl("p", {
			text: "If the code shown in the browser doesn't match the one above, stop.",
		});

		this.statusEl = contentEl.createEl("p", { text: "Waiting for approval…" });

		this.deadline = Date.now() + this.start.expires_in_seconds * 1000;

		const every = Math.max(2, this.start.poll_interval_seconds) * 1000;
		this.intervalId = window.setInterval(() => void this.poll(), every);
		// Tied to the plugin lifecycle too, so a disabled plugin never leaves
		// a timer running even if onClose was skipped somehow.
		this.plugin.registerInterval(this.intervalId);
	}

	onClose(): void {
		this.stopPolling();
		this.contentEl.empty();
	}

	private stopPolling(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	private async poll(): Promise<void> {
		if (this.pollBusy || this.settled) return;

		if (Date.now() > this.deadline) {
			this.finishWith("The connect request expired — close this and start again.");
			return;
		}

		this.pollBusy = true;
		try {
			const res = await requestUrl({
				url: `${this.baseUrl}${PLUGIN_CONNECT_PATH}/${encodeURIComponent(this.start.device_code)}`,
				method: "GET",
				headers: { Accept: "application/json" },
				throw: false,
			});

			if (res.status === 429) return; // slow_down — the next tick is later anyway
			if (res.status === 404) {
				this.finishWith("The connect request expired — close this and start again.");
				return;
			}
			if (res.status !== 200) return; // transient — the deadline bounds us

			const poll = res.json as ConnectPoll;

			switch (poll.status) {
				case "pending":
					return;

				case "approved": {
					this.plugin.settings.apiToken = poll.token;
					await this.plugin.saveSettings();
					this.settled = true;
					this.stopPolling();
					this.renderConnected(poll.game.name);
					return;
				}

				case "denied":
					this.finishWith("The request was denied on the website. No token was issued.");
					return;

				case "consumed":
					this.finishWith("That connect request was already used — start again.");
					return;

				case "expired":
					this.finishWith("The connect request expired — close this and start again.");
					return;
			}
		} catch (err) {
			console.error("RoleCall Sync: connect poll failed", err);
		} finally {
			this.pollBusy = false;
		}
	}

	private finishWith(message: string): void {
		this.settled = true;
		this.stopPolling();
		if (this.statusEl) this.statusEl.setText(message);
	}

	// Success swaps the modal body: pushing the vault is its own explicit
	// choice (Obsidian's policy: vault content never leaves without informed
	// consent — connecting alone uploads nothing).
	private renderConnected(gameName: string): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Connected" });
		contentEl.createEl("p", {
			text: `This vault is now linked to “${gameName}”. Push your ${this.plugin.settings.publishedFolder}/ folder to publish it there?`,
		});

		const row = contentEl.createDiv({ cls: "modal-button-container" });

		const pushBtn = row.createEl("button", { text: "Push now", cls: "mod-cta" });
		pushBtn.addEventListener("click", () => {
			this.close();
			this.onConnected?.();
		});

		const laterBtn = row.createEl("button", { text: "Later" });
		laterBtn.addEventListener("click", () => this.close());
	}
}
