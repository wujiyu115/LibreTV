import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  dataDir,
  deleteSnapshot,
  isDataDirWritable,
  readSnapshot,
  writeSnapshot,
  MAX_SNAPSHOT_BYTES,
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
