import { describe, expect, it } from 'vitest';
import {
  extractEpisodesFromPlayUrl,
  extractM3u8FromText,
  filterAdultResults,
  filterRelevantResults,
  MAX_FALLBACK_RESULTS,
  isAdultContent,
  isRelevant,
  normalizeTitle,
  parseDetail,
  parseDetailPageHtml,
  parseSearchList,
} from './cms-parser';

const source = { key: 'test', name: '测试源', url: 'https://api.example.com/provide/vod' };

describe('parseSearchList', () => {
  it('解析标准搜索响应并补齐源信息', () => {
    const data = {
      list: [
        { vod_id: 123, vod_name: '流浪地球', vod_pic: 'https://img/a.jpg', type_name: '科幻', vod_year: '2019', vod_remarks: 'HD' },
        { vod_id: 'abc-1', vod_name: '探<script>' },
      ],
    };
    const items = parseSearchList(data, source);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      sourceKey: 'test', sourceName: '测试源', vodId: '123', name: '流浪地球',
      typeName: '科幻', year: '2019', remarks: 'HD', sourceUrl: source.url,
    });
    expect(items[1].vodId).toBe('abc-1');
  });

  it('对缺失字段健壮', () => {
    const items = parseSearchList({ list: [{}] }, source);
    expect(items[0].vodId).toBe('');
    expect(items[0].name).toBe('');
  });

  it('拒绝无效响应；list 缺失或 null 视为空结果', () => {
    expect(() => parseSearchList(null, source)).toThrow();
    expect(() => parseSearchList({ list: 'nope' }, source)).toThrow();
    // 部分源站无结果时返回 list: null（或缺失），按空结果兼容
    expect(parseSearchList({ list: null }, source)).toEqual([]);
    expect(parseSearchList({}, source)).toEqual([]);
  });
});

describe('extractEpisodesFromPlayUrl', () => {
  it('解析 源$$$源 与 集$URL#集$URL 结构', () => {
    const play = '第01集$https://cdn/a1.m3u8#第02集$https://cdn/a2.m3u8$$$备用$https://x/b.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual([
      'https://cdn/a1.m3u8',
      'https://cdn/a2.m3u8',
    ]);
  });

  it('过滤无 URL 或非 http 的集', () => {
    const play = '第01集$#第02集$ftp://x#第03集$https://cdn/a3.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual(['https://cdn/a3.m3u8']);
  });

  it('第一条线路为中转页时优先取 m3u8 线路（量子/非凡类源）', () => {
    const play =
      'HD中字$https://vip.lzcdn2.com/share/abc$$$HD中字$https://vip.lzcdn2.com/20220329/1012_e9be6a92/index.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual([
      'https://vip.lzcdn2.com/20220329/1012_e9be6a92/index.m3u8',
    ]);
  });

  it('第一条线路为空时取后续有效线路', () => {
    const play = '第1集$$$第1集$https://cdn/b.m3u8';
    expect(extractEpisodesFromPlayUrl(play)).toEqual(['https://cdn/b.m3u8']);
  });

  it('两条线路均无 m3u8 时回退第一条', () => {
    const play = '第1集$https://cdn/a.mp4$$$第1集$https://cdn2/a.mp4';
    expect(extractEpisodesFromPlayUrl(play)).toEqual(['https://cdn/a.mp4']);
  });

  it('空输入返回空数组', () => {
    expect(extractEpisodesFromPlayUrl('')).toEqual([]);
  });
});

describe('extractM3u8FromText', () => {
  it('从简介中提取 m3u8 链接', () => {
    const text = '正片$https://cdn.com/x/index.m3u8 更多';
    expect(extractM3u8FromText(text)).toEqual(['https://cdn.com/x/index.m3u8']);
  });
});

describe('parseDetail', () => {
  it('解析详情并提取分集', () => {
    const data = {
      list: [{
        vod_id: 1, vod_name: '三体', vod_content: '科幻剧',
        vod_play_url: '第1集$https://cdn/1.m3u8#第2集$https://cdn/2.m3u8',
      }],
    };
    const detail = parseDetail(data, source);
    expect(detail.episodes).toHaveLength(2);
    expect(detail.videoInfo.title).toBe('三体');
    expect(detail.videoInfo.sourceName).toBe('测试源');
  });

  it('play_url 为空时从简介兜底', () => {
    const data = { list: [{ vod_name: 'X', vod_content: '$https://cdn/fall.m3u8' }] };
    const detail = parseDetail(data, source);
    expect(detail.episodes).toEqual(['https://cdn/fall.m3u8']);
  });

  it('空列表抛错', () => {
    expect(() => parseDetail({ list: [] }, source)).toThrow();
  });
});

describe('parseDetailPageHtml', () => {
  it('从 HTML 中提取去重后的 m3u8', () => {
    const html = `<h1>庆余年</h1>
      <div class="sketch">简介<b>内容</b></div>
      <script>player_aa={"url":"$https://cdn/ep1.m3u8"}</script>
      <script>player_bb={"url":"$https://cdn/ep2.m3u8"}</script>
      <script>player_cc={"url":"$https://cdn/ep1.m3u8"}</script>`;
    const detail = parseDetailPageHtml(html, source);
    expect(detail.episodes).toEqual(['https://cdn/ep1.m3u8', 'https://cdn/ep2.m3u8']);
    expect(detail.videoInfo.title).toBe('庆余年');
    expect(detail.videoInfo.desc).toBe('简介 内容');
  });

  it('非凡影视特征路径兜底', () => {
    const html = '$https://vip.ffzy.com/20231101/12345_abcdef/index.m3u8';
    const detail = parseDetailPageHtml(html, source);
    expect(detail.episodes).toContain('https://vip.ffzy.com/20231101/12345_abcdef/index.m3u8');
  });
});

describe('成人内容过滤', () => {
  it('识别敏感分类', () => {
    expect(isAdultContent('伦理片')).toBe(true);
    expect(isAdultContent('福利片')).toBe(true);
    expect(isAdultContent('科幻片')).toBe(false);
    expect(isAdultContent(undefined)).toBe(false);
  });

  it('filterAdultResults 按开关过滤', () => {
    const items = [{ typeName: '伦理片' }, { typeName: '剧情片' }];
    expect(filterAdultResults(items, true)).toEqual([{ typeName: '剧情片' }]);
    expect(filterAdultResults(items, false)).toHaveLength(2);
  });

  it('源级 isAdult 传导到结果：成人源返回的任何内容都丢弃', () => {
    // 实测杏吧源的分类是「颜值正义」「吃瓜黑料」「国产主播」「熟女少妇」，
    // 全部不在词表里——成人站的分类名无穷无尽，靠关键词追不上，
    // 只能靠源级标记把整源结果丢掉。
    const items = [
      { typeName: '颜值正义', isAdult: true },
      { typeName: '吃瓜黑料', isAdult: true },
      { typeName: '科幻片', isAdult: true }, // 源是成人源，正常分类也不可信
      { typeName: '科幻片' },
    ];

    expect(filterAdultResults(items, true)).toEqual([{ typeName: '科幻片' }]);
  });

  it('源级 isAdult 在关闭过滤时不生效（用户主动放行）', () => {
    const items = [{ typeName: '颜值正义', isAdult: true }];

    expect(filterAdultResults(items, false)).toHaveLength(1);
  });
});

describe('normalizeTitle', () => {
  it('去标点、空白并转小写', () => {
    expect(normalizeTitle('摔跤吧！爸爸')).toBe('摔跤吧爸爸');
    expect(normalizeTitle('摔跤吧!爸爸 【影视解说】')).toBe('摔跤吧爸爸影视解说');
    expect(normalizeTitle('Hello, World!')).toBe('helloworld');
  });
});

describe('isRelevant', () => {
  it('命中完整关键词（忽略标点差异）', () => {
    expect(isRelevant('摔跤吧！爸爸', '摔跤吧！爸爸')).toBe(true);
    expect(isRelevant('摔跤吧!爸爸【影视解说】', '摔跤吧！爸爸')).toBe(true);
    expect(isRelevant('摔跤吧 爸爸', '摔跤吧！爸爸')).toBe(true);
  });

  it('标题不含关键词时不相关（模糊分词场景）', () => {
    expect(isRelevant('爸爸去哪儿第三季', '摔跤吧！爸爸')).toBe(false);
    expect(isRelevant('爸爸当家 第五季', '摔跤吧！爸爸')).toBe(false);
  });

  it('子串命中视为相关', () => {
    expect(isRelevant('爸爸去哪儿第三季', '爸爸去哪儿')).toBe(true);
  });

  it('多词查询放宽为每个词都命中', () => {
    expect(isRelevant('钢铁侠', '钢铁侠 2008')).toBe(false);
    expect(isRelevant('钢铁侠 Iron Man 2008', '钢铁侠 2008')).toBe(true);
  });

  it('空关键词或空标题不参与过滤', () => {
    expect(isRelevant('任意标题', '')).toBe(true);
    expect(isRelevant('', '任意')).toBe(true);
  });
});

describe('filterRelevantResults', () => {
  const wd = '摔跤吧！爸爸';
  const items = [
    { name: '摔跤吧！爸爸' },
    { name: '爸爸去哪儿第三季' },
    { name: '摔跤吧!爸爸【影视解说】' },
  ];

  it('丢弃与关键词无关的结果', () => {
    const out = filterRelevantResults(items, wd);
    expect(out).toHaveLength(2);
    expect(out.map((i) => i.name)).toEqual(['摔跤吧！爸爸', '摔跤吧!爸爸【影视解说】']);
  });

  it('全部不相关时按得分降序并限流，不再全量回退', () => {
    // 旧行为是全量回退（等于过滤失效）：实测光速源搜「摔跤吧！爸爸」返回 100 条、
    // 无一条命中关键词，全量放行会把这 100 条无关结果原样展出来。
    const junk = [{ name: '爸爸当家' }, { name: '爸爸别走' }];
    const out = filterRelevantResults(junk, wd);

    // 公共子串「爸爸」得分高的排前面，但仍受总量上限约束
    expect(out.length).toBeLessThanOrEqual(junk.length);
    expect(out.every((i) => junk.includes(i))).toBe(true);
  });

  it('完全无交集的条目被截断，不再返回全量', () => {
    // 100 条和关键词毫无共同子串的结果：不能全部放行
    const junk = Array.from({ length: 100 }, (_, i) => ({ name: `zzz电影${i}` }));
    const out = filterRelevantResults(junk, wd);

    expect(out.length).toBeLessThan(junk.length);
    expect(out.length).toBeLessThanOrEqual(MAX_FALLBACK_RESULTS);
  });

  it('降级匹配按得分降序，最接近的排前面', () => {
    const items2 = [
      { name: '完全无关' },    // 0 分
      { name: '摔跤手' },      // 与「摔跤吧爸爸」公共子串「摔跤」= 2
      { name: '爸爸' },        // 「爸爸」= 2
    ];
    const out = filterRelevantResults(items2, wd);

    // 不再只留最高档（游泳名检索这类场景会被误杀），而是降序排 + 总量封顶；
    // 「完全无关」仍在结果里，但排在最后
    expect(out[out.length - 1].name).toBe('完全无关');
  });

  it('关键词归一化后为空时视为不过滤（既有语义）', () => {
    // 纯标点关键词经 normalizeTitle 后为空，isRelevant 走「空关键词不参与过滤」分支，
    // 不会进入降级匹配。这里锁定既有语义，避免以后误以为它会被截断。
    const junk = Array.from({ length: 100 }, (_, i) => ({ name: `片${i}` }));
    const out = filterRelevantResults(junk, '！？！');

    expect(out).toHaveLength(100);
  });
});
