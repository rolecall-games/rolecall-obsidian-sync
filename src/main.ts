import { Notice, Plugin } from "obsidian";
import { startConnectFlow } from "./connect";
import type { SyncState } from "./plan";
import { DEFAULT_SETTINGS, RoleCallSettingTab, RoleCallSyncSettings } from "./settings";
import { SyncEngine } from "./sync";
import { targetFingerprint } from "./util";

/**
 * Plugin lifecycle only: register the command and ribbon, load/save settings,
 * and own the persisted sync state. The push itself lives in `SyncEngine`.
 */
export default class RoleCallSyncPlugin extends Plugin {
	settings: RoleCallSyncSettings = DEFAULT_SETTINGS;

	// Wire path -> content hash, from the last successful sync: published
	// files root-relative, GM-folder files under `GM/`. Lets us send only what
	// changed and emit explicit deletes.
	private lastSyncedHashes: SyncState = {};

	// Which server/game/folder `lastSyncedHashes` was built against. See
	// `targetFingerprint`; a mismatch invalidates the whole state.
	private syncedTarget: string | null = null;

	// One push at a time. Both the command and the ribbon call pushNotes,
	// and two overlapping runs each write the state on completion — the slower
	// response can overwrite newer state with an older hash set, marking a
	// changed note as synced forever.
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
			if (this.syncedTarget !== null && this.syncedTarget !== fingerprint) {
				this.lastSyncedHashes = {};
				new Notice("Sync target changed — pushing everything");
			}

			const engine = new SyncEngine(this.app, this.settings, this.manifest.version);
			const next = await engine.push(this.lastSyncedHashes);

			if (next) {
				this.lastSyncedHashes = next;
				this.syncedTarget = fingerprint;
				await this.persist();
			}
		} finally {
			this.syncing = false;
		}
	}

	async loadSettings() {
		const stored = (await this.loadData()) as
			| (Partial<RoleCallSyncSettings> & {
					lastSyncedHashes?: SyncState;
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
		this.syncedTarget = null;
		await this.persist();
	}

	private async persist() {
		await this.saveData({
			...this.settings,
			lastSyncedHashes: this.lastSyncedHashes,
			syncedTarget: this.syncedTarget,
		});
	}
}
