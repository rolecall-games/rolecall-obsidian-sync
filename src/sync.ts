import {
	App,
	getLinkpath,
	normalizePath,
	Notice,
	requestUrl,
	RequestUrlResponse,
	TFile,
	TFolder,
} from "obsidian";
import {
	CLIENT_NAME,
	MEDIA_EXTENSIONS,
	RejectedPath,
	SYNC_VERSION,
	SyncPayload,
	SyncResponse,
	SyncRoot,
	VAULT_IMPORTS_PATH,
	VersionMismatch,
} from "./api";
import {
	claimsGmRoot,
	foldersOverlap,
	GmFolderState,
	gmWirePath,
	isInsideFolder,
	isVaultRoot,
	LooseEmbed,
	placeLooseMedia,
	planPush,
	Snapshot,
	SyncState,
} from "./plan";
import type { RoleCallSyncSettings } from "./settings";
import { parseJson, sha256Hex, summarize, toBase64, withHeldBack } from "./util";

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
 * The published folder and the GM folder are the same folder, or one is inside
 * the other. Every file in the overlap would be read by both walks — and the
 * published walk sends what it finds to the players. There is no reading of
 * such a setup that is safe to guess at, so nothing is sent.
 */
export class OverlappingFoldersError extends Error {
	constructor(
		readonly publishedPath: string,
		readonly gmPath: string,
	) {
		super(`Published folder (${publishedPath}) and GM folder (${gmPath}) overlap`);
		this.name = "OverlappingFoldersError";
	}
}

interface Collected {
	snapshot: Snapshot;
	gm: GmFolderState;
	/** The GM folder as configured, for the "not found" notice. */
	gmFolderPath: string;
	/** Published files held back because they sit in a folder named GM. */
	shadowed: number;
}

/**
 * One push of a vault's notes to a RoleCall game: the published folder always,
 * the GM folder only when the GM has switched it on, and with each note the
 * images it embeds — wherever in the vault they live, the GM folder excepted.
 *
 * The engine owns collection and the request; the plugin owns the persisted
 * state and hands it in; `plan.ts` owns every decision that can be made
 * without a vault. The privacy promises live in two places and each has its
 * own test: which folder a file is sent under and which files are refused
 * (`collect` below, by way of `plan.ts`), and what RoleCall does with a
 * `GM/…` path (the server — the plugin's word is never taken for it).
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
	 */
	async push(lastSyncedHashes: SyncState): Promise<SyncState | null> {
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
			collected = await this.collect();
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

		const plan = planPush(lastSyncedHashes, collected.snapshot, collected.gm);

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

	// Gather markdown notes and media attachments from the published folder —
	// and, when the GM has switched it on, the GM folder — keyed by the path
	// RoleCall stores them under (the server re-validates every one anyway).
	// Then the media those notes embed from anywhere else in the vault.
	//
	// Walks the resolved folders rather than filtering every file in the vault
	// by a string prefix: `getFolderByPath` is the API Obsidian's guidelines
	// point at, and it makes a missing folder an error instead of an empty
	// match. The prefix approach also silently included a sibling like
	// `PublishedDrafts/` under a `Published` setting, which is the one mistake
	// this plugin must never make.
	private async collect(): Promise<Collected> {
		const publishedPath = normalizePath(this.settings.publishedFolder.trim());

		// An empty setting normalises to the vault root, and walking that would
		// send every note in the vault to the players.
		if (isVaultRoot(publishedPath)) throw new MissingFolderError("(not set)");

		const gmWanted = this.settings.syncGmFolder;
		const gmPath = gmWanted ? normalizePath(this.settings.gmFolder.trim()) : "";

		// Decided before a single file is read.
		if (gmWanted && !isVaultRoot(gmPath) && foldersOverlap(publishedPath, gmPath)) {
			throw new OverlappingFoldersError(publishedPath, gmPath);
		}

		const publishedRoot = this.app.vault.getFolderByPath(publishedPath);
		if (!publishedRoot) throw new MissingFolderError(publishedPath);

		const snapshot: Snapshot = { notes: [], attachments: [] };

		// Media a synced note embeds from OUTSIDE both folders. Never from the
		// GM folder, whether or not it is switched on: with it on the walk
		// below already sends the file (GM-only), and with it off nothing
		// under that folder leaves the vault — embedding a GM image in a
		// published note does not publish it. The folder is the boundary.
		const gmBoundary = normalizePath(this.settings.gmFolder.trim());
		const loose: LooseEmbed[] = [];
		const noteEmbeds = (embeddedBy: SyncRoot) => (note: TFile) => {
			for (const file of this.embeddedMedia(note)) {
				if (isInsideFolder(file.path, publishedPath)) continue;
				if (!isVaultRoot(gmBoundary) && isInsideFolder(file.path, gmBoundary)) continue;
				loose.push({ vaultPath: file.path, embeddedBy });
			}
		};

		// Published files go out root-relative — except any in a folder named
		// GM, whose root-relative path is spelled like a GM-root one.
		const shadowed = await this.read(
			publishedRoot,
			(rel) => (claimsGmRoot(rel) ? null : rel),
			snapshot,
			noteEmbeds("published"),
		);

		let gm: GmFolderState = "off";
		if (gmWanted) {
			// Unlike the published folder, a GM folder we cannot find is not
			// fatal: it cannot leave a campaign site blank. It is not "off"
			// either — see `GmFolderState`.
			const gmRoot = isVaultRoot(gmPath) ? null : this.app.vault.getFolderByPath(gmPath);
			if (gmRoot) {
				await this.read(gmRoot, gmWirePath, snapshot, noteEmbeds("gm"));
				gm = "synced";
			} else {
				gm = "missing";
			}
		}

		await this.readLooseMedia(loose, snapshot);

		return {
			snapshot,
			gm,
			gmFolderPath: isVaultRoot(gmPath) ? "(not set)" : gmPath,
			shadowed,
		};
	}

	// The media files `note` embeds, as Obsidian itself resolves them — the
	// same lookup that decides which image the GM sees in the note. Only
	// media: an embedded NOTE from outside the synced folders is not sent.
	private embeddedMedia(note: TFile): TFile[] {
		const embeds = this.app.metadataCache.getFileCache(note)?.embeds ?? [];
		const out: TFile[] = [];
		for (const embed of embeds) {
			const dest = this.app.metadataCache.getFirstLinkpathDest(
				getLinkpath(embed.link),
				note.path,
			);
			if (dest && MEDIA_EXTENSIONS.has(dest.extension.toLowerCase())) out.push(dest);
		}
		return out;
	}

	// Read the loose media the synced notes embed into `into`, at the paths
	// `placeLooseMedia` gives them.
	private async readLooseMedia(loose: LooseEmbed[], into: Snapshot): Promise<void> {
		if (loose.length === 0) return;

		const taken = [...into.notes, ...into.attachments].map((entry) => entry.path);
		const { placed, skipped } = placeLooseMedia(loose, taken);

		for (const { vaultPath, wirePath } of placed) {
			const file = this.app.vault.getFileByPath(vaultPath);
			if (!file) continue;
			const buf = new Uint8Array(await this.app.vault.readBinary(file));
			into.attachments.push({
				path: wirePath,
				content_base64: toBase64(buf),
				content_hash: await sha256Hex(buf),
			});
		}

		if (skipped.length > 0) {
			console.warn(
				"RoleCall Sync: embedded files not sent — another file with the same name is already being synced",
				skipped,
			);
		}
	}

	// Read every syncable file under `root` into `into`, at the wire path
	// `toWirePath` gives its root-relative path. A `null` wire path holds the
	// file back — it is not read — and the count of those is returned.
	// `onNote` sees each note that was read.
	private async read(
		root: TFolder,
		toWirePath: (rel: string) => string | null,
		into: Snapshot,
		onNote: (note: TFile) => void,
	): Promise<number> {
		const prefixLength = root.path.length + 1;
		let heldBack = 0;

		for (const file of collectFiles(root)) {
			const ext = file.extension.toLowerCase();
			const isNote = ext === "md";

			// Other file types under a synced folder are intentionally not synced.
			if (!isNote && !MEDIA_EXTENSIONS.has(ext)) continue;

			const path = toWirePath(file.path.slice(prefixLength));
			if (path === null) {
				heldBack += 1;
				continue;
			}

			if (isNote) {
				const markdown = await this.app.vault.read(file);
				into.notes.push({
					path,
					markdown,
					content_hash: await sha256Hex(new TextEncoder().encode(markdown)),
				});
				onNote(file);
			} else {
				const buf = new Uint8Array(await this.app.vault.readBinary(file));
				into.attachments.push({
					path,
					content_base64: toBase64(buf),
					content_hash: await sha256Hex(buf),
				});
			}
		}

		return heldBack;
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
