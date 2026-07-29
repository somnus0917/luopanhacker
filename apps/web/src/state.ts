export type AnyRecord = Record<string, any>;

export type OperationRecord = AnyRecord & {
  date: string;
  shop_name: string;
  source?: string;
  source_label?: string;
  metrics?: AnyRecord;
  content?: AnyRecord;
};

export type AppState = {
  currentUser: { username: string; role: string } | null;
  users: AnyRecord[];
  accountMessage: string;
  records: OperationRecord[];
  operationDates: Set<string>;
  operationPlatforms: Set<string>;
  operationShops: Set<string>;
  operationSources: Set<string>;
  operationFilterOpen: Set<string>;
  operationCalendarOpen: boolean;
  operationCalendarCursor: string;
  operationCalendarRangeStart: string;
  tablePlatform: string;
  tableShop: string;
  operationSection: "overview" | "sales" | "traffic" | "ads";
  status: AnyRecord | null;
  collectionModules: Set<string>;
  collectionBackfillDate: string;
  collectionBackfillShops: Set<string>;
  collectionMessage: string;
  page: string;
  inventory: AnyRecord | null;
  inventoryView: string;
  inventoryWarehouse: string;
  inventoryBrand: string;
  inventorySortKey: string;
  inventorySortDir: "asc" | "desc";
  settlement: AnyRecord | null;
  settlementShop: string;
  settlementUploadMessage: string;
  orderImports: { batches: AnyRecord[]; summary: AnyRecord };
  orderPreview: AnyRecord | null;
  orderImportMessage: string;
  channel: AnyRecord | null;
};

export const COLLECTION_SHOPS = ["华硕凡飞笔记本电脑专卖店", "惠普办公设备旗舰店", "HYPERX极度未知凡飞专卖店", "acer宏碁凡飞专卖店"];

export const localDateValue = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export const currentLocalMonthStart = () => {
  const date = new Date();
  date.setDate(1);
  return localDateValue(date);
};

export const previousLocalDate = () => {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localDateValue(date);
};

export const latestBackfillDate = () => previousLocalDate() >= currentLocalMonthStart() ? previousLocalDate() : "";

export const backfillDateAllowed = (value: string) => Boolean(value && value >= currentLocalMonthStart() && value <= previousLocalDate());

export const state: AppState = { currentUser: null, users: [], accountMessage: "", records: [], operationDates: new Set<string>(), operationPlatforms: new Set<string>(), operationShops: new Set<string>(), operationSources: new Set<string>(), operationFilterOpen: new Set<string>(), operationCalendarOpen: false, operationCalendarCursor: "", operationCalendarRangeStart: "", tablePlatform: "", tableShop: "", operationSection: "overview", status: null, collectionModules: new Set(["operations", "channel"]), collectionBackfillDate: latestBackfillDate(), collectionBackfillShops: new Set(COLLECTION_SHOPS), collectionMessage: "", page: "operations", inventory: null, inventoryView: "overview", inventoryWarehouse: "", inventoryBrand: "", inventorySortKey: "", inventorySortDir: "desc", settlement: null, settlementShop: "", settlementUploadMessage: "", orderImports: { batches: [], summary: {} }, orderPreview: null, orderImportMessage: "", channel: null };

export const isAdmin = () => state.currentUser?.role === "admin";
