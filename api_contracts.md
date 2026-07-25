# Backend API Contracts

This document specifies the finalized API contracts, scoping, security rules, and response shapes for the parlour ERP backend.

---

## 1. Authentication & Session Details

### GET `/api/v1/auth/me`
Returns details of the currently authenticated user session.
*   **Authentication**: Required (JWT Bearer Token in `Authorization` header or cookie).
*   **Authorization**: Any active authenticated user.
*   **Response Shape (200 OK)**:
    ```json
    {
      "success": true,
      "message": "Session details retrieved",
      "data": {
        "id": "64abc...",
        "name": "John Doe",
        "email": "owner@parlour.com",
        "phone": "+91 9999999999",
        "role": "Owner",
        "permissions": [
          "customers.view",
          "customers.create",
          "customers.edit",
          "customers.delete"
        ],
        "organizationId": "64def...",
        "hasOrgWideAccess": true,
        "branchAccess": [
          {
            "branchId": "64ghi...",
            "branchName": "Koramangala",
            "isActive": true
          }
        ]
      }
    }
    ```
*   **Rules**:
    *   `hasOrgWideAccess` is retrieved directly from the user's database record (never inferred from role names).
    *   `branchAccess` is pre-populated. If `hasOrgWideAccess` is `true`, it is automatically populated with all branches in the organization. If `hasOrgWideAccess` is `false`, it returns only active branches the user is explicitly assigned to.

---

## 2. Customer Scoping & Hardening

### POST `/api/v1/customers`
Creates a new customer profile.
*   **Authentication**: Required.
*   **Authorization**: Permission `customer:create`.
*   **Headers**: `X-Branch-Id` (Required, must be an active branch within the user's organization).
*   **Request Body**:
    ```json
    {
      "name": "Jane Customer",
      "phone": "+91 9876543210",
      "email": "jane@customer.com",
      "branchId": "64ghi..." // Optional. If provided, must match X-Branch-Id header exactly
    }
    ```
*   **Rules**:
    *   The backend validates `X-Branch-Id` against the user's branch access (or bypasses if `hasOrgWideAccess = true`).
    *   If `branchId` is provided in the body, it must exactly match `X-Branch-Id`. If not, returns `400 Bad Request`.
    *   If omitted from the body, it is derived server-side from `X-Branch-Id`.

### GET `/api/v1/customers`
Retrieves a paginated list of customers.
*   **Authentication**: Required.
*   **Authorization**: Permission `customer:view`.
*   **Headers**: `X-Branch-Id` (Optional if `hasOrgWideAccess = true`, otherwise Required).
*   **Query Parameters**:
    *   `page`: (default 1)
    *   `limit`: (default 10)
    *   `search`: Optional search term (name/phone/email match)
    *   `branchId`: Optional. If provided, must match `X-Branch-Id` header (if header is provided).
*   **Rules**:
    *   `X-Branch-Id` header strictly controls the branch scope.
    *   If the user has `hasOrgWideAccess = true` and `X-Branch-Id` is omitted, the API operates in **organization scope**, returning customers across all branches in the organization.
    *   If `X-Branch-Id` is omitted and the user does NOT have `hasOrgWideAccess = true`, returns `400 Bad Request`.
    *   If `branchId` is passed in query parameters but does not match `X-Branch-Id` (when `X-Branch-Id` is set), returns `400 Bad Request`.
    *   If `branchId` is passed in query parameters, `X-Branch-Id` is omitted, but the user lacks organization-wide access, returns `403 Forbidden`.

### GET `/api/v1/customers/:id`
Retrieves details of a single customer.
*   **Authentication**: Required.
*   **Authorization**: Permission `customer:view`.
*   **Scoping**: Organization-scoped.
*   **Rules**: Enforces `organizationId` matching from user context.

### PUT `/api/v1/customers/:id`
Updates customer details.
*   **Authentication**: Required.
*   **Authorization**: Permission `customer:update`.
*   **Scoping**: Organization-scoped.
*   **Rules**:
    *   Enforces `organizationId` matching from user context.
    *   If `branchId` is provided in the request body (requesting branch reassignment), the backend validates:
        1. Target branch belongs to the user's organization.
        2. Target branch is active.
        3. Authenticated user has access to that target branch (either via `hasOrgWideAccess = true` or target branch is in their `branchAccess` list).
    *   Fails with `404 Not Found` if branch does not exist/is inactive, or `403 Forbidden` if the user is unauthorized for the target branch.

---

## 3. Branches

### POST `/api/v1/branches`
Creates a new branch.
*   **Authentication**: Required.
*   **Authorization**: Permission `branches.manage`.
*   **Response Status**: `201 Created`

---

## 4. Role & RBAC Management

### POST `/api/v1/rbac/roles`
Creates a new role.
*   **Authentication**: Required.
*   **Authorization**: Permission `roles.manage`.
*   **Response Status**: `201 Created`

---

## 5. Architectural Decisions & Status

| Decision / Feature | Scope | Status | Notes |
| :--- | :--- | :--- | :--- |
| **All RBAC Routes Protection** | Global | **FINALIZED** | Protected strictly with authentication and `roles.manage` permission. |
| **Customer listing scope** | Hybrid | **FINALIZED** | Branch-scoped unless user has `hasOrgWideAccess = true` and omits `X-Branch-Id` header. |
| **Cross-Branch Customer Update** | Tenant-scoped | **FINALIZED** | Supported under organization scope, but target `branchId` reassignment requires explicit authorization checks. |
| **ERP Modules Implementation** | Feature | **PENDING** | Deferred per instructions. No new modules implemented in this sprint. |
