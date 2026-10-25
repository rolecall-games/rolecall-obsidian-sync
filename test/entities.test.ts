// What a push does with RoleCall's entity keys (plugin 0.5.0), pinned without
// an Obsidian runtime: the bookkeeping `sync.ts` runs around its vault writes,
// played through `planPush` / `planPull` the way the plugin runs them.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import type { NoteEntry } from "../src/api";
import {
	type BoundEntry,
	describeEntityResults,
	localTargets,
	readEntityResults,
	recordBound,
	settleStamped,
	shouldReplaceNormalised,
	stampTargets,
} from "../src/entities";
import {
	effectiveLocalHash,
	planPull,
	planPush,
	type StampedState,
	type SyncState,
} from "../src/plan";
import { stampRcId } from "../src/stamp";
import { summarize } from "../src/util";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const ID = "npc_01j9xk3f2m8qzr7w4e6t1yabcd";
const BOB = "GM/NPCs/Bob.md";

const noteOf = (path: string, markdown: string): NoteEntry => ({
	path,
	markdown,
	content_hash: sha(markdown),
});

/**
 * One push as `SyncEngine` runs it, with the vault reduced to a map of wire
 * path -> text: plan, "send", build `next`, then apply the response's `bound`
 * entries to the vault and the state. `respond` plays RoleCall.
 */
function push(
	vault: Map<string, string>,
	last: SyncState,
	stamped: StampedState,
	respond: (sent: NoteEntry[]) => unknown,
): { synced: SyncState; stamped: StampedState; sent: NoteEntry[]; tagged: number } | null {
	const snapshot = { notes: [...vault].map(([path, text]) => noteOf(path, text)), attachments: [] };
	const plan = planPush(last, snapshot, "synced");
	if (plan.isNoop) return null;

	const results = respond(plan.notes);
	const next: SyncState = { ...plan.currentHashes };
	const nextStamped = settleStamped(
		stamped,
		plan.notes.map((n) => n.path),
		next,
	);

	const sources = new Map([...vault.keys()].map((path) => [path, `Vault/${path}`]));
	let tagged = 0;
	const bound = readEntityResults(results).bound;
	for (const { entry } of stampTargets(bound, sources, new Set(), plan.currentHashes)) {
		const before = vault.get(entry.path) ?? "";
		const after = stampRcId(before, entry.rc_id, entry.replace) ?? before;
		vault.set(entry.path, after);
		if (recordBound(next, nextStamped, entry, sha(before), sha(after))) tagged += 1;
	}

	return { synced: next, stamped: nextStamped, sent: plan.notes, tagged };
}

const boundFor = (path: string, text: string, replace = false): BoundEntry => ({
	path,
	rc_id: ID,
	content_hash: sha(text),
	replace,
});

describe("push → stamp → push", () => {
	it("stamps the new entity note, then sends it once as an edit of the agreed version, then rests", () => {
		const original = "# Bob\nA bandit with a heart of gold.\n";
		const vault = new Map([[BOB, original]]);

		const first = push(vault, {}, {}, () => ({ bound: [boundFor(BOB, original)] }));
		assert.ok(first);
		assert.equal(first.tagged, 1);

		const stamped = `---\nrc_id: ${ID}\n---\n${original}`;
		assert.equal(vault.get(BOB), stamped);
		// RoleCall's hash — the version the vault agreed on — not the stamped file's.
		assert.equal(first.synced[BOB], sha(original));
		assert.deepEqual(first.stamped[BOB], { from: sha(original), to: sha(stamped) });

		// The next push sends the stamped file with the agreed version as its
		// base: RoleCall's stamp-agree rung (or a plain vault update) takes it.
		const second = push(vault, first.synced, first.stamped, (sent) => {
			assert.deepEqual(
				sent.map((n) => [n.path, n.base_hash]),
				[[BOB, sha(original)]],
			);
			return { notes: { created: 0, updated: 0, skipped: 1, deleted: 0 } };
		});
		assert.ok(second);
		assert.equal(second.synced[BOB], sha(stamped));
		assert.deepEqual(second.stamped, {}, "the stamp record goes once the stamped file is sent");

		assert.equal(push(vault, second.synced, second.stamped, () => ({})), null, "nothing left to send");
	});

	it("a pull between the stamp and the next push sees the stamp-only difference as nothing", () => {
		const original = "# Bob\n";
		const vault = new Map([[BOB, original]]);
		const first = push(vault, {}, {}, () => ({ bound: [boundFor(BOB, original)] }));
		assert.ok(first);
		const local = { [BOB]: sha(vault.get(BOB) ?? "") };
		const state = { synced: first.synced, pulled: {}, stamped: first.stamped };

		// RoleCall still has the pushed version.
		const unchanged = planPull([{ path: BOB, content_hash: sha(original) }], local, state);
		assert.deepEqual(unchanged.same, [{ path: BOB, hash: sha(original), parked: false }]);
		assert.deepEqual(unchanged.conflicts, []);

		// A field edited in RoleCall since: the app's file (which carries the id)
		// replaces the stamped one — an update, never a conflict.
		const edited = planPull([{ path: BOB, content_hash: "app-edit" }], local, state);
		assert.deepEqual(edited.update, [BOB]);
		assert.deepEqual(edited.conflicts, []);

		// Without the record, the same pull would have asked the GM.
		const forgetful = planPull(
			[{ path: BOB, content_hash: "app-edit" }],
			local,
			{ synced: first.synced, pulled: {} },
		);
		assert.deepEqual(forgetful.conflicts, [BOB]);
	});

	it("after the stamped push, the manifest agrees", () => {
		const original = "# Bob\n";
		const vault = new Map([[BOB, original]]);
		const first = push(vault, {}, {}, () => ({ bound: [boundFor(BOB, original)] }));
		assert.ok(first);
		const second = push(vault, first.synced, first.stamped, () => ({}));
		assert.ok(second);
		const stampedHash = sha(vault.get(BOB) ?? "");

		const pull = planPull(
			[{ path: BOB, content_hash: stampedHash }],
			{ [BOB]: stampedHash },
			{ synced: second.synced, pulled: {}, stamped: second.stamped },
		);
		assert.deepEqual(pull.same, [{ path: BOB, hash: stampedHash, parked: false }]);
	});

	it("replaces an emptied rc_id when RoleCall says so", () => {
		const original = "---\ntype: npc\nrc_id:\nrace: Elf\n---\nBody\n";
		const vault = new Map([[BOB, original]]);
		const first = push(vault, {}, {}, () => ({ bound: [boundFor(BOB, original, true)] }));
		assert.ok(first);
		assert.equal(vault.get(BOB), `---\ntype: npc\nrc_id: ${ID}\nrace: Elf\n---\nBody\n`);
		assert.equal(first.tagged, 1);
	});

	it("never overwrites an rc_id without replace", () => {
		const original = "---\nrc_id: npc_01j9xk3f2m8qzr7w4e6t1yzzzz\n---\n";
		const vault = new Map([[BOB, original]]);
		const first = push(vault, {}, {}, () => ({ bound: [boundFor(BOB, original)] }));
		assert.ok(first);
		assert.equal(vault.get(BOB), original);
		assert.equal(first.tagged, 0);
		assert.deepEqual(first.stamped, {});
	});

	it("leaves a BOM file alone, records RoleCall's hash, and has nothing to send", () => {
		const original = "﻿# Bob\n";
		const vault = new Map([[BOB, original]]);
		const first = push(vault, {}, {}, () => ({ bound: [boundFor(BOB, original)] }));
		assert.ok(first);
		assert.equal(vault.get(BOB), original);
		assert.equal(first.tagged, 0);
		assert.equal(first.synced[BOB], sha(original));
		assert.deepEqual(first.stamped, {});
		assert.equal(push(vault, first.synced, first.stamped, () => ({})), null);
	});

	it("keeps no stamp record for a file the GM changed after the push", () => {
		const next: SyncState = { [BOB]: "typed-since" };
		const stamped: StampedState = {};
		const entry = boundFor(BOB, "# Bob\n");
		assert.equal(recordBound(next, stamped, entry, sha("# Bob\nmore\n"), "after"), true);
		assert.equal(next[BOB], entry.content_hash);
		assert.deepEqual(stamped, {});
	});

	it("leaves a note it did not send alone when RoleCall's agreed version is not the one here", () => {
		// Another device (or a co-GM's vault) pushed a newer Bob; this vault
		// still holds the version it last synced and did not send it. RoleCall
		// lists Bob in `bound` with ITS hash. Stamping and recording that hash
		// would make the stale copy read as "the vault is ahead", and the next
		// push would put it over RoleCall's newer one.
		const mine = "# Bob\nThe old version.\n";
		const theirs = "# Bob\nThe newer version, from another device.\n";
		const vault = new Map([
			[BOB, mine],
			["GM/Plot.md", "A new note, so the push is not a no-op.\n"],
		]);
		const last: SyncState = { [BOB]: sha(mine) };

		const first = push(vault, last, {}, (sent) => {
			assert.deepEqual(sent.map((n) => n.path), ["GM/Plot.md"]);
			return { bound: [boundFor(BOB, theirs)] };
		});
		assert.ok(first);
		assert.equal(vault.get(BOB), mine, "not stamped");
		assert.equal(first.tagged, 0);
		assert.equal(first.synced[BOB], sha(mine), "still the version this vault agreed on");
		assert.deepEqual(first.stamped, {});

		// So the pull brings RoleCall's newer copy down, as it would have
		// without the entity keys …
		const local = { [BOB]: sha(vault.get(BOB) ?? "") };
		const pull = planPull(
			[{ path: BOB, content_hash: sha(theirs) }],
			local,
			{ synced: first.synced, pulled: {}, stamped: first.stamped },
		);
		assert.deepEqual(pull.update, [BOB]);
		// … and the next push does not send the stale copy.
		assert.equal(push(vault, first.synced, first.stamped, () => ({})), null);
	});

	it("a failed stamp still records RoleCall's hash", () => {
		const next: SyncState = {};
		const stamped: StampedState = {};
		const entry = boundFor(BOB, "# Bob\n");
		assert.equal(recordBound(next, stamped, entry), false);
		assert.deepEqual(next, { [BOB]: entry.content_hash });
		assert.deepEqual(stamped, {});
	});
});

describe("which entries a push acts on", () => {
	it("only paths this vault has a file for, and never a rejected one", () => {
		const sources = new Map([
			[BOB, "Campaign/GM/NPCs/Bob.md"],
			["GM/NPCs/Ann.md", "Campaign/GM/NPCs/Ann.md"],
		]);
		const entries = [{ path: BOB }, { path: "GM/NPCs/Ann.md" }, { path: "GM/NPCs/Gone.md" }];
		assert.deepEqual(localTargets(entries, sources, new Set(["GM/NPCs/Ann.md"])), [
			{ entry: { path: BOB }, localPath: "Campaign/GM/NPCs/Bob.md" },
		]);
	});

	it("stamps only a file this push read in the version RoleCall names as agreed", () => {
		const sources = new Map([
			[BOB, "Campaign/GM/NPCs/Bob.md"],
			["GM/NPCs/Ann.md", "Campaign/GM/NPCs/Ann.md"],
		]);
		const bob = boundFor(BOB, "# Bob\n");
		const ann = boundFor("GM/NPCs/Ann.md", "# Ann, as another device left her\n");
		const pushed: SyncState = { [BOB]: sha("# Bob\n"), "GM/NPCs/Ann.md": sha("# Ann\n") };
		assert.deepEqual(
			stampTargets([bob, ann], sources, new Set(), pushed).map((t) => t.entry.path),
			[BOB],
		);
	});

	it("a GM note RoleCall names while the GM folder is not pushed never enters the push state", () => {
		// With the folder off the collector reads no GM files, so there is no source.
		const vault = new Map([["Bob.md", "# Bob\n"]]);
		const first = push(vault, {}, {}, () => ({ bound: [boundFor(BOB, "# Bob\n")] }));
		assert.ok(first);
		assert.equal(BOB in first.synced, false);
	});
});

describe("reading the entity keys", () => {
	it("absent keys read as empty", () => {
		assert.deepEqual(readEntityResults(undefined), {
			bound: [],
			notesKept: [],
			attachmentsKept: [],
			duplicateIds: [],
			normalised: [],
		});
	});

	it("keeps only well-formed entries", () => {
		const good = { path: BOB, rc_id: ID, content_hash: sha("x"), replace: true };
		const read = readEntityResults({
			bound: [
				good,
				{ ...good, path: "NPCs/Bob.md" }, // published: never stamped
				{ ...good, path: "GM/NPCs/bob.png" },
				{ ...good, rc_id: "npc_x" },
				{ ...good, content_hash: "short" },
				"GM/NPCs/Bob.md",
				{ ...good, replace: "yes" },
			],
			entity_notes_kept: ["GM/NPCs/Garrick.md", 7],
			entity_attachments_kept: "GM/_att/g.png",
			duplicate_ids: ["GM/NPCs/Bob 2.md"],
			normalised: [
				{ path: "NPCs/Bob.md", markdown: "---\ntype: npc\n---\n", content_hash: sha("y") },
				{ path: "GM/NPCs/Bob.md", markdown: "x", content_hash: sha("y") },
				{ path: "NPCs/Bob.md", content_hash: sha("y") },
			],
		});

		assert.deepEqual(read.bound, [good, { ...good, replace: false }]);
		assert.deepEqual(read.notesKept, ["GM/NPCs/Garrick.md"]);
		assert.deepEqual(read.attachmentsKept, []);
		assert.deepEqual(read.duplicateIds, ["GM/NPCs/Bob 2.md"]);
		assert.deepEqual(read.normalised.map((n) => n.path), ["NPCs/Bob.md"]);
	});
});

describe("a GM note dragged into the published folder", () => {
	const dragged = "---\ntype: npc\nrc_id: " + ID + "\nsecret: The Duke's spy\n---\nBob.\n";
	const stored = "---\ntype: npc\nrc_id: " + ID + "\n---\nBob.\n";
	const entry = { path: "NPCs/Bob.md", markdown: stored, content_hash: sha(stored) };

	it("is replaced by RoleCall's player page while it is still what was pushed", () => {
		assert.equal(shouldReplaceNormalised(entry, sha(dragged), sha(dragged), sha(stored)), true);

		// Recorded as RoleCall's hash, the next push has nothing to send.
		const plan = planPush({ "NPCs/Bob.md": entry.content_hash }, {
			notes: [noteOf("NPCs/Bob.md", stored)],
			attachments: [],
		}, "synced");
		assert.equal(plan.isNoop, true);
	});

	it("is left alone when edited since the push — the next pull offers RoleCall's page", () => {
		const edited = dragged + "More.\n";
		assert.equal(shouldReplaceNormalised(entry, sha(dragged), sha(edited), sha(stored)), false);

		const pull = planPull(
			[{ path: "NPCs/Bob.md", content_hash: entry.content_hash }],
			{ "NPCs/Bob.md": sha(edited) },
			{ synced: { "NPCs/Bob.md": sha(dragged) }, pulled: {} },
		);
		assert.deepEqual(pull.conflicts, ["NPCs/Bob.md"]);
	});

	it("is never replaced with bytes that don't match RoleCall's hash, or when not pushed", () => {
		assert.equal(shouldReplaceNormalised(entry, sha(dragged), sha(dragged), sha("other")), false);
		assert.equal(shouldReplaceNormalised(entry, undefined, sha(dragged), sha(stored)), false);
	});
});

describe("stamp records", () => {
	it("judge a file that differs only by the stamp as the agreed version", () => {
		assert.equal(effectiveLocalHash("to", { from: "from", to: "to" }), "from");
		assert.equal(effectiveLocalHash("other", { from: "from", to: "to" }), "other");
		assert.equal(effectiveLocalHash(undefined, { from: "from", to: "to" }), undefined);
		assert.equal(effectiveLocalHash("x", undefined), "x");
	});

	it("are dropped once the path is sent, or no longer tracked", () => {
		const previous: StampedState = {
			"GM/A.md": { from: "a", to: "a2" },
			"GM/B.md": { from: "b", to: "b2" },
			"GM/C.md": { from: "c", to: "c2" },
		};
		const next: SyncState = { "GM/A.md": "a2", "GM/B.md": "b" };
		assert.deepEqual(settleStamped(previous, ["GM/A.md"], next), {
			"GM/B.md": { from: "b", to: "b2" },
		});
	});
});

describe("the entity notice", () => {
	const none = { tagged: 0, notesKept: 0, attachmentsKept: 0, duplicates: 0, normalised: 0 };

	it("says nothing when there is nothing to say", () => {
		assert.deepEqual(describeEntityResults(none), []);
	});

	it("counts each kind, in the GM's words", () => {
		assert.deepEqual(
			describeEntityResults({ tagged: 2, notesKept: 3, attachmentsKept: 1, duplicates: 2, normalised: 1 }),
			[
				"2 notes tagged with their RoleCall id",
				"RoleCall kept 3 entity notes you deleted and 1 image they show — remove the NPCs, places, groups or quests in RoleCall to delete them",
				"2 notes carry an id another note already uses — kept as plain notes",
				"1 player page published without your GM properties",
			],
		);
	});

	it("speaks of one in the singular", () => {
		assert.deepEqual(
			describeEntityResults({ ...none, tagged: 1, notesKept: 1, duplicates: 1, normalised: 2 }),
			[
				"1 note tagged with its RoleCall id",
				"RoleCall kept 1 entity note you deleted — remove the NPC, place, group or quest in RoleCall to delete it",
				"1 note carries an id another note already uses — kept as a plain note",
				"2 player pages published without your GM properties",
			],
		);
	});

	it("says why a picture stayed when only pictures were kept", () => {
		assert.deepEqual(describeEntityResults({ ...none, attachmentsKept: 2 }), [
			"RoleCall kept 2 images you deleted — an NPC, place, group or quest note still shows them",
		]);
	});

	it("joins the end-of-push notice", () => {
		assert.equal(
			summarize(
				{ results: { notes: { created: 1, updated: 0, skipped: 0, deleted: 0 } } },
				0,
				0,
				describeEntityResults({ ...none, tagged: 1 }),
			),
			"Synced: 1 added — 1 note tagged with its RoleCall id",
		);
	});
});
