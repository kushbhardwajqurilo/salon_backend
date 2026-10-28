# Organizations & Multi-Branch Foundation — Specification & Status

```text
Module: Organizations & Multi-Branch Scoping
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Multi-Tenancy & Data Isolation Boundary
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: DATABASE_ARCHITECTURE.md, API_CONTRACT.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Organizations & Multi-Branch** module enforces physical and logical data boundaries. The organization is the root multi-tenant boundary, while branches represent physical salon outlets.

### Key Responsibilities
- Organization tenant management (`Organization` collection).
- Multi-branch registry per organization (`Branch` collection).
- Request branch resolution middleware (`requireBranchScope`, `requireOrganizationScope`, `requireActiveBranch`).
- Enforcement of `X-Branch-Id` header against the caller's allowed `branchAccess`.
- Server-side rejection of the `"all"` UI sentinel.

---

## 2. Multi-Tenancy Architecture & Scoping Modes

```text
Organization (ABC Unisex Parlour)
   ├── Branch 1: Koramangala
   ├── Branch 2: Indiranagar
   └── Branch 3: Whitefield
```

### The 3 Scoping Modes:
1. **Organization-Wide Mode**: Valid **only** when `req.user.hasOrgWideAccess === true` AND `X-Branch-Id` header is omitted. Queries return organization-wide data.
2. **Specific Branch Mode**: Valid when `X-Branch-Id` is provided, active, and exists in the user's `branchAccess` list (or user has org-wide access).
3. **Branch-Limited Mode**: For regular branch staff (`hasOrgWideAccess === false`), `X-Branch-Id` is **mandatory**. Omitting the header returns `400 Bad Request`.

> ⚠️ **Invariant**: The string `"all"` is a client-side UI sentinel. If passed as `X-Branch-Id`, the backend returns `400 Bad Request`.

---

## 3. Database Models & Schema Specifications

### Organization Model (`src/models/organizations/organization.model.js`)
- `name`: String (Required, trimmed).
- `logo`: String (URL).
- `isActive`: Boolean (Default: `true`).
- Timestamps and soft deletion enabled.

### Branch Model (`src/models/branches/branch.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `name`: String (Required, trimmed).
- `address`: String.
- `phone`: String.
- `isActive`: Boolean (Default: `true`).
- Compound Index: `{ organizationId: 1, name: 1 }` (Unique).

---

## 4. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/branches` | Authenticated | List all active branches accessible to caller |
| `GET` | `/api/v1/branches/:id` | Authenticated | Get detailed branch profile |
| `POST` | `/api/v1/branches` | `branches.manage` | Register new physical branch location |
| `PATCH` | `/api/v1/branches/:id` | `branches.manage` | Update branch address, phone, or name |
| `DELETE` | `/api/v1/branches/:id` | `branches.manage` | Soft-deactivate branch location |

---

## 5. Testing & Verification

- **Test Files**:
  - `src/tests/branches/branch.rbac.test.js`
  - `src/tests/auth/branchAuthorizationScope.integration.test.js`
  - `src/tests/security.integration.test.js`
- **Result**: ✅ 100% Passed.

