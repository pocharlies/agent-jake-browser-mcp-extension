import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('private storage startup', () => {
  it('restricts content scripts and sanitizes legacy history before continuing', async () => {
    vi.resetModules();
    const events: string[] = [];
    let history: unknown = [{ id: 'old', timestamp: 1, type: 'tool', action: 'browser_network_request',
      description: 'old-secret', details: { responseBody: 'old-secret' }, success: true }];
    vi.stubGlobal('chrome', { storage: { local: {
      setAccessLevel: vi.fn(async () => { events.push('access'); }),
      get: vi.fn(async () => { events.push('read'); return { agent_jake_activity_log: history }; }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        events.push('rewrite');
        history = items.agent_jake_activity_log;
      }),
      remove: vi.fn(async () => { history = undefined; }),
    } } });

    const { preparePrivateStorage } = await import('@/background/storage-privacy');
    await preparePrivateStorage();

    expect(events).toEqual(['access', 'read', 'rewrite']);
    expect(JSON.stringify(history)).not.toContain('old-secret');
  });

  it('stops startup if storage cannot be restricted', async () => {
    vi.resetModules();
    const get = vi.fn();
    vi.stubGlobal('chrome', { storage: { local: {
      setAccessLevel: vi.fn().mockRejectedValue(new Error('access denied')),
      get,
    } } });

    const { preparePrivateStorage } = await import('@/background/storage-privacy');
    await expect(preparePrivateStorage()).rejects.toThrow('access denied');
    expect(get).not.toHaveBeenCalled();
  });
});
