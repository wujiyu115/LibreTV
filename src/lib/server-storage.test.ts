import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  dataDir,
  deleteSnapshot,
  isDataDirWritable,
  mutateSnapshot,
  readSnapshot,
  writeSnapshot,
  MAX_SNAPSHOT_BYTES,
  VERSION_CONFLICT,
} from './server-storage';

let tmpDir: string;
const originalDataDir = process.env.DATA_DIR;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ltv-store-'));
  process.env.DATA_DIR = tmpDir;
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('dataDir', () => {
  it('默认 /data，可由 DATA_DIR 覆盖', () => {
    delete process.env.DATA_DIR;
    expect(dataDir()).toBe('/data');
    process.env.DATA_DIR = '/custom/path';
    expect(dataDir()).toBe('/custom/path');
  });

  it('空白值回落到默认目录（避免把数据写到当前工作目录）', () => {
    process.env.DATA_DIR = '   ';
    expect(dataDir()).toBe('/data');
  });
});

describe('readSnapshot / writeSnapshot', () => {
  it('文件不存在时返回 null（表示服务端还没有数据）', async () => {
    expect(await readSnapshot('default')).toBeNull();
  });

  it('写入后能读回，且带回 updatedAt 与 deviceId', async () => {
    await writeSnapshot('default', { hello: 'world' }, { updatedAt: 12345, deviceId: 'dev-a' });
    const snap = await readSnapshot<{ hello: string }>('default');
    expect(snap).not.toBeNull();
    expect(snap!.data).toEqual({ hello: 'world' });
    expect(snap!.updatedAt).toBe(12345);
    expect(snap!.deviceId).toBe('dev-a');
  });

  it('后写覆盖前写（同一 profile）', async () => {
    await writeSnapshot('default', { v: 1 }, { updatedAt: 1, deviceId: 'a' });
    await writeSnapshot('default', { v: 2 }, { updatedAt: 2, deviceId: 'b' });
    const snap = await readSnapshot<{ v: number }>('default');
    expect(snap!.data.v).toBe(2);
    expect(snap!.deviceId).toBe('b');
  });

  it('并发写入不产生半截文件，最终读到的是某一次完整写入', async () => {
    // 10 次并发写：原子 rename 保证任何时刻读到的都是完整 JSON
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writeSnapshot('default', { payload: 'x'.repeat(1000), i }, { updatedAt: i, deviceId: 'd' })
      )
    );
    const snap = await readSnapshot<{ payload: string; i: number }>('default');
    expect(snap).not.toBeNull();
    expect(snap!.data.payload).toHaveLength(1000);
    expect(typeof snap!.data.i).toBe('number');

    // 不留临时文件
    const files = await fs.readdir(tmpDir);
    expect(files.filter((f) => f.includes('.tmp.'))).toHaveLength(0);
  });

  it('文件内容损坏时返回 null 而不是抛错（可自愈）', async () => {
    await fs.writeFile(path.join(tmpDir, 'default.json'), '{ 这不是 JSON', 'utf8');
    expect(await readSnapshot('default')).toBeNull();
  });

  it('缺 updatedAt 的旧格式视为无效', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'default.json'),
      JSON.stringify({ data: { a: 1 } }),
      'utf8'
    );
    expect(await readSnapshot('default')).toBeNull();
  });

  it('超过体积上限时抛 TOO_LARGE，且不写坏已有文件', async () => {
    await writeSnapshot('default', { ok: true }, { updatedAt: 1, deviceId: 'a' });
    const huge = { blob: 'x'.repeat(MAX_SNAPSHOT_BYTES + 100) };
    await expect(
      writeSnapshot('default', huge, { updatedAt: 2, deviceId: 'b' })
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    // 原数据保持不变
    const snap = await readSnapshot<{ ok: boolean }>('default');
    expect(snap!.data).toEqual({ ok: true });
  });

  it('profile 名做白名单校验，阻止路径穿越', async () => {
    await expect(
      writeSnapshot('../escape', {}, { updatedAt: 1, deviceId: 'a' })
    ).rejects.toThrow(/非法的配置名/);
    await expect(readSnapshot('bad/name')).rejects.toThrow(/非法的配置名/);
    await expect(readSnapshot('UPPER')).rejects.toThrow(/非法的配置名/);
  });
});

describe('deleteSnapshot', () => {
  it('删除后读到 null', async () => {
    await writeSnapshot('default', { a: 1 }, { updatedAt: 1, deviceId: 'x' });
    await deleteSnapshot('default');
    expect(await readSnapshot('default')).toBeNull();
  });

  it('文件不存在时不报错（幂等）', async () => {
    await expect(deleteSnapshot('default')).resolves.toBeUndefined();
  });
});

describe('isDataDirWritable', () => {
  it('目录可写时返回 true', async () => {
    expect(await isDataDirWritable()).toBe(true);
  });

  it('目录无法创建时返回 false（部署忘了挂载的情况）', async () => {
    // 指向一个普通文件下的路径：mkdir 必然失败
    const blocker = path.join(tmpDir, 'blocker');
    await fs.writeFile(blocker, 'x');
    process.env.DATA_DIR = path.join(blocker, 'sub');
    expect(await isDataDirWritable()).toBe(false);
  });

  it('探测后不留下临时文件', async () => {
    await isDataDirWritable();
    const files = await fs.readdir(tmpDir);
    expect(files.filter((f) => f.startsWith('.probe'))).toHaveLength(0);
  });
});

describe('mutateSnapshot（并发安全与版本单调）', () => {
  /**
   * 回归：updatedAt 曾用纯 Date.now()，同一毫秒内两次写入版本号相同。
   * 客户端拿着「和自己刚读到的旧版本相同」的 baseUpdatedAt 再来写时，
   * 服务端比较相等 -> 判定无冲突 -> 静默覆盖另一台设备的修改。
   * CI 上 ulid 跑得快时必现（本地跨过了毫秒边界所以偶发漏过）。
   */
  it('同一毫秒内连续写入，版本号严格递增', async () => {
    const seen: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await mutateSnapshot<{ i: number }>('default', () => ({
        data: { i },
        deviceId: 'd',
      }));
      seen.push(r.updatedAt);
    }
    // 严格递增（无重复、无回退）
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThan(seen[i - 1]);
    }
    // 远快于毫秒时，说明确实靠 +1 在推进而不是真实时钟
    expect(seen[seen.length - 1] - seen[0]).toBeGreaterThanOrEqual(19);
  });

  it('expectUpdatedAt 不匹配时抛 VERSION_CONFLICT 并带上当前版本', async () => {
    const first = await mutateSnapshot<{ v: number }>('default', () => ({ data: { v: 1 }, deviceId: 'a' }));
    const second = await mutateSnapshot<{ v: number }>('default', () => ({ data: { v: 2 }, deviceId: 'b' }));

    await expect(
      mutateSnapshot<{ v: number }>('default', () => ({
        data: { v: 3 },
        deviceId: 'a',
        expectUpdatedAt: first.updatedAt, // 已过期
      }))
    ).rejects.toMatchObject({
      code: VERSION_CONFLICT,
      updatedAt: second.updatedAt,
      deviceId: 'b',
    });

    // 失败的写入不落盘
    const snap = await readSnapshot<{ v: number }>('default');
    expect(snap!.data.v).toBe(2);
  });

  it('并发写入下只有一个能拿到期望版本，其余全部冲突（不丢修改）', async () => {
    const base = await mutateSnapshot<{ from: string }>('default', () => ({
      data: { from: 'init' },
      deviceId: 'init',
    }));

    // 5 个设备同时带着同一个 baseUpdatedAt 来写
    const results = await Promise.allSettled(
      ['d1', 'd2', 'd3', 'd4', 'd5'].map((d) =>
        mutateSnapshot<{ from: string }>('default', () => ({
          data: { from: d },
          deviceId: d,
          expectUpdatedAt: base.updatedAt,
        }))
      )
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const conflicts = results.filter(
      (r) => r.status === 'rejected' && (r.reason as { code?: string }).code === VERSION_CONFLICT
    );
    // 恰好一个成功，其余明确报冲突（而不是全部成功互相覆盖）
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(4);

    const snap = await readSnapshot<{ from: string }>('default');
    const winner = (ok[0] as PromiseFulfilledResult<{ updatedAt: number; deviceId: string }>).value;
    expect(snap!.data.from).toBe(winner.deviceId);
  });

  it('不带 expectUpdatedAt 时总是覆盖（初始化 / force 场景）', async () => {
    await mutateSnapshot<{ v: number }>('default', () => ({ data: { v: 1 }, deviceId: 'a' }));
    const r = await mutateSnapshot<{ v: number }>('default', () => ({ data: { v: 2 }, deviceId: 'b' }));
    expect(r.deviceId).toBe('b');
    const snap = await readSnapshot<{ v: number }>('default');
    expect(snap!.data.v).toBe(2);
  });

  it('体积超限时不写坏已有文件', async () => {
    await mutateSnapshot<{ ok: boolean }>('default', () => ({ data: { ok: true }, deviceId: 'a' }));
    await expect(
      mutateSnapshot<{ blob: string }>('default', () => ({
        data: { blob: 'x'.repeat(MAX_SNAPSHOT_BYTES + 100) },
        deviceId: 'b',
      }))
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const snap = await readSnapshot<{ ok: boolean }>('default');
    expect(snap!.data.ok).toBe(true);
  });
});
