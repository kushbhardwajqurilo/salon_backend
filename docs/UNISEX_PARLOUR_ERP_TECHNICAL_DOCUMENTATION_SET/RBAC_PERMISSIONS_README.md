# RBAC & Canonical Permissions Module — Specification & Status

```text
Module: Role-Based Access Control (RBAC) & Permission Registry
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Backend Authorization & Governance
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: PERMISSIONS.md, workflow_md/rbac_workflow.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **RBAC & Canonical Permissions** module enforces granular capability-based authorization across all ERP operations. Role names are human-readable groupings and never serve as bypasses or security logic.

### Key Responsibilities
- Central canonical permission registry (~90+ permission strings) in `src/config/permissions.js`.
- Permission-based authorization middleware (`requirePermission`, `authorize`).
- Role definition, creation, and permission assignment.
- High-performance Redis caching of role permissions (24-hour TTL) with automatic cache invalidation upon mutation.
- Automated database sync CLI script (`npm run permissions:sync`).

---

## 2. Authorization Philosophy & Rules

- **Core Rule**: Authorization is strictly permission-based, **never role-name-based**.
- **The Owner Role**: The system role `owner` possesses all permissions by default.
- **Cache Architecture**: Role permissions are cached in Redis under the key `rbac:role:<roleId>:permissions`. Any update to a role immediately purges the corresponding Redis cache key.

---

## 3. Canonical Permission Keys Registry

Key modules and permission keys declared in `src/config/permissions.js`:

| Module Area | Canonical Permission Keys |
|:---|:---|
| **Users** | `users.view`, `users.create`, `users.update`, `users.delete` |
| **Roles & Permissions** | `roles.view`, `roles.create`, `roles.update`, `roles.delete` |
| **Organizations & Branches** | `organizations.view`, `organizations.update`, `branches.view`, `branches.create`, `branches.update`, `branches.delete` |
| **Customers** | `customers.view`, `customers.create`, `customers.edit`, `customers.delete` |
| **Services** | `services.view`, `services.create`, `services.edit`, `services.delete` |
| **Employees & Staff** | `employees.view`, `employees.create`, `employees.update`, `employees.delete`, `employees.assign_branch`, `employees.assign_service` |
| **Leaves** | `employees.leaves.view`, `employees.leaves.manage` |
| **Appointments** | `appointments.view`, `appointments.create`, `appointments.reschedule`, `appointments.assign_staff`, `appointments.update_status`, `appointments.cancel`, `appointments.force_early_start`, `appointments.reminders.send` |
| **Subscriptions** | `subscriptions.view`, `subscriptions.configure`, `subscriptions.sell`, `subscriptions.redeem` |
| **Billing & POS** | `billing.view`, `billing.checkout`, `billing.void` |
| **Payments** | `payments.view`, `payments.receive`, `payments.refund` |
| **Loyalty** | `loyalty.view`, `loyalty.configure`, `loyalty.adjust` |
| **Audit Logs** | `logs.view` |

---

## 4. Database Models & Schema Specifications

### Role Model (`src/models/roles/role.model.js`)
- `organizationId`: Ref `Organization` (Nullable for system-wide roles, otherwise scoped).
- `name`: String (Required, trimmed, e.g. "Manager", "Receptionist", "Stylist").
- `description`: String.
- `permissions`: Array of Refs to `Permission` model.
- `isSystemRole`: Boolean (Default: `false`).

### Permission Model (`src/models/permissions/permission.model.js`)
- `name`: String (Unique canonical key, e.g. `appointments.create`).
- `module`: String (Categorization, e.g. "Appointments").
- `action`: String (e.g. "Create", "View", "Update").
- `description`: String.

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/rbac/permissions` | `roles.view` | List all canonical permissions in registry |
| `POST` | `/api/v1/rbac/permissions` | `roles.create` | Register new custom permission key |
| `GET` | `/api/v1/rbac/roles` | `roles.view` | List roles and populated permissions |
| `POST` | `/api/v1/rbac/roles` | `roles.create` | Create new operational role |
| `POST` | `/api/v1/rbac/roles/:roleId/permissions` | `roles.update` | Assign permissions array to role (invalidates Redis cache) |

---

## 6. Testing & Verification

- **Test Files**:
  - `src/tests/rbac/rbac.test.js`
  - `src/tests/rbac/rbacContract.test.js`
  - `src/tests/rbac/rbacModules.test.js`
  - `src/tests/rbac/rbacService.test.js`
  - `src/tests/rbac/permissionsFiltering.test.js`
- **Result**: ✅ 100% Passed.

