# Vesti i18n 术语表（en / ja / ko）

本表是 VESTI-APP 日语（ja）与韩语（ko）UI 文案的发布级审校基准。修改或新增 ja/ko 文案时，先查本表；新增术语请补进表中再使用。

适用范围：`src/ui/i18n/translations/{ja,ko,desktopCompletions}.ts`、`src/ui/shell/{SettingsPage,Dock,HomeDashboard}.tsx`、`src/ui/membership/copy.ts` 等组件内嵌 COPY 的 ja/ko 段。

## 一、核心术语对照

| English | 日本語 | 한국어 | 备注 |
|---|---|---|---|
| session | セッション | 세션 | CLI/桌面端工作单元 |
| conversation | 会話 | 대화 | 浏览/分析的对话本体 |
| capture（动词/名词） | キャプチャ | 캡처 | **禁用**：収集・取得 / 수집。例外：隐私同意书「收集/不收集什么」章节对应 en "collect"，保留 収集 / 수집 |
| knowledge graph | ナレッジグラフ | 지식 그래프 | 标签名禁用：ネットワーク / 네트워크 |
| Memory Space | メモリースペース | 메모리 공간 | 禁用：メモリー空間 / 메모리 스페이스 |
| deposit（名词） | ナレッジ | 지식 문서 | 禁用：デポジット / 디파짓・침전 |
| distill | 蒸留 | 정제 | 禁用：증류 |
| dream | 夢 | 꿈 | |
| Night Talk | 夜話 | 밤의 대화 | |
| roundtable | 円卓会議 | 원탁회의 | 界面内短标签可用 円卓 / 원탁 |
| credits | クレジット | 크레딧 | |
| free tier | 無料版 | 무료 버전 | |
| BYOK | BYOK | BYOK | 保留拉丁缩写 |
| embedding | 埋め込み | 임베딩 | |
| recall | リコール | 리콜 | embeddingModelHint 语境；禁译「召回」等中文残留 |
| data contribution | データ貢献 | 데이터 기여 | |
| capsule / floating ball | フローティングボール | 플로팅 볼 | |
| topic | トピック | 주제 | ko 统一用 주제，**弃 토픽** |
| agent | エージェント | 에이전트 | **禁用拉丁 "Agent"**；键名（如 askAgentPlaceholder）除外 |
| token | トークン | 토큰 | 例外：Notion "Integration Token" 为字段名，保留拉丁 |
| domain（学习领域） | 分野 | 도메인 | 禁用：領域 / 영역 |
| AITI imagery / portrait | イメージ | 이미지 | 禁用：肖像・人物像・画像 / 초상・프로필 |
| signal | シグナル | 신호 | |
| personas（夜话人格） | リスナー / クリエイター | 리스너 / 크리에이터 | 禁用：傾聴者・創造者 / 경청자・창작자 |
| memory server (vesti-mcp) | メモリーサーバー | 메모리 서버 | 禁用：記憶サーバー |
| export | エクスポート | 내보내기 | |
| summary | サマリー / 要約 | 요약 | ja 两种写法历史上混在，本次**容认并存**（见「存疑与容认」）；ko 统一 요약 |
| browser | ブラウザ | 브라우저 | 禁用：ブラウザー（长音） |
| folder | フォルダ | 폴더 | 禁用：フォルダー（长音） |
| filter | フィルタ | 필터 | 禁用：フィルター |

## 二、文体与敬体

- **ja**：です・ます調。名词结尾的短标签（按钮/标签）可体言止め。
- **ko**：합니다체。**禁用 해요체**（如 ~있어요、~못했어요 → ~있습니다、~못했습니다）。

## 三、标点与字形

| 项 | ja | ko |
|---|---|---|
| 冒号 | 全角「：」 | 半角「: 」（带空格） |
| 括号 | 全角（） | 半角 () |
| 省略号 | U+2026「…」单一字符 | 同左 |
| 强调引号 | 「」 | 「」（禁用 ''、""、''） |
| 破折号 | 禁用中文式「——」，改用句号或括弧 | 同左，句中可用「 — 」（en 风格，前后空格） |
| 日期/数字 | 「直近 30 日」半角空格 | 「최근 30일」无空格 |

- 占位符 `{count}` `{n}` `{version}` `{label}` 等必须原样保留，不得增删空格或改写。
- ja/ko 文案中出现的「Integration Token」「Base URL」「Page ID / Database ID」等产品字段名保留拉丁原文。

## 四、存疑与容认（本次审校有意保留）

1. **ja「サマリー / 要約」混在**：library/explore 区历史形成（サマリーを生成 / 要約を読み込み中 等），语义无歧义，本次容认并存，后续版本可再统一。
2. **prompts.markFavorite**：ja「お気に入りに登録（常用）」保留 en 源自带的「常用」二字，属 en 原文风格直译。
3. **SplashIntro ja 标语**：为意译（非逐字对译），发布审校认为语气优于直译，保留。
4. **daily catchUp**：ja「{count} 日分をまとめて生成」、ko「{count}일 보완」，与 en "catch up N days" 语义对应但措辞各自自然化；trial 的「3か月 / 3개월」写法保留现状。
5. **隐私同意书章节的 収集 / 수집**：对应 en "collect"（数据贡献语境），与 capture 功能术语无关，有意保留。

## 五、维护说明

- en.ts 为基准（source of truth）。新增键时 ja/ko 必须同 PR 补齐，`src/ui/i18n/translations/coverage.test.ts` 会校验键齐合。
- 审校时同时检查组件内嵌 COPY（SettingsPage.tsx 的 `COPY` 常量、membership/copy.ts、Dock.tsx、HomeDashboard.tsx），它们不经 translations 目录。
