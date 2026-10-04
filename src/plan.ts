// The decisions a push makes, with no Obsidian runtime in sight.
//
// Everything in here is a pure function of paths, hashes and settings, which
// is what lets `test/plan.test.ts` pin the plugin's privacy rules without a
// vault: which folder a file is sent under, which files are refused, and —
// the one that deletes things — which paths a push tells RoleCall to remove.

import type { AttachmentEntry, NoteEntry, SyncRoot } from "./api";

/** Wire path -> content hash, from the last successful sync. */
export type SyncState = Record<string, string>;

export interface Snapshot {
	notes: NoteEntry[];
	attachments: AttachmentEntry[];
}

/**
 * What became of the GM folder on this push.
 *
 * - `synced`  — the switch is on and the folder was read. GM paths are diffed
 *   like any others.
 * - `off`     — the switch is off. Nothing under the GM folder was read; GM
 *   paths still in the state are what a GM who turned the switch off wants
 *   gone, so they are deleted.
 * - `missing` — the switch is on but the folder was not found (renamed, a
 *   typo in the setting). This is NOT `off`: the GM asked for these notes to
 *   sync, so a folder we cannot find must not read as "delete them all".
 *   GM paths are carried forward untouched and the batch says nothing about
 *   the GM root.
 */
export type GmFolderState = "synced" | "off" | "missing";

export interface PushPlan {
	roots: SyncRoot[];
	notes: NoteEntry[];
	attachments: AttachmentEntry[];
	deletedPaths: string[];
	/** Everything that counts as synced if the server accepts the batch. */
	currentHashes: SyncState;
	/** GM-root deletions, counted apart so the notice can say so. */
	gmRemovals: number;
	isNoop: boolean;
}

// The prefix RoleCall stores a GM-only path under. It is the SERVER's literal
// (`RoleCall.Obsidian.Roots`), not the vault's folder name: a GM who calls
// their folder "Secrets" still sends `GM/…`, and the server accepts no other
// spelling.
export const GM_WIRE_PREFIX = "GM/";

/** The wire path for a file `rel` under the vault's GM folder. */
export function gmWirePath(rel: string): string {
	return GM_WIRE_PREFIX + rel;
}

/** Is this wire path under the GM root? Exact case, like the server's test. */
export function isGmWirePath(path: string): boolean {
	return path.startsWith(GM_WIRE_PREFIX);
}

/**
 * Would this path, relative to the PUBLISHED folder, be spelled like a GM-root
 * path on the wire? True for a top-level folder named `GM` in any case.
 *
 * Published paths are sent root-relative, so `Published/GM/Bob.md` would go
 * out as `GM/Bob.md` — exactly what a file in the real GM folder is sent as.
 * RoleCall would file it GM-only (hidden, never leaked), and the GM would have
 * no idea why a note they published is not on their site. Any-case because
 * the server reserves every casing of the name.
 */
export function claimsGmRoot(rel: string): boolean {
	const slash = rel.indexOf("/");
	return slash > 0 && rel.slice(0, slash).toLowerCase() === "gm";
}

// Where RoleCall keeps media that has no folder of its own (the server's
// `Roots.attachment_folder/1`): `_att/…` beside the published notes, `GM/_att/…`
// beside the GM ones. It is the same place an image pasted into a note on
// RoleCall lands, and the campaign's notes tree does not list it.
export const ATTACHMENT_DIR = "_att";

/** A media file a synced note embeds, living outside both synced folders. */
export interface LooseEmbed {
	/** The file's path in the vault. */
	vaultPath: string;
	/** The root of the note that embeds it. */
	embeddedBy: SyncRoot;
}

export interface PlacedMedia {
	vaultPath: string;
	wirePath: string;
}

/**
 * Is `path` inside `folder`? Case-insensitive, for the same reason as
 * `foldersOverlap`: this is what keeps a file in the GM folder from being
 * picked up as loose media, so the cautious answer is "yes".
 */
export function isInsideFolder(path: string, folder: string): boolean {
	if (isVaultRoot(folder)) return true;
	return path.toLowerCase().startsWith(folder.toLowerCase() + "/");
}

/**
 * Decide where loose media goes on the wire.
 *
 * A file follows the most public note that embeds it: embedded by any
 * published note it is published (`_att/<name>`) — that note already shows it
 * to the players in Obsidian — and embedded only by GM notes it is GM-only
 * (`GM/_att/<name>`). One copy either way; a GM note resolves an image in
 * either root.
 *
 * `taken` is every wire path the folder walks already produced. A real file
 * at a path wins over a loose one that would land on it, and of two loose
 * files with the same name the first by vault path wins: RoleCall resolves an
 * embed by file name, so a second copy could only ever shadow the first.
 * Names are compared case-insensitively. What lost is returned in `skipped`.
 */
export function placeLooseMedia(
	embeds: LooseEmbed[],
	taken: Iterable<string>,
): { placed: PlacedMedia[]; skipped: string[] } {
	const publishedPaths = new Set(
		embeds.filter((e) => e.embeddedBy === "published").map((e) => e.vaultPath),
	);
	const vaultPaths = [...new Set(embeds.map((e) => e.vaultPath))].sort();

	const used = new Set<string>();
	for (const path of taken) used.add(path.toLowerCase());

	const placed: PlacedMedia[] = [];
	const skipped: string[] = [];

	for (const vaultPath of vaultPaths) {
		const name = vaultPath.slice(vaultPath.lastIndexOf("/") + 1);
		const rel = `${ATTACHMENT_DIR}/${name}`;
		const wirePath = publishedPaths.has(vaultPath) ? rel : gmWirePath(rel);
		const key = wirePath.toLowerCase();

		if (used.has(key)) {
			skipped.push(vaultPath);
		} else {
			used.add(key);
			placed.push({ vaultPath, wirePath });
		}
	}

	return { placed, skipped };
}

/** Is this normalised folder path the vault root (or nothing at all)? */
export function isVaultRoot(folderPath: string): boolean {
	return folderPath === "" || folderPath === "/";
}

/**
 * Do two normalised folder paths overlap — the same folder, or one inside the
 * other? Compared case-insensitively: macOS and Windows vaults are, and a
 * false "they overlap" only asks the GM to fix a setting, while a false "they
 * don't" would send GM notes as published ones.
 */
export function foldersOverlap(a: string, b: string): boolean {
	if (isVaultRoot(a) || isVaultRoot(b)) return true;
	const x = a.toLowerCase() + "/";
	const y = b.toLowerCase() + "/";
	return x.startsWith(y) || y.startsWith(x);
}

/**
 * Turn "what the vault holds now" and "what we synced last time" into one
 * batch: only what changed, plus explicit deletes for what disappeared.
 */
export function planPush(last: SyncState, snapshot: Snapshot, gm: GmFolderState): PushPlan {
	// Current full state by wire path → hash (notes + attachments share the namespace).
	const currentHashes: SyncState = {};
	for (const n of snapshot.notes) currentHashes[n.path] = n.content_hash;
	for (const a of snapshot.attachments) currentHashes[a.path] = a.content_hash;

	const lastGmPaths = Object.keys(last).filter(isGmWirePath);

	if (gm === "missing") {
		// Not read, so not judged: carried forward exactly as they were.
		for (const path of lastGmPaths) {
			const hash = last[path];
			if (hash !== undefined) currentHashes[path] = hash;
		}
	}

	const notes = snapshot.notes.filter((n) => last[n.path] !== n.content_hash);
	const attachments = snapshot.attachments.filter((a) => last[a.path] !== a.content_hash);
	const deletedPaths = Object.keys(last).filter((p) => !(p in currentHashes));

	// The batch speaks for the GM root when it carries GM files, or when it is
	// the cleanup push after the switch was turned off. RoleCall ignores GM
	// deletes from a batch that does not name the root, so leaving it out here
	// would strand the notes the GM just asked to have removed.
	const speaksForGm = gm === "synced" || (gm === "off" && lastGmPaths.length > 0);

	return {
		roots: speaksForGm ? ["published", "gm"] : ["published"],
		notes,
		attachments,
		deletedPaths,
		currentHashes,
		gmRemovals: gm === "off" ? lastGmPaths.length : 0,
		isNoop: notes.length === 0 && attachments.length === 0 && deletedPaths.length === 0,
	};
}
