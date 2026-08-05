# Module Architecture Standard

```
Status: Canonical
Reference Modules: Customer, Services
Scope: All future ERP modules
Module Architecture Standard Version: 1.1
Last Updated: 2026-08-05
```

---

## Table of Contents

1. [Document Purpose](#1-document-purpose)
2. [Source of Truth Hierarchy](#2-source-of-truth-hierarchy)
3. [Architecture Principles](#3-architecture-principles)
4. [Canonical Module Structure](#4-canonical-module-structure)
5. [API Layer Standard](#5-api-layer-standard)
6. [TypeScript Types Standard](#6-typescript-types-standard)
7. [Validation Standard](#7-validation-standard)
8. [React Query / Server State Standard](#8-react-query--server-state-standard)
9. [Branch Scoping Standard](#9-branch-scoping-standard)
10. [RBAC / Permission Standard](#10-rbac--permission-standard)
11. [Table / List Architecture](#11-table--list-architecture)
12. [Pagination Standard](#12-pagination-standard)
13. [Entity Profile / Detail Page Standard](#13-entity-profile--detail-page-standard)
14. [CRUD Standard](#14-crud-standard)
15. [Lifecycle / Status Standard](#15-lifecycle--status-standard)
16. [Reusable Shared Components](#16-reusable-shared-components)
17. [Hooks Standard](#17-hooks-standard)
18. [Form Architecture](#18-form-architecture)
19. [UI/UX Standard](#19-uiux-standard)
20. [Naming Conventions](#20-naming-conventions)
21. [Backend Architecture Standard](#21-backend-architecture-standard)
22. [Data Model Standard](#22-data-model-standard)
23. [Audit / History / Notes Standard](#23-audit--history--notes-standard)
24. [Error Handling Standard](#24-error-handling-standard)
25. [Security Standard](#25-security-standard)
26. [Performance Standard](#26-performance-standard)
27. [Testing Standard](#27-testing-standard)
28. [Production Readiness Checklist](#28-production-readiness-checklist)
29. [New Module Implementation Workflow](#29-new-module-implementation-workflow)
30. [Architecture Audit Checklist](#30-architecture-audit-checklist)
31. [When the Standard Does Not Apply](#31-when-the-standard-does-not-apply)
32. [AI Coding Agent Instructions](#32-ai-coding-agent-instructions)
33. [Decision Log](#33-decision-log)
34. [Customer + Services Reference Matrix](#34-customer--services-reference-matrix)

---

## 1. Document Purpose

This standard exists to define, formalize, and enforce the architecture, conventions, patterns, and quality gates that future modules in the Unisex Parlour ERP application must follow. By adhering to this reference, developers and AI coding agents ensure the codebase remains highly consistent, secure, performant, and maintainable.

### Standard Classifications

To ensure clarity, every rule in this standard is categorized into one of four classifications:

#### [ARCHITECTURAL INVARIANT]
A non-negotiable rule that directly affects system security, data isolation, correctness, or fundamental architecture. Breaking an Architectural Invariant requires explicit approval from the lead architect and a documented justification.

#### [CANONICAL PATTERN]
The preferred implementation pattern established in the codebase. Future modules should default to these patterns to maintain structural and code-level consistency across the application.

#### [RECOMMENDED PRACTICE]
A strong architectural suggestion that represents a clean, maintainable approach. It can be adapted or modified based on domain complexity or specific context.

#### [EXAMPLE]
Illustrative code or conceptual description intended to demonstrate how a rule is applied. Examples must not be interpreted as mandatory API contracts.

---

## 2. Source of Truth Hierarchy

When resolving conflicts between different specifications, implementations, or documentation, the following hierarchy of authority **MUST** be enforced:

```
1. Security/Backend Runtime Contract (Authoritative for endpoints and API parameters)
2. Approved Architectural Invariants (This document)
3. Existing Shared Infrastructure (Axios client, global context, shared ui/layout components)
4. Module Architecture Standard (General documentation rules)
5. Canonical Reference Modules (Customer and Services implementations)
6. Implementation Examples (Illustrative code snippets)
7. Developer or AI Agent Assumptions
```

### [ARCHITECTURAL INVARIANT] - Documentation Conflict Handling
If two sources of truth conflict (e.g., this documentation specifies an endpoint or behavior that the backend API does not actually support, or if two modules show divergent patterns for a shared concern), the developer or AI agent **MUST STOP** and report the discrepancy rather than guessing or silently choosing an interpretation. When documentation conflicts with actual implementation, stop and report rather than guessing.

---

## 3. Architecture Principles

### Separation of Concerns
* **[ARCHITECTURAL INVARIANT]** - Every layer must fulfill a single responsibility. Business logic must not live in UI components. API communication must live in the API service files, and server state synchronization must be managed by custom React Query hooks.

### Feature-Based Architecture
* **[ARCHITECTURAL INVARIANT]** - Domain implementation code must live under `src/features/<module>/`. Application-level routing, navigation, global state providers, permission registries, and other established application-wide infrastructure remain in their existing application-level locations (e.g., `src/app/`, `src/components/layout/`, `src/store/`).

### Reusability and Duplication
* **[ARCHITECTURAL INVARIANT]** - Existing shared infrastructure (utilities, query key builders, mutations, global contexts, form error mapping, formatters) and components (DataTable, Pagination, EntityActionMenu, dialogs) **MUST** be reused. Developers **MUST NOT** duplicate shared logic locally within a module.

### Type Safety
* **[ARCHITECTURAL INVARIANT]** - All API payloads, responses, forms, and entities must have explicit TypeScript types. The use of `any` for domain or API data is strictly prohibited.

---

## 4. Canonical Module Structure

### [CANONICAL PATTERN] - Feature Directory Structure
A standard ERP domain module is structured as follows:

```
src/features/<module>/
├── api/                    # API service functions
│   └── <entity>.api.ts
├── types/                  # TypeScript domain type definitions
│   ├── <entity>.types.ts
│   └── filters.types.ts    # [RECOMMENDED PRACTICE] Filter type definitions
├── schemas/                # Zod validation schemas
│   └── <entity>.schema.ts
├── hooks/                  # React Query query and mutation hooks
│   ├── use<Entity>.ts
│   ├── use<Entities>.ts
│   ├── useCreate<Entity>.ts
│   ├── useUpdate<Entity>.ts
│   ├── useDelete<Entity>.ts
│   └── useReactivate<Entity>.ts
├── components/             # React components
│   ├── <Entity>List.tsx
│   ├── <Entity>Form.tsx
│   ├── <Entity>Filters.tsx
│   ├── <Entity>Search.tsx
│   ├── <Entity>MobileCard.tsx
│   └── ...
├── columns/                # TanStack Table column definitions
│   └── <entity>Columns.tsx
└── config/                 # Feature configuration (routes, permissions, defaults)
    └── <module>.config.ts
```

### [RECOMMENDED PRACTICE] - Multi-Entity Sub-Organization
When a module implements multiple related sub-entities (e.g., `Services` and `ServiceCategories` inside the `services` module), sub-organize the `components/` and `hooks/` directories:

```
src/features/services/
├── hooks/
│   ├── services/
│   │   └── useServices.ts
│   └── categories/
│       └── useServiceCategories.ts
├── components/
│   ├── common/             # Primary pages and cross-entity views
│   ├── services/           # Service-specific components
│   └── service-categories/ # Category-specific components
```

---

## 5. API Layer Standard

### [ARCHITECTURAL INVARIANT] - API Layer Boundaries
The API layer acts as the gatekeeper for network request formatting.
* Feature API code must use the central `apiClient` imported from `@/lib/api/axios`.
* Feature API functions must accept and return strictly typed payloads and response shapes.
* Feature API functions must not contain UI interactions, toast notifications, or global state dispatches.

### [ARCHITECTURAL INVARIANT] - List Response Envelope
* Standard paginated domain list endpoints **MUST** conform to the `PaginatedResponse<T>` interface defined in `@/types/api.types.ts`.
* Small lookup/reference responses or domain-specific non-paginated collections **MAY** use another response shape (such as a simple `ApiResponse<T[]>`) when justified by the verified backend contract. Wording must not allow developers to avoid pagination arbitrarily when paginated access is standard for the entity size.

### [ARCHITECTURAL INVARIANT] - Type-Safe ID Normalization
The backend database uses Mongoose ObjectIds (`_id`). The frontend codebase expects a clean `id` string. Normalization **MUST** be performed at the API layer, and it **MUST** preserve the actual source type.
* Developers **MUST NOT** use `any`, `as any`, `as unknown as T`, or arbitrary type assertions merely to force incompatible backend data into a frontend type.
* Normalization must use explicit, type-safe mapping functions or constrained interfaces that verify both types at compile-time.

```typescript
// [EXAMPLE] Type-Safe ID Mapping
export interface MongoCustomer {
  _id: string;
  name: string;
  phone: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
}

export function normalizeCustomer(dbCustomer: MongoCustomer): Customer {
  return {
    id: dbCustomer._id,
    name: dbCustomer.name,
    phone: dbCustomer.phone,
  };
}
```

---

## 6. TypeScript Types Standard

### [CANONICAL PATTERN] - Type Locations
* Pure domain types and entity models live in `src/features/<module>/types/<entity>.types.ts`.
* Complex list filters and search param types live in `src/features/<module>/types/filters.types.ts`.
* Shared API wrappers and application-wide models live in `src/types/`.

### [ARCHITECTURAL INVARIANT] - TypeScript Safety
* **No `any` allowed:** Developers must not use `any` or `as any` to bypass compile-time checks.
* **Narrow types:** Use exact union types instead of broad types when values are finite (e.g. `type Status = "active" | "inactive" | "blocked"`).
* **Optional vs. Nullable:** Be explicit about whether a field is optional (`field?: string`) or nullable (`field: string | null`), matching the database model constraints.

---

## 7. Validation Standard

### [CANONICAL PATTERN] - Schema Validation
* Every data-entry form **MUST** define a companion Zod validation schema in `src/features/<module>/schemas/<entity>.schema.ts`.
* Forms must use `@hookform/resolvers/zod` to bind Zod schemas to React Hook Form.
* Form values types should be derived using `z.infer<typeof schema>`.

### [ARCHITECTURAL INVARIANT] - Error Mapping
Feature code **MUST** use the centralized `mapBackendValidationErrors` and `getErrorMessage` utilities from `@/lib/api/errors` to handle API validation failures. Locally reinventing error mapping is prohibited.

---

## 8. React Query / Server State Standard

### [ARCHITECTURAL INVARIANT] - Cache Identity and Scoping
Query keys determine the identity of cached server state. To prevent data leakage and incorrect views, every server-state input that affects the returned dataset **MUST** be represented in the query key.

Query keys MUST include:
1. Domain entity identity
2. Applicable scope identity:
   - branch scope for branch-scoped data
   - organization scope for organization-wide data
3. All query-affecting inputs such as filters, search, pagination, sorting, and page size.

```typescript
// [EXAMPLE] Query key with pagination and search parameters
const queryKey = getBranchQueryKey("customers", [filters]);
```

### [ARCHITECTURAL INVARIANT] - Cache Separation
* Branch-scoped queries **MUST** use the centralized branch-aware query-key helper.
* Organization-wide queries **MUST** use an appropriate organization-scoped key and **MUST NOT** include a branch identity that does not affect the dataset. Developers **MUST NOT** use static query keys (e.g., `["customers"]`) for branch-scoped data. All branch-scoped queries must obtain their key via the `getBranchQueryKey` callback to ensure cache separation between branch views.

### [ARCHITECTURAL INVARIANT] - Mutation Cache Invalidation
After a successful mutation (create, update, status change, deactivation, reactivation), all affected queries **MUST** be invalidated so the UI cannot display stale data.
* The hook or calling component **MUST** trigger invalidations for the affected list queries (e.g., the key returned by `getBranchQueryKey("customers")`).
* The hook or calling component **MUST** trigger invalidations for the specific entity-detail query (e.g., `getBranchQueryKey("customer", [id])`).
* The hook **MUST** invalidate related queries (e.g., notes, audit logs) if the mutation modifies data displayed in those queries.
* The invalidation keys must be passed explicitly to `useEntityMutation` via the `invalidateKeys` configuration parameter, or executed inside the mutation's `onSuccess` callback.

```typescript
// [EXAMPLE] Custom update hook using explicit onSuccess invalidations
export function useUpdateCustomer() {
  const queryClient = useQueryClient();
  const { getBranchQueryKey } = useBranchContext();

  return useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: CustomerPayload }) => updateCustomer(id, payload),
    onSuccess: (data) => {
      // Refresh list queries
      queryClient.invalidateQueries({ queryKey: getBranchQueryKey("customers") });
      // Refresh specific details query
      queryClient.invalidateQueries({ queryKey: getBranchQueryKey("customer", [data.id]) });
    },
  });
}
```

---

## 9. Branch Scoping Standard

### [ARCHITECTURAL INVARIANT] - Scoping Configuration
* Before implementing a module, developers **MUST** determine the effective data scope of each operation according to the verified backend contract.
* **Not every module operation is branch-scoped.**
* **Branch-scoped operations:** The API request config must include `branchScope: "current"`. The Axios interceptor automatically appends the correct `X-Branch-Id` header based on active state. Only branch-scoped operations use `branchScope: "current"`.
* **Organization-wide operations:** The request config must omit or configure `branchScope` such that no `X-Branch-Id` header is sent.
* **Sentinel Rejection:** Modules **MUST NOT** manually read branch ID from arbitrary locations, construct headers manually, or send `X-Branch-Id: "all"`.

---

## 10. RBAC / Permission Standard

### [ARCHITECTURAL INVARIANT] - Permission Rules
* **No Role Bypasses:** Role names (e.g., `"Owner"`, `"Admin"`, `"Superadmin"`) must never be used in frontend code to bypass permission checks. Permission checks must look up specific permission keys.
* **UX Gating Only:** Frontend checks (`hasPermission`, `PermissionGate`) are for visual styling and UX guidance. They do not substitute for backend authorization, which must independently secure every API endpoint.
* **Permissions Naming:** Permissions follow the `domain.action` or `domain.resource.action` syntax.
* **Lifecycle Permissions:**
  * Lifecycle actions **MUST** use explicit permission checks.
  * For modules following the canonical CRUD permission model:
    * Deactivation: Requires the `<module>.delete` permission.
    * Reactivation: Requires the `<module>.update` permission.
  * If the verified backend contract defines dedicated lifecycle permissions (e.g. status-specific permissions), the module **MUST** check those backend-defined permissions.

---

## 11. Table / List Architecture

### [CANONICAL PATTERN] - List Rendering
* List views displaying tabular data **MUST** use the shared `DataTable` component when pagination and columns apply.
* Standard lists **MUST** support paginated queries, search inputs, and filters.
* All lists **MUST** provide a matching card-based mobile view via the `renderMobileRow` prop of `DataTable`.

### [RECOMMENDED PRACTICE] - Action Menus
* **[RECOMMENDED PRACTICE]** - CRUD-oriented entities should use the shared `EntityActionMenu` for list row actions when the standard action model (View, Edit, Deactivate, Reactivate) applies.
* **[ARCHITECTURAL INVARIANT]** - Existing shared action-menu functionality must not be duplicated locally when it is applicable. Domain-specific workflows (e.g. analytical reporting, simple settings lists) **MAY** use a different action set when justified.

---

## 12. Pagination Standard

### [ARCHITECTURAL INVARIANT] - Server-Side Pagination
* All ERP modules displaying potentially large datasets **MUST** implement server-side pagination. Client-side pagination of large datasets is strictly prohibited.
* Pagination controls must use the shared `Pagination` component from `@/components/ui/pagination.tsx`.
* Default page sizes and limits must be defined in the feature config file and passed consistently to queries.

---

## 13. Entity Profile / Detail Page Standard

### [RECOMMENDED PRACTICE] - Profile Navigation Layout
* **[RECOMMENDED PRACTICE]** - Profile-oriented entities (e.g., Customer, Staff, Branch details) should use `EntityProfileLayout` to compose tabbed detail views.
* **[ARCHITECTURAL INVARIANT]** - Feature modules must reuse existing shared layout primitives when applicable. Domain-specific detail pages (e.g. transactional invoices, reporting widgets, logs) **MAY** use a different layout when the domain interaction model genuinely requires it.

---

## 14. CRUD Standard

### [CANONICAL PATTERN] - Mutation Scoping
* Every mutation hook must invalidate the related list cache.
* Creation mutations **MUST** verify that a specific branch is selected (`currentBranchId !== null`) and must throw an error if the user is in "All Branches" scope, unless the backend contract explicitly permits organization-wide creation.
* Detail routing page files (`page.tsx`) must resolve param promises asynchronously and hand the identifiers to client feature components.

---

## 15. Lifecycle / Status Standard

### [ARCHITECTURAL INVARIANT] - Single Lifecycle Field
A domain entity **MUST NOT** define multiple competing status or state fields. Each module must standardize on exactly one lifecycle representation:
* Use `status: "active" | "inactive" | "blocked"` for entities with multi-state lifecycles.
* Use `isActive: boolean` for simpler entities.
Casually combining `isActive`, `status`, `enabled`, and `disabled` within the same entity schema is forbidden.

### [ARCHITECTURAL INVARIANT] - HTTP Method Authority
This standard defines *architectural behavior* (Deactivate vs. Reactivate), not arbitrary HTTP verbs. The frontend codebase **MUST** follow the backend API contract. If the backend defines `DELETE /entities/:id` for deactivation, the frontend must call that method; if the backend defines `PATCH /entities/:id/status`, the frontend must call that method. The frontend must never invent endpoints or HTTP verbs that differ from the backend runtime contract.

---

## 16. Reusable Shared Components

Future modules **MUST** reuse the following existing shared components rather than reimplementing them locally:

| Category | Component Path | Purpose |
|---|---|---|
| **Entity Actions** | `@/components/entity/EntityActionMenu.tsx` | View, Edit, Deactivate, Reactivate action buttons |
| **Entity Actions** | `@/components/entity/DeactivateDialog.tsx` | Soft-delete/deactivate confirmation modal |
| **Entity Actions** | `@/components/entity/ReactivateDialog.tsx` | Profile restoration confirmation modal |
| **Entity Layout** | `@/components/entity/EntityProfileLayout.tsx` | Tabbed navigation and content layout |
| **Common UI** | `@/components/ui/data-table/DataTable.tsx` | Table rendering with skeleton loading and mobile responsive slots |
| **Common UI** | `@/components/ui/pagination.tsx` | Pagination bar with size select dropdown |
| **Common UI** | `@/components/ui/empty-state.tsx` | Dashboard/list zero-data message view |
| **Common UI** | `@/components/ui/error-state.tsx` | Component loading failure warning with retry action |
| **Global Layout** | `@/components/layout/PermissionGate.tsx` | Role-agnostic permission checking wrapper |
| **Global Layout** | `@/components/layout/Unauthorized.tsx` | Access denied page view |

---

## 17. Hooks Standard

### [CANONICAL PATTERN] - Hook Responsibilities
Custom hooks decouple components from state management:
* **Query Hooks:** Encapsulate auth checks, permission checks, active branch scoping, and pass parameters to query functions.
* **Mutation Hooks:** Encapsulate loading state triggers, mutation functions, and query cache invalidations.
* **Hooks must not:** Access router navigation directly, dispatch toast notifications, or manage local modal overlays.

---

## 18. Form Architecture

### [CANONICAL PATTERN] - Form Lifecycle
The standard form lifecycle flows as follows:
```
React Hook Form (useForm)
  ↓
Zod Validation Resolver
  ↓
Component Submit Handler
  ↓
Mutation Hook (.mutate)
  ↓
API Service Call
  ↓
Backend Validation
  ↓
Success: Invalidate cache + Close modal + Toast success
Error: Map backend validation errors (mapBackendValidationErrors) + Toast error
```

---

## 19. UI/UX Standard

### [ARCHITECTURAL INVARIANT] - UI States
Every data-driven page **MUST** provide:
1. **Loading State:** Skeletons or loading indicators (e.g., DataTable built-in loading skeletons).
2. **Empty State:** Clear explanations when no records match (using `EmptyState`).
3. **Error State:** Human-readable explanations of failures with a retry option (using `ErrorState`).
4. **Destructive confirmations:** Modals confirming deactivation or cancellation.

---

## 20. Naming Conventions

### [CANONICAL PATTERN] - File and Folder Naming
Modules **MUST** follow these exact casing and suffix rules:

| File Type | Casing | Suffix | Example |
|---|---|---|---|
| **Feature Folder** | Lowercase | Plural | `customers`, `services` |
| **API File** | lowercase | `.api.ts` | `customers.api.ts` |
| **Type File** | lowercase | `.types.ts` | `customer.types.ts` |
| **Schema File** | lowercase | `.schema.ts` | `customer.schema.ts` |
| **Column File** | camelCase | `Columns.tsx` | `customerColumns.tsx` |
| **Config File** | lowercase | `.config.ts` | `customers.config.ts` |
| **Component File** | PascalCase | None | `CustomerForm.tsx` |
| **Hook File** | camelCase | None | `useCustomers.ts` |

---

## 21. Backend Architecture Standard

### [RECOMMENDED PRACTICE] - Backend Layers
For modules requiring new backend endpoints, the backend code should follow the standard layered structure:
```
Route (Express)
  ↓
Authentication & Authorization Middleware
  ↓
Validation Middleware (Zod/Joi)
  ↓
Controller (Request/Response mapping)
  ↓
Service (Business logic)
  ↓
Repository (Database access)
  ↓
Model (Mongoose schema)
```
Controllers should remain thin, delegating all domain logic to the Service layer.

---

## 22. Data Model Standard

### [ARCHITECTURAL INVARIANT] - Domain-Dependent Fields
There is no universal field list that every database document must contain. Entity schemas must be designed based on their structural requirements:
* **Organization-owned entity:** Must contain `organizationId` for tenant isolation when applicable.
* **Branch-owned entity:** Must contain `branchId` when data belongs specifically to one branch.
* **Customer entity (DOMAIN-SPECIFIC / CUSTOMER REFERENCE PATTERN):** Uses `homeBranchId` and `visitedBranchIds` when the Customer domain requires a canonical home branch or branch visit tracking.
* **Customer preferences (DOMAIN-SPECIFIC / CUSTOMER REFERENCE PATTERN):** Fields such as `preferredStaff` and `preferredServices` are specific to the Customer profile requirements and must not be treated as universal fields for other domains.
* **Profile-oriented entities:** Must use the branch ownership/association model defined by their verified backend contract.
* **Lifecycle-managed entity:** Must contain `status` or `isActive` when applicable.
* **Auditable entity:** Must contain `createdAt` and `updatedAt` timestamps when applicable.

---

## 23. Audit / History / Notes Standard

### [RECOMMENDED PRACTICE] - Audit Isolation
* Unbounded user-generated notes or comments **SHOULD** live in a separate sub-collection and be queried through paginated routes (as demonstrated by `CustomerNotes` — DOMAIN-SPECIFIC / CUSTOMER REFERENCE PATTERN).
* Automatically generated audit trails or history logs **SHOULD** be stored in an immutable, read-only collection and queried separately (as demonstrated by `CustomerActivity` / audit logs — DOMAIN-SPECIFIC / CUSTOMER REFERENCE PATTERN).
* Small, bounded, static metadata (e.g. preferences, address, settings) should remain inline inside the parent document.

---

## 24. Error Handling Standard

### [ARCHITECTURAL INVARIANT] - Error Normalization
* Feature API calls and hooks must normalize raw HTTP errors.
* Internal database schemas, server stack traces, or technical system errors **MUST NOT** be exposed to frontend users.
* Field-level validation failures must be mapped inline to inputs, while request-level errors should be displayed as toast alerts.

---

## 25. Security Standard

### [ARCHITECTURAL INVARIANT] - Security Boundary Checks
* Frontend permission gating exists only for visual convenience. The backend **MUST** authorize every incoming request independently.
* Tenant isolation (`organizationId`) must be derived backend-side from the verified session token; backend code must never trust client-provided tenant identifiers.
* Branch boundary checks must verify that the user's token has active access permissions for the target branch ID.
* **Organization Scope vs. Branch Scope:**
  ```text
  Authentication       → Who is the user?
  Organization Scope   → Which tenant's data?
  Branch Scope         → Which branch's data/view?
  Permission           → What may the user do?
  ```
  Organization scope is independent of branch scope. Branch isolation must never be used as a substitute for organization isolation.

---

## 26. Performance Standard

### [RECOMMENDED PRACTICE] - Performance Expectations
* **Caching:** Leverage React Query caching to prevent redundant API queries. Default `staleTime` and refetch options should align with global configuration.
* **Lazy Loading:** Dynamically import heavier dialogs, charts, or tabs that are not required for the initial render.
* **Avoid unnecessary refetches:** Ensure query key parameters are stable to prevent accidental query trigger loops.
* **Memoization:** Do not prematurely optimize simple components. Use React's `useMemo` or `useCallback` only when performing expensive computations or preventing redundant renders of complex child components.

---

## 27. Testing Standard

### Required Verification
Before submitting a module, developers or AI agents **MUST** verify:
* **Typecheck:** The build environment compile must succeed without type assertions or unsafe casts.
* **Build:** The production bundle compilation must pass cleanly.
* **Validation:** Zod schemas must successfully reject invalid formats and empty inputs.
* **Security:** Organization and branch isolation boundaries must hold under simulated cross-tenant requests.

### Recommended Automated Tests
New modules **SHOULD** implement automated test coverage under `src/features/<module>/__tests__/` verifying:
* Zod form validation rules.
* Branch-aware query key separation.
* Permission rendering behaviors.
* Action menu callback triggers.

---

## 28. Production Readiness Checklist

### Architecture
- [ ] Code is under `src/features/<module>/`
- [ ] Sub-entities are organized cleanly
- [ ] No duplicated shared abstractions or utility logic
- [ ] Typecheck compilation completes with zero errors

### Scope & Isolation
- [ ] Tenant boundaries are validated backend-side
- [ ] Branch-scoped API calls include `branchScope: "current"`
- [ ] Query keys represent all query-changing inputs (search, filters, pagination)
- [ ] All Branches views omit the branch ID header

### UI/UX States
- [ ] Skeletons display during initial load
- [ ] Empty state renders when zero records exist
- [ ] Error boundary provides clear description and a retry button
- [ ] Deactivation/reactivation triggers standard confirmation modals

---

## 29. New Module Implementation Workflow

```
1. Verify backend API contract and check permissions
        ↓
2. Establish domain configuration (routes, permissions, defaults)
        ↓
3. Define TypeScript types and Zod schemas
        ↓
4. Implement API service layer using apiClient
        ↓
5. Implement React Query hooks with branch-aware keys
        ↓
6. Compose table columns and actions
        ↓
7. Build list, form, and detail components
        ↓
8. Write automated unit and UI tests
        ↓
9. Execute production readiness audit
```

---

## 30. Architecture Audit Checklist

This audit compares new feature code against approved invariants:

```text
□ Is domain code located entirely under its feature folder?
□ Does it reuse DataTable, Pagination, and EntityActionMenu?
□ Are query keys branch-scoped via useBranchContext?
□ Does it avoid manual construction of X-Branch-Id?
□ Are all server-affecting params included in the query key?
□ Does it normalize database IDs to id strings type-safely?
□ Is the use of any completely avoided?
□ Are HTTP methods and routes aligned with the backend contract?
□ Is there exactly one lifecycle field (status or isActive)?
□ Are lifecycle actions protected by explicit permissions defined by the verified backend permission contract?
□ If the module uses the canonical CRUD permission model, are deactivate/reactivate mapped to delete/update respectively?
```

### [ARCHITECTURAL INVARIANT] - Common Architectural Drift
AI coding agents and developers **MUST NOT** commit the following architectural violations:
1. Hardcoding branch ID scoping or inventing custom header injection.
2. Storing server state in global Redux stores.
3. Suppressing TypeScript compiler errors using `any` or comments.
4. Bypassing shared UI primitives (e.g. creating custom pagination or custom table elements).
5. Checking role names directly for action authorization.

---

## 31. When the Standard Does Not Apply

This standard is designed for standard transactional and master data ERP modules (Customers, Services, Employees, Inventory). The standard **MAY** require controlled deviation for:
* **Interactive Dashboards:** Where data is consolidated and layout grids replace forms.
* **Transactional workflows:** E.g. appointment booking flows which use multi-step wizard forms.
* **Real-time interfaces:** Where WebSockets or streaming updates are utilized.
* **Reporting engines:** Where massive, read-only analytical aggregations occur.

### Deviation Protocol
When a developer or AI agent encounters a module that requires deviation:
1. Document the specific standard rules that do not fit.
2. Outline the proposed replacement pattern.
3. Verify which general standards (Tenant isolation, Type safety, central Axios client) remain applicable.
4. Obtain architectural approval before writing code.

---

## 32. AI Coding Agent Instructions

AI coding agents working on future modules **MUST** adhere to these strict instructions:

1. **Verify first:** Inspect `MODULE_ARCHITECTURE_STANDARD.md` before coding.
2. **Review references:** Inspect Customer and Services feature folders to understand the visual and layout style of the application.
3. **Verify API contract:** Check the backend router code before writing frontend network requests.
4. **Never guess:** If a specification is missing or a conflict arises, stop and request clarification.
5. **No custom scoping:** Determine operation scope from the verified backend contract. Use `branchScope: "current"` only for branch-scoped operations. Use the centralized branch-aware query-key helper for branch-scoped server state. Organization-wide operations must not send branch scope.
6. **No code duplication:** Do not copy code from shared components to create local custom versions.
7. **Perform audit:** Run the Architecture Audit Checklist (Section 30) before concluding a task.

---

## 33. Decision Log

| Concern | Architectural Standard / Decision | Reason |
|---|---|---|
| **Branch Scope** | Centralized Axios interceptor; `branchScope: "current"` config | Prevents manual header building and leaks |
| **Org Scope** | Completely isolated from branch scoping; backend-derived | Prevents tenant cross-contamination |
| **Query Keys** | must include all query parameters (filters, pagination, branch) | Prevents caching overlap and wrong views |
| **Lifecycle Field** | Standardize on one field: `status` OR `isActive` | Eliminates conflicting state data models |
| **HTTP Methods** | Derived from actual backend API contract | Prevents routing mismatches and build breakage |
| **API Normalization** | Type-safe; no `any` mapping | Preserves type-safety guarantees |
| **Entity Fields** | Domain-dependent (no universal schema list) | Supports flexible data modeling |
| **Cache Refresh** | Invalidate list and detail keys on success | Keeps user interface synchronized |
| **Components** | Reuse DataTable, Pagination, EntityActionMenu, Dialogs | Reduces UI bugs and codebase bloat |
| **AI deviations** | Stop and report before implementing exceptions | Prevents silent architectural drift |

---

## 34. Customer + Services Reference Matrix

| Feature | Customer | Services | Standard |
|---|---|---|---|
| **API file** | `customers.api.ts` | `services.api.ts` + `serviceCategories.api.ts` | One file per entity |
| **Response generic** | Alias wrappers | Shared generic | **Shared generic preferred** |
| **Mutation hooks** | Direct `useMutation` | `useEntityMutation` | **useEntityMutation preferred** |
| **Type definition** | Manual interface | `z.infer` | **z.infer preferred** |
| **Delete dialog** | Local wrapper | Direct shared usage | **Shared dialogs directly** |
| **Filters** | Inline parameters | `filters.types.ts` | **Separate filters file** |
| **Tests** | Present | Absent | **Automated tests recommended** |

---

```
Module Architecture Standard Version: 1.1
Reference Modules: Customer + Services
```
