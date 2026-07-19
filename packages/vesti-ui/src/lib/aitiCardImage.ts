// P5 思维意象 share image: a pure front-end canvas render of the imagery card
// (emblem + name + type code + verdict + persona footnote + radar thumbnail +
// top obsessions + repo QR) for the "导出意象卡" button. Colors are read from
// the live semantic tokens so the exported PNG follows the current light/dark
// theme; no external service involved.

import { renderQrDataUrl, VESTI_REPO_SHORT, VESTI_REPO_URL } from "./repoQr";

export interface AitiCardImageRadarAxis {
  /** 0..100 toward the right pole */
  score: number;
  hasSignal?: boolean;
  /** faint-signal axis — the dot renders muted */
  weak?: boolean;
  /** resolved pole label ("" for no-signal axes) */
  pole: string;
}

export interface AitiCardImageInput {
  name: string;
  code: string;
  origin: string;
  verdict: string;
  personaNote?: string | null;
  /** caption above the persona footnote (localized) */
  personaNoteLabel?: string;
  /** eyebrow heading of the radar section (localized) */
  mindMapTitle?: string;
  /** caption above the obsessions chips (localized) */
  obsessionsTitle?: string;
  /** caption beside the repo QR (localized) */
  repoQrCaption?: string;
  /** four-axis radar data; skipped when not exactly four axes */
  radarAxes?: AitiCardImageRadarAxis[];
  /** obsession terms, most-invested first; the first few are drawn */
  obsessions: string[];
  sampleText: string;
  emblemUrl?: string;
}

const WIDTH = 1080;
const HEIGHT = 1600;
const PAD = 72;

/** Read an HSL-triplet semantic token as a canvas color, with a fallback. */
function tokenColor(name: string, fallback: string): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (raw && !raw.startsWith("var(")) return `hsl(${raw})`;
  } catch {
    // Non-DOM environment: fall through to the fallback.
  }
  return fallback;
}

function tokenFont(name: string, fallback: string): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (raw) return raw;
  } catch {
    // ignore
  }
  return fallback;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Greedy word/character wrap: CJK breaks per character, latin per word. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const ch of text) {
    const candidate = line + ch;
    if (line && ctx.measureText(candidate).width > maxWidth && ch !== " ") {
      lines.push(line.trimEnd());
      line = ch.trimStart();
    } else {
      line = candidate;
    }
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
}

/** Canvas port of the AitiRadar SVG: rings + spokes + score polygon + pole labels. */
function drawRadar(
  ctx: CanvasRenderingContext2D,
  axes: AitiCardImageRadarAxis[],
  centerY: number,
  radius: number,
  colors: { accent: string; border: string; secondary: string; tertiary: string },
  serif: string,
): void {
  const cx = WIDTH / 2;
  const cy = centerY;
  const deg = [-90, 0, 90, 180]; // top, right, bottom, left
  const rad = (d: number) => (d * Math.PI) / 180;
  const at = (frac: number, i: number) => ({
    x: cx + frac * radius * Math.cos(rad(deg[i])),
    y: cy + frac * radius * Math.sin(rad(deg[i])),
  });
  const clampFrac = (score: number) => Math.max(0.04, Math.min(1, (score ?? 0) / 100));
  const fracFor = (a: AitiCardImageRadarAxis) => (a.hasSignal === false ? 0.5 : clampFrac(a.score));

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = colors.border;
  for (const f of [0.33, 0.66, 1]) {
    ctx.beginPath();
    axes.forEach((_, i) => {
      const p = at(f, i);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.stroke();
  }
  axes.forEach((_, i) => {
    const p = at(1, i);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  });

  ctx.beginPath();
  axes.forEach((a, i) => {
    const p = at(fracFor(a), i);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fillStyle = colors.accent;
  ctx.globalAlpha = 0.22;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.lineWidth = 3;
  ctx.strokeStyle = colors.accent;
  ctx.stroke();

  axes.forEach((a, i) => {
    const p = at(fracFor(a), i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = a.weak ? colors.tertiary : colors.accent;
    ctx.fill();
  });

  ctx.fillStyle = colors.secondary;
  ctx.font = `22px ${serif}`;
  axes.forEach((a, i) => {
    if (!a.pole) return;
    const p = at(1.26, i);
    ctx.textAlign = i === 1 ? "left" : i === 3 ? "right" : "center";
    ctx.fillText(a.pole, p.x, p.y + (i === 0 ? -6 : i === 2 ? 16 : 6));
  });
  ctx.textAlign = "left";
}

/**
 * Render the share image; resolves null when canvas/blob is unavailable. The
 * caller turns the blob into a download.
 */
export async function renderAitiCardImage(input: AitiCardImageInput): Promise<Blob | null> {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const pageBg = tokenColor("--bg-tertiary", "#fafafa");
  const cardBg = tokenColor("--surface-card", "#ffffff");
  const textPrimary = tokenColor("--text-primary", "#111827");
  const textSecondary = tokenColor("--text-secondary", "#4b5563");
  const textTertiary = tokenColor("--text-tertiary", "#9ca3af");
  const borderSubtle = tokenColor("--border-subtle", "#e5e7eb");
  const accent = tokenColor("--accent-primary", "#111827");
  const serif = tokenFont(
    "--font-vesti-serif",
    'Georgia, "Songti SC", "Noto Serif SC", serif',
  );

  // Page + card
  ctx.fillStyle = pageBg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  roundedRect(ctx, 40, 40, WIDTH - 80, HEIGHT - 80, 36);
  ctx.fillStyle = cardBg;
  ctx.fill();
  ctx.strokeStyle = borderSubtle;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Emblem (or circular initial fallback when the art is missing). The emblem
  // PNG is a de-papered sticker now, so it blends straight into the card.
  const emblemSize = 168;
  const emblemX = PAD;
  const emblemY = 108;
  const emblem = input.emblemUrl ? await loadImage(input.emblemUrl) : null;
  if (emblem) {
    ctx.drawImage(emblem, emblemX, emblemY, emblemSize, emblemSize);
  } else {
    ctx.beginPath();
    ctx.arc(emblemX + emblemSize / 2, emblemY + emblemSize / 2, emblemSize / 2, 0, Math.PI * 2);
    ctx.strokeStyle = borderSubtle;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = textPrimary;
    ctx.font = `64px ${serif}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(input.name.charAt(0), emblemX + emblemSize / 2, emblemY + emblemSize / 2 + 4);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  // Name + type-code chip + origin
  const textX = emblemX + emblemSize + 40;
  ctx.fillStyle = textPrimary;
  ctx.font = `600 56px ${serif}`;
  ctx.fillText(input.name, textX, emblemY + 62, WIDTH - PAD - textX);

  ctx.font = `28px ${serif}`;
  const codeText = input.code.split("").join(" ");
  const codeWidth = ctx.measureText(codeText).width;
  const chipY = emblemY + 88;
  roundedRect(ctx, textX, chipY, codeWidth + 44, 48, 24);
  ctx.strokeStyle = textPrimary;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = textPrimary;
  ctx.fillText(codeText, textX + 22, chipY + 34);

  ctx.fillStyle = textTertiary;
  ctx.font = `24px ${serif}`;
  ctx.fillText(input.origin, textX, chipY + 96, WIDTH - PAD - textX);

  // Verdict — the visual重心 of the card
  let y = emblemY + emblemSize + 96;
  ctx.fillStyle = textPrimary;
  ctx.font = `italic 38px ${serif}`;
  const verdictLines = wrapText(ctx, input.verdict, WIDTH - PAD * 2);
  for (const line of verdictLines.slice(0, 4)) {
    ctx.fillText(line, PAD, y);
    y += 60;
  }

  // LLM persona footnote (when present): eyebrow label + accent quote bar,
  // mirroring the card's quote styling
  const note = input.personaNote?.trim();
  if (note) {
    y += 20;
    if (input.personaNoteLabel) {
      ctx.fillStyle = textTertiary;
      ctx.font = `22px ${serif}`;
      ctx.fillText(input.personaNoteLabel.toUpperCase(), PAD + 4, y);
      y += 40;
    }
    ctx.fillStyle = textSecondary;
    ctx.font = `italic 28px ${serif}`;
    const noteLines = wrapText(ctx, note, WIDTH - PAD * 2 - 36).slice(0, 3);
    const noteTop = y - 26;
    for (const line of noteLines) {
      ctx.fillText(line, PAD + 32, y);
      y += 46;
    }
    ctx.fillStyle = accent;
    ctx.fillRect(PAD, noteTop, 5, y - noteTop - 14);
  }

  // Divider
  y += 44;
  ctx.strokeStyle = borderSubtle;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(WIDTH - PAD, y);
  ctx.stroke();
  y += 56;

  // 思维图 thumbnail: radar of the four axes (skipped for other axis sets)
  if (input.radarAxes && input.radarAxes.length === 4) {
    if (input.mindMapTitle) {
      ctx.fillStyle = textTertiary;
      ctx.font = `22px ${serif}`;
      ctx.fillText(input.mindMapTitle.toUpperCase(), PAD, y - 6);
      y += 34;
    }
    drawRadar(
      ctx,
      input.radarAxes,
      y + 140,
      130,
      { accent, border: borderSubtle, secondary: textSecondary, tertiary: textTertiary },
      serif,
    );
    y += 360;
  }

  // Top obsessions as bordered chips, flowing with wrap; stop before the footer zone
  if (input.obsessions.length > 0 && input.obsessionsTitle) {
    ctx.fillStyle = textTertiary;
    ctx.font = `22px ${serif}`;
    ctx.fillText(input.obsessionsTitle.toUpperCase(), PAD, y - 6);
    y += 44;
  }
  ctx.font = `26px ${serif}`;
  let chipX = PAD;
  const chipFloor = HEIGHT - 240;
  for (const term of input.obsessions.slice(0, 6)) {
    const w = ctx.measureText(term).width + 40;
    if (chipX + w > WIDTH - PAD) {
      chipX = PAD;
      y += 72;
      if (y > chipFloor) break;
    }
    roundedRect(ctx, chipX, y - 34, w, 52, 26);
    ctx.strokeStyle = borderSubtle;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = textPrimary;
    ctx.fillText(term, chipX + 20, y + 2);
    chipX += w + 18;
  }

  // Footer: sample + brand left; repo QR with caption bottom-right (dark-on-
  // white tile so it scans regardless of the exported theme)
  const footerY = HEIGHT - 88;
  ctx.fillStyle = textTertiary;
  ctx.font = `22px ${serif}`;
  ctx.fillText(input.sampleText, PAD, footerY);

  const qrSize = 128;
  const qrUrl = await renderQrDataUrl(VESTI_REPO_URL, 256);
  const qr = qrUrl ? await loadImage(qrUrl) : null;
  if (qr) {
    const qrX = WIDTH - PAD - qrSize;
    const qrY = footerY - qrSize + 10;
    ctx.fillStyle = "#ffffff";
    roundedRect(ctx, qrX - 10, qrY - 10, qrSize + 20, qrSize + 20, 16);
    ctx.fill();
    ctx.strokeStyle = borderSubtle;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

    const captionLines = [input.repoQrCaption, VESTI_REPO_SHORT].filter(Boolean) as string[];
    ctx.fillStyle = textTertiary;
    ctx.font = `20px ${serif}`;
    ctx.textAlign = "right";
    captionLines.forEach((line, i) => {
      ctx.fillText(line, qrX - 28, qrY + qrSize / 2 - (captionLines.length - 1) * 14 + i * 28 + 7);
    });
    ctx.textAlign = "left";
  } else {
    const brand = "VESTI · AITI";
    ctx.fillText(brand, WIDTH - PAD - ctx.measureText(brand).width, footerY);
  }

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}
