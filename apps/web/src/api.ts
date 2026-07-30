export type ApiError = {
  code: string;
  message: string;
};

type ApiEnvelope = {
  data: unknown;
  error: ApiError | null;
  meta: { request_id: string; source?: string; fallback?: boolean; updated_at?: string | Record<string, string> };
};

function isEnvelope(payload: unknown): payload is ApiEnvelope {
  return Boolean(payload && typeof payload === "object" && "data" in payload && "error" in payload && "meta" in payload);
}

// Keeps page code focused on domain data while every API response is an envelope on the wire.
export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await window.fetch(input, init);
  const decode = response.json.bind(response);
  response.json = async () => {
    const payload: unknown = await decode();
    if (!isEnvelope(payload)) return payload;
    if (payload.meta.fallback) {
      window.dispatchEvent(new CustomEvent("luopan-api-fallback", { detail: payload.meta }));
    }
    if (payload.error) {
      return { error: payload.error.message, error_code: payload.error.code, request_id: payload.meta.request_id };
    }
    return payload.data;
  };
  return response;
}
