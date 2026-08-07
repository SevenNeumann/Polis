import { App, ItemView, Plugin, WorkspaceLeaf, Notice, setIcon } from "obsidian";

export const VIEW_TYPE_POLIS = "polis-view";

/** Одно хранилище внутри группы */
export interface PolisVault {
	id: string;
	name: string;
	/** абсолютный путь к папке vault'а на диске */
	path: string;
	description?: string;
}

/** Группа (контекст), объединяющая несколько vault'ов */
export interface PolisGroup {
	id: string;
	name: string;
	description?: string;
	vaults: PolisVault[];
}

export interface PolisSettings {
	groups: PolisGroup[];
}

export const DEFAULT_SETTINGS: PolisSettings = {
	groups: [],
};

function makeId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export default class PolisPlugin extends Plugin {
	settings!: PolisSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_POLIS, (leaf) => new PolisView(leaf, this));

		this.addRibbonIcon("landmark", "Polis", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-polis-view",
			name: "Открыть Polis",
			callback: () => this.activateView(),
		});
	}

	onunload() {}

	async activateView() {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(VIEW_TYPE_POLIS);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			leaf = workspace.getLeftLeaf(false);
			await leaf?.setViewState({ type: VIEW_TYPE_POLIS, active: true });
		}

		if (leaf) workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// перерисовать все открытые view плагина
		this.app.workspace.getLeavesOfType(VIEW_TYPE_POLIS).forEach((leaf) => {
			if (leaf.view instanceof PolisView) leaf.view.render();
		});
	}

	addGroup(name: string) {
		this.settings.groups.push({ id: makeId(), name, vaults: [] });
		this.saveSettings();
	}

	addVaultToGroup(groupId: string, name: string, path: string) {
		const group = this.settings.groups.find((g) => g.id === groupId);
		if (!group) return;
		group.vaults.push({ id: makeId(), name, path });
		this.saveSettings();
	}

	removeGroup(groupId: string) {
		this.settings.groups = this.settings.groups.filter((g) => g.id !== groupId);
		this.saveSettings();
	}

	removeVault(groupId: string, vaultId: string) {
		const group = this.settings.groups.find((g) => g.id === groupId);
		if (!group) return;
		group.vaults = group.vaults.filter((v) => v.id !== vaultId);
		this.saveSettings();
	}

	/** Открыть vault по пути через стандартный URI-обработчик Obsidian */
	openVault(vault: PolisVault) {
		const uri = `obsidian://open?path=${encodeURIComponent(vault.path)}`;
		window.open(uri);
	}
}

class PolisView extends ItemView {
	plugin: PolisPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: PolisPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_POLIS;
	}

	getDisplayText() {
		return "Polis";
	}

	getIcon() {
		return "landmark";
	}

	async onOpen() {
		this.render();
	}

	async onClose() {}

	render() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("polis-view");

		const header = container.createDiv({ cls: "polis-header" });
		header.createEl("span", { text: "Контексты", cls: "polis-title" });
		const addGroupBtn = header.createEl("button", { cls: "polis-icon-btn" });
		setIcon(addGroupBtn, "plus");
		addGroupBtn.onclick = () => this.promptAddGroup();

		if (this.plugin.settings.groups.length === 0) {
			container.createDiv({
				cls: "polis-empty",
				text: "Пока нет групп. Нажми «+», чтобы создать первую.",
			});
			return;
		}

		for (const group of this.plugin.settings.groups) {
			const groupEl = container.createDiv({ cls: "polis-group" });

			const groupHeader = groupEl.createDiv({ cls: "polis-group-header" });
			groupHeader.createEl("span", { text: group.name, cls: "polis-group-name" });

			const groupActions = groupHeader.createDiv({ cls: "polis-group-actions" });

			const addVaultBtn = groupActions.createEl("button", { cls: "polis-icon-btn" });
			setIcon(addVaultBtn, "plus");
			addVaultBtn.setAttr("aria-label", "Добавить vault в группу");
			addVaultBtn.onclick = () => this.promptAddVault(group.id);

			const removeGroupBtn = groupActions.createEl("button", { cls: "polis-icon-btn" });
			setIcon(removeGroupBtn, "trash-2");
			removeGroupBtn.setAttr("aria-label", "Удалить группу");
			removeGroupBtn.onclick = () => this.plugin.removeGroup(group.id);

			if (group.description) {
				groupEl.createDiv({ cls: "polis-group-desc", text: group.description });
			}

			const vaultList = groupEl.createDiv({ cls: "polis-vault-list" });
			for (const vault of group.vaults) {
				const vaultEl = vaultList.createDiv({ cls: "polis-vault" });

				const vaultIcon = vaultEl.createSpan({ cls: "polis-vault-icon" });
				setIcon(vaultIcon, "vault");

				const vaultInfo = vaultEl.createDiv({ cls: "polis-vault-info" });
				vaultInfo.createEl("span", { text: vault.name, cls: "polis-vault-name" });
				if (vault.description) {
					vaultInfo.createEl("span", {
						text: vault.description,
						cls: "polis-vault-desc",
					});
				}

				vaultEl.onclick = (e) => {
					if ((e.target as HTMLElement).closest(".polis-icon-btn")) return;
					this.plugin.openVault(vault);
				};

				const removeVaultBtn = vaultEl.createEl("button", { cls: "polis-icon-btn" });
				setIcon(removeVaultBtn, "x");
				removeVaultBtn.setAttr("aria-label", "Убрать vault из группы");
				removeVaultBtn.onclick = () => this.plugin.removeVault(group.id, vault.id);
			}
		}
	}

	promptAddGroup() {
		const name = window.prompt("Название группы (контекста):");
		if (!name) return;
		this.plugin.addGroup(name.trim());
	}

	promptAddVault(groupId: string) {
		const name = window.prompt("Название vault'а (для отображения):");
		if (!name) return;
		const path = window.prompt("Путь к папке vault'а на диске:");
		if (!path) {
			new Notice("Нужен путь к vault'у");
			return;
		}
		this.plugin.addVaultToGroup(groupId, name.trim(), path.trim());
	}
}
