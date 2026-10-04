// The decisions a push makes, with no Obsidian runtime in sight.
//
// Everything in here is a pure function of paths, hashes and settings, which
// is what lets `test/plan.test.ts` pin the plugin's privacy rules without a
// vault: which folder a file is sent under, which files are refused, and —
// the one that deletes things — which paths a push tells RoleCall to remove.

import type { AttachmentEntry, ManifestNote, NoteEntry, SyncRoot } from "./api";

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
 *
 * `pulled` is the pull's own record (see `PullState`). It decides nothing
 * about what is sent or deleted; it only supplies a `base_hash` for a note
 * the push state has no entry for.
 */
export function planPush(
	last: SyncState,
	snapshot: Snapshot,
	gm: GmFolderState,
	pulled: SyncState = {},
): PushPlan {
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

	// Each changed note says which version it was edited from, when we know.
	const notes = snapshot.notes
		.filter((n) => last[n.path] !== n.content_hash)
		.map((n) => {
			const base = last[n.path] ?? pulled[n.path];
			return base === undefined ? n : { ...n, base_hash: base };
		});
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

// ── Pull ────────────────────────────────────────────────────────────────────

/**
 * What the plugin remembers between syncs.
 *
 * - `synced` — the push state: wire path -> hash at the last sync, for every
 *   path a push manages. A push deletes from RoleCall whatever is in here and
 *   no longer in the vault.
 * - `pulled` — GM notes a pull brought down while the GM folder was NOT being
 *   pushed. They cannot go in `synced`: with the switch off, a push treats
 *   every GM path there as one to remove from RoleCall. Kept apart, they are
 *   only ever a "which version did I last see" record.
 */
export interface PullState {
	synced: SyncState;
	pulled: SyncState;
}

/** The version of `path` this vault last agreed with RoleCall on, if any. */
export function baseHash(state: PullState, path: string): string | undefined {
	return state.synced[path] ?? state.pulled[path];
}

/**
 * Record that the vault and RoleCall agree on `hash` for `path` — in the push
 * state when a push manages that path, in the pull's own record when it does
 * not (a GM path while the GM folder is not pushed).
 */
export function recordAgreed(
	state: PullState,
	path: string,
	hash: string,
	gmPushed: boolean,
): void {
	if (!isGmWirePath(path) || gmPushed) {
		state.synced[path] = hash;
		delete state.pulled[path];
	} else {
		state.pulled[path] = hash;
	}
}

/**
 * Forget what was agreed for `path`, so the next push sends the file whole.
 *
 * Used for one case: the vault holds exactly RoleCall's version of a note
 * that RoleCall still has a conflict parked on. Only a push can settle that —
 * RoleCall clears a parked conflict when a vault shows it the app's own
 * bytes — and a push sends nothing it believes is already synced.
 */
export function forgetAgreed(state: PullState, path: string): void {
	delete state.synced[path];
	delete state.pulled[path];
}

/**
 * What a pull does about one path RoleCall holds.
 *
 * - `create`       — not in the vault and never synced: new on RoleCall.
 * - `update`       — the vault's copy is the one we last synced; RoleCall's
 *                    has changed since. Safe to replace.
 * - `same`         — identical already.
 * - `local-ahead`  — RoleCall's copy is the one we last synced; the vault's
 *                    has changed. The next push sends it.
 * - `deleted-here` — synced before and since deleted from the vault. Not
 *                    resurrected; the next push tells RoleCall.
 * - `conflict`     — changed on both sides, or different with no record of a
 *                    common version, or RoleCall has a conflict parked on it.
 *                    Never resolved automatically.
 */
export type PullAction =
	| "create"
	| "update"
	| "same"
	| "local-ahead"
	| "deleted-here"
	| "conflict";

export function classifyPull(
	remoteHash: string,
	localHash: string | undefined,
	base: string | undefined,
	parked: boolean,
): PullAction {
	if (localHash === undefined) return base === undefined ? "create" : "deleted-here";
	if (localHash === remoteHash) return "same";
	if (parked) return "conflict";
	if (base === localHash) return "update";
	if (base === remoteHash) return "local-ahead";
	return "conflict";
}

export interface PullPlan {
	create: string[];
	update: string[];
	conflicts: string[];
	/**
	 * Identical on both sides, with the hash to record. `parked` — RoleCall
	 * still has a conflict standing on it, which the next push should settle
	 * (`forgetAgreed`).
	 */
	same: { path: string; hash: string; parked: boolean }[];
}

/** Sort RoleCall's entries of one kind into what a pull does with each. */
export function planPull(
	remote: Pick<ManifestNote, "path" | "content_hash" | "conflict">[],
	local: SyncState,
	state: PullState,
): PullPlan {
	const plan: PullPlan = { create: [], update: [], conflicts: [], same: [] };

	for (const entry of remote) {
		const action = classifyPull(
			entry.content_hash,
			local[entry.path],
			baseHash(state, entry.path),
			entry.conflict === true,
		);
		if (action === "create") plan.create.push(entry.path);
		else if (action === "update") plan.update.push(entry.path);
		else if (action === "conflict") plan.conflicts.push(entry.path);
		else if (action === "same") {
			plan.same.push({
				path: entry.path,
				hash: entry.content_hash,
				parked: entry.conflict === true,
			});
		}
	}

	return plan;
}

/**
 * Paths the vault still holds, and once synced, that RoleCall no longer has:
 * deleted or moved there. A pull leaves these files alone — it only adds and
 * updates — and says how many there are.
 */
export function goneFromRemote(
	remotePaths: Iterable<string>,
	local: SyncState,
	state: PullState,
): string[] {
	const remote = new Set(remotePaths);
	return Object.keys(local)
		.filter((path) => !remote.has(path) && baseHash(state, path) !== undefined)
		.sort();
}

/**
 * Where a wire path lives in this vault: under the published folder, or the
 * GM folder for a `GM/…` path. `null` for a GM path when no GM folder is set.
 */
export function localPathFor(wirePath: string, publishedPath: string, gmPath: string): string | null {
	if (!isGmWirePath(wirePath)) return `${publishedPath}/${wirePath}`;
	if (isVaultRoot(gmPath)) return null;
	return `${gmPath}/${wirePath.slice(GM_WIRE_PREFIX.length)}`;
}
