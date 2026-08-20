export {
	listQuotaAdapters,
	QUOTA_ADAPTERS_KEY,
	registerQuotaAdapter,
} from "./src/quota/guest.ts";
export type { QuotaAdapter, QuotaAdapterHost, QuotaModelRef } from "./src/quota/guest.ts";
export type { QuotaSnapshot, QuotaSourceId, QuotaWindow } from "./src/quota/types.ts";
