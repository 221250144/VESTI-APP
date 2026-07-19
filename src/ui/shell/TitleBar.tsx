import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import type { SupportedLocale } from "../i18n/locales";
import { LOGO_BASE64 } from "../logo";

// Localized title bar labels, kept next to the component (same pattern as the
// Dock and capsule dictionaries) so the shared translation files stay
// untouched.
const TITLE_BAR_COPY: Record<
  SupportedLocale,
  Record<"minimize" | "maximize" | "restore" | "close", string>
> = {
  en: { minimize: "Minimize", maximize: "Maximize", restore: "Restore", close: "Close" },
  zh: { minimize: "最小化", maximize: "最大化", restore: "还原", close: "关闭" },
  ja: { minimize: "最小化", maximize: "最大化", restore: "元に戻す", close: "閉じる" },
  ko: { minimize: "최소화", maximize: "최대화", restore: "복원", close: "닫기" },
};

const BUTTON_BASE =
  "flex h-full w-11 items-center justify-center text-text-secondary transition-colors [transition-duration:140ms] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-focus";

/**
 * Custom window title bar (P6a). The whole strip is an app-region drag area;
 * Windows/Linux get drawn min/max/close buttons, while macOS keeps its native
 * traffic lights (hiddenInset) over a 70px left inset and renders no buttons.
 */
export function TitleBar() {
  const { locale } = useI18n();
  const copy = TITLE_BAR_COPY[locale] ?? TITLE_BAR_COPY.en;
  const bridge = typeof window !== "undefined" ? window.vestiWindow : undefined;
  const isMac = bridge?.platform === "darwin";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    void bridge.isMaximized().then(setMaximized).catch(() => {});
    return bridge.onMaximizedChanged(setMaximized);
  }, [bridge]);

  const handleDoubleClick = (event: React.MouseEvent) => {
    if (isMac) return; // macOS applies its own title-bar double-click behavior.
    if ((event.target as HTMLElement).closest("button")) return;
    bridge?.toggleMaximize();
  };

  return (
    <header
      onDoubleClick={handleDoubleClick}
      className="flex h-10 shrink-0 select-none items-center border-b border-border-subtle bg-bg-app [-webkit-app-region:drag]"
    >
      {isMac && <div className="w-[70px] shrink-0" aria-hidden="true" />}
      <div className="flex min-w-0 flex-1 items-center gap-2 px-3">
        <img src={LOGO_BASE64} alt="" className="h-4 w-4" draggable={false} />
        <span className="truncate font-vesti-serif text-vesti-base font-semibold text-text-secondary">
          Vesti
        </span>
      </div>
      {!isMac && (
        <div className="flex h-full shrink-0 items-center [-webkit-app-region:no-drag]">
          <button
            type="button"
            aria-label={copy.minimize}
            onClick={() => bridge?.minimize()}
            className={`${BUTTON_BASE} hover:bg-accent-primary-light hover:text-text-primary`}
          >
            <Minus className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label={maximized ? copy.restore : copy.maximize}
            onClick={() => bridge?.toggleMaximize()}
            className={`${BUTTON_BASE} hover:bg-accent-primary-light hover:text-text-primary`}
          >
            {maximized ? (
              <Copy className="h-4 w-4" strokeWidth={1.75} />
            ) : (
              <Square className="h-4 w-4" strokeWidth={1.75} />
            )}
          </button>
          <button
            type="button"
            aria-label={copy.close}
            onClick={() => bridge?.close()}
            className={`${BUTTON_BASE} hover:bg-danger hover:text-text-inverse`}
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      )}
    </header>
  );
}
