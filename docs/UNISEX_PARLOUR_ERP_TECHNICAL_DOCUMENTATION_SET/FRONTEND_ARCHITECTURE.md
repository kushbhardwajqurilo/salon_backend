# Unisex Parlour ERP — Frontend Architecture Specification

**Status:** Living technical specification  
**Parent document:** `ARCHITECTURE.md`  
**Stack:** Next.js, TypeScript, Axios, React Query, Redux Toolkit, Tailwind CSS

## 1. Purpose

This document defines how frontend features should be structured and how they interact with authentication, permissions, branch context, and server state.

## 2. Responsibility Boundary

The frontend is responsible for:

- User experience.
- Rendering.
- Form interaction.
- Client-side validation.
- Permission-aware UI.
- Branch selection.
- Server-state caching.
- Local UI state.

The backend is responsible for:

- Security.
- Authorization.
- Tenant isolation.
- Branch data access.
- Business rules.
- Data integrity.

## 3. Feature Architecture

New ERP domains should be organized by business feature/domain.

A feature may contain:

```text
feature/
├── components/
├── hooks/
├── api/
├── schemas/
├── types/
└── utils/
```

Exact project folder conventions must follow the existing repository.

## 4. Server vs Client State

Use React Query for server state:

- Customers.
- Appointments.
- Services.
- Employees.
- Inventory.
- Billing data.

Use Redux Toolkit only where persistent/global client state is genuinely required.

Do not duplicate the same server state in Redux and React Query without a clear reason.

## 5. Axios

All API requests should use the centralized Axios client.

The client owns:

- Shared base URL.
- Authentication transport.
- Refresh behavior.
- Branch scope injection.
- Shared request/response behavior.

Feature code should not manually attach `X-Branch-Id`.

## 6. Branch Context

The branch context provides:

- Active branch.
- Branch list.
- Organization-wide capability.
- Branch selection.

The frontend may represent All Branches internally as `"all"`.

It must translate:

```text
"all"
→ omit X-Branch-Id
```

Never send:

```text
X-Branch-Id: all
```

## 7. Permission Checks

Use permission helpers.

Examples:

```ts
hasPermission("customers.view")
hasPermission("customers.create")
```

Do not write:

```ts
user.role === "Owner"
```

for authorization.

## 8. Navigation and UI

Permission checks can control:

- Sidebar items.
- Routes.
- Buttons.
- Menus.
- Actions.

A hidden UI element does not secure an API.

## 9. Query Keys

Branch-sensitive server data must not leak between branches.

Use the project's established branch-aware query-key convention or equivalent cache isolation.

Conceptually:

```ts
["customers", { branchScope }]
```

or an equivalent architecture where cache invalidation guarantees isolation.

The key principle is that Branch A data must never be displayed as Branch B data.

## 10. Branch Switching

When a branch changes:

1. Update active branch state.
2. Ensure future requests use the new scope.
3. Invalidate or isolate affected queries.
4. Refetch branch-sensitive data.
5. Prevent stale branch data from being displayed.

## 11. Forms

Use the project's established form and validation stack.

Client validation is for UX.

The backend remains the final validator.

## 12. Customer Frontend

Customer UI should follow:

```text
Page
 ↓
Feature Component
 ↓
Query / Mutation Hook
 ↓
API Function
 ↓
Central Axios
 ↓
Backend
```

Customer actions must be permission-aware.

Customer lists and details must respect active branch scope through centralized request behavior.

## 13. Loading and Error States

Every asynchronous feature should handle:

- Initial loading.
- Refetching.
- Empty state.
- Error state.
- Mutation pending state.
- Mutation error.
- Success feedback.

## 14. Frontend Testing

Test:

- Permission-based rendering.
- Owner behavior through returned permissions.
- Branch selection.
- All Branches behavior.
- `X-Branch-Id` omission for organization-wide scope.
- Correct branch header for specific scope.
- Cache isolation.
- Branch switching.
- API error handling.

## 15. Frontend Rules

Never:

- Add role-name authorization bypasses.
- Send `"all"` as a branch ID.
- Manually add branch headers in individual components.
- Treat Redux as the default server-state cache.
- Assume frontend permission checks replace backend authorization.
- Use stale branch data after a branch switch.

