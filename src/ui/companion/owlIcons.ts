// Owl mood icons for 夜话: the PNGs live at src/ui/assets/owl/<mood>.png
// (generated out-of-band, transparent 512px). Resolved via import.meta.glob —
// same pattern as aiti/emblems.ts — so a missing asset simply drops that key
// and the chat falls back to the calm icon / monogram instead of breaking.
// The map is handed to @vesti/ui as the companionOwlIcons prop (Electron
// file://-safe URLs produced by the renderer bundle).

import type { CompanionMood } from "./companionService";

const modules = import.meta.glob("../assets/owl/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const ICONS = {} as Record<CompanionMood, string>;
for (const [path, url] of Object.entries(modules)) {
  const id = path.split("/").pop()?.replace(/\.png$/, "");
  if (id && id in ICONS) ICONS[id as CompanionMood] = url;
}

/** Owl mood-icon URLs keyed by mood id (calm/thinking/delighted/spark/sleepy/warm). */
export const OWL_MOOD_ICONS: Readonly<Record<CompanionMood, string>> = ICONS;
