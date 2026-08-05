import { App, Notice, PluginSettingTab, Setting } from "obsidian";
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

export class RoleCallSettingTab extends PluginSettingTab {
	plugin: RoleCallSyncPlugin;

	constructor(app: App, plugin: RoleCallSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("API base URL")
			.setDesc("Server origin. Leave the default unless you self-host.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.apiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiBaseUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API token")
			.setDesc("Token from your game's vault sync page on rolecall.games. Identifies which campaign receives the notes.")
			.addText((text) => {
				text
					.setPlaceholder("Paste token")
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Published folder")
			.setDesc("Only notes inside this folder are synced. Everything else in the vault stays private.")
			.addText((text) =>
				text
					.setPlaceholder("Published")
					.setValue(this.plugin.settings.publishedFolder)
					.onChange(async (value) => {
						this.plugin.settings.publishedFolder = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Resync from scratch")
			.setDesc("Forget what was synced before and push the whole published folder on the next sync.")
			.addButton((btn) =>
				btn.setButtonText("Reset sync state").onClick(async () => {
					await this.plugin.resetSyncState();
					new Notice("Sync state reset — the next push sends everything");
				}),
			);
	}
}
