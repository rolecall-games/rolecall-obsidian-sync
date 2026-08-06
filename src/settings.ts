import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { startConnectFlow } from "./connect";
import type RoleCallSyncPlugin from "./main";

export interface RoleCallSyncSettings {
	apiBaseUrl: string;
	apiToken: string;
	publishedFolder: string;
}

export const DEFAULT_SETTINGS: RoleCallSyncSettings = {
	apiBaseUrl: "https://rolecall.games",
	apiToken: "",
	publishedFolder: "Published",
};

// One row, described once. `getSettingDefinitions()` (Obsidian 1.13+) and the
// legacy `display()` both build from this list, so the two renderers cannot
// drift — which matters because 1.13 silently ignores display() and older
// builds never see the definitions, so a row added to one path alone would be
// invisible on half the installs and nobody would notice.
interface Row {
	name: string;
	desc: string | (() => DocumentFragment);
	build: (setting: Setting) => void;
}

export class RoleCallSettingTab extends PluginSettingTab {
	plugin: RoleCallSyncPlugin;

	constructor(app: App, plugin: RoleCallSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// Declarative definitions are what put these settings in Obsidian's
	// settings search on 1.13+. Every row is a `render` rather than a
	// `control`: a control binds through `setControlValue`, whose default
	// writes `plugin.settings` straight to disk — and this plugin's `data.json`
	// also carries `lastSyncedHashes` and `syncedTarget`, which that write
	// would drop. Losing them silently resets the incremental sync state, so
	// every row persists through the plugin's own `saveSettings()` instead.
	// `name`/`desc` are still declared here, which is all search needs.
	override getSettingDefinitions(): SettingDefinitionItem[] {
		return this.rows().map((row) => ({
			name: row.name,
			desc: typeof row.desc === "function" ? row.desc() : row.desc,
			render: (setting: Setting) => {
				row.build(setting);
			},
		}));
	}

	// Fallback for Obsidian older than 1.13.0 — `manifest.json` still declares
	// minAppVersion 1.5.7. On 1.13+ this is never called (a non-empty
	// getSettingDefinitions() takes over), so it must stay a thin loop over the
	// same rows rather than growing behaviour of its own.
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		for (const row of this.rows()) {
			const setting = new Setting(containerEl)
				.setName(row.name)
				.setDesc(typeof row.desc === "function" ? row.desc() : row.desc);
			row.build(setting);
		}
	}

	// `update()` re-renders a declarative tab and only exists on 1.13+; older
	// builds re-run display(). Checked at runtime, not by version string.
	private refresh(): void {
		const update = (this as { update?: () => void }).update;
		if (typeof update === "function") update.call(this);
		else this.display();
	}

	private rows(): Row[] {
		return [
			{
				name: "Connect to RoleCall",
				desc: "Link this vault to a campaign — sign in (or create a free account) in your browser and the token below is filled in for you. No copy-paste.",
				build: (setting) => {
					setting.addButton((btn) =>
						btn
							.setButtonText("Connect")
							.setCta()
							.onClick(() => {
								startConnectFlow(this.plugin, {
									onConnected: () => {
										this.refresh();
										void this.plugin.pushPublished();
									},
								});
							}),
					);
				},
			},
			{
				name: "API base URL",
				desc: "Server origin. Leave the default unless you self-host.",
				build: (setting) => {
					setting.addText((text) =>
						text
							.setValue(this.plugin.settings.apiBaseUrl)
							.onChange(async (value) => {
								this.plugin.settings.apiBaseUrl = value;
								await this.plugin.saveSettings();
							}),
					);
				},
			},
			{
				name: "API token",
				// A fragment rather than a string so the address is clickable — this
				// is the one place a GM has to go somewhere else to continue, and
				// the page name has already changed once ("Vault Sync" → "Plugins").
				desc: () =>
					createFragment((frag) => {
						frag.appendText(
							"Filled by Connect to RoleCall, or paste a token from your game's Plugins page on ",
						);
						frag.createEl("a", {
							text: "rolecall.games",
							href: "https://rolecall.games",
						});
						frag.appendText(". Identifies which campaign receives the notes.");
					}),
				build: (setting) => {
					setting.addText((text) => {
						text
							.setPlaceholder("Paste token")
							.setValue(this.plugin.settings.apiToken)
							.onChange(async (value) => {
								this.plugin.settings.apiToken = value;
								await this.plugin.saveSettings();
							});
						// Masked deliberately: the token is a bearer credential for the
						// whole campaign, and this pane gets screen-shared and
						// screenshotted in support threads.
						text.inputEl.type = "password";
					});
				},
			},
			{
				name: "Published folder",
				desc: "Only notes inside this folder are synced. Everything else in the vault stays private.",
				build: (setting) => {
					setting.addText((text) =>
						text
							.setPlaceholder("Published")
							.setValue(this.plugin.settings.publishedFolder)
							.onChange(async (value) => {
								this.plugin.settings.publishedFolder = value;
								await this.plugin.saveSettings();
							}),
					);
				},
			},
			{
				name: "Resync from scratch",
				desc: "Forget what was synced before and push the whole published folder on the next sync.",
				build: (setting) => {
					setting.addButton((btn) =>
						btn.setButtonText("Reset sync state").onClick(async () => {
							await this.plugin.resetSyncState();
							new Notice("Sync state reset — the next push sends everything");
						}),
					);
				},
			},
		];
	}
}
