// Emblem assets for the P5 思维意象: the badge PNGs live at
// src/ui/assets/emblems/<emblemId>.png (generated out-of-band). Resolved via
// import.meta.glob so a missing asset simply yields undefined and the card
// falls back to its placeholder — the feature never breaks on absent art.

const modules = import.meta.glob("../assets/emblems/*.png", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const URLS = new Map<string, string>();
for (const [path, url] of Object.entries(modules)) {
  const id = path.split("/").pop()?.replace(/\.png$/, "");
  if (id) URLS.set(id, url);
}

/** URL of the emblem PNG for an imagery entry, undefined when not generated. */
export function emblemUrl(emblemId: string): string | undefined {
  return URLS.get(emblemId);
}
