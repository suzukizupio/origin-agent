import type { AgentMode, ToolCall } from "./types.ts";

export type ResearchTopic = { subjects: string[] };
export type ResearchRoute = {
  firstCall?: Pick<ToolCall, "name" | "args">;
  allowWeb: boolean;
  research: boolean;
  readSource?: boolean;
  additionalSearches?: string[];
  topic?: ResearchTopic;
  clarification?: string;
  resolvedQuestion?: string;
  comparison?: { subjects: string[]; metric: "面積" | "人口" };
  focus?: string[];
};

// 3B の記憶は「つくばみらい市は広島県」と答える程度なので、世の中の固有の事実を記憶に任せない。
// 以前は「〜ってどこ」のような決まった言い方だけを拾っていたため、採点課題の文面は検索に回るのに、
// 「〜ってどんな場所？」と言い換えると記憶で答えて捏造した。
// そこで言い回しではなく、「固有の対象について聞いているか」「人物について聞いているか」で判断する。
// 判定の良し悪しは scripts/eval-route.ts で、言い換えを含む質問集（tune / holdout）に対して測る。

const OPT_OUT = /検索(?:しない|しなくて|せず|不要)|調べなくて|ネット(?:を|は)?使わ(?:ない|ず)|オフラインで/;
const EXPLICIT = /(?:ネット|インターネット|web|ウェブ).*(?:調べ|検索)|(?:調べて|調査して)/i;
/** ユーザー自身や会話の内容。検索しても答えは無く、個人の情報を検索語に混ぜることにもなる */
const ABOUT_USER = /私(?:の|は|が|を|に)|わたし(?:の|は|が)|僕(?:の|は|が)|自分(?:の|は|が)|さっき|先ほど|今の話/;
/** code モードで、コードベースについて聞いている印。「関数はどこ？」を地名の質問と取り違えない */
const ABOUT_CODE = /関数|メソッド|クラス|変数|ファイル|フォルダ|ディレクトリ|コード|テスト|実装|定義|リポジトリ|プロジェクト|エラー|バグ|引数|[\w-]+\.[a-z]{1,5}\b|\bsrc\//i;
/** 答えるには調べる必要がある、移ろう情報 */
const CURRENT_TOPIC = /時刻表|運行状況|運賃|営業時間|休業日|天気|気温|株価|為替|ニュース|最新|人口/;
/** 移ろう情報の「言葉の意味」を聞いているだけなら、調べなくてよい */
const DEFINITION = /(?:時刻表|運賃|天気|気温|株価|為替)(?:って|とは)(?:何|どういう|\s*$)|(?:の意味|の仕組み)/;
/**
 * 地名・施設など固有の対象。語尾で見分ける。
 * 前半に「の」「は」を含めないのは、「今日は富士山に…」の「今日は富士山」を対象名にしないため。
 */
const PLACE = /([\p{Script=Han}\p{Script=Katakana}ーぁ-ねば-ゖ]+?(?:市|区|町|村|県|府|都|道|駅|空港|港|大学|高校|山|岳|川|湖|島|寺|神社|城|公園|タワー|博物館|美術館|水族館|動物園|病院))(?=について|って|とは|は|の|から|に|へ|で|を|[?？]|$)/u;
/** 場所そのものを尋ねる言い方。公式サイトの概要を読むのが確実 */
const WHERE = /どこ|場所|ところ|所在地|住所|位置|何県|どの県|アクセス|行き方/;
/** 場所以外の事実を尋ねる言い方。検索語に添える */
const ATTRIBUTE = /人口|高さ|標高|面積|広さ|長さ|深さ|いつ|何年|創業|設立|完成|建設|歴史|由来|特徴|名物|観光|有名/;
/** 人物について尋ねる言い方 */
const PERSON = /どんな人|何をした人|って誰|は誰/;
/** 質問・依頼の印 */
const REQUEST = /[?？]|教えて|知りたい|について|どんな|何|いつ|誰|どこ|いくら|ですか/;

function toQuery(input: string): string {
  const query = input.replace(/(?:インターネット|ネット|ウェブ|web)で/gi, " ")
    .replace(/(?:調べて|検索して|教えて|ください|下さい|もらえますか|教えてください)[。！？?\s]*/g, " ").trim();
  return query || input;
}

// 答えの表ではなく、比較時に「県」と「市」を混ぜないための名前の辞書。
const PREFECTURES = ("北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県").split(" ");
function prefecture(name: string): string | undefined {
  return PREFECTURES.find((full) => name === full || (full !== "北海道" && name === full.slice(0, -1)));
}

function comparisonSubjects(input: string): string[] | undefined {
  if (!/どっち|どちら|比較|比べ/.test(input)) return;
  const match = input.match(/^([\p{L}\dー・]{1,30})\s*と\s*([\p{L}\dー・]{1,30}?)(?=って|では|は|だと|の|を|、|どっち|どちら|\s)/u);
  if (!match) return;
  const names = [match[1]!, match[2]!];
  if (names.some((name) => /^(これ|それ|あれ|ここ|そこ|どこ|あなた|私|僕)$/.test(name))) return;
  return names;
}

function topicRoute(subjects: string[], attribute: string, input: string): ResearchRoute {
  const queries = subjects.map((subject) => `${subject} ${attribute} 公式`);
  return {
    allowWeb: true, research: true, readSource: true, topic: { subjects },
    focus: attribute.split(" "),
    firstCall: { name: "web_search", args: { query: queries[0]!, limit: 5 } },
    additionalSearches: queries.slice(1),
    ...(subjects.length === 2 && /^(面積|広さ|人口)$/.test(attribute) ? { comparison: { subjects, metric: attribute === "人口" ? "人口" as const : "面積" as const } } : {}),
    resolvedQuestion: `${input}\n今回調べる対象: ${subjects.join("と")}。確認する項目: ${attribute}。${subjects.length > 1 ? "同じ単位・同じ時点の数値を比べ、どちらかを名前で答えてください。両方の資料がそろわなければ比較は未確認としてください。" : ""}`,
  };
}

/** 直前の返答の短縮・整形だけを判定する。新しい対象・条件・調査依頼は取り込まない。 */
export function isReplyRewrite(input: string): boolean {
  const text = input.trim().normalize("NFKC");
  if (text.length > 120) return false;
  return /^(?:(?:それ|これ|(?:その|前の|直前の|さっきの|今の)(?:回答|返答|説明))(?:を|は)?\s*)?(?:(?:もう少し|もっと)\s*)?(?:(?:短く|簡潔に|わかりやすく|分かりやすく|やさしく)(?:して|説明して|言い換えて|まとめて|答えて)|(?:箇条書き|表)(?:にして|でまとめて)|[1-9]\d?(?:文|行)で(?:まとめて|答えて|説明して))(?:ください)?[。！!？?\s]*$/.test(text);
}

/** モデルが検索を選び損ねやすい質問を補助する。個人の記憶は検索語に混ぜない。 */
export function researchRoute(input: string, mode: AgentMode, previous?: ResearchTopic): ResearchRoute {
  const none: ResearchRoute = { allowWeb: true, research: false };
  if (OPT_OUT.test(input)) return { allowWeb: false, research: false };

  const explicit = EXPLICIT.test(input);
  if (mode === "code" && ABOUT_CODE.test(input) && !explicit) return none;
  if (ABOUT_USER.test(input) && !explicit) return none;

  const url = input.match(/https?:\/\/[^\s「」<>]+/)?.[0]?.replace(/[。！？、)）]+$/, "");
  if (url && /読んで|要約|調べ|見て|説明/.test(input)) {
    return { allowWeb: true, research: true, firstCall: { name: "web_fetch", args: { url } } };
  }

  // 短い続きの質問だけに、直前にユーザーが挙げた公開の対象名を補う。
  // 会話全体や個人の記憶を検索サービスへ送らない。
  const followup = input.match(/^(?:(?:では|じゃあ|それでは|ちなみに)[、,\s]*)?(?:その|それぞれの)?(面積|広さ|人口|高さ|標高|長さ|深さ)(?:(?:は|も|で|を|について)?(?:どうですか|どう|どっちが大きい|どちらが大きい|教えて(?:ください)?|比べて|お願いします)?)?[。！？?\s]*$/);
  if (followup) {
    return previous ? topicRoute(previous.subjects, followup[1]!, input) : {
      ...none, clarification: `何の${followup[1]}を知りたいですか？ 比べる場合は、両方の名前を教えてください。`,
    };
  }

  if (!ABOUT_CODE.test(input)) {
    const pair = comparisonSubjects(input);
    if (pair) {
      const fullNames = pair.map(prefecture);
      const subjects = fullNames.every(Boolean) ? fullNames as string[] : pair;
      const attribute = input.match(ATTRIBUTE)?.[0];
      if (attribute) return topicRoute(subjects, attribute, input);
      if (/大き|広い|多い/.test(input) && (fullNames.every(Boolean) || pair.every((name) => /[県府都道市区町村国島湖海山]$/.test(name)))) {
        return { ...none, topic: { subjects }, clarification: `${subjects.join("と")}を比べますね。「大きい」は、面積と人口のどちらを知りたいですか？` };
      }
    }
    // 「大阪ってどこ」のように、地名の末尾の「府」「市」が省略されても拾う。
    const bare = input.match(/^([\p{L}\dー・]{1,35}?)(?:って|とは|は|の)(?=どこ|どんな場所|何県|所在地|位置|面積|広さ|人口|高さ|標高)/u)?.[1];
    if (bare && !/^(これ|それ|あれ|ここ|そこ|どこ|あなた)$/.test(bare)) {
      return topicRoute([bare], input.match(ATTRIBUTE)?.[0] ?? (/どんな場所/.test(input) ? "概要 特徴 位置" : "何地方 位置"), input);
    }
  }

  const current = CURRENT_TOPIC.test(input) && REQUEST.test(input) && !DEFINITION.test(input);
  if (explicit || current) {
    const timetable = /時刻表/.test(input);
    const query = toQuery(input);
    return { allowWeb: true, research: true, readSource: timetable, firstCall: { name: "web_search", args: { query: timetable ? `${query} 公式` : query } } };
  }

  // 固有の対象について何か聞いていれば、言い回しに関わらず調べる
  const place = input.match(PLACE)?.[1];
  if (place !== undefined && REQUEST.test(input)) {
    const attribute = input.match(ATTRIBUTE)?.[0];
    const query = attribute !== undefined && !WHERE.test(input)
      ? `${place} ${attribute}`
      : `${place} 公式 ${/[市区町村県]$/.test(place) ? "概要 位置" : "所在地"}`;
    return { allowWeb: true, research: true, readSource: true, topic: { subjects: [place] }, firstCall: { name: "web_search", args: { query } } };
  }

  if (PERSON.test(input)) {
    return { allowWeb: true, research: true, firstCall: { name: "web_search", args: { query: toQuery(input) } } };
  }

  return none;
}
