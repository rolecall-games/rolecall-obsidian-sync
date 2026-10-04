import { Notice, Plugin } from "obsidian";
import { ConflictModal } from "./conflicts";
import { startConnectFlow } from "./connect";
import type { PullState, SyncState } from "./plan";
import { PullConflict, PullEngine } from "./pull";
import { DEFAULT_SETTINGS, RoleCallSettingTab, RoleCallSyncSettings } from "./settings";
import { SyncEngine } from "./sync";
import { targetFingerprint } from "./util";

/**
 * Plugin lifecycle only: register the commands and ribbon, load/save settings,
 * and own the persisted sync state. The push lives in `SyncEngine`, the pull
 * in `PullEngine`.
 */
export default class RoleCallSyncPlugin extends Plugin {
	settings: RoleCallSyncSettings = DEFAULT_SETTINGS;

	// Wire path -> content hash, from the last successful sync: published
	// files root-relative, GM-folder files under `GM/`. Lets us send only what
	// changed and emit explicit deletes.
	private lastSyncedHashes: SyncState = {};

	// GM notes a pull brought down while the GM folder was not being pushed.
	// Kept out of `lastSyncedHashes` on purpose — see `PullState`.
	private lastPulledHashes: SyncState = {};

	// Which server/game/folder `lastSyncedHashes` was built against. See
	// `targetFingerprint`; a mismatch invalidates the whole state.
	private syncedTarget: string | null = null;

	// One push OR pull at a time. Both the command and the ribbon call
	// pushNotes, and two overlapping runs each write the state on completion —
	// the slower response can overwrite newer state with an older hash set,
	// marking a changed note as synced forever. A pull writes the same state.
	private syncing = false;

	async onload() {
		await this.loadSettings();

		// The id predates the GM folder switch and stays as it is: Obsidian
		// keys a user's hotkey to it, so renaming it would silently unbind
		// every one. The label is what changed — a push may now carry both
		// folders, and a label that says "published" would be wrong about the
		// one thing a GM most needs it to be right about.
		this.addCommand({
			id: "push-published",
			name: "Push notes to RoleCall",
			callback: () => {
				void this.pushNotes();
			},
		});

		this.addRibbonIcon("upload-cloud", "Push notes to RoleCall", () => {
			void this.pushNotes();
		});

		this.addCommand({
			id: "pull-notes",
			name: "Pull notes from RoleCall",
			callback: () => {
				void this.pullNotes();
			},
		});

		this.addSettingTab(new RoleCallSettingTab(this.app, this));
	}

	async pushNotes(): Promise<void> {
		if (this.syncing) {
			new Notice("A sync is already running");
			return;
		}

		// First run: no token yet. Offer the connect flow instead of a
		// dead-end "paste a token" notice; its success screen offers the push
		// this click was asking for.
		if (!this.settings.apiToken.trim()) {
			startConnectFlow(this, { onConnected: () => void this.pushNotes() });
			return;
		}

		this.syncing = true;

		try {
			const fingerprint = await targetFingerprint(this.settings);

			// Repointed at a different game, server or folder: the incremental
			// state describes somewhere else. Drop it and send everything —
			// which also, correctly, emits no deletes, since deletes computed
			// against the old target would be meaningless against the new one.
			if (this.forgetIfRetargeted(fingerprint)) {
				new Notice("Sync target changed — pushing everything");
			}

			const engine = new SyncEngine(this.app, this.settings, this.manifest.version);
			const next = await engine.push(this.lastSyncedHashes, this.lastPulledHashes);

			if (next) {
				// What this push told RoleCall to remove is no longer something
				// the pull should remember agreeing on — or it would report every
				// one of those files, on every pull, as "removed on RoleCall".
				for (const path of Object.keys(this.lastSyncedHashes)) {
					if (!(path in next)) delete this.lastPulledHashes[path];
				}

				this.lastSyncedHashes = next;
				this.syncedTarget = fingerprint;
				await this.persist();
			}
		} finally {
			this.syncing = false;
		}
	}

	/**
	 * Bring down what was written or changed on RoleCall. Adds and updates
	 * only; anything changed on both sides is offered as a choice afterwards.
	 */
	async pullNotes(): Promise<void> {
		if (this.syncing) {
			new Notice("A sync is already running");
			return;
		}

		if (!this.settings.apiToken.trim()) {
			startConnectFlow(this, { onConnected: () => void this.pullNotes() });
			return;
		}

		this.syncing = true;
		let conflicts: PullConflict[] = [];

		try {
			const fingerprint = await targetFingerprint(this.settings);

			// A different game or folder: nothing we remember describes it, so
			// every file that differs is a conflict to choose, never an
			// overwrite decided from another campaign's history.
			if (this.forgetIfRetargeted(fingerprint)) {
				new Notice("Sync target changed — comparing everything");
			}

			const outcome = await new PullEngine(this.app, this.settings).pull(this.pullState());

			if (outcome) {
				this.adopt(outcome.state);
				this.syncedTarget = fingerprint;
				await this.persist();
				conflicts = outcome.conflicts;
			}
		} finally {
			this.syncing = false;
		}

		if (conflicts.length > 0) this.offerConflicts(conflicts);
	}

	// Each choice is applied and saved as it is made, so closing the dialog
	// half-way keeps what was chosen and re-offers the rest next pull.
	private offerConflicts(conflicts: PullConflict[]): void {
		const engine = new PullEngine(this.app, this.settings);

		new ConflictModal(this.app, conflicts, {
			useRemote: async (conflict) => {
				const next = await engine.takeRemote(conflict, this.pullState());
				if (!next) return false;
				this.adopt(next);
				await this.persist();
				return true;
			},
			keepMine: async (conflict) => {
				this.adopt(engine.keepMine(conflict, this.pullState()));
				await this.persist();
			},
		}).open();
	}

	private pullState(): PullState {
		return { synced: this.lastSyncedHashes, pulled: this.lastPulledHashes };
	}

	private adopt(state: PullState): void {
		this.lastSyncedHashes = state.synced;
		this.lastPulledHashes = state.pulled;
	}

	// True when the state was built against a different target and has just
	// been dropped.
	private forgetIfRetargeted(fingerprint: string): boolean {
		if (this.syncedTarget === null || this.syncedTarget === fingerprint) return false;
		this.lastSyncedHashes = {};
		this.lastPulledHashes = {};
		return true;
	}

	async loadSettings() {
		const stored = (await this.loadData()) as
			| (Partial<RoleCallSyncSettings> & {
					lastSyncedHashes?: SyncState;
					lastPulledHashes?: SyncState;
					syncedTarget?: string;
			  })
			| null;
		this.settings = {
			apiBaseUrl: stored?.apiBaseUrl ?? DEFAULT_SETTINGS.apiBaseUrl,
			apiToken: stored?.apiToken ?? DEFAULT_SETTINGS.apiToken,
			publishedFolder: stored?.publishedFolder ?? DEFAULT_SETTINGS.publishedFolder,
			// Strictly `true`: this is the switch that sends GM notes, and
			// nothing but the GM flipping it may read as on.
			syncGmFolder: stored?.syncGmFolder === true,
			gmFolder: stored?.gmFolder ?? DEFAULT_SETTINGS.gmFolder,
		};
		this.lastSyncedHashes = stored?.lastSyncedHashes ?? {};
		this.lastPulledHashes = stored?.lastPulledHashes ?? {};
		// null (not undefined) when upgrading from a build that never wrote one:
		// there is no target to compare against, so the first push is trusted
		// rather than forced into a needless full re-send.
		this.syncedTarget = stored?.syncedTarget ?? null;
	}

	async saveSettings() {
		await this.persist();
	}

	async resetSyncState() {
		this.lastSyncedHashes = {};
		this.lastPulledHashes = {};
		this.syncedTarget = null;
		await this.persist();
	}

	private async persist() {
		await this.saveData({
			...this.settings,
			lastSyncedHashes: this.lastSyncedHashes,
			lastPulledHashes: this.lastPulledHashes,
			syncedTarget: this.syncedTarget,
		});
	}
}
