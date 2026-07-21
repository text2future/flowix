// Cloudflare Turnstile 校验。
// TURNSTILE_SECRET_KEY 未配置时直接放行(本地开发);生产必须配置。
export async function verifyTurnstile(
  token: string | undefined,
  secret: string | undefined,
  remoteip?: string
): Promise<boolean> {
  if (!secret) return true; // 开发期未配置 = 不强制
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      secret,
      response: token,
      ...(remoteip ? { remoteip } : {}),
    }),
  });
  const data = (await res.json()) as { success: boolean };
  return data.success === true;
}
