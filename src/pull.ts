import { App, Notice, requestUrl, RequestUrlResponse } from "obsidian";
import {
	ManifestAttachment,
	ManifestNote,
	NoteEntry,
	PULL_NOTES_CHUNK,
	PULL_SYNC_VERSION,
	VAULT_ATTACHMENT_PATH,
	VAULT_MANIFEST_PATH,
	VAULT_NOTES_PATH,
	VaultManifest,
	VaultNotesResponse,
} from "./api";
import {
	Collected,
	MissingFolderError,
	OverlappingFoldersError,
	VaultCollector,
} from "./collect";
import {
	forgetAgreed,
	goneFromRemote,
	localPathFor,
	planPull,
	PullState,
	recordAgreed,
	SyncState,
} from "./plan";
import type { RoleCallSyncSettings } from "./settings";
import { explainPullFailure, parseJson, sha256Hex, summarizePull } from "./util";

/** A file that changed both here and on RoleCall. The GM decides. */
export interface PullConflict {
	/** The path RoleCall stores it under. */
	path: string;
	/** Where it is in this vault. */
	localPath: string;
	kind: "note" | "attachment";
	/** RoleCall's version, as the manifest listed it. */
	remoteHash: string;
	/** RoleCall itself has a conflict parked on this file. */
	parked: boolean;
}

export interface PullOutcome {
	state: PullState;
	conflicts: PullConflict[];
}

interface Tally {
	added: number;
	updated: number;
	failed: number;
}

/**
 * One pull: bring down what was written or changed on RoleCall.
 *
 * A pull only ever ADDS files and UPDATES ones the vault has not touched
 * since the last sync. It never deletes or renames anything here, and it
 * never overwrites a file that changed on both sides — those come back as
 * conflicts for the GM to choose (`ConflictModal`).
 *
 * The comparison happens in the plugin. RoleCall sends a manifest of what it
 * holds; the vault's own file names and hashes are never sent up to be
 * compared — a pull covers the GM folder even when it is not being pushed,
 * and the names of unpushed GM notes are exactly what must stay here.
 */
export class PullEngine {
	constructor(
		private readonly app: App,
		private readonly settings: RoleCallSyncSettings,
	) {}

	/**
	 * Runs one pull. Returns the state to persist and the conflicts to offer,
	 * or null when the pull could not run at all.
	 */
	async pull(current: PullState): Promise<PullOutcome | null> {
		if (!this.baseUrl() || !this.token()) {
			new Notice("Add your API token in the plugin settings first");
			return null;
		}

		new Notice("Pulling notes from RoleCall…");

		// The GM folder is read here whatever the push switch says: the pull
		// has to know what it already holds. Nothing read is sent anywhere.
		let collected: Collected;
		try {
			collected = await new VaultCollector(this.app, this.settings).collect(true);
		} catch (err) {
			if (err instanceof MissingFolderError) {
				new Notice(`Published folder not found: ${err.folderPath}`);
				return null;
			}
			if (err instanceof OverlappingFoldersError) {
				new Notice(
					"Your published folder and GM folder overlap, so nothing was pulled — point them at two separate folders in the plugin settings",
				);
				return null;
			}
			console.error("RoleCall Sync: failed to read the vault's notes", err);
			new Notice("Couldn't read the vault's notes");
			return null;
		}

		const manifest = await this.fetchManifest();
		if (!manifest) return null;

		const state: PullState = {
			synced: { ...current.synced },
			pulled: { ...current.pulled },
		};

		const local: SyncState = {};
		for (const n of collected.snapshot.notes) local[n.path] = n.content_hash;
		for (const a of collected.snapshot.attachments) local[a.path] = a.content_hash;

		// A GM path with no GM folder to put it in is left where it is.
		const placeable = <T extends { path: string }>(entries: T[] | undefined): T[] =>
			(entries ?? []).filter((e) => this.localPath(e.path, collected) !== null);
		const notes = placeable<ManifestNote>(manifest.notes);
		const attachments = placeable<ManifestAttachment>(manifest.attachments);
		const unplaced =
			(manifest.notes?.length ?? 0) +
			(manifest.attachments?.length ?? 0) -
			notes.length -
			attachments.length;

		const notePlan = planPull(notes, local, state);
		const attachmentPlan = planPull(attachments, local, state);
		const tally: Tally = { added: 0, updated: 0, failed: 0 };

		for (const { path, hash, parked } of [...notePlan.same, ...attachmentPlan.same]) {
			if (parked) forgetAgreed(state, path);
			else recordAgreed(state, path, hash, this.settings.syncGmFolder);
		}

		await this.pullNotes([...notePlan.create, ...notePlan.update], collected, state, tally);

		const wanted = new Set([...attachmentPlan.create, ...attachmentPlan.update]);
		for (const attachment of attachments) {
			if (wanted.has(attachment.path)) {
				await this.pullAttachment(attachment.path, collected, state, tally);
			}
		}

		await this.ensureFolders(manifest.folders ?? [], collected);

		const remoteHashes = new Map(
			[...notes, ...attachments].map((e) => [e.path, e.content_hash]),
		);
		const parkedPaths = new Set(notes.filter((n) => n.conflict === true).map((n) => n.path));
		const conflict = (kind: PullConflict["kind"]) => (path: string): PullConflict => ({
			path,
			localPath: this.localPath(path, collected) ?? path,
			kind,
			remoteHash: remoteHashes.get(path) ?? "",
			parked: parkedPaths.has(path),
		});
		const conflicts = [
			...notePlan.conflicts.map(conflict("note")),
			...attachmentPlan.conflicts.map(conflict("attachment")),
		];

		const gone = goneFromRemote(remoteHashes.keys(), local, state);
		if (gone.length > 0) {
			console.debug("RoleCall Sync: in this vault but no longer on RoleCall", gone);
		}

		new Notice(summarizePull(tally, conflicts.length, gone.length, unplaced));
		return { state, conflicts };
	}

	/**
	 * "Use RoleCall's version": replace the vault's copy of a conflicted file.
	 * Returns the state to persist, or null if it could not be fetched.
	 */
	async takeRemote(conflict: PullConflict, current: PullState): Promise<PullState | null> {
		const state: PullState = { synced: { ...current.synced }, pulled: { ...current.pulled } };
		const tally: Tally = { added: 0, updated: 0, failed: 0 };
		const at = new Map([[conflict.path, conflict.localPath]]);

		if (conflict.kind === "note") {
			const fetched = await this.fetchNotes([conflict.path]);
			// Nothing came back: the note is gone from RoleCall since the pull.
			if (!fetched || fetched.length === 0) return null;
			await this.writeNotes(fetched, at, state, tally);
		} else {
			await this.writeAttachment(conflict.path, conflict.localPath, state, tally);
		}

		if (tally.failed > 0) return null;

		// The vault now holds RoleCall's version, but RoleCall still has the
		// conflict standing. The next push shows it these bytes and settles it.
		if (conflict.parked) forgetAgreed(state, conflict.path);
		return state;
	}

	/**
	 * "Keep mine": the vault's copy stands. Recording RoleCall's version as the
	 * one this copy was made from is what makes that stick — the next push
	 * sends it as a change on top of RoleCall's, and the next pull sees the
	 * vault as ahead rather than in conflict.
	 */
	keepMine(conflict: PullConflict, current: PullState): PullState {
		const state: PullState = { synced: { ...current.synced }, pulled: { ...current.pulled } };
		recordAgreed(state, conflict.path, conflict.remoteHash, this.settings.syncGmFolder);
		return state;
	}

	// ── Fetching ─────────────────────────────────────────────────────────────

	private async fetchManifest(): Promise<VaultManifest | null> {
		const response = await this.request(VAULT_MANIFEST_PATH);
		if (!response) return null;
		if (response.status !== 200) {
			new Notice(explainPullFailure(response));
			return null;
		}

		const manifest = parseJson<VaultManifest>(response);
		if (!manifest) {
			new Notice("RoleCall sent something this plugin couldn't read");
			return null;
		}
		if ((manifest.min_sync_version ?? PULL_SYNC_VERSION) > PULL_SYNC_VERSION) {
			new Notice("This plugin version is out of date — please update it and pull again");
			return null;
		}
		return manifest;
	}

	private async fetchNotes(paths: string[]): Promise<NoteEntry[] | null> {
		const response = await this.request(VAULT_NOTES_PATH, { paths });
		if (!response) return null;
		if (response.status !== 200) {
			new Notice(explainPullFailure(response));
			return null;
		}
		return parseJson<VaultNotesResponse>(response)?.notes ?? [];
	}

	private async request(path: string, body?: unknown): Promise<RequestUrlResponse | null> {
		try {
			return await requestUrl({
				url: `${this.baseUrl()}${path}`,
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${this.token()}`,
					Accept: "application/json",
					...(body === undefined ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				throw: false,
			});
		} catch (err) {
			console.error("RoleCall Sync: request failed", err);
			new Notice(`Couldn't reach RoleCall: ${this.baseUrl()}`);
			return null;
		}
	}

	// ── Writing ──────────────────────────────────────────────────────────────

	private async pullNotes(
		paths: string[],
		collected: Collected,
		state: PullState,
		tally: Tally,
	): Promise<void> {
		const at = new Map<string, string>();
		for (const path of paths) {
			const localPath = this.localPath(path, collected);
			if (localPath !== null) at.set(path, localPath);
		}

		for (let i = 0; i < paths.length; i += PULL_NOTES_CHUNK) {
			const chunk = paths.slice(i, i + PULL_NOTES_CHUNK);
			const fetched = await this.fetchNotes(chunk);
			if (!fetched) {
				tally.failed += chunk.length;
				return;
			}
			await this.writeNotes(fetched, at, state, tally);
		}
	}

	private async writeNotes(
		fetched: NoteEntry[],
		at: Map<string, string>,
		state: PullState,
		tally: Tally,
	): Promise<void> {
		for (const entry of fetched) {
			const localPath = at.get(entry.path);
			if (localPath === undefined || typeof entry.markdown !== "string") continue;

			try {
				// Hashed here, from the text actually written: this is what the
				// next push will compute for the file.
				const hash = await sha256Hex(new TextEncoder().encode(entry.markdown));
				const existing = this.app.vault.getFileByPath(localPath);

				if (!existing) {
					await this.ensureFolder(parentOf(localPath));
					await this.app.vault.create(localPath, entry.markdown);
					tally.added += 1;
				} else if ((await this.app.vault.read(existing)) !== entry.markdown) {
					await this.app.vault.process(existing, () => entry.markdown);
					tally.updated += 1;
				}

				recordAgreed(state, entry.path, hash, this.settings.syncGmFolder);
			} catch (err) {
				console.error(`RoleCall Sync: couldn't write ${localPath}`, err);
				tally.failed += 1;
			}
		}
	}

	private async pullAttachment(
		path: string,
		collected: Collected,
		state: PullState,
		tally: Tally,
	): Promise<void> {
		const localPath = this.localPath(path, collected);
		if (localPath !== null) await this.writeAttachment(path, localPath, state, tally);
	}

	private async writeAttachment(
		path: string,
		localPath: string,
		state: PullState,
		tally: Tally,
	): Promise<void> {
		const response = await this.request(
			`${VAULT_ATTACHMENT_PATH}?path=${encodeURIComponent(path)}`,
		);
		if (!response || response.status !== 200) {
			if (response) console.error(`RoleCall Sync: couldn't fetch ${path}: HTTP ${response.status}`);
			tally.failed += 1;
			return;
		}

		try {
			const bytes = response.arrayBuffer;
			const hash = await sha256Hex(new Uint8Array(bytes));
			const existing = this.app.vault.getFileByPath(localPath);

			if (existing) {
				await this.app.vault.modifyBinary(existing, bytes);
				tally.updated += 1;
			} else {
				await this.ensureFolder(parentOf(localPath));
				await this.app.vault.createBinary(localPath, bytes);
				tally.added += 1;
			}

			recordAgreed(state, path, hash, this.settings.syncGmFolder);
		} catch (err) {
			console.error(`RoleCall Sync: couldn't write ${localPath}`, err);
			tally.failed += 1;
		}
	}

	// Folders made on RoleCall that hold no notes yet, so the vault's tree
	// matches. A folder that cannot be made is not worth failing a pull over.
	private async ensureFolders(folders: string[], collected: Collected): Promise<void> {
		for (const folder of folders) {
			const localPath = this.localPath(folder, collected);
			if (localPath === null) continue;
			try {
				await this.ensureFolder(localPath);
			} catch (err) {
				console.error(`RoleCall Sync: couldn't create folder ${localPath}`, err);
			}
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		if (path === "" || this.app.vault.getFolderByPath(path)) return;

		const segments = path.split("/");
		for (let depth = 1; depth <= segments.length; depth += 1) {
			const ancestor = segments.slice(0, depth).join("/");
			if (!this.app.vault.getFolderByPath(ancestor)) {
				await this.app.vault.createFolder(ancestor);
			}
		}
	}

	// Where a wire path is in THIS vault: where the collector found it (an
	// image the vault keeps outside the synced folders stays where it is), or
	// else its place under the published or GM folder.
	private localPath(path: string, collected: Collected): string | null {
		return (
			collected.sources.get(path) ??
			localPathFor(path, collected.publishedPath, collected.gmPath)
		);
	}

	private baseUrl(): string {
		return this.settings.apiBaseUrl.trim().replace(/\/+$/, "");
	}

	private token(): string {
		return this.settings.apiToken.trim();
	}
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash < 0 ? "" : path.slice(0, slash);
}
