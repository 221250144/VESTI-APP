import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatusView } from '../shared/contracts';
import {
  UPDATE_INITIAL_DELAY_MS,
  UPDATE_POLL_INTERVAL_MS,
  UpdateService,
  type AutoUpdaterLike,
} from './updateService';

// electron-updater 依赖 electron 运行时,node 测试环境不可加载;测试中一律
// 注入 FakeAutoUpdater,模块 mock 只是兜底(防止默认分支被意外触达)。
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    on: vi.fn(),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
  },
}));

type AnyListener = (arg?: any) => void;

/** 可控的 autoUpdater 假实现:check/download 时同步派发事件,可注入失败。 */
class FakeAutoUpdater implements AutoUpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  availableVersion: string | null = '0.4.0';
  failNextCheck: Error | null = null;
  failNextDownload: Error | null = null;
  checkCalls = 0;
  downloadCalls = 0;
  quitCalls = 0;
  readonly registered: string[] = [];
  private readonly listeners = new Map<string, AnyListener[]>();

  on(event: string, listener: AnyListener): this {
    this.registered.push(event);
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }

  async checkForUpdates(): Promise<unknown> {
    this.checkCalls += 1;
    this.emit('checking-for-update');
    if (this.failNextCheck) {
      const error = this.failNextCheck;
      this.failNextCheck = null;
      this.emit('error', error);
      throw error;
    }
    if (this.availableVersion) this.emit('update-available', { version: this.availableVersion });
    else this.emit('update-not-available', { version: '0.3.1' });
    return null;
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadCalls += 1;
    if (this.failNextDownload) {
      const error = this.failNextDownload;
      this.failNextDownload = null;
      this.emit('error', error);
      throw error;
    }
    this.emit('download-progress', { percent: 40, bytesPerSecond: 1024 });
    this.emit('download-progress', { percent: 100, bytesPerSecond: 2048 });
    this.emit('update-downloaded', { version: this.availableVersion ?? '0.4.0' });
    return [];
  }

  quitAndInstall(): void {
    this.quitCalls += 1;
  }
}

function makeService(options: {
  isPackaged?: boolean;
  updater?: FakeAutoUpdater;
  logs?: string[];
  initialDelayMs?: number;
  pollIntervalMs?: number;
} = {}): { service: UpdateService; updater: FakeAutoUpdater; logs: string[] } {
  const updater = options.updater ?? new FakeAutoUpdater();
  const logs = options.logs ?? [];
  const service = new UpdateService({
    isPackaged: options.isPackaged ?? true,
    currentVersion: '0.3.1',
    autoUpdater: updater,
    log: line => logs.push(line),
    ...(options.initialDelayMs !== undefined ? { initialDelayMs: options.initialDelayMs } : {}),
    ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
  });
  return { service, updater, logs };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('UpdateService (dev / unpackaged)', () => {
  it('dev 构建是完全 no-op:不挂事件、不起定时器、动作全部落空', async () => {
    const { service, updater } = makeService({ isPackaged: false });
    service.start();

    expect(service.getStatus()).toMatchObject({ enabled: false, phase: 'idle', currentVersion: '0.3.1' });
    expect(updater.registered).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS + UPDATE_POLL_INTERVAL_MS * 2);
    expect(updater.checkCalls).toBe(0);

    const before = service.getStatus();
    expect(await service.checkForUpdates()).toEqual(before);
    expect(await service.downloadUpdate()).toEqual(before);
    expect(() => service.quitAndInstall()).not.toThrow();
    expect(updater.checkCalls).toBe(0);
    expect(updater.downloadCalls).toBe(0);
    expect(updater.quitCalls).toBe(0);
    // dev 下不强制配置下载策略。
    expect(updater.autoDownload).toBe(true);
  });
});

describe('UpdateService (packaged)', () => {
  it('start 配置用户确认下载策略并挂载全部事件', () => {
    const { service, updater } = makeService();
    service.start();
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.registered.sort()).toEqual([
      'checking-for-update',
      'download-progress',
      'error',
      'update-available',
      'update-downloaded',
      'update-not-available',
    ].sort());
    service.stop();
  });

  it('状态机 happy path:checking → available → downloading → downloaded,全程广播', async () => {
    const { service } = makeService();
    service.start();
    const seen: UpdateStatusView[] = [];
    service.onStatusChanged(status => seen.push(status));

    const available = await service.checkForUpdates();
    expect(available).toMatchObject({
      enabled: true,
      phase: 'available',
      latestVersion: '0.4.0',
      currentVersion: '0.3.1',
    });
    expect(available.checkedAt).not.toBeNull();
    // checkForUpdates 自身先置 checking,autoUpdater 事件再确认一次(幂等)。
    expect(seen.map(s => s.phase)).toEqual(['checking', 'checking', 'available']);

    const downloaded = await service.downloadUpdate();
    expect(downloaded).toMatchObject({ phase: 'downloaded', percent: 100, bytesPerSecond: null });
    expect(seen.map(s => s.phase)).toEqual([
      'checking',
      'checking',
      'available',
      'downloading',
      'downloading',
      'downloading',
      'downloaded',
    ]);
    // 下载进度细节:40% 时带速度。
    const mid = seen.find(s => s.percent === 40);
    expect(mid).toMatchObject({ phase: 'downloading', bytesPerSecond: 1024 });
    service.stop();
  });

  it('quitAndInstall 仅在 downloaded 后放行', async () => {
    const { service, updater } = makeService();
    service.start();
    expect(() => service.quitAndInstall()).toThrow('当前没有可安装的已下载更新');
    expect(updater.quitCalls).toBe(0);

    await service.checkForUpdates();
    await service.downloadUpdate();
    expect(service.getStatus().phase).toBe('downloaded');
    service.quitAndInstall();
    expect(updater.quitCalls).toBe(1);
    service.stop();
  });

  it('服务器无更新时回到 idle 并记录检查时间', async () => {
    const updater = new FakeAutoUpdater();
    updater.availableVersion = null;
    const { service } = makeService({ updater });
    service.start();

    const status = await service.checkForUpdates();
    expect(status).toMatchObject({ phase: 'idle', latestVersion: null, percent: null });
    expect(status.checkedAt).not.toBeNull();
    service.stop();
  });

  it('检查失败转入 error:静默记日志、不抛出', async () => {
    const { service, updater, logs } = makeService();
    service.start();
    updater.failNextCheck = new Error('network down');

    const status = await service.checkForUpdates();
    expect(status).toMatchObject({ phase: 'error', error: 'network down' });
    expect(logs.some(line => line.includes('network down'))).toBe(true);

    // 失败后允许重试并自愈。
    const recovered = await service.checkForUpdates();
    expect(recovered.phase).toBe('available');
    service.stop();
  });

  it('autoUpdater 仅派发 error 事件(无 promise 拒绝)也会转入 error', async () => {
    const { service, updater } = makeService();
    service.start();
    updater.emit('error', new Error('signature mismatch'));
    expect(service.getStatus()).toMatchObject({ phase: 'error', error: 'signature mismatch' });
    service.stop();
  });

  it('下载失败转入 error,不污染已发现版本', async () => {
    const { service, updater } = makeService();
    service.start();
    await service.checkForUpdates();
    updater.failNextDownload = new Error('disk full');

    const status = await service.downloadUpdate();
    expect(status).toMatchObject({ phase: 'error', error: 'disk full', latestVersion: '0.4.0' });
    service.stop();
  });

  it('并发守卫:checking/downloading/downloaded 中的检查与下载直接落空', async () => {
    const { service, updater } = makeService();
    service.start();

    // checking 中:手动再检查不再调用 autoUpdater。
    updater.emit('checking-for-update');
    expect(service.getStatus().phase).toBe('checking');
    await service.checkForUpdates();
    expect(updater.checkCalls).toBe(0);

    // downloading 中:检查与重复下载都被跳过。
    updater.emit('update-available', { version: '0.4.0' });
    updater.emit('download-progress', { percent: 10, bytesPerSecond: 1 });
    expect(service.getStatus().phase).toBe('downloading');
    await service.checkForUpdates();
    await service.downloadUpdate();
    expect(updater.checkCalls).toBe(0);
    expect(updater.downloadCalls).toBe(0);

    // downloaded 中:重复检查/下载都被跳过(保住待安装状态)。
    updater.emit('update-downloaded', { version: '0.4.0' });
    expect(service.getStatus().phase).toBe('downloaded');
    await service.checkForUpdates();
    await service.downloadUpdate();
    expect(updater.checkCalls).toBe(0);
    expect(updater.downloadCalls).toBe(0);
    expect(service.getStatus().phase).toBe('downloaded');
    service.stop();
  });

  it('轮询:启动延迟后自动检查一次,之后按间隔轮询;stop 后停止', async () => {
    const updater = new FakeAutoUpdater();
    updater.availableVersion = null; // 每轮回到 idle,不阻塞下一轮
    const { service } = makeService({ updater });
    service.start();

    expect(updater.checkCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS - 1);
    expect(updater.checkCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(updater.checkCalls).toBe(1);

    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS);
    expect(updater.checkCalls).toBe(2);
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS);
    expect(updater.checkCalls).toBe(3);

    service.stop();
    await vi.advanceTimersByTimeAsync(UPDATE_POLL_INTERVAL_MS * 3);
    expect(updater.checkCalls).toBe(3);
  });

  it('downloaded 状态下轮询自动跳过,不打乱待安装状态', async () => {
    const { service, updater } = makeService();
    service.start();
    await service.checkForUpdates();
    await service.downloadUpdate();
    const checks = updater.checkCalls;

    await vi.advanceTimersByTimeAsync(UPDATE_INITIAL_DELAY_MS + UPDATE_POLL_INTERVAL_MS * 2);
    expect(updater.checkCalls).toBe(checks);
    expect(service.getStatus().phase).toBe('downloaded');
    service.stop();
  });
});
