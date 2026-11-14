// Provider Interface — Salon Project Unisex Parlour ERP
// Defines the contract for biometric provider adapters.
// Provider-independent: the core Attendance engine does not depend on vendor-specific code.

// Provider adapter must implement these methods:
// 1. validateOrganization(org) — validates adapter is configured for this org
// 2. normalizePayload(rawPayload, org, branch, actor) → canonical punch fields
//    - externalEmployeeCode: String (resolved to staff by server-side mapping)
//    - punchType: "in" | "out"
//    - punchAt: Date (UTC, preserving timezone/offset info)
//    - externalEventId: String | null (device-assigned identity for dedup)
//    - provider: String (free-form vendor identifier)
//    - deviceId: String | null
//    - deviceSource: String | null
//    - mappingStatus: "mapped" | "unmapped" | "partial" | "unknown"
//    - rawEvent: Mixed (verbatim vendor payload, preserved for audit)
// 3. validateRequestSource(req) → Error | null
//    - HMAC/signature check, IP allowlisting
// 4. postIngest(punch, org, branch, actor) → side-effects (notification, sync checkpoint update)
//    - default no-op

// Adapter registration:
// - Provider Registry maps provider name to Adapter class
// - New provider: implement adapter class, register via registry.registerAdapter(name, class)
// - No changes to Attendance business logic required

// Provider identity rules:
// - Provider payload must NOT contain ERP organizationId, branchId, or staffId
// - Organization and branch come from trusted provider configuration or authenticated server scope
// - Adapter-provided organizationId, branchId, or staffId fields are ignored.
// - Staff identity comes only from server-side StaffDeviceMapping lookup
// - unmapped/ambiguous events remain in RawProviderEvent until authorized resolution

// Example adapter structure:
// class eTimeOfficeAdapter {
//   constructor(config) { this.config = config; }
//   validateOrganization(org) { /* ... */ }
//   normalizePayload(payload) { /* ... */ }
//   validateRequestSource(req) { /* ... */ }
//   postIngest(punch) { /* ... */ }
// }

// Simulator adapter exercises the same pipeline as real providers
// Used for testing without physical devices