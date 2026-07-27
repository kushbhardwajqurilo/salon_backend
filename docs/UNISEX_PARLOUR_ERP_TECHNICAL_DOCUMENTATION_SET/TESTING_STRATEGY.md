# Unisex Parlour ERP — Testing Strategy

**Status:** Living technical specification  
**Parent document:** `ARCHITECTURE.md`

## 1. Purpose

Testing must verify both business correctness and security correctness.

A feature is incomplete if it works functionally but allows unauthorized data access.

## 2. Test Layers

The project uses multiple test layers.

### Unit Tests

Test isolated functions and business logic.

Examples:

- Permission helpers.
- Validation.
- Service rules.
- Utility functions.

### Integration Tests

Test multiple backend layers together.

Examples:

- Route + middleware + controller + service.
- Database scoping.
- Authorization.

### Frontend Component Tests

Test:

- Permission-based rendering.
- Branch UI.
- Loading states.
- Error states.

### End-to-End Tests

Eventually verify complete user workflows across frontend and backend.

## 3. Security Test Matrix

Every protected domain should test:

| Scenario | Expected |
|---|---|
| Valid permission | Allowed |
| Missing permission | `403` |
| Wrong organization | Denied / hidden |
| Unauthorized branch | Denied / hidden |
| Valid branch | Allowed |
| Org-wide without header | Allowed where applicable |
| `X-Branch-Id: all` | Rejected |
| Client-supplied tenant override | Ignored/rejected |
| Immutable field modification | Ignored/rejected |

## 4. Customer Reference Tests

Customer is the reference vertical.

Tests should verify:

- Organization A cannot access Organization B.
- Branch-limited user sees only visible Customers.
- Org-wide user can see organization-wide Customers without branch header.
- Org-wide user can explicitly scope to a branch.
- `"all"` header is rejected.
- Customer creation requires a specific branch.
- `organizationId` cannot be overridden.
- `homeBranchId` cannot be overridden.
- `visitedBranchIds` cannot be overridden.
- Soft-deleted Customers are excluded from normal lists.

## 5. Permission Tests

For every permission:

1. User with permission is allowed.
2. User without permission is denied.
3. Owner access comes from permissions.
4. Role name alone does not grant access.

## 6. Branch Tests

Test:

- Branch A request sends Branch A.
- Branch B request sends Branch B.
- All Branches omits header.
- `"all"` is never sent as an actual branch header.
- Non-org-wide users cannot select All Branches.
- Branch switching does not show stale data.

## 7. Cache Tests

Test that:

- Branch A data is not displayed under Branch B.
- Switching branch invalidates/refetches affected data.
- Organization changes clear user-specific caches.
- Query keys represent scope where required.

## 8. Regression Testing

After a domain is implemented:

1. Run its tests.
2. Run all backend tests.
3. Run all frontend tests.
4. Run build/type checks.
5. Verify existing domains still pass.

## 9. Definition of Done

A feature is complete when:

- Functional tests pass.
- Authorization tests pass.
- Scope isolation tests pass.
- Validation tests pass.
- Frontend tests pass where applicable.
- Build/type checks pass.
- Documentation is updated.

## 10. Test Naming

Tests should describe business behavior.

Prefer:

```text
denies a branch-limited user from viewing a customer outside active branch scope
```

over:

```text
test customer branch
```

Clear names help future engineers understand security expectations.

