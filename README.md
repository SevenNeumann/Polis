# Polis

A vault manager for Obsidian. Group your vaults into contexts, jump between them in one click, and keep everything organized — right next to Files, Search, and Bookmarks.

## Features

- **Groups (contexts)** — organize vaults into named groups, each with its own icon, color, and description (e.g. "Work", "Personal", "Writing").
- **One-click vault switching** — click any vault to open it via Obsidian's `obsidian://` URI handler.
- **Drag-and-drop reordering** — smooth, physics-based reordering (powered by [SortableJS](https://github.com/SortableJS/Sortable)) for both groups and vaults, including moving a vault between groups.
- **Edit mode** — a dedicated mode dims the rest of Obsidian and reveals drag handles and edit affordances, so browsing and editing stay visually distinct.
- **Auto-detects known vaults** — when adding a vault, pick from vaults Obsidian already knows about (read from Obsidian's own vault list) instead of typing a path by hand.
- **Import / export** — back up all groups and vaults to a JSON file, or move your setup between different Obsidian installations. Import supports three merge strategies: replace everything, merge and overwrite matching groups, or merge while keeping existing groups untouched.
- **Localized UI** — English, Russian, and Japanese out of the box, with automatic detection based on Obsidian's own display language (or pick one manually in settings).

## Installation

Polis isn't yet available in the Community Plugins directory. To install manually:

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases).
2. Create a folder named `polis` inside your vault's `.obsidian/plugins/` directory.
3. Copy the three files into that folder.
4. In Obsidian, go to **Settings → Community plugins**, disable Safe mode if needed, and enable **Polis**.

## Usage

- Click the brackets icon in the Polis panel header to create a group.
- Click the vault icon to add a vault to a group (disabled until at least one group exists).
- Click the pencil icon to toggle edit mode — drag groups and vaults to reorder them, or click a row to edit its name, icon, color, or description.
- Click the "i" icon on a group to read its description.
- Configure language, and export/import your data, from **Settings → Polis**.

## Development

Requires Node.js and npm.

```bash
npm install
npm run dev      # watch mode — main.js rebuilds on every change to main.ts
npm run build    # production build (type-check + minify)
```

### Testing in a real Obsidian vault

The easiest way is to symlink (or, on Windows, use a directory junction for) the whole project folder into a test vault's plugins directory, so `npm run dev` rebuilds are picked up without copying files manually:

```bash
# macOS / Linux
ln -s /path/to/obsidian-polis /path/to/TestVault/.obsidian/plugins/polis

# Windows (Command Prompt, no admin rights required)
mklink /J "C:\path\to\TestVault\.obsidian\plugins\polis" "C:\path\to\obsidian-polis"
```

Then, in Obsidian: **Settings → Community plugins → enable Polis**. After changes rebuild, reload with **Ctrl/Cmd+P → Reload app without saving**, or toggle the plugin off and on.

### Project structure

```
main.ts        — plugin entry point, view, data model, modals
i18n.ts         — locale detection and the t() translation helper
locales/        — en.json, ru.json, ja.json translation dictionaries
styles.css      — panel styling, using Obsidian's own CSS variables where possible
manifest.json   — plugin metadata
```

## Roadmap

- [ ] Community Plugins directory submission
- [ ] Additional languages
- [ ] Broader icon picker

## License

MIT
