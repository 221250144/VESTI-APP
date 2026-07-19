// VESTI GitHub 仓库二维码 — shared by the AITI card (React <img>) and the
// exported share image (canvas drawImage). The QR always renders dark modules
// on a white tile so it stays scannable in both light and dark themes.

import QRCode from "qrcode";

export const VESTI_REPO_URL = "https://github.com/firefly-hefeng/VESTI-APP";
/** Short host/path form for captions (no scheme). */
export const VESTI_REPO_SHORT = "github.com/firefly-hefeng/VESTI-APP";

/**
 * PNG data URL of the QR for `text`; null when canvas/QR is unavailable.
 * Dark-on-white fixed colors: the surrounding UI supplies the tile, so the
 * code itself must not follow the theme.
 */
export async function renderQrDataUrl(text: string, width: number): Promise<string | null> {
  try {
    return await QRCode.toDataURL(text, {
      width,
      margin: 0,
      errorCorrectionLevel: "M",
      color: { dark: "#111827", light: "#ffffff" },
    });
  } catch {
    return null;
  }
}
