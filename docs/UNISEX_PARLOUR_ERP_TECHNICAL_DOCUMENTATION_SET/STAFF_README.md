# Staff & Operational HR Module — Specification & Status

```text
Module: Staff & Operational Personnel Management
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Human Resources / Operations
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: STAFF_BACKEND_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md, STAFF_BACKEND_CONTRACT.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Staff** module manages salon personnel (hair stylists, beauticians, therapists, cashiers, helpers). It decouples operational employee identity from user authentication logins and enforces strict branch and service capability mappings.

### Key Responsibilities
- Staff HR profile management (name, phone, email, designation, joining date).
- Automatic sequential staff code generation (`STF-XXXX`) via `Sequence` model.
- **Primary Branch Invariant**: Enforces exactly one primary branch per staff member with automatic promotion inside ACID transactions.
- Service capability mapping via `StaffService` junction table.
- User account linkage & unlinking (`Staff` ↔ `User`).
- Soft deletion with cascading user deactivation and isolated restoration.

---

## 2. Multi-Tenancy & Scoping Rules

- **Organization Bound**: All staff records are strictly isolated by `organizationId`. Phone numbers must be unique per organization.
- **Branch Junctions**: Branch assignments are managed in `StaffBranch`. A staff member can operate across multiple branches but must have exactly one primary branch.

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View Staff Directory | `employees.view` | Browse staff profiles, branch assignments, service mappings |
| Create Staff Profile | `employees.create` | Register staff profile (auto STF-XXXX code) |
| Update Staff / Link User | `employees.update` | Update details, change status, link/unlink user accounts |
| Soft-Delete Staff | `employees.delete` | Soft-delete staff (cascades user to inactive) |
| Assign / Remove Branch | `employees.assign_branch` | Modify branch assignments |
| Assign / Remove Service | `employees.assign_service` | Modify service capabilities |

---

## 4. Database Models & Schema Specifications

### Staff Model (`src/models/staff/staff.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `staffCode`: String (Unique, e.g. `STF-0001`, auto-generated).
- `name`: String (Required, trimmed).
- `phone`: String (Required, normalized, unique per org).
- `email`: String (Optional, lowercase).
- `designation`: String (e.g. "Senior Hair Stylist", "Nail Artist").
- `userId`: Ref `User` (Optional, unique 1-to-1 link).
- `status`: Enum (`active`, `inactive`, `suspended`).
- Soft-delete plugin enabled (`isDeleted`, `deletedAt`).

### StaffBranch Model (`src/models/staff/staffBranch.model.js`)
- `organizationId`: Ref `Organization` (Required).
- `staffId`: Ref `Staff` (Required, Indexed).
- `branchId`: Ref `Branch` (Required, Indexed).
- `isPrimary`: Boolean (Default: `false`).
- Compound Index: `{ organizationId: 1, staffId: 1, branchId: 1 }` (Unique).

### StaffService Model (`src/models/staff/staffService.model.js`)
- `organizationId`: Ref `Organization` (Required).
- `staffId`: Ref `Staff` (Required, Indexed).
- `serviceId`: Ref `Service` (Required, Indexed).
- Compound Index: `{ organizationId: 1, staffId: 1, serviceId: 1 }` (Unique).

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/staff` | `employees.create` | Create staff profile (auto `STF-XXXX`) |
| `GET` | `/api/v1/staff` | `employees.view` | Paginated staff list with branch/designation filters |
| `GET` | `/api/v1/staff/:id` | `employees.view` | Get staff details |
| `PUT` | `/api/v1/staff/:id` | `employees.update` | Update staff profile details |
| `DELETE` | `/api/v1/staff/:id` | `employees.delete` | Soft-delete staff (cascades linked user to inactive) |
| `POST` | `/api/v1/staff/:id/restore` | `employees.update` | Restore soft-deleted staff profile |
| `POST` | `/api/v1/staff/:id/user` | `employees.update` | Link User account to Staff profile |
| `DELETE` | `/api/v1/staff/:id/user` | `employees.update` | Unlink User account from Staff profile |
| `POST` | `/api/v1/staff/:id/branches` | `employees.assign_branch` | Assign branch (auto sets primary if first branch) |
| `DELETE` | `/api/v1/staff/:id/branches/:branchId` | `employees.assign_branch` | Remove branch assignment (promotes oldest remaining) |
| `GET` | `/api/v1/staff/:id/branches` | `employees.view` | List assigned branches |
| `POST` | `/api/v1/staff/:id/services` | `employees.assign_service` | Map service capability to staff |
| `DELETE` | `/api/v1/staff/:id/services/:serviceId` | `employees.assign_service` | Remove service capability |
| `GET` | `/api/v1/staff/:id/services` | `employees.view` | List mapped service capabilities |

---

## 6. Testing & Verification

- **Test Files**: `src/tests/staff/staff.test.js`.
- **Result**: ✅ 100% Passed.

