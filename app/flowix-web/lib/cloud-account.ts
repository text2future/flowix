/** Native account capabilities are the local source of truth for Cloud sync UI. */
export interface CloudSyncAccess {
  canRead: boolean;
  canUpload: boolean;
  canDelete: boolean;
  restriction: 'signed_out' | 'verifying' | 'verification_failed' | 'membership_required' | 'storage_limited' | null;
}

interface AccountProjection {
  authenticated: boolean;
  syncAccess?: CloudSyncAccess;
}

/** A missing snapshot grants no capability while the account service initializes. */
export function getCloudSyncAccess(state: AccountProjection | null | undefined): CloudSyncAccess {
  return state?.syncAccess ?? {
    canRead: false,
    canUpload: false,
    canDelete: false,
    restriction: state?.authenticated ? 'verifying' : 'signed_out',
  };
}

interface RestoreNoticeProjection {
  authenticated: boolean;
  restored?: boolean;
  account?: { user: { id: string } } | null;
}

/**
 * Accounts revived inside their deletion window should be acknowledged once.
 *
 * The flag lives on the session, and several unrelated surfaces react to the
 * same state event (preferences, the notebook login dialog), so the "already
 * told the user" memory has to sit outside any one component — otherwise the
 * toast appears twice, or not at all if the user signed in from a dialog.
 */
const announcedRestores = new Set<string>();

export function consumeAccountRestoreNotice(
  state: RestoreNoticeProjection | null | undefined,
): boolean {
  // Signing out forgets the notice, so a later restore of the same account is
  // announced again instead of being suppressed by a stale id.
  if (!state?.authenticated) {
    announcedRestores.clear();
    return false;
  }
  if (!state.restored) return false;
  const key = state.account?.user.id ?? '';
  if (announcedRestores.has(key)) return false;
  announcedRestores.add(key);
  return true;
}

/** Tests and sign-out paths reset the notice memory. */
export function resetAccountRestoreNotices(): void {
  announcedRestores.clear();
}
