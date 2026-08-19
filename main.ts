import {
	App,
	ItemView,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	setTooltip,
	WorkspaceLeaf,
} from "obsidian";
import Sortable from "sortablejs";
import { PolisLanguageSetting, setActiveLocale, t } from "./i18n";

export const VIEW_TYPE_POLIS = "polis-view";

/** Icons offered in the picker grid (curated lucide subset) */
const CURATED_ICONS = [
	"scan", "vault", "folder", "folder-open", "archive", "book-open",
	"briefcase", "flask-conical", "target", "palette", "code", "pen-tool",
	"music", "heart", "star", "globe", "graduation-cap", "dumbbell",
	"plane", "home", "users", "lightbulb", "rocket", "camera",
	"coffee", "gamepad-2", "wrench", "shield", "compass", "map",
];

const DEFAULT_GROUP_ICON = "scan";

/** A vault within a group */
export interface PolisVault {
	id: string;
	/** display name shown in the Polis panel */
	name: string;
	/**
	 * Absolute path to the vault folder on disk. Used to open the vault via
	 * `obsidian://open?path=...`. Not available/meaningful on mobile, where
	 * plugins have no access to a filesystem path for vaults.
	 */
	path?: string;
	/**
	 * The vault's name as registered in Obsidian itself. Used to open the
	 * vault via `obsidian://open?vault=...`, which works on every platform
	 * (including mobile) as long as the vault has been opened on this
	 * device before — Obsidian resolves the name locally, no path needed.
	 */
	obsidianVaultName?: string;
	/** optional free-form note on what this vault is for — shown as a hover tooltip on desktop */
	description?: string;
}

/** A group (context) that bundles together several vaults */
export interface PolisGroup {
	id: string;
	name: string;
	description?: string;
	icon?: string;
	color?: string;
	collapsed?: boolean;
	vaults: PolisVault[];
	/**
	 * Nested subgroups — exactly one level deep. A subgroup has the exact
	 * same shape as a top-level group (icon, color, description, vaults),
	 * but its own `subgroups` array is intentionally left empty and unused:
	 * Polis only supports a single level of nesting.
	 */
	subgroups: PolisGroup[];
}

export type PolisInfoVisibility = "groups" | "global" | "both";

export interface PolisSettings {
	groups: PolisGroup[];
	language: PolisLanguageSetting;
	/** free-form description of the whole vault structure, edited from the settings tab */
	globalDescription: string;
	/** controls which "i" (info) buttons are shown: per-group only, the global one only, or both */
	infoVisibility: PolisInfoVisibility;
	/** id of the group last used in "Add vault", pre-selected next time the modal opens */
	lastUsedGroupId: string | null;
	/** desktop-only: show a hover tooltip with a vault's description (when it has one) */
	vaultTooltipsEnabled: boolean;
}

export const DEFAULT_SETTINGS: PolisSettings = {
	groups: [],
	language: "auto",
	globalDescription: "",
	infoVisibility: "groups",
	lastUsedGroupId: null,
	vaultTooltipsEnabled: true,
};

function makeId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * Ensures a group loaded from disk (possibly saved by an older version of
 * Polis, before subgroups existed) always has a well-formed `subgroups`
 * array. Subgroups are only one level deep, so nested groups' own
 * `subgroups` are normalized but not expected to be populated.
 */
function migrateGroup(group: PolisGroup): PolisGroup {
	return {
		...group,
		subgroups: (group.subgroups ?? []).map((sg) => ({ ...sg, subgroups: sg.subgroups ?? [] })),
	};
}

/**
 * Flattens top-level groups and their subgroups into a single list suitable
 * for a dropdown, each entry carrying enough info to render it distinctly
 * (subgroups are indented and labeled with their parent's name).
 */
interface GroupOption {
	group: PolisGroup;
	isSubgroup: boolean;
	parentName?: string;
}

function flattenGroupsForPicker(topLevelGroups: PolisGroup[]): GroupOption[] {
	const options: GroupOption[] = [];
	for (const group of topLevelGroups) {
		options.push({ group, isSubgroup: false });
		for (const subgroup of group.subgroups) {
			options.push({ group: subgroup, isSubgroup: true, parentName: group.name });
		}
	}
	return options;
}

/** A vault known to Obsidian itself (from its global config) */
interface KnownVault {
	path: string;
	name: string;
}

/**
 * Node.js's fs/os/path modules don't exist on mobile Obsidian at all. We
 * intentionally avoid a static `import ... from "fs"` (which would pull the
 * module into the bundle unconditionally) and instead require it lazily,
 * only on desktop, so the plugin loads cleanly on iOS/Android.
 */
function getNodeModules(): { fs: typeof import("fs"); os: typeof import("os"); path: typeof import("path") } | null {
	if (!Platform.isDesktopApp) return null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return {
			fs: require("fs"),
			os: require("os"),
			path: require("path"),
		};
	} catch {
		return null;
	}
}

function getObsidianConfigPath(): string | null {
	const node = getNodeModules();
	if (!node) return null;

	const home = node.os.homedir();
	switch (process.platform) {
		case "win32": {
			const appData = process.env.APPDATA;
			return appData ? node.path.join(appData, "obsidian", "obsidian.json") : null;
		}
		case "darwin":
			return node.path.join(home, "Library", "Application Support", "obsidian", "obsidian.json");
		default:
			return node.path.join(home, ".config", "obsidian", "obsidian.json");
	}
}

/**
 * Lists vaults Obsidian already knows about, for the "pick an existing vault"
 * dropdown when adding a vault. Desktop-only: mobile Obsidian has no such
 * global vault registry on disk, so this simply returns an empty list there
 * and the "add manually" path is used instead.
 */
function getKnownVaults(): KnownVault[] {
	const node = getNodeModules();
	if (!node) return [];

	try {
		const configPath = getObsidianConfigPath();
		if (!configPath || !node.fs.existsSync(configPath)) return [];

		const raw = node.fs.readFileSync(configPath, "utf-8");
		const data = JSON.parse(raw) as { vaults?: Record<string, { path?: string }> };
		const entries = Object.values(data.vaults ?? {});

		return entries
			.map((v) => v.path)
			.filter((p): p is string => !!p && node.fs.existsSync(p))
			.map((p) => ({ path: p, name: node.path.basename(p) }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch (e) {
		console.error("Polis: failed to read obsidian.json", e);
		return [];
	}
}

export default class PolisPlugin extends Plugin {
	settings!: PolisSettings;

	async onload() {
		await this.loadSettings();
		setActiveLocale(this.settings.language);

		this.registerView(VIEW_TYPE_POLIS, (leaf) => new PolisView(leaf, this));
		this.addSettingTab(new PolisSettingTab(this.app, this));

		this.addRibbonIcon("landmark", "Polis", () => this.activateView());
		this.addCommand({
			id: "open-polis-view",
			name: t("command.openPolis"),
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
		const loaded = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		loaded.groups = (loaded.groups ?? []).map(migrateGroup);
		this.settings = loaded;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.app.workspace.getLeavesOfType(VIEW_TYPE_POLIS).forEach((leaf) => {
			if (leaf.view instanceof PolisView) leaf.view.render();
		});
	}

	// ---- groups ----

	/**
	 * Finds a group by id anywhere in the (at most one level deep) hierarchy.
	 * Returns both the group and the array it currently lives in (either
	 * `settings.groups` or some parent's `subgroups`), so callers can splice
	 * it out, reorder it, etc. without needing to know which level it's on.
	 */
	private findGroup(groupId: string): { group: PolisGroup; siblings: PolisGroup[] } | null {
		const topIndex = this.settings.groups.findIndex((g) => g.id === groupId);
		if (topIndex !== -1) {
			return { group: this.settings.groups[topIndex], siblings: this.settings.groups };
		}
		for (const parent of this.settings.groups) {
			const subIndex = parent.subgroups.findIndex((g) => g.id === groupId);
			if (subIndex !== -1) {
				return { group: parent.subgroups[subIndex], siblings: parent.subgroups };
			}
		}
		return null;
	}

	addGroup(
		name: string,
		description?: string,
		icon?: string,
		color?: string,
		parentGroupId?: string
	) {
		const newGroup: PolisGroup = {
			id: makeId(),
			name,
			description: description || undefined,
			icon: icon || DEFAULT_GROUP_ICON,
			color: color || undefined,
			collapsed: false,
			vaults: [],
			subgroups: [],
		};

		if (parentGroupId) {
			const parent = this.settings.groups.find((g) => g.id === parentGroupId);
			if (parent) {
				parent.subgroups.push(newGroup);
				this.saveSettings();
				return;
			}
		}

		this.settings.groups.push(newGroup);
		this.saveSettings();
	}

	updateGroup(groupId: string, patch: Partial<Omit<PolisGroup, "id" | "vaults" | "subgroups">>) {
		const found = this.findGroup(groupId);
		if (!found) return;
		Object.assign(found.group, patch);
		this.saveSettings();
	}

	/**
	 * Like updateGroup, but also handles moving the group to a different
	 * parent (or promoting/demoting between top-level and subgroup) when
	 * `newParentGroupId` differs from where the group currently lives.
	 * `newParentGroupId` is `null` for "make this a top-level group".
	 */
	updateGroupWithParent(
		groupId: string,
		patch: Partial<Omit<PolisGroup, "id" | "vaults" | "subgroups">>,
		newParentGroupId: string | null
	) {
		const found = this.findGroup(groupId);
		if (!found) return;
		Object.assign(found.group, patch);

		const currentlyTopLevel = found.siblings === this.settings.groups;

		// simplest correct check: compare current parent id to the requested one
		const currentParentId = currentlyTopLevel
			? null
			: this.settings.groups.find((g) => g.subgroups.includes(found.group))?.id ?? null;

		if (currentParentId === newParentGroupId) {
			this.saveSettings();
			return;
		}

		found.siblings.splice(found.siblings.indexOf(found.group), 1);

		if (newParentGroupId) {
			const parent = this.settings.groups.find((g) => g.id === newParentGroupId);
			if (parent) {
				parent.subgroups.push(found.group);
			} else {
				// parent vanished somehow — fall back to top-level rather than dropping the group
				this.settings.groups.push(found.group);
			}
		} else {
			this.settings.groups.push(found.group);
		}

		this.saveSettings();
	}

	removeGroup(groupId: string) {
		const found = this.findGroup(groupId);
		if (!found) return;
		found.siblings.splice(found.siblings.indexOf(found.group), 1);
		this.saveSettings();
	}

	/**
	 * Deletes a group that has content (vaults and/or subgroups), applying
	 * one of three strategies:
	 * - "delete-all": remove the group and everything inside it
	 * - "move-to": move the group's vaults and subgroups into another group
	 *   (targetGroupId required), then remove the now-empty group
	 * - "promote": only valid for a subgroup — its vaults and subgroups are
	 *   lifted up into the parent group, then the now-empty subgroup is removed
	 */
	deleteGroupWithStrategy(
		groupId: string,
		strategy: "delete-all" | "move-to" | "promote",
		targetGroupId?: string
	) {
		const found = this.findGroup(groupId);
		if (!found) return;
		const group = found.group;

		if (strategy === "delete-all") {
			this.removeGroup(groupId);
			return;
		}

		if (strategy === "move-to" && targetGroupId) {
			const targetFound = this.findGroup(targetGroupId);
			if (!targetFound) return;
			targetFound.group.vaults.push(...group.vaults);
			// subgroups can only be moved into a top-level target, since nesting
			// is one level deep — the caller (DeleteGroupModal) only offers
			// valid targets, but this is a defensive no-op if that's ever violated
			if (this.settings.groups.includes(targetFound.group)) {
				targetFound.group.subgroups.push(...group.subgroups);
			}
			this.removeGroup(groupId);
			return;
		}

		if (strategy === "promote") {
			const parent = this.settings.groups.find((g) => g.subgroups.includes(group));
			if (!parent) return;
			parent.vaults.push(...group.vaults);
			// promoting a subgroup's own subgroups would create a second level of
			// nesting under the parent, which isn't supported — but a subgroup's
			// subgroups array is always empty by construction, so there's nothing
			// to lift here in practice
			this.removeGroup(groupId);
			return;
		}
	}

	toggleGroupCollapsed(groupId: string) {
		const found = this.findGroup(groupId);
		if (!found) return;
		found.group.collapsed = !found.group.collapsed;
		this.saveSettings();
	}

	/** Move a top-level group to position newIndex among other top-level groups */
	moveGroup(groupId: string, newIndex: number) {
		const groups = this.settings.groups;
		const fromIndex = groups.findIndex((g) => g.id === groupId);
		if (fromIndex === -1) return;
		const [item] = groups.splice(fromIndex, 1);
		const clamped = Math.max(0, Math.min(newIndex, groups.length));
		groups.splice(clamped, 0, item);
		this.saveSettings();
	}

	/**
	 * Move a subgroup to position newIndex — within the same parent or into
	 * a different parent group. Subgroups can't be nested further, so both
	 * `fromParentId` and `toParentId` must refer to top-level groups.
	 */
	moveSubgroup(subgroupId: string, fromParentId: string, toParentId: string, newIndex: number) {
		const fromParent = this.settings.groups.find((g) => g.id === fromParentId);
		const toParent = this.settings.groups.find((g) => g.id === toParentId);
		if (!fromParent || !toParent) return;

		const idx = fromParent.subgroups.findIndex((g) => g.id === subgroupId);
		if (idx === -1) return;
		const [item] = fromParent.subgroups.splice(idx, 1);

		const clamped = Math.max(0, Math.min(newIndex, toParent.subgroups.length));
		toParent.subgroups.splice(clamped, 0, item);
		this.saveSettings();
	}

	// ---- vaults ----

	addVault(
		groupId: string,
		name: string,
		location: { path?: string; obsidianVaultName?: string; description?: string }
	) {
		const found = this.findGroup(groupId);
		if (!found) return;
		found.group.vaults.push({ id: makeId(), name, ...location });
		this.saveSettings();
	}

	updateVault(groupId: string, vaultId: string, patch: Partial<Omit<PolisVault, "id">>) {
		const found = this.findGroup(groupId);
		const vault = found?.group.vaults.find((v) => v.id === vaultId);
		if (!vault) return;
		Object.assign(vault, patch);
		this.saveSettings();
	}

	removeVault(groupId: string, vaultId: string) {
		const found = this.findGroup(groupId);
		if (!found) return;
		found.group.vaults = found.group.vaults.filter((v) => v.id !== vaultId);
		this.saveSettings();
	}

	/** Move a vault to position newIndex — within the same group or into another one (including across the nesting level) */
	moveVault(vaultId: string, fromGroupId: string, toGroupId: string, newIndex: number) {
		const fromFound = this.findGroup(fromGroupId);
		const toFound = this.findGroup(toGroupId);
		if (!fromFound || !toFound) return;

		const idx = fromFound.group.vaults.findIndex((v) => v.id === vaultId);
		if (idx === -1) return;
		const [item] = fromFound.group.vaults.splice(idx, 1);

		const clamped = Math.max(0, Math.min(newIndex, toFound.group.vaults.length));
		toFound.group.vaults.splice(clamped, 0, item);
		this.saveSettings();
	}

	openVault(vault: PolisVault) {
		let uri: string;
		if (vault.obsidianVaultName) {
			uri = `obsidian://open?vault=${encodeURIComponent(vault.obsidianVaultName)}`;
		} else if (vault.path) {
			uri = `obsidian://open?path=${encodeURIComponent(vault.path)}`;
		} else {
			new Notice(t("vault.noOpenTarget"));
			return;
		}
		window.open(uri);
	}

	// ---- language ----

	async setLanguage(language: PolisLanguageSetting) {
		this.settings.language = language;
		setActiveLocale(language);
		await this.saveSettings();
		// full re-render is needed since a language switch changes strings
		// everywhere, not just data — saveSettings() already re-renders open views
	}

	// ---- description settings ----

	async setGlobalDescription(description: string) {
		this.settings.globalDescription = description;
		await this.saveSettings();
	}

	async setInfoVisibility(visibility: PolisInfoVisibility) {
		this.settings.infoVisibility = visibility;
		await this.saveSettings();
	}

	/**
	 * Applies a batch of settings-tab fields at once — used by the Save
	 * button in PolisSettingTab, so language/description/visibility/hover
	 * changes take effect together rather than one saveData() call each.
	 */
	async applySettingsPatch(patch: {
		language: PolisLanguageSetting;
		globalDescription: string;
		infoVisibility: PolisInfoVisibility;
		vaultTooltipsEnabled: boolean;
	}) {
		this.settings.language = patch.language;
		this.settings.globalDescription = patch.globalDescription;
		this.settings.infoVisibility = patch.infoVisibility;
		this.settings.vaultTooltipsEnabled = patch.vaultTooltipsEnabled;
		setActiveLocale(patch.language);
		await this.saveSettings();
	}

	/** Remembers the group last used in "Add vault", so it's pre-selected next time */
	async setLastUsedGroup(groupId: string) {
		this.settings.lastUsedGroupId = groupId;
		await this.saveData(this.settings);
		// intentionally skip saveSettings()'s full view re-render here — this is
		// a silent preference, not a data change the open panel needs to reflect
	}

	// ---- import / export ----

	/**
	 * Serializes all groups (and their nested vaults) into a portable JSON
	 * payload. When `includeSettings` is true, also includes language,
	 * global description, info visibility, and the vault-tooltip preference —
	 * off by default, since settings are usually local to one Obsidian
	 * installation and not something you'd want silently overwritten by
	 * importing someone else's (or your own other device's) export.
	 */
	exportData(includeSettings = false): string {
		const payload: {
			polisExportVersion: number;
			exportedAt: string;
			groups: PolisGroup[];
			settings?: Pick<PolisSettings, "language" | "globalDescription" | "infoVisibility" | "vaultTooltipsEnabled">;
		} = {
			polisExportVersion: 1,
			exportedAt: new Date().toISOString(),
			groups: this.settings.groups,
		};

		if (includeSettings) {
			payload.settings = {
				language: this.settings.language,
				globalDescription: this.settings.globalDescription,
				infoVisibility: this.settings.infoVisibility,
				vaultTooltipsEnabled: this.settings.vaultTooltipsEnabled,
			};
		}

		return JSON.stringify(payload, null, 2);
	}

	/** Applies the optional `settings` block from an imported export, if present */
	async importSettingsFields(fields: Partial<PolisSettings>) {
		if (fields.language !== undefined) {
			this.settings.language = fields.language;
			setActiveLocale(fields.language);
		}
		if (fields.globalDescription !== undefined) this.settings.globalDescription = fields.globalDescription;
		if (fields.infoVisibility !== undefined) this.settings.infoVisibility = fields.infoVisibility;
		if (fields.vaultTooltipsEnabled !== undefined) this.settings.vaultTooltipsEnabled = fields.vaultTooltipsEnabled;
		await this.saveSettings();
	}

	/**
	 * Merges an imported list of groups into current settings using one of
	 * three strategies. Matching is done by group id, since ids are stable
	 * identifiers generated once per group and preserved across export/import.
	 */
	importGroups(
		importedRaw: PolisGroup[],
		strategy: "replace" | "merge-overwrite" | "merge-keep"
	): { added: number; overwritten: number; skipped: number } {
		const imported = importedRaw.map(migrateGroup);

		if (strategy === "replace") {
			this.settings.groups = imported;
			this.saveSettings();
			return { added: imported.length, overwritten: 0, skipped: 0 };
		}

		let added = 0;
		let overwritten = 0;
		let skipped = 0;

		for (const incoming of imported) {
			const existingIndex = this.settings.groups.findIndex((g) => g.id === incoming.id);
			if (existingIndex === -1) {
				this.settings.groups.push(incoming);
				added++;
			} else if (strategy === "merge-overwrite") {
				this.settings.groups[existingIndex] = incoming;
				overwritten++;
			} else {
				skipped++;
			}
		}

		this.saveSettings();
		return { added, overwritten, skipped };
	}
}

class PolisView extends ItemView {
	plugin: PolisPlugin;
	private editMode = false;

	private dimPieces: HTMLElement[] = [];
	private resizeHandler = () => this.updateDimFrame();
	private sortableInstances: Sortable[] = [];

	/**
	 * ids of vaults whose on-disk path couldn't be found during the last
	 * check. This is a transient runtime cache, not persisted to data.json —
	 * a vault that's temporarily unavailable (e.g. an unmounted drive)
	 * shouldn't be permanently flagged in saved data.
	 */
	private missingVaultIds = new Set<string>();

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
		this.checkVaultAvailability();
		this.render();
	}

	/**
	 * Checks which vaults' on-disk paths no longer exist, so they can be
	 * flagged in the UI. Desktop-only: only vaults that have a `path` are
	 * checkable this way — vaults opened by Obsidian vault name have no
	 * local filesystem path to check, and mobile has no fs access at all.
	 */
	private checkVaultAvailability() {
		this.missingVaultIds.clear();
		if (!Platform.isDesktopApp) return;

		const node = getNodeModules();
		if (!node) return;

		const allVaults: PolisVault[] = [];
		for (const group of this.plugin.settings.groups) {
			allVaults.push(...group.vaults);
			for (const subgroup of group.subgroups) {
				allVaults.push(...subgroup.vaults);
			}
		}

		for (const vault of allVaults) {
			if (vault.path && !node.fs.existsSync(vault.path)) {
				this.missingVaultIds.add(vault.id);
			}
		}
	}
	render() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("polis-view");
		container.toggleClass("polis-edit-mode", this.editMode);

		this.destroySortables();
		this.setGlobalDimming(this.editMode);

		this.renderHeader(container);

		const groups = this.plugin.settings.groups;
		if (groups.length === 0) {
			container.createDiv({
				cls: "polis-empty",
				text: t("empty.noGroups"),
			});
			return;
		}

		const groupsContainer = container.createDiv({ cls: "polis-groups-container" });
		for (const group of groups) {
			this.renderGroup(groupsContainer, group);
		}

		if (this.editMode) {
			this.setupGroupSortable(groupsContainer);
		}
	}

	/**
	 * Dims the rest of Obsidian around the Polis panel without covering the
	 * panel itself. Instead of a single full-screen layer (which runs into
	 * z-index conflicts with Obsidian's own stacking contexts), this uses
	 * 4 separate rectangles — top/bottom/left/right of the panel's real
	 * coordinates. That way the panel is never physically under the overlay.
	 */
	private setGlobalDimming(active: boolean) {
		if (!active) {
			this.dimPieces.forEach((el) => el.remove());
			this.dimPieces = [];
			window.removeEventListener("resize", this.resizeHandler);
			return;
		}

		if (this.dimPieces.length === 0) {
			for (let i = 0; i < 4; i++) {
				const piece = document.createElement("div");
				piece.className = "polis-global-dim-piece";
				piece.onclick = () => {
					this.editMode = false;
					this.render();
				};
				document.body.appendChild(piece);
				this.dimPieces.push(piece);
			}
			window.addEventListener("resize", this.resizeHandler);
		}

		this.updateDimFrame();
	}

	private updateDimFrame() {
		if (this.dimPieces.length < 4) return;
		const container = this.containerEl.children[1] as HTMLElement;
		const rect = container.getBoundingClientRect();
		const vw = window.innerWidth;
		const vh = window.innerHeight;
		const [top, bottom, left, right] = this.dimPieces;

		Object.assign(top.style, {
			left: "0px",
			top: "0px",
			width: `${vw}px`,
			height: `${Math.max(rect.top, 0)}px`,
		});
		Object.assign(bottom.style, {
			left: "0px",
			top: `${Math.max(rect.bottom, 0)}px`,
			width: `${vw}px`,
			height: `${Math.max(vh - rect.bottom, 0)}px`,
		});
		Object.assign(left.style, {
			left: "0px",
			top: `${rect.top}px`,
			width: `${Math.max(rect.left, 0)}px`,
			height: `${rect.height}px`,
		});
		Object.assign(right.style, {
			left: `${rect.right}px`,
			top: `${rect.top}px`,
			width: `${Math.max(vw - rect.right, 0)}px`,
			height: `${rect.height}px`,
		});
	}

	async onClose() {
		this.setGlobalDimming(false);
		this.destroySortables();
	}

	private renderHeader(container: HTMLElement) {
		const header = container.createDiv({ cls: "nav-buttons-container" });

		const addGroupBtn = header.createEl("button", { cls: "polis-icon-btn nav-action-button clickable-icon" });
		setIcon(addGroupBtn, "scan");
		addGroupBtn.setAttr("aria-label", t("aria.createGroup"));
		addGroupBtn.disabled = this.editMode;
		addGroupBtn.onclick = () => {
			if (this.editMode) return;
			new EditGroupModal(this.app, null, this.plugin.settings.groups, null, (data) => {
				this.plugin.addGroup(data.name, data.description, data.icon, data.color, data.parentGroupId ?? undefined);
			}).open();
		};

		const addVaultBtn = header.createEl("button", { cls: "polis-icon-btn nav-action-button clickable-icon" });
		setIcon(addVaultBtn, "vault");
		addVaultBtn.setAttr("aria-label", t("aria.addVault"));
		const hasGroups = this.plugin.settings.groups.length > 0;
		addVaultBtn.disabled = !hasGroups || this.editMode;
		if (!hasGroups) addVaultBtn.setAttr("aria-disabled", "true");
		addVaultBtn.onclick = () => {
			if (this.editMode || this.plugin.settings.groups.length === 0) return;
			new AddVaultModal(
				this.app,
				this.plugin.settings.groups,
				this.plugin.settings.lastUsedGroupId,
				(groupId, name, vaultPath) => {
					this.plugin.addVault(groupId, name, vaultPath);
					this.plugin.setLastUsedGroup(groupId);
				}
			).open();
		};

		const editBtn = header.createEl("button", { cls: "polis-icon-btn nav-action-button clickable-icon" });
		setIcon(editBtn, "square-pen");
		editBtn.setAttr("aria-label", t("aria.editMode"));
		editBtn.toggleClass("polis-icon-btn-active", this.editMode);
		editBtn.onclick = () => {
			this.editMode = !this.editMode;
			this.render();
		};

		const infoVisibility = this.plugin.settings.infoVisibility;
		if (infoVisibility === "global" || infoVisibility === "both") {
			const globalInfoBtn = header.createEl("button", {
				cls: "polis-icon-btn nav-action-button clickable-icon",
			});
			setIcon(globalInfoBtn, "info");
			globalInfoBtn.setAttr("aria-label", t("aria.globalDescription"));
			globalInfoBtn.disabled = this.editMode;
			globalInfoBtn.onclick = () => {
				if (this.editMode) return;
				new GlobalInfoModal(this.app, this.plugin.settings.globalDescription).open();
			};
		}
	}

	private renderGroup(container: HTMLElement, group: PolisGroup, isSubgroup = false) {
		const groupEl = container.createDiv({ cls: "polis-group" });
		if (isSubgroup) groupEl.addClass("polis-subgroup");
		groupEl.dataset.groupId = group.id;

		const groupHeader = groupEl.createDiv({ cls: "polis-group-header" });

		const chevron = groupHeader.createDiv({ cls: "tree-item-icon collapse-icon" });
		chevron.toggleClass("is-collapsed", !!group.collapsed);
		setIcon(chevron, "right-triangle");
		chevron.setAttr("aria-label", group.collapsed ? t("aria.expand") : t("aria.collapse"));
		chevron.onclick = (e) => {
			e.stopPropagation();
			this.plugin.toggleGroupCollapsed(group.id);
		};

		const groupIcon = groupHeader.createSpan({ cls: "polis-group-icon" });
		setIcon(groupIcon, group.icon || DEFAULT_GROUP_ICON);
		if (group.color) groupIcon.style.color = group.color;

		groupHeader.createEl("span", { text: group.name, cls: "polis-group-name" });

		const showGroupInfo =
			!this.editMode &&
			(this.plugin.settings.infoVisibility === "groups" || this.plugin.settings.infoVisibility === "both");
		if (showGroupInfo) {
			const infoBtn = groupHeader.createEl("button", { cls: "polis-info-btn clickable-icon" });
			setIcon(infoBtn, "info");
			infoBtn.setAttr("aria-label", t("aria.groupDescription"));
			infoBtn.onclick = (e) => {
				e.stopPropagation();
				new GroupInfoModal(this.app, group).open();
			};
		}

		if (this.editMode) {
			const grip = groupHeader.createSpan({ cls: "polis-grip" });
			setIcon(grip, "grip-vertical");
		}

		// clicking the group row in edit mode -> open the edit modal
		groupHeader.addEventListener("click", (e) => {
			if (!this.editMode) return;
			const target = e.target as HTMLElement;
			if (target.closest(".collapse-icon, .polis-grip, .polis-info-btn")) return;
			const currentParent = isSubgroup
				? this.plugin.settings.groups.find((g) => g.subgroups.includes(group))
				: undefined;
			new EditGroupModal(
				this.app,
				group,
				this.plugin.settings.groups,
				currentParent?.id ?? null,
				(data) => {
					this.plugin.updateGroupWithParent(group.id, data, data.parentGroupId);
				},
				() => this.handleGroupDeletion(group, isSubgroup, currentParent ?? null)
			).open();
		});

		if (group.description) {
			groupEl.createDiv({ cls: "polis-group-desc-hint" });
		}

		if (!group.collapsed) {
			const vaultList = groupEl.createDiv({ cls: "polis-vault-list" });
			vaultList.dataset.groupId = group.id;
			group.vaults.forEach((vault, index) => {
				const isLast = index === group.vaults.length - 1 && group.subgroups.length === 0;
				this.renderVault(vaultList, group, vault, isLast);
			});
			if (this.editMode) {
				this.setupVaultSortable(vaultList);
			}

			if (!isSubgroup && group.subgroups.length > 0) {
				const subgroupsContainer = groupEl.createDiv({ cls: "polis-subgroups-container" });
				subgroupsContainer.dataset.parentGroupId = group.id;
				group.subgroups.forEach((subgroup) => {
					this.renderGroup(subgroupsContainer, subgroup, true);
				});
				if (this.editMode) {
					this.setupSubgroupSortable(subgroupsContainer);
				}
			}
		}
	}

	private renderVault(vaultList: HTMLElement, group: PolisGroup, vault: PolisVault, isLast: boolean) {
		const row = vaultList.createDiv({ cls: "polis-vault-row" });
		row.dataset.vaultId = vault.id;
		row.toggleClass("polis-vault-row-last", isLast);
		row.toggleClass("polis-vault-missing", this.missingVaultIds.has(vault.id));

		// tree connector: shared "trunk" segment + horizontal branch to the dot
		const connector = row.createDiv({ cls: "polis-tree-connector" });
		connector.createDiv({ cls: "polis-tree-trunk" });
		connector.createDiv({ cls: "polis-tree-branch" });

		const vaultEl = row.createDiv({ cls: "polis-vault" });

		if (Platform.isDesktopApp && this.plugin.settings.vaultTooltipsEnabled && vault.description) {
			setTooltip(vaultEl, vault.description, { placement: "bottom" });
		}

		vaultEl.createEl("span", { text: vault.name, cls: "polis-vault-name" });

		if (this.editMode) {
			const grip = vaultEl.createSpan({ cls: "polis-grip" });
			setIcon(grip, "grip-vertical");
		}

		vaultEl.onclick = (e) => {
			if ((e.target as HTMLElement).closest(".polis-grip")) return;
			if (this.editMode) {
				new EditVaultModal(
					this.app,
					this.plugin.settings.groups,
					group.id,
					vault,
					(targetGroupId, name, location) => {
						if (targetGroupId !== group.id) {
							const toGroup = this.plugin.settings.groups.find((g) => g.id === targetGroupId);
							this.plugin.moveVault(vault.id, group.id, targetGroupId, toGroup?.vaults.length ?? 0);
						}
						this.plugin.updateVault(targetGroupId, vault.id, {
							name,
							path: location.path,
							obsidianVaultName: location.obsidianVaultName,
							description: location.description,
						});
					},
					() => this.plugin.removeVault(group.id, vault.id)
				).open();
			} else {
				this.plugin.openVault(vault);
			}
		};
	}

	/**
	 * Decides how to handle deleting a group: if it has no content (no
	 * vaults, no subgroups), it's removed immediately with no further
	 * questions. Otherwise, DeleteGroupModal asks the user what to do with
	 * that content before anything is actually deleted.
	 */
	private handleGroupDeletion(group: PolisGroup, isSubgroup: boolean, parent: PolisGroup | null) {
		const hasContent = group.vaults.length > 0 || group.subgroups.length > 0;
		if (!hasContent) {
			this.plugin.removeGroup(group.id);
			return;
		}

		const otherGroups = isSubgroup
			? (parent?.subgroups ?? []).filter((g) => g.id !== group.id)
			: this.plugin.settings.groups.filter((g) => g.id !== group.id);

		new DeleteGroupModal(this.app, group, isSubgroup, otherGroups, (strategy, targetGroupId) => {
			this.plugin.deleteGroupWithStrategy(group.id, strategy, targetGroupId);
		}).open();
	}

	// ---------------------------------------------------------------------
	// Drag & drop (SortableJS) — smooth reordering physics instead of native
	// HTML5 DnD, including neighbor make-way animation and touch support.
	// ---------------------------------------------------------------------

	/** Destroys all current Sortable instances — called before every render() */
	private destroySortables() {
		this.sortableInstances.forEach((s) => s.destroy());
		this.sortableInstances = [];
	}

	private setupGroupSortable(groupsContainer: HTMLElement) {
		const sortable = Sortable.create(groupsContainer, {
			animation: 180,
			easing: "cubic-bezier(0.22, 1, 0.36, 1)",
			handle: ".polis-grip",
			draggable: ".polis-group",
			ghostClass: "polis-sortable-ghost",
			chosenClass: "polis-sortable-chosen",
			dragClass: "polis-sortable-drag",
			onEnd: (evt: Sortable.SortableEvent) => {
				const groupId = (evt.item as HTMLElement).dataset.groupId;
				if (!groupId || evt.newIndex === undefined) return;
				this.plugin.moveGroup(groupId, evt.newIndex);
			},
		});
		this.sortableInstances.push(sortable);
	}

	private setupVaultSortable(vaultList: HTMLElement) {
		const sortable = Sortable.create(vaultList, {
			group: "polis-vaults",
			animation: 180,
			easing: "cubic-bezier(0.22, 1, 0.36, 1)",
			handle: ".polis-grip",
			draggable: ".polis-vault-row",
			ghostClass: "polis-sortable-ghost",
			chosenClass: "polis-sortable-chosen",
			dragClass: "polis-sortable-drag",
			onEnd: (evt: Sortable.SortableEvent) => {
				const vaultId = (evt.item as HTMLElement).dataset.vaultId;
				const fromGroupId = (evt.from as HTMLElement).dataset.groupId;
				const toGroupId = (evt.to as HTMLElement).dataset.groupId;
				if (!vaultId || !fromGroupId || !toGroupId || evt.newIndex === undefined) return;
				this.plugin.moveVault(vaultId, fromGroupId, toGroupId, evt.newIndex);
			},
		});
		this.sortableInstances.push(sortable);
	}

	private setupSubgroupSortable(subgroupsContainer: HTMLElement) {
		const sortable = Sortable.create(subgroupsContainer, {
			group: "polis-subgroups",
			animation: 180,
			easing: "cubic-bezier(0.22, 1, 0.36, 1)",
			handle: ".polis-grip",
			draggable: ".polis-subgroup",
			ghostClass: "polis-sortable-ghost",
			chosenClass: "polis-sortable-chosen",
			dragClass: "polis-sortable-drag",
			onEnd: (evt: Sortable.SortableEvent) => {
				const subgroupId = (evt.item as HTMLElement).dataset.groupId;
				const fromParentId = (evt.from as HTMLElement).dataset.parentGroupId;
				const toParentId = (evt.to as HTMLElement).dataset.parentGroupId;
				if (!subgroupId || !fromParentId || !toParentId || evt.newIndex === undefined) return;
				this.plugin.moveSubgroup(subgroupId, fromParentId, toParentId, evt.newIndex);
			},
		});
		this.sortableInstances.push(sortable);
	}
}

// ---------------------------------------------------------------------------
// Shared UI helpers for modals
// ---------------------------------------------------------------------------

function buildIconPicker(
	contentEl: HTMLElement,
	initial: string,
	onChange: (icon: string) => void
) {
	let selected = initial || DEFAULT_GROUP_ICON;

	new Setting(contentEl).setName(t("icon.heading")).setHeading();

	const grid = contentEl.createDiv({ cls: "polis-icon-grid" });
	const buttons: HTMLElement[] = [];

	const markSelected = () => {
		buttons.forEach((b) => b.toggleClass("polis-icon-selected", b.dataset.icon === selected));
	};

	CURATED_ICONS.forEach((iconName) => {
		const btn = grid.createEl("button", { cls: "polis-icon-grid-btn" });
		btn.dataset.icon = iconName;
		setIcon(btn, iconName);
		btn.onclick = () => {
			selected = iconName;
			customInput.value = "";
			onChange(selected);
			markSelected();
		};
		buttons.push(btn);
	});
	markSelected();

	let customInput: HTMLInputElement;
	new Setting(contentEl)
		.setName(t("icon.customLabel"))
		.setDesc(t("icon.customDesc"))
		.addText((text) => {
			customInput = text.inputEl;
			text.setPlaceholder(t("icon.customPlaceholder")).onChange((value) => {
				if (!value.trim()) return;
				selected = value.trim();
				onChange(selected);
				markSelected();
			});
		});
}

function buildColorPicker(
	contentEl: HTMLElement,
	initial: string | undefined,
	onChange: (color: string | undefined) => void
) {
	new Setting(contentEl)
		.setName(t("color.label"))
		.setDesc(t("color.desc"))
		.addColorPicker((picker) => {
			picker.setValue(initial || "#7c7c7c").onChange((value) => onChange(value));
		})
		.addExtraButton((btn) =>
			btn
				.setIcon("rotate-ccw")
				.setTooltip(t("color.reset"))
				.onClick(() => onChange(undefined))
		);
}

// ---------------------------------------------------------------------------
// Create/edit group modal
// ---------------------------------------------------------------------------

interface GroupFormData {
	name: string;
	description?: string;
	icon: string;
	color?: string;
	/** id of the top-level group this should become a subgroup of, or null for a top-level group */
	parentGroupId: string | null;
}

/**
 * Base class for all Polis modals. Adds a .modal-container class with a
 * deliberately high z-index so the modal always sits above the edit-mode
 * dimming strips, regardless of Obsidian's own exact z-index values.
 */
class PolisModal extends Modal {
	constructor(app: App) {
		super(app);
		this.containerEl.addClass("polis-modal-container");
	}
}

class EditGroupModal extends PolisModal {
	private data: GroupFormData;
	private confirmingDelete = false;

	constructor(
		app: App,
		private existing: PolisGroup | null,
		/** all top-level groups, used to populate the parent-group dropdown */
		private topLevelGroups: PolisGroup[],
		/** id of the group `existing` currently lives under, if it's a subgroup */
		private currentParentId: string | null,
		private onSave: (data: GroupFormData) => void,
		private onDelete?: () => void
	) {
		super(app);
		this.data = {
			name: existing?.name ?? "",
			description: existing?.description,
			icon: existing?.icon ?? DEFAULT_GROUP_ICON,
			color: existing?.color,
			parentGroupId: currentParentId,
		};
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.existing ? t("group.editTitle") : t("group.newTitle") });

		new Setting(contentEl).setName(t("group.nameLabel")).addText((text) => {
			text.setValue(this.data.name).onChange((value) => {
				this.data.name = value;
			});
			text.inputEl.focus();
		});

		this.buildParentPicker(contentEl);

		buildIconPicker(contentEl, this.data.icon, (icon) => {
			this.data.icon = icon;
		});

		buildColorPicker(contentEl, this.data.color, (color) => {
			this.data.color = color;
		});

		new Setting(contentEl)
			.setName(t("group.descLabel"))
			.setDesc(t("group.descDesc"))
			.addTextArea((text) => {
				text.setValue(this.data.description ?? "").onChange((value) => {
					this.data.description = value;
				});
				text.inputEl.rows = 4;
			});

		const footer = new Setting(contentEl);
		if (this.existing && this.onDelete) {
			footer.addButton((btn) =>
				btn
					.setButtonText(t("group.delete"))
					.setWarning()
					.onClick(() => {
						if (!this.confirmingDelete) {
							this.confirmingDelete = true;
							btn.setButtonText(t("group.deleteConfirm"));
							setTimeout(() => {
								this.confirmingDelete = false;
								btn.setButtonText(t("group.delete"));
							}, 3000);
							return;
						}
						this.onDelete?.();
						this.close();
					})
			);
		}
		footer.addButton((btn) => btn.setButtonText(t("group.cancel")).onClick(() => this.close()));
		footer.addButton((btn) =>
			btn
				.setButtonText(t("group.save"))
				.setCta()
				.onClick(() => this.submit())
		);
	}

	/**
	 * Parent-group dropdown. Only top-level groups are ever offered as a
	 * parent, since nesting is exactly one level deep. When editing an
	 * existing group that already has its own subgroups, it can't become a
	 * subgroup itself — that would create a second level — so it's excluded
	 * from candidacy entirely (the field is hidden rather than shown-disabled,
	 * since there's nothing meaningful to pick from in that case).
	 */
	private buildParentPicker(contentEl: HTMLElement) {
		const isEditingGroupWithSubgroups = !!this.existing && this.existing.subgroups.length > 0;
		if (isEditingGroupWithSubgroups) return;

		const candidates = this.topLevelGroups.filter((g) => g.id !== this.existing?.id);

		const setting = new Setting(contentEl).setName(t("group.parentLabel")).setDesc(t("group.parentDesc"));

		if (candidates.length === 0) {
			setting.setDesc(t("group.parentDescNoGroups"));
			setting.addDropdown((dropdown) => {
				dropdown.addOption("", t("group.parentNone"));
				dropdown.setDisabled(true);
			});
			return;
		}

		setting.addDropdown((dropdown) => {
			dropdown.addOption("", t("group.parentNone"));
			candidates.forEach((g) => dropdown.addOption(g.id, g.name));
			dropdown.setValue(this.data.parentGroupId ?? "").onChange((value) => {
				this.data.parentGroupId = value || null;
			});
		});
	}

	private submit() {
		const name = this.data.name.trim();
		if (!name) {
			new Notice(t("group.nameRequired"));
			return;
		}
		this.onSave({
			name,
			description: this.data.description?.trim() || undefined,
			icon: this.data.icon,
			color: this.data.color,
			parentGroupId: this.data.parentGroupId,
		});
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Delete-with-content modal — asks how to handle a group's vaults and
// subgroups before deleting a group that isn't empty.
// ---------------------------------------------------------------------------

type DeleteGroupStrategy = "delete-all" | "move-to" | "promote";

class DeleteGroupModal extends PolisModal {
	private targetGroupId = "";

	constructor(
		app: App,
		private group: PolisGroup,
		private isSubgroup: boolean,
		/** candidate groups content can be moved into — siblings at the same level */
		private otherGroups: PolisGroup[],
		private onChoose: (strategy: DeleteGroupStrategy, targetGroupId?: string) => void
	) {
		super(app);
		this.targetGroupId = otherGroups[0]?.id ?? "";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("deleteGroup.title", { name: this.group.name }) });
		contentEl.createEl("p", { text: t("deleteGroup.desc"), cls: "polis-info-desc" });

		new Setting(contentEl)
			.setName(t("deleteGroup.deleteAll"))
			.setDesc(t("deleteGroup.deleteAllDesc"))
			.addButton((btn) =>
				btn
					.setButtonText(t("deleteGroup.deleteAll"))
					.setWarning()
					.onClick(() => {
						this.onChoose("delete-all");
						this.close();
					})
			);

		if (this.otherGroups.length > 0) {
			let dropdown: HTMLSelectElement;
			new Setting(contentEl)
				.setName(t("deleteGroup.moveTo"))
				.setDesc(t("deleteGroup.moveToDesc"))
				.addDropdown((dd) => {
					this.otherGroups.forEach((g) => dd.addOption(g.id, g.name));
					dd.setValue(this.targetGroupId).onChange((value) => {
						this.targetGroupId = value;
					});
					dropdown = dd.selectEl;
				})
				.addButton((btn) =>
					btn
						.setButtonText(t("deleteGroup.moveTo"))
						.setCta()
						.onClick(() => {
							this.onChoose("move-to", this.targetGroupId);
							this.close();
						})
				);
		}

		if (this.isSubgroup) {
			new Setting(contentEl)
				.setName(t("deleteGroup.promote"))
				.setDesc(t("deleteGroup.promoteDesc"))
				.addButton((btn) =>
					btn
						.setButtonText(t("deleteGroup.promote"))
						.setCta()
						.onClick(() => {
							this.onChoose("promote");
							this.close();
						})
				);
		}

		new Setting(contentEl).addButton((btn) => btn.setButtonText(t("group.cancel")).onClick(() => this.close()));
	}

	onClose() {
		this.contentEl.empty();
	}
}

class GroupInfoModal extends PolisModal {
	constructor(app: App, private group: PolisGroup) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		const heading = contentEl.createDiv({ cls: "polis-info-heading" });
		const iconEl = heading.createSpan();
		setIcon(iconEl, this.group.icon || DEFAULT_GROUP_ICON);
		if (this.group.color) iconEl.style.color = this.group.color;
		heading.createEl("h3", { text: this.group.name });

		if (this.group.description) {
			contentEl.createEl("p", { text: this.group.description, cls: "polis-info-desc" });
		} else {
			contentEl.createEl("p", {
				text: t("group.noDescription"),
				cls: "polis-info-desc polis-info-empty",
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

class GlobalInfoModal extends PolisModal {
	constructor(app: App, private description: string) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("global.infoTitle") });

		if (this.description) {
			contentEl.createEl("p", { text: this.description, cls: "polis-info-desc" });
		} else {
			contentEl.createEl("p", {
				text: t("global.noDescription"),
				cls: "polis-info-desc polis-info-empty",
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Add vault modal
// ---------------------------------------------------------------------------

class AddVaultModal extends PolisModal {
	private groupId: string;
	private name = "";
	private path = "";
	private obsidianVaultName = "";
	private description = "";
	private nameInputEl!: HTMLInputElement;
	private pathInputEl!: HTMLInputElement;
	private groupOptions: GroupOption[];

	constructor(
		app: App,
		private topLevelGroups: PolisGroup[],
		preferredGroupId: string | null,
		private onSubmit: (
			groupId: string,
			name: string,
			location: { path?: string; obsidianVaultName?: string; description?: string }
		) => void
	) {
		super(app);
		this.groupOptions = flattenGroupsForPicker(topLevelGroups);
		const preferredStillExists = preferredGroupId && this.groupOptions.some((o) => o.group.id === preferredGroupId);
		this.groupId = preferredStillExists ? preferredGroupId! : this.groupOptions[0]?.group.id ?? "";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("vault.addTitle") });

		new Setting(contentEl).setName(t("vault.groupLabel")).addDropdown((dropdown) => {
			this.groupOptions.forEach((opt) => {
				const label = opt.isSubgroup ? `${opt.parentName} → ${opt.group.name}` : opt.group.name;
				dropdown.addOption(opt.group.id, label);
			});
			dropdown.setValue(this.groupId).onChange((value) => {
				this.groupId = value;
			});
		});

		if (Platform.isDesktopApp) {
			const known = getKnownVaults();
			if (known.length > 0) {
				new Setting(contentEl)
					.setName(t("vault.knownLabel"))
					.setDesc(t("vault.knownDesc"))
					.addDropdown((dropdown) => {
						dropdown.addOption("", t("vault.knownManual"));
						known.forEach((v, i) => dropdown.addOption(String(i), `${v.name}  (${v.path})`));
						dropdown.onChange((value) => {
							if (value === "") return;
							const vault = known[Number(value)];
							this.name = vault.name;
							this.path = vault.path;
							this.nameInputEl.value = vault.name;
							this.pathInputEl.value = vault.path;
						});
					});
			}
		}

		new Setting(contentEl).setName(t("vault.nameLabel")).addText((text) => {
			this.nameInputEl = text.inputEl;
			text.onChange((value) => {
				this.name = value;
			});
		});

		if (Platform.isDesktopApp) {
			new Setting(contentEl)
				.setName(t("vault.pathLabel"))
				.setDesc(t("vault.pathDesc"))
				.addText((text) => {
					this.pathInputEl = text.inputEl;
					text.setPlaceholder(t("vault.pathPlaceholder")).onChange((value) => {
						this.path = value;
					});
				});
		} else {
			new Setting(contentEl)
				.setName(t("vault.obsidianNameLabel"))
				.setDesc(t("vault.obsidianNameDesc"))
				.addText((text) => {
					text.setPlaceholder(t("vault.obsidianNamePlaceholder")).onChange((value) => {
						this.obsidianVaultName = value;
					});
				});
		}

		new Setting(contentEl)
			.setName(t("vault.descLabel"))
			.setDesc(t("vault.descDesc"))
			.addTextArea((text) => {
				text.onChange((value) => {
					this.description = value;
				});
				text.inputEl.rows = 3;
			});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(t("vault.add"))
				.setCta()
				.onClick(() => this.submit())
		);
	}

	private submit() {
		const name = this.name.trim();
		const vaultPath = this.path.trim();
		const obsidianVaultName = this.obsidianVaultName.trim();
		const description = this.description.trim() || undefined;

		if (!this.groupId) {
			new Notice(t("vault.groupRequired"));
			return;
		}
		if (!name) {
			new Notice(t("vault.nameRequired"));
			return;
		}
		if (Platform.isDesktopApp) {
			if (!vaultPath) {
				new Notice(t("vault.pathRequired"));
				return;
			}
			this.onSubmit(this.groupId, name, { path: vaultPath, description });
		} else {
			if (!obsidianVaultName) {
				new Notice(t("vault.obsidianNameRequired"));
				return;
			}
			this.onSubmit(this.groupId, name, { obsidianVaultName, description });
		}
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Edit vault modal
// ---------------------------------------------------------------------------

class EditVaultModal extends PolisModal {
	private groupId: string;
	private name: string;
	private path: string;
	private obsidianVaultName: string;
	private description: string;
	private confirmingDelete = false;
	private groupOptions: GroupOption[];

	constructor(
		app: App,
		topLevelGroups: PolisGroup[],
		currentGroupId: string,
		private vault: PolisVault,
		private onSave: (
			groupId: string,
			name: string,
			location: { path?: string; obsidianVaultName?: string; description?: string }
		) => void,
		private onDelete: () => void
	) {
		super(app);
		this.groupOptions = flattenGroupsForPicker(topLevelGroups);
		this.groupId = currentGroupId;
		this.name = vault.name;
		this.path = vault.path ?? "";
		this.obsidianVaultName = vault.obsidianVaultName ?? "";
		this.description = vault.description ?? "";
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("vault.editTitle") });

		new Setting(contentEl).setName(t("vault.groupLabel")).addDropdown((dropdown) => {
			this.groupOptions.forEach((opt) => {
				const label = opt.isSubgroup ? `${opt.parentName} → ${opt.group.name}` : opt.group.name;
				dropdown.addOption(opt.group.id, label);
			});
			dropdown.setValue(this.groupId).onChange((value) => {
				this.groupId = value;
			});
		});

		new Setting(contentEl).setName(t("vault.nameLabel")).addText((text) => {
			text.setValue(this.name).onChange((value) => {
				this.name = value;
			});
			text.inputEl.focus();
		});

		if (Platform.isDesktopApp) {
			new Setting(contentEl).setName(t("vault.pathLabel")).addText((text) => {
				text.setValue(this.path).onChange((value) => {
					this.path = value;
				});
			});
		} else {
			new Setting(contentEl)
				.setName(t("vault.obsidianNameLabel"))
				.setDesc(t("vault.obsidianNameDesc"))
				.addText((text) => {
					text.setValue(this.obsidianVaultName).onChange((value) => {
						this.obsidianVaultName = value;
					});
				});
		}

		new Setting(contentEl)
			.setName(t("vault.descLabel"))
			.setDesc(t("vault.descDesc"))
			.addTextArea((text) => {
				text.setValue(this.description).onChange((value) => {
					this.description = value;
				});
				text.inputEl.rows = 3;
			});

		const footer = new Setting(contentEl);
		footer.addButton((btn) =>
			btn
				.setButtonText(t("vault.delete"))
				.setWarning()
				.onClick(() => {
					if (!this.confirmingDelete) {
						this.confirmingDelete = true;
						btn.setButtonText(t("vault.deleteConfirm"));
						setTimeout(() => {
							this.confirmingDelete = false;
							btn.setButtonText(t("vault.delete"));
						}, 3000);
						return;
					}
					this.onDelete();
					this.close();
				})
		);
		footer.addButton((btn) => btn.setButtonText(t("vault.cancel")).onClick(() => this.close()));
		footer.addButton((btn) =>
			btn
				.setButtonText(t("vault.save"))
				.setCta()
				.onClick(() => this.submit())
		);
	}

	private submit() {
		const name = this.name.trim();
		const vaultPath = this.path.trim();
		const obsidianVaultName = this.obsidianVaultName.trim();
		const description = this.description.trim() || undefined;

		if (!name) {
			new Notice(t("vault.nameRequiredShort"));
			return;
		}
		if (Platform.isDesktopApp) {
			if (!vaultPath) {
				new Notice(t("vault.pathRequired"));
				return;
			}
			this.onSave(this.groupId, name, { path: vaultPath, obsidianVaultName: undefined, description });
		} else {
			if (!obsidianVaultName) {
				new Notice(t("vault.obsidianNameRequired"));
				return;
			}
			this.onSave(this.groupId, name, { path: undefined, obsidianVaultName, description });
		}
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ---------------------------------------------------------------------------
// Plugin settings tab: language selection + data export/import
// ---------------------------------------------------------------------------

const LANGUAGE_OPTIONS: { value: PolisLanguageSetting; labelKey: string }[] = [
	{ value: "auto", labelKey: "settings.language.auto" },
	{ value: "en", labelKey: "settings.language.en" },
	{ value: "ru", labelKey: "settings.language.ru" },
	{ value: "ja", labelKey: "settings.language.ja" },
];

const INFO_VISIBILITY_OPTIONS: { value: PolisInfoVisibility; labelKey: string }[] = [
	{ value: "groups", labelKey: "settings.infoVisibility.groups" },
	{ value: "global", labelKey: "settings.infoVisibility.global" },
	{ value: "both", labelKey: "settings.infoVisibility.both" },
];

class PolisSettingTab extends PluginSettingTab {
	/** buffered edits — not applied to plugin.settings until Save is clicked */
	private draft: {
		language: PolisLanguageSetting;
		infoVisibility: PolisInfoVisibility;
		globalDescription: string;
		vaultTooltipsEnabled: boolean;
	};
	private dirty = false;
	private includeSettingsInExport = false;

	constructor(app: App, private plugin: PolisPlugin) {
		super(app, plugin);
		this.draft = this.snapshotFromSettings();
	}

	private snapshotFromSettings() {
		return {
			language: this.plugin.settings.language,
			infoVisibility: this.plugin.settings.infoVisibility,
			globalDescription: this.plugin.settings.globalDescription,
			vaultTooltipsEnabled: this.plugin.settings.vaultTooltipsEnabled,
		};
	}

	private markDirty() {
		this.dirty = true;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		this.draft = this.snapshotFromSettings();
		this.dirty = false;

		new Setting(containerEl)
			.setName(t("settings.language.name"))
			.setDesc(t("settings.language.desc"))
			.addDropdown((dropdown) => {
				LANGUAGE_OPTIONS.forEach((opt) => dropdown.addOption(opt.value, t(opt.labelKey)));
				dropdown.setValue(this.draft.language).onChange((value) => {
					this.draft.language = value as PolisLanguageSetting;
					this.markDirty();
				});
			});

		new Setting(containerEl).setName(t("settings.description.heading")).setHeading();

		new Setting(containerEl)
			.setName(t("settings.infoVisibility.name"))
			.setDesc(t("settings.infoVisibility.desc"))
			.addDropdown((dropdown) => {
				INFO_VISIBILITY_OPTIONS.forEach((opt) => dropdown.addOption(opt.value, t(opt.labelKey)));
				dropdown.setValue(this.draft.infoVisibility).onChange((value) => {
					this.draft.infoVisibility = value as PolisInfoVisibility;
					this.markDirty();
				});
			});

		new Setting(containerEl)
			.setName(t("settings.globalDescription.name"))
			.setDesc(t("settings.globalDescription.desc"))
			.addTextArea((text) => {
				text.setValue(this.draft.globalDescription).onChange((value) => {
					this.draft.globalDescription = value;
					this.markDirty();
				});
				text.inputEl.rows = 5;
				text.inputEl.addClass("polis-settings-textarea");
			});

		new Setting(containerEl)
			.setName(t("settings.vaultTooltips.name"))
			.setDesc(t("settings.vaultTooltips.desc"))
			.addToggle((toggle) => {
				toggle.setValue(this.draft.vaultTooltipsEnabled).onChange((value) => {
					this.draft.vaultTooltipsEnabled = value;
					this.markDirty();
				});
			});

		new Setting(containerEl)
			.addButton((btn) => btn.setButtonText(t("settings.cancel")).onClick(() => this.discardAndRefresh()))
			.addButton((btn) =>
				btn
					.setButtonText(t("settings.save"))
					.setCta()
					.onClick(() => this.saveDraft())
			);

		new Setting(containerEl).setName(t("settings.data.heading")).setHeading();

		new Setting(containerEl)
			.setName(t("settings.export.name"))
			.setDesc(t("settings.export.desc"))
			.addToggle((toggle) => {
				toggle.setValue(this.includeSettingsInExport).setTooltip(t("settings.export.includeSettings"));
				toggle.onChange((value) => {
					this.includeSettingsInExport = value;
				});
			})
			.addButton((btn) =>
				btn.setButtonText(t("settings.export.button")).onClick(() => this.handleExport())
			);

		new Setting(containerEl)
			.setName(t("settings.import.name"))
			.setDesc(t("settings.import.desc"))
			.addButton((btn) =>
				btn.setButtonText(t("settings.import.button")).onClick(() => this.handleImportClick())
			);
	}

	private async saveDraft() {
		await this.plugin.applySettingsPatch(this.draft);
		this.dirty = false;
		new Notice(t("settings.saved"));
		this.display();
	}

	private discardAndRefresh() {
		this.dirty = false;
		this.display();
	}

	/**
	 * Called by Obsidian when the user navigates away from this settings tab
	 * (switching to another tab, or closing the Settings window). Unlike a
	 * Modal, a settings tab has no backdrop-click to intercept, and Obsidian
	 * gives no way to block navigation here — so unsaved changes can't be
	 * prevented, only surfaced with a Notice on the way out.
	 */
	hide() {
		if (this.dirty) {
			new Notice(t("settings.discardedNotice"));
		}
	}

	private handleExport() {
		const json = this.plugin.exportData(this.includeSettingsInExport);
		const blob = new Blob([json], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		const timestamp = new Date().toISOString().slice(0, 10);
		link.href = url;
		link.download = `polis-export-${timestamp}.json`;
		link.click();
		URL.revokeObjectURL(url);
		new Notice(t("settings.export.success", { count: this.plugin.settings.groups.length }));
	}

	private handleImportClick() {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = "application/json,.json";
		input.onchange = () => {
			const file = input.files?.[0];
			if (!file) return;

			const reader = new FileReader();
			reader.onload = () => {
				this.processImportedText(String(reader.result));
			};
			reader.readAsText(file);
		};
		input.click();
	}

	private processImportedText(raw: string) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			new Notice(t("settings.import.parseError"));
			return;
		}

		const payload = parsed as { groups?: unknown; settings?: Partial<PolisSettings> };
		if (!Array.isArray(payload.groups)) {
			new Notice(t("settings.import.invalidFile"));
			return;
		}
		const groups = payload.groups as PolisGroup[];

		new ImportStrategyModal(this.app, groups, this.plugin.settings.groups.length, (strategy) => {
			const result = this.plugin.importGroups(groups, strategy);
			if (payload.settings) {
				this.plugin.importSettingsFields(payload.settings);
			}
			if (strategy === "replace") {
				new Notice(t("import.resultReplace", { count: groups.length }));
			} else {
				new Notice(
					t("import.resultMerge", {
						added: result.added,
						overwritten: result.overwritten,
						skipped: result.skipped,
					})
				);
			}
			this.display();
		}).open();
	}
}

// ---------------------------------------------------------------------------
// Import strategy modal — asks how to apply imported groups when the vault
// already has data: replace everything, merge and overwrite id matches, or
// merge while keeping existing groups untouched.
// ---------------------------------------------------------------------------

type ImportStrategy = "replace" | "merge-overwrite" | "merge-keep";

class ImportStrategyModal extends PolisModal {
	constructor(
		app: App,
		private imported: PolisGroup[],
		private existingCount: number,
		private onChoose: (strategy: ImportStrategy) => void
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("import.modalTitle", { count: this.imported.length }) });
		contentEl.createEl("p", {
			text: t("import.modalDesc", { existing: this.existingCount }),
			cls: "polis-info-desc",
		});

		this.addChoice(contentEl, t("import.replaceAll"), t("import.replaceAllDesc"), "replace");
		this.addChoice(
			contentEl,
			t("import.mergeOverwrite"),
			t("import.mergeOverwriteDesc"),
			"merge-overwrite"
		);
		this.addChoice(contentEl, t("import.mergeKeep"), t("import.mergeKeepDesc"), "merge-keep");
	}

	private addChoice(contentEl: HTMLElement, name: string, desc: string, strategy: ImportStrategy) {
		new Setting(contentEl)
			.setName(name)
			.setDesc(desc)
			.addButton((btn) =>
				btn
					.setButtonText(name)
					.setCta()
					.onClick(() => {
						this.onChoose(strategy);
						this.close();
					})
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}
