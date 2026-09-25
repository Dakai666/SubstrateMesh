/**
 * 個人規模的關鍵字檢索：CJK 單字 + 二字組、拉丁字詞輕度詞形還原、
 * 常用簡繁對照正規化，以 BM25 計分。不需要外部依賴或索引檔。
 */

// 常用簡體 → 繁體（只收一對一、不易歧義的字；髮/發、後/后、乾/幹 等刻意不收）
const S2T_PAIRS =
  "爱愛 罢罷 备備 贝貝 笔筆 边邊 变變 标標 别別 宾賓 补補 参參 层層 产產 长長 尝嘗 场場 车車 陈陳 称稱 " +
  "诚誠 迟遲 虫蟲 处處 传傳 创創 词詞 从從 错錯 达達 带帶 单單 当當 党黨 导導 灯燈 递遞 点點 电電 调調 " +
  "东東 动動 冻凍 独獨 读讀 断斷 队隊 对對 顿頓 夺奪 儿兒 尔爾 发發 饭飯 访訪 飞飛 费費 纷紛 风風 丰豐 " +
  "妇婦 负負 该該 盖蓋 赶趕 刚剛 纲綱 钢鋼 个個 给給 贡貢 沟溝 构構 购購 够夠 顾顧 关關 观觀 馆館 惯慣 " +
  "广廣 归歸 规規 贵貴 国國 过過 还還 汉漢 号號 华華 画畫 话話 坏壞 欢歡 环環 换換 会會 汇匯 获獲 货貨 " +
  "祸禍 机機 积積 击擊 极極 级級 际際 计計 记記 纪紀 济濟 继繼 价價 驾駕 坚堅 间間 简簡 见見 键鍵 渐漸 " +
  "践踐 将將 奖獎 讲講 较較 阶階 节節 结結 洁潔 紧緊 进進 尽盡 经經 惊驚 静靜 镜鏡 旧舊 举舉 剧劇 据據 " +
  "觉覺 开開 课課 块塊 况況 亏虧 扩擴 来來 蓝藍 览覽 劳勞 乐樂 类類 离離 礼禮 厉厲 丽麗 连連 联聯 练練 " +
  "恋戀 两兩 辆輛 疗療 临臨 灵靈 领領 龙龍 楼樓 录錄 陆陸 虑慮 乱亂 论論 罗羅 马馬 买買 卖賣 满滿 门門 " +
  "们們 梦夢 灭滅 鸣鳴 难難 脑腦 鸟鳥 农農 浓濃 诺諾 欧歐 盘盤 赔賠 贫貧 评評 凭憑 气氣 启啟 弃棄 迁遷 " +
  "签簽 钱錢 浅淺 墙牆 桥橋 亲親 轻輕 庆慶 穷窮 区區 权權 劝勸 确確 让讓 热熱 认認 荣榮 软軟 伤傷 赏賞 " +
  "烧燒 设設 摄攝 绍紹 圣聖 胜勝 师師 诗詩 时時 识識 实實 视視 试試 适適 势勢 饰飾 书書 属屬 术術 树樹 " +
  "数數 双雙 说說 顺順 丝絲 虽雖 随隨 岁歲 损損 态態 谈談 叹嘆 汤湯 讨討 题題 体體 条條 听聽 厅廳 头頭 " +
  "图圖 团團 维維 为為 伟偉 卫衛 问問 稳穩 务務 误誤 无無 习習 戏戲 细細 鲜鮮 显顯 险險 现現 线線 宪憲 " +
  "乡鄉 响響 项項 协協 写寫 谢謝 兴興 选選 学學 寻尋 训訓 压壓 亚亞 严嚴 验驗 阳陽 养養 样樣 药藥 业業 " +
  "页頁 叶葉 医醫 仪儀 艺藝 亿億 忆憶 义義 议議 译譯 阴陰 银銀 饮飲 应應 营營 拥擁 优優 忧憂 邮郵 鱼魚 " +
  "与與 语語 预預 员員 园園 远遠 愿願 约約 阅閱 跃躍 运運 杂雜 灾災 载載 赞讚 责責 则則 择擇 张張 这這 " +
  "针針 阵陣 争爭 证證 织織 职職 执執 纸紙 质質 钟鐘 种種 众眾 猪豬 诸諸 专專 转轉 庄莊 状狀 装裝 准準 " +
  "资資 总總 组組 钻鑽 厂廠 办辦 帮幫 报報 饱飽 宝寶 赛賽 岛島 绪緒 续續 馈饋 请請 谁誰 网網 码碼 链鏈 " +
  "编編 辑輯 输輸 库庫 档檔 测測 爷爺 喷噴 饿餓 厨廚 鸡雞 鸭鴨 猫貓 猎獵 纳納";

const S2T = new Map<string, string>();
for (const pair of S2T_PAIRS.split(" ")) {
  const [s, t] = [...pair];
  if (s && t && s !== t) S2T.set(s, t);
}

/** 高頻虛字：單字時不計分（仍參與二字組） */
const STOP_CHARS = new Set([..."的了是在和與及或我你他她它們也就都而之其這那個有要會對把被讓給嗎呢吧啊呀喔哦什麼怎如何很更最"]);

const CJK_RUN = /[㐀-鿿豈-﫿]+/g;
const LATIN_WORD = /[a-z0-9][a-z0-9_\-]*/g;

/** 單字的權重低於二字組：單字只用來補足二字組抓不到的情況 */
const UNIGRAM_WEIGHT = 0.4;

export function normalize(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFKC").toLowerCase()) out += S2T.get(ch) ?? ch;
  return out;
}

/** 輕度英文詞形還原：複數與常見字尾，寧可少還原也不要誤併 */
function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** 詞項與其權重（同一詞出現多次則累加） */
export function terms(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (t: string, w: number) => out.set(t, (out.get(t) ?? 0) + w);
  const text = normalize(s);
  for (const w of text.match(LATIN_WORD) ?? []) {
    if (w.length >= 2) add(stem(w), 1);
  }
  for (const run of text.match(CJK_RUN) ?? []) {
    const chars = [...run];
    for (const c of chars) if (!STOP_CHARS.has(c)) add(c, UNIGRAM_WEIGHT);
    for (let i = 0; i < chars.length - 1; i++) add(chars[i] + chars[i + 1], 1);
  }
  return out;
}

/** 可檢索文件：多個欄位，各帶權重（例如 claim 比 body 重要） */
export type Fields = Array<[text: string, weight: number]>;

interface Doc {
  tf: Map<string, number>;
  len: number;
}

function toDoc(fields: Fields): Doc {
  const tf = new Map<string, number>();
  let len = 0;
  for (const [text, weight] of fields) {
    for (const [t, w] of terms(text)) {
      tf.set(t, (tf.get(t) ?? 0) + w * weight);
      len += w * weight;
    }
  }
  return { tf, len };
}

const K1 = 1.2;
const B = 0.75;

/** 以 BM25 為每個項目計分，回傳與輸入同序的分數（無命中為 0） */
export function score<T>(items: T[], fieldsOf: (item: T) => Fields, query: string): number[] {
  const q = terms(query);
  if (q.size === 0 || items.length === 0) return items.map(() => 0);
  const docs = items.map((it) => toDoc(fieldsOf(it)));
  const avg = docs.reduce((n, d) => n + d.len, 0) / docs.length || 1;
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const t of q.keys()) {
    const df = docs.reduce((c, d) => c + (d.tf.has(t) ? 1 : 0), 0);
    idf.set(t, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }
  return docs.map((d) => {
    let s = 0;
    for (const [t, qw] of q) {
      const f = d.tf.get(t);
      if (!f) continue;
      s += qw * idf.get(t)! * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avg)));
    }
    return s;
  });
}

/** 低於最高分此比例的結果視為雜訊，不回傳 */
export const MIN_RELATIVE_SCORE = 0.25;
