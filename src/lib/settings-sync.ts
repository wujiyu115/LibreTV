'use client';

/**
 * 服务端配置同步（配置 + 个人数据）。
 *
 * 设计要点：
 *
 * 1. **服务端为权威源**。登录后先 GET，服务端有数据就覆盖本地；
 *    服务端为空（全新安装）才把本地数据推上去做初始化。
 *    反过来（本地优先）会导致「旧设备一上线就把新设备的改动冲掉」。
 *
 * 2. **写穿 + 防抖**。本地改动在 800ms 静默后推送，不阻塞界面；
 *    与 localStorage 的节流窗口对齐，避免一次操作触发多次上传。
 *
 * 3. **乐观并发检测**。每次 PUT 带上「我看到的服务端版本号」，
 *    服务端发现不一致就回 409，此时不静默覆盖，而是提示用户
 *    「另一台设备改过了」，由用户选择以哪边为准。
 *    这是单密码多设备场景下唯一不会丢数据的选择。
 *
 * 4. **deviceId 只用于诊断**。记录「哪台设备最后写的」，
 *    冲突提示里能说清是谁覆盖了谁，但不用它做合并决策。
 */

import { api } from './client-api';
import { exportPersonalData, importPersonalData } from './db';
import { PERSIST_KEY, flushPendingPersist } from './persist-storage';
import { useAppStore } from './store';
import {
  SYNC_SCHEMA_VERSION,
  type SettingsGetResponse,
  type SyncPayload,
} from './sync-types';

const DEVICE_ID_KEY = 'libretv-device-id';

/** 推送防抖窗口：与 persist-storage 的 800ms 节流一致，一次操作只上传一次 */
const PUSH_DEBOUNCE_MS = 800;

/**
 * 本设备的稳定标识。
 *
 * 用 crypto.randomUUID 而不是指纹：指纹（屏幕/UA/时区）会把两台同型号
 * 手机认成同一台，而这里只需要「区分不同浏览器实例」。
 * 存 localStorage 而不是内存：同一浏览器刷新后仍是同一台设备。
 */
export function getDeviceId(): string {
  if (typeof window === 'undefined') return '';
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID?.() ?? `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // 隐私模式下 localStorage 可能不可写：退化为会话内临时 id，
    // 不影响同步功能，只是诊断信息不稳定
    return `tmp-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 从 localStorage 读出 store 的 settings 部分（即 persist 的 state） */
function readLocalSettings(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown> };
    return parsed?.state ?? {};
  } catch {
    return {};
  }
}

/** 收集本地全部待同步数据（settings + 三张个人数据表） */
async function collectLocalPayload(): Promise<SyncPayload> {
  // 先 flush：节流缓冲里的最新改动还没落盘，直接读 localStorage 会拿到旧值
  flushPendingPersist();
  const personal = await exportPersonalData();
  return {
    settings: readLocalSettings(),
    history: personal.history,
    progress: personal.progress,
    searchHistory: personal.searchHistory,
  };
}

/** 同步状态：界面用它显示「已保存 / 保存中 / 冲突 / 存不了」 */
export type SyncStatus = 'idle' | 'syncing' | 'saved' | 'conflict' | 'error' | 'disabled';

interface SyncState {
  status: SyncStatus;
  /** 服务端最后写入时间（本地镜像，用于下次 PUT 的 baseUpdatedAt） */
  serverUpdatedAt: number;
  /** 服务端最后写入的设备 */
  serverDeviceId: string;
  /** 最近一次错误信息，供提示 */
  error: string;
  /** 服务端数据目录是否可写（false 时不该继续尝试推送） */
  storageWritable: boolean | null;
  /** 冲突详情：服务端当前版本，供用户决定是否覆盖 */
  conflict: { updatedAt: number; deviceId: string } | null;
}

const state: SyncState = {
  status: 'idle',
  serverUpdatedAt: 0,
  serverDeviceId: '',
  error: '',
  storageWritable: null,
  conflict: null,
};

const listeners = new Set<() => void>();

function emit(patch: Partial<SyncState>): void {
  Object.assign(state, patch);
  listeners.forEach((fn) => fn());
}

/** 订阅同步状态（React 用 useSyncExternalStore 消费） */
export function subscribeSyncStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSyncStatus(): SyncState {
  return state;
}

let started = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
/** 串行化推送：并发 PUT 会让服务端的乐观并发检测误判成冲突 */
let pushChain: Promise<void> = Promise.resolve();

/**
 * 把服务端快照应用到本地。
 *
 * settings 不能直接整体替换 localStorage：store 已经 rehydrate 过了，
 * 只改 localStorage 内存里还是旧值。正确做法是先写 localStorage，
 * 再让 store 重新 rehydrate 一次（zustand 的 rehydrate 会重读 storage）。
 */
async function applyServerPayload(payload: SyncPayload): Promise<void> {
  // 1) settings：写进 localStorage 对应键，再触发 store 重新加载
  try {
    const next = JSON.stringify({
      state: payload.settings,
      // version 必须保留，否则下次 rehydrate 会走 migrate 把数据当成 v0 处理
      version: SYNC_SCHEMA_VERSION,
    });
    localStorage.setItem(PERSIST_KEY, next);
  } catch {
    // 配额不足时放弃 settings 同步，个人数据仍继续
  }
  await useAppStore.persist.rehydrate();

  // 2) 个人数据：整体替换三张表
  await importPersonalData({
    history: payload.history,
    progress: payload.progress,
    searchHistory: payload.searchHistory,
  });
}

/**
 * 启动同步：登录成功后调用（未登录时不应该调，接口会 401）。
 *
 * 返回值表示是否成功完成了一次握手，失败不抛错（同步是增强功能，
 * 不能因为服务端问题让用户用不了站点）。
 */
export async function startSync(): Promise<void> {
  if (started) return;
  started = true;
  emit({ status: 'syncing', error: '', conflict: null });

  try {
    const remote = await api.getSettings();

    if (remote.storageWritable === false) {
      // 部署问题：服务端存不了。此时继续推送只会每次都失败并弹错，
      // 直接停用同步并保留状态供界面提示。
      emit({
        status: 'disabled',
        storageWritable: false,
        error: '服务端数据目录不可写（DATA_DIR 未挂载），配置只能保存在本浏览器',
      });
      return;
    }

    emit({ storageWritable: remote.storageWritable });

    if (!remote.exists || !remote.payload) {
      // 服务端为空：把本地数据推上去做初始化。
      // 注意这里不带 baseUpdatedAt（服务端还没有版本可对齐）。
      emit({ serverUpdatedAt: 0, serverDeviceId: '' });
      await pushNow({ baseUpdatedAt: undefined });
    } else {
      // 服务端有数据：以服务端为准覆盖本地
      await applyServerPayload(remote.payload);
      emit({
        serverUpdatedAt: remote.updatedAt,
        serverDeviceId: remote.deviceId,
        status: 'saved',
      });
    }

    attachWatchers();
  } catch (err) {
    // 401 说明未登录，不算错误（调用方时机不对）；其余记录供界面展示
    const message = err instanceof Error ? err.message : '同步失败';
    emit({ status: 'error', error: message });
  } finally {
    started = false;
  }
}

/** 立即推送一次当前本地数据 */
async function pushNow(opts: { baseUpdatedAt?: number; force?: boolean } = {}): Promise<void> {
  const run = async () => {
    try {
      const payload = await collectLocalPayload();
      const res = await api.putSettings({
        payload,
        deviceId: getDeviceId(),
        baseUpdatedAt: opts.baseUpdatedAt,
        force: opts.force,
      });
      emit({
        status: 'saved',
        serverUpdatedAt: res.updatedAt,
        serverDeviceId: res.deviceId,
        error: '',
        conflict: null,
      });
    } catch (err) {
      // 409 是冲突而非失败：单独标记，让界面提示用户选择覆盖方式
      const conflict = err as { status?: number; updatedAt?: number; deviceId?: string };
      if (conflict?.status === 409) {
        emit({
          status: 'conflict',
          conflict: {
            updatedAt: conflict.updatedAt ?? 0,
            deviceId: conflict.deviceId ?? '',
          },
          error: '另一台设备修改过配置',
        });
        return;
      }
      emit({
        status: 'error',
        error: err instanceof Error ? err.message : '保存失败',
      });
    }
  };
  pushChain = pushChain.then(run, run);
  return pushChain;
}

/** 防抖推送：本地改动后调用 */
export function scheduleSync(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (state.status === 'disabled') return;
    void pushNow({ baseUpdatedAt: state.serverUpdatedAt });
  }, PUSH_DEBOUNCE_MS);
}

/**
 * 用户确认「以本机为准」：强制覆盖服务端。
 * 冲突时界面弹提示，用户点「用这台设备的配置覆盖」后调用。
 */
export async function forcePushLocal(): Promise<void> {
  await pushNow({ force: true });
}

/**
 * 用户确认「以服务端为准」：丢弃本地改动，重新拉取。
 */
export async function pullFromServer(): Promise<void> {
  emit({ status: 'syncing', conflict: null });
  try {
    const remote = await api.getSettings();
    if (remote.exists && remote.payload) {
      await applyServerPayload(remote.payload);
      emit({
        status: 'saved',
        serverUpdatedAt: remote.updatedAt,
        serverDeviceId: remote.deviceId,
        conflict: null,
        error: '',
      });
    } else {
      emit({ status: 'saved', conflict: null, error: '' });
    }
  } catch (err) {
    emit({ status: 'error', error: err instanceof Error ? err.message : '拉取失败' });
  }
}

/**
 * 挂载变更监听：settings 走 zustand subscribe，个人数据走定时比对。
 *
 * 个人数据用轮询而不是事件的原因：db.ts 里的写入口有十几个（upsertHistory /
 * updateHistoryProgress / saveProgress / addSearchHistory ...），逐个改造
 * 侵入性大且容易漏；播放进度本身是几秒一次的低频写，30s 比对一次足够，
 * 且比对只是查 count + 最新 updatedAt，开销很小。
 */
let watchersAttached = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPersonalStamp = '';

/** 用「条数 + 最大时间戳」作为个人数据的轻量指纹：任一条新增/更新都会改变它 */
function personalStampOf(d: {
  history: { timestamp: number }[];
  progress: { updatedAt: number }[];
  searchHistory: { timestamp: number }[];
}): string {
  const maxHistory = d.history.reduce((m, x) => Math.max(m, x.timestamp), 0);
  const maxProgress = d.progress.reduce((m, x) => Math.max(m, x.updatedAt), 0);
  const maxSearch = d.searchHistory.reduce((m, x) => Math.max(m, x.timestamp), 0);
  return [
    d.history.length,
    maxHistory,
    d.progress.length,
    maxProgress,
    d.searchHistory.length,
    maxSearch,
  ].join(':');
}

function attachWatchers(): void {
  if (watchersAttached || typeof window === 'undefined') return;
  watchersAttached = true;

  // settings：任何 store 变更都安排一次推送。
  // persist 的写入本身是节流的，所以这里不需要再判断字段是否变化。
  useAppStore.subscribe(() => {
    if (state.status === 'disabled') return;
    scheduleSync();
  });

  // 个人数据：定时比对指纹
  void (async () => {
    lastPersonalStamp = personalStampOf(await exportPersonalData());
  })();
  pollTimer = setInterval(async () => {
    if (state.status === 'disabled') return;
    try {
      const data = await exportPersonalData();
      const stamp = personalStampOf(data);
      if (stamp !== lastPersonalStamp) {
        lastPersonalStamp = stamp;
        scheduleSync();
      }
    } catch {
      // IndexedDB 不可用时静默跳过
    }
  }, 30_000);

  // 页面隐藏/卸载前立即推送：否则最后一个改动可能还在防抖窗口里
  const flushNow = () => {
    if (state.status === 'disabled') return;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    // 用 keepalive 语义在这里做不到（request 封装不支持），
    // 因此仍然发起普通请求；visibilitychange 到真正卸载通常有几百毫秒余量
    void pushNow({ baseUpdatedAt: state.serverUpdatedAt });
  };
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushNow();
  });
  window.addEventListener('pagehide', flushNow);
}

/** 停止同步（登出时调用） */
export function stopSync(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  watchersAttached = false;
  emit({ status: 'idle', conflict: null, error: '' });
}

export type { SettingsGetResponse };
