import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pageEvents } from '@/background/page-events';
import { createDevtoolsHandlers } from '@/background/tools/handlers/devtools';
import type { HandlerContext } from '@/background/tools/handlers/types';

const sendDebuggerCommand = vi.fn();
const handlers = createDevtoolsHandlers({ tabManager: { sendDebuggerCommand } } as unknown as HandlerContext);

beforeEach(() => {
  pageEvents.reset();
  sendDebuggerCommand.mockReset();
});

describe('browser_network_request redirect bodies', () => {
  it('does not return the final hop body for an earlier redirect hop', async () => {
    pageEvents.handle('Network.requestWillBeSent', { requestId: 'same', request: { url: 'https://example.test/start', hasPostData: true } });
    pageEvents.handle('Network.requestWillBeSent', {
      requestId: 'same',
      redirectResponse: { status: 302, headers: { location: '/final' } },
      request: { url: 'https://example.test/final' },
    });
    pageEvents.handle('Network.responseReceived', { requestId: 'same', response: { status: 200, mimeType: 'text/plain' } });
    sendDebuggerCommand.mockImplementation(async (method: string) =>
      method === 'Network.getResponseBody' ? { body: 'final-body', base64Encoded: false } : { postData: 'final-post' });

    const defaultResult = await handlers.browser_network_request({ index: 1 }) as Record<string, unknown>;
    expect(defaultResult).not.toHaveProperty('requestBody');
    expect(defaultResult).not.toHaveProperty('responseBody');

    const redirect = await handlers.browser_network_request({ index: 1, part: 'response-body' }) as Record<string, unknown>;
    expect(redirect.responseBody).toBe('(unavailable: redirect response)');
    const redirectRequest = await handlers.browser_network_request({ index: 1, part: 'request-body' }) as Record<string, unknown>;
    expect(redirectRequest.requestBody).toBeNull();
    expect(sendDebuggerCommand).not.toHaveBeenCalled();

    const final = await handlers.browser_network_request({ index: 2, part: 'response-body' }) as Record<string, unknown>;
    expect(final.responseBody).toBe('final-body');
    expect(sendDebuggerCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'same' });
  });

  it('redacts sensitive headers regardless of casing without changing captured data', async () => {
    pageEvents.handle('Network.requestWillBeSent', { requestId: 'auth', request: {
      url: 'https://user:password@example.test/private/path?token=secret#fragment', headers: {
        cOoKiE: 'session=secret', AUTHORIZATION: 'Bearer secret', 'Proxy-Authorization': 'Basic secret',
        'X-Session-ID': 'secret', 'x-AuThToKeN': 'secret', Accept: 'application/json',
      },
    } });
    pageEvents.handle('Network.responseReceived', { requestId: 'auth', response: { status: 200, headers: {
      'sEt-CoOkIe': 'session=secret; HttpOnly', 'Content-Type': 'application/json',
    } } });

    const index = pageEvents.networkRequests()[0].index;
    const result = await handlers.browser_network_request({ index }) as Record<string, unknown>;
    expect(result.requestHeaders).toEqual({
      cOoKiE: '[REDACTED]', AUTHORIZATION: '[REDACTED]', 'Proxy-Authorization': '[REDACTED]',
      'X-Session-ID': '[REDACTED]', 'x-AuThToKeN': '[REDACTED]', Accept: 'application/json',
    });
    expect(result.responseHeaders).toEqual({ 'sEt-CoOkIe': '[REDACTED]', 'Content-Type': 'application/json' });
    expect(result.url).toBe('https://example.test/private/path');
    const list = await handlers.browser_network_requests({}) as { requests: Array<{ url: string }> };
    expect(list.requests[0].url).toBe('https://example.test/private/path');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(list)).not.toContain('secret');
    expect(pageEvents.networkRequest(index)?.requestHeaders.cOoKiE).toBe('session=secret');
    expect(result).not.toHaveProperty('requestBody');
    expect(result).not.toHaveProperty('responseBody');
    expect(sendDebuggerCommand).not.toHaveBeenCalled();
  });
});
