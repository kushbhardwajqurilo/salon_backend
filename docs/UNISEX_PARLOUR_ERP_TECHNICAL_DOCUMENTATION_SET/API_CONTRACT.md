# Unisex Parlour ERP — API Contract Specification

**Status:** Living technical specification  
**Parent document:** `ARCHITECTURE.md`

## 1. Purpose

This document defines the contract between the Next.js frontend and Express backend.

The exact endpoint list will grow as modules are implemented. This document defines the conventions every endpoint must follow.

## 2. System Boundary

```text
Next.js Frontend
      ↓
Axios API Client
      ↓
Express API
      ↓
Middleware
      ↓
Controller
      ↓
Service
      ↓
MongoDB
```

The frontend must not bypass the API for business operations.

## 3. Authentication

Protected requests rely on the established authenticated session/token mechanism.

The frontend must use the centralized Axios client.

Do not create feature-specific authentication logic.

## 4. Branch Context

Branch-sensitive requests use:

```http
X-Branch-Id: <real-branch-id>
```

The value must be a real branch identifier.

Never send:

```http
X-Branch-Id: all
```

When an organization-wide user intentionally selects All Branches, the frontend omits the header.

## 5. Organization Isolation

The client must not be trusted to choose `organizationId`.

The backend derives organization context from the authenticated user/session.

A request attempting to access another organization's record must be rejected or return the appropriate not-found behavior.

## 6. Request Flow

A protected endpoint follows this conceptual order:

```text
Authenticate
    ↓
Authorize Permission
    ↓
Resolve Organization
    ↓
Validate Branch Context
    ↓
Validate Input
    ↓
Controller
    ↓
Service
    ↓
Database
```

Exact middleware ordering may vary when technically necessary, but security boundaries must remain enforced.

## 7. Response Envelope

The project uses a consistent response envelope.

Example:

```json
{
  "success": true,
  "status": "success",
  "message": "Session details retrieved",
  "data": {},
  "meta": null
}
```

The frontend should consume the standardized `data` field rather than relying on endpoint-specific envelope shapes.

## 8. Error Responses

Errors should use the project's standard error envelope and meaningful HTTP status codes.

Conceptually:

```json
{
  "success": false,
  "status": "error",
  "message": "Access denied",
  "data": null,
  "meta": null
}
```

Common meanings:

- `400` — Invalid request or invalid context.
- `401` — Unauthenticated.
- `403` — Authenticated but not authorized.
- `404` — Resource not found or intentionally hidden by isolation rules.
- `409` — Business conflict.
- `422` — Validation failure when the project uses this convention.
- `500` — Unexpected server error.

The backend remains responsible for the final exact status.

## 9. Validation

Validate input at the backend boundary.

Client-side validation improves UX but does not replace backend validation.

The backend must reject attempts to modify immutable scoping fields.

## 10. Pagination

List endpoints should use a consistent pagination contract when pagination is required.

A typical request may contain:

```text
?page=1&limit=20
```

The exact maximum limit and response metadata must be standardized before broad rollout.

Do not create different pagination semantics for each module.

## 11. Filtering, Sorting, and Search

Filtering and sorting must be explicitly defined per endpoint.

The backend must:

- Validate allowed fields.
- Prevent arbitrary database query operators.
- Apply organization scope automatically.
- Apply branch scope where applicable.

## 12. API Layer Responsibilities

### Frontend API functions

Responsible for:

- Calling the correct endpoint.
- Passing typed request data.
- Reading typed response data.

### Axios

Responsible for:

- Authentication/session transport.
- Central branch scoping.
- Shared interceptors.
- Shared error handling.

### Controller

Responsible for:

- Translating HTTP request to application operation.
- Reading validated context.
- Returning the HTTP response.

### Service

Responsible for:

- Business rules.
- Data access orchestration.
- Domain behavior.

## 13. Customer API Reference Pattern

Customer endpoints use canonical permissions:

- `customers.view`
- `customers.create`
- `customers.update`
- `customers.delete`

Customer creation requires a specific active branch because `homeBranchId` is derived server-side.

A client must not override:

- `organizationId`
- `homeBranchId`
- `visitedBranchIds`

## 14. API Contract Change Process

When changing an API:

1. Update backend contract.
2. Update frontend types.
3. Update API functions/hooks.
4. Update tests.
5. Verify existing consumers.
6. Document breaking changes.

Do not silently change response shape.

## 15. API Design Rules

Never:

- Trust client-provided organization ownership.
- Accept `"all"` as a real branch ID.
- Duplicate authorization rules in controllers if middleware already owns them.
- Allow feature modules to invent their own auth transport.
- Return inconsistent response envelopes without a documented reason.

