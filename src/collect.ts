import { App, getLinkpath, normalizePath, TFile, TFolder } from "obsidian";
import { MEDIA_EXTENSIONS, SyncRoot } from "./api";
import {
	claimsGmRoot,
	foldersOverlap,
	GmFolderState,
	gmWirePath,
	isInsideFolder,
	isVaultRoot,
	LooseEmbed,
	placeLooseMedia,
	Snapshot,
} from "./plan";
import type { RoleCallSyncSettings } from "./settings";
import { sha256Hex, toBase64 } from "./util";

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

export interface Collected {
	snapshot: Snapshot;
	gm: GmFolderState;
	/** The GM folder as configured, for the "not found" notice. */
	gmFolderPath: string;
	/** Published files held back because they sit in a folder named GM. */
	shadowed: number;
	/** Wire path -> where that file actually is in the vault. */
	sources: Map<string, string>;
	/** The two synced folders, normalised. `gmPath` is "" when none is set. */
	publishedPath: string;
	gmPath: string;
}

/**
 * Reads the vault the way RoleCall sees it: every syncable file, keyed by the
 * path the server stores it under.
 *
 * Push and pull both go through here, so they cannot disagree about which
 * file is which path — and so the rules about what is never read (a folder
 * named GM inside the published folder, overlapping folders, an unset
 * published folder) hold for both.
 */
export class VaultCollector {
	constructor(
		private readonly app: App,
		private readonly settings: RoleCallSyncSettings,
	) {}

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
	//
	// `readGm` says whether the GM folder is read at all. A push passes the
	// GM's switch. A pull passes true: it has to compare the GM folder's files
	// against RoleCall's to know what to bring down, and it sends none of what
	// it reads there.
	async collect(readGm: boolean): Promise<Collected> {
		const publishedPath = normalizePath(this.settings.publishedFolder.trim());

		// An empty setting normalises to the vault root, and walking that would
		// send every note in the vault to the players.
		if (isVaultRoot(publishedPath)) throw new MissingFolderError("(not set)");

		const gmWanted = readGm;
		const gmPath = gmWanted ? normalizePath(this.settings.gmFolder.trim()) : "";

		// Decided before a single file is read.
		if (gmWanted && !isVaultRoot(gmPath) && foldersOverlap(publishedPath, gmPath)) {
			throw new OverlappingFoldersError(publishedPath, gmPath);
		}

		const publishedRoot = this.app.vault.getFolderByPath(publishedPath);
		if (!publishedRoot) throw new MissingFolderError(publishedPath);

		const snapshot: Snapshot = { notes: [], attachments: [] };
		const sources = new Map<string, string>();

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
			sources,
			noteEmbeds("published"),
		);

		let gm: GmFolderState = "off";
		if (gmWanted) {
			// Unlike the published folder, a GM folder we cannot find is not
			// fatal: it cannot leave a campaign site blank. It is not "off"
			// either — see `GmFolderState`.
			const gmRoot = isVaultRoot(gmPath) ? null : this.app.vault.getFolderByPath(gmPath);
			if (gmRoot) {
				await this.read(gmRoot, gmWirePath, snapshot, sources, noteEmbeds("gm"));
				gm = "synced";
			} else {
				gm = "missing";
			}
		}

		await this.readLooseMedia(loose, snapshot, sources);

		return {
			snapshot,
			gm,
			gmFolderPath: isVaultRoot(gmPath) ? "(not set)" : gmPath,
			shadowed,
			sources,
			publishedPath,
			gmPath: isVaultRoot(gmBoundary) ? "" : gmBoundary,
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
	private async readLooseMedia(
		loose: LooseEmbed[],
		into: Snapshot,
		sources: Map<string, string>,
	): Promise<void> {
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
			sources.set(wirePath, vaultPath);
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
		sources: Map<string, string>,
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
			sources.set(path, file.path);

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
