// The plugin's privacy rules, pinned without an Obsidian runtime.
//
// Run with `npm test`. Everything under test is in `src/plan.ts`, which is
// kept free of the `obsidian` import for exactly this reason.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AttachmentEntry, NoteEntry } from "../src/api";
import {
	baseHash,
	claimsGmRoot,
	classifyPull,
	foldersOverlap,
	forgetAgreed,
	gmWirePath,
	goneFromRemote,
	isGmWirePath,
	isInsideFolder,
	isVaultRoot,
	localPathFor,
	placeLooseMedia,
	planPull,
	planPush,
	recordAgreed,
	type PullState,
	type Snapshot,
} from "../src/plan";
import { explainPullFailure, summarize, summarizePull, withHeldBack } from "../src/util";

const note = (path: string, hash: string): NoteEntry => ({
	path,
	markdown: `body of ${path}`,
	content_hash: hash,
});

const media = (path: string, hash: string): AttachmentEntry => ({
	path,
	content_base64: "AAAA",
	content_hash: hash,
});

const snapshot = (notes: NoteEntry[] = [], attachments: AttachmentEntry[] = []): Snapshot => ({
	notes,
	attachments,
});

describe("wire paths", () => {
	it("a GM-folder file is sent under the server's literal GM/ prefix", () => {
		assert.equal(gmWirePath("NPCs/Bob.md"), "GM/NPCs/Bob.md");
		assert.equal(isGmWirePath("GM/NPCs/Bob.md"), true);
	});

	it("only the exact-case prefix is the GM root", () => {
		assert.equal(isGmWirePath("gm/NPCs/Bob.md"), false);
		assert.equal(isGmWirePath("GMs/Bob.md"), false);
		assert.equal(isGmWirePath("GM.md"), false);
		assert.equal(isGmWirePath("NPCs/GM/Bob.md"), false);
	});
});

describe("a folder named GM inside the published folder", () => {
	it("is spotted in any case, at the top level only", () => {
		assert.equal(claimsGmRoot("GM/Bob.md"), true);
		assert.equal(claimsGmRoot("gm/Bob.md"), true);
		assert.equal(claimsGmRoot("Gm/deep/Bob.md"), true);
	});

	it("leaves everything else alone", () => {
		assert.equal(claimsGmRoot("GM.md"), false);
		assert.equal(claimsGmRoot("GMs/Bob.md"), false);
		assert.equal(claimsGmRoot("NPCs/GM/Bob.md"), false);
		assert.equal(claimsGmRoot("Bob.md"), false);
		assert.equal(claimsGmRoot("/Bob.md"), false);
	});
});

describe("folder settings that must not be walked", () => {
	it("an empty setting is the vault root", () => {
		assert.equal(isVaultRoot(""), true);
		assert.equal(isVaultRoot("/"), true);
		assert.equal(isVaultRoot("Published"), false);
	});

	it("the same folder, or one inside the other, overlaps", () => {
		assert.equal(foldersOverlap("Published", "Published"), true);
		assert.equal(foldersOverlap("Published", "Published/Secrets"), true);
		assert.equal(foldersOverlap("Campaign/GM", "Campaign"), true);
	});

	it("overlap is judged case-insensitively", () => {
		assert.equal(foldersOverlap("Published", "published/Secrets"), true);
		assert.equal(foldersOverlap("campaign", "Campaign"), true);
	});

	it("siblings and name-prefix lookalikes do not overlap", () => {
		assert.equal(foldersOverlap("Published", "GM"), false);
		assert.equal(foldersOverlap("Published", "PublishedDrafts"), false);
		assert.equal(foldersOverlap("Campaign/Published", "Campaign/GM"), false);
	});

	it("the vault root overlaps everything", () => {
		assert.equal(foldersOverlap("/", "GM"), true);
		assert.equal(foldersOverlap("Published", ""), true);
	});
});

describe("media a note embeds from outside the synced folders", () => {
	it("knows what is inside a folder, in any case", () => {
		assert.equal(isInsideFolder("GM/NPCs/face.png", "GM"), true);
		assert.equal(isInsideFolder("gm/NPCs/face.png", "GM"), true);
		assert.equal(isInsideFolder("GMs/face.png", "GM"), false);
		assert.equal(isInsideFolder("face.png", "GM"), false);
		assert.equal(isInsideFolder("Campaign/GM/face.png", "Campaign/GM"), true);
		// An unset folder is the vault root, and everything is inside that.
		assert.equal(isInsideFolder("face.png", ""), true);
	});

	it("goes beside the published notes when a published note embeds it", () => {
		const { placed, skipped } = placeLooseMedia(
			[{ vaultPath: "Pasted image 1.png", embeddedBy: "published" }],
			[],
		);
		assert.deepEqual(placed, [
			{ vaultPath: "Pasted image 1.png", wirePath: "_att/Pasted image 1.png" },
		]);
		assert.deepEqual(skipped, []);
	});

	it("is GM-only when only GM notes embed it", () => {
		const { placed } = placeLooseMedia([{ vaultPath: "Maps/lair.png", embeddedBy: "gm" }], []);
		assert.deepEqual(placed, [{ vaultPath: "Maps/lair.png", wirePath: "GM/_att/lair.png" }]);
	});

	it("is sent once, published, when both a published and a GM note embed it", () => {
		const { placed } = placeLooseMedia(
			[
				{ vaultPath: "shared.png", embeddedBy: "gm" },
				{ vaultPath: "shared.png", embeddedBy: "published" },
				{ vaultPath: "shared.png", embeddedBy: "gm" },
			],
			[],
		);
		assert.deepEqual(placed, [{ vaultPath: "shared.png", wirePath: "_att/shared.png" }]);
	});

	it("never lands on a file the folder walk already produced", () => {
		const { placed, skipped } = placeLooseMedia(
			[{ vaultPath: "map.png", embeddedBy: "published" }],
			["_att/Map.png", "Notes.md"],
		);
		assert.deepEqual(placed, []);
		assert.deepEqual(skipped, ["map.png"]);
	});

	it("keeps the first of two loose files with the same name", () => {
		const { placed, skipped } = placeLooseMedia(
			[
				{ vaultPath: "Zeta/map.png", embeddedBy: "published" },
				{ vaultPath: "Alpha/map.png", embeddedBy: "published" },
			],
			[],
		);
		assert.deepEqual(placed, [{ vaultPath: "Alpha/map.png", wirePath: "_att/map.png" }]);
		assert.deepEqual(skipped, ["Zeta/map.png"]);
	});

	it("lets the same name exist once in each root", () => {
		const { placed, skipped } = placeLooseMedia(
			[
				{ vaultPath: "A/map.png", embeddedBy: "published" },
				{ vaultPath: "B/map.png", embeddedBy: "gm" },
			],
			[],
		);
		assert.deepEqual(
			placed.map((p) => p.wirePath),
			["_att/map.png", "GM/_att/map.png"],
		);
		assert.deepEqual(skipped, []);
	});

	it("a GM-only loose file is removed by the switch-off cleanup like any GM path", () => {
		const plan = planPush({ "A.md": "a1", "GM/_att/lair.png": "l1" }, snapshot([note("A.md", "a1")]), "off");
		assert.deepEqual(plan.deletedPaths, ["GM/_att/lair.png"]);
		assert.deepEqual(plan.roots, ["published", "gm"]);
	});

	it("a loose file no note embeds any more is deleted on the next push", () => {
		const plan = planPush(
			{ "A.md": "a1", "_att/old.png": "o1" },
			snapshot([note("A.md", "a2")]),
			"off",
		);
		assert.deepEqual(plan.deletedPaths, ["_att/old.png"]);
	});
});

describe("planPush with the GM folder off", () => {
	it("names only the published root and sends only what changed", () => {
		const plan = planPush(
			{ "A.md": "a1", "B.md": "b1" },
			snapshot([note("A.md", "a1"), note("B.md", "b2"), note("C.md", "c1")]),
			"off",
		);

		assert.deepEqual(plan.roots, ["published"]);
		assert.deepEqual(
			plan.notes.map((n) => n.path),
			["B.md", "C.md"],
		);
		assert.deepEqual(plan.deletedPaths, []);
		assert.equal(plan.gmRemovals, 0);
		assert.equal(plan.isNoop, false);
	});

	it("deletes what disappeared from the published folder", () => {
		const plan = planPush({ "A.md": "a1", "_att/map.png": "m1" }, snapshot(), "off");
		assert.deepEqual(plan.deletedPaths, ["A.md", "_att/map.png"]);
		assert.deepEqual(plan.roots, ["published"]);
	});

	it("is a no-op when nothing changed", () => {
		const plan = planPush({ "A.md": "a1" }, snapshot([note("A.md", "a1")]), "off");
		assert.equal(plan.isNoop, true);
		assert.deepEqual(plan.currentHashes, { "A.md": "a1" });
	});
});

describe("planPush with the GM folder on", () => {
	it("names both roots and sends GM files beside published ones", () => {
		const plan = planPush(
			{ "A.md": "a1" },
			snapshot([note("A.md", "a1"), note("GM/Heist.md", "h1")], [media("GM/_att/map.png", "m1")]),
			"synced",
		);

		assert.deepEqual(plan.roots, ["published", "gm"]);
		assert.deepEqual(
			plan.notes.map((n) => n.path),
			["GM/Heist.md"],
		);
		assert.deepEqual(
			plan.attachments.map((a) => a.path),
			["GM/_att/map.png"],
		);
		assert.deepEqual(plan.currentHashes, {
			"A.md": "a1",
			"GM/Heist.md": "h1",
			"GM/_att/map.png": "m1",
		});
	});

	it("deletes a GM file the GM deleted, like any other", () => {
		const plan = planPush(
			{ "A.md": "a1", "GM/Heist.md": "h1", "GM/Old.md": "o1" },
			snapshot([note("A.md", "a1"), note("GM/Heist.md", "h1")]),
			"synced",
		);

		assert.deepEqual(plan.deletedPaths, ["GM/Old.md"]);
		assert.deepEqual(plan.roots, ["published", "gm"]);
		// A file deleted while the switch is on is an ordinary delete, not the
		// switch-off cleanup.
		assert.equal(plan.gmRemovals, 0);
	});

	it("still names the GM root when nothing under it changed", () => {
		const plan = planPush(
			{ "A.md": "a1", "GM/Heist.md": "h1" },
			snapshot([note("A.md", "a2"), note("GM/Heist.md", "h1")]),
			"synced",
		);

		assert.deepEqual(plan.roots, ["published", "gm"]);
		assert.deepEqual(
			plan.notes.map((n) => n.path),
			["A.md"],
		);
	});
});

describe("planPush after the GM folder is switched off", () => {
	const last = { "A.md": "a1", "GM/Heist.md": "h1", "GM/_att/map.png": "m1" };

	it("removes every GM path it had synced, in a batch that names the GM root", () => {
		const plan = planPush(last, snapshot([note("A.md", "a1")]), "off");

		assert.deepEqual(plan.deletedPaths, ["GM/Heist.md", "GM/_att/map.png"]);
		// Without `gm` in roots RoleCall ignores GM deletes, and the notes the
		// GM just asked to have removed would stay.
		assert.deepEqual(plan.roots, ["published", "gm"]);
		assert.equal(plan.gmRemovals, 2);
		assert.equal(plan.isNoop, false);
		assert.deepEqual(plan.currentHashes, { "A.md": "a1" });
	});

	it("is published-only again on the push after that", () => {
		const cleanup = planPush(last, snapshot([note("A.md", "a1")]), "off");
		const next = planPush(cleanup.currentHashes, snapshot([note("A.md", "a1")]), "off");

		assert.deepEqual(next.roots, ["published"]);
		assert.equal(next.isNoop, true);
	});
});

describe("planPush when the GM folder is on but cannot be found", () => {
	const last = { "A.md": "a1", "GM/Heist.md": "h1", "GM/_att/map.png": "m1" };

	it("deletes nothing under the GM root — a typo is not a request to remove", () => {
		const plan = planPush(last, snapshot([note("A.md", "a1")]), "missing");

		assert.deepEqual(plan.deletedPaths, []);
		assert.equal(plan.gmRemovals, 0);
		assert.equal(plan.isNoop, true);
	});

	it("carries the GM state forward so a later push can still diff it", () => {
		const plan = planPush(last, snapshot([note("A.md", "a2")]), "missing");

		assert.deepEqual(plan.currentHashes, {
			"A.md": "a2",
			"GM/Heist.md": "h1",
			"GM/_att/map.png": "m1",
		});
		assert.deepEqual(
			plan.notes.map((n) => n.path),
			["A.md"],
		);
	});

	it("says nothing about the GM root", () => {
		const plan = planPush(last, snapshot([note("A.md", "a2")]), "missing");
		assert.deepEqual(plan.roots, ["published"]);
	});

	it("still deletes what disappeared from the published folder", () => {
		const plan = planPush(last, snapshot(), "missing");
		assert.deepEqual(plan.deletedPaths, ["A.md"]);
	});
});

describe("the end-of-push notice", () => {
	it("counts both kinds of entry together", () => {
		const message = summarize(
			{
				results: {
					notes: { created: 2, updated: 1, skipped: 0, deleted: 0 },
					attachments: { created: 1, updated: 0, skipped: 0, deleted: 3 },
				},
			},
			0,
		);
		assert.equal(message, "Synced: 3 added, 1 updated, 3 deleted");
	});

	it("says when the server rejected something", () => {
		assert.equal(summarize(undefined, 2), "Synced — 2 rejected (see console)");
	});

	it("says when published files were held back, even if nothing changed", () => {
		assert.match(withHeldBack("Already up to date", 2), /^Already up to date — 2 not sent: /);
		assert.equal(withHeldBack("Already up to date", 0), "Already up to date");
		assert.match(summarize(undefined, 0, 1), /^Synced — 1 not sent: a folder named GM/);
	});
});

describe("a push says which version each change was made from", () => {
	it("sends the last synced hash as base_hash for a changed note", () => {
		const plan = planPush({ "A.md": "a1" }, snapshot([note("A.md", "a2")]), "off");
		assert.equal(plan.notes[0]?.base_hash, "a1");
	});

	it("sends none for a note it has no record of", () => {
		const plan = planPush({}, snapshot([note("New.md", "n1")]), "off");
		assert.equal(plan.notes[0]?.base_hash, undefined);
		assert.equal("base_hash" in (plan.notes[0] ?? {}), false);
	});

	it("falls back to the pull's record for a GM note that was never pushed", () => {
		const plan = planPush(
			{},
			snapshot([note("GM/Heist.md", "edited")]),
			"synced",
			{ "GM/Heist.md": "pulled" },
		);
		assert.equal(plan.notes[0]?.base_hash, "pulled");
	});

	it("the pull's record never causes a delete", () => {
		const plan = planPush({ "A.md": "a1" }, snapshot([note("A.md", "a1")]), "off", {
			"GM/Heist.md": "pulled",
		});
		assert.deepEqual(plan.deletedPaths, []);
		assert.deepEqual(plan.roots, ["published"]);
		assert.equal(plan.isNoop, true);
	});
});

describe("what a pull does about one file", () => {
	it("creates what is new on RoleCall", () => {
		assert.equal(classifyPull("r1", undefined, undefined, false), "create");
	});

	it("does not resurrect a file deleted here since the last sync", () => {
		assert.equal(classifyPull("r1", undefined, "r1", false), "deleted-here");
		assert.equal(classifyPull("r1", undefined, "old", true), "deleted-here");
	});

	it("leaves identical files alone", () => {
		assert.equal(classifyPull("same", "same", undefined, false), "same");
		assert.equal(classifyPull("same", "same", "old", true), "same");
	});

	it("updates a file the vault has not touched since the last sync", () => {
		assert.equal(classifyPull("r2", "l1", "l1", false), "update");
	});

	it("leaves a file only the vault changed for the next push", () => {
		assert.equal(classifyPull("r1", "l2", "r1", false), "local-ahead");
	});

	it("never overwrites a file changed on both sides", () => {
		assert.equal(classifyPull("r2", "l2", "base", false), "conflict");
	});

	it("never overwrites a differing file it has no history for", () => {
		assert.equal(classifyPull("r1", "l1", undefined, false), "conflict");
	});

	it("treats a conflict parked on RoleCall as a conflict, even where it would otherwise update", () => {
		// The push that parked it recorded the vault's hash, so by the hashes
		// alone this looks like "untouched here, changed there".
		assert.equal(classifyPull("app", "vault", "vault", true), "conflict");
	});
});

describe("planPull", () => {
	const state: PullState = { synced: { "Edited.md": "e1", "Mine.md": "m1" }, pulled: {} };
	const local = { "Edited.md": "e1", "Mine.md": "m2", "Both.md": "b-local", "Same.md": "s1" };

	it("sorts RoleCall's files into add, update, conflict and identical", () => {
		const plan = planPull(
			[
				{ path: "New.md", content_hash: "n1" },
				{ path: "Edited.md", content_hash: "e2" },
				{ path: "Mine.md", content_hash: "m1" },
				{ path: "Both.md", content_hash: "b-remote" },
				{ path: "Same.md", content_hash: "s1" },
			],
			local,
			state,
		);

		assert.deepEqual(plan.create, ["New.md"]);
		assert.deepEqual(plan.update, ["Edited.md"]);
		assert.deepEqual(plan.conflicts, ["Both.md"]);
		assert.deepEqual(plan.same, [{ path: "Same.md", hash: "s1", parked: false }]);
	});

	it("marks an identical file RoleCall still has a conflict parked on", () => {
		const plan = planPull(
			[{ path: "Same.md", content_hash: "s1", conflict: true }],
			{ "Same.md": "s1" },
			{ synced: { "Same.md": "s1" }, pulled: {} },
		);
		assert.deepEqual(plan.same, [{ path: "Same.md", hash: "s1", parked: true }]);
		assert.deepEqual(plan.conflicts, []);
	});

	it("uses the pull's own record as the base for an unpushed GM note", () => {
		const plan = planPull(
			[{ path: "GM/Heist.md", content_hash: "h2" }],
			{ "GM/Heist.md": "h1" },
			{ synced: {}, pulled: { "GM/Heist.md": "h1" } },
		);
		assert.deepEqual(plan.update, ["GM/Heist.md"]);
	});
});

describe("where a pull records what it agreed on", () => {
	it("published paths go in the push state", () => {
		const state: PullState = { synced: {}, pulled: {} };
		recordAgreed(state, "Town.md", "t1", false);
		assert.deepEqual(state, { synced: { "Town.md": "t1" }, pulled: {} });
	});

	it("GM paths stay OUT of the push state while the GM folder is not pushed", () => {
		const state: PullState = { synced: {}, pulled: {} };
		recordAgreed(state, "GM/Heist.md", "h1", false);
		assert.deepEqual(state, { synced: {}, pulled: { "GM/Heist.md": "h1" } });
	});

	it("so the next push does not ask RoleCall to delete the GM notes it just pulled", () => {
		// In the push state, a GM path with the switch off IS that request:
		// it is how switching the GM folder off cleans up.
		const state: PullState = { synced: { "A.md": "a1" }, pulled: {} };
		recordAgreed(state, "GM/Heist.md", "h1", false);
		recordAgreed(state, "GM/_att/map.png", "m1", false);

		const plan = planPush(state.synced, snapshot([note("A.md", "a1")]), "off", state.pulled);
		assert.deepEqual(plan.deletedPaths, []);
		assert.equal(plan.gmRemovals, 0);
		assert.deepEqual(plan.roots, ["published"]);
	});

	it("GM paths go in the push state once the GM folder is pushed, and leave the pull's record", () => {
		const state: PullState = { synced: {}, pulled: { "GM/Heist.md": "h1" } };
		recordAgreed(state, "GM/Heist.md", "h2", true);
		assert.deepEqual(state, { synced: { "GM/Heist.md": "h2" }, pulled: {} });
	});

	it("forgetting a path makes the next push send it whole, and deletes nothing", () => {
		const state: PullState = { synced: { "A.md": "a1", "B.md": "b1" }, pulled: {} };
		forgetAgreed(state, "B.md");

		const plan = planPush(state.synced, snapshot([note("A.md", "a1"), note("B.md", "b1")]), "off");
		assert.deepEqual(
			plan.notes.map((n) => n.path),
			["B.md"],
		);
		assert.equal(plan.notes[0]?.base_hash, undefined);
		assert.deepEqual(plan.deletedPaths, []);
	});

	it("the push state wins when both hold a path", () => {
		assert.equal(baseHash({ synced: { "P.md": "s" }, pulled: { "P.md": "p" } }, "P.md"), "s");
		assert.equal(baseHash({ synced: {}, pulled: { "P.md": "p" } }, "P.md"), "p");
		assert.equal(baseHash({ synced: {}, pulled: {} }, "P.md"), undefined);
	});
});

describe("files RoleCall no longer has", () => {
	it("are the ones this vault synced before and still holds", () => {
		const gone = goneFromRemote(
			["Kept.md"],
			{ "Kept.md": "k", "Moved.md": "m", "NeverPushed.md": "n", "GM/Old.md": "o" },
			{ synced: { "Kept.md": "k", "Moved.md": "m" }, pulled: { "GM/Old.md": "o" } },
		);
		// A file never synced is simply unpushed, not removed.
		assert.deepEqual(gone, ["GM/Old.md", "Moved.md"]);
	});
});

describe("where a pulled file lands", () => {
	it("published paths under the published folder, GM paths under the GM folder", () => {
		assert.equal(localPathFor("NPCs/Bob.md", "Published", "GM"), "Published/NPCs/Bob.md");
		assert.equal(localPathFor("GM/Plots/Heist.md", "Published", "Secrets"), "Secrets/Plots/Heist.md");
		assert.equal(localPathFor("_att/map.png", "Campaign/Out", "GM"), "Campaign/Out/_att/map.png");
	});

	it("a GM path has nowhere to go when no GM folder is set", () => {
		assert.equal(localPathFor("GM/Plots/Heist.md", "Published", ""), null);
		assert.equal(localPathFor("GM/Plots/Heist.md", "Published", "/"), null);
	});
});

describe("the end-of-pull notice", () => {
	it("says what came down", () => {
		assert.equal(summarizePull({ added: 3, updated: 1, failed: 0 }, 0, 0, 0), "Pulled: 3 added, 1 updated");
		assert.equal(summarizePull({ added: 0, updated: 0, failed: 0 }, 0, 0, 0), "Already up to date");
	});

	it("says what it did not do, and why", () => {
		const message = summarizePull({ added: 1, updated: 0, failed: 2 }, 3, 1, 4);
		assert.match(message, /^Pulled: 1 added/);
		assert.match(message, /3 changed in both places \(your copy was kept\)/);
		assert.match(message, /2 failed/);
		assert.match(message, /4 GM files skipped: set a GM folder/);
		assert.match(message, /1 removed on RoleCall is still in this vault/);
	});

	it("tells a push-only token how to get the permission", () => {
		assert.match(explainPullFailure({ status: 403 }), /can push notes but not pull them/);
		assert.match(explainPullFailure({ status: 404 }), /doesn't support pulling/);
		assert.match(explainPullFailure({ status: 401 }), /Invalid or revoked token/);
	});
});
