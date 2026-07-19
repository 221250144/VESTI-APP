// P5 思维意象 share image: a pure front-end canvas render of the imagery card
// (emblem + name + type code + verdict + top obsessions) for the "导出意象卡"
// button. Colors are read from the live semantic tokens so the exported PNG
// follows the current light/dark theme; no external service involved.

export interface AitiCardImageInput {
  name: string;
  code: string;
  origin: string;
  verdict: string;
  personaNote?: string | null;
  /** obsession terms, most-invested first; the first few are drawn */
  obsessions: string[];
  sampleText: string;
  emblemUrl?: string;
}

const WIDTH = 1080;
const HEIGHT = 1350;
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

  // Emblem (or circular initial fallback when the art is missing)
  const emblemSize = 168;
  const emblemX = PAD;
  const emblemY = 108;
  const emblem = input.emblemUrl ? await loadImage(input.emblemUrl) : null;
  if (emblem) {
    ctx.save();
    roundedRect(ctx, emblemX, emblemY, emblemSize, emblemSize, 28);
    ctx.clip();
    ctx.drawImage(emblem, emblemX, emblemY, emblemSize, emblemSize);
    ctx.restore();
    roundedRect(ctx, emblemX, emblemY, emblemSize, emblemSize, 28);
    ctx.strokeStyle = borderSubtle;
    ctx.stroke();
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

  // LLM persona footnote (when present), visually weaker than the verdict
  const note = input.personaNote?.trim();
  if (note) {
    y += 16;
    ctx.fillStyle = textSecondary;
    ctx.font = `28px ${serif}`;
    for (const line of wrapText(ctx, note, WIDTH - PAD * 2).slice(0, 3)) {
      ctx.fillText(line, PAD, y);
      y += 46;
    }
  }

  // Divider
  y += 44;
  ctx.strokeStyle = borderSubtle;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(PAD, y);
  ctx.lineTo(WIDTH - PAD, y);
  ctx.stroke();
  y += 64;

  // Top obsessions as bordered chips, flowing with wrap
  ctx.font = `26px ${serif}`;
  let chipX = PAD;
  for (const term of input.obsessions.slice(0, 6)) {
    const w = ctx.measureText(term).width + 40;
    if (chipX + w > WIDTH - PAD) {
      chipX = PAD;
      y += 72;
    }
    roundedRect(ctx, chipX, y - 34, w, 52, 26);
    ctx.strokeStyle = borderSubtle;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = textPrimary;
    ctx.fillText(term, chipX + 20, y + 2);
    chipX += w + 18;
  }

  // Footer
  ctx.fillStyle = textTertiary;
  ctx.font = `22px ${serif}`;
  ctx.fillText(input.sampleText, PAD, HEIGHT - 88);
  const brand = "VESTI · AITI";
  ctx.fillText(brand, WIDTH - PAD - ctx.measureText(brand).width, HEIGHT - 88);

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}
