import type { ChannelDashboard, DouyinDashboard, InventoryView, JsonObject, OperationRecord as OperationRecordData, OrderImports, OrderPreview, PageName, SettlementDashboard, User } from "./types";

export type AnyRecord = JsonObject;

export type OperationRecord = OperationRecordData;

export type AppState = {
  currentUser: User | null;
  users: User[];
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
  operationDatePreset: "realtime" | "day" | "week" | "month" | "custom" | "all";
  tablePlatform: string;
  tableShop: string;
  operationSection: "overview" | "sales" | "traffic" | "ads";
  douyinSection: "live" | "video" | "product_card";
  douyinShop: string;
  douyinStartDate: string;
  douyinEndDate: string;
  douyinCalendarOpen: boolean;
  douyinCalendarCursor: string;
  douyinCalendarRangeStart: string;
  douyinDatePreset: "day" | "week" | "month" | "custom" | "all";
  status: AnyRecord | null;
  collectionModules: Set<string>;
  collectionBackfillDate: string;
  collectionBackfillShops: Set<string>;
  collectionMessage: string;
  page: PageName;
  inventory: AnyRecord | null;
  inventoryView: InventoryView;
  inventoryWarehouse: string;
  inventoryBrand: string;
  inventorySortKey: string;
  inventorySortDir: "asc" | "desc";
  businessOutbound: AnyRecord | null;
  businessOutboundMessage: string;
  settlement: SettlementDashboard | null;
  settlementShop: string;
  settlementAvailableDates: string[];
  settlementStartDate: string;
  settlementEndDate: string;
  settlementCalendarOpen: boolean;
  settlementCalendarCursor: string;
  settlementCalendarRangeStart: string;
  settlementUploadMessage: string;
  orderImports: OrderImports;
  orderPreview: OrderPreview | null;
  orderImportMessage: string;
  channel: ChannelDashboard | null;
  douyin: DouyinDashboard | null;
};

export let COLLECTION_SHOPS: string[] = [];

export function setCollectionShops(shops: string[]) {
  COLLECTION_SHOPS = [...new Set(shops.filter(Boolean))];
  state.collectionBackfillShops = new Set(COLLECTION_SHOPS);
}

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

export const state: AppState = { currentUser: null, users: [], accountMessage: "", records: [], operationDates: new Set<string>(), operationPlatforms: new Set<string>(), operationShops: new Set<string>(), operationSources: new Set<string>(), operationFilterOpen: new Set<string>(), operationCalendarOpen: false, operationCalendarCursor: "", operationCalendarRangeStart: "", operationDatePreset: "all", tablePlatform: "", tableShop: "", operationSection: "overview", douyinSection: "live", douyinShop: "", douyinStartDate: "", douyinEndDate: "", douyinCalendarOpen: false, douyinCalendarCursor: "", douyinCalendarRangeStart: "", douyinDatePreset: "day", status: null, collectionModules: new Set(["operations", "channel", "douyin"]), collectionBackfillDate: latestBackfillDate(), collectionBackfillShops: new Set(COLLECTION_SHOPS), collectionMessage: "", page: "operations", inventory: null, inventoryView: "overview", inventoryWarehouse: "", inventoryBrand: "", inventorySortKey: "", inventorySortDir: "desc", businessOutbound: null, businessOutboundMessage: "", settlement: null, settlementShop: "", settlementAvailableDates: [], settlementStartDate: "", settlementEndDate: "", settlementCalendarOpen: false, settlementCalendarCursor: "", settlementCalendarRangeStart: "", settlementUploadMessage: "", orderImports: { batches: [], summary: {} }, orderPreview: null, orderImportMessage: "", channel: null, douyin: null };

export const isAdmin = () => state.currentUser?.role === "admin";
