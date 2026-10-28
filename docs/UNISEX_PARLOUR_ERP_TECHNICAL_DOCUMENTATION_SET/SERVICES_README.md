# Services & Categories Module — Specification & Status

```text
Module: Services Catalog & Service Categories
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Operational Catalog / Pricing
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: MODULE_ARCHITECTURE_STANDARD.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Services** module provides the master service menu for the parlour. It supports category grouping, branch-scoped pricing, service duration modeling, gender targeting, and tax computation configuration.

### Key Responsibilities
- Service category hierarchy and display ordering.
- Catalog item CRUD with duration in minutes and code sequences.
- Base pricing and tax inclusion/exclusion configuration.
- Target customer gender filtering (`male`, `female`, `unisex`).
- Category deletion safeguards (prevent deleting categories with active services).
- Soft deletion and reactivation for both services and categories.

---

## 2. Multi-Tenancy & Scoping Rules

- **Organization Boundary**: All categories and services are partitioned by `organizationId`.
- **Branch Scoping**: Services and categories are scoped to specific branches or set across the organization.
- Creating a service requires an active branch context (`X-Branch-Id`).

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View Service Catalog | `services.view` | Browse services and category menus |
| Create Service / Category | `services.create` | Register new services or categories |
| Edit Service / Category | `services.edit` | Update service pricing, durations, or details |
| Delete Service / Category | `services.delete` | Soft-delete catalog items |

---

## 4. Database Models & Schema Specifications

### ServiceCategory Model (`src/models/services/serviceCategory.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `branchId`: Ref `Branch` (Optional/Scoped).
- `name`: String (Required, trimmed).
- `description`: String.
- `displayOrder`: Number (Default: 0).
- `status`: Enum (`active`, `inactive`).

### Service Model (`src/models/services/service.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `branchId`: Ref `Branch` (Required, Indexed).
- `categoryId`: Ref `ServiceCategory` (Required, Indexed).
- `name`: String (Required, trimmed).
- `serviceCode`: String (Unique per branch/org).
- `description`: String.
- `duration`: Number (In minutes, e.g. 30, 45, 60).
- `gender`: Enum (`male`, `female`, `unisex`, Default: `unisex`).
- `pricing`: `{ basePrice: Number, isTaxIncluded: Boolean }`.
- `taxConfiguration`: `{ taxRate: Number, hsnCode: String }`.
- `status`: Enum (`active`, `inactive`).
- Soft-delete plugin enabled (`isDeleted`, `deletedAt`).

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/services/categories` | `services.create` | Create category (requires `X-Branch-Id`) |
| `GET` | `/api/v1/services/categories` | `services.view` | List categories by branch |
| `GET` | `/api/v1/services/categories/:id` | `services.view` | Get category details |
| `PUT` | `/api/v1/services/categories/:id` | `services.edit` | Update category |
| `DELETE` | `/api/v1/services/categories/:id` | `services.delete` | Soft-delete category (blocked if active services exist) |
| `PATCH` | `/api/v1/services/categories/:id/reactivate` | `services.edit` | Reactivate category |
| `POST` | `/api/v1/services` | `services.create` | Create service item |
| `GET` | `/api/v1/services` | `services.view` | List services with category/gender filters |
| `GET` | `/api/v1/services/:id` | `services.view` | Get service details |
| `PUT` | `/api/v1/services/:id` | `services.edit` | Update service pricing or duration |
| `DELETE` | `/api/v1/services/:id` | `services.delete` | Soft-delete service |
| `PATCH` | `/api/v1/services/:id/reactivate` | `services.edit` | Reactivate service |

---

## 6. Testing & Verification

- **Test Files**:
  - `src/tests/services/service.test.js`
  - `src/tests/services/service.routes.test.js`
  - `src/tests/services/service.customerGender.test.js`
  - `src/tests/services/service.queryValidation.test.js`
- **Result**: ✅ 100% Passed.

