// 「検索に回すか」の判定を、言い換えに対して採点するための質問集。
//
// 方針
//   検索に回す … 地名・人物・組織・作品などの固有の事実、数値や日付、最新の情報。
//                3B の記憶は「つくばみらい市は広島県」と答える程度なので、ここを記憶に任せない。
//   検索しない … 挨拶や雑談、ユーザー自身や会話の内容、一般的な概念の説明、話し方の指示、計算、
//                code モードではコードベースについての質問。
//
// tune と holdout に分けてある。
//   tune    … 判定を直すときに見てよい。失敗を見ながら規則を変える。
//   holdout … 判定を直している間は見ない・走らせない。直し終わってから1回だけ走らせて、
//             tune で上がった成績が、見ていない言い回しにも通用するかを確かめる。
//
// holdout の失敗を見て規則を直したら、その質問はもう holdout ではない。tune に移すこと。
// 新しい holdout は、判定を直す人とは別の人（理想はユーザー本人）が足すのが一番よい。
//
// この版の holdout は、判定の規則を書き換える前に書いて固定した。
// ただし書いたのは規則を直す本人（Claude）なので、ユーザーが足した質問より甘い可能性がある。

import type { AgentMode } from "../src/types.ts";

export type RouteCase = {
  input: string;
  mode: AgentMode;
  /** search: 検索に回すべき / direct: 検索せずに答えるべき */
  expect: "search" | "direct";
  /** 検索するとき、検索語に含まれているべき語 */
  queryIncludes?: string;
  /** なぜその期待なのか。境界の判断を後から見直せるように */
  note?: string;
};

export const tune: RouteCase[] = [
  // --- chat: 検索に回すべき ---
  { mode: "chat", expect: "search", input: "つくばみらい市ってどこですか？", queryIncludes: "つくばみらい市", note: "採点課題の文面" },
  { mode: "chat", expect: "search", input: "つくばみらい市ってどんな場所？", queryIncludes: "つくばみらい市", note: "実機で広島県と捏造した質問" },
  { mode: "chat", expect: "search", input: "つくばみらい市について教えて", queryIncludes: "つくばみらい市" },
  { mode: "chat", expect: "search", input: "松本市は何県ですか？", queryIncludes: "松本市", note: "既存テスト" },
  { mode: "chat", expect: "search", input: "富士山の高さは？", queryIncludes: "富士山" },
  { mode: "chat", expect: "search", input: "今日の東京の天気を教えて", queryIncludes: "東京" },
  { mode: "chat", expect: "search", input: "東京タワーはいつできたの？", queryIncludes: "東京タワー" },
  { mode: "chat", expect: "search", input: "徳川家康ってどんな人？", queryIncludes: "徳川家康" },
  { mode: "chat", expect: "search", input: "みらい平駅の時刻表を教えてください。", queryIncludes: "みらい平駅" },

  // --- chat: 検索しないべき ---
  { mode: "chat", expect: "direct", input: "こんにちは" },
  { mode: "chat", expect: "direct", input: "聞こえていますか？" },
  { mode: "chat", expect: "direct", input: "私の名前は何ですか？", note: "ユーザー自身のこと" },
  { mode: "chat", expect: "direct", input: "天気とは何ですか？", note: "一般的な概念の説明。既存テスト" },
  { mode: "chat", expect: "direct", input: "JavaScriptの変数を初心者向けに説明して", note: "一般的な概念の説明" },
  { mode: "chat", expect: "direct", input: "ありがとう、助かりました" },
  { mode: "chat", expect: "direct", input: "2たす3は？", note: "計算" },
  { mode: "chat", expect: "direct", input: "短く答えてほしいです", note: "話し方の指示" },

  // --- code: コードの話は検索しない、世の中の事実は検索する ---
  { mode: "code", expect: "direct", input: "greet 関数はどこで定義されていますか？", note: "「どこ」でもコードベースの質問" },
  { mode: "code", expect: "direct", input: "時刻表を表示するコードを書いて", note: "既存テスト" },
  { mode: "code", expect: "direct", input: "config.json の port を 4000 にして" },
  { mode: "code", expect: "search", input: "つくばみらい市ってどんな場所？", queryIncludes: "つくばみらい市", note: "実機で捏造した質問。モードはcodeだった" },
  { mode: "code", expect: "search", input: "TypeScript の最新バージョンを調べて", queryIncludes: "TypeScript" },
];

export const holdout: RouteCase[] = [
  // --- chat: 検索に回すべき ---
  { mode: "chat", expect: "search", input: "筑波山について知りたい", queryIncludes: "筑波山" },
  { mode: "chat", expect: "search", input: "茨城県の県庁所在地は？", queryIncludes: "茨城県" },
  { mode: "chat", expect: "search", input: "坂本龍馬は何をした人ですか", queryIncludes: "坂本龍馬" },
  { mode: "chat", expect: "search", input: "イチローの通算安打数は？", queryIncludes: "イチロー" },
  { mode: "chat", expect: "search", input: "Node.js の最新バージョンは？", queryIncludes: "Node.js" },
  { mode: "chat", expect: "search", input: "金閣寺ってどんなところ？", queryIncludes: "金閣寺" },
  { mode: "chat", expect: "search", input: "横浜駅から近い観光地はある？", queryIncludes: "横浜駅" },
  { mode: "chat", expect: "search", input: "北海道の面積ってどれくらい？", queryIncludes: "北海道" },

  // --- chat: 検索しないべき ---
  { mode: "chat", expect: "direct", input: "おはようございます" },
  { mode: "chat", expect: "direct", input: "さっき私が何て言ったか覚えてる？", note: "会話の内容" },
  { mode: "chat", expect: "direct", input: "もう少し詳しく説明して", note: "直前の続き" },
  { mode: "chat", expect: "direct", input: "配列とオブジェクトの違いを教えて", note: "一般的な概念の説明" },
  { mode: "chat", expect: "direct", input: "今日はちょっと疲れました", note: "雑談" },
  { mode: "chat", expect: "direct", input: "TypeScriptとJavaScriptの違いは？", note: "固有名詞を含むが一般的な概念の説明。境界" },
  { mode: "chat", expect: "direct", input: "おすすめの勉強方法ある？", note: "一般的な助言" },

  // --- code ---
  { mode: "code", expect: "direct", input: "テストファイルはどこにありますか？" },
  { mode: "code", expect: "direct", input: "src/agent.ts の run 関数を説明して" },
  { mode: "code", expect: "direct", input: "この関数の名前をもっと分かりやすくしたい" },
  { mode: "code", expect: "search", input: "富士山の標高を教えて", queryIncludes: "富士山" },
  { mode: "code", expect: "search", input: "東京駅の住所は？", queryIncludes: "東京駅" },
];
