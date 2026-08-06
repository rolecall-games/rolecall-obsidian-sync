import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		rules: {
			// The sentence-case rule lowercases anything it doesn't recognise as
			// a brand, so it reads "Connect to RoleCall" as a sentence and asks
			// for "Connect to rolecall". Inline disables of obsidianmd/* rules
			// are blocked by eslint-comments/no-restricted-disable — and rightly
			// so — which makes `brands` the intended way to say "this is a name".
			//
			// NOTE: this REPLACES the plugin's DEFAULT_BRANDS rather than
			// extending it, so anything we might name in UI text has to be here.
			// Only the ones this plugin could plausibly mention are listed; add
			// to it rather than reaching into the plugin's internals for the
			// full default list.
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: [
						// The bare domain is a name too — without it the rule
						// sentence-cases link text into "RoleCall.games".
						"rolecall.games",
						"RoleCall",
						"RoleCall Sync",
						"Obsidian",
						"Obsidian Sync",
						"Obsidian Publish",
						"BRAT",
						"Markdown",
						"GitHub",
						"Discord",
						"iOS",
						"iPadOS",
						"macOS",
						"Windows",
						"Android",
						"Linux",
					],
				},
			],
		},
	},
	{
		// `PluginSettingTab.display()` is deprecated as of Obsidian 1.13.0 in
		// favour of getSettingDefinitions(), which this tab implements. It is
		// kept deliberately: manifest.json still declares minAppVersion 1.5.7,
		// and Obsidian's own typings say to implement display() "as a fallback
		// for plugins that need to support versions older than 1.13.0". 1.13+
		// never calls it. Drop this override — and the method — the day
		// minAppVersion moves to 1.13.0.
		files: ["src/settings.ts"],
		rules: { "@typescript-eslint/no-deprecated": "off" },
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.mts",
		"version-bump.mjs",
		"versions.json",
		"main.js",
	]),
);
