/**
 * Cloud-model access failures that the conversation surface can act on.
 *
 * A Flowix Cloud model can fail for two reasons the product can resolve:
 * the account is signed out, or the credit balance is exhausted. Both arrive
 * as ordinary run failures, so the surface needs a stable way to tell them
 * apart from every other provider error (a BYOK key running out of balance,
 * a rate limit, a bad request, …). Only failures from a Cloud provider are
 * mapped; everything else returns null and keeps the plain error row.
 */
export type CloudAccessKind = "signed_out" | "no_credits";

/** Preview provider used by the guest catalog; it has no local credentials. */
export const FLOWIX_CLOUD_PREVIEW_PROVIDER_ID = "__flowix-cloud-preview";

export function isCloudModelProvider(providerId?: string | null): boolean {
  const value = providerId?.trim().toLowerCase();
  if (!value) return false;
  return value === FLOWIX_CLOUD_PREVIEW_PROVIDER_ID
    || value.startsWith("flowix-cloud");
}

const MISSING_CREDITS_PATTERN =
  /insufficient[_ ]?credits?|insufficient[_ ]?balance|balance insufficient|not enough credit|quota[_ ]?exceeded|exceeded your current quota|用量上限|点数不足|余额不足|积分不足|额度不足|配额耗尽/;

const MISSING_AUTH_PATTERN =
  /\bunauthori[sz]ed\b|invalid[_ ]api[_ ]key|authentication|not signed in|signed out|请先登录|未登录/;

export interface CloudAccessFailure {
  /** Provider that produced the failure; custom providers are ignored. */
  providerId?: string | null;
  /** Whether a Cloud account session exists right now. */
  authenticated: boolean;
  /** Category classified by the desktop agent runner. */
  category?: string | null;
  /** Raw provider message. */
  message?: string | null;
}

export function resolveCloudAccessKind(
  failure: CloudAccessFailure,
): CloudAccessKind | null {
  if (!isCloudModelProvider(failure.providerId)) return null;
  if (!failure.authenticated) return "signed_out";
  const text = failure.message?.trim().toLowerCase() ?? "";
  if (failure.category === "quota_exhausted") return "no_credits";
  if (MISSING_CREDITS_PATTERN.test(text)) return "no_credits";
  if (failure.category === "authentication" || MISSING_AUTH_PATTERN.test(text)) {
    return "signed_out";
  }
  return null;
}

/**
 * A signed-out account cannot run any Cloud model, even before a request is
 * made: the provider is not installed in Pi until a credential exists.
 */
export function signedOutAccessFor(
  providerId: string | null | undefined,
  authenticated: boolean,
): CloudAccessKind | null {
  if (authenticated) return null;
  return isCloudModelProvider(providerId) ? "signed_out" : null;
}

/** The subset of a rendered conversation row this derivation needs. */
export interface CloudAccessMessageLike {
  id: string;
  role: string;
  content?: string | null;
  errorDetails?: {
    category?: string | null;
    upstreamMessage?: string | null;
  } | null;
}

export interface CloudAccessDerivation {
  /** Row that produced the notice; unchanged ids must not reopen a dismissed card. */
  messageId: string;
  kind: CloudAccessKind;
}

/**
 * The newest failed assistant row owns the notice. Both surfaces that render a
 * conversation (the note-embedded Thread Card and the standalone detail page)
 * derive it the same way so they cannot disagree.
 */
export function deriveCloudAccess(
  messages: readonly CloudAccessMessageLike[],
  context: { providerId?: string | null; authenticated: boolean },
): CloudAccessDerivation | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.errorDetails) continue;
    const kind = resolveCloudAccessKind({
      providerId: context.providerId,
      authenticated: context.authenticated,
      category: message.errorDetails.category,
      message: message.errorDetails.upstreamMessage ?? message.content,
    });
    return kind ? { messageId: message.id, kind } : null;
  }
  return null;
}
