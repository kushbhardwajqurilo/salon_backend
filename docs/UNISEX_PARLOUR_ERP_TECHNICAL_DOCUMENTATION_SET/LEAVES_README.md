# Staff Leaves & Time-Off Module — Specification & Status

```text
Module: Staff Leaves & Absence Management
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Human Resources / Scheduling & Availability
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: LEAVES_BACKEND_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Leaves** module handles staff absence requests, approvals, rejections, and cancellations. It provides the source of truth for stylist availability to prevent scheduling appointments during approved time-off.

### Key Responsibilities
- Leave request submission: Self-service (`submittedFor: "self"`) vs On-behalf (`submittedFor: "staff"`).
- UTC date normalization (`YYYY-MM-DD` strings).
- **Calendar Overlap Prevention**: Database multikey unique index preventing concurrent or overlapping leaves for the same staff.
- Self-approval protection (managers cannot approve their own leaves).
- Full lifecycle audit trail.

---

## 2. Multi-Tenancy & Scoping Rules

- **Organization & Branch Scoped**: Every leave request belongs to an `organizationId` and `branchId`.
- Staff member must be actively assigned to the target branch via `StaffBranch`.

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View Leaves | `employees.leaves.view` | View leave requests and calendar |
| Submit / Cancel Leave | `employees.leaves.view` | Submit self leave or cancel own pending request |
| Approve / Reject Leave | `employees.leaves.manage` | Review, approve, or reject staff leave requests |

---

## 4. Database Models & Schema Specifications

### Leave Model (`src/models/leaves/leave.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `branchId`: Ref `Branch` (Required, Indexed).
- `staffId`: Ref `Staff` (Required, Indexed).
- `leaveCode`: String (Auto-generated sequence).
- `leaveType`: String (e.g. "Casual", "Sick", "Earned").
- `startDate`: Date (UTC midnight).
- `endDate`: Date (UTC midnight).
- `dates`: Array of Strings (Inclusive `YYYY-MM-DD` strings generated server-side).
- `reason`: String (Max 1000 chars).
- `status`: Enum (`pending`, `approved`, `rejected`, `cancelled`).
- `submittedBy`: Ref `User` (Actor who created the request).
- `submittedFor`: Enum (`self`, `staff`).
- `reviewedBy`: Ref `User` (Manager who reviewed).
- `reviewedAt`: Date.
- `reviewNote`: String.

### Unique Multikey Overlap Prevention Index
```js
{
  organizationId: 1,
  staffId: 1,
  dates: 1
}
// Partial filter: { status: { $in: ["pending", "approved"] }, isDeleted: false }
```

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/leaves` | `employees.leaves.view` (+ manager check if on-behalf) | Submit leave request |
| `GET` | `/api/v1/leaves` | `employees.leaves.view` | Query leaves with status, staff, and date filters |
| `GET` | `/api/v1/leaves/:id` | `employees.leaves.view` | Get single leave request details |
| `PUT` | `/api/v1/leaves/:id` | `employees.leaves.view` | Update pending leave request |
| `POST` | `/api/v1/leaves/:id/approve` | `employees.leaves.manage` | Approve pending leave |
| `POST` | `/api/v1/leaves/:id/reject` | `employees.leaves.manage` | Reject pending leave |
| `POST` | `/api/v1/leaves/:id/cancel` | `employees.leaves.view` | Cancel leave request |

---

## 6. Testing & Verification

- **Test Files**:
  - `src/tests/leaves/leave.phase1.test.js`
  - `src/tests/leaves/leave.repository.test.js`
  - `src/tests/leaves/leave.service.test.js`
  - `src/tests/leaves/leave.controller.test.js`
  - `src/tests/leaves/leave.router.test.js`
  - `src/tests/leaves/leave.router.behavior.test.js`
  - `src/tests/leaves/leave.validation.test.js`
  - `src/tests/leaves/leaveScope.middleware.test.js`
- **Result**: ✅ 100% Passed.

