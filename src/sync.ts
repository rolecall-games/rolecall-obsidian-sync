import {
	App,
	normalizePath,
	Notice,
	requestUrl,
	RequestUrlResponse,
	TFile,
	TFolder,
} from "obsidian";
import {
	AttachmentEntry,
	CLIENT_NAME,
	CLIENT_VERSION,
	MEDIA_EXTENSIONS,
	NoteEntry,
	RejectedPath,
	SYNC_VERSION,
	SyncPayload,
	SyncResponse,
	VAULT_IMPORTS_PATH,
} from "./api";
import type { RoleCallSyncSettings } from "./settings";
import { parseJson, sha256Hex, summarize, toBase64 } from "./util";

/** Root-relative published path -> content hash, from the last successful sync. */
export type SyncState = Record<string, string>;

/**
 * The configured published folder does not exist in this vault.
 *
 * Distinct from "the folder is empty" on purpose. A typo, a rename, or a case
 * mismatch (macOS is case-insensitive; Obsidian's path comparison is not) used
 * to collect zero files and report "Already up to date" — a silent success that
 * leaves the campaign site empty and gives the GM nothing to go on.
 */
export class MissingFolderError extends Error {
	constructor(readonly folderPath: string) {
		super(`Published folder not found: ${folderPath}`);
		this.name = "MissingFolderError";
	}
}

/**
 * One push of the published folder to a Role Call game.
 *
 * The engine owns collection, diffing and the request; the plugin owns the
 * persisted state and hands it in. Keeping the two apart is what makes the
 * collector testable without an Obsidian runtime — the privacy promise
 * ("only the published folder ever leaves the machine") lives in
 * `collectPublished` and deserves a test that does not need a real vault.
 */
export class SyncEngine {
	constructor(
		private readonly app: App,
		private readonly settings: RoleCallSyncSettings,
	) {}

	/**
	 * Runs one sync. Returns the state to persist, or null when nothing was
	 * written (no-op, or a failure the caller should not record as progress).
	 */
	async push(lastSyncedHashes: SyncState): Promise<SyncState | null> {
		const baseUrl = this.settings.apiBaseUrl.trim().replace(/\/+$/, "");
		const token = this.settings.apiToken.trim();

		if (!baseUrl || !token) {
			new Notice("Add your API token in the plugin settings first");
			return null;
		}

		new Notice("Syncing published notes…");

		let snapshot: { notes: NoteEntry[]; attachments: AttachmentEntry[] };
		try {
			snapshot = await this.collectPublished();
		} catch (err) {
			if (err instanceof MissingFolderError) {
				new Notice(`Published folder not found: ${err.folderPath}`);
				return null;
			}
			console.error("Role Call Sync: failed to read published notes", err);
			new Notice("Couldn't read the published notes folder");
			return null;
		}

		// Current full state by path → hash (notes + attachments share the namespace).
		const currentHashes: SyncState = {};
		for (const n of snapshot.notes) currentHashes[n.path] = n.content_hash;
		for (const a of snapshot.attachments) currentHashes[a.path] = a.content_hash;

		// Only send what changed; delete what disappeared.
		const changedNotes = snapshot.notes.filter((n) => lastSyncedHashes[n.path] !== n.content_hash);
		const changedAttachments = snapshot.attachments.filter(
			(a) => lastSyncedHashes[a.path] !== a.content_hash,
		);
		const deletedPaths = Object.keys(lastSyncedHashes).filter((p) => !(p in currentHashes));

		if (changedNotes.length === 0 && changedAttachments.length === 0 && deletedPaths.length === 0) {
			new Notice("Already up to date");
			return null;
		}

		const payload: SyncPayload = {
			sync_version: SYNC_VERSION,
			client: CLIENT_NAME,
			client_version: CLIENT_VERSION,
			notes: changedNotes,
			attachments: changedAttachments,
			deleted_paths: deletedPaths,
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
			console.error("Role Call Sync: request failed", err);
			new Notice(`Couldn't reach Role Call: ${baseUrl}`);
			return null;
		}

		return this.handleResponse(response, currentHashes);
	}

	private handleResponse(
		response: RequestUrlResponse,
		currentHashes: SyncState,
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

			new Notice(summarize(body, rejected.length));
			if (rejected.length > 0) {
				console.warn("Role Call Sync: server rejected paths", rejected);
			}
			return next;
		}

		if (status === 401) {
			new Notice("Invalid or revoked token — check plugin settings");
			return null;
		}
		if (status === 409) {
			new Notice("This plugin version is out of date — please update it and sync again");
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

	// Gather markdown notes and media attachments under the published folder,
	// keyed by their path RELATIVE to that folder (the server re-validates anyway).
	//
	// Walks the resolved folder rather than filtering every file in the vault by
	// a string prefix: `getFolderByPath` is the API Obsidian's guidelines point
	// at, and it makes a missing folder an error instead of an empty match. The
	// prefix approach also silently included a sibling like `PublishedDrafts/`
	// under a `Published` setting, which is the one mistake this plugin must
	// never make.
	private async collectPublished(): Promise<{
		notes: NoteEntry[];
		attachments: AttachmentEntry[];
	}> {
		const folderPath = normalizePath(this.settings.publishedFolder.trim());
		const root = this.app.vault.getFolderByPath(folderPath);
		if (!root) throw new MissingFolderError(folderPath);

		const notes: NoteEntry[] = [];
		const attachments: AttachmentEntry[] = [];
		const prefixLength = root.path.length + 1;

		for (const file of collectFiles(root)) {
			const rel = file.path.slice(prefixLength);
			const ext = file.extension.toLowerCase();

			if (ext === "md") {
				const markdown = await this.app.vault.read(file);
				notes.push({
					path: rel,
					markdown,
					content_hash: await sha256Hex(new TextEncoder().encode(markdown)),
				});
			} else if (MEDIA_EXTENSIONS.has(ext)) {
				const buf = new Uint8Array(await this.app.vault.readBinary(file));
				attachments.push({
					path: rel,
					content_base64: toBase64(buf),
					content_hash: await sha256Hex(buf),
				});
			}
			// Other file types under the published folder are intentionally not synced.
		}

		return { notes, attachments };
	}
}

/** Every file in `folder` and its descendants, depth-first. */
function collectFiles(folder: TFolder): TFile[] {
	const out: TFile[] = [];
	for (const child of folder.children) {
		if (child instanceof TFolder) out.push(...collectFiles(child));
		else if (child instanceof TFile) out.push(child);
	}
	return out;
}
