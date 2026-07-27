# Unisex Parlour ERP — Backend Architecture Specification

**Status:** Living technical specification  
**Parent document:** `ARCHITECTURE.md`  
**Stack:** Express.js, MongoDB, Mongoose

## 1. Purpose

This document defines the backend structure and responsibilities.

## 2. Layered Architecture

The standard domain flow is:

```text
Route
  ↓
Authentication Middleware
  ↓
Authorization Middleware
  ↓
Scope / Context Validation
  ↓
Controller
  ↓
Validation
  ↓
Service
  ↓
Model / Database
```

The exact order may vary where technically necessary, but each concern must remain explicit.

## 3. Routes

Routes define:

- HTTP method.
- URL.
- Middleware.
- Controller handler.

Routes should not contain business logic.

## 4. Authentication Middleware

Authentication establishes the user identity and trusted session context.

It must not be treated as authorization.

## 5. Authorization Middleware

Authorization checks canonical permissions.

Example:

```text
authorize("customers.view")
```

Do not add role-name bypasses.

## 6. Scope Enforcement

Scope enforcement ensures:

- Organization isolation.
- Valid branch context.
- Branch visibility.

Scope is separate from permission.

A user can have permission to perform an operation but still be unable to perform it against a resource outside their scope.

## 7. Controllers

Controllers should:

- Read request context.
- Read validated input.
- Call services.
- Return standardized responses.

Controllers should not contain large business workflows.

## 8. Validation

Validation protects the API boundary.

Validate:

- Body.
- Query.
- Params.
- Relevant headers/context.

Reject immutable or forbidden fields.

## 9. Services

Services own domain business rules.

Examples:

- Customer visibility.
- Customer creation rules.
- Branch access.
- Domain-specific transitions.

Services must not trust client-provided tenant ownership.

## 10. Models

Models define:

- Persistence structure.
- Schema constraints.
- Indexes.
- Database-level behavior.

Do not put all business logic into Mongoose models.

## 11. Organization Isolation

Every organization-owned query must use the authenticated organization context.

Never trust:

```json
{
  "organizationId": "client-supplied-value"
}
```

for tenant ownership.

## 12. Branch Scoping

A request may be:

- Organization-wide.
- Explicitly branch-scoped.

The backend must reject invalid sentinel values such as:

```text
X-Branch-Id: all
```

when `"all"` is only a frontend representation.

## 13. Customer Backend Pattern

Customer routes use:

```text
customers.view
customers.create
customers.update
customers.delete
```

Customer creation requires a specific active branch.

Customer updates cannot modify:

- `organizationId`
- `homeBranchId`
- `visitedBranchIds`

Customer visibility is based on organization plus active branch semantics.

## 14. Error Handling

Errors should be normalized into a consistent API response.

Expected business/security failures should not expose stack traces or sensitive implementation details.

Unexpected errors should be logged appropriately and returned as safe generic responses.

## 15. Testing

Backend tests must cover:

### Functional
- CRUD.
- Validation.
- Business rules.

### Security
- Permission denial.
- Organization isolation.
- Branch isolation.
- Cross-organization IDs.
- Invalid branch context.
- `"all"` rejection.

## 16. New Domain Checklist

Before implementation:

- Define domain ownership.
- Define permissions.
- Define organization scope.
- Define branch scope.
- Define immutable fields.
- Define deletion semantics.
- Define API contract.

Then implement:

```text
Model
Validation
Service
Controller
Routes
Tests
```

## 17. Backend Rules

Never:

- Trust client tenant IDs.
- Use role names as permission bypasses.
- Treat `branchAccess` as active scope.
- Accept `"all"` as a real branch ID.
- Mix unrelated domain business logic.
- Skip security tests.

