# RoleCall Sync

An Obsidian community plugin that syncs your TTRPG campaign notes to a [RoleCall](https://rolecall.games) game. RoleCall renders them on your campaign site — wikilinks and frontmatter are parsed there.

> **Requires a free [https://rolecall.games](https://rolecall.games) account.** The plugin pushes notes to a game you run there, authenticated by a per-game API token from that game's **Plugins** page (see [Configure](#configure)).

## The one rule: `Published/` is for your players, `GM/` is for you

Two folders, and which one a note is in is the only thing that decides who can read it:

| Folder       | Sent to RoleCall?                                         | Who can read it there        |
| ------------ | --------------------------------------------------------- | ---------------------------- |
| `Published/` | Always.                                                   | Your players (or the public, if you made the campaign's notes public). |
| `GM/`        | **Only if you turn on _Also push my GM folder_.** Off by default. | GMs of the campaign. Nobody else, ever. |
| anything else | Never — with one exception: **an image a synced note embeds.** | Whoever can read the note that embeds it. |

Both folder names are configurable.

**Images don't need a folder.** If a note in `Published/` embeds an image (`![[map.png]]`), the
image is uploaded with it wherever it lives in your vault — the vault root, an attachments folder,
anywhere — because your players are already meant to see it in that note. If only GM notes embed
it, it is uploaded GM-only, and only when the GM folder is switched on. Nothing else outside the two
folders is ever read: not notes, not images no synced note embeds.

The one place this never reaches is your GM folder. An image stored there is not published by
embedding it in a published note — with the GM folder off it never leaves this device, and with it
on it syncs GM-only. Move the image out of `GM/` if your players should see it.

**With the GM folder off** (the default), nothing under it is read, let alone sent — your secrets,
plans and spoilers stay on this device, exactly as in every earlier version of this plugin.

**With it on**, your GM notes sync to the GM side of your campaign's notes workspace on RoleCall, so
your prep is there when you run the game. Players never see a GM note: not in the notes list, not in
search, not in the activity feed — and a `[[link]]` from a published note to a GM note shows up for
them as plain text, not even as a link. This is enforced by the RoleCall server, not by this plugin:
the server files anything under `GM/` as GM-only and re-checks every path itself.

**Turning it off again removes those notes from RoleCall** on your next push. (A GM note you went on
to edit on RoleCall is kept there and flagged for you to decide, rather than deleted.)

> Don't rely on `%%comments%%` or `> [!secret]` callouts to hide things inside a published note —
> they are **not** hidden. If it shouldn't be seen, keep it in `GM/`.

> A folder named `GM` *inside* `Published/` is never sent — it would be indistinguishable from your
> real GM folder. The plugin tells you when it holds files back for this reason; rename the folder.

## What it does

- Adds a **Push notes to RoleCall** ribbon icon (cloud-with-arrow) and a command-palette action.
- On trigger, sends an **incremental** JSON batch of changed notes + embedded media to RoleCall,
  and deletes notes you've removed. Unchanged files are skipped (it remembers the last sync).
- Markdown notes become pages; media in a synced folder, or embedded by a synced note, becomes
  images on those pages. Stop embedding an image from outside the folders and the next push removes
  it from RoleCall.
- Adds a **Pull notes from RoleCall** command that brings down what was written or changed on
  RoleCall — by you or your players — see [Pull](#pull).

## What it does *not* do (yet)

- No automatic / background sync. You push and pull when you want.
- A pull never deletes or renames anything in your vault. A note deleted or moved on RoleCall stays
  where it was here; the pull tells you how many there are.
- No diff preview before pushing or pulling.

## Install

### From the community plugin directory (recommended)

1. Open **Settings → Community plugins → Browse**.
2. Search for **RoleCall Sync**, then Install and Enable.

### Via BRAT (for pre-release builds)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin and enable it.
2. Open **Settings → BRAT → Add Beta plugin**.
3. Paste this repository URL: `https://github.com/rolecall-games/rolecall-obsidian-sync` (or your fork).
4. Enable **RoleCall Sync** under **Settings → Community plugins**.

### Manually

1. Download `main.js` and `manifest.json` from the latest [release](https://github.com/rolecall-games/rolecall-obsidian-sync/releases).
2. Drop them into `<YourVault>/.obsidian/plugins/rolecall-sync/`.
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

## Configure

**Fastest path — Connect to RoleCall.** Open **Settings → RoleCall Sync** and click
**Connect** (or just hit the ribbon's push button with no token set). Your browser opens on
rolecall.games showing the same code as the plugin — sign in or create a free account right
there, pick the campaign this vault should publish to (or create one, prenamed after the
vault), and approve. The token lands in the plugin by itself; nothing to paste. Connecting
uploads nothing from your vault — the first push is its own explicit step.

Prefer to wire it by hand? Open **Settings → RoleCall Sync** and fill in:

| Field            | What goes here                                                              |
| ---------------- | --------------------------------------------------------------------------- |
| API base URL     | `https://rolecall.games` (default). Change only if you self-host RoleCall. |
| API token        | A personal token. See **How to generate a token** below.                    |
| Published folder | `Published` (default). Notes inside this folder are synced and shown to your players. |
| Also push my GM folder | Off (default). Turn on to sync your GM folder too — GMs only, see [the one rule](#the-one-rule-published-is-for-your-players-gm-is-for-you). Turning it off removes those notes from RoleCall on the next push. |
| GM folder        | `GM` (default). Only read when the switch above is on. Must not be inside the published folder. |

The token identifies which game receives the push — there's no separate Game ID setting. If you want to push to a different game, generate a token on that game's page and paste it here.

**Easiest path:** on your game's **Plugins** page, click **Download starter vault**. It gives you
a ready-made vault with the `GM/`+`Published/` folders and this plugin already configured (token
baked in) — just install the plugin and push.

### How to generate a token

1. Sign in to RoleCall and open the game this vault belongs to.
2. Go to the game's **Plugins** page.
3. Click **Generate token**, give it a name like `Obsidian`, and copy the token immediately — it's only shown once.
4. Paste it into the plugin's **API token** setting.

## Push

- Click the cloud-with-arrow ribbon icon, **or**
- Open the command palette (`Cmd/Ctrl+P`) and run **RoleCall Sync: Push notes to RoleCall**
  (named **Push published notes** before 0.3.0).

You'll see `Syncing published notes…` while it runs — or `Syncing published and GM notes…` when the
GM folder is on, so every push says what it is carrying — and a summary like
`Synced: 3 added, 1 updated` on success (or `Already up to date`). On failure, the notice explains
what went wrong (bad token, out-of-date plugin, network).

If the GM folder is switched on but can't be found (renamed, or a typo in the setting), the push
carries your published notes only and leaves the GM notes already on RoleCall untouched — a folder
the plugin can't find is never treated as "delete them all".

## Pull

Open the command palette and run **RoleCall Sync: Pull notes from RoleCall**.

A pull brings down every note, folder and image that is new or changed on RoleCall — notes you wrote
in the campaign's notes workspace, notes your players wrote, edits made there to notes that came
from this vault. Published notes land in your published folder; GM-only notes land in your GM
folder, **whether or not you push that folder** (pulling them sends nothing).

What it will and won't do to your files:

| Your copy | RoleCall's copy | A pull… |
| --------- | --------------- | ------- |
| doesn't exist | new | **adds** it |
| unchanged since the last sync | changed | **updates** it |
| changed | unchanged | leaves it — your next push sends it |
| changed | changed | **leaves it exactly as it is**, and asks you afterwards |
| deleted by you | still there | leaves it deleted — your next push tells RoleCall |
| still there | deleted or moved | leaves it — a pull never deletes or renames |

When something changed in both places, a dialog lists those notes after the pull with two buttons
each: **Keep mine** (your copy stands, and your next push makes it RoleCall's version too) or
**Use RoleCall's** (your copy is replaced). Anything you don't decide is asked about again next
time. Nothing is ever overwritten without that choice.

**Pulling needs permission to read your campaign's notes**, which tokens issued before pulling
existed (plugin 0.4.0) don't have — they could only push, on purpose. If a pull says the token can't pull, open
**Settings → RoleCall Sync** and click **Connect** once; that grants it. (If you paste tokens by
hand, tick the pull box when generating one on the **Plugins** page.)

The comparison is done on your device: RoleCall sends a list of what it holds, and nothing about
your local files — names or contents — is sent up to make it.

## Local development

```bash
git clone https://github.com/rolecall-games/rolecall-obsidian-sync
cd rolecall-obsidian-sync
npm install
npm run dev    # watch-build to main.js
```

To test against a real vault, symlink the plugin into a throwaway vault:

```bash
ln -s "$PWD" "/path/to/TestVault/.obsidian/plugins/rolecall-sync"
```

Install the [Hot Reload](https://github.com/pjeby/hot-reload) plugin in the test vault so changes to `main.js` reload automatically.

Production build, tests and lint:

```bash
npm run build
npm test       # the push-planning rules in src/plan.ts — no Obsidian runtime needed
npm run lint
```

## Releasing

0. **If the release raises `SYNC_VERSION` (`src/api.ts`), the RoleCall server must already be
   deployed with it.** A plugin that speaks a newer version than the server gets a `409` on every
   push until the server catches up, and updating the plugin again cannot fix it.
1. Bump `version` in `manifest.json` and add a matching entry in `versions.json` mapping the new version to the minimum supported Obsidian version.
2. Tag the release on GitHub with the exact version (no leading `v`), e.g. `0.1.1`.
3. Attach `manifest.json` and `main.js` as individual release assets.

## License

MIT © Framework and Fable LLC — see [LICENSE](LICENSE).
