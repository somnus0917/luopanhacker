export type Scalar = string | number | boolean | null | undefined;
export type PageName = "operations" | "douyin" | "inventory" | "settlement" | "collection" | "account";
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

export type OperationRecord = JsonObject & {
  date: string;
  shop_name: string;
  source?: string;
  source_key?: string;
  source_label?: string;
  metrics?: JsonObject;
  content?: JsonObject;
};

export type ChannelDashboard = JsonObject & {
  records: JsonObject[];
};

export type DouyinDashboard = JsonObject & {
  records: JsonObject[];
};

export type CompassResponse = {
  records: OperationRecord[];
  channel: ChannelDashboard | null;
};

export type OrderPreviewFile = JsonObject & {
  source_label: string;
  file_name: string;
  known_file: boolean;
  added_orders: number;
  duplicate_orders: number;
};

export type OrderPreview = JsonObject & {
  preview_token: string;
  summary: JsonObject & {
    added_orders: number;
    duplicate_orders: number;
    pay_amt: number;
    pay_item_cnt: number;
    date_range: [string, string] | null;
  };
  files: OrderPreviewFile[];
};

export type OrderImports = {
  batches: JsonObject[];
  summary: JsonObject;
};

export type OrderImportCommit = {
  batch?: JsonObject & { added_orders?: number };
};

export type OrderImportDelete = {
  deleted?: JsonObject & { added_orders?: number };
};

export type SettlementDashboard = JsonObject & {
  summary: JsonObject;
  rows: JsonObject[];
  shops: string[];
  available_dates: string[];
  selected_shop?: string;
  selected_start_date?: string;
  selected_end_date?: string;
};

export type SettlementUpload = {
  upload?: JsonObject & {
    file?: JsonObject & {
      shop_name?: string;
      original_name?: string;
      name?: string;
      rows?: number;
    };
  };
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
