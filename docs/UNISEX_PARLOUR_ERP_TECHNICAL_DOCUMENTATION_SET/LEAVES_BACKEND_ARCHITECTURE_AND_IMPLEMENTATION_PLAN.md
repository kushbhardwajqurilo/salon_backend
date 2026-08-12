# Leaves Backend Architecture and Implementation Plan

```
Status: Canonical — FINAL
Version: 1.0 FINAL
Last Updated: 2026-08-11
Reference Modules: Staff (blueprint), Backend Module Architecture Standard v1.0
Scope: Leaves request/workflow module (v1)
```

---

## 1. Scope and Non-Goals

### In-Scope (v1)
- Leave request creation, listing, retrieval, update (pending only), approval, rejection, and cancellation.
- Branch-scoped operations via `requireBranchScope` + `X-Branch-Id` header.
- Staff ↔ Branch membership validation via existing `StaffBranch` relationship.
- Self-service submission (staff submits own leave) and manager/admin submission (on behalf of staff).
- Self-approval prevention.
- Overlap detection between leave requests for the same staff.
- Audit trail for all leave lifecycle transitions.
- Organization/branch tenant isolation.

### Non-Goals (v1 — explicitly excluded)
- **LeaveType entity** — no leave type catalog/configuration. Leave requests carry a free-text `leaveType` string (e.g. "Casual", "Sick", "Earned") for display only. No type-based rules, quotas, or validation.
- **Leave balance / accrual** — no balance tracking, accrual rules, or deduction logic.
- **Half-day leaves** — all leaves are full-day.
- **Holiday calculation** — no holiday calendar, working-day computation, or business-day logic.
- **Payroll integration** — no linkage to payroll, salary, or compensation.
- **Attendance integration** — no linkage to attendance/punch records.
- **Separate Staff ↔ Leave relationship entity** — the Leave document directly references `staffId`; no intermediate join entity.

---

## 2. Leave Model Fields / Types / Indexes

**File:** `src/models/leaves/leave.model.js`

```js
const leaveSchema = new mongoose.Schema(
  {
    organizationId: { type: ObjectId, ref: "Organization", required: true },
    branchId: { type: ObjectId, ref: "Branch", required: true },
    staffId: { type: ObjectId, ref: "Staff", required: true },
    leaveCode: { type: String, required: true },
    leaveType: { type: String, required: true, trim: true }, // free-text, display only
    startDate: { type: Date, required: true },               // UTC midnight
    endDate: { type: Date, required: true },                 // UTC midnight
    dates: { type: [String], default: [] },                  // INTERNAL ONLY — covered YYYY-MM-DD strings; never client-controlled, never serialized
    reason: { type: String, required: true, trim: true, maxlength: 1000 },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending",
      required: true,
    },
    submittedBy: { type: ObjectId, ref: "User", required: true }, // actor who submitted
    submittedFor: { type: String, enum: ["self", "staff"], required: true }, // self-service vs on-behalf
    reviewedBy: { type: ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, trim: true, maxlength: 1000, default: null },
    cancelledBy: { type: ObjectId, ref: "User", default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, maxlength: 1000, default: null },
  },
  { timestamps: true }
);
```

**Indexes:**
```js
// Tenant + branch isolation
leaveSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
// Staff-centric queries (list by staff, overlap validation)
leaveSchema.index({ organizationId: 1, staffId: 1, startDate: 1, endDate: 1 });
// Status filtering
leaveSchema.index({ organizationId: 1, branchId: 1, status: 1, createdAt: -1 });
// Unique leave code (soft-delete aware)
leaveSchema.index(
  { organizationId: 1, leaveCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
// CANONICAL CONCURRENCY SERIALIZATION — unique multikey index on covered dates
// Prevents concurrent overlapping leave inserts atomically at the storage engine
leaveSchema.index(
  { organizationId: 1, staffId: 1, dates: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, status: { $in: ["pending", "approved"] } } }
);
```

**Note:** The global `auditPlugin` (registered in `src/database/db.js`) automatically adds `isDeleted`, `deletedAt`, `createdBy`, `updatedBy`, `deletedBy` and the `.softDelete(userId)` instance method. The model does NOT need to declare these.

**`dates` field contract:**
- **Internal-only field.** Never accepted from the request body (stripped by `.strict()` Zod + service never reads it from input). Never exposed in API responses (excluded via `select`/response mapping).
- Populated exclusively by the service via the date conversion helper (§9).
- On update, the FULL `dates` array is recomputed and replaced in a single `save()` — never incrementally pushed/removed.

---

## 3. Status Lifecycle + Allowed/Forbidden Transitions

**States:** `pending` → `approved` | `rejected` | `cancelled`

| From | To | Allowed? | Actor | Notes |
|---|---|---|---|---|
| pending | approved | ✅ | Manager/Admin (`employees.leaves.manage`) | Sets `reviewedBy`, `reviewedAt` |
| pending | rejected | ✅ | Manager/Admin (`employees.leaves.manage`) | Sets `reviewedBy`, `reviewedAt`, `reviewNote` |
| pending | cancelled | ✅ | Submitter (self) or Manager/Admin | Sets `cancelledBy`, `cancelledAt`, `cancelReason` |
| approved | cancelled | ✅ | Manager/Admin (`employees.leaves.manage`) | Cancelling frees the `dates` index entries |
| approved | rejected | ❌ | — | Forbidden — must cancel first |
| approved | pending | ❌ | — | Forbidden — no re-open |
| rejected | pending | ❌ | — | Forbidden — must submit a new request |
| rejected | approved | ❌ | — | Forbidden — must submit a new request |
| rejected | cancelled | ❌ | — | Forbidden — already terminal |
| cancelled | any | ❌ | — | Terminal state |

**Note:** `rejected` and `cancelled` documents drop out of the `dates` unique index via `partialFilterExpression`, so their dates are automatically freed for new requests.

---

## 4. Create / Update / Approve / Reject / Cancel Rules

### Create
- Requires `X-Branch-Id` (branch-scoped). `branchId` derived from `req.branchId` (set by `requireBranchScope`), **never from body**.
- `organizationId` derived from `req.organizationId` (set by `requireBranchScope`), **never from body**.
- Self-service: `staffId` omitted → resolved to actor's linked Staff (§6). On-behalf: `staffId` provided and differs from actor's own Staff → requires `employees.leaves.manage`.
- `startDate` and `endDate` required, `YYYY-MM-DD` format; `endDate >= startDate` enforced.
- **`MAX_LEAVE_DAYS` = 365.** Any range exceeding 365 calendar days is rejected with 400. This bounds the `dates[]` multikey index array length, preventing unbounded index growth and excessive resource usage per document.
- `leaveCode` generated via `Sequence` (`leaveCode:${organizationId}`) → `LV-0001` pattern.
- Initial status is always `pending`.
- `submittedBy` = actor user id; `submittedFor` = `"self"` or `"staff"`.

### Update (draft edit)
- Only `pending` leaves may be updated. Editing approved/rejected/cancelled leaves is forbidden.
- Only the submitter (self) or a manager/admin (`employees.leaves.manage`) may update a pending leave.
- Editable fields: `leaveType`, `startDate`, `endDate`, `reason`. `staffId`, `branchId`, `organizationId`, `status`, `leaveCode`, `dates`, `submittedBy`, `submittedFor` are immutable.
- Re-runs date validation, `MAX_LEAVE_DAYS` check, and overlap detection (friendly query + the `dates` unique index backstop) on the updated values.
- The FULL `dates` array is recomputed and replaced in the same atomic `save()`.

### Approve
- Requires `employees.leaves.manage`.
- Only `pending` leaves can be approved.
- **Self-approval prevention:** the actor must NOT be the `submittedBy` user of the leave. If the actor is the submitter, throw 403.
- Sets `status = "approved"`, `reviewedBy = actorId`, `reviewedAt = now`.
- Optional `reviewNote`.

### Reject
- Requires `employees.leaves.manage`.
- Only `pending` leaves can be rejected.
- **Self-rejection prevention:** the actor must NOT be the `submittedBy` user. If the actor is the submitter, throw 403.
- Sets `status = "rejected"`, `reviewedBy = actorId`, `reviewedAt = now`, `reviewNote` (required).

### Cancel
- `pending` leaves: cancelable by the submitter (self) or a manager/admin (`employees.leaves.manage`).
- `approved` leaves: cancelable only by a manager/admin (`employees.leaves.manage`).
- Sets `status = "cancelled"`, `cancelledBy = actorId`, `cancelledAt = now`, `cancelReason` (required).
- `rejected` and `cancelled` leaves cannot be cancelled.

---

## 5. Staff Eligibility and StaffBranch Validation

- Before creating/updating a leave, the service must verify the target `staffId` exists, is active, and belongs to `organizationId`:
  ```js
  const staff = await staffRepo.findById(staffId, organizationId);
  if (!staff) throw new AppError("Staff not found", 404);
  if (staff.status !== "active") throw new AppError("Staff is not active", 400);
  ```
- **Branch membership:** the staff must be assigned to the active branch (`req.branchId`) via an active `StaffBranch` record:
  ```js
  const assignment = await staffBranchRepo.findOne(
    { staffId, branchId: req.branchId, isActive: true }, organizationId);
  if (!assignment) throw new AppError("Staff is not assigned to this branch", 403);
  ```
- This reuses the existing `StaffBranch` relationship and `StaffBranchRepository.findOne` pattern from `src/services/staff/staff.service.js` (`getStaffById`).

---

## 6. Self-Service vs Manager/Admin Submission (FINAL RBAC Flow)

**Exact POST flow:**

```
authenticate → requireBranchScope → authorize("employees.leaves.view")
    → validate(createLeaveSchema) → requireOnBehalfManage (conditional)
    → controller.createLeave
```

1. **`authorize("employees.leaves.view")`** — grants entry to all staff/users with view permission.
2. **`validate(createLeaveSchema)`** — strips all server-owned fields, validates `staffId` (optional), `leaveType`, `startDate`, `endDate`, `reason`.
3. **`requireOnBehalfManage`** (middleware, new file `src/middleware/leaveScope.js`):
   - `staffId` omitted → **self-submit** — allowed with `view` only. Pass.
   - `staffId` present → resolve actor's own Staff via `staffRepo.findOne({ userId: req.user.id, isDeleted: false }, req.organizationId)`.
     - Equality with actor's own Staff → **self-submit** — allowed with `view`. Pass.
     - Differs → **on-behalf** — invoke `requirePermission("employees.leaves.manage")` (existing export from `src/middleware/rbac.js`) → 403 if absent.
4. **Service independently re-enforces** the final staff identity and authorization — the controller never trusts that middleware alone. `createLeave` resolves/staffId again from the user session and rejects mismatches that would escalate privilege.

**Invariant:** A client-provided `staffId` can only select which branch of the check runs. It can never grant `manage`. `requirePermission("employees.leaves.manage")` is always executed server-side for on-behalf requests, and the service re-validates the resolved identity.

---

## 7. Self-Approval Prevention

- In `approve` and `reject`, the service compares `leave.submittedBy` with `actorId`:
  ```js
  if (leave.submittedBy.toString() === actorId.toString()) {
    throw new AppError("You cannot approve/reject your own leave request", 403);
  }
  ```

---

## 8. Overlap Detection Rules

Two complementary layers:

### 8.1 Friendly deterministic validation (application-level query)
Run inside the transaction before insert/update to give a clear, human-friendly error:
```js
const overlap = await leaveRepo.findOne(
  {
    staffId,
    status: { $in: ["pending", "approved"] },
    _id: { $ne: leaveId }, // exclude self on update
    startDate: { $lte: endDate },
    endDate: { $gte: startDate },
  },
  organizationId
);
if (overlap) throw new AppError("Leave request overlaps with an existing leave", 400);
```
- Uses covered `startDate`/`endDate` range intersection on non-terminal states.
- `rejected` and `cancelled` leaves are excluded and do not block new requests.

### 8.2 Canonical atomic enforcement (unique multikey `dates` index)
The `{ organizationId, staffId, dates }` unique index is the **authoritative** guard:
- Every covered calendar date becomes an array element under a single unique key `(organizationId, staffId, date)`.
- Two overlapping non-terminal leaves share ≥1 date → the second insert fails with **E11000 at the storage engine** — there is no application-level race window.
- The partial filter `{ isDeleted: false, status: { $in: ["pending", "approved"] } }` automatically excludes rejected/cancelled/soft-deleted documents, freeing their dates.
- E11000 on the `dates` index key maps to `AppError("Leave request overlaps with an existing leave", 400)`. **Do not silently retry** (unlike `leaveCode` collisions).

---

## 9. Date Semantics (FINAL)

**Canonical date convention — `YYYY-MM-DD` calendar dates stored as UTC-midnight Dates.**

| Layer | Representation |
|---|---|
| **API request** | `"YYYY-MM-DD"` string only. Zod regex `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)`. Datetime strings (ISO with time) are **rejected**. |
| **Mongo storage** | `Date` at UTC midnight: `new Date("2026-09-01T00:00:00.000Z")`. |
| **API response** | `YYYY-MM-DD` string via `date.toISOString().slice(0, 10)`. |
| **Internal `dates[]`** | `YYYY-MM-DD` strings (string equality is stable and index-safe). |
| **Comparisons** | Native Date `$lte`/`$gte` on UTC-midnight values — boundaries never shift. |

**`toUTCDate`/`toDateOnlyStr` conversion helpers (shared util — PROPOSED new file `src/utils/date.js`):**
```js
// "2026-09-01" -> Date at UTC midnight. NEVER new Date(input) — that spec-parses
// date-only as UTC but is ambiguous across runtime environments.
export const toUTCDate = (dateOnlyStr) =>
  new Date(`${dateOnlyStr}T00:00:00.000Z`);

// Date -> "2026-09-01" (always UTC, timezone-stable)
export const toDateOnlyStr = (date) => date.toISOString().slice(0, 10);

// "2026-09-01" -> ["2026-09-01", ..., "2026-09-03"] inclusive
export const enumerateDates = (startStr, endStr) => {
  const out = [];
  let cur = toUTCDate(startStr);
  const end = toUTCDate(endStr);
  while (cur <= end) {
    out.push(toDateOnlyStr(cur));
    cur = new Date(cur.getTime() + 24 * 60 * 60 * 1000);
  }
  return out;
};
```

**Enforcement points:**
- Zod accepts `YYYY-MM-DD` strings only (no `z.date()`, no datetime).
- **Service** performs conversion via `toUTCDate` — never `new Date(input)`.
- **Service** enforces `endDate >= startDate` and `startDate >= todayUTC` (no backdating).
- **Service** enforces `MAX_LEAVE_DAYS = 365` by checking `enumerateDates(start, end).length <= 365` (also protects the multikey index).
- **Serialization** in controller/service responses always uses `toDateOnlyStr`.

---

## 10. Cancellation Rules

- `pending` leave: cancelable by submitter (self) or manager/admin.
- `approved` leave: cancelable only by manager/admin (`employees.leaves.manage`).
- `rejected` / `cancelled`: not cancelable (terminal).
- `cancelReason` is required.
- Cancellation is a terminal state; the leave cannot be re-opened or re-submitted.
- Cancellation drops the document from the `dates` unique index (via partial filter) — dates become immediately available for new requests.

---

## 11. Organization/Branch Isolation (FINAL)

- **Canonical branch source chain:** `X-Branch-Id` header → `requireBranchScope` middleware → `req.branchId`. Org-wide behavior is whatever `requireBranchScope` already defines (`hasOrgWideAccess === true` + omitted header → `req.branchId = undefined`).
- `organizationId` and `branchId` are derived **strictly** from `req.organizationId` / `req.branchId`. They are **never** read from the request body or query.
- **`branchId` is NOT a client query/filter parameter.** It is removed from `queryLeaveSchema`. List filtering applies `req.branchId` internally in the service:
  ```js
  async listLeaves(filter, options, organizationId, branchId) {
    const queryFilter = { ...filter };
    if (branchId) queryFilter.branchId = branchId; // from requireBranchScope, never client input
    if (organizationId) queryFilter.organizationId = organizationId;
    return this.leaveRepo.find(queryFilter, options, organizationId);
  }
  ```
- All repository queries inject `organizationId` (and `branchId` where relevant) to prevent cross-tenant/cross-branch leakage, following the `BaseRepository` tenant-scope injection standard.

---

## 12. Permission Usage

Reuse **only** these two existing permissions from `src/config/permissions.js`:

| Permission | Usage |
|---|---|
| `employees.leaves.view` | List, get, and self-submit own leave requests (own pending edit/cancel) |
| `employees.leaves.manage` | On-behalf submission, approve, reject, cancel (incl. approved), update any pending leave |

No new permissions are introduced in v1.

---

## 13. Audit Actions + Metadata

**File to extend:** `src/models/audit/auditLog.model.js` → add to `AUDIT_ACTIONS`:

```js
LEAVE_REQUESTED: "LEAVE_REQUESTED",
LEAVE_UPDATED: "LEAVE_UPDATED",
LEAVE_APPROVED: "LEAVE_APPROVED",
LEAVE_REJECTED: "LEAVE_REJECTED",
LEAVE_CANCELLED: "LEAVE_CANCELLED",
```

**Audit metadata per action:**

| Action | entityType | entityId | metadata |
|---|---|---|---|
| LEAVE_REQUESTED | `Leave` | leave._id | `{ leaveCode, staffId, branchId, startDate, endDate, leaveType, submittedFor }` |
| LEAVE_UPDATED | `Leave` | leave._id | `{ leaveCode, updatedFields: [...] }` |
| LEAVE_APPROVED | `Leave` | leave._id | `{ leaveCode, reviewedBy, reviewNote }` |
| LEAVE_REJECTED | `Leave` | leave._id | `{ leaveCode, reviewedBy, reviewNote }` |
| LEAVE_CANCELLED | `Leave` | leave._id | `{ leaveCode, cancelReason, previousStatus }` |

**Call pattern** (reuse `AuditLogService.createAuditLog`):
```js
await this.auditLogService.createAuditLog(
  { entityType: "Leave", entityId: leave._id, action: "LEAVE_REQUESTED",
    description: `Leave requested for ${staffId}`, metadata: {...}, branchId, actorId },
  organizationId, actorId, session
);
```

---

## 14. Transaction Boundaries

- **Create:** leave insert + audit log + sequence increment → wrapped in session transaction (`runTransaction` pattern from `StaffService`). Overlap check + `dates` enumeration run inside the transaction.
- **Update:** leave update (full `dates` recompute) + audit log → transaction.
- **Approve/Reject/Cancel:** single-document status update + audit log → transaction.
- **List/Get:** read-only, no transaction.
- **E11000 handling:**
  - `dates` index E11000 → `AppError("Leave request overlaps with an existing leave", 400)` — **no retry**.
  - `leaveCode` index E11000 → retry sequence generation up to 3 times (existing `StaffService.createStaff` pattern), then rethrow.

---

## 15. Concurrency / Race-Condition Handling (FINAL)

### Overlap race — canonical mechanism
- **Unique multikey index** `{ organizationId: 1, staffId: 1, dates: 1 }` with `partialFilterExpression: { isDeleted: false, status: { $in: ["pending", "approved"] } }` is the **authoritative** serialization point.
- Two concurrent overlapping creates share ≥1 covered date → the second fails **atomically at the storage engine** with E11000. No application-level read-check-then-write race exists.
- The friendly overlap query (§8.1) runs first for a deterministic, human-readable error; the index is the backstop that guarantees correctness under concurrency.
- `rejected`/`cancelled`/soft-deleted docs are excluded by the partial filter — their dates are freed automatically.
- Status transitions (`pending → approved/rejected/cancelled`) automatically move the document in/out of the index via the partial filter — no manual index maintenance.

### Status transition race
- Two concurrent approve/reject calls on the same leave. The service re-reads the leave **inside the transaction** and validates the current status before applying the transition.
- The global `auditPlugin` enables `optimisticConcurrency` (Mongoose versioning) on the model — concurrent saves on the same document throw a VersionError. The service catches and rethrows as `AppError("Leave was modified by another request", 409)`.

### `dates` array safety
- **`MAX_LEAVE_DAYS = 365`.** Ranges exceeding 365 calendar days are rejected with 400. This bounds the multikey index array length: a 365-day leave produces at most 365 array elements. Without this cap, unbounded ranges could create pathological index entries and excessive per-document resource usage. The 365-day figure aligns with a full-year leave cap.

---

## 16. API Endpoints

All under `/api/v1/leaves` (mounted in `app.mjs`).

| Method | Path | Permission | Description |
|---|---|---|---|
| POST | `/api/v1/leaves` | `employees.leaves.view` (self) / `employees.leaves.manage` (on-behalf) | Create leave request |
| GET | `/api/v1/leaves` | `employees.leaves.view` | List leaves (paginated, filterable) |
| GET | `/api/v1/leaves/:id` | `employees.leaves.view` | Get leave detail |
| PUT | `/api/v1/leaves/:id` | `employees.leaves.view` (own pending) / `employees.leaves.manage` | Update pending leave |
| POST | `/api/v1/leaves/:id/approve` | `employees.leaves.manage` | Approve leave |
| POST | `/api/v1/leaves/:id/reject` | `employees.leaves.manage` | Reject leave |
| POST | `/api/v1/leaves/:id/cancel` | `employees.leaves.view` (own pending) / `employees.leaves.manage` | Cancel leave |

---

## 17. Request/Response Contracts

### Create — `POST /api/v1/leaves`
**Request body:**
```json
{
  "staffId": "64b...",          // optional; omitted = self-service
  "leaveType": "Casual",
  "startDate": "2026-09-01",
  "endDate": "2026-09-03",
  "reason": "Family function"
}
```
**Response (201)** — `dates`, `organizationId`/tenant fields never exposed:
```json
{
  "success": true,
  "status": "success",
  "message": "Leave requested successfully",
  "data": { "id": "...", "leaveCode": "LV-0001", "status": "pending", "staffId": "...", "branchId": "...", "startDate": "2026-09-01", "endDate": "2026-09-03", "leaveType": "Casual", "reason": "Family function", "submittedFor": "self" }
}
```

### List — `GET /api/v1/leaves?page=1&limit=10&status=pending&staffId=...`
**`branchId` is NOT a query parameter** — branch scope comes from `req.branchId` (set by `requireBranchScope`).
**Response (200):**
```json
{
  "success": true,
  "status": "success",
  "message": "Leaves listed successfully",
  "data": [ { "id": "...", "leaveCode": "LV-0001", "status": "pending", ... } ],
  "meta": { "total": 100, "page": 1, "limit": 10, "totalPages": 10 }
}
```

### Approve — `POST /api/v1/leaves/:id/approve`
**Request body (optional):**
```json
{ "reviewNote": "Approved" }
```
**Response (200):**
```json
{
  "success": true,
  "status": "success",
  "message": "Leave approved successfully",
  "data": { "id": "...", "status": "approved", "reviewedBy": "...", "reviewedAt": "...", "reviewNote": "Approved" }
}
```

### Reject — `POST /api/v1/leaves/:id/reject`
**Request body (required):**
```json
{ "reviewNote": "Insufficient staff coverage" }
```

### Cancel — `POST /api/v1/leaves/:id/cancel`
**Request body (required):**
```json
{ "cancelReason": "Plans changed" }
```

---

## 18. Zod Validation Rules (FINAL)

**File:** `src/validation/leaves/leave.validation.js`

```js
const objectIdRegex = /^[0-9a-fA-F]{24}$/;
const objectIdSchema = z.string().regex(objectIdRegex, "Invalid ObjectId format");
const dateOnlyRegex = /^\d{4}-\d{2}-\d{2}$/;
const dateOnlySchema = z.string().regex(dateOnlyRegex, "Invalid date format (YYYY-MM-DD)");

export const createLeaveSchema = z.object({
  body: z.object({
    staffId: objectIdSchema.optional(), // omitted = self-service
    leaveType: z.string().min(1, "Leave type is required").trim().max(50),
    startDate: dateOnlySchema,
    endDate: dateOnlySchema,
    reason: z.string().min(1, "Reason is required").trim().max(1000),
  }).strict(), // strips organizationId/branchId/status/leaveCode/dates/submittedBy/reviewedBy/cancelledBy
});

export const updateLeaveSchema = z.object({
  body: z.object({
    leaveType: z.string().min(1).trim().max(50).optional(),
    startDate: dateOnlySchema.optional(),
    endDate: dateOnlySchema.optional(),
    reason: z.string().min(1).trim().max(1000).optional(),
  }).strict(),
});

export const queryLeaveSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().default(10),
    sort: z.string().refine(...).default("-createdAt"),
    search: z.string().optional(),
    status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
    staffId: objectIdSchema.optional(),
    startDate: dateOnlySchema.optional(),
    endDate: dateOnlySchema.optional(),
    // branchId deliberately NOT accepted — branch scope comes from X-Branch-Id → req.branchId
  }),
});

export const approveLeaveSchema = z.object({
  body: z.object({ reviewNote: z.string().trim().max(1000).optional() }).strict(),
});

export const rejectLeaveSchema = z.object({
  body: z.object({ reviewNote: z.string().min(1, "Review note is required").trim().max(1000) }).strict(),
});

export const cancelLeaveSchema = z.object({
  body: z.object({ cancelReason: z.string().min(1, "Cancel reason is required").trim().max(1000) }).strict(),
});
```

**Key rules (FINAL):**
- Dates are `YYYY-MM-DD` strings only. No `z.date()`, no datetime strings.
- `.strict()` strips all server-owned fields: `organizationId`, `branchId`, `status`, `leaveCode`, `dates`, `submittedBy`, `submittedFor`, `reviewedBy`, `reviewedAt`, `reviewNote`, `cancelledBy`, `cancelledAt`, `cancelReason`.
- `branchId` not accepted in query schema.
- `endDate >= startDate` and `MAX_LEAVE_DAYS` enforced in service (cross-field business rules).
- `allowedSortFields` whitelist: `["leaveCode", "startDate", "endDate", "status", "createdAt", "updatedAt"]`.

---

## 19. Repository Methods

**File:** `src/repositories/leaves/leave.repository.js` — extends `BaseRepository`.

```js
export class LeaveRepository extends BaseRepository {
  constructor() { super(Leave); }

  async create(data, organizationId, userId = null, session = null) {
    const doc = new this.model({ ...data, organizationId });
    if (userId) { doc.createdBy = userId; doc.updatedBy = userId; }
    return doc.save({ session }); // E11000 from dates index → overlap; leaveCode index → retry upstream
  }

  async findById(id, organizationId, populate = [], select = null, session = null) {
    // select should EXCLUDE "dates" unless explicitly requested internally
    return this.model.findOne({ _id: id, organizationId }).populate(populate).select(select).session(session).exec();
  }

  async findOne(filter, organizationId, populate = [], select = null, session = null) {
    return this.model.findOne({ ...filter, organizationId }).populate(populate).select(select).session(session).exec();
  }

  async updateById(id, data, organizationId, userId = null, session = null) {
    const doc = await this.model.findOne({ _id: id, organizationId }).session(session);
    if (!doc) return null;
    Object.assign(doc, data); // dates array replaced as a whole
    if (userId) { doc.updatedBy = userId; }
    return doc.save({ session });
  }

  async find(filter = {}, options = {}, organizationId) {
    // strip non-schema keys; inject organizationId; default searchFields ["leaveCode","leaveType","reason"]
    return super.find(queryFilter, queryOptions);
  }

  async count(filter = {}, organizationId) {
    return super.count({ ...filter, organizationId });
  }

  async findOverlapping(staffId, startDate, endDate, organizationId, excludeId = null, session = null) {
    const filter = {
      staffId,
      status: { $in: ["pending", "approved"] },
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    };
    if (excludeId) filter._id = { $ne: excludeId };
    return this.findOne(filter, organizationId, [], null, session);
  }
}
```

**Response serialization:** the controller/service maps the Mongoose doc to a DTO that excludes `dates` and any other internal/server-only fields.

---

## 20. Service Methods

**File:** `src/services/leaves/leave.service.js`

```js
export class LeaveService {
  constructor() {
    this.leaveRepo = new LeaveRepository();
    this.staffRepo = new StaffRepository();
    this.staffBranchRepo = new StaffBranchRepository();
    this.auditLogService = new AuditLogService();
  }

  async runTransaction(operation) { /* reuse StaffService pattern */ }

  async createLeave(data, organizationId, branchId, actorId) {
    // 1. resolve staffId (self vs on-behalf) + RE-validate authorization independently
    // 2. validate staff active + branch membership (StaffBranch)
    // 3. convert dates via toUTCDate; enforce endDate >= startDate; no past dates; MAX_LEAVE_DAYS
    // 4. enumerate dates[] via enumerateDates
    // 5. generate leaveCode via Sequence (LV-0001)
    // 6. friendly overlap query (findOverlapping)
    // 7. insert with dates[]; catch E11000 → LEAVE_OVERLAP (400) vs leaveCode retry
    // 8. audit LEAVE_REQUESTED
  }

  async updateLeave(id, data, organizationId, branchId, actorId) {
    // only pending; only submitter or manager; immutable fields enforced
    // recompute FULL dates[]; re-validate all date rules + overlap; single save; audit LEAVE_UPDATED
  }

  async approveLeave(id, reviewNote, organizationId, actorId) {
    // only pending; self-approval prevention; set approved/reviewedBy/reviewedAt; audit LEAVE_APPROVED
  }

  async rejectLeave(id, reviewNote, organizationId, actorId) {
    // only pending; self-rejection prevention; set rejected/reviewedBy/reviewedAt; audit LEAVE_REJECTED
  }

  async cancelLeave(id, cancelReason, organizationId, actorId) {
    // pending (submitter or manager) or approved (manager only); set cancelled; audit LEAVE_CANCELLED
  }

  async getLeaveById(id, organizationId, branchId) { /* findById + branch check + DTO mapping */ }

  async listLeaves(filter, options, organizationId, branchId) {
    // branchId forced from req.branchId (never client input); find + DTO mapping
  }
}
```

---

## 21. Controller Responsibilities

**File:** `src/controllers/leaves/leave.controller.js`

- Thin controllers only: extract `req.params`, `req.query`, `req.body`, `req.organizationId`, `req.branchId`, `req.user.id`.
- Call service methods and respond via `sendResponse`.
- Do NOT re-derive branch context manually (unlike Staff's legacy `getActiveBranchContext`). Branch context comes from `req.branchId` set by `requireBranchScope`.
- Controllers map responses to DTOs excluding `dates` and other internal fields.
- Wrap handlers with `asyncHandler`.

```js
export const createLeave = asyncHandler(async (req, res) => {
  const leave = await leaveService.createLeave(req.body, req.organizationId, req.branchId, req.user.id);
  return sendResponse(res, 201, "Leave requested successfully", toLeaveDTO(leave));
});
```

---

## 22. Route Middleware Chains (FINAL)

**File:** `src/routers/leaves/leave.routes.js`

```js
router.post("/", authenticate, requireBranchScope, authorize("employees.leaves.view"),
  validate(createLeaveSchema), requireOnBehalfManage, controller.createLeave);
router.get("/", authenticate, requireBranchScope, authorize("employees.leaves.view"),
  validate(queryLeaveSchema), controller.listLeaves);
router.get("/:id", authenticate, requireBranchScope, authorize("employees.leaves.view"), controller.getLeave);
router.put("/:id", authenticate, requireBranchScope, authorize("employees.leaves.view"),
  validate(updateLeaveSchema), controller.updateLeave);
router.post("/:id/approve", authenticate, requireBranchScope, authorize("employees.leaves.manage"),
  validate(approveLeaveSchema), controller.approveLeave);
router.post("/:id/reject", authenticate, requireBranchScope, authorize("employees.leaves.manage"),
  validate(rejectLeaveSchema), controller.rejectLeave);
router.post("/:id/cancel", authenticate, requireBranchScope, authorize("employees.leaves.view"),
  validate(cancelLeaveSchema), controller.cancelLeave);
```

**`requireOnBehalfManage`** — `src/middleware/leaveScope.js`:
```js
export const requireOnBehalfManage = asyncHandler(async (req, res, next) => {
  if (!req.body.staffId) return next(); // self-submit; view already granted

  const actorStaff = await staffRepo.findOne(
    { userId: req.user.id, isDeleted: false }, req.organizationId);
  if (actorStaff && req.body.staffId === actorStaff._id.toString())
    return next(); // own staff document = self-submit; view suffices

  // on-behalf: reuse existing Redis-cached RBAC permission check
  await requirePermission("employees.leaves.manage")(req, res, next);
});
```

**Chain:** `authenticate → requireBranchScope → authorize → validate → (conditional requireOnBehalfManage on POST) → controller`.

**Note:** `requireBranchScope` (not `requireOrganizationScope`) is used because Leaves is branch-scoped. This is the canonical pattern per BACKEND_MODULE_ARCHITECTURE_STANDARD.md §8/§14, and deliberately avoids Staff's legacy manual branch-context pattern.

**Mount in `app.mjs`:**
```js
import leaveRouter from "./src/routers/leaves/leave.routes.js";
app.use("/api/v1/leaves", leaveRouter);
```

---

## 23. Error Codes / Statuses (FINAL)

| Code | Scenario |
|---|---|
| 400 | Invalid input (Zod), `endDate < startDate`, past `startDate`, overlap detected (friendly query OR `dates` index E11000 → LEAVE_OVERLAP), staff not active, invalid lifecycle transition, missing review/cancel note, range exceeds `MAX_LEAVE_DAYS` (366+ days) |
| 401 | Unauthenticated (no/invalid token) |
| 403 | Missing permission, self-approval/rejection attempt, on-behalf without `employees.leaves.manage`, staff not assigned to branch, cross-branch access |
| 404 | Leave not found, staff not found, branch not found |
| 409 | Concurrent status transition conflict (optimistic locking VersionError) |
| 500 | Server/database errors (masked in production) |

All errors bubble to `globalErrorHandler` in `src/utils/errors.js` via `next(err)`.

---

## 24. Mongo Indexes (FINAL)

```js
leaveSchema.index({ organizationId: 1, branchId: 1, createdAt: -1 });
leaveSchema.index({ organizationId: 1, staffId: 1, startDate: 1, endDate: 1 });
leaveSchema.index({ organizationId: 1, branchId: 1, status: 1, createdAt: -1 });
leaveSchema.index(
  { organizationId: 1, leaveCode: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } }
);
// CANONICAL concurrency serialization — no alternatives, no optional proposals
leaveSchema.index(
  { organizationId: 1, staffId: 1, dates: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, status: { $in: ["pending", "approved"] } } }
);
```

**Note:** All previous optional/proposed concurrency indexes (e.g. unique `{ organizationId, staffId, startDate }`) are **removed**. The `dates` multikey index is the single canonical serialization mechanism.

---

## 25. Test Matrix (FINAL)

**File:** `src/tests/leaves/leave.test.js` (and integration/security variants)

| Test Category | Cases |
|---|---|
| Unit — validation | Zod rejects missing fields, invalid ObjectId, non-YYYY-MM-DD dates, past dates, `endDate < startDate`, body `organizationId`/`branchId`/`status`/`leaveCode`/`dates` stripped |
| Unit — date semantics | `toUTCDate`/`toDateOnlyStr`/`enumerateDates` correctness; timezone stability; serialization round-trip |
| Unit — date limits | **365-day range accepted**; **366-day range rejected** (MAX_LEAVE_DAYS) |
| Unit — lifecycle | Allowed/forbidden transitions per §3; approve/reject only pending; cancel rules |
| Unit — business rules | Self-approval/rejection blocked; overlap detection (pending+approved block, rejected/cancelled don't); staff active + branch membership required |
| Repository — overlaps | **Overlapping ranges sharing first date**, **sharing middle date**, **sharing last date** all blocked by unique `dates` index |
| Repository — adjacency | **Adjacent non-overlapping dates** (e.g. 09-01→09-03 and 09-04→09-05) both succeed |
| Repository — E11000 mapping | `dates` index E11000 → LEAVE_OVERLAP (400, no retry); `leaveCode` E11000 → retry sequence |
| Repository — freeing | **Rejected leave frees its dates**; **cancelled leave frees its dates** (new request on same dates succeeds) |
| Repository | `organizationId` injection on all queries; partial unique index on `leaveCode`; soft-delete filter |
| Integration — routes | Middleware chain execution; `requireBranchScope` sets `req.branchId`; request param mapping; DB saves |
| API — contract | Paginated response `meta`; error payload structure; status codes per §23; **`dates` never present in responses** |
| API — branch scope | **`branchId` cannot be supplied as a query scope parameter** (rejected/stripped by Zod); list only scoped by `X-Branch-Id → req.branchId` |
| API — field security | **`dates` cannot be supplied or modified by the client** (stripped; updates ignore it); all server-owned fields rejected |
| Security & isolation | Cross-tenant and cross-branch requests blocked; body `organizationId`/`branchId` ignored |
| RBAC | `employees.leaves.view` vs `employees.leaves.manage` enforcement; **self vs on-behalf flow**: omitted `staffId` → self (view); own `staffId` → self (view); different `staffId` → requires `manage` (403 without) |
| Concurrency | **Concurrent overlapping creates** → one succeeds, one gets LEAVE_OVERLAP (E11000); concurrent approve/reject → 409 |

---

## 26. Exact Implementation Order (FINAL)

1. **Model** — `src/models/leaves/leave.model.js`: fields, enums, `dates` array, **all indexes including the canonical unique multikey `dates` index**, and `MAX_LEAVE_DAYS` constant (exported from the model or `src/config/constants.js`).
2. **Date utilities** — `src/utils/date.js`: `toUTCDate`, `toDateOnlyStr`, `enumerateDates` + unit tests.
3. **Audit actions** — add `LEAVE_*` constants to `AUDIT_ACTIONS` in `src/models/audit/auditLog.model.js`.
4. **Repository** — `src/repositories/leaves/leave.repository.js`: extends `BaseRepository`, tenant-scoped methods, `findOverlapping`, E11000 surface.
5. **Validation** — `src/validation/leaves/leave.validation.js`: create/update/query/approve/reject/cancel schemas with `YYYY-MM-DD` dates, `.strict()`, no `branchId` in query.
6. **RBAC middleware** — `src/middleware/leaveScope.js`: `requireOnBehalfManage`.
7. **Service** — `src/services/leaves/leave.service.js`: transaction wrapper, date conversion, `MAX_LEAVE_DAYS`, overlap checks (friendly + index backstop), E11000 mapping, self-service identity resolution, audit calls.
8. **Controller** — `src/controllers/leaves/leave.controller.js`: thin handlers, DTO mapping (excludes `dates`), `sendResponse`.
9. **Routes** — `src/routers/leaves/leave.routes.js`: middleware chains per §22.
10. **Mount** — register `leaveRouter` in `app.mjs` at `/api/v1/leaves`.
11. **Tests** — `src/tests/leaves/`: per §25 — explicitly test the `dates` index concurrency behavior (overlap first/middle/last, adjacency, concurrent creates, freeing on reject/cancel, 365/366-day limits) and the self vs on-behalf RBAC flow.
12. **Verify** — run test suite; confirm `syncIndexes()` builds the `dates` unique multikey index; confirm audit enum reload; run concurrency tests against a replica-set connection to validate the transactional overlap behavior.

---

## Version / Change Log

- **1.0 (2026-08-11):** Initial Leaves backend architecture and implementation plan drafted, based on verified Staff module patterns and Backend Module Architecture Standard v1.0.
- **1.0 FINAL (2026-08-11):** Incorporated the 4 verified architecture review decisions:
  1. **Concurrency:** canonical unique multikey `dates` index `{ organizationId, staffId, dates }` with partial filter `{ isDeleted: false, status: { $in: ["pending", "approved"] } }`; friendly overlap query retained for deterministic validation; `dates` E11000 → LEAVE_OVERLAP (400); `leaveCode` E11000 retried separately; all optional/proposed startDate-index concurrency proposals removed.
  2. **`dates` array safety:** `MAX_LEAVE_DAYS = 365` cap; ranges exceeding 365 calendar days rejected; bounds multikey index/resource usage.
  3. **Branch scope:** `branchId` removed from all client query/filter contracts; canonical chain `X-Branch-Id → requireBranchScope → req.branchId`; org-wide behavior delegated to `requireBranchScope`.
  4. **Date semantics:** API `YYYY-MM-DD` only; Mongo UTC-midnight `Date`; service-side conversion via `toUTCDate` helpers in `src/utils/date.js`; `dates[]` internal `YYYY-MM-DD` strings; response serialization `YYYY-MM-DD`.
  5. **Self-service RBAC:** POST flow `view → validate → requireOnBehalfManage`; omitted `staffId` = self; same actor Staff = self; different Staff = `employees.leaves.manage`; service independently re-enforces identity and authorization.
  6. **Model/API security:** `dates` and all server-owned fields (`organizationId`, `branchId`, `status`, `leaveCode`, `submittedBy`, `reviewedBy`, `cancelledBy`, etc.) never client-controlled; `dates` never exposed in responses.
  7. **Implementation order** updated: concurrency/index behavior implemented in Model phase and tested explicitly (§25/§26).
  8. **Test matrix** expanded: overlap first/middle/last date, adjacency, concurrent overlapping creates, rejected/cancelled freeing dates, 365/366-day limits, `dates` client tampering, `branchId` query tampering, self vs on-behalf RBAC.

---

**FINAL VERDICT:**
**LEAVES BACKEND ARCHITECTURE AND IMPLEMENTATION PLAN v1.0 FINAL — APPROVED FOR IMPLEMENTATION**