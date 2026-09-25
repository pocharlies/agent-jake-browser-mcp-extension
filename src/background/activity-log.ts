/**
 * Activity log singleton for tracking extension events.
 * Persists to chrome.storage.local with FIFO eviction.
 */

import type { ActivityEntry, ActivityEntryInput, ActivityLogResponse } from '@/types/activity';
import { schemas } from './tools/schemas';

const STORAGE_KEY = 'agent_jake_activity_log';
const MAX_ENTRIES = 100;
const META_ACTIONS = new Set([
  'unknown_tool', 'tab_connect', 'tab_disconnect', 'ws_connect', 'ws_close',
  'ws_error', 'ws_disconnect', 'ws_reconnect_failed', 'ws_reconnecting',
]);
const SAFE_DETAIL_KEYS = new Set(['tabId', 'code', 'attempts', 'maxAttempts', 'attempt', 'delayMs', 'pendingRequestsCancelled']);

// Activity history is durable and exposed to extension contexts. Keep only
// operational metadata; tool payloads, page content, URLs and errors may be secret.
function safeEntry(input: ActivityEntryInput, id: string, timestamp: number): ActivityEntry {
  const action = Object.hasOwn(schemas, input.action) || META_ACTIONS.has(input.action)
    ? input.action : 'unknown';
  const details = Object.fromEntries(Object.entries(input.details ?? {}).filter(
    ([key, value]) => SAFE_DETAIL_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value),
  ));
  return {
    id,
    timestamp,
    type: input.type,
    action,
    description: action.replace(/_/g, ' '),
    success: input.success,
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    ...(Object.keys(details).length ? { details } : {}),
  };
}

class ActivityLog {
  private static instance: ActivityLog;
  private cache: ActivityEntry[] | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): ActivityLog {
    if (!ActivityLog.instance) {
      ActivityLog.instance = new ActivityLog();
    }
    return ActivityLog.instance;
  }

  /**
   * Add a new activity entry.
   * Auto-generates id and timestamp.
   */
  async addEntry(input: ActivityEntryInput): Promise<ActivityEntry> {
    const entry = safeEntry(input, crypto.randomUUID(), Date.now());

    const entries = await this.loadEntries();
    entries.unshift(entry); // Add to beginning (newest first)

    // Enforce max entries (FIFO eviction)
    if (entries.length > MAX_ENTRIES) {
      entries.length = MAX_ENTRIES;
    }

    await this.saveEntries(entries);
    return entry;
  }

  /**
   * Get the latest N entries.
   */
  async getLatest(count: number = 5): Promise<ActivityLogResponse> {
    const entries = await this.loadEntries();
    return {
      activities: entries.slice(0, count),
      total: entries.length,
    };
  }

  /**
   * Get all entries.
   */
  async getAll(): Promise<ActivityLogResponse> {
    const entries = await this.loadEntries();
    return {
      activities: entries,
      total: entries.length,
    };
  }

  /**
   * Clear all entries.
   */
  async clear(): Promise<void> {
    this.cache = [];
    await chrome.storage.local.remove(STORAGE_KEY);
  }

  /**
   * Load entries from storage.
   */
  private async loadEntries(): Promise<ActivityEntry[]> {
    if (this.cache !== null) {
      return this.cache;
    }

    let stored: unknown;
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      stored = result[STORAGE_KEY];
    } catch (error) {
      console.error('[ActivityLog] Failed to load entries:', error);
      this.cache = [];
      return this.cache;
    }

    const oldEntries: ActivityEntry[] = Array.isArray(stored) ? stored : [];
    const sanitized = oldEntries.map((entry) => safeEntry(entry, entry.id, entry.timestamp));
    if (oldEntries.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(sanitized[index]))) {
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: sanitized });
      } catch {
        // A failed rewrite must not leave the old secret-bearing history in storage.
        await chrome.storage.local.remove(STORAGE_KEY);
        this.cache = [];
        return this.cache;
      }
    }
    this.cache = sanitized;
    return sanitized;
  }

  /**
   * Save entries to storage.
   */
  private async saveEntries(entries: ActivityEntry[]): Promise<void> {
    this.cache = entries;
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: entries });
    } catch (error) {
      console.error('[ActivityLog] Failed to save entries:', error);
    }
  }
}

// Export singleton instance
export const activityLog = ActivityLog.getInstance();

// Helper functions for common logging patterns
export function logConnection(action: string, description: string, success: boolean, details?: Record<string, unknown>): Promise<ActivityEntry> {
  return activityLog.addEntry({
    type: 'connection',
    action,
    description,
    success,
    details,
  });
}

export function logTab(action: string, description: string, success: boolean, details?: Record<string, unknown>): Promise<ActivityEntry> {
  return activityLog.addEntry({
    type: 'tab',
    action,
    description,
    success,
    details,
  });
}

export function logTool(action: string, description: string, success: boolean, durationMs?: number, details?: Record<string, unknown>): Promise<ActivityEntry> {
  return activityLog.addEntry({
    type: 'tool',
    action,
    description,
    success,
    durationMs,
    details,
  });
}

export function logError(action: string, description: string, details?: Record<string, unknown>): Promise<ActivityEntry> {
  return activityLog.addEntry({
    type: 'error',
    action,
    description,
    success: false,
    details,
  });
}

export function logAuth(action: string, description: string, success: boolean, durationMs?: number, details?: Record<string, unknown>): Promise<ActivityEntry> {
  return activityLog.addEntry({
    type: 'auth',
    action,
    description,
    success,
    durationMs,
    details,
  });
}

/**
 * Generic log function that accepts full entry input.
 */
export function logActivity(input: Omit<ActivityEntry, 'id' | 'timestamp'>): Promise<ActivityEntry> {
  return activityLog.addEntry(input);
}
