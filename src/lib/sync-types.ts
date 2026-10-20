/**
 * 服务端同步数据的结构定义。
 *
 * 独立成模块的原因：服务端路由与客户端同步层都要用它，
 * 而 db.ts / store.ts 都带 `'use client'` 依赖（Dexie、zustand），
 * 服务端路由不能 import 它们，否则会把浏览器代码打进 Node bundle。
 *
 * 本文件只放纯类型与常量，不含任何运行时代码，两端都能安全引用。
 */

/** 同步的数据版本：结构变更时递增，服务端据此决定是否兼容旧数据 */
export const SYNC_SCHEMA_VERSION = 1;

/**
 * 同步范围的选择依据（对应「配置 + 个人数据」）：
 *
 * - settings：AppSettings 的持久化字段（源、订阅、开关、过滤设置）。
 *   体积小，是多端一致性的核心。
 * - history / progress / searchHistory：个人数据，跨设备续播的关键。
 *
 * 刻意不含：
 * - downloads / segmentMeta：这些指向本地文件字节，跨设备没有意义。
 * - liveProbeResults / sourceHealth / qualityMap：依赖各设备网络环境，
 *   共享反而会互相误判（家里 Wi-Fi 好、公司网差），保留在本机。
 * - envSources / liveEnvSources：每次由服务端环境变量下发，不该回写。
 */
export interface SyncPayload {
  /** 设置快照：即原 localStorage 里 libretv-settings 的 state 部分 */
  settings: Record<string, unknown>;
  history: SyncHistoryEntry[];
  progress: SyncProgressEntry[];
  searchHistory: SyncSearchEntry[];
}

export interface SyncHistoryEntry {
  id: string;
  sourceKey: string;
  sourceUrl?: string;
  vodId: string;
  title: string;
  pic?: string;
  episodeIndex: number;
  totalEpisodes: number;
  playbackPosition: number;
  duration: number;
  timestamp: number;
}

export interface SyncProgressEntry {
  key: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface SyncSearchEntry {
  text: string;
  timestamp: number;
}

/** GET /api/settings 的响应 */
export interface SettingsGetResponse {
  /** 服务端是否已有数据：false 表示这次是全新安装 */
  exists: boolean;
  /** 最后写入时间；无数据时为 0 */
  updatedAt: number;
  /** 最后写入的设备；无数据时为空串 */
  deviceId: string;
  /** 结构版本，便于将来迁移 */
  schemaVersion: number;
  /** 数据目录是否可写：false 时前端应提示「配置无法保存」 */
  storageWritable: boolean;
  /** 数据本体；exists 为 false 时为 null */
  payload: SyncPayload | null;
}

/** PUT /api/settings 的请求体 */
export interface SettingsPutRequest {
  payload: SyncPayload;
  /** 发起写入的设备标识，服务端原样记下并返回 */
  deviceId: string;
  /**
   * 客户端看到的服务端版本号（即上次 GET 拿到的 updatedAt）。
   * 用于乐观并发检测：与服务端当前值不符说明期间有别的设备写过，
   * 服务端返回 409 + 当前数据，由客户端决定是否覆盖。
   */
  baseUpdatedAt?: number;
  /** 为 true 时无视 baseUpdatedAt，强制覆盖（用户确认「以我这台为准」后使用） */
  force?: boolean;
}

/** PUT 成功响应 */
export interface SettingsPutResponse {
  ok: true;
  updatedAt: number;
  deviceId: string;
}

/** PUT 冲突响应（HTTP 409） */
export interface SettingsConflictResponse {
  error: string;
  conflict: true;
  /** 服务端当前的写入信息，供客户端展示「哪台设备在什么时候改过」 */
  updatedAt: number;
  deviceId: string;
}

/** 空载荷（服务端无数据且客户端也没数据时使用） */
export function emptyPayload(): SyncPayload {
  return { settings: {}, history: [], progress: [], searchHistory: [] };
}
