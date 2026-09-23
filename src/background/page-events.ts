/**
 * Console and network capture for the connected tab.
 *
 * The debugger is already attached for input, so the CDP events are there for free:
 * Runtime.consoleAPICalled / exceptionThrown and Log.entryAdded for the console,
 * Network.* for requests. Everything goes into ring buffers kept in the service worker;
 * nothing is stored on disk. Capture starts when the tab is connected — there is no
 * history from before that.
 *
 * "Since the last navigation" is counted on Page.frameNavigated of the top frame. The
 * document request of that navigation is sent BEFORE the event arrives, so it is moved
 * to the new navigation afterwards (its requestId is the frame's loaderId).
 */

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug';

export interface ConsoleEntry {
  nav: number;
  type: string;
  text: string;
  location?: string;
  timestamp: number;
}

export interface NetworkEntry {
  index: number;
  nav: number;
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  postData?: string;
  hasPostData: boolean;
  status?: number;
  statusText?: string;
  mimeType?: string;
  responseHeaders?: Record<string, string>;
  failure?: string;
  finished: boolean;
  timestamp: number;
}

const STATIC_TYPES = new Set(['Image', 'Font', 'Stylesheet', 'Media', 'Script', 'Manifest', 'TextTrack']);

const SEVERITY: Record<ConsoleLevel, number> = { error: 3, warning: 2, info: 1, debug: 0 };

/** CDP console types (log, warning, error, debug, assert, trace...) to a severity. */
export function severityOf(type: string): number {
  if (type === 'error' || type === 'assert') return 3;
  if (type === 'warning' || type === 'warn') return 2;
  if (type === 'debug' || type === 'verbose' || type === 'trace') return 0;
  return 1;
}

interface RemoteObject {
  type?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
}

function remoteToText(arg: RemoteObject): string {
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? String(arg.type ?? '');
}

export class PageEventLog {
  private nav = 0;
  private seq = 0;
  private console: ConsoleEntry[] = [];
  private requests: NetworkEntry[] = [];
  private byRequestId = new Map<string, NetworkEntry>();

  constructor(private readonly max = 1000) {}

  reset(): void {
    this.nav = 0;
    this.console = [];
    this.requests = [];
    this.byRequestId.clear();
  }

  clearConsole(): void {
    this.console = [];
  }

  private push<T>(list: T[], item: T, onDrop?: (dropped: T) => void): void {
    list.push(item);
    if (list.length > this.max) {
      const dropped = list.shift()!;
      onDrop?.(dropped);
    }
  }

  private addConsole(type: string, text: string, location?: string): void {
    this.push(this.console, { nav: this.nav, type, text, location, timestamp: Date.now() });
  }

  handle(method: string, params: Record<string, any> = {}): void {
    switch (method) {
      case 'Page.frameNavigated': {
        const frame = params.frame ?? {};
        if (frame.parentId) return;
        this.nav++;
        const doc = frame.loaderId ? this.byRequestId.get(frame.loaderId) : undefined;
        if (doc) doc.nav = this.nav;
        return;
      }
      case 'Runtime.consoleAPICalled': {
        const text = (params.args ?? []).map(remoteToText).join(' ');
        const top = params.stackTrace?.callFrames?.[0];
        const location = top?.url ? `${String(top.url).slice(0, 150)}:${top.lineNumber}` : undefined;
        this.addConsole(String(params.type ?? 'log'), text, location);
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails ?? {};
        const text = d.exception?.description ?? d.text ?? 'Uncaught exception';
        const location = d.url ? `${String(d.url).slice(0, 150)}:${d.lineNumber}` : undefined;
        this.addConsole('error', `Uncaught ${text}`, location);
        return;
      }
      case 'Log.entryAdded': {
        const e = params.entry ?? {};
        const type = e.level === 'verbose' ? 'debug' : String(e.level ?? 'info');
        this.addConsole(type, `[${e.source ?? 'browser'}] ${e.text ?? ''}`, e.url ? String(e.url).slice(0, 150) : undefined);
        return;
      }
      case 'Network.requestWillBeSent': {
        const prev = this.byRequestId.get(params.requestId);
        if (prev && params.redirectResponse) {
          // Redirects reuse the requestId: close the hop and start a new entry.
          prev.status = params.redirectResponse.status;
          prev.statusText = params.redirectResponse.statusText;
          prev.responseHeaders = params.redirectResponse.headers;
          prev.finished = true;
        }
        const req = params.request ?? {};
        const entry: NetworkEntry = {
          index: ++this.seq,
          nav: this.nav,
          requestId: params.requestId,
          method: req.method ?? 'GET',
          url: req.url ?? '',
          resourceType: params.type ?? 'Other',
          requestHeaders: { ...(req.headers ?? {}) },
          postData: req.postData,
          hasPostData: !!req.hasPostData || req.postData !== undefined,
          finished: false,
          timestamp: Date.now(),
        };
        this.byRequestId.set(params.requestId, entry);
        this.push(this.requests, entry, (d) => {
          if (this.byRequestId.get(d.requestId) === d) this.byRequestId.delete(d.requestId);
        });
        return;
      }
      case 'Network.requestWillBeSentExtraInfo': {
        // Full headers as sent on the wire (cookies included).
        const e = this.byRequestId.get(params.requestId);
        if (e && params.headers) e.requestHeaders = { ...e.requestHeaders, ...params.headers };
        return;
      }
      case 'Network.responseReceived': {
        const e = this.byRequestId.get(params.requestId);
        if (!e) return;
        const r = params.response ?? {};
        e.status = r.status;
        e.statusText = r.statusText;
        e.mimeType = r.mimeType;
        e.responseHeaders = { ...(e.responseHeaders ?? {}), ...(r.headers ?? {}) };
        return;
      }
      case 'Network.responseReceivedExtraInfo': {
        const e = this.byRequestId.get(params.requestId);
        if (e && params.headers) e.responseHeaders = { ...(e.responseHeaders ?? {}), ...params.headers };
        return;
      }
      case 'Network.loadingFinished': {
        const e = this.byRequestId.get(params.requestId);
        if (e) e.finished = true;
        return;
      }
      case 'Network.loadingFailed': {
        const e = this.byRequestId.get(params.requestId);
        if (e) {
          e.failure = params.canceled ? 'canceled' : (params.errorText ?? 'failed');
          e.finished = true;
        }
        return;
      }
      default:
        return;
    }
  }

  consoleMessages(opts: { level?: ConsoleLevel; all?: boolean; types?: string[] } = {}): ConsoleEntry[] {
    const min = SEVERITY[opts.level ?? 'debug'];
    const types = opts.types?.length ? new Set(opts.types.map((t) => (t === 'warn' ? 'warning' : t))) : null;
    return this.console.filter((m) =>
      (opts.all || m.nav === this.nav) &&
      severityOf(m.type) >= min &&
      (!types || types.has(m.type)),
    );
  }

  networkRequests(opts: { includeStatic?: boolean; all?: boolean; filter?: string } = {}): NetworkEntry[] {
    const re = opts.filter ? new RegExp(opts.filter, 'i') : null;
    return this.requests.filter((e) =>
      (opts.all || e.nav === this.nav) &&
      (opts.includeStatic || !STATIC_TYPES.has(e.resourceType)) &&
      (!re || re.test(e.url)),
    );
  }

  networkRequest(index: number): NetworkEntry | undefined {
    return this.requests.find((e) => e.index === index);
  }
}

/** One log per service worker: the extension automates one tab at a time. */
export const pageEvents = new PageEventLog();
