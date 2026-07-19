import { Component, type ErrorInfo, type ReactNode } from "react";
import { LOGO_BASE64 } from "../logo";

type Copy = {
  eyebrow: string;
  title: string;
  description: string;
  reload: string;
  copy: string;
  copied: string;
  details: string;
};

const copyByLanguage: Record<"zh" | "en" | "ja" | "ko", Copy> = {
  zh: {
    eyebrow: "界面恢复",
    title: "Vesti 遇到了显示问题",
    description: "你的本地数据没有丢失。请重新加载界面；如果问题再次发生，可复制诊断信息用于反馈。",
    reload: "重新加载",
    copy: "复制诊断信息",
    copied: "已复制",
    details: "错误详情",
  },
  en: {
    eyebrow: "UI recovery",
    title: "Vesti encountered a display problem",
    description: "Your local data is safe. Reload the interface, or copy the diagnostics if the problem happens again.",
    reload: "Reload",
    copy: "Copy diagnostics",
    copied: "Copied",
    details: "Error details",
  },
  ja: {
    eyebrow: "画面の復旧",
    title: "Vesti で表示上の問題が発生しました",
    description: "ローカルデータは失われていません。画面を再読み込みし、再発する場合は診断情報をコピーしてください。",
    reload: "再読み込み",
    copy: "診断情報をコピー",
    copied: "コピーしました",
    details: "エラーの詳細",
  },
  ko: {
    eyebrow: "화면 복구",
    title: "Vesti 화면에 문제가 발생했습니다",
    description: "로컬 데이터는 안전합니다. 화면을 다시 불러오고, 문제가 반복되면 진단 정보를 복사해 주세요.",
    reload: "다시 불러오기",
    copy: "진단 정보 복사",
    copied: "복사됨",
    details: "오류 세부 정보",
  },
};

function currentCopy(): Copy {
  const language = navigator.language.toLowerCase();
  if (language.startsWith("zh")) return copyByLanguage.zh;
  if (language.startsWith("ja")) return copyByLanguage.ja;
  if (language.startsWith("ko")) return copyByLanguage.ko;
  return copyByLanguage.en;
}

type Props = { children: ReactNode };
type State = { error: Error | null; componentStack: string; copied: boolean };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: "", copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, copied: false };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[vesti] renderer error", error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? "" });
  }

  private diagnostics() {
    const { error, componentStack } = this.state;
    return [
      `Vesti renderer error (${new Date().toISOString()})`,
      `${error?.name ?? "Error"}: ${error?.message ?? "Unknown error"}`,
      error?.stack ?? "",
      componentStack,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private copyDiagnostics = async () => {
    try {
      await navigator.clipboard.writeText(this.diagnostics());
      this.setState({ copied: true });
    } catch (error) {
      console.error("[vesti] failed to copy renderer diagnostics", error);
    }
  };

  render() {
    if (!this.state.error) return this.props.children;

    const copy = currentCopy();
    return (
      <main className="flex min-h-screen items-center justify-center bg-bg-primary px-6 py-10 text-text-primary">
        <section className="w-full max-w-2xl rounded-2xl border border-border-default bg-bg-surface-card p-7 shadow-lg">
          <div className="flex items-center gap-3">
            <img src={LOGO_BASE64} alt="" className="h-10 w-10" draggable={false} />
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-tertiary">{copy.eyebrow}</p>
              <h1 className="mt-1 font-serif text-2xl text-text-primary">{copy.title}</h1>
            </div>
          </div>
          <p className="mt-5 text-sm leading-6 text-text-secondary">{copy.description}</p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              className="rounded-lg bg-accent-primary px-4 py-2.5 text-sm font-semibold text-text-inverse transition-opacity hover:opacity-85"
              onClick={() => window.location.reload()}
            >
              {copy.reload}
            </button>
            <button
              type="button"
              className="rounded-lg border border-border-default bg-bg-secondary px-4 py-2.5 text-sm font-semibold text-text-primary hover:bg-bg-surface-card-hover"
              onClick={this.copyDiagnostics}
            >
              {this.state.copied ? copy.copied : copy.copy}
            </button>
          </div>
          <details className="mt-6 rounded-lg border border-border-subtle bg-bg-secondary p-3 text-xs text-text-secondary">
            <summary className="cursor-pointer font-semibold text-text-primary">{copy.details}</summary>
            <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono leading-5">
              {this.diagnostics()}
            </pre>
          </details>
        </section>
      </main>
    );
  }
}
