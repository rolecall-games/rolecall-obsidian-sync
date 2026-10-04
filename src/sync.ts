import { App, Notice, requestUrl, RequestUrlResponse } from "obsidian";
import {
	CLIENT_NAME,
	RejectedPath,
	SYNC_VERSION,
	SyncPayload,
	SyncResponse,
	VAULT_IMPORTS_PATH,
	VersionMismatch,
} from "./api";
import {
	Collected,
	MissingFolderError,
	OverlappingFoldersError,
	VaultCollector,
} from "./collect";
import { planPush, SyncState } from "./plan";
import type { RoleCallSyncSettings } from "./settings";
import { parseJson, summarize, withHeldBack } from "./util";

/**
 * One push of a vault's notes to a RoleCall game: the published folder always,
 * the GM folder only when the GM has switched it on, and with each note the
 * images it embeds — wherever in the vault they live, the GM folder excepted.
 *
 * The engine owns the request; `VaultCollector` reads the vault; the plugin
 * owns the persisted state and hands it in; `plan.ts` owns every decision
 * that can be made without a vault. The privacy promises live in two places
 * and each has its own test: which folder a file is sent under and which
 * files are refused (`collect.ts`, by way of `plan.ts`), and what RoleCall
 * does with a `GM/…` path (the server — the plugin's word is never taken for
 * it).
 */
export class SyncEngine {
	constructor(
		private readonly app: App,
		private readonly settings: RoleCallSyncSettings,
		// The manifest's version, threaded in by the plugin — the wire
		// `client_version` must never be a hand-maintained copy (it drifted).
		private readonly clientVersion: string,
	) {}

	/**
	 * Runs one sync. Returns the state to persist, or null when nothing was
	 * written (no-op, or a failure the caller should not record as progress).
	 *
	 * `pulledHashes` is the pull's record of GM notes it brought down while
	 * the GM folder was not being pushed. It is read here only to say which
	 * version a changed note was edited from — see `planPush`.
	 */
	async push(lastSyncedHashes: SyncState, pulledHashes: SyncState = {}): Promise<SyncState | null> {
		const baseUrl = this.settings.apiBaseUrl.trim().replace(/\/+$/, "");
		const token = this.settings.apiToken.trim();

		if (!baseUrl || !token) {
			new Notice("Add your API token in the plugin settings first");
			return null;
		}

		new Notice(
			this.settings.syncGmFolder
				? "Syncing published and GM notes…"
				: "Syncing published notes…",
		);

		let collected: Collected;
		try {
			collected = await new VaultCollector(this.app, this.settings).collect(
				this.settings.syncGmFolder,
			);
		} catch (err) {
			if (err instanceof MissingFolderError) {
				new Notice(`Published folder not found: ${err.folderPath}`);
				return null;
			}
			if (err instanceof OverlappingFoldersError) {
				new Notice(
					"Your published folder and GM folder overlap, so nothing was sent — point them at two separate folders in the plugin settings",
				);
				return null;
			}
			console.error("RoleCall Sync: failed to read the vault's notes", err);
			new Notice("Couldn't read the notes to sync");
			return null;
		}

		if (collected.gm === "missing") {
			new Notice(
				`GM folder not found: ${collected.gmFolderPath} — syncing published notes only, and leaving the GM notes already on RoleCall as they are`,
			);
		}

		const plan = planPush(lastSyncedHashes, collected.snapshot, collected.gm, pulledHashes);

		if (plan.isNoop) {
			new Notice(withHeldBack("Already up to date", collected.shadowed));
			return null;
		}

		if (plan.gmRemovals > 0) {
			new Notice(
				`GM folder sync is off — removing ${plan.gmRemovals} GM ${plan.gmRemovals === 1 ? "file" : "files"} from RoleCall`,
			);
		}

		const payload: SyncPayload = {
			sync_version: SYNC_VERSION,
			client: CLIENT_NAME,
			client_version: this.clientVersion,
			roots: plan.roots,
			notes: plan.notes,
			attachments: plan.attachments,
			deleted_paths: plan.deletedPaths,
		};

		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url: `${baseUrl}${VAULT_IMPORTS_PATH}`,
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify(payload),
				throw: false,
			});
		} catch (err) {
			console.error("RoleCall Sync: request failed", err);
			new Notice(`Couldn't reach RoleCall: ${baseUrl}`);
			return null;
		}

		return this.handleResponse(response, plan.currentHashes, collected.shadowed);
	}

	private handleResponse(
		response: RequestUrlResponse,
		currentHashes: SyncState,
		shadowed: number,
	): SyncState | null {
		const status = response.status;

		if (status >= 200 && status < 300) {
			const body = parseJson<SyncResponse>(response);
			const rejected: RejectedPath[] = body?.results?.rejected ?? [];
			const rejectedPaths = new Set(rejected.map((r) => r.path));

			// Record everything currently present as synced, except anything the
			// server rejected (so it is retried next push).
			const next: SyncState = {};
			for (const path of Object.keys(currentHashes)) {
				const hash = currentHashes[path];
				if (hash !== undefined && !rejectedPaths.has(path)) next[path] = hash;
			}

			new Notice(summarize(body, rejected.length, shadowed));
			if (rejected.length > 0) {
				console.warn("RoleCall Sync: server rejected paths", rejected);
			}
			return next;
		}

		if (status === 401) {
			new Notice("Invalid or revoked token — check plugin settings");
			return null;
		}
		if (status === 409) {
			// Outside the server's accepted range — in one of two directions,
			// and only one of them is fixed by updating the plugin.
			const serverVersion = parseJson<VersionMismatch>(response)?.sync_version;
			if (typeof serverVersion === "number" && serverVersion < SYNC_VERSION) {
				new Notice(
					"This server doesn't support this plugin version yet — nothing was sent, so try again later",
				);
			} else {
				new Notice("This plugin version is out of date — please update it and sync again");
			}
			return null;
		}
		if (status === 413) {
			new Notice("Too much changed to sync at once — split it into smaller pushes");
			return null;
		}
		if (status === 400) {
			new Notice("The server rejected the request (bad payload)");
			return null;
		}
		new Notice(`Sync failed: HTTP ${status}`);
		return null;
	}
}
