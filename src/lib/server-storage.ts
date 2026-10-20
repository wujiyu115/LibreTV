/**
 * 服务端持久化存储。
 *
 * 为什么需要它：此前所有用户数据（源配置、订阅、观影历史、播放进度）都存在
 * 浏览器 localStorage / IndexedDB 里，服务端零持久化。换浏览器、换设备、
 * 清缓存、容器重建后数据即丢，也无法多端续播。
 *
 * 存储位置由 DATA_DIR 决定（默认 /data）。容器镜像里 /app 是只读的，
 * 因此这个目录必须由部署者挂载出来（Unraid 模板映射到 appdata），
 * 否则容器一旦重建数据就没了 —— 容器可写层不是持久化方案。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 数据目录：默认 /data，部署者可通过 DATA_DIR 覆盖 */
export function dataDir(): string {
  return process.env.DATA_DIR?.trim() || '/data';
}

/**
 * 单份快照的体积上限。
 * 源配置 + 100 条历史 + 进度表实测在几十 KB 量级，留两个数量级余量足够；
 * 设上限是为了防止被当成任意大文件的中转（本接口语义是配置存储，不是上传通道）。
 */
export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

/** 快照文件名：profile 白名单化，避免路径穿越 */
const SAFE_PROFILE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface SnapshotMeta {
  /** 服务端最后写入时间（毫秒） */
  updatedAt: number;
  /** 最后写入的设备标识，用于多端冲突时告知用户「谁覆盖了谁」 */
  deviceId: string;
}

export type Snapshot<T> = SnapshotMeta & { data: T };

function snapshotPath(profile: string): string {
  if (!SAFE_PROFILE.test(profile)) throw new Error(`非法的配置名：${profile}`);
  return path.join(dataDir(), `${profile}.json`);
}

/**
 * 进程内串行写锁（按 profile）。
 *
 * 同一 profile 的读-改-写必须串行：两个并发 PUT 都读到旧值再各自写回，
 * 后写的会静默吞掉前一次的修改。服务端是单 Node 进程，模块级 Map 足够；
 * 不依赖文件锁是因为容器里未必有可用的 advisory lock 工具。
 */
const writeChains = new Map<string, Promise<unknown>>();

function withLock<T>(profile: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(profile) ?? Promise.resolve();
  // catch 兜底：前一次失败不能阻断后续写入（否则一次异常会永久卡死该 profile）
  const next = prev.catch(() => undefined).then(fn);
  writeChains.set(profile, next);
  // 链尾清理：避免 Map 无限增长（同时也避免持有已完成的 promise）
  void next.catch(() => undefined).then(() => {
    if (writeChains.get(profile) === next) writeChains.delete(profile);
  });
  return next;
}

/**
 * 读快照。文件不存在返回 null（视为「服务端还没有数据」，由调用方决定初始化策略）。
 *
 * JSON 解析失败时同样返回 null 而不是抛错：数据文件可能是手工编辑出错，
 * 或上次写入被硬中断（虽然有原子写保护，仍不做过度乐观假设）。
 * 此时上层会用客户端数据重新初始化，比整个接口 500 更能自愈。
 */
export async function readSnapshot<T>(profile: string): Promise<Snapshot<T> | null> {
  const file = snapshotPath(profile);
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // ENOTDIR / EACCES：DATA_DIR 指向了普通文件或无权限目录。
    // 这类部署问题由 isDataDirWritable() 单独报告，读接口不应因此 500
    // （否则界面连「为什么存不了」都展示不出来）。
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot<T>>;
    if (typeof parsed?.updatedAt !== 'number' || !parsed.data) return null;
    return {
      updatedAt: parsed.updatedAt,
      deviceId: typeof parsed.deviceId === 'string' ? parsed.deviceId : '',
      data: parsed.data as T,
    };
  } catch {
    return null;
  }
}

/**
 * 原子写快照。
 *
 * 先写同目录临时文件再 rename：rename 在同一文件系统内是原子的，
 * 进程被杀/容器重启时读到的要么是旧完整文件、要么是新完整文件，
 * 不会出现半截 JSON。直接 writeFile 到目标文件则有截断窗口。
 *
 * 临时文件名带 pid + 随机串：同一 profile 的写入已被 withLock 串行化，
 * 但不同 profile 可能并发，且容器里可能有多个 Node 进程（不应假设唯一）。
 */
export async function writeSnapshot<T>(
  profile: string,
  data: T,
  meta: SnapshotMeta
): Promise<void> {
  const file = snapshotPath(profile);
  const payload = JSON.stringify({ ...meta, data });
  if (Buffer.byteLength(payload, 'utf8') > MAX_SNAPSHOT_BYTES) {
    throw Object.assign(new Error('配置体积超出上限'), { code: 'TOO_LARGE' });
  }

  await withLock(profile, async () => {
    await fs.mkdir(dataDir(), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
    try {
      await fs.writeFile(tmp, payload, 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      // 失败时清掉临时文件，避免残留堆积在 appdata 里
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  });
}

/** 删除快照（幂等：文件不存在也算成功） */
export async function deleteSnapshot(profile: string): Promise<void> {
  const file = snapshotPath(profile);
  await withLock(profile, async () => {
    await fs.rm(file, { force: true });
  });
}

/**
 * 数据目录是否可写。
 * 部署者忘记挂载 /data 时，写入会失败；在状态接口里暴露这一点，
 * 让用户能在界面上看到「配置无法保存」而不是以为保存成功了。
 */
export async function isDataDirWritable(): Promise<boolean> {
  try {
    await fs.mkdir(dataDir(), { recursive: true });
    const probe = path.join(dataDir(), `.probe.${process.pid}`);
    await fs.writeFile(probe, '');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}
