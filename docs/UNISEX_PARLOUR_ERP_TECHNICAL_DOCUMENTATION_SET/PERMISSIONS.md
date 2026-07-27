# Unisex Parlour ERP — Permissions & RBAC Specification

**Status:** Living technical specification  
**Parent document:** `ARCHITECTURE.md`  
**Audience:** Frontend engineers, backend engineers, QA, AI coding agents

## 1. Purpose

This document defines the ERP authorization model. It explains how permissions are defined, assigned, resolved, checked, and extended.

The core rule is:

> Authorization is permission-based, not role-name-based.

Roles are a way to group permissions. A role name must never be treated as an implicit security bypass.

## 2. Core Concepts

### Authentication
Answers: **Who is the user?**

### Permission
Answers: **What capability does the user have?**

### Organization scope
Answers: **Which tenant's data can the user access?**

### Branch scope
Answers: **Which branch is the current request operating against?**

These concerns are independent and must remain independent.

## 3. Canonical Permission Keys

Permission keys are stable strings such as:

- `dashboard.view`
- `users.view`
- `users.create`
- `users.update`
- `users.delete`
- `roles.view`
- `roles.create`
- `roles.update`
- `roles.delete`
- `organizations.view`
- `organizations.update`
- `branches.view`
- `branches.create`
- `branches.update`
- `branches.delete`
- `customers.view`
- `customers.create`
- `customers.update`
- `customers.delete`
- `appointments.view`
- `appointments.book`
- `appointments.reschedule`
- `appointments.assign_staff`
- `appointments.update_status`
- `appointments.cancel`
- `employees.view`
- `employees.create`
- `employees.update`
- `employees.delete`
- `employees.leaves.view`
- `employees.leaves.manage`
- `attendance.view`
- `attendance.punch`
- `attendance.adjust`
- `payroll.view`
- `payroll.calculate`
- `services.view`
- `services.create`
- `services.update`
- `services.delete`
- `memberships.view`
- `memberships.configure`
- `memberships.sell`
- `memberships.redeem`
- `coupons.view`
- `coupons.configure`
- `coupons.apply`
- `billing.view`
- `billing.checkout`
- `billing.void`
- `payments.view`
- `payments.receive`
- `payments.refund`
- `expenses.view`
- `expenses.create`
- `expenses.update`
- `expenses.delete`
- `finance.view`
- `finance.gst_report`
- `inventory.view`
- `inventory.consume`
- `inventory.adjust`
- `procurement.suppliers.view`
- `procurement.suppliers.manage`
- `procurement.orders.view`
- `procurement.orders.create`
- `procurement.orders.update`
- `procurement.invoices.manage`
- `procurement.payments.manage`
- `loyalty.view`
- `loyalty.configure`
- `loyalty.adjust`
- `reports.revenue.view`
- `reports.performance.view`
- `reports.retention.view`
- `reports.inventory.view`
- `reports.services.view`
- `whatsapp.config.update`
- `notifications.templates.update`
- `campaigns.send`
- `campaigns.view`
- `settings.view`
- `settings.update`
- `settings.backups`
- `logs.view`

The backend permission registry is the authoritative registry. The frontend mirrors keys only for UI capability checks.

## 4. Permission Resolution

The authenticated session exposes a `permissions` array.

Example:

```json
{
  "role": "Owner",
  "permissions": [
    "customers.view",
    "customers.create",
    "customers.update",
    "customers.delete"
  ]
}
```

The frontend uses this array for UI decisions.

The backend independently resolves and enforces authorization for every protected API operation.

## 5. Owner Behavior

The Owner role has no special frontend bypass.

Owner access is achieved by provisioning the appropriate canonical permissions.

Forbidden:

```ts
if (user.role === "Owner") {
  return true;
}
```

Correct:

```ts
hasPermission("customers.view")
```

This keeps the architecture role-agnostic.

## 6. Frontend Permission Helpers

The frontend may expose:

- `hasPermission(permission)`
- `hasAnyPermission(permissions)`
- `hasAllPermissions(permissions)`

These helpers must inspect the permission list only.

They may be used for:

- Navigation visibility
- Page access UX
- Button visibility
- Disabled states
- Action menus

They are not security controls.

## 7. Backend Authorization

The backend is the final authority.

A protected request must:

1. Authenticate the user.
2. Resolve the required permission.
3. Verify the permission.
4. Apply organization isolation.
5. Apply branch scope where required.
6. Execute business logic.

A frontend-hidden button does not make an endpoint secure.

## 8. Adding a New Permission

When a new capability is introduced:

1. Confirm it represents a real authorization boundary.
2. Choose a stable domain-oriented key.
3. Add it to the canonical backend registry/seed.
4. Ensure the permission can be persisted in the database.
5. Assign it to the appropriate roles.
6. Ensure `/auth/me` returns it for users who have it.
7. Add backend authorization to affected routes.
8. Add frontend checks where UI behavior depends on it.
9. Add tests for allow and deny behavior.
10. Update this document.

Do not silently create a frontend-only permission.

## 9. Forgotten Permission Recovery

The permission seed/registry must be idempotent.

A seed operation should use an upsert-style strategy so running it later can:

- Create missing permissions.
- Preserve existing permissions.
- Avoid duplicate permission documents.

Do not delete permissions automatically during normal seeding unless an explicit migration is intended.

A recommended operational workflow is:

```text
Update canonical registry
        ↓
Run permission sync/seed
        ↓
Verify missing permissions
        ↓
Assign to roles
        ↓
Run RBAC tests
```

## 10. Permission Naming Rules

Use:

`domain.action`

or, for nested domains:

`domain.resource.action`

Examples:

- `customers.view`
- `appointments.assign_staff`
- `procurement.orders.create`

Avoid:

- UI-specific names
- Button-specific names
- Role-specific names
- Duplicate synonyms

A permission should represent a business capability, not a screen.

## 11. Testing Requirements

Every new permission should have:

- Positive authorization test.
- Negative authorization test.
- Frontend capability test if UI uses it.
- Organization isolation test where relevant.
- Branch scope test where relevant.

## 12. Architectural Rules

Never:

- Add role-name bypasses.
- Trust the frontend for security.
- Invent permission keys only in frontend code.
- Reuse unrelated permissions merely to avoid adding a new one.
- Treat `hasOrgWideAccess` as permission.
- Treat `branchAccess` as permission.

Permissions answer **what**.

Scope answers **where**.

