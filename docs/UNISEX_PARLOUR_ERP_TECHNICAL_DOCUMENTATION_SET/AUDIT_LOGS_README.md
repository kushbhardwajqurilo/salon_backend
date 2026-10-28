# Immutable Audit Logs Module — Specification & Status

```text
Module: Audit Logs & Compliance Ledger
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Compliance & Security
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: DATABASE_ARCHITECTURE.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Audit Logs** module records security, financial, and operational mutations across all system entities. It is strictly append-only; update and delete operations are forbidden.

### Key Responsibilities
- Automated Mongoose `auditPlugin` injecting soft-delete flags, user tags, and optimistic locking (`__v`).
- Centralized recording of sensitive business actions (auth lockouts, leave approvals, appointment modifications, billing checkout, payment voids, points adjustments).
- Read-only querying and forensic filtering.

---

## 2. Multi-Tenancy & Scoping Rules

- Scoped to `organizationId` and optional `branchId`.
- Normal domain queries automatically filter out records where `isDeleted === true`.

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View Audit Trail | `logs.view` | Browse and filter security and business audit logs |

---

## 4. Database Models & Schema Specifications

### AuditLog Model (`src/models/audit/auditLog.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `branchId`: Ref `Branch` (Optional/Scoped).
- `action`: String (e.g. `AUTH_LOGIN`, `LEAVE_APPROVE`, `APPOINTMENT_RESCHEDULE`, `INVOICE_FINALIZE`, `PAYMENT_VOID`).
- `entityType`: String (e.g. `Appointment`, `Invoice`, `Leave`, `Staff`, `Customer`).
- `entityId`: ObjectId (Target record ID).
- `actorId`: Ref `User` (User performing the action).
- `actorRole`: String.
- `ipAddress`: String.
- `metadata`: Schema.Types.Mixed (Diffs, old/new states, comments).
- `timestamp`: Date (Default: `Date.now`, Indexed).

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/audit-logs` | `logs.view` | Query audit logs by entity, date, actor, or branch |

---

## 6. Testing & Verification

- **Test Files**: `src/tests/audit/auditLog.integration.test.js`, `src/tests/security.integration.test.js`.
- **Result**: ✅ 100% Passed.

