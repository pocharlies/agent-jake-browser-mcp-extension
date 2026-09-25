import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockChrome = {
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  tabs: {
    get: vi.fn(),
    update: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    remove: vi.fn(),
    onUpdated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onCreated: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  debugger: {
    getTargets: vi.fn(),
    attach: vi.fn(),
    sendCommand: vi.fn(),
    detach: vi.fn(),
    onEvent: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onDetach: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  scripting: {
    executeScript: vi.fn().mockResolvedValue([]),
  },
};

(globalThis as { chrome?: unknown }).chrome = mockChrome as unknown;

vi.mock('@/utils/logger', () => ({
  log: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/background/activity-log', () => ({
  logTab: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn().mockResolvedValue(undefined),
}));

import { TabManager } from '@/background/tab-manager';
import { pageEvents } from '@/background/page-events';

describe('TabManager CDP readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cancels a file chooser event wait without a late timeout rejection', async () => {
    const manager = new TabManager();
    const controller = new AbortController();
    const wait = manager.waitForDebuggerEvent('Page.fileChooserOpened', 10000, controller.signal);
    controller.abort();
    await expect(wait).rejects.toThrow('Stopped waiting for Page.fileChooserOpened');
  });

  it('rejects a second file chooser until the first releases its lock', () => {
    const manager = new TabManager();
    manager.beginFileChooser();
    expect(() => manager.beginFileChooser()).toThrow('already in progress');
    manager.endFileChooser();
    expect(() => manager.beginFileChooser()).not.toThrow();
    manager.endFileChooser();
  });

  it('clears captured network and console data on disconnect and debugger detach', async () => {
    const manager = new TabManager();
    pageEvents.handle('Network.requestWillBeSent', { requestId: 'secret', request: { url: 'https://x.test', postData: 'secret' } });
    pageEvents.handle('Runtime.consoleAPICalled', { args: [{ value: 'secret' }] });
    await manager.disconnectTab();
    expect(pageEvents.networkRequests()).toHaveLength(0);
    expect(pageEvents.consoleMessages()).toHaveLength(0);

    pageEvents.handle('Network.requestWillBeSent', { requestId: 'secret2', request: { url: 'https://x.test' } });
    manager.markDebuggerDetached();
    expect(pageEvents.networkRequests()).toHaveLength(0);
  });

  it('reports not ready when no tab is connected', async () => {
    const manager = new TabManager();
    const status = await manager.getCdpStatus();

    expect(status.connectedTabId).toBeNull();
    expect(status.debuggerAttached).toBe(false);
    expect(status.canExecuteCdp).toBe(false);
    expect(status.lastCdpError).toContain('No tab connected');
  });

  it('throws CDP_DEBUGGER_BUSY when another debugger owns the tab', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets.mockResolvedValue([]);
    mockChrome.debugger.attach.mockRejectedValue(
      new Error('Another debugger is already attached to the tab')
    );
    // The client holding it is not us: Chrome refuses our commands.
    mockChrome.debugger.sendCommand.mockRejectedValue(
      new Error('Debugger is not attached to the tab with id: 101')
    );

    await expect(manager.connectTab(101, 'https://example.com')).rejects.toThrow('CDP_DEBUGGER_BUSY');
  });

  it('attaches even when getTargets says the tab is already attached (another CDP client)', async () => {
    // Regression: with a Playwright client connected over CDP, `getTargets()[].attached` is
    // true while we are not attached at all. Trusting that flag skipped our own attach and
    // every command afterwards died with "Debugger is not attached".
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets.mockResolvedValue([{ tabId: 101, attached: true }]);
    let attached = false;
    mockChrome.debugger.attach.mockImplementation(async () => {
      attached = true;
    });
    mockChrome.debugger.sendCommand.mockImplementation(async () => {
      if (!attached) throw new Error('Debugger is not attached to the tab with id: 101');
      return {};
    });

    await manager.connectTab(101, 'https://example.com');

    expect(mockChrome.debugger.attach).toHaveBeenCalledWith({ tabId: 101 }, expect.any(String));
  });

  it('reattaches and retries once when command fails with detached debugger', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });

    // connectTab attach check -> detached
    // sendDebuggerCommand initial check -> attached
    // retry attach check -> detached
    mockChrome.debugger.getTargets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);

    let firstEvaluate = true;
    mockChrome.debugger.sendCommand.mockImplementation(async (_debuggee, method) => {
      if (method === 'Runtime.enable' || method === 'Page.enable' || method === 'DOM.enable') {
        return {};
      }

      if (method === 'Runtime.evaluate') {
        if (firstEvaluate) {
          firstEvaluate = false;
          throw new Error('Debugger is not attached to the tab with id: 101.');
        }

        return { result: { type: 'number', value: 2 } };
      }

      return {};
    });

    await manager.connectTab(101, 'https://example.com');
    const result = await manager.sendDebuggerCommand('Runtime.evaluate', { expression: '1+1' });

    expect(result).toEqual({ result: { type: 'number', value: 2 } });
    expect(mockChrome.debugger.attach).toHaveBeenCalledTimes(2);
    expect(mockChrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 101 },
      'Runtime.evaluate',
      { expression: '1+1' }
    );
  });

  it('enables close confirmation on connect and disables it on disconnect', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockResolvedValue({});

    await manager.connectTab(101, 'https://example.com');

    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 101 },
        world: 'MAIN',
        func: expect.any(Function),
      })
    );

    await manager.disconnectTab();

    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 101 },
        world: 'MAIN',
        func: expect.any(Function),
      })
    );
  });

  it('reapplies live connection UI for connected tab after reload', async () => {
    const manager = new TabManager();
    mockChrome.tabs.get.mockResolvedValue({ id: 101, title: 'Demo', url: 'https://example.com' });
    mockChrome.debugger.getTargets
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tabId: 101, attached: true }]);
    mockChrome.debugger.attach.mockResolvedValue(undefined);
    mockChrome.debugger.sendCommand.mockResolvedValue({});

    await manager.connectTab(101, 'https://example.com');
    mockChrome.scripting.executeScript.mockClear();

    await manager.reapplyLiveConnectionUi();

    expect(mockChrome.scripting.executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: 101 },
        world: 'MAIN',
        func: expect.any(Function),
      })
    );
  });
});
