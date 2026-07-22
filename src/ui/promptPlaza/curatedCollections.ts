// 提示词广场 · 设计/创作高质量合集 (CURATED_COLLECTIONS).
//
// Design / writing / engineering workflow prompts, each grounded in a
// well-known public prompt collection (see per-entry source/sourceUrl) and
// battle-tested on real VESTI work (the Don't-Starve emblem set and the owl
// mascot skins shipped in the app). Every entry carries:
//   - bilingual title + description (适用场景说明) + body,
//   - `{{placeholder}}` variables (detected by promptlib's detectVariables),
//   - tags for search and grouping,
//   - honest attribution: `source` names the public collection the pattern
//     comes from, `sourceUrl` is that collection's real page.
//
// Image-generation bodies stay in English (image models follow English style
// vocabulary more reliably); the zh body keeps the same English prompt text
// and adds Chinese usage notes. Writing/engineering bodies are Chinese-first
// with an English translation.
//
// Merged into CURATED_PROMPTS in commonPrompts.ts (deduped by id), which puts
// every entry into the supermarket AND the date-seeded daily rotation.

import type { CuratedPrompt } from "./commonPrompts";

const ART = { en: "AI Art & Icons", zh: "AI 绘画与图标" };
const UIUX = { en: "UI/UX Design", zh: "UI/UX 设计" };
const WRITING = { en: "Creative Writing", zh: "创作与写作" };
const ENG = { en: "Engineering", zh: "工程效率" };

export const CURATED_COLLECTIONS: CuratedPrompt[] = [
  // ------------------------------------------------------------------
  // AI 绘画与图标 (AI Art & Icons) — image-gen prompts, English-first.
  // ------------------------------------------------------------------
  {
    id: "art-emblem-dontstarve",
    category: ART,
    title: { en: "Don't-Starve hand-drawn emblem", zh: "饥荒式手绘徽章" },
    description: {
      en: "Circular storybook emblems in a light, whimsical Don't-Starve sketchbook style. Battle-tested on a 16-emblem production set: keep the STYLE prefix verbatim, swap only the Scene and Accent lines per badge.",
      zh: "《饥荒》速写本风格（明亮轻快版）的圆形徽章。已在 16 枚徽章的生产集上验证：STYLE 前缀逐字复用，每枚只改 Scene 与 Accent 两行。适用：系列图标、成就徽章、人格/类型徽章。",
    },
    tags: ["image-gen", "emblem", "badge", "hand-drawn", "徽章", "手绘"],
    body: {
      en: `A circular emblem medallion badge, hand-drawn illustration in the sketchbook style of the video game Don't Starve, but with a light, airy, gently whimsical mood, never gloomy or eerie. Composition: one single circular medallion centered on the square canvas, the circular artwork fills about 78% of the canvas and is fully contained inside a slightly wobbly hand-inked circular border ring. Minimal clean composition with generous breathing room: one simple silhouette-driven main subject with only a few supporting elements, plenty of quiet empty aged-paper space. Rough sketchy black ink outlines with visible pen wobble, clear readable silhouettes, only sparse light cross-hatching for shading, muted desaturated vintage palette on aged paper, subtle paper grain texture, exaggerated cute slightly-lumpy proportions, bright calm hopeful fairy-tale charm. Flat ink-and-wash coloring only: no 3D rendering, no photorealism, no smooth digital gradients, no glossy airbrush, no neon colors, no heavy dark shading, no stormy or horror atmosphere. Isolated on a plain solid flat aged-paper background (uniform hex #F5F0E6), absolutely nothing outside the circular medallion, no ground shadow, no glow outside the circle. No text, no letters, no numbers, no watermark.
Scene: {{scene — the badge subject plus 2-4 supporting elements, e.g. "a chubby little bird carrying a twig flies over simple curled waves, a warm morning sun on the horizon"}}. Accent colors: {{1-2 muted accent colors, e.g. "faded teal waves and dusty coral red"}}.

Usage notes:
- Keep the STYLE prefix (everything above the Scene line) verbatim for every badge; change only Scene and Accent. Batch consistency comes from the fixed prefix.
- "about 78%" is deliberate: models render a 90-95% full medallion from this wording. Do not "fix" the number.
- The flat #F5F0E6 background doubles as a cutout key color (floodfill from the canvas corners) for transparent PNGs.
- Even tragic subjects should read as "bright loneliness", never gloomy or eerie.`,
      zh: `A circular emblem medallion badge, hand-drawn illustration in the sketchbook style of the video game Don't Starve, but with a light, airy, gently whimsical mood, never gloomy or eerie. Composition: one single circular medallion centered on the square canvas, the circular artwork fills about 78% of the canvas and is fully contained inside a slightly wobbly hand-inked circular border ring. Minimal clean composition with generous breathing room: one simple silhouette-driven main subject with only a few supporting elements, plenty of quiet empty aged-paper space. Rough sketchy black ink outlines with visible pen wobble, clear readable silhouettes, only sparse light cross-hatching for shading, muted desaturated vintage palette on aged paper, subtle paper grain texture, exaggerated cute slightly-lumpy proportions, bright calm hopeful fairy-tale charm. Flat ink-and-wash coloring only: no 3D rendering, no photorealism, no smooth digital gradients, no glossy airbrush, no neon colors, no heavy dark shading, no stormy or horror atmosphere. Isolated on a plain solid flat aged-paper background (uniform hex #F5F0E6), absolutely nothing outside the circular medallion, no ground shadow, no glow outside the circle. No text, no letters, no numbers, no watermark.
Scene: {{场景——徽章主体加 2-4 个辅助元素，如「衔细枝的圆滚小鸟飞过简洁卷曲海浪，海平线一轮暖阳」}}. Accent colors: {{1-2 个低饱和做旧强调色，如「褪 teal 浪 + 褪珊瑚红」}}.

使用说明：
- Scene 行以上的 STYLE 前缀逐字固定，每枚徽章只改 Scene 与 Accent 两行；批量一致性靠前缀保证。
- "about 78%" 是经验措辞：该措辞下模型实际产出 90-95% 的饱满画幅，勿改数字。
- 纯色 #F5F0E6 纸底兼作去背键色（从画布四角 floodfill），便于输出透明 PNG。
- 悲剧题材也画成「明亮的孤独感」，绝不阴森。`,
    },
    source: "Learn Prompting",
    sourceUrl: "https://learnprompting.org/",
  },
  {
    id: "art-mascot-ball",
    category: ART,
    title: { en: "Spherical mascot & skin variants", zh: "圆球吉祥物与皮肤变体" },
    description: {
      en: "One reusable prefix for a chubby ball mascot that fills the canvas edge-to-edge, plus themed skin variants (classic / midnight / pixel / sakura all shipped). Works for any brand mascot, not just owls.",
      zh: "一套可复用前缀，生成撑满画幅的圆球吉祥物，并批量产出主题皮肤（经典/星夜/像素/樱花均已上线）。换成你自己的吉祥物主体同样适用。适用：品牌吉祥物、桌面挂件皮肤、头像。",
    },
    tags: ["image-gen", "mascot", "吉祥物", "皮肤", "i2i"],
    body: {
      en: `A cute chubby baby owl mascot ball for a desktop floating-ball widget. Perfectly circular spherical composition: one single round ball that fills the square 1:1 canvas edge-to-edge, subject centered, the ball is the owl (its face is on the front of the ball). Soft modern illustration style, smooth clean shading, rounded friendly shapes, crisp silhouette, high-quality digital art. Isolated on a plain solid pure white background (#FFFFFF), absolutely nothing else in the background, no ground shadow. No text, no letters, no watermark. Keep the owl identity of the attached reference logo: huge round wide-open eyes and a tiny beak.
Skin: {{skin theme — palette, material, mood, e.g. "starry midnight: deep indigo-navy body sprinkled with tiny glowing stars, big round warm amber glowing eyes, calm cozy late-night mood"}}.

Usage notes:
- Reuse the STYLE prefix verbatim; only the Skin line changes per variant.
- The sentence "Keep the owl identity of the attached reference logo" is for image-to-image edits with a base logo attached; delete it for plain text-to-image.
- Swap "baby owl" for your own mascot animal or object and keep everything else.
- The pure #FFFFFF background is the cutout key: threshold pixels with RGB min-channel >= 240, then floodfill from the edges for a transparent sprite.`,
      zh: `A cute chubby baby owl mascot ball for a desktop floating-ball widget. Perfectly circular spherical composition: one single round ball that fills the square 1:1 canvas edge-to-edge, subject centered, the ball is the owl (its face is on the front of the ball). Soft modern illustration style, smooth clean shading, rounded friendly shapes, crisp silhouette, high-quality digital art. Isolated on a plain solid pure white background (#FFFFFF), absolutely nothing else in the background, no ground shadow. No text, no letters, no watermark. Keep the owl identity of the attached reference logo: huge round wide-open eyes and a tiny beak.
Skin: {{皮肤主题——配色、材质、氛围，如「星夜：深靛蓝球体洒满微光小星，琥珀色发光大眼，安静深夜氛围」}}.

使用说明：
- STYLE 前缀逐字复用，每个皮肤只改 Skin 一行。
- 末句 "Keep the owl identity of the attached reference logo" 用于图生图（附基准 logo 时）；纯文生图请删掉它。
- 把 "baby owl" 换成你自己的吉祥物主体，其余保持不变。
- 纯白 #FFFFFF 底是去背键色：RGB 最小通道 ≥ 240 判背景，再从边缘 floodfill，得到透明贴图。`,
    },
    source: "OpenAI Cookbook",
    sourceUrl: "https://cookbook.openai.com/",
  },
  {
    id: "art-flat-illustration",
    category: ART,
    title: { en: "Flat editorial illustration", zh: "扁平插画风" },
    description: {
      en: "Clean geometric flat illustration for blog headers, onboarding and slides. The palette cap (3-5 named colors) and a stated use case are what keep the output consistent.",
      zh: "几何形扁平插画，适合博客头图、引导页与幻灯片。一致性的关键在于限定 3-5 个具名颜色，并写明使用场景。",
    },
    tags: ["image-gen", "illustration", "flat", "插画", "头图"],
    body: {
      en: `A flat vector-style illustration of {{subject}}. Clean geometric shapes, bold uniform outlines or outline-free shapes, a limited palette of {{3-5 colors, e.g. "warm cream, terracotta, sage green, charcoal"}}, no gradients except at most one subtle flat shadow, generous negative space, balanced asymmetrical composition. Modern editorial illustration feel for {{use case, e.g. "a tech-blog header / an onboarding screen"}}. Isolated on a plain solid {{background color}} background, nothing else in frame. No text, no letters, no watermark, no photorealistic texture, no 3D rendering.

Tips:
- Name the exact palette (hex codes help) and cap it at 3-5 colors.
- State the use case explicitly — models compose differently for a wide header vs. a square card.`,
      zh: `A flat vector-style illustration of {{主体}}. Clean geometric shapes, bold uniform outlines or outline-free shapes, a limited palette of {{3-5 个颜色，如「暖米白、陶土红、灰绿、炭黑」}}, no gradients except at most one subtle flat shadow, generous negative space, balanced asymmetrical composition. Modern editorial illustration feel for {{使用场景，如「技术博客头图 / 新手引导页」}}. Isolated on a plain solid {{背景色}} background, nothing else in frame. No text, no letters, no watermark, no photorealistic texture, no 3D rendering.

使用提示：
- 色板写具体（给 hex 更好），并限定在 3-5 色。
- 明确写出使用场景——横幅头图与方形卡片的构图逻辑不同。`,
    },
    source: "Learn Prompting",
    sourceUrl: "https://learnprompting.org/",
  },
  {
    id: "art-app-icon",
    category: ART,
    title: { en: "App icon from one metaphor", zh: "应用图标（单隐喻法）" },
    description: {
      en: "Design an app icon around a single bold glyph that survives 64px. Generate 4 metaphor variants separately, then iterate the strongest — never fix a weak metaphor with colors.",
      zh: "围绕一个在 64px 下仍可辨认的单一图形隐喻设计应用图标。分别生成 4 个隐喻变体再择优迭代——隐喻不行就换隐喻，别靠配色救。",
    },
    tags: ["image-gen", "icon", "app-icon", "logo", "图标"],
    body: {
      en: `An app icon for {{app purpose}}, centered on a squircle-rounded-square canvas. One single bold glyph metaphor — {{core metaphor, e.g. "an owl eye inside a chat bubble"}} — built from simple geometric shapes, readable at 64px. Flat or softly layered design, 1-2 brand colors on {{background treatment, e.g. "a deep charcoal-to-indigo vertical gradient"}}. Crisp edges, no fine detail, no small elements, no text, no letters, no photorealism, no 3D bevels. Full-bleed composition with comfortable safe margins.

Tips:
- Downscale the result to 64px and 32px: if the metaphor does not survive, simplify the glyph, not the colors.
- Ask for 3-4 different metaphors in separate generations, then iterate on the strongest one.`,
      zh: `An app icon for {{应用用途}}, centered on a squircle-rounded-square canvas. One single bold glyph metaphor — {{核心隐喻，如「聊天气泡里的一只猫头鹰眼睛」}} — built from simple geometric shapes, readable at 64px. Flat or softly layered design, 1-2 brand colors on {{背景处理，如「炭黑到靛蓝的纵向渐变」}}. Crisp edges, no fine detail, no small elements, no text, no letters, no photorealism, no 3D bevels. Full-bleed composition with comfortable safe margins.

使用提示：
- 把结果缩到 64px / 32px 检验：隐喻糊了就简化图形，而不是改配色。
- 分多次生成 3-4 个不同隐喻，再围绕最强的那个迭代。`,
    },
    source: "OpenAI Cookbook",
    sourceUrl: "https://cookbook.openai.com/",
  },
  {
    id: "art-i2i-consistent-variants",
    category: ART,
    title: { en: "I2I consistent variants", zh: "图生图一致性变体" },
    description: {
      en: "Image-to-image variant technique: attach one clean reference, then state explicitly what stays invariant (identity, composition, style, background) and the single thing that changes. Consistency comes from the invariant list.",
      zh: "图生图变体技巧：附一张干净基准图，显式列出「保持不变项」（主体、构图、风格、背景）与「唯一变化项」。一致性来自不变清单，而非模型猜测。适用：皮肤、配色、季节/节日变体。",
    },
    tags: ["image-gen", "i2i", "图生图", "变体", "一致性"],
    body: {
      en: `Use the attached image as the identity anchor. Keep unchanged: subject identity and proportions, composition and framing, overall style and line language, background treatment. Change only: {{what varies, e.g. "the color theme to a cherry-blossom palette: soft pastel pink body, cream-white face patch, a few petals drifting"}}. Everything not explicitly listed as changing must stay consistent with the reference. No text, no watermark.

How to use:
- Attach ONE clean reference (flat background, subject centered).
- Batch variants by reusing the same skeleton and swapping only the "Change only" line.
- If the model drifts, strengthen the anchor: add "the same character, same pose, same composition as the reference image".`,
      zh: `Use the attached image as the identity anchor. Keep unchanged: subject identity and proportions, composition and framing, overall style and line language, background treatment. Change only: {{唯一变化项，如「配色换成樱花主题：柔粉色球体、奶白脸斑、几片飘落花瓣」}}. Everything not explicitly listed as changing must stay consistent with the reference. No text, no watermark.

使用说明：
- 只附一张干净基准图（纯色底、主体居中）。
- 批量变体复用同一骨架，只换 "Change only" 一行。
- 若模型跑偏，加强锚定：补一句 "the same character, same pose, same composition as the reference image"。`,
    },
    source: "OpenAI Cookbook",
    sourceUrl: "https://cookbook.openai.com/",
  },
  {
    id: "art-style-prefix-framework",
    category: ART,
    title: { en: "Reusable STYLE prefix framework", zh: "STYLE 前缀五槽框架" },
    description: {
      en: "The meta-technique behind our shipped image sets: lock five slots (framing, line language, palette, mood, negative constraints) into one verbatim prefix, then append only a short scene line per image.",
      zh: "我们两套上线图集背后的元技巧：把五个槽位（画幅、线条语言、配色、气质、负约束）锁进一段逐字复用的前缀，每张图只追加一行场景描述。适用：任何需要批量一致性的图集。",
    },
    tags: ["image-gen", "prompt-engineering", "批量", "一致性", "方法论"],
    body: {
      en: `Build a reusable STYLE prefix for a batch image set by locking five slots:
1. Format & framing — e.g. "one circular medallion centered on a square canvas, fills about 78%".
2. Line & rendering language — e.g. "rough sketchy black ink outlines with visible pen wobble, sparse light cross-hatching".
3. Palette & background — name exact colors/hex; a uniform background hex doubles as a cutout key color.
4. Mood lock — one sentence fixing the emotional register and what it must never become.
5. Negative constraints — "no 3D rendering, no photorealism, no neon colors, no text, no watermark" plus layout bans ("nothing outside the circle, no ground shadow").

Rules:
- Per image, append only a short scene line (subject + accent colors); keep the prefix verbatim across the whole batch.
- When one image drifts, re-roll that image alone; never tweak the shared prefix mid-batch.
- Write the prefix in English even if you work in Chinese — image models follow English style vocabulary more reliably.

Now draft my STYLE prefix and the per-image scene lines for: {{your batch — subject, mood, and the list of images, e.g. "12 zodiac emblems, bright storybook mood"}}.`,
      zh: `用五个锁定的槽位搭建可批量复用的 STYLE 前缀：
1. 画幅与取景——如「方形画布正中一个圆形徽章，画幅约占 78%」。
2. 线条与渲染语言——如「带笔尖抖动的速写墨线、稀疏轻排线」。
3. 配色与背景——写具体色值/hex；统一背景色可兼作去背键色。
4. 气质锁——一句话钉住情绪基调，并写明绝不成为什么。
5. 负约束——「no 3D rendering, no photorealism, no neon colors, no text, no watermark」，外加布局禁令（圆外无物、无投影）。

规则：
- 每张图只追加一行场景（主体 + 强调色）；整批逐字复用前缀。
- 单张跑偏就单张重抽，绝不在批量中途改共享前缀。
- 即使你中文工作，前缀也用英文写——图像模型对英文风格词汇响应更稳。

现在请为我的图集起草 STYLE 前缀与每张的场景行：{{你的图集——主题、气质与图片清单，如「12 枚生肖徽章，明亮童话感」}}。`,
    },
    source: "Learn Prompting",
    sourceUrl: "https://learnprompting.org/",
  },
  {
    id: "art-empty-state-illustration",
    category: ART,
    title: { en: "Empty-state spot illustration", zh: "空状态点缀插画" },
    description: {
      en: "Small, quiet spot illustrations for empty states that leave room for UI copy. Keep the subject under ~40% of the canvas and match the palette to your design tokens by hex.",
      zh: "为空状态页生成小巧安静的点缀插画，给 UI 文案留出空间。主体控制在画布约 40% 以内，配色用 hex 对齐设计 token。",
    },
    tags: ["image-gen", "empty-state", "空状态", "插画", "ui"],
    body: {
      en: `A minimal spot illustration for an empty-state screen about {{context, e.g. "no conversations yet"}}. One small charming subject ({{subject, e.g. "a sleepy owl sitting in an open cardboard box"}}) with lots of empty space around it, a soft muted palette matching {{brand colors, e.g. "#F5F0E6 cream, charcoal, dusty teal"}}, gentle flat shading, a friendly quiet mood — encouraging, not sad. Centered on a plain {{background color}} background. No text, no letters, no UI chrome, no watermark.

Tips:
- Keep the subject under about 40% of the canvas so the UI can place headline and button around it.
- Name your design-token hex values explicitly instead of vague color words.`,
      zh: `A minimal spot illustration for an empty-state screen about {{场景，如「还没有任何会话」}}. One small charming subject ({{主体，如「一只坐在打开的纸箱里打瞌睡的猫头鹰」}}) with lots of empty space around it, a soft muted palette matching {{品牌色，如「#F5F0E6 米白、炭黑、灰 teal」}}, gentle flat shading, a friendly quiet mood — encouraging, not sad. Centered on a plain {{背景色}} background. No text, no letters, no UI chrome, no watermark.

使用提示：
- 主体控制在画布约 40% 以内，方便 UI 在其周围排标题与按钮。
- 配色直接写设计 token 的 hex 值，不要用模糊的颜色词。`,
    },
    source: "Learn Prompting",
    sourceUrl: "https://learnprompting.org/",
  },
  {
    id: "art-cutout-key-background",
    category: ART,
    title: { en: "Cutout-friendly key background", zh: "键控底去背技巧" },
    description: {
      en: "One sentence added to any prompt gives you a transparent PNG later: force a uniform flat background hex, then floodfill only the edge-connected background (same-colored areas inside the subject survive).",
      zh: "在任意提示词后加一句话，事后即可程序化去背：强制统一纯色背景，再只 floodfill 与画布边缘连通的背景域（主体内部同色区域不受影响）。",
    },
    tags: ["image-gen", "cutout", "去背", "透明底", "技巧"],
    body: {
      en: `Add this sentence to any subject prompt when you need a transparent PNG afterwards:
"Isolated on a plain solid flat {{key color, e.g. "#F5F0E6" or "#FFFFFF"}} background, uniform color, absolutely nothing else in the background, no ground shadow, no glow."

Then cut the background programmatically:
1. Sample the four corners for the real key color.
2. Treat pixels within a small RGB distance of it as background.
3. Floodfill only the background region CONNECTED to the canvas edge, so same-colored areas enclosed inside the subject stay opaque.
4. Feather the edge about 0.6px to kill fringe.

Pick a key color that does not appear inside the subject itself.`,
      zh: `需要透明 PNG 时，在任意主体提示词后加这句话：
"Isolated on a plain solid flat {{键控色，如 #F5F0E6 或 #FFFFFF}} background, uniform color, absolutely nothing else in the background, no ground shadow, no glow."

然后程序化去背：
1. 采样画布四角得到真实键控色。
2. 与该色 RGB 距离小于阈值的像素判为背景。
3. 只 floodfill 与画布边缘连通的背景域——主体内部被围住的同色区域保持不透明。
4. 边缘羽化约 0.6px 去毛边。

选一个主体内部不出现的颜色作键控色。`,
    },
    source: "Learn Prompting",
    sourceUrl: "https://learnprompting.org/",
  },

  // ------------------------------------------------------------------
  // UI/UX 设计 — Chinese-first.
  // ------------------------------------------------------------------
  {
    id: "uiux-review-checklist",
    category: UIUX,
    title: { en: "Interface review checklist", zh: "界面审查清单" },
    description: {
      en: "A structured UI audit across hierarchy, consistency, state coverage, feedback and accessibility. Paste a screenshot description or page spec; get pass/risk/fail per item plus a Top-3 fix list.",
      zh: "覆盖信息层级、一致性、状态覆盖、反馈与无障碍的结构化界面审查。粘贴截图描述或页面规格，逐项给出通过/有风险/不通过，最后输出 Top 3 问题与修法。适用：设计评审、上线前自查。",
    },
    tags: ["design", "review", "checklist", "审查", "设计评审"],
    body: {
      en: `You are a senior product designer. Audit the interface below against the checklist: for each item give Pass / At risk / Fail with a one-line reason, then list the Top 3 issues by severity with concrete fixes.

Checklist:
1. Information hierarchy: can a first-time user grasp the main task in 3 seconds? Are title / body / helper-text levels distinct?
2. Consistency: are spacing, radii, font sizes and palette uniform? Do similar components behave alike?
3. State coverage: are loading, empty, error, no-permission and extreme-data states (very long text / zero / huge numbers) all designed?
4. Feedback & control: does every action give immediate feedback? Do destructive actions have confirmation or undo?
5. Accessibility: is contrast at least 4.5:1? Are hit areas at least 44px? Keyboard and screen-reader support?
6. Copy: are button verbs explicit? Do error messages say what happened AND what to do next?

Interface description / spec:
{{paste the interface description, page structure or design spec}}`,
      zh: `你是资深产品设计师。请按下面的清单审查这个界面，逐项给出「通过 / 有风险 / 不通过」和一句理由，最后按严重程度列出 Top 3 问题与具体修改建议。

审查清单：
1. 信息层级：首屏能否 3 秒内看懂主任务？标题/正文/辅助文字的层级是否清晰？
2. 一致性：间距、圆角、字号、色板是否统一？同类组件行为是否一致？
3. 状态覆盖：加载、空、错误、权限不足、极端数据（超长文本/为零/超大数字）是否都有设计？
4. 反馈与可控性：每个操作是否有即时反馈？破坏性操作是否有确认与撤销？
5. 无障碍：对比度是否 ≥ 4.5:1？可点区域是否 ≥ 44px？是否支持键盘与读屏？
6. 文案：按钮动词是否明确？错误提示是否说清「发生了什么 + 怎么办」？

界面描述/规格：
{{粘贴界面截图的文字描述、页面结构或设计稿说明}}`,
    },
    source: "Awesome ChatGPT Prompts",
    sourceUrl: "https://github.com/f/awesome-chatgpt-prompts",
  },
  {
    id: "uiux-design-tokens",
    category: UIUX,
    title: { en: "Design token spec generator", zh: "设计系统 token 规范生成" },
    description: {
      en: "Turn brand traits into a shippable token spec: palette with contrast-checked pairs, type scale, 4px spacing scale, elevation levels, dual CSS-variable + JSON naming.",
      zh: "把品牌气质变成可落地的 token 规范：带对比度合规组合的色板、字体阶梯、4px 间距刻度、阴影层级，CSS 变量与 JSON 双格式、语义化命名。适用：新项目立规范、旧项目收编散色。",
    },
    tags: ["design-system", "tokens", "设计系统", "色板", "规范"],
    body: {
      en: `You are a design-system engineer. From the brand brief below, produce a ready-to-use design token spec:
1. Palette: primary / secondary / semantic colors (success, warning, error, info) / a neutral gray ramp (at least 8 steps), with hex values and the contrast-compliant foreground pairs marked.
2. Type scale: font-size / line-height / weight table covering caption through display.
3. Spacing & radius: a 4px-based spacing scale and a radius scale.
4. Elevation: 3-4 shadow levels.
5. Naming: output both CSS variables and a design-token JSON, with semantic names (--color-bg-surface, not --color-gray-100).

Brand brief: {{brand personality, preferred primary color, product form, e.g. "developer tool, dark-first, restrained and professional"}}
Constraints: {{platform/framework, e.g. "Tailwind CSS variables", "must output both light and dark sets"}}`,
      zh: `你是设计系统工程师。根据下面的品牌信息，输出一套可直接落地的设计 token 规范：
1. 色板：主色/辅助色/语义色（success、warning、error、info）/中性灰阶（至少 8 档），给出 hex 并标注对比度合规的前景色组合；
2. 字体阶梯：字号-行高-字重对照表（覆盖 caption 到 display）；
3. 间距与圆角：以 4px 为基的间距刻度、圆角刻度；
4. 阴影与层级：3-4 档 elevation；
5. 命名：CSS 变量与 design token JSON 双格式输出，命名语义化（--color-bg-surface，而非 --color-gray-100）。

品牌信息：{{品牌气质、主色偏好、产品形态，如「开发者工具，深色优先，克制专业」}}
约束：{{平台/框架，如「Tailwind CSS 变量」「需要同时输出浅色与深色两套」}}`,
    },
    source: "Anthropic Prompt Library",
    sourceUrl: "https://docs.anthropic.com/en/prompt-library/library",
  },
  {
    id: "uiux-usability-walkthrough",
    category: UIUX,
    title: { en: "Cognitive walkthrough", zh: "可用性认知走查" },
    description: {
      en: "Step through a task as the target user, asking the four classic questions at each step. Produces severity-tagged friction points and the cheapest fix for the Top 5 issues.",
      zh: "扮演目标用户逐步走查任务，每步回答经典四问（会尝试吗/找得到吗/对得上吗/知道成了吗）。输出标注严重程度的卡点与 Top 5 问题的最低成本修法。适用：新流程上线前、竞品迁移体验评估。",
    },
    tags: ["usability", "walkthrough", "可用性", "走查", "ux"],
    body: {
      en: `Run a cognitive walkthrough of the task below as the target user. At each step answer the four questions: Will the user try the right action? Can they find the control? Will they connect the control to the expected outcome? Does the feedback show the action worked?
Record step by step: friction points, hesitations, wrong expectations, each tagged by severity (blocker / major / minor). Then output the Top 5 usability issues with the cheapest fix for each.

Target user: {{persona, e.g. "first-time user migrating from a competitor, intermediate skill"}}
Task: {{the task to complete, e.g. "import history and find one record from last week"}}
Interface flow: {{steps / page descriptions}}`,
      zh: `请对下面的用户任务做一次认知走查（Cognitive Walkthrough）。扮演目标用户，逐步执行并回答四问：用户会尝试正确的操作吗？用户能找到这个控件吗？用户能把控件与预期效果联系起来吗？操作后反馈是否足以让用户知道做对了？
逐步记录：卡点、犹豫、错误预期，并标注严重程度（阻塞/严重/轻微）。最后输出 Top 5 可用性问题，以及每个问题成本最低的修复方案。

目标用户：{{用户画像，如「第一次使用、从竞品迁移来的中级用户」}}
任务：{{要完成的任务，如「导入历史数据并找到上周的某条记录」}}
界面流程：{{步骤/页面描述}}`,
    },
    source: "Awesome ChatGPT Prompts",
    sourceUrl: "https://github.com/f/awesome-chatgpt-prompts",
  },
  {
    id: "uiux-dark-mode-audit",
    category: UIUX,
    title: { en: "Dark-mode adaptation audit", zh: "深色模式适配检查" },
    description: {
      en: "Audit a UI for dark-mode quality: pure-black traps, contrast drift, shadow-based layering failure, semantic color tuning, image/icon swaps, and hard-coded color replacement suggestions.",
      zh: "检查界面深色模式适配质量：纯黑背景陷阱、对比度漂移、阴影分层失效、语义色过亮、图片图标深色版、硬编码颜色的 token 替换建议。粘贴 CSS/组件代码即可用。",
    },
    tags: ["dark-mode", "深色模式", "css", "适配", "audit"],
    body: {
      en: `You are an engineer-designer hybrid. Audit the code below for dark-mode adaptation quality:
1. Pure-black trap: is the background #000? It should be a dark gray (e.g. #121212 to #1E1E1E).
2. Contrast: do body / secondary / disabled text still meet 4.5:1 and 3:1 on the new surfaces?
3. Shadow failure: cards that relied on shadows for layering in light mode — do they switch to lighter surface + hairline border in dark?
4. Semantic color drift: are success / warning / error too bright or too dim on dark? Should saturation be reduced?
5. Images & icons: do bitmap logos and illustrations need dark variants? Are icon strokes adapted?
6. Hard-coded colors: list every hard-coded color value and suggest the token that should replace it.

Code / style snippet:
{{paste CSS, Tailwind classes or component code}}`,
      zh: `你是前端与设计双修的专家。检查下面的代码在深色模式下的适配质量，逐项审查：
1. 纯黑陷阱：背景是否用了 #000 纯黑（应改为深灰，如 #121212~#1E1E1E）？
2. 对比度：正文/次要文字/禁用态在新背景下是否仍 ≥ 4.5:1 / 3:1？
3. 阴影失效：浅色模式靠阴影分层的卡片，在深色下是否改用「更亮的表面色 + 细边框」分层？
4. 语义色漂移：success/warning/error 在深底上是否过亮或过暗？饱和度是否需要下调？
5. 图片与图标：位图 logo、插图是否需要深色版？图标描边色是否适配？
6. 硬编码颜色：列出代码中所有写死的颜色值，给出对应的 token 替换建议。

代码/样式片段：
{{粘贴 CSS / Tailwind 类 / 组件代码}}`,
    },
    source: "GitHub Copilot Docs",
    sourceUrl: "https://docs.github.com/en/copilot",
  },
  {
    id: "uiux-empty-state-copy",
    category: UIUX,
    title: { en: "Empty-state copywriting", zh: "空状态文案写作" },
    description: {
      en: "Empty-state copy that says what belongs here, why it is empty, and where to click next — three variants (action-guiding / value-explaining / progress-reassuring) with use cases marked.",
      zh: "空状态文案三要素：这里会有什么、为什么现在是空的、下一步点哪里。输出引导操作型/说明价值型/进度安抚型三个版本并标注适用场景。不卖萌、不道歉、不居高临下。",
    },
    tags: ["copywriting", "empty-state", "空状态", "文案", "ux-writing"],
    body: {
      en: `You are a product copywriter. Write copy for the empty state below:
- Cover three things: what will live here, why it is empty right now, and where to click next.
- Tone: {{brand voice, e.g. "restrained, professional, slightly warm"}}. No cutesy acting, no apologizing, no condescension.
- Structure: headline within 10 characters, body within 40 characters, primary button an explicit verb (within 4 characters), plus an optional secondary link.
- Output 3 variants — action-guiding / value-explaining / progress-reassuring — and mark when each fits best.

Empty-state scenario: {{e.g. "a new user has no conversations yet", "search returned nothing", "the recycle bin is empty"}}
Product context: {{what the product is and what this page does}}`,
      zh: `你是产品文案专家。为下面的空状态写一套文案，要求：
- 说清三件事：这里会有什么、为什么现在是空的、下一步点哪里；
- 语气：{{品牌语气，如「克制、专业、略带温度」}}，不卖萌、不道歉、不居高临下；
- 结构：标题 ≤ 10 字，正文 ≤ 40 字，主按钮为明确动词（≤ 4 字），可选次级引导链接；
- 输出 3 个版本：引导操作型 / 说明价值型 / 进度安抚型，并标注各自适用场景。

空状态场景：{{如「新用户还没有任何会话记录」「搜索结果为空」「回收站为空」}}
产品上下文：{{产品是什么、这个页面干什么}}`,
    },
    source: "Google Workspace Prompting Guide",
    sourceUrl: "https://workspace.google.com/resources/prompting/",
  },

  // ------------------------------------------------------------------
  // 创作与写作 (Creative Writing) — Chinese-first.
  // ------------------------------------------------------------------
  {
    id: "writing-style-mimic",
    category: WRITING,
    title: { en: "Style profile → mimicry", zh: "写作风格分析→仿写" },
    description: {
      en: "Two-step: distill the author's style from sample texts (tone, rhythm, diction, structure, taboos), then write a new piece in that style. Pairs with Vesti's deposits-area writing_style template — distill once, reuse the profile.",
      zh: "两步法：先从样文提炼风格画像（语气、句式、用词、结构、禁忌），再严格按画像写新主题。与 Vesti 沉淀区的「写作风格」模板同构——先用模板沉淀风格文档，再用本提示词仿写。",
    },
    tags: ["writing", "style", "仿写", "风格", "沉淀"],
    body: {
      en: `Work in two steps.
Step 1 (style profile): read the sample texts and distill the author's style across five dimensions — tone and attitude, sentence rhythm (long/short mix, colloquial level), diction habits (catchphrases, jargon density), structure habits (how pieces open, develop, close), and expressions to avoid. Output a concise style document.
Step 2 (mimicry): strictly following that style document, write a {{genre, e.g. "WeChat article / blog section / product update note"}} on "{{new topic}}". Then self-check: fix anything that does not sound like the author, and list the 3 style traits you deliberately imitated.

Sample texts:
{{paste 2-3 representative pieces by the author}}`,
      zh: `分两步执行。
第一步（风格画像）：通读下面的样文，从五个维度提炼作者的写作风格——语气与态度、句式特点（长短句节奏、口语化程度）、用词偏好（口头禅、术语密度）、结构习惯（开头方式、段落推进、结尾收束）、应当避免的表达。输出一份简洁的风格文档。
第二步（仿写）：严格按该风格文档，就「{{新主题}}」写一篇 {{体裁，如「公众号短文 / 博客段落 / 产品更新公告」}}。写完后自查一遍：把不像作者的地方改掉，并列出你刻意模仿的 3 个风格特征。

样文：
{{粘贴 2-3 篇作者的代表作}}`,
    },
    source: "OpenAI Prompt Engineering Guide",
    sourceUrl: "https://platform.openai.com/docs/guides/prompt-engineering",
  },
  {
    id: "writing-tech-blog-polish",
    category: WRITING,
    title: { en: "Tech blog polish", zh: "技术博客润色" },
    description: {
      en: "Polish a tech draft without flattening the author's voice: sharpen the opening, close every argument loop (problem → solution → evidence → tradeoff), cut filler, trim code blocks. Includes a change-log table.",
      zh: "润色技术草稿但不磨平作者语气：开头三句说清价值，每个论点补齐「问题→方案→证据→取舍」闭环，删正确的废话，精简代码块。附修改说明表。",
    },
    tags: ["writing", "blog", "润色", "技术写作", "blog"],
    body: {
      en: `You are a technical-writing editor. Polish the draft below:
- Preserve the author's technical opinions and personal voice; optimize only for clarity and structure.
- Within the first 3 sentences the reader must know what problem this solves and who it is for.
- Every argument needs a full loop: problem → solution → code/evidence → tradeoffs. Flag whatever is missing so I can supply it.
- Delete empty filler ("as everyone knows", "with the development of...").
- Keep only the key lines in code blocks; truncate long outputs with an ellipsis.
- Output: the polished full text + a change table (original issue → fix → reason).

Draft:
{{paste the blog draft}}`,
      zh: `你是技术写作编辑。润色下面这篇技术博客草稿，要求：
- 保持作者的技术观点与个人语气不变，只做清晰度与结构优化；
- 开头 3 句内必须说清「这篇解决什么问题、适合谁读」；
- 每个论点配「问题 → 方案 → 代码/证据 → 取舍」的完整闭环，缺什么就标出来让我补；
- 删掉正确的废话（如「众所周知」「随着时代的发展」）；
- 代码块只保留关键行，长输出用省略号截断；
- 输出：润色后的全文 + 一张修改说明表（原问题 → 改法 → 理由）。

草稿：
{{粘贴博客草稿}}`,
    },
    source: "Anthropic Prompt Library",
    sourceUrl: "https://docs.anthropic.com/en/prompt-library/library",
  },
  {
    id: "writing-readme",
    category: WRITING,
    title: { en: "README that onboards", zh: "README 写作" },
    description: {
      en: "A README structure that gets people running in minutes: one-line positioning, screenshot slot, value-first features, shortest quick-start path, the 5-8 most common config keys, one-paragraph architecture.",
      zh: "让人几分钟跑起来的 README 结构：一句话定位、截图位、用户价值优先的 Features、最短 Quick Start、最常用的 5-8 个配置项、一段式架构概述。语气克制，不堆形容词。",
    },
    tags: ["writing", "readme", "docs", "文档", "开源"],
    body: {
      en: `You are a documentation engineer for open-source projects. Write a README.md from the project info below:
1. One-line positioning (what it does + whose problem it solves) and a badge row.
2. Screenshot/GIF placeholder with a one-line caption.
3. Features: 3-6 items, one line each, verb-first, framed as user value not implementation.
4. Quick Start: the shortest path from clone to running, with copy-pasteable commands.
5. Config table with only the 5-8 most common keys.
6. Architecture in one paragraph plus a module list (no big code dumps).
7. Contributing / License / Credits.
Restrained, professional tone, no adjective stacking. Write in English unless the project primarily serves Chinese users.

Project info:
{{project name, tech stack, core features, target users, install method}}`,
      zh: `你是开源项目的文档工程师。根据下面的项目信息写一份 README.md，结构如下：
1. 一句话定位（做什么 + 为谁解决什么问题）+ 徽标行；
2. 截图/GIF 占位与一句图注；
3. Features：3-6 条，每条一行，动词开头，讲用户价值而非实现细节；
4. Quick Start：从 clone 到跑起来的最短路径，命令可直接复制；
5. 配置项表格（仅列最常用的 5-8 个）；
6. 架构一段式概述（配模块清单，不贴大段代码）；
7. Contributing / License / 致谢。
语气克制专业，不堆砌形容词；项目主要面向中文用户则用中文，否则用英文。

项目信息：
{{项目名、技术栈、核心功能、目标用户、安装方式}}`,
    },
    source: "Awesome ChatGPT Prompts",
    sourceUrl: "https://github.com/f/awesome-chatgpt-prompts",
  },
  {
    id: "writing-release-announcement",
    category: WRITING,
    title: { en: "Release announcement", zh: "产品发布稿" },
    description: {
      en: "Release notes framed as user benefit: verb-first headline, pain → now → how-to per feature, numbers for performance claims, plus a 140-character social summary. Upgrade path and feedback channel included.",
      zh: "以用户收益为主线的发布稿：动词开头标题、每个功能按「痛点→现在→怎么用」展开、性能用数字说话，附 140 字社媒摘要版。含升级方式与反馈渠道。",
    },
    tags: ["writing", "release", "发布稿", "changelog", "营销"],
    body: {
      en: `You are a product-marketing writer. Write a release announcement from the version info below:
- Headline: verb-first, states the biggest user benefit (no version-number stacking).
- Opening paragraph: the core pain this version solves + the one-line highlight.
- Body of 3-5 sections: one feature per section, told as pain → what it is now → how to use it, with one example each.
- Performance/stability improvements get their own section, told in numbers.
- Close: how to upgrade + what is next + feedback channel.
- Total length {{length, e.g. "under 600 words"}}, tone {{tone, e.g. "confident and restrained"}}.
- Also output a social-media summary version of at most 140 characters.

Version info:
{{version number, new features, improvements and fixes, target users}}`,
      zh: `你是产品营销撰稿人。根据下面的版本信息写一篇发布稿：
- 标题：动词开头，说清最大的用户收益（不堆版本号）；
- 开头一段：这个版本解决的核心痛点 + 一句话亮点；
- 主体 3-5 个小节：每节一个功能点，按「痛点 → 现在怎样 → 怎么用」展开，各配一句示例；
- 性能/稳定性改进单列一节，用数字说话；
- 结尾：升级方式 + 下个版本预告 + 反馈渠道；
- 全文 {{篇幅，如「600 字以内」}}，语气 {{语气，如「自信克制」}}；
- 同时输出一条 ≤ 140 字的社交媒体摘要版。

版本信息：
{{版本号、新功能清单、改进与修复、目标用户}}`,
    },
    source: "Google Workspace Prompting Guide",
    sourceUrl: "https://workspace.google.com/resources/prompting/",
  },
  {
    id: "writing-case-study",
    category: WRITING,
    title: { en: "Customer case study", zh: "用户案例/故事写作" },
    description: {
      en: "Turn raw interview notes into a case study: background → challenge with numbers → why old ways failed → 3 key actions → before/after metrics → a quotable line. Missing material is marked, never invented.",
      zh: "把访谈原始素材整理成用户案例：背景→有数字的挑战→旧方案为何不行→3 个关键动作→前后对比指标→一句可引用原话。缺失素材标「待补」，绝不编造。",
    },
    tags: ["writing", "case-study", "案例", "故事", "marketing"],
    body: {
      en: `You are a case-study writer. Shape the raw material below into a customer case study:
- Structure: background and role → the challenge (specific, with numbers) → why the old approach failed → how the new one landed (3 key actions) → results (before/after metrics) → one quotable user line.
- Style: details over adjectives, numbers over adverbs; every claim traceable to the material.
- Never invent missing material — mark it as [to be filled: what is missing].
- Output: the full piece + a 100-word abstract + 3 candidate headlines.

Raw material:
{{interview notes / chat logs / transcribed data}}`,
      zh: `你是案例研究撰稿人。把下面的原始素材整理成一篇用户案例：
- 结构：背景与角色 → 遇到的挑战（具体、有数字）→ 为什么旧方案不行 → 新方案如何落地（3 个关键动作）→ 结果（前后对比指标）→ 一句可引用的用户原话；
- 写法：细节优先于形容词，数字优先于副词；每个论点都要有素材出处；
- 缺失的素材不要编，用【待补：缺什么】标注；
- 输出完整稿 + 100 字摘要 + 3 个候选标题。

原始素材：
{{访谈记录 / 聊天记录 / 数据截图的文字整理}}`,
    },
    source: "Google Workspace Prompting Guide",
    sourceUrl: "https://workspace.google.com/resources/prompting/",
  },

  // ------------------------------------------------------------------
  // 工程效率 (Engineering) — Chinese-first.
  // ------------------------------------------------------------------
  {
    id: "eng-code-review-strict",
    category: ENG,
    title: { en: "Strict code review", zh: "严格代码评审" },
    description: {
      en: "Priority-ordered review: correctness first (severity-tagged), then compatibility, testability, security — readability only where it hurts maintenance. Ends with a merge verdict, no fluff.",
      zh: "按优先级评审：正确性优先（标注严重程度），其次兼容性、可测试性、安全；可读性仅在影响维护时提。最后给合并结论，不客套、不复述代码。适用：PR 评审、自查 diff。",
    },
    tags: ["code-review", "评审", "pr", "质量", "engineering"],
    body: {
      en: `You are a strict senior reviewer. Review the change below in priority order:
1. Correctness: logic errors, edge cases, concurrency/async traps, resource leaks (tag each as severe / normal / suggestion).
2. Compatibility: are interface or data-structure changes backward compatible? What is the migration cost?
3. Testability: which branches lack coverage? Suggest concrete test cases.
4. Readability: only where it harms maintenance (misleading names, overlong functions, magic numbers) — no style nitpicks.
5. Security: injection, privilege escalation, sensitive-data exposure.
Output format per finding: location | severity | issue | concrete fix. End with a one-line verdict: merge / merge after fixes / rewrite. No pleasantries, no retelling what the code does.

Code / change:
{{paste the diff or code snippet}}`,
      zh: `你是严格的资深评审。按优先级审查下面的代码变更：
1. 正确性：逻辑错误、边界条件、并发/异步陷阱、资源泄漏（每条标注 严重/一般/建议）；
2. 兼容性：接口/数据结构变更是否向后兼容？迁移成本多大？
3. 可测试性：哪些分支缺少测试覆盖？给出具体用例建议；
4. 可读性：仅在影响维护时提出（命名误导、函数过长、魔法数），不纠结风格细节；
5. 安全：注入、越权、敏感信息泄露。
输出格式：每条「位置 | 级别 | 问题 | 具体修法」。最后给一句结论：可以合并 / 修改后合并 / 需要重写。不要客套话，不要复述代码做了什么。

代码/变更：
{{粘贴 diff 或代码片段}}`,
    },
    source: "GitHub Copilot Docs",
    sourceUrl: "https://docs.github.com/en/copilot",
  },
  {
    id: "eng-refactor-plan",
    category: ENG,
    title: { en: "Executable refactor plan", zh: "可执行重构方案" },
    description: {
      en: "Refactoring as a migration path, not a wish list: 3-5 top problems by maintenance cost, target structure, small independently-shippable steps (each compiles, tested, revertable), explicit non-goals, acceptance criteria.",
      zh: "把重构做成迁移路径而非愿望清单：按维护成本列 3-5 个最大问题、目标结构、可独立提交的小步（每步可编译可回滚）、明确不做什么、验收标准。",
    },
    tags: ["refactor", "重构", "架构", "plan", "engineering"],
    body: {
      en: `You are a refactoring advisor. Produce an executable plan for the code/module below:
1. Diagnosis: the 3-5 biggest problems ranked by maintenance cost — do not enumerate every code smell.
2. Target structure: the module layout and key interfaces after refactoring (one paragraph + a simple structure sketch).
3. Migration path: small independently-committable steps, each one compilable, testable and revertable, with risk and verification per step.
4. Explicit non-goals: what this refactor deliberately does NOT touch, and why.
5. Acceptance criteria: how we know it is done (behavior-preserving regression tests / performance baseline / all call sites migrated).

Constraints: {{time budget, whether public interfaces may change, whether a test net exists}}
Code / structure:
{{paste the code or module-structure description}}`,
      zh: `你是重构顾问。针对下面的代码/模块给出可执行的重构方案：
1. 现状诊断：用 3-5 条说清最大的问题（按维护成本排序），不要罗列所有坏味道；
2. 目标结构：重构后的模块划分与关键接口（一段文字 + 简单结构图）；
3. 迁移路径：拆成可独立提交的小步（每步可编译、可测试、可回滚），标注每步风险与验证方式；
4. 明确「不做什么」：本次重构明确不动的部分及理由；
5. 验收标准：怎样算重构完成（行为不变的回归测试 / 性能基准 / 调用方全部迁移）。

约束：{{时间预算、能否改对外接口、是否有测试网}}
代码/结构描述：
{{粘贴代码或模块结构说明}}`,
    },
    source: "GitHub Copilot Docs",
    sourceUrl: "https://docs.github.com/en/copilot",
  },
  {
    id: "eng-test-cases",
    category: ENG,
    title: { en: "Test matrix & case generation", zh: "测试用例生成" },
    description: {
      en: "From a function to a test matrix (happy path / boundaries / error paths / concurrency), then the 5-8 highest-value cases written in the project's own test-framework style, plus testability fixes.",
      zh: "先列测试矩阵（正常/边界/错误/并发），再按项目现有框架风格写出覆盖价值最高的 5-8 个用例，并指出让测试难写的实现问题与最小改造建议。",
    },
    tags: ["testing", "测试", "test-cases", "vitest", "engineering"],
    body: {
      en: `You are a test engineer. Design test cases for the function/module below:
1. Start with a test matrix: happy path / boundary values (empty, zero, max, overlong) / error paths (bad input, failing dependencies) / state and concurrency where applicable.
2. For each case: name, preconditions, input, expected result.
3. Write the actual code for the 5-8 highest-value cases, in the style of the project's existing test framework.
4. Point out what in the implementation makes testing hard (hidden dependencies, global state) and suggest the smallest change that fixes it.

Code under test:
{{paste the function or class}}
Test framework and conventions: {{e.g. "vitest, table-driven, in-memory fakes instead of DB mocks"}}`,
      zh: `你是测试工程师。为下面的函数/模块设计测试用例：
1. 先列出测试矩阵：正常路径 / 边界值（空、0、最大、超长）/ 错误路径（异常输入、外部依赖失败）/ 状态与并发（如适用）；
2. 每个用例给出：名称、前置条件、输入、预期结果；
3. 用项目现有测试框架的风格写出关键用例的代码（不必全写，挑覆盖价值最高的 5-8 个）；
4. 指出现有实现中让测试难写的点（隐藏依赖、全局状态），给出最小改造建议。

被测代码：
{{粘贴函数/类}}
测试框架与约定：{{如「vitest，表驱动，用内存实现替代数据库 mock」}}`,
    },
    source: "GitHub Copilot Docs",
    sourceUrl: "https://docs.github.com/en/copilot",
  },
  {
    id: "eng-commit-message",
    category: ENG,
    title: { en: "Conventional commit message", zh: "规范 commit 信息" },
    description: {
      en: "Conventional Commits from a diff: type(scope) + imperative subject ≤72 chars, a body about WHY not WHAT, BREAKING CHANGE flags, and a split suggestion when the change is really several commits.",
      zh: "从 diff 生成 Conventional Commits：type(scope) + ≤72 字符祈使句摘要，正文讲「为什么改」而非「改了什么」，标注 BREAKING CHANGE；改动该拆时先给拆分建议再分别写。",
    },
    tags: ["git", "commit", "提交信息", "conventional-commits", "engineering"],
    body: {
      en: `Write a Conventional Commits message for the change below:
- Subject: type(scope): imperative summary of at most 72 characters; pick the type from feat / fix / refactor / perf / test / docs / chore and say why if it is ambiguous.
- Body when needed: explain WHY the change, not WHAT changed (the diff already shows that); flag BREAKING CHANGE where applicable.
- If the change should really be several commits, first propose the split, then write a message for each part.
- Output 2 candidates: one concise, one detailed.

Change (diff or description):
{{paste the git diff or change description}}`,
      zh: `根据下面的改动内容，生成符合 Conventional Commits 的提交信息：
- 首行：type(scope): 祈使句摘要 ≤ 72 字符；type 从 feat/fix/refactor/perf/test/docs/chore 中选，拿不准就说明理由；
- 正文（如需要）：讲清「为什么改」而非「改了什么」（diff 已经能看到），并标注破坏性变更 BREAKING CHANGE；
- 如果改动其实该拆成多个提交，先给出拆分建议，再分别为每个提交写信息；
- 输出 2 个候选：一个简洁版，一个详细版。

改动内容（diff 或描述）：
{{粘贴 git diff / 改动描述}}`,
    },
    source: "Awesome ChatGPT Prompts",
    sourceUrl: "https://github.com/f/awesome-chatgpt-prompts",
  },
  {
    id: "eng-handoff-doc",
    category: ENG,
    title: { en: "Handoff package doc", zh: "交接文档（交接包结构）" },
    description: {
      en: "A handoff doc mirroring Vesti's handoff-package schema: goal, current state, key decisions, key files, failed paths, open issues, verification commands, next steps, and a paste-ready handoff prompt. Facts only, unknowns marked.",
      zh: "与 Vesti 交接包 schema 同构的交接文档：目标、现状、关键决策、关键文件、失败路径、未解问题、验证命令、下一步，外加一段可直接粘贴的交接提示词。只归纳事实，未知就标「未知」。",
    },
    tags: ["handoff", "交接", "文档", "onboarding", "engineering"],
    body: {
      en: `From the work log below, write a handoff document that gets a successor (human or AI) productive within 30 minutes. Follow this structure strictly:
1. Goal: what this work aims to achieve, one sentence.
2. Current state: what is done and where it stopped (at most 8 items).
3. Key decisions: each as "decision + reason" (at most 8).
4. Key files: path + why it matters + its current change state.
5. Failed paths: approaches tried and abandoned, with why they failed (so no one repeats them).
6. Open issues and risks.
7. Verification: commands that prove the work (build/test) and their last results.
8. Next steps: an action list ordered by priority.
9. Handoff prompt: a self-contained note of at most 200 words that can be pasted at the start of a new AI session.
Summarize only from the provided records; mark anything unknown as "unknown" — do not invent facts.

Work log:
{{paste conversation records, commit history, notes}}`,
      zh: `根据下面的工作记录，写一份让接手人（人或 AI）30 分钟内能上手的交接文档，严格按此结构：
1. 目标：这项工作要达成什么（一句话）；
2. 现状：已完成什么、进行到哪一步（至多 8 条）；
3. 关键决策：每条「决定 + 理由」（至多 8 条）；
4. 关键文件：路径 + 为什么重要 + 当前改动状态；
5. 失败路径：试过但放弃的方案 + 为什么失败（避免接手人重蹈覆辙）；
6. 未解问题与风险；
7. 验证方式：用于确认工作正确的命令（构建/测试）及最近一次结果；
8. 下一步：按优先级排序的行动清单；
9. 交接提示词：一段 ≤ 200 字、可直接粘贴到新 AI 会话开头的自包含交接说明。
只依据提供的记录归纳，不知道的就标注「未知」，不要补造事实。

工作记录：
{{粘贴会话记录、commit 历史、笔记}}`,
    },
    source: "Anthropic Prompt Library",
    sourceUrl: "https://docs.anthropic.com/en/prompt-library/library",
  },
];
