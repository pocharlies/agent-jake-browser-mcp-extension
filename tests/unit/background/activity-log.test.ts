import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activityLog, logTool } from '@/background/activity-log';

const key = 'agent_jake_activity_log';
const stored: Record<string, unknown> = {};

beforeEach(async () => {
  vi.stubGlobal('chrome', {
    storage: { local: {
      get: vi.fn(async () => ({ [key]: stored[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => Object.assign(stored, items)),
      remove: vi.fn(async () => { delete stored[key]; }),
    } },
  });
  await activityLog.clear();
});

describe('durable activity history', () => {
  it('stores tool metadata without network, console or form secrets', async () => {
    const secret = 'secret-marker-729';
    await logTool('browser_network_request', `Response: ${secret}`, true, 7, {
      payload: { authorization: secret, fields: [{ value: secret }] },
      result: { responseBody: secret, logs: [{ text: secret }] },
    });

    const saved = JSON.stringify(stored[key]);
    expect(saved).not.toContain(secret);
    expect(saved).toContain('browser_network_request');
    expect(saved).not.toContain('payload');
    expect(saved).not.toContain('result');
  });

  it('keeps numeric diagnostics while removing URLs and remote text', async () => {
    const { logConnection } = await import('@/background/activity-log');
    await logConnection('ws_close', 'https://example.test/?token=secret-marker-729', true,
      { code: 1006, reason: 'secret-marker-729' });
    const [entry] = (await activityLog.getAll()).activities;
    expect(entry.details).toEqual({ code: 1006 });
    expect(JSON.stringify(stored[key])).not.toContain('secret-marker-729');
  });

  it('removes sensitive details from entries persisted by older versions', async () => {
    await activityLog.clear();
    const secret = 'old-secret-marker-307';
    stored[key] = [{ id: 'old', timestamp: 1, type: 'tool', action: 'browser_get_console_logs',
      description: secret, details: { logs: [{ text: secret }] }, success: true }];

    vi.resetModules();
    const { activityLog: freshLog } = await import('@/background/activity-log');
    const history = await freshLog.getAll();
    expect(history.activities[0].description).toBe('browser get console logs');
    expect(JSON.stringify(stored[key])).not.toContain(secret);
  });
});
