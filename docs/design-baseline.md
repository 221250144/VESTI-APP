# Vesti Desktop 设计基线(Design Baseline)

参照 Notion(克制的配色、清晰的排版层级、慷慨的留白)与 Obsidian(明确的面板层次、可靠的焦点态、顺滑的微动效)的设计原则,落到本项目的可检查规则。Phase 4 的每轮设计评审以此为准。

## 1. 排版(Typography)

- 字体阶梯:正文 UI 用 `--font-ui`(Vesti Sans UI);阅读性长文(笔记编辑器、Markdown 正文)可用衬线;标题层级只用 `font-serif` 的 18–24px 区间 + `font-sans` 的 11–13px eyebrow(大写、字距 0.14–0.18em、`text-text-tertiary`)。
- 字号只允许出现在既定刻度上:11/12/13/14/16/18/22px(对应 tailwind.config 的 vesti-* 刻度);禁止任意像素值。
- 行高:正文 1.5–1.65;标题 1.3;eyebrow 1.3。
- 单行文本溢出必须有省略号(truncate);中文与英文混排不截断词中字符。
- 对比层次:主标题 `text-text-primary`、正文 `text-text-primary/secondary`、辅助与占位 `text-text-tertiary`,不允许出现第四种灰色。

## 2. 色彩与对比度(Color & Contrast)

- 只允许使用 tokens.css 的语义色(`bg-*`、`text-*`、`border-*`、`accent-*`、平台徽章色);禁止新增硬编码 hex(平台徽章与图表色板除外,须在既有调色板内)。
- 正文对比度 ≥ 4.5:1;大字号(≥18px)与图标 ≥ 3:1;禁用态可降低但不得用于关键操作。
- 强调色 `accent-primary` 只用于:主按钮、激活态、关键链接、focus ring;同一屏内强调色填充块不超过 2 处。
- 暗色模式所有 surface、边框、文字必须使用 `.dark` token 对应值,不允许"看起来差不多"的近似色;暗色下阴影减弱、边框提亮。

## 3. 间距、密度与对齐(Spacing & Layout)

- 间距走 4px 网格:组件内边距 8/12/16/24,卡片内边距 16–24,区块间距 24–32;禁止 7px/13px 这类破网格值。
- 卡片圆角:容器 12–16px(`rounded-card`=16),按钮/输入 8–12px,徽章 full;同一层级圆角一致。
- 对齐:列表项的图标、标题、次级信息、尾部操作必须在同一基线网格;侧边栏分组标题左对齐到同一 x 位置。
- 空态必须有内容:图标/插画 + 一句话标题 + 一句引导文案,不允许空白区域。

## 4. 层级与面板(Elevation & Panels)

- 层级最多三层:app 背景(`bg-bg-app`)→ 卡片(`bg-bg-surface-card`)→ 浮层(popover/tooltip,带 `shadow-popover`)。
- 分隔优先用 1px `border-border-subtle`,阴影只做浮层;避免大面积阴影块。
- 当前选中项(导航、列表)必须有可见的选中处理(底色 `bg-accent-primary-light` 或边框),与 hover 态区分。

## 5. 动效与交互反馈(Motion & Feedback)

- 时长:hover 100–160ms;面板开合 180–240ms;只动 `transform`/`opacity`/`background-color`,禁止 layout 属性动画。
- 缓动:ease-out 为主;禁止 linear 用于 hover。
- 所有可点击元素必须有:hover 反馈、`:focus-visible` 焦点环(`ring-border-focus`)、active/按下反馈;禁用态视觉上明确。
- 异步操作必须有进行中状态(按钮文案/旋转/骨架),失败必须给出错误文案而不是静默。

## 6. 图标与图形(Iconography)

- 图标统一 lucide-react,strokeWidth 1.75,尺寸 16/20px 两档;禁止 emoji 当功能图标。
- 平台徽章用 `getPlatformBadgeStyle` 的输出,不手写颜色。

## 7. 可访问性(A11y)

- 图标按钮必须有 aria-label;当前导航项 `aria-current="page"`;弹层有 role 与 Esc 关闭。
- 键盘可达:Tab 顺序合理,焦点不丢失。
