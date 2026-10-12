import { Menu, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { shell } from "electron";
import { normalize } from "path";
import { spawn } from "child_process";

interface AppPair {
        name: string;
        code: string;
        arguments: string;
        showInMenu: boolean;
}
interface OpenWithSettings {
        apps: AppPair[];
        sysexpInFileMenu: boolean;
}

const DEFAULT_SETTINGS: OpenWithSettings = {
        apps: [],
        sysexpInFileMenu: false,
}

export default class OpenWithPlugin extends Plugin {
        settings: OpenWithSettings;

        async onload() {
                console.log('loading plugin');

                await this.loadSettings();

                this.addSettingTab(new OpenWithSettingTab(this));

                this.addCommand({
                        id: "copy-absolute-file-path",
                        name: "Copy absolute Path of File to clipboard",
                        checkCallback: (checking: boolean) => {
                                let file = this.app.workspace.getActiveFile()
                                if (file) {
                                        if (!checking) {
                                                navigator.clipboard.writeText(this.getAbsolutePathOfFile(file));
                                        }
                                        return true;
                                }
                                return false;
                        }
                });

                this.addCommand({
                        id: 'show-file-in-explorer',
                        name: 'Show File in system explorer',
                        checkCallback: (checking: boolean) => {
                                let file = this.app.workspace.getActiveFile();
                                if (file) {
                                        if (!checking) {
                                                shell.showItemInFolder(this.getAbsolutePathOfFile(file));
                                        }
                                        return true;
                                }
                                return false;
                        }
                })

                this.settings.apps.forEach(app => {
                        this.addCommand({
                                id: this.commandIdFor(app.name),
                                name: "Open File with " + app.name,
                                checkCallback: (checking: boolean) => {
                                        let file = this.app.workspace.getActiveFile();
                                        if (file) {
                                                if (!checking) {
                                                        this.launchExternalApp(app, this.getAbsolutePathOfFile(file));
                                                }
                                                return true;
                                        }
                                        return false;
                                }
                        });
                });

                this.registerEvent(
                        this.app.workspace.on("file-menu", this.fileMenuHandlerCreateNew),
                );
        }

        fileMenuHandlerCreateNew = (menu: Menu, file: TFile) => {
                this.settings.apps.forEach(app => {
                        if (app.showInMenu) {
                                menu.addItem(item => {
                                        item
                                                .setTitle(`Open with ${app.name}`)
                                                .setIcon('popup-open')
                                                .onClick(() => this.launchExternalApp(app, this.getAbsolutePathOfFile(file)));
                                });
                        }
                });
                if(this.settings.sysexpInFileMenu) {
                        menu.addItem(item => {
                                item
                                        .setTitle('Show in system explorer')
                                        .setIcon('popup-open')
                                        .onClick(() => shell.showItemInFolder(this.getAbsolutePathOfFile(file)));
                        });
                }
        };

        /**
         * Obsidian 1.14.4+ can open Markdown files from outside the vault.
         * Those files are exposed as TExternalFile, whose `path` is virtual,
         * while `getRealPath()` returns the actual filesystem path.
         * Feature-detect so the plugin keeps working on older Obsidian versions.
         */
        isExternalFile(file: TFile): boolean {
                return typeof (file as any).getRealPath === "function";
        }

        getAbsolutePathOfFile(file: TFile): string {
                if (this.isExternalFile(file)) {
                        return (file as any).getRealPath();
                }
                //@ts-ignore
                const path = normalize(`${this.app.vault.adapter.basePath}/${file.path}`);
                if (Platform.isDesktopApp && navigator.platform === "Win32") {
                        return path.replace(/\//g, "\\");
                }
                return path;
        }

        commandIdFor(appName: string): string {
                // Command IDs must not contain spaces (hotkey settings & executeCommandById).
                return "open-file-with-" + appName.toLowerCase().replace(/\s+/g, "-");
        }

        /**
         * Launches the configured application with the given file.
         * Replaces the `open` npm package, whose Windows implementation
         * (powershell -EncodedCommand) broke on Obsidian 1.14.4's Electron 43.
         * - win32: `cmd /c start "" <app> <target> [args...]` resolves the app
         *   via PATH and the App Paths registry.
         * - darwin: `open -a <app> <target> [--args ...]` (same as `open` pkg).
         * - other: spawns the app binary directly (same as `open` pkg).
         * Errors are surfaced as Notices instead of failing silently.
         */
        launchExternalApp(app: AppPair, target: string): void {
                const extraArgs = app.arguments
                        .split(",")
                        .map(arg => arg.trim())
                        .filter(arg => arg.length > 0);

                let child: any;
                try {
                        if (Platform.isDesktopApp && navigator.platform === "Win32") {
                                child = spawn("cmd.exe", ["/c", "start", "", app.code, target, ...extraArgs], {
                                        detached: true,
                                        stdio: "ignore",
                                });
                        } else if (Platform.isDesktopApp && navigator.platform === "MacIntel") {
                                child = spawn("open", ["-a", app.code, target, ...(extraArgs.length > 0 ? ["--args", ...extraArgs] : [])], {
                                        detached: true,
                                        stdio: "ignore",
                                });
                        } else {
                                child = spawn(app.code, [...extraArgs, target], {
                                        detached: true,
                                        stdio: "ignore",
                                });
                        }
                } catch (e) {
                        new Notice(`Open with: unable to launch "${app.code}" - ${e}`);
                        return;
                }
                child.on("error", (err: Error) => {
                        new Notice(`Open with: unable to launch "${app.code}" - ${err.message}`);
                });
                child.on("close", (code: number | null) => {
                        if (code !== 0 && code !== null) {
                                new Notice(`Open with: "${app.code}" exited with code ${code}. Check the command in the plugin settings.`);
                        }
                });
                child.unref();
        }

        async loadSettings() {
                this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        }

        async saveSettings() {
                await this.saveData(this.settings);
        }
}
class OpenWithSettingTab extends PluginSettingTab {
        plugin: OpenWithPlugin;

        constructor(plugin: OpenWithPlugin) {
                super(plugin.app, plugin);
                this.plugin = plugin;
        }

        display(): void {
                let { containerEl } = this;

                containerEl.empty();
                containerEl.addClass('OW-settings-page')

                containerEl.createEl('h2', { text: 'Open with Plugin' });

                // Keep direct references to the inputs instead of querying the
                // global document: the settings UI has lived in its own window
                // since Obsidian 1.13, and `document` refers to the main window.
                let nameInput: HTMLInputElement;
                let codeInput: HTMLInputElement;
                let argsInput: HTMLInputElement;

                new Setting(containerEl)
                        .setName("Add new application")
                        .setClass("OW-setting-item")
                        .setDesc("Add a new application to open files with. You need to use the application path or command (for example \"code\" for VSCode) and arguments need to be comma seperated.")
                        .addText(cb => {
                                nameInput = cb.inputEl;
                                cb.inputEl.addClass("OW-name");
                                cb.setPlaceholder("Display Name");
                        })
                        .addText(cb => {
                                codeInput = cb.inputEl;
                                cb.inputEl.addClass("OW-code");
                                cb.setPlaceholder("Path/Command");
                        })
                        .addText(cb => {
                                argsInput = cb.inputEl;
                                cb.inputEl.addClass("OW-args");
                                cb.setPlaceholder("Arguments (optional)");
                        })
                        .addButton(btn => {
                                btn.setButtonText("+")
                                        .onClick(async () => {
                                                const name = nameInput.value;
                                                const code = codeInput.value;
                                                const args = argsInput.value;
                                                if (name && code) {
                                                        this.plugin.addCommand({
                                                                id: this.plugin.commandIdFor(name),
                                                                name: "Open File with " + name,
                                                                checkCallback: (checking: boolean) => {
                                                                        let file = this.plugin.app.workspace.getActiveFile();
                                                                        if (file) {
                                                                                if (!checking) {
                                                                                        this.plugin.launchExternalApp({ name, code, arguments: args, showInMenu: false }, this.plugin.getAbsolutePathOfFile(file));
                                                                                }
                                                                                return true;
                                                                        }
                                                                        return false;
                                                                }
                                                        });
                                                        this.plugin.settings.apps.push({ name, code, arguments: args, showInMenu: false });
                                                        await this.plugin.saveSettings();
                                                        this.display();
                                                } else {
                                                        new Notice("Display Name & Path/Command are always neccessary.");
                                                }
                                        });
                        });

                this.plugin.settings.apps.forEach(app => {
                        new Setting(containerEl)
                                .setName(app.name)
                                .setDesc(`Command: ${app.code}${app.arguments ? ` | Arguments: ${app.arguments}` : ""}`)
                                .addToggle(cb => {
                                        cb.toggleEl.parentElement.prepend('Show in File-Menu ');
                                        cb.setValue(app.showInMenu).onChange(async (value) => {
                                                app.showInMenu = value;
                                                await this.plugin.saveSettings();
                                        })
                                })
                                .addButton(btn => {
                                        btn.setIcon("trash")
                                                .setTooltip("Remove")
                                                .onClick(async () => {
                                                        new Notice("You need to restart Obsidian for these changes to take effect.");
                                                        this.plugin.settings.apps.remove(app);
                                                        await this.plugin.saveSettings();
                                                        this.display();
                                                });
                                });
                });
                new Setting(containerEl)
                                .setName('Show "Show in system explorer" in File-Menu')
                                .setDesc('Show the enhanced "Show in system explorer" command in File-Menus')
                                .addToggle(cb => {
                                        cb.setValue(this.plugin.settings.sysexpInFileMenu).onChange(async (value) => {
                                                this.plugin.settings.sysexpInFileMenu = value;
                                                await this.plugin.saveSettings();
                                        })
                                });
        }
}
