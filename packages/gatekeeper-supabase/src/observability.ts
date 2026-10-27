import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** The vendor id: the router's `/gatekeeper/supabase/` path segment. */
export const VENDOR_ID = "supabase";

/** Observability fields emitted by the Supabase gatekeeper. */
export type SupabaseObservabilityFields = { vendorId: string };

/** Ambient observability fields for one Supabase gatekeeper operation. */
export const obsContext = createObservabilityContext<SupabaseObservabilityFields>();
