export type ApiError = {
  code: string;
  message: string;
};

export type ApiMeta = {
  request_id: string;
  source?: string;
  fallback?: boolean;
  updated_at?: string | Record<string, string>;
};

type ApiEnvelope = {
  data: unknown;
  error: ApiError | null;
  meta: ApiMeta;
};

// Compatibility only: legacy pages will be migrated to request<T> incrementally.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LegacyResponse = { ok: boolean; status: number; json: () => Promise<any> };

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code = "REQUEST_FAILED",
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function isEnvelope(payload: unknown): payload is ApiEnvelope {
  return Boolean(payload && typeof payload === "object" && "data" in payload && "error" in payload && "meta" in payload);
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiRequestError ? error.message : fallback;
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

// All API responses are unwrapped here so pages only receive their domain payload.
export async function request<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await window.fetch(input, init);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError("服务器返回了无效响应", response.status);
  }
  if (!isEnvelope(payload)) {
    throw new ApiRequestError("服务器返回了未知响应格式", response.status);
  }
  if (payload.meta.fallback) {
    window.dispatchEvent(new CustomEvent<ApiMeta>("luopan-api-fallback", { detail: payload.meta }));
  }
  if (!response.ok || payload.error) {
    throw new ApiRequestError(
      payload.error?.message ?? "请求失败",
      response.status,
      payload.error?.code,
      payload.meta.request_id,
    );
  }
  return payload.data as T;
}

/** @deprecated Migrate callers to request<T>; retained only while legacy pages are converted. */
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<LegacyResponse> {
  try {
    const data = await request<unknown>(input, init);
    return {
      ok: true,
      status: 200,
      json: async () => data,
    };
  } catch (error) {
    if (isApiRequestError(error)) {
      return {
        ok: false,
        status: error.status,
        json: async () => ({ error: error.message, error_code: error.code, request_id: error.requestId }),
      };
    }
    throw error;
  }
}
