import { App, Modal } from "obsidian";
import type { PullConflict } from "./pull";

export interface ConflictHandlers {
	/** Replace the vault's copy with RoleCall's. Resolves false if it failed. */
	useRemote: (conflict: PullConflict) => Promise<boolean>;
	/** The vault's copy stands, and wins on the next push. */
	keepMine: (conflict: PullConflict) => Promise<void>;
}

/**
 * Shown after a pull that found files changed both here and on RoleCall.
 *
 * Nothing has been done to those files by the time this opens: the pull kept
 * every one of them as the vault had it. Each row is a choice the GM makes
 * here; a row left alone stays a conflict and is offered again next pull.
 */
export class ConflictModal extends Modal {
	constructor(
		app: App,
		private readonly conflicts: PullConflict[],
		private readonly handlers: ConflictHandlers,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Changed in both places" });
		contentEl.createEl("p", {
			text: "These changed in this vault and on RoleCall since the last sync. Your copies were left exactly as they are — choose which version to keep for each. Anything you leave alone is asked about again next time you pull.",
		});

		for (const conflict of this.conflicts) this.renderRow(contentEl, conflict);

		const footer = contentEl.createDiv({ cls: "modal-button-container" });
		footer.createEl("button", { text: "Done" }).addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private renderRow(parent: HTMLElement, conflict: PullConflict): void {
		const row = parent.createDiv({ cls: "setting-item" });

		const info = row.createDiv({ cls: "setting-item-info" });
		info.createDiv({ cls: "setting-item-name", text: conflict.localPath });
		const status = info.createDiv({ cls: "setting-item-description" });

		const controls = row.createDiv({ cls: "setting-item-control" });
		const keep = controls.createEl("button", { text: "Keep mine" });
		const take = controls.createEl("button", { text: "Use RoleCall's" });

		const settle = (message: string) => {
			status.setText(message);
			controls.empty();
		};

		keep.addEventListener("click", () => {
			keep.disabled = true;
			take.disabled = true;
			void this.handlers.keepMine(conflict).then(() => {
				settle("Kept yours — your next push sends it to RoleCall");
			});
		});

		take.addEventListener("click", () => {
			keep.disabled = true;
			take.disabled = true;
			status.setText("Fetching…");
			void this.handlers.useRemote(conflict).then((ok) => {
				if (ok) {
					settle("Replaced with RoleCall's version");
				} else {
					status.setText("Couldn't fetch RoleCall's version — try again");
					keep.disabled = false;
					take.disabled = false;
				}
			});
		});
	}
}
