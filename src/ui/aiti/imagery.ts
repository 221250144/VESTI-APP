// AITI 思维意象 (P5): map the four locally-computed AITI axes onto one of 16
// fixed "thinking imageries" (type code → 意象名 + 出典 + 判词). Pure and
// locale-aware: resolveImagery returns the table entry plus the letter code and
// the list of weak-signal axes; localizeImagery projects it to the UI strings
// the @vesti/ui card consumes (type mirror: AitiImagery in packages/vesti-ui).
//
// Type code rules (fixed): depth≥50→D else q · maker≥50→M else T ·
// focus≥50→W else F · affect≥50→S else c. Letter order follows the axis order
// already used by the AitiCard type line: depth · maker · focus · affect.
// An axis is WEAK when it has no signal (hasSignal=false) or its score sits in
// the undecided band [45, 55]: the code still takes the pole, but the axis is
// reported so the UI can mark it "信号尚浅" and the whole imagery "轮廓尚浅".

import type { AitiAxisScore, AitiImagery } from "@vesti/ui";

export type AitiLocale = "zh" | "en";

export interface ImageryCopy {
  zh: string;
  en: string;
}

export interface ImageryEntry {
  /** letter type code, e.g. "DMFS" */
  code: string;
  /** emblem asset id; the PNG lives at src/ui/assets/emblems/<emblemId>.png */
  emblemId: string;
  name: ImageryCopy;
  origin: ImageryCopy;
  verdict: ImageryCopy;
}

export interface ResolvedImagery {
  entry: ImageryEntry;
  code: string;
  /** axis keys ("depth" | "maker" | "focus" | "affect") whose signal is faint */
  weakAxes: string[];
  /** true when any axis is weak — the imagery outline is "尚浅" */
  faint: boolean;
}

/** Undecided band: a score this close to 50 shouldn't be read as conviction. */
export const WEAK_BAND_LO = 45;
export const WEAK_BAND_HI = 55;

export const IMAGERY_TABLE: readonly ImageryEntry[] = [
  {
    code: "DMFS",
    emblemId: "jingwei-shadow",
    name: { zh: "精卫的影子", en: "Shadow of Jingwei" },
    origin: { zh: "《山海经》", en: "Classic of Mountains and Seas" },
    verdict: {
      zh: "日复一日，衔微木以填沧海——深度从不靠灵感，靠执念",
      en: "Day after day, small twigs carried toward a boundless sea — depth is never a gift of inspiration, only of quiet devotion.",
    },
  },
  {
    code: "DMFc",
    emblemId: "robinson-island",
    name: { zh: "鲁滨逊的荒岛", en: "Robinson's Island" },
    origin: { zh: "笛福《鲁滨逊漂流记》", en: "Defoe, Robinson Crusoe" },
    verdict: {
      zh: "一个人，一堆工具，从无到有——不动声色地，把一无所有建成应有尽有",
      en: "One castaway, a heap of tools, everything made from nothing — without a sound, an empty shore becomes a providence.",
    },
  },
  {
    code: "DMWS",
    emblemId: "siren-elegy",
    name: { zh: "塞壬的挽歌", en: "Siren's Elegy" },
    origin: { zh: "荷马《奥德赛》", en: "Homer, The Odyssey" },
    verdict: {
      zh: "被灵感的歌声蛊惑，甘愿把自己绑在桅杆上听到底——漫游，是另一种深潜",
      en: "Spellbound by the song of inspiration, gladly lashed to the mast to hear it through — wandering is another kind of deep dive.",
    },
  },
  {
    code: "DMWc",
    emblemId: "odysseus-ship",
    name: { zh: "奥德修斯的航船", en: "Odysseus's Ship" },
    origin: { zh: "荷马《奥德赛》", en: "Homer, The Odyssey" },
    verdict: {
      zh: "十年漂泊，千条航线——每一次迷航，都走成了归途",
      en: "Ten years adrift, a thousand routes — every wrong turning sailed its way home.",
    },
  },
  {
    code: "DTFS",
    emblemId: "happy-prince-heart",
    name: { zh: "快乐王子的铅心", en: "The Happy Prince's Leaden Heart" },
    origin: { zh: "王尔德《快乐王子》", en: "Wilde, The Happy Prince" },
    verdict: {
      zh: "看遍人间的苦难与微光，只为真正重要的事，碎裂一次",
      en: "Having seen all the sorrow and faint light of the world, the leaden heart breaks once — for what truly matters.",
    },
  },
  {
    code: "DTFc",
    emblemId: "plato-cave",
    name: { zh: "柏拉图的洞穴", en: "Plato's Cave" },
    origin: { zh: "柏拉图《理想国》", en: "Plato, Republic" },
    verdict: {
      zh: "墙上是影子，洞外才是光——所谓思考，是转身看见真实",
      en: "Shadows on the wall, sunlight beyond the cave — to think is to turn around and see the real.",
    },
  },
  {
    code: "DTWS",
    emblemId: "faust-study",
    name: { zh: "浮士德的书斋", en: "Faust's Study" },
    origin: { zh: "歌德《浮士德》", en: "Goethe, Faust" },
    verdict: {
      zh: "对知识永不餍足，灵魂为问题沸腾",
      en: "Never sated with knowledge, the soul keeps boiling with questions.",
    },
  },
  {
    code: "DTWc",
    emblemId: "hanshan-bell",
    name: { zh: "寒山寺的夜钟", en: "The Night Bell of Hanshan Temple" },
    origin: { zh: "张继《枫桥夜泊》", en: "Zhang Ji, Night Mooring at Maple Bridge" },
    verdict: {
      zh: "姑苏城外，夜半钟声——万籁俱寂时，听见问题本身",
      en: "Beyond Gusu's walls, a bell at midnight — when every sound falls away, the question itself is heard.",
    },
  },
  {
    code: "qMFS",
    emblemId: "gump-chocolate",
    name: { zh: "阿甘的巧克力", en: "Forrest's Chocolates" },
    origin: { zh: "《阿甘正传》", en: "Forrest Gump" },
    verdict: {
      zh: "巧克力未拆之前，味道都是想象——直接拆开它，便是答案",
      en: "Before the box is opened, every flavor is imagination — open it, and that is the answer.",
    },
  },
  {
    code: "qMFc",
    emblemId: "runtu-fork",
    name: { zh: "闰土的钢叉", en: "Runtu's Steel Fork" },
    origin: { zh: "鲁迅《故乡》", en: "Lu Xun, My Old Home" },
    verdict: {
      zh: "深蓝的天空下，手起叉落——专注的人，一击即中",
      en: "Under the deep blue sky, the fork rises and falls — the focused hand strikes once, and strikes home.",
    },
  },
  {
    code: "qMWS",
    emblemId: "pheidippides-run",
    name: { zh: "奔跑的菲迪皮茨", en: "Pheidippides Running" },
    origin: { zh: "古希腊马拉松", en: "The Marathon runner of ancient Greece" },
    verdict: {
      zh: "四十二公里的奔跑，只为把“成了”二字，第一个带回雅典",
      en: "Forty-two kilometers of running, only to carry the words “it is done” back to Athens first.",
    },
  },
  {
    code: "qMWc",
    emblemId: "gaixia-song",
    name: { zh: "垓下的楚歌", en: "Songs of Gaixia" },
    origin: { zh: "《史记·项羽本纪》", en: "Records of the Grand Historian, Annals of Xiang Yu" },
    verdict: {
      zh: "楚歌四面，剑气未冷——绝境之中，仍保留着清点残局的从容",
      en: "Chu songs on every side, the blade not yet cold — even at the end, the grace to count what remains.",
    },
  },
  {
    code: "qTFS",
    emblemId: "libai-cup",
    name: { zh: "李白的酒杯", en: "Li Bai's Wine Cup" },
    origin: { zh: "李白《月下独酌》", en: "Li Bai, Drinking Alone under the Moon" },
    verdict: {
      zh: "举杯邀明月，对影成三人——天地、灵感，与永不缺席的月光",
      en: "A cup raised to the bright moon makes three with the shadow — heaven, earth, inspiration, and moonlight that never fails to attend.",
    },
  },
  {
    code: "qTFc",
    emblemId: "sisyphus-boulder",
    name: { zh: "西西弗斯的巨石", en: "Sisyphus's Boulder" },
    origin: { zh: "希腊神话", en: "Greek myth" },
    verdict: {
      zh: "巨石滚落千次，便推起千次——众神看见徒劳，行者看见意义",
      en: "The boulder rolls down a thousand times, and a thousand times it is pushed — the gods see futility; the climber sees meaning.",
    },
  },
  {
    code: "qTWS",
    emblemId: "macondo-butterfly",
    name: { zh: "马孔多的蝴蝶", en: "Butterflies of Macondo" },
    origin: { zh: "《百年孤独》", en: "One Hundred Years of Solitude" },
    verdict: {
      zh: "黄色的蝴蝶成群而至——被纷飞的灵感环绕，所到之处皆绚烂",
      en: "Yellow butterflies arrive in swarms — surrounded by fluttering inspiration, wherever they settle turns brilliant.",
    },
  },
  {
    code: "qTWc",
    emblemId: "alice-rabbit-hole",
    name: { zh: "爱丽丝的兔子洞", en: "Alice's Rabbit Hole" },
    origin: { zh: "卡罗尔《爱丽丝漫游奇境》", en: "Carroll, Alice in Wonderland" },
    verdict: {
      zh: "随处一跃，便是新世界的入口——好奇心从不需要理由",
      en: "One leap anywhere is an entrance to a new world — curiosity never needs a reason.",
    },
  },
];

const BY_CODE = new Map(IMAGERY_TABLE.map((entry) => [entry.code, entry]));

/** Letter each axis contributes to the type code (pole taken at score ≥ 50). */
const AXIS_LETTERS: Record<string, [string, string]> = {
  depth: ["q", "D"],
  maker: ["T", "M"],
  focus: ["F", "W"],
  affect: ["c", "S"],
};
const AXIS_ORDER = ["depth", "maker", "focus", "affect"] as const;

/**
 * Resolve the 思维意象 for a computed axis set. Returns null when the axis set
 * isn't the expected four (card falls back to the plain type code). Weak axes
 * (no signal, or score inside [45, 55]) still take their pole for the code but
 * are listed so the UI can temper the reading.
 */
export function resolveImagery(axes: AitiAxisScore[]): ResolvedImagery | null {
  const byKey = new Map(axes.map((axis) => [axis.key, axis]));
  const letters: string[] = [];
  const weakAxes: string[] = [];
  for (const key of AXIS_ORDER) {
    const axis = byKey.get(key);
    const pair = AXIS_LETTERS[key];
    if (!axis || !pair || typeof axis.score !== "number") return null;
    letters.push(axis.score >= 50 ? pair[1] : pair[0]);
    if (
      axis.hasSignal === false ||
      (axis.score >= WEAK_BAND_LO && axis.score <= WEAK_BAND_HI)
    ) {
      weakAxes.push(key);
    }
  }
  const code = letters.join("");
  const entry = BY_CODE.get(code);
  if (!entry) return null;
  return { entry, code, weakAxes, faint: weakAxes.length > 0 };
}

/** Project a resolved imagery to the localized, flat shape the UI card takes. */
export function localizeImagery(resolved: ResolvedImagery, locale: AitiLocale): AitiImagery {
  const { entry } = resolved;
  return {
    code: resolved.code,
    emblemId: entry.emblemId,
    name: entry.name[locale],
    origin: entry.origin[locale],
    verdict: entry.verdict[locale],
    weakAxes: resolved.weakAxes,
    faint: resolved.faint,
  };
}
