import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DELETE, GET, PUT } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import type { SyncPayload } from '@/lib/sync-types';

/**
 * /api/settings 单测：鉴权、归一化（防任意写入）、乐观并发检测、体积上限。
 * 存储层行为由 server-storage.test.ts 覆盖，这里只验证路由契约。
 */

let tmpDir: string;
const originalDataDir = process.env.DATA_DIR;
const originalPassword = process.env.PASSWORD;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ltv-api-'));
  process.env.DATA_DIR = tmpDir;
  // guardRequest 要求配置了 PASSWORD，否则返回 503
  process.env.PASSWORD = 'test-pass';
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalPassword === undefined) delete process.env.PASSWORD;
  else process.env.PASSWORD = originalPassword;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeRequest(
  method: string,
  body?: unknown,
  opts?: { authenticated?: boolean }
): Request {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts?.authenticated !== false) {
    headers.cookie = `${SESSION_COOKIE}=${signSession().token}`;
  }
  return new Request('https://local.test/api/settings', {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const samplePayload: SyncPayload = {
  settings: { yellowFilter: false, selectedKeys: ['a'] },
  history: [
    {
      id: 'src_1',
      sourceKey: 'src',
      vodId: '1',
      title: '某片',
      episodeIndex: 0,
      totalEpisodes: 12,
      playbackPosition: 100,
      duration: 2000,
      timestamp: 111,
    },
  ],
  progress: [{ key: 'src_1_0', position: 100, duration: 2000, updatedAt: 222 }],
  searchHistory: [{ text: '绅士', timestamp: 333 }],
};

describe('鉴权', () => {
  it('未登录返回 401', async () => {
    const res = await GET(makeRequest('GET', undefined, { authenticated: false }));
    expect(res.status).toBe(401);
  });

  it('未配置 PASSWORD 时返回 503', async () => {
    delete process.env.PASSWORD;
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(503);
  });
});

describe('GET', () => {
  it('服务端无数据时 exists=false、payload=null', async () => {
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.exists).toBe(false);
    expect(data.payload).toBeNull();
    expect(data.updatedAt).toBe(0);
    expect(data.storageWritable).toBe(true);
  });

  it('写入后能读到', async () => {
    await PUT(makeRequest('PUT', { payload: samplePayload, deviceId: 'dev-a' }));
    const data = await (await GET(makeRequest('GET'))).json();
    expect(data.exists).toBe(true);
    expect(data.payload.settings).toEqual({ yellowFilter: false, selectedKeys: ['a'] });
    expect(data.payload.history).toHaveLength(1);
    expect(data.deviceId).toBe('dev-a');
    expect(data.updatedAt).toBeGreaterThan(0);
  });

  it('数据目录不可写时仍返回 200 并标记 storageWritable=false', async () => {
    const blocker = path.join(tmpDir, 'blocker');
    await fs.writeFile(blocker, 'x');
    process.env.DATA_DIR = path.join(blocker, 'sub');
    const res = await GET(makeRequest('GET'));
    expect(res.status).toBe(200);
    expect((await res.json()).storageWritable).toBe(false);
  });
});

describe('PUT 归一化', () => {
  it('未知字段被丢弃、超长截断、条数封顶', async () => {
    const messy = {
      settings: { keep: 1, __proto__x: 'dropped?' },
      history: Array.from({ length: 500 }, (_, i) => ({
        id: `id${i}`,
        sourceKey: 's',
        vodId: String(i),
        title: 't'.repeat(5000),
        episodeIndex: 0,
        totalEpisodes: 1,
        playbackPosition: 0,
        duration: 0,
        timestamp: i,
        evil: 'should-be-dropped',
      })),
      progress: [],
      searchHistory: [],
      extraTopLevel: 'dropped',
    };
    const res = await PUT(makeRequest('PUT', { payload: messy, deviceId: 'd' }));
    expect(res.status).toBe(200);
    const data = await (await GET(makeRequest('GET'))).json();
    // 历史上限 100
    expect(data.payload.history).toHaveLength(100);
    // 标题截断到 512
    expect(data.payload.history[0].title.length).toBeLessThanOrEqual(512);
    // 未知字段不落盘
    expect(data.payload.history[0].evil).toBeUndefined();
    expect(data.payload.extraTopLevel).toBeUndefined();
  });

  it('缺少主键的 history 条目被丢弃', async () => {
    const res = await PUT(
      makeRequest('PUT', {
        payload: { settings: {}, history: [{ title: '没有 id' }], progress: [], searchHistory: [] },
        deviceId: 'd',
      })
    );
    expect(res.status).toBe(200);
    const data = await (await GET(makeRequest('GET'))).json();
    expect(data.payload.history).toHaveLength(0);
  });

  it('payload 结构非法返回 400', async () => {
    expect((await PUT(makeRequest('PUT', { payload: 'not-an-object', deviceId: 'd' }))).status).toBe(400);
    expect((await PUT(makeRequest('PUT', { payload: [], deviceId: 'd' }))).status).toBe(400);
  });

  it('缺少 deviceId 返回 400', async () => {
    expect((await PUT(makeRequest('PUT', { payload: samplePayload }))).status).toBe(400);
  });

  it('请求体不是合法 JSON 返回 400', async () => {
    const req = new Request('https://local.test/api/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        cookie: `${SESSION_COOKIE}=${signSession().token}`,
      },
      body: '{ 坏 JSON',
    });
    expect((await PUT(req)).status).toBe(400);
  });

  it('超过体积上限返回 413', async () => {
    const huge = {
      settings: { blob: 'x'.repeat(5 * 1024 * 1024) },
      history: [],
      progress: [],
      searchHistory: [],
    };
    const res = await PUT(makeRequest('PUT', { payload: huge, deviceId: 'd' }));
    expect(res.status).toBe(413);
  });
});

describe('PUT 乐观并发检测', () => {
  it('baseUpdatedAt 与服务端一致时写入成功', async () => {
    const first = await (await PUT(makeRequest('PUT', { payload: samplePayload, deviceId: 'a' }))).json();
    const res = await PUT(
      makeRequest('PUT', {
        payload: samplePayload,
        deviceId: 'a',
        baseUpdatedAt: first.updatedAt,
      })
    );
    expect(res.status).toBe(200);
  });

  it('期间被别的设备写过 -> 409 并回传当前版本', async () => {
    const first = await (await PUT(makeRequest('PUT', { payload: samplePayload, deviceId: 'a' }))).json();
    // 设备 B 抢先写了一版
    await PUT(makeRequest('PUT', { payload: samplePayload, deviceId: 'b' }));
    // 设备 A 带着旧 baseUpdatedAt 再来写
    const res = await PUT(
      makeRequest('PUT', {
        payload: samplePayload,
        deviceId: 'a',
        baseUpdatedAt: first.updatedAt,
      })
    );
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.conflict).toBe(true);
    expect(data.deviceId).toBe('b');
  });

  it('force=true 时无视冲突强制覆盖', async () => {
    const first = await (await PUT(makeRequest('PUT', { payload: samplePayload, deviceId: 'a' }))).json();
    await PUT(makeRequest('PUT', { payload: samplePayload, deviceId: 'b' }));
    const res = await PUT(
      makeRequest('PUT', {
        payload: samplePayload,
        deviceId: 'a',
        baseUpdatedAt: first.updatedAt,
        force: true,
      })
    );
    expect(res.status).toBe(200);
    const data = await (await GET(makeRequest('GET'))).json();
    expect(data.deviceId).toBe('a');
  });

  it('不带 baseUpdatedAt 时不做冲突检测（首次初始化）', async () => {
    await PUT(makeRequest('PUT', { payload: samplePayload, deviceId: 'b' }));
    const res = await PUT(makeRequest('PUT', { payload: samplePayload, deviceId: 'a' }));
    expect(res.status).toBe(200);
  });
});

describe('DELETE', () => {
  it('删除后 exists 变回 false', async () => {
    await PUT(makeRequest('PUT', { payload: samplePayload, deviceId: 'd' }));
    expect((await DELETE(makeRequest('DELETE'))).status).toBe(200);
    const data = await (await GET(makeRequest('GET'))).json();
    expect(data.exists).toBe(false);
  });

  it('未登录时返回 401', async () => {
    const res = await DELETE(makeRequest('DELETE', undefined, { authenticated: false }));
    expect(res.status).toBe(401);
  });
});
