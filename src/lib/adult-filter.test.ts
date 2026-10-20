import { describe, expect, it } from 'vitest';
import {
  ADULT_SOURCE_CATEGORY_RATIO,
  isAdultContent,
  isAdultSource,
} from './adult-filter';

describe('isAdultContent（结果级判定）', () => {
  it('历史词表保持命中', () => {
    expect(isAdultContent('伦理片')).toBe(true);
    expect(isAdultContent('无码')).toBe(true);
    expect(isAdultContent('91视频')).toBe(true);
    expect(isAdultContent('自拍偷拍')).toBe(true);
  });

  it('繁体分类名也命中（港台源用繁体写分类）', () => {
    expect(isAdultContent('無碼')).toBe(true);
    expect(isAdultContent('有碼')).toBe(true);
    expect(isAdultContent('倫理片')).toBe(true);
  });

  it('实测补充词命中（旧词表漏掉的真实分类）', () => {
    // 这些分类名取自 tv.cc0cd.cc.cd 实际返回的 type_name
    for (const t of [
      '国产自拍',
      '伦理三级',
      '群交淫乱',
      '欧美性爱',
      '国产裸聊',
      '偷拍自拍',
      '巨乳美乳',
      '少女萝莉',
      '制服丝袜',
      '女同性恋',
      '人妖系列',
      '强奸乱伦',
      '3P合辑',
      'AV明星',
      '口交视频',
      '颜射系列',
      'SM重味',
      '大秀视频',
    ]) {
      expect(isAdultContent(t), t).toBe(true);
    }
  });

  it('正常影视分类不误伤', () => {
    for (const t of [
      '动作片',
      '剧情片',
      '科幻片',
      '国产剧',
      '日韩综艺',
      '记录片',
      '动画电影',
      '预告片',
      '篮球',
    ]) {
      expect(isAdultContent(t), t).toBe(false);
    }
  });

  it('混合源里的中性分类不误伤（中文字幕 / 卡通动漫 / 精品推荐）', () => {
    // 这些词只在成人站聚集出现，主流站也用，因此不得进结果级词表
    expect(isAdultContent('中文字幕')).toBe(false);
    expect(isAdultContent('卡通动漫')).toBe(false);
    expect(isAdultContent('精品推荐')).toBe(false);
    expect(isAdultContent('日韩精品')).toBe(false);
  });

  it('大小写不敏感', () => {
    expect(isAdultContent('swag')).toBe(true);
    expect(isAdultContent('SWAG')).toBe(true);
    expect(isAdultContent('av明星')).toBe(true);
  });

  it('空值与 undefined 安全', () => {
    expect(isAdultContent(undefined)).toBe(false);
    expect(isAdultContent('')).toBe(false);
  });
});

describe('isAdultSource（源级判定）', () => {
  it('源名强关键词直接判成人（订阅里的成人站常不带 categories）', () => {
    expect(isAdultSource(undefined, '🍊大奶')).toBe(true);
    expect(isAdultSource(undefined, '🍊色逼')).toBe(true);
    expect(isAdultSource(undefined, '🍊杏吧')).toBe(true);
    expect(isAdultSource(undefined, '🧿gay┃资源')).toBe(true);
    expect(isAdultSource(undefined, '成人51')).toBe(true);
    expect(isAdultSource(undefined, '🔞乐播资源')).toBe(true);
    expect(isAdultSource(undefined, '*91麻豆')).toBe(true);
  });

  it('纯成人分类站（分类全命中）判成人', () => {
    // 实测「番外┃采集」的 categories：16/16 全是成人分类
    const fanwai = [
      '群交淫乱', '偷拍自拍', '制服丝袜', '无码专区', '卡通动漫', '中文字幕',
      '欧美性爱', '巨乳美乳', '国产裸聊', '国产自拍', '国产盗摄', '伦理三级',
      '女同性恋', '少女萝莉', '人妖系列', '虚拟VR',
    ];
    expect(isAdultSource(fanwai, '🧿番外┃采集')).toBe(true);
  });

  it('混合源不判成人（主流影视 + 一个伦理片分类）', () => {
    // 实测光速源：23 个分类里只有 1 个伦理片；整源判成人会误杀大量正常影片
    const guangsu = [
      '电影', '电视剧', '综艺', '动漫', '动作片', '喜剧片', '爱情片', '科幻片', '恐怖片',
      '剧情片', '战争片', '大陆剧', '欧美剧', '港澳剧', '韩剧', '动漫电影', '日剧',
      '台湾剧', '泰剧', '记录片', '伦理片', '体育赛事', '短剧',
    ];
    expect(isAdultSource(guangsu, '🎀光速┃采集')).toBe(false);
    // 火狐 27 个分类里也只有 1 个伦理片
    expect(isAdultSource(['伦理片', ...Array.from({ length: 26 }, (_, i) => `分类${i}`)], '🔥️火狐┃秒播')).toBe(false);
  });

  it('纯粹的正常源不判成人', () => {
    expect(isAdultSource(['动作片', '喜剧片', '国产剧'], '正常影视')).toBe(false);
    expect(isAdultSource(undefined, '正常资源站')).toBe(false);
    expect(isAdultSource([], '正常资源站')).toBe(false);
  });

  it('占比阈值是 0.5，边界值可判定', () => {
    expect(ADULT_SOURCE_CATEGORY_RATIO).toBe(0.5);
    const half = ['无码专区', '伦理片', '动作片', '剧情片'];
    expect(isAdultSource(half, 'x')).toBe(true);
    // 稍低于一半则不判
    expect(isAdultSource(['无码专区', '动作片', '剧情片', '喜剧片'], 'x')).toBe(false);
  });

  it('非数组 categories 不影响源名判定', () => {
    expect(isAdultSource('not-an-array', '成人51')).toBe(true);
    expect(isAdultSource(null, '正常资源')).toBe(false);
  });

  it('分类里的非字符串项被安全跳过', () => {
    expect(isAdultSource([1, null, {}, '动作片'], '正常影视')).toBe(false);
  });
});

describe('结果级 / 源级的词表分工（防误伤边界）', () => {
  it('纯成人站才用的分类进结果级词表', () => {
    for (const t of ['学生空姐', '反差母狗', '探花嫖娼', '性感人妻', '丝袜OL', '人妻系列']) {
      expect(isAdultContent(t), t).toBe(true);
    }
  });

  it('主流站也会用的分类留在源级（结果级不拦，避免误杀正常影片）', () => {
    // 运行时实测：这 3 个分类只出现在纯成人源里，但字面量本身完全中性，
    // 一旦进结果级词表，任何源站用它做正常分类都会被整类误杀。
    for (const t of ['中文字幕', '卡通动漫', '精品推荐']) {
      expect(isAdultContent(t), t).toBe(false);
    }
  });

  it('这 3 个中性词参与源级占比判定，纯成人源仍会被整源拦住', () => {
    const pureAdult = ['中文字幕', '卡通动漫', '精品推荐', '伦理三级', '无码专区', '少女萝莉'];
    expect(isAdultSource(pureAdult, '某个源')).toBe(true);
  });
});
