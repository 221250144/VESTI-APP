import classicCollapsed from './assets/skins/classic/collapsed.png';
import midnightCollapsed from './assets/skins/midnight/collapsed.png';
import pixelCollapsed from './assets/skins/pixel/collapsed.png';
import sakuraCollapsed from './assets/skins/sakura/collapsed.png';

/**
 * Registry of floating-ball owl skins. The selected skin id is persisted in
 * ui-prefs under `owlSkin`; unknown/missing ids fall back to DEFAULT_SKIN_ID.
 *
 * All collapsed-state PNGs are imported eagerly: 4 × ~1MB ≈ 4.3MB in the
 * bundle, acceptable today. If the number of variants grows, switch to
 * dynamic loading (e.g. import.meta.glob) so only the active skin is fetched.
 */
export interface OwlSkin {
  id: string;
  name: { zh: string; en: string };
  /** Artwork for the collapsed 48px ball state (transparent-background PNG). */
  collapsed: string;
}

export const DEFAULT_SKIN_ID = 'classic';

export const SKINS: OwlSkin[] = [
  { id: 'classic', name: { zh: '经典', en: 'Classic' }, collapsed: classicCollapsed },
  { id: 'midnight', name: { zh: '午夜星空', en: 'Midnight' }, collapsed: midnightCollapsed },
  { id: 'pixel', name: { zh: '像素', en: 'Pixel' }, collapsed: pixelCollapsed },
  { id: 'sakura', name: { zh: '樱花', en: 'Sakura' }, collapsed: sakuraCollapsed },
];

export function resolveSkin(id: unknown): OwlSkin {
  return SKINS.find(skin => skin.id === id) ?? SKINS[0];
}
