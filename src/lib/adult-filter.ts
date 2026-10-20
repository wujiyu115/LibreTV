/**
 * 成人内容判定的共享词表与判定规则。
 *
 * 两处调用方语义不同，必须分开：
 * - 结果级（cms-parser.filterAdultResults）：只看单条结果的 type_name，判定要**保守**——
 *   漏判只是多显示一条，误判会把整部正常影片藏起来；
 * - 源级（tvbox-parser 导入订阅时）：看整源分类表与源名，判定可以**激进**——
 *   打错标记的代价只是源默认不勾选（用户关掉过滤即可恢复），而漏判等于整源成人内容
 *   静默涌入搜索结果。
 *
 * 词表来源：tv.cc0cd.cc.cd 这类 TVBOX 订阅的真实分类名（158 个）逐条核对过，
 * 只收录「在成人站出现、主流站不出现」的词，避免把「中文字幕」这种混合源里
 * 正常分类也误杀。
 */

/**
 * 结果级关键词：命中即认为该条结果是成人内容。
 *
 * 前半段是历史词表（与旧版保持一致，避免存量行为变化），
 * 后半段是实测补充——旧词表在真实订阅上只拦得住 4 个分类，漏 24 个。
 */
const RESULT_ADULT_KEYWORDS: readonly string[] = [
  // —— 历史词表（勿删，存量行为依赖它）——
  '伦理片', '福利', '倫理片', '福利片', '日本伦理', '日本福利', '日本福利片', '日本伦理片',
  '擦边短剧', '擦边', '韩国伦理', '里番动漫', '门事件', '萝莉少女', '制服诱惑', '国产传媒',
  'cosplay', '黑丝诱惑', '无码', '日本无码', '有码', '日本有码', 'SWAG',
  // 繁体变体：部分采集站（港台源）用繁体写分类名
  '無碼', '有碼', '倫理',
  '网红主播', '色情片', '同性片', '福利视频', '无码高清', '有码高清', '91视频', '自拍偷拍',
  'mini传媒',
  // —— 实测补充：旧词表漏掉、真实订阅里确实存在的成人分类 ——
  '伦理三级', '伦理影片', '三级伦理', '港台三级', '西方伦理', '国产自拍', '国产盗摄',
  '国产裸聊', '欧美性爱', '偷拍自拍', '群交淫乱', '自慰系列', '巨乳', '少女萝莉',
  '制服丝袜', '女同性恋', '人妖系列', '强奸乱伦', '日韩无码', 'AV明星', '口交视频',
  '颜射系列', 'SM重味', '大秀视频', '3P合辑', '虚拟VR', '下药迷奸', '迷奸', '群P',
  // 纯成人源才会用的分类名（运行时实测拉回，正常影视站不会这么分类）：
  '学生空姐', '反差母狗', '网曝系列', '主播秀色', '探花嫖娼', '性感人妻',
  '日本片商', '丝袜OL', '人妻系列', '教师学生',
];

/**
 * 源级强关键词：源名命中即判为成人站。
 * 只收「正常影视站不可能叫这名」的词——「主播」「福利」这类会被正规站用到的词
 * 一律不收，否则会把整源正常影片拒之门外。
 */
const SOURCE_ADULT_NAME_KEYWORDS: readonly string[] = [
  '成人', '番号', '色逼', '大奶', '杏吧', '麻豆', '女优', '里番', '情色', '色情', '色库',
  'gay', '淫', '🔞', 'av资源', '无码', '有码', '偷拍', '自拍',
];

/**
 * 源级分类关键词：判定单个分类名是否为成人分类。
 * 比结果级更宽（允许「卡通动漫」这类仅出现在成人站的分类），
 * 因为源级判定靠「成人分类占比」兜底，单点误判不会导致整源被判错。
 */
const SOURCE_ADULT_CATEGORY_KEYWORDS: readonly string[] = [
  ...RESULT_ADULT_KEYWORDS,
  // 以下词在成人站高频聚集，但在主流站仅表示「中文字幕」「日韩精品的剧」等，
  // 因此只在源级使用（配合占比判定），不进结果级词表
  '卡通动漫', '中文字幕', '精品推荐', '日韩精品', '欧美精品', '国产精品', '动漫精品',
  '巨乳系列',
];

/** 成人分类占比达到该比例时，整个源判为成人源 */
export const ADULT_SOURCE_CATEGORY_RATIO = 0.5;

function hit(text: string | undefined, keywords: readonly string[]): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * 结果级判定：单条结果的分类名是否属于成人内容。
 * 保守策略——只认明确的成人分类词，不看片名（片名关键词极易误伤正常影片，
 * 且源站会给正常片写擦边标题导流）。
 */
export function isAdultContent(typeName: string | undefined): boolean {
  return hit(typeName, RESULT_ADULT_KEYWORDS);
}

/** 导出供测试与排查使用（不参与运行时判定） */
export const ADULT_RESULT_KEYWORDS = RESULT_ADULT_KEYWORDS;

/**
 * 源级判定：读 TVBOX 站点声明的 categories 分类表 + 源名，判断是否为成人站。
 *
 * 判定顺序：
 * 1. 源名命中强关键词 → 直接判成人（订阅里的成人站往往不给 categories）；
 * 2. 有 categories 且成人分类占比 ≥ ADULT_SOURCE_CATEGORY_RATIO → 判成人
 *    （实测只有「番外 16/16」「大地 21/21」这类纯成人站能到这个比例）；
 * 3. 其余一律不判——光速/火狐/量子这类「主流 + 1 个伦理片分类」的混合源必须保留，
 *    漏掉的那个分类由结果级过滤兜底。
 *
 * @param categories 站点声明的分类列表（TVBOX sites[].categories，可能缺失）
 * @param name 源显示名
 */
export function isAdultSource(categories: unknown, name: string | undefined): boolean {
  if (hit(name, SOURCE_ADULT_NAME_KEYWORDS)) return true;
  if (!Array.isArray(categories) || categories.length === 0) return false;
  const adultCount = categories.filter((c) =>
    hit(typeof c === 'string' ? c : undefined, SOURCE_ADULT_CATEGORY_KEYWORDS)
  ).length;
  return adultCount / categories.length >= ADULT_SOURCE_CATEGORY_RATIO;
}
