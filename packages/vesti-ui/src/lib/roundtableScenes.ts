// 场景模板 (Roundtable): one-click seat lineups for the common uses —
// reviewing a technical plan, getting a study question answered, and
// stress-testing a decision. Pure data + a selection matcher; the panel
// applies localized names.

import type { RoundtablePersonaId } from "../types";

export type RoundtableSeatId = Exclude<RoundtablePersonaId, "moderator">;

export type RoundtableSceneId = "tech_review" | "study_qa" | "decision_debate";

export interface RoundtableScene {
  id: RoundtableSceneId;
  seats: readonly RoundtableSeatId[];
}

/** Seat lineups per scene. 学习答疑 stays at two seats on purpose — a Q&A
 * doesn't need a debate, and fewer seats means a faster answer. */
export const ROUNDTABLE_SCENES: readonly RoundtableScene[] = [
  { id: "tech_review", seats: ["domain_expert", "skeptic", "pragmatist"] },
  { id: "study_qa", seats: ["domain_expert", "pragmatist"] },
  { id: "decision_debate", seats: ["optimist", "skeptic", "devils_advocate", "pragmatist"] },
];

/** Whether the current selection is exactly this scene's lineup (order
 * doesn't matter — toggling seats reorders the selection array). */
export function sceneMatchesSelection(
  scene: RoundtableScene,
  selection: readonly RoundtableSeatId[],
): boolean {
  if (scene.seats.length !== selection.length) return false;
  const picked = new Set(selection);
  return scene.seats.every((seat) => picked.has(seat));
}
