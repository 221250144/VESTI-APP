// 记忆空间「梦境」公共面。

export { runDream } from "./dreamService";
export type {
  DreamMode,
  DreamProgress,
  DreamRunResult,
} from "./dreamService";
export {
  DREAM_AUTO_PREF_KEY,
  isDreamAutoEnabled,
  setDreamAutoEnabled,
  startDreamScheduler,
} from "./dreamScheduler";
