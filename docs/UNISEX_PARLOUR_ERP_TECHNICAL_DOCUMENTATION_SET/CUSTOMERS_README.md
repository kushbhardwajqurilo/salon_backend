# Customers & CRM Module — Specification & Status

```text
Module: Customers & Customer Relationship Management
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Core Operations / Customer Directory
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: API_CONTRACT.md, workflow_md/customer_workflow.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Customers** module provides client relationship management (CRM) for the parlour. It tracks customer profiles, contact records, home branch registration, visited branch history, preferences, and staff notes.

### Key Responsibilities
- Customer profile CRUD with phone deduplication per organization.
- Home branch assignment derived server-side from active branch context upon creation.
- Dynamic visited branch registration (`visitedBranchIds`) as customers visit different salon branches.
- Customer notes timeline with author attribution (`CustomerNote` collection).
- Activity and appointment timeline log integration.
- Soft-deletion with explicit restoration/reactivation.
- Inline customer creation during rapid appointment booking.

---

## 2. Multi-Tenancy & Scoping Rules

- **Organization Scoped**: Customer records are strictly isolated by `organizationId`. Phone numbers must be unique within an organization.
- **Branch Visibility Rule**:
  A customer is visible within a branch query if:
  `customer.homeBranchId.equals(activeBranchId) || customer.visitedBranchIds.includes(activeBranchId)`
  (or across all branches for users with `hasOrgWideAccess === true`).
- **Immutable Fields**: `organizationId`, `homeBranchId`, and `visitedBranchIds` cannot be arbitrarily modified via standard profile update endpoints.

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View Customer Profiles | `customers.view` | Access customer list, search, notes, and activity timeline |
| Create Customer | `customers.create` | Register new customer profile (requires active branch) |
| Edit Customer Profile | `customers.edit` | Update contact information, preferences, tags, gender |
| Delete Customer | `customers.delete` | Soft-delete customer profile |

---

## 4. Database Models & Schema Specifications

### Customer Model (`src/models/customers/customer.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `name`: String (Required, trimmed).
- `phone`: String (Required, normalized E.164 format, unique per org).
- `email`: String (Optional, lowercase).
- `gender`: Enum (`male`, `female`, `other`).
- `dateOfBirth`: Date.
- `anniversaryDate`: Date.
- `homeBranchId`: Ref `Branch` (Required, immutable).
- `visitedBranchIds`: Array of Refs to `Branch` (Default: `[]`).
- `loyaltyPoints`: Number (Default: 0).
- `tags`: Array of Strings (e.g. `VIP`, `Regular`, `High Spender`).
- `notes`: Array of subdocuments or virtual reference.
- `status`: Enum (`active`, `inactive`, `blocked`).
- Soft-delete plugin enabled (`isDeleted`, `deletedAt`).

### CustomerNote Model (`src/models/customers/customerNote.model.js`)
- `organizationId`: Ref `Organization` (Required).
- `customerId`: Ref `Customer` (Required, Indexed).
- `branchId`: Ref `Branch` (Required).
- `authorId`: Ref `User` (Required).
- `content`: String (Required).

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/customers` | `customers.create` | Create customer (requires `X-Branch-Id`) |
| `GET` | `/api/v1/customers` | `customers.view` | Paginated customer list with filters (name, phone, branch) |
| `GET` | `/api/v1/customers/:id` | `customers.view` | Get customer profile details |
| `PUT` | `/api/v1/customers/:id` | `customers.edit` | Update customer details |
| `DELETE` | `/api/v1/customers/:id` | `customers.delete` | Soft-delete customer profile |
| `PUT` | `/api/v1/customers/:id/reactivate` | `customers.edit` | Reactivate soft-deleted customer |
| `GET` | `/api/v1/customers/:id/notes` | `customers.view` | List notes attached to customer |
| `POST` | `/api/v1/customers/:id/notes` | `customers.edit` | Add note to customer |
| `GET` | `/api/v1/customers/:id/activity` | `customers.view` | View audit and appointment history timeline |

---

## 6. Testing & Verification

- **Test Files**:
  - `src/tests/customers/customer.service.test.js`
  - `src/tests/customers/customer.integration.test.js`
  - `src/tests/customers/customer.filters.test.js`
  - `src/tests/customers/customer.upgrade.test.js`
  - `src/tests/customers/inlineCustomerCreation.integration.test.js`
- **Result**: ✅ 100% Passed.

