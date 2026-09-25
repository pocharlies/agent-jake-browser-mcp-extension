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

    const redirect = await handlers.browser_network_request({ index: 1 }) as Record<string, unknown>;
    expect(redirect.responseBody).toBe('(unavailable: redirect response)');
    expect(redirect.requestBody).toBeNull();
    expect(sendDebuggerCommand).not.toHaveBeenCalled();

    const final = await handlers.browser_network_request({ index: 2, part: 'response-body' }) as Record<string, unknown>;
    expect(final.responseBody).toBe('final-body');
    expect(sendDebuggerCommand).toHaveBeenCalledWith('Network.getResponseBody', { requestId: 'same' });
  });
});
