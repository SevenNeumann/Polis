import en from "locales/en.json";
import ru from "locales/ru.json";
import ja from "locales/ja.json";

export type PolisLocale = "en" | "ru" | "ja";
export type PolisLanguageSetting = "auto" | PolisLocale;

export const SUPPORTED_LOCALES: PolisLocale[] = ["en", "ru", "ja"];

const DICTIONARIES: Record<PolisLocale, Record<string, string>> = { en, ru, ja };

let activeLocale: PolisLocale = "en";

/**
 * Detects Obsidian's own display language via the global moment.js instance
 * that Obsidian configures on load (window.moment.locale()). This is the
 * same signal most community plugins use for "match Obsidian" behavior —
 * it avoids reaching into Obsidian's private localStorage keys directly.
 */
function detectObsidianLocale(): PolisLocale {
	try {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const momentLocale: string = (window as any).moment?.locale?.() ?? "en";
		const short = momentLocale.split("-")[0].toLowerCase();
		if (SUPPORTED_LOCALES.includes(short as PolisLocale)) {
			return short as PolisLocale;
		}
	} catch {
		// fall through to default
	}
	return "en";
}

/** Resolves the "auto" language setting into a concrete supported locale */
export function resolveLocale(setting: PolisLanguageSetting): PolisLocale {
	if (setting === "auto") return detectObsidianLocale();
	return setting;
}

/** Sets which dictionary t() reads from. Call this on load and whenever the setting changes. */
export function setActiveLocale(setting: PolisLanguageSetting) {
	activeLocale = resolveLocale(setting);
}

export function getActiveLocale(): PolisLocale {
	return activeLocale;
}

/**
 * Translates a key using the active locale, falling back to English for any
 * missing key (and to the key itself if even English is missing it, so a
 * gap in translation never breaks the UI silently).
 */
export function t(key: string, vars?: Record<string, string | number>): string {
	const dict = DICTIONARIES[activeLocale] ?? DICTIONARIES.en;
	let str = dict[key] ?? DICTIONARIES.en[key] ?? key;

	if (vars) {
		for (const [name, value] of Object.entries(vars)) {
			str = str.replace(new RegExp(`\\{${name}\\}`, "g"), String(value));
		}
	}

	return str;
}
