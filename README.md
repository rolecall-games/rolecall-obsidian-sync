# Role Call Sync

An Obsidian community plugin that syncs your TTRPG campaign notes to a [Role Call](https://rolecall.games) game. Role Call renders them on your campaign site — wikilinks and frontmatter are parsed there.

> **Requires a free [Role Call](https://rolecall.games) account.** The plugin pushes notes to a game you run there, authenticated by a per-game API token from that game's **Vault Sync** page (see [Configure](#configure)).

## The one rule: `Published/` syncs, everything else stays private

This plugin uploads **only** the notes inside your `Published/` folder (configurable). Your `GM/`
notes — secrets, plans, spoilers — are never sent. The Role Call server also enforces this: it
rejects any path outside the published root, so GM content can't reach it even by accident.

> Don't rely on `%%comments%%` or `> [!secret]` callouts to hide things inside a published note —
> they are **not** hidden. If it shouldn't be seen, keep it in `GM/`.

## What it does

- Adds a **Push published notes** ribbon icon (cloud-with-arrow) and a command-palette action.
- On trigger, sends an **incremental** JSON batch of changed notes + embedded media to Role Call,
  and deletes notes you've removed. Unchanged files are skipped (it remembers the last sync).
- Markdown notes become pages; media in `Published/` becomes embeddable images.

## What it does *not* do (yet)

- No automatic / background sync. You push when you want.
- No pulling content **from** Role Call back into the vault. This is upload-only.
- No diff preview before pushing.

## Install

### Via BRAT (recommended while the plugin is in beta)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin and enable it.
2. Open **Settings → BRAT → Add Beta plugin**.
3. Paste this repository URL: `https://github.com/rolecall-games/rolecall-obsidian-sync` (or your fork).
4. Enable **Role Call Sync** under **Settings → Community plugins**.

### Manually

1. Download `main.js` and `manifest.json` from the latest [release](https://github.com/rolecall-games/rolecall-obsidian-sync/releases).
2. Drop them into `<YourVault>/.obsidian/plugins/rolecall-sync/`.
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

## Configure

Open **Settings → Role Call Sync** and fill in:

| Field            | What goes here                                                              |
| ---------------- | --------------------------------------------------------------------------- |
| API base URL     | `https://rolecall.games` (default). Change only if you self-host Role Call. |
| API token        | A personal token. See **How to generate a token** below.                    |
| Published folder | `Published` (default). Only notes inside this folder are synced.            |

The token identifies which game receives the push — there's no separate Game ID setting. If you want to push to a different game, generate a token on that game's page and paste it here.

**Easiest path:** on your game's **Vault Sync** page, click **Download starter vault**. It gives you
a ready-made vault with the `GM/`+`Published/` folders and this plugin already configured (token
baked in) — just install the plugin and push.

### How to generate a token

1. Sign in to Role Call and open the game this vault belongs to.
2. Go to the game's **Vault Sync** (Tokens) page.
3. Click **Generate token**, give it a name like `Obsidian`, and copy the token immediately — it's only shown once.
4. Paste it into the plugin's **API token** setting.

## Push

- Click the cloud-with-arrow ribbon icon, **or**
- Open the command palette (`Cmd/Ctrl+P`) and run **Role Call: Push published notes**.

You'll see `Syncing published notes…` while it runs and a summary like `Synced: 3 added, 1 updated`
on success (or `Already up to date`). On failure, the notice explains what went wrong (bad token,
out-of-date plugin, network).

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

Production build:

```bash
npm run build
```

## Releasing

1. Bump `version` in `manifest.json` and add a matching entry in `versions.json` mapping the new version to the minimum supported Obsidian version.
2. Tag the release on GitHub with the exact version (no leading `v`), e.g. `0.1.1`.
3. Attach `manifest.json` and `main.js` as individual release assets.

## License

MIT © Framework and Fable LLC — see [LICENSE](LICENSE).
