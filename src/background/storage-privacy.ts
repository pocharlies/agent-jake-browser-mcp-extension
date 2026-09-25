import { activityLog } from './activity-log';

/** Restrict content-script access and remove secrets from legacy activity history before connecting. */
export async function preparePrivateStorage(): Promise<void> {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await activityLog.getAll();
}
