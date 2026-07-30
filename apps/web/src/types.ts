export type Scalar = string | number | boolean | null | undefined;
export type PageName = "operations" | "inventory" | "settlement" | "collection" | "account";
export type InventoryView = "overview" | "replenish" | "overstock" | "detail";
/** Dynamic properties supplied by dashboard data files and API responses. */
// The view layer narrows fields before business calculations; this index keeps
// the boundary compatible with extensible collector payloads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JsonObject = Record<string, any>;
export type JsonValue = Scalar | JsonObject | JsonValue[];

export type User = {
  username: string;
  role: "admin" | "viewer";
  created_at?: string;
  password_changed_at?: string | null;
};

export type ApiErrorPayload = {
  error?: string;
  error_code?: string;
  request_id?: string;
};

export type CollectionStatus = JsonObject & {
  state?: string;
  message?: string;
  terminal_output?: string;
  collector_online?: boolean;
  job_running?: boolean;
  request_pending?: boolean;
  modules?: Record<string, JsonObject>;
};

export type InventoryRecord = JsonObject & {
  spec_no?: string;
  health_key?: string;
  available_num?: Scalar;
  stock_num?: Scalar;
  sales_7d?: Scalar;
  inbound_30d?: Scalar;
  coverage_days?: Scalar;
  cost_covered?: boolean;
  stock_cost_amount?: Scalar;
  available_cost_amount?: Scalar;
};
