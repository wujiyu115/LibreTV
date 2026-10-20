import { ADULT_RESULT_KEYWORDS, isAdultContent } from './adult-filter';
import type { SearchResultItem, VideoDetail } from './types';

/**
 * Apple CMS（苹果CMS）资源站响应解析
 * 与旧版 js/api.js 逻辑对齐，迁移为纯函数以便单元测试。
 *
 * 成人内容的关键词表与源级判定见 ./adult-filter（TVBOX 订阅导入也要用）。
 */

const M3U8_PATTERN = /\$https?:\/\/[^"'\s]+?\.m3u8/g;

const UA_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

export function cmsRequestHeaders(): Record<string, string> {
  return { ...UA_HEADERS };
}

/** 搜索响应 → 统一结果列表 */
export function parseSearchList(
  data: unknown,
  source: { key: string; name: string; url: string; isAdult?: boolean }
): SearchResultItem[] {
  if (!data || typeof data !== 'object') throw new Error('API返回的数据格式无效');
  const list = (data as { list?: unknown }).list;
  // 部分源站无结果时返回 list: null（而非 []），视为空结果而非格式错误
  if (list !== null && list !== undefined && !Array.isArray(list)) {
    throw new Error('API返回的数据格式无效');
  }
  return (Array.isArray(list) ? list : []).map((item) => {
    const vod = item as Record<string, unknown>;
    return {
      sourceKey: source.key,
      sourceName: source.name,
      vodId: String(vod.vod_id ?? ''),
      name: String(vod.vod_name ?? ''),
      pic: typeof vod.vod_pic === 'string' ? vod.vod_pic : undefined,
      typeName: typeof vod.type_name === 'string' ? vod.type_name : undefined,
      year: typeof vod.vod_year === 'string' ? vod.vod_year : undefined,
      area: typeof vod.vod_area === 'string' ? vod.vod_area : undefined,
      remarks: typeof vod.vod_remarks === 'string' ? vod.vod_remarks : undefined,
      sourceUrl: source.url,
      isAdult: source.isAdult,
    };
  });
}

/**
 * 从 vod_play_url 中提取分集地址：格式 源1$$$源2，集1$URL1#集2$URL2。
 * 部分源（如量子 lziapi、非凡 ffzy）第一条线路是网页中转页（…/share/xxx，不可播），
 * 真实 m3u8 在后面的线路里，因此优先取包含 m3u8 直链的线路；均无 m3u8 时回退第一条。
 */
export function extractEpisodesFromPlayUrl(playUrl: string): string[] {
  if (!playUrl) return [];
  const groups = playUrl
    .split('$$$')
    .map((group) =>
      group
        .split('#')
        .map((ep) => {
          const parts = ep.split('$');
          return parts.length > 1 ? parts[1] : '';
        })
        .filter((url) => url.startsWith('http://') || url.startsWith('https://'))
    )
    .filter((eps) => eps.length > 0);
  if (groups.length === 0) return [];
  return groups.find((eps) => eps.some((url) => url.includes('.m3u8'))) ?? groups[0];
}

/** 从简介文本中兜底提取 m3u8 链接 */
export function extractM3u8FromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(M3U8_PATTERN) || [];
  return matches.map((link) => link.replace(/^\$/, ''));
}

/** 详情 JSON 响应 → 统一详情 */
export function parseDetail(
  data: unknown,
  source: { key: string; name: string; url: string }
): VideoDetail {
  const d = data as { list?: Record<string, unknown>[] };
  if (!d || !Array.isArray(d.list) || d.list.length === 0) {
    throw new Error('获取到的详情内容无效');
  }
  const vod = d.list[0];
  let episodes = extractEpisodesFromPlayUrl(String(vod.vod_play_url ?? ''));
  if (episodes.length === 0) {
    episodes = extractM3u8FromText(String(vod.vod_content ?? ''));
  }
  return {
    episodes,
    videoInfo: {
      title: str(vod.vod_name),
      cover: str(vod.vod_pic),
      desc: str(vod.vod_content),
      typeName: str(vod.type_name),
      year: str(vod.vod_year),
      area: str(vod.vod_area),
      director: str(vod.vod_director),
      actor: str(vod.vod_actor),
      remarks: str(vod.vod_remarks),
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: source.url,
    },
  };
}

function str(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || undefined;
}

/**
 * 部分源的列表接口不返回播放地址，需要爬详情页 HTML 提取 m3u8。
 * 与旧版 handleSpecialSourceDetail 对齐。
 */
export function parseDetailPageHtml(
  html: string,
  source: { key: string; name: string; url: string }
): VideoDetail {
  // 先尝试通用模式，再尝试非凡影视的日期哈希特征路径
  let matches = html.match(/\$(https?:\/\/[^"'\s]+?\.m3u8)/g) || [];
  if (matches.length === 0) {
    matches = html.match(/\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g) || [];
  }
  // 去重并清理尾缀
  const episodes = [...new Set(matches)].map((link) => {
    let u = link.substring(1);
    const parenIndex = u.indexOf('(');
    if (parenIndex > 0) u = u.substring(0, parenIndex);
    return u;
  });

  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);

  return {
    episodes,
    videoInfo: {
      title: titleMatch ? titleMatch[1].trim() : undefined,
      desc: descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : undefined,
      sourceKey: source.key,
      sourceName: source.name,
      sourceUrl: source.url,
    },
  };
}

/** 成人内容过滤：判定与关键词见 ./adult-filter（与订阅导入共享同一套词表） */
export { ADULT_RESULT_KEYWORDS, isAdultContent };

/**
 * 丢弃成人结果。两道关卡：
 *
 * 1. **源级标记**（可靠）：源本身被判定为成人站时，它返回的一切都不展示。
 *    这是主关卡——成人站的分类名是无穷的（实测杏吧用「颜值正义」「吃瓜黑料」
 *   「国产主播」「熟女少妇」，词表法永远追不上），靠关键词叫停不了。
 * 2. **分类关键词**（兜底）：源本身是混合站（主流影视 + 几个伦理片分类）时，
 *    源级不能封杀，只能靠 typeName 逐条拦。
 */
export function filterAdultResults<T extends { typeName?: string; isAdult?: boolean }>(
  items: T[],
  enabled: boolean
): T[] {
  if (!enabled) return items;
  return items.filter((item) => !item.isAdult && !isAdultContent(item.typeName));
}

/**
 * 归一化标题/关键词：去空白、标点与符号，转小写。
 * 用于跨标点差异匹配（源站存「摔跤吧!爸爸」而用户搜「摔跤吧！爸爸」）。
 */
export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * 相关性判断：结果标题是否真的命中了搜索词。
 * 部分采集站会做分词/OR 模糊搜索（搜「摔跤吧！爸爸」返回一堆「爸爸XXX」），
 * 逐条校验后只保留真正相关的结果。
 *
 * 规则：归一化后的标题包含归一化后的完整关键词；
 * 多词查询（空格分隔）时放宽为「每个词都命中」即可（如「钢铁侠 2008」）。
 */
export function isRelevant(name: string, wd: string): boolean {
  const nName = normalizeTitle(name);
  const nWd = normalizeTitle(wd);
  if (!nName || !nWd) return true; // 空关键词不参与过滤
  if (nName.includes(nWd)) return true;
  const tokens = wd.trim().split(/\s+/);
  if (tokens.length > 1) {
    return tokens.every((t) => {
      const n = normalizeTitle(t);
      return n && nName.includes(n);
    });
  }
  return false;
}

/**
 * 结果相关性过滤：丢弃与关键词无关的条目。
 *
 * 部分采集站会做分词/OR 模糊搜索（搜「摔跤吧！爸爸」返回一堆「爸爸XXX」），
 * 逐条校验后只保留真正相关的结果。
 *
 * 匹配不到任何条目时不能整份原样回退：实测光速源搜「摔跤吧！爸爸」返回 100 条、
 * 无一条命中关键词，旧的全量回退把这 100 条无关结果原样放行，相关性过滤形同失效。
 *
 * 但也不能直接清空：采集站支持按演员 / 标签检索（搜「刘德华」返回的片名里
 * 本来就不会含关键词），清空会把这类正常搜索变成「无结果」。
 * 折中：按「标题与关键词的最长公共子串」降序排，只取前 MAX_FALLBACK_RESULTS 条。
 * 最接近的排前面，总量有上限，既不清空也不会把上百条无关结果全回放。
 */
export function filterRelevantResults<T extends { name?: string }>(items: T[], wd: string): T[] {
  const filtered = items.filter((item) => isRelevant(item.name || '', wd));
  if (filtered.length > 0) return filtered;

  const nWd = normalizeTitle(wd);
  // 关键词归一化后为空（纯标点）：无从比较，按原顺序截断
  if (!nWd) return items.slice(0, MAX_FALLBACK_RESULTS);

  return items
    .map((item) => ({ item, score: longestCommonSubstringLength(normalizeTitle(item.name || ''), nWd) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_FALLBACK_RESULTS)
    .map((s) => s.item);
}

/** 降级匹配（相关性不成立时）最多保留的条数：给演员名检索留余地，又能拦住上百条无关结果 */
export const MAX_FALLBACK_RESULTS = 40;

/** 最长公共子串长度（滚动数组 DP，名称都很短，代价可忽略） */
function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : 0;
      if (cur[j] > best) best = cur[j];
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return best;
}
