/**
 * DevTools-style handlers: console, network, raw CDP, drop and fill_form.
 *
 * The first three read what page-events.ts captured from the debugger. drop and
 * fill_form act on refs the same way interaction.ts does: the ref says which frame,
 * and the order goes to that frame's content script.
 */
import { pageEvents } from '../../page-events';
import { schemas } from '../schemas';
import type { HandlerContext, HandlerMap } from './types';

const TEXTY = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded|graphql|ld\+json|problem\+json))|\+json|\+xml/;

export function createDevtoolsHandlers(ctx: HandlerContext): HandlerMap {
  const { sendToContent, resolveRef } = ctx;

  const target = async (ref?: string, selector?: string, fallback?: string) => {
    if (ref) return resolveRef(ref);
    const css = selector || fallback;
    if (!css) throw new Error('Either ref or selector must be provided');
    return { frameId: 0, selector: css };
  };

  return {
    browser_get_console_logs: async (payload) => {
      const { types, level, all, clear } = schemas.browser_get_console_logs.parse(payload);
      const logs = pageEvents.consoleMessages({ types, level, all }).map((m) => ({
        type: m.type,
        text: m.text,
        timestamp: m.timestamp,
        ...(m.location ? { location: m.location } : {}),
      }));
      if (clear) pageEvents.clearConsole();
      return { logs };
    },

    browser_network_requests: async (payload) => {
      const { includeStatic, all, filter } = schemas.browser_network_requests.parse(payload);
      const requests = pageEvents.networkRequests({ includeStatic, all, filter }).map((e) => ({
        index: e.index,
        method: e.method,
        url: e.url,
        resourceType: e.resourceType,
        status: e.status ?? null,
        failure: e.failure ?? null,
      }));
      return { requests };
    },

    browser_network_request: async (payload) => {
      const { index, part, maxBodyChars } = schemas.browser_network_request.parse(payload);
      const e = pageEvents.networkRequest(index);
      if (!e) throw new Error(`No request [${index}] in the buffer (see browser_network_requests)`);

      const want = (p: string) => !part || part === p;
      const clip = (s: string) => (s.length > maxBodyChars ? `${s.slice(0, maxBodyChars)}\n… (${s.length - maxBodyChars} more chars)` : s);
      const out: Record<string, unknown> = {
        index: e.index,
        method: e.method,
        url: e.url,
        resourceType: e.resourceType,
        status: e.status ?? null,
        failure: e.failure ?? null,
      };

      if (want('request-headers')) out.requestHeaders = e.requestHeaders;
      if (want('request-body')) {
        let body = e.postData;
        if (body === undefined && e.hasPostData) {
          body = await ctx.tabManager
            .sendDebuggerCommand<{ postData: string }>('Network.getRequestPostData', { requestId: e.requestId })
            .then((r) => r.postData)
            .catch(() => undefined);
        }
        out.requestBody = body === undefined ? null : clip(body);
      }
      if (want('response-headers')) out.responseHeaders = e.responseHeaders ?? null;
      if (want('response-body')) {
        if (e.status === undefined) out.responseBody = null;
        else {
          try {
            const r = await ctx.tabManager.sendDebuggerCommand<{ body: string; base64Encoded: boolean }>(
              'Network.getResponseBody',
              { requestId: e.requestId },
            );
            const mime = e.mimeType ?? '';
            if (!r.base64Encoded) out.responseBody = clip(r.body);
            else if (TEXTY.test(mime)) {
              out.responseBody = clip(new TextDecoder().decode(Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0))));
            }
            else out.responseBody = `<binary ${mime || 'body'}, ${Math.round(r.body.length * 0.75)} bytes>`;
          } catch (err) {
            // Chrome drops bodies once the page navigates or the resource is evicted.
            out.responseBody = `(unavailable: ${(err as Error).message})`;
          }
        }
      }
      return out;
    },

    /** Raw CDP command on the connected tab. The engine behind browser_run_code_unsafe. */
    browser_cdp: async (payload) => {
      const { method, params } = schemas.browser_cdp.parse(payload);
      return ctx.tabManager.sendDebuggerCommand(method, params as Record<string, unknown> | undefined);
    },

    browser_drop: async (payload) => {
      const { ref, selector, files, data } = schemas.browser_drop.parse(payload);
      if (!files.length && !Object.keys(data).length) throw new Error('browser_drop needs files or data');
      const t = await target(ref, selector);
      await sendToContent('scrollIntoView', { selector: t.selector }, t.frameId);
      return sendToContent('dispatchDrop', { selector: t.selector, files, data }, t.frameId);
    },

    browser_fill_form: async (payload) => {
      const { fields } = schemas.browser_fill_form.parse(payload);
      const results: Array<{ field: string; ok: boolean; kind?: string; error?: string }> = [];
      for (const f of fields) {
        const field = f.ref ?? f.selector ?? '?';
        try {
          const t = await target(f.ref, f.selector);
          const { kind } = await sendToContent<{ kind: string }>('fillField', {
            selector: t.selector,
            value: f.value,
            type: f.type,
          }, t.frameId);
          results.push({ field, ok: true, kind });
        } catch (err) {
          results.push({ field, ok: false, error: (err as Error).message });
        }
      }
      return { results };
    },
  };
}
