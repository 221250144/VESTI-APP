// 自定义猫头鹰皮肤 (DIY): text-to-image via the official gateway's
// OpenAI-compatible images surface. Both LLM modes generate through OUR
// gateway — a BYOK key has no gpt-image upstream — so every generation is
// credit-metered (category 'image'), unlike chat which skips BYOK. The owl
// keeps one custom slot: a fresh generation overwrites custom-owl.png under
// the active data directory; the capsule ball and the 夜话 avatars pick it up
// through readCustomOwl() when ui-pref `owlSkin === 'custom'`.

import { net } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CaptureService } from './captureService';
import { demoOpenAiBase } from './chatStream';
import { DEMO_BASE_URL, DEMO_SERVICE_TOKEN, type SettingsService } from './settingsService';

export const CUSTOM_OWL_FILE = 'custom-owl.png';
export const CUSTOM_OWL_META_FILE = 'custom-owl.json';
export const CUSTOM_OWL_IMAGE_MODEL = 'gpt-image-2-high';
export const CUSTOM_OWL_TIMEOUT_MS = 180_000;
export const CUSTOM_OWL_MAX_PROMPT_CHARS = 400;

export interface CustomOwlAsset {
  dataUrl: string;
  updatedAt: number;
}

/** Credit-metering hook wired by main; image generations are ALWAYS metered
 * (both modes ride our gateway), so this meter never no-ops on BYOK. */
export interface ImageCreditMeter {
  /** Pre-flight check; throws (CREDITS_EXHAUSTED) when the cycle is spent. */
  beforeImage(): void;
  /** Post-success accounting (fixed per-generation cost). */
  afterImage(label: string): void;
}

/**
 * 风格统一约束：every custom owl — preset or DIY — opens with this preamble so
 * the whole skin family stays recognizably the same character (round body,
 * big eyes, flat illustration, transparent background). The user's
 * description only steers the THEME section.
 */
export const CUSTOM_OWL_STYLE_PREFIX =
  '一只圆润可爱的猫头鹰角色立绘：球形体态、大眼睛、居中构图、角色约占画面八成，简洁扁平插画风配柔和渐变，透明背景，无文字无水印。皮肤主题：';

interface CustomOwlMeta {
  prompt: string;
  model: string;
  updatedAt: number;
}

export class ImageService {
  constructor(
    private readonly capture: CaptureService,
    private readonly settings: SettingsService,
    private readonly credits?: ImageCreditMeter,
  ) {}

  private get skinsDirectory(): string {
    return path.join(this.capture.activeDataDirectory, 'skins');
  }

  private get assetPath(): string {
    return path.join(this.skinsDirectory, CUSTOM_OWL_FILE);
  }

  private get metaPath(): string {
    return path.join(this.skinsDirectory, CUSTOM_OWL_META_FILE);
  }

  async generateCustomOwl(prompt: string): Promise<CustomOwlAsset> {
    const trimmed = prompt.trim().slice(0, CUSTOM_OWL_MAX_PROMPT_CHARS);
    if (!trimmed) throw new Error('请先描述你想要的猫头鹰皮肤');
    const llm = this.settings.getRuntimeLlm();
    // Always the official gateway: image generation is a gateway-side
    // capability (keys stay server-side), independent of the chat LLM mode.
    const baseUrl = llm.mode === 'demo_proxy' && llm.baseUrl.trim() ? llm.baseUrl : DEMO_BASE_URL;
    const serviceToken = llm.mode === 'demo_proxy' && llm.serviceToken.trim()
      ? llm.serviceToken.trim()
      : DEMO_SERVICE_TOKEN;
    const endpoint = `${demoOpenAiBase(baseUrl)}/images/generations`;
    this.credits?.beforeImage();

    const response = await net.fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vesti-service-token': serviceToken,
      },
      body: JSON.stringify({
        model: CUSTOM_OWL_IMAGE_MODEL,
        prompt: `${CUSTOM_OWL_STYLE_PREFIX}${trimmed}`,
        size: '1024x1024',
        background: 'transparent',
      }),
      signal: AbortSignal.timeout(CUSTOM_OWL_TIMEOUT_MS),
    }).catch((error: unknown) => {
      throw new Error(`无法连接绘图服务：${error instanceof Error ? error.message : String(error)}`);
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as {
        error?: { message?: string } | string;
        message?: string;
      };
      const detail = typeof payload.error === 'string'
        ? payload.error
        : payload.error?.message || payload.message;
      throw new Error(detail || `绘图请求失败（HTTP ${response.status}）`);
    }

    const payload = await response.json().catch(() => ({})) as {
      data?: Array<{ b64_json?: unknown; url?: unknown }>;
    };
    const first = payload.data?.[0];
    let buffer: Buffer | null = null;
    if (typeof first?.b64_json === 'string' && first.b64_json) {
      buffer = Buffer.from(first.b64_json, 'base64');
    } else if (typeof first?.url === 'string' && first.url) {
      const download = await net.fetch(first.url, {
        signal: AbortSignal.timeout(CUSTOM_OWL_TIMEOUT_MS),
      }).catch(() => null);
      if (download?.ok) buffer = Buffer.from(await download.arrayBuffer());
    }
    if (!buffer || buffer.length === 0) throw new Error('绘图服务没有返回可用的图片');

    const updatedAt = Date.now();
    await fs.mkdir(this.skinsDirectory, { recursive: true });
    await fs.writeFile(this.assetPath, buffer);
    const meta: CustomOwlMeta = { prompt: trimmed, model: CUSTOM_OWL_IMAGE_MODEL, updatedAt };
    await fs.writeFile(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');
    this.credits?.afterImage('custom-owl');
    return { dataUrl: `data:image/png;base64,${buffer.toString('base64')}`, updatedAt };
  }

  /** The current custom owl as a data URL (null when never generated). */
  async readCustomOwl(): Promise<CustomOwlAsset | null> {
    try {
      const [buffer, metaRaw] = await Promise.all([
        fs.readFile(this.assetPath),
        fs.readFile(this.metaPath, 'utf8').catch(() => ''),
      ]);
      let updatedAt = 0;
      if (metaRaw) {
        try {
          const meta = JSON.parse(metaRaw) as Partial<CustomOwlMeta>;
          updatedAt = typeof meta.updatedAt === 'number' ? meta.updatedAt : 0;
        } catch {
          updatedAt = 0;
        }
      }
      if (!updatedAt) updatedAt = (await fs.stat(this.assetPath)).mtimeMs;
      return { dataUrl: `data:image/png;base64,${buffer.toString('base64')}`, updatedAt };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}
