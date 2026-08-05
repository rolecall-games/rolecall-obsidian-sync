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

		/* eslint-disable obsidianmd/ui/sentence-case -- "Role Call" is the product name; lowercase URL placeholder is intentional */
		new Setting(containerEl)
			.setName("API base URL")
			.setDesc("Role Call server origin. Leave the default unless you self-host.")
			.addText((text) =>
				text
					.setPlaceholder("https://rolecall.games")
					.setValue(this.plugin.settings.apiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiBaseUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("API token")
			.setDesc("Token from your game's Vault Sync page in Role Call. Identifies which campaign receives the notes.")
			.addText((text) => {
				text
					.setPlaceholder("paste token")
					.setValue(this.plugin.settings.apiToken)
					.onChange(async (value) => {
						this.plugin.settings.apiToken = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Published folder")
			.setDesc("Only notes inside this folder are synced. Everything else (your GM/ notes) stays private.")
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
			.setDesc("Forget what was synced before and push the whole Published folder on the next sync.")
			.addButton((btn) =>
				btn.setButtonText("Reset sync state").onClick(async () => {
					await this.plugin.resetSyncState();
					new Notice("Sync state reset — the next push sends everything");
				}),
			);
		/* eslint-enable obsidianmd/ui/sentence-case */
	}
}
