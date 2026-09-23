import { describe, it, expect } from 'vitest';
import { PageEventLog, severityOf } from '@/background/page-events';

const nav = (loaderId: string) => ['Page.frameNavigated', { frame: { id: 'top', loaderId } }] as const;
const req = (requestId: string, url: string, type = 'XHR', extra: Record<string, unknown> = {}) =>
  ['Network.requestWillBeSent', { requestId, type, request: { method: 'GET', url, headers: { a: '1' } }, ...extra }] as const;

describe('PageEventLog console', () => {
  it('turns CDP console args into text and filters by severity', () => {
    const l = new PageEventLog();
    l.handle('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hi' }, { type: 'number', value: 2 }] });
    l.handle('Runtime.consoleAPICalled', { type: 'warning', args: [{ type: 'string', value: 'careful' }] });
    l.handle('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'Error: boom' } } });
    l.handle('Log.entryAdded', { entry: { level: 'error', source: 'network', text: '404' } });

    expect(l.consoleMessages().map((m) => m.text)).toEqual(['hi 2', 'careful', 'Uncaught Error: boom', '[network] 404']);
    expect(l.consoleMessages({ level: 'warning' }).map((m) => m.type)).toEqual(['warning', 'error', 'error']);
    expect(l.consoleMessages({ types: ['warn'] }).map((m) => m.text)).toEqual(['careful']);
  });

  it('keeps only the last navigation unless all', () => {
    const l = new PageEventLog();
    l.handle('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'before' }] });
    l.handle(...nav('L1'));
    l.handle('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'after' }] });
    expect(l.consoleMessages().map((m) => m.text)).toEqual(['after']);
    expect(l.consoleMessages({ all: true })).toHaveLength(2);
  });

  it('maps severities', () => {
    expect(severityOf('assert')).toBe(3);
    expect(severityOf('warn')).toBe(2);
    expect(severityOf('info')).toBe(1);
    expect(severityOf('trace')).toBe(0);
  });
});

describe('PageEventLog network', () => {
  it('tracks a request through response and failure, hiding static by default', () => {
    const l = new PageEventLog();
    l.handle(...req('1', 'https://x.test/api'));
    l.handle('Network.requestWillBeSentExtraInfo', { requestId: '1', headers: { cookie: 'c' } });
    l.handle('Network.responseReceived', { requestId: '1', response: { status: 200, mimeType: 'application/json', headers: { h: 'v' } } });
    l.handle(...req('2', 'https://x.test/logo.png', 'Image'));
    l.handle(...req('3', 'https://x.test/fail'));
    l.handle('Network.loadingFailed', { requestId: '3', errorText: 'net::ERR_FAILED' });

    expect(l.networkRequests().map((e) => e.index)).toEqual([1, 3]);
    expect(l.networkRequests({ includeStatic: true })).toHaveLength(3);
    expect(l.networkRequests({ filter: 'API' }).map((e) => e.url)).toEqual(['https://x.test/api']);
    const one = l.networkRequest(1)!;
    expect(one.status).toBe(200);
    expect(one.requestHeaders).toEqual({ a: '1', cookie: 'c' });
    expect(l.networkRequest(3)!.failure).toBe('net::ERR_FAILED');
  });

  it('splits redirects into hops and moves the document request to its navigation', () => {
    const l = new PageEventLog();
    l.handle(...req('old', 'https://x.test/old'));
    l.handle(...req('L1', 'https://x.test/a', 'Document'));
    l.handle(...req('L1', 'https://x.test/b', 'Document', { redirectResponse: { status: 302, headers: {} } }));
    l.handle(...nav('L1'));

    expect(l.networkRequests().map((e) => e.url)).toEqual(['https://x.test/b']);
    expect(l.networkRequests({ all: true }).map((e) => e.status)).toEqual([undefined, 302, undefined]);
  });

  it('is a ring buffer', () => {
    const l = new PageEventLog(2);
    for (const id of ['1', '2', '3']) l.handle(...req(id, `https://x.test/${id}`));
    expect(l.networkRequests().map((e) => e.index)).toEqual([2, 3]);
    expect(l.networkRequest(1)).toBeUndefined();
  });
});
