// 统一 HTTP 错误。路由可 `throw badRequest("...")`,由 index.ts 的 onError 捕获
// 并标准化为 { error, message }。未捕获的错误统一返回 500 internal。
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string
  ) {
    super(message ?? code);
    this.name = "HttpError";
  }
}

export const badRequest = (msg?: string) => new HttpError(400, "bad_request", msg);
export const unauthorized = (msg?: string) => new HttpError(401, "unauthorized", msg);
export const forbidden = (msg?: string) => new HttpError(403, "forbidden", msg);
export const notFound = (msg?: string) => new HttpError(404, "not_found", msg);
export const conflict = (msg?: string) => new HttpError(409, "conflict", msg);
export const payloadTooLarge = (msg?: string) => new HttpError(413, "payload_too_large", msg);
export const tooManyRequests = (msg?: string) => new HttpError(429, "rate_limited", msg);
