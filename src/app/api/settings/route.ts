import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import {
  deleteSnapshot,
  isDataDirWritable,
  readSnapshot,
  writeSnapshot,
} from '@/lib/server-storage';
import {
  SYNC_SCHEMA_VERSION,
  type SettingsPutRequest,
  type SyncPayload,
} from '@/lib/sync-types';

export const runtime = 'nodejs';
/** 用户数据必须实时读写，不能被 Next 静态化或缓存 */
export const dynamic = 'force-dynamic';

/**
 * 单用户配置档。当前设计是「一个 PASSWORD 对应一份配置」：
 * LibreTV 的鉴权模型就是单一共享密码，没有多用户概念，
 * 因此用固定名 `default` 作为 profile，不做成多租户（那需要真的用户体系）。
 */
const PROFILE = 'default';

/** 各数组的条数上限：与前端 db.ts 的 MAX_HISTORY / MAX_SEARCH_HISTORY 对齐 */
const MAX_HISTORY = 100;
const MAX_PROGRESS = 5000;
const MAX_SEARCH_HISTORY = 10;

/**
 * 归一化客户端提交的载荷。
 *
 * 为什么要逐字段重建而不是直接存：这个接口会把内容落到磁盘，
 * 若原样信任客户端就等于开了一个任意写入通道。这里只保留已知结构，
 * 未知字段丢弃、超长截断、条数封顶，把「配置存储」的语义钉死。
 */
function normalizePayload(raw: unknown): SyncPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const num = (v: unknown, fallback = 0) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const str = (v: unknown, max = 2048) =>
    typeof v === 'string' ? v.slice(0, max) : '';

  // settings 是自由结构的设置对象（字段随版本演进），但必须是普通对象
  const settings =
    r.settings && typeof r.settings === 'object' && !Array.isArray(r.settings)
      ? (r.settings as Record<string, unknown>)
      : {};

  const history = (Array.isArray(r.history) ? r.history : [])
    .slice(0, MAX_HISTORY)
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return {
        id: str(o.id, 512),
        sourceKey: str(o.sourceKey, 2048),
        sourceUrl: o.sourceUrl ? str(o.sourceUrl, 2048) : undefined,
        vodId: str(o.vodId, 512),
        title: str(o.title, 512),
        pic: o.pic ? str(o.pic, 2048) : undefined,
        episodeIndex: num(o.episodeIndex),
        totalEpisodes: num(o.totalEpisodes),
        playbackPosition: num(o.playbackPosition),
        duration: num(o.duration),
        timestamp: num(o.timestamp),
      };
    })
    // 没有主键的记录无意义：既不能去重也不能定位，直接丢弃
    .filter((h) => h.id && h.sourceKey && h.vodId);

  const progress = (Array.isArray(r.progress) ? r.progress : [])
    .slice(0, MAX_PROGRESS)
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return {
        key: str(o.key, 2048),
        position: num(o.position),
        duration: num(o.duration),
        updatedAt: num(o.updatedAt),
      };
    })
    .filter((p) => p.key);

  const searchHistory = (Array.isArray(r.searchHistory) ? r.searchHistory : [])
    .slice(0, MAX_SEARCH_HISTORY)
    .map((item) => {
      const o = (item ?? {}) as Record<string, unknown>;
      return { text: str(o.text, 100), timestamp: num(o.timestamp) };
    })
    .filter((s) => s.text);

  return { settings, history, progress, searchHistory };
}

/** GET /api/settings：读取服务端配置（未登录 401） */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const snapshot = await readSnapshot<SyncPayload>(PROFILE);
  const writable = await isDataDirWritable();

  // 数据目录不可写时仍返回 200：让界面能展示「读得到但存不了」的原因，
  // 比直接 500 更容易让用户定位到「忘了挂载 /data」这个部署问题。
  return NextResponse.json({
    exists: snapshot !== null,
    updatedAt: snapshot?.updatedAt ?? 0,
    deviceId: snapshot?.deviceId ?? '',
    schemaVersion: SYNC_SCHEMA_VERSION,
    storageWritable: writable,
    payload: snapshot?.data ?? null,
  });
}

/** PUT /api/settings：写入配置（带乐观并发检测） */
export async function PUT(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;

  let body: SettingsPutRequest;
  try {
    body = (await req.json()) as SettingsPutRequest;
  } catch {
    return jsonError('请求体不是合法 JSON', 400);
  }

  const payload = normalizePayload(body?.payload);
  if (!payload) return jsonError('payload 结构不正确', 400);

  const deviceId = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 64) : '';
  if (!deviceId) return jsonError('缺少 deviceId', 400);

  // 乐观并发检测：客户端带了 baseUpdatedAt 且与服务端当前值不符，
  // 说明期间有别的设备写过。默认拒绝并回传当前版本，让用户决定是否覆盖，
  // 避免「手机上的改动被电脑上的旧页面静默冲掉」。
  if (!body.force && typeof body.baseUpdatedAt === 'number') {
    const current = await readSnapshot<SyncPayload>(PROFILE);
    const currentUpdatedAt = current?.updatedAt ?? 0;
    if (currentUpdatedAt !== body.baseUpdatedAt) {
      return NextResponse.json(
        {
          error: '服务端配置已被其他设备修改',
          conflict: true,
          updatedAt: currentUpdatedAt,
          deviceId: current?.deviceId ?? '',
        },
        { status: 409 }
      );
    }
  }

  const updatedAt = Date.now();
  try {
    await writeSnapshot<SyncPayload>(PROFILE, payload, { updatedAt, deviceId });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'TOO_LARGE') return jsonError('配置体积超出上限', 413);
    // 最常见的原因是没有挂载 /data（EROFS / EACCES），把这一点直接说出来
    return jsonError(
      `配置写入失败：${err instanceof Error ? err.message : '未知错误'}（请确认 DATA_DIR 已挂载为可写目录）`,
      500
    );
  }

  return NextResponse.json({ ok: true, updatedAt, deviceId });
}

/** DELETE /api/settings：清空服务端配置（界面上的「重置」入口使用） */
export async function DELETE(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;
  try {
    await deleteSnapshot(PROFILE);
  } catch (err) {
    return jsonError(
      `删除失败：${err instanceof Error ? err.message : '未知错误'}`,
      500
    );
  }
  return NextResponse.json({ ok: true });
}
