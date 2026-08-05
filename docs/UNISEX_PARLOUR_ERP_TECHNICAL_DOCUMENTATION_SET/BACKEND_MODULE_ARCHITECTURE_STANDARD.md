# Backend Module Architecture Standard

```
Status: Canonical
Reference Modules: Customer, Services
Scope: All future backend ERP modules
Backend Module Architecture Standard Version: 1.0
Last Updated: 2026-08-05
Revision Note: Final refined version after architectural review and alignment on framework-level standards.
```

---

## 1. Purpose
This document establishes the canonical Backend Module Architecture Standard for the Salon ERP. It defines the layering, security boundaries, and architectural rules that all future backend modules must conform to. Adhering to this standard ensures backend consistency, tenant isolation, robust authorization, and a clear separation of concerns across all current and future modules.

---

## 2. Scope
This standard applies strictly to the backend codebase of the Salon ERP. It governs the design and verification of all backend modules (such as Staff, Appointments, Inventory, Products, POS, Billing, Payments, and CRM).

---

## 3. Relationship to Frontend Architecture Standard
The backend standard shares domain contracts (such as entity naming conventions, lifecycle values, permission scopes, pagination parameters, and API response envelopes) as defined in [MODULE_ARCHITECTURE_STANDARD.md](file:///c:/Users/deves/Desktop/Projects/Saloon%20ERP/docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/MODULE_ARCHITECTURE_STANDARD.md) v1.1. The systems share domain contracts without forcing identical folder layouts, and the frontend architecture does not dictate backend implementation layers.

---

## 4. Architectural Principles
* **Separation of Concerns:** Business logic must not live in route files or controllers. Data access and query building must be delegated to the repository layer.
* **Strict Tenant Isolation:** Every data access check and persistence operation must enforce the tenant boundary (`organizationId`). Client-provided tenant IDs must never be trusted.
* **Thin Controllers:** Controllers must limit their responsibility to parameter extraction, service invocation, and response formatting.
* **Fail-Fast Boundary Validation:** Incoming data (headers, query parameters, path variables, and body payloads) must be validated at the entry point of the route layer before executing any business logic.

---

## 5. Backend Layer Architecture
The standard flow of a backend request is strictly sequenced:
```text
HTTP Request
     ↓
Route (Express Router)
     ↓
Authentication Middleware (authenticate)
     ↓
Scope Enforcement Middleware (requireBranchScope / requireOrganizationScope)
     ↓
Authorization Middleware (authorize)
     ↓
Validation Middleware (validate)
     ↓
Controller
     ↓
Service
     ↓
Repository
     ↓
Model (Mongoose) / Database
```

---

## 6. Model Standard
All database schemas must define fields and structures according to their domain requirements:
* **Tenant Isolation:** Every document must contain an `organizationId` referencing the tenant organization.
* **Branch Isolation:** Schemas must specify their branch scoping pattern (single-branch, multi-branch, relationship-based, or organization-wide).
* **Auditing:** Documents must track creation and update timestamps (`createdAt`, `updatedAt`), alongside user identifiers (`createdBy`, `updatedBy`).
* **Concurrency Control:** Implement optimistic locking to prevent concurrent write collisions.
* **Deletion Lifecycle:** Documents requiring historical preservation must support soft deletion via boolean flags and timestamp fields.

---

## 7. Organization/Tenant Standard
* **Tenant Isolation:** Every document belongs to an organization. The `organizationId` is the primary tenant boundary.
* **Session Derivation:** The `organizationId` must be derived strictly server-side from the authenticated session context (`req.user.organizationId`) in the middleware layer.
* **Cross-Tenant Prevention:** Under no circumstances should database queries allow searching across different organizations. All queries must explicitly filter by `organizationId`.

---

## 8. Branch Scope Standard
Backend modules must explicitly scope access based on their branch semantics:
* **Branch-Scoped Operations:** Require the `X-Branch-Id` header. The `requireBranchScope` middleware validates that the branch is active, belongs to the user's organization, and the user is authorized to access it.
* **Organization-Wide Operations:** Triggered by omitting the `X-Branch-Id` header (valid only for users with `hasOrgWideAccess === true`).
* **Creation constraints:** Creating an entity requires a specific branch context (meaning `X-Branch-Id` must be provided and validated) unless the entity is inherently organization-wide.

---

## 9. Lifecycle Standard
Every backend module must define its document lifecycle model according to its domain requirements:

### Lifecycle Classifications
* **Binary Lifecycle:** Used for simple active/inactive toggling where records are either operationally available or suspended.
* **Operational Lifecycle:** Used for entities that move through states (e.g. scheduled, in-progress, completed) to represent workflow progress.
* **Multi-State Lifecycle:** Used for complex profiles requiring administrative sub-states (e.g., active, inactive, blocked, suspended).
* **Archival Lifecycle:** Used for historical documents that are closed or resolved and kept for reference only.
* **Historical Lifecycle:** Used for logs or audit records that are completely immutable and never transition.

### Lifecycle Rules
* **Transition Validation:** All state transitions must be validated in the Service layer to ensure only valid workflows are executed.
* **Authorization:** Transitions modifying operational status or administrative states must require explicit RBAC permissions.
* **Relationship to Deletion:** Setting a status value to inactive or blocked is distinct from soft deletion. Soft deletion hides the record from normal queries, whereas status states modify how active users interact with the record.
* **Audit Integration:** All state transitions must record audit trail logs mapping the actor, previous state, and new state.

---

## 10. Validation Standard
* **Zod Schemas:** Input validation must use Zod schemas defined under `src/validation/<module>/`.
* **Standard Schemas:** Every module must expose schemas for `create`, `update`, and `query` validation.
* **Request Validation:** The `validate` middleware parses the request body, query parameters, and path parameters, stripping unvalidated fields and reassigning the validated outputs to `req.body`, `req.query`, and `req.params`.

---

## 11. Repository Standard
* **Base Inheritance:** All repositories must inherit from [BaseRepository](file:///c:/Users/deves/Desktop/Projects/Saloon%20ERP/src/shared/repositories/base.repository.js).
* **Tenant Scope Injection:** Custom query overrides (e.g. `find`, `count`, `findById`, `updateById`, `deleteById`) must explicitly inject the `organizationId` to prevent cross-tenant leakages.
* **No Workflows:** Repositories must NOT contain business rules, authorization logic, transaction management, or HTTP handlers. They are strictly data-access wrappers.

---

## 12. Service Standard
* **Business Invariants:** The service layer is the sole owner of business logic and invariants.
* **Validation & Security Checks:** Service functions validate that referenced entities (such as category, staff, or branch) exist, are active, and belong to the correct organization tenant scope.
* **Auditing:** Services trigger audit logging entries via the `AuditLogRepository` or `auditLogService`.
* **Transaction Orchestration:** Services coordinate multi-document database operations within MongoDB transactions.

---

## 13. Controller Standard
* **薄 / Thin controllers:** Controllers should extract parameters (`req.params`, `req.query`, `req.body`), request context (`req.organizationId`, `req.branchId`, `req.user`), call service functions, and return responses.
* **Unified Response Format:** All responses must use the `sendResponse` utility from `src/utils/response.js`.
* **No Business Logic:** Controllers must not perform data modifications, enforce domain constraints, or execute database operations directly.

---

## 14. Route Standard
* **Plural naming:** Route prefixes must be plural (e.g., `/api/customers`, `/api/services`).
* **REST Conventions:** Follow standard HTTP verbs:
  * `POST /resource` (Create)
  * `GET /resource` (List)
  * `GET /resource/:id` (Get Detail)
  * `PUT /resource/:id` (Canonical Update - Full entity edits)
  * `DELETE /resource/:id` (Soft Delete/Deactivate)
* **Canonical Update Method:** The canonical method for updating resources is `PUT`. All general resource updates must use `PUT`. `PATCH` is reserved strictly for specialized, partial state transitions (such as status reactivation) if required by the API contract.
* **Middleware Chaining:** Sequence must be: `authenticate` -> `requireBranchScope`/`requireOrganizationScope` -> `authorize` -> `validate` -> controller handler.

---

## 15. API Contract Standard
All API endpoints must return a standardized JSON structure:
* **Single Entity Response:**
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Resource retrieved successfully",
    "data": { "id": "...", "name": "..." }
  }
  ```
* **List Response:**
  ```json
  {
    "success": true,
    "status": "success",
    "message": "Resources listed successfully",
    "data": [ ... ],
    "meta": {
      "total": 100,
      "page": 1,
      "limit": 10,
      "totalPages": 10
    }
  }
  ```

---

## 16. Pagination Standard
* **Server-Side Enforcement:** Pagination is mandatory for all query lists. Client-side pagination of query results is prohibited.
* **Query Parameters:** Query validation must enforce default paging fields: `page` (default 1), `limit` (default 10, max 100).
* **Meta Output:** The response `meta` block must contain `total`, `page`, `limit`, and `totalPages` computed from database counts.

---

## 17. Search/Filtering/Sorting Standard
* **Search Fields:** Text searches must map to specific, safe fields using MongoDB regex (handled type-safely in `BaseRepository` via options).
* **Allowed Filter Keys:** Query schemas must validate and whitelist filter parameters to prevent execution of arbitrary database queries.
* **Determinism:** Sorts must default to a stable order (e.g., `displayOrder` or `-createdAt`) and fallback to `_id` as a tie-breaker.

---

## 18. RBAC Standard
* **Permission naming:** Follows the `module.action` structure.
* **Vocabulary:** Standard action conventions are `view`, `create`, `edit` (or `update`), and `delete`.
* **Caching:** Permissions are checked against cached values in Redis via the `authorize` middleware to reduce database load.

---

## 19. Error Handling Standard
* **Central Error Handler:** All errors must be forwarded to Express `next(err)` and caught by `globalErrorHandler` in `src/utils/errors.js`.
* **Standard Error Wrapper:** Errors are mapped to `AppError` instances with corresponding HTTP status codes:
  * 400: Input validations (Zod, DB Cast/ValidationError, duplicates)
  * 401: Unauthenticated requests
  * 403: Unauthorized or missing permission scopes
  * 404: Missing resources
  * 500: Server/Database errors (stack traces masked in production)

---

## 20. Audit Standard
* **Universal Audit Plugin:** The global `auditPlugin` in `src/database/plugins/audit.js` adds tracking fields (`createdBy`, `updatedBy`, `deletedBy`, `isDeleted`, `deletedAt`) to every Mongoose document.
* **Audit Trails:** Crucial state adjustments and creation events must write detailed history records to the `AuditLog` collection through the service layer.

---

## 21. Transaction Standard
* **Multi-document writes:** Any operation writing or modifying multiple documents (e.g. creating/reactivating an entity and logging audits, or cascading status edits) must execute within a Mongoose session transaction (`session.startTransaction()`).
* **Aborts:** Transactions must abort and roll back completely if any intermediate validation or database save fails.

---

## 22. Database Index Standard
* **Tenant Indexes:** Every model index must be compound and start with `organizationId` (or `branchId`) to ensure fast, isolated lookups.
* **Uniqueness:** Unique indexes must filter out soft-deleted records using partial indexes:
  ```javascript
  schema.index(
    { branchId: 1, name: 1 },
    { unique: true, partialFilterExpression: { isDeleted: false } }
  );
  ```

---

## 23. Security Standard
* **Strict tenant isolation:** Verified token session details are the absolute source of truth for identity, organization, and branch ownership.
* **Input Scrape:** Strip all write parameters (`organizationId`, `homeBranchId`, `branchId`) from request body inputs during create/update validation.

---

## 24. Type Safety Standard
* **No Any:** The codebase uses JavaScript (`.js` and `.mjs`) but enforces type boundaries at boundaries through Zod parsers and schema constraints.
* **DTO Validation:** Inputs are mapped strictly via Zod shapes to reject unrecognized parameters.

---

## 25. Testing Standard
All backend modules must implement automated coverage:
* **Unit Tests:** Verify business validations, lifecycle transitions, and formatting rules.
* **Repository Tests:** Verify organization scope injections, partial indexes, and soft-delete filters.
* **Integration Tests:** Verify Express router middleware execution, request parameter mappings, and database saves.
* **API Tests:** Verify contract compliance, paginated responses, and error payload structures.
* **Security & Isolation Tests:** Verify that simulated unauthorized cross-tenant and cross-branch requests are blocked.
* **RBAC Tests:** Validate that endpoints successfully reject requests lacking the required permission scope.
* **Validation Tests:** Verify that schema validation checks block invalid inputs.

---

## 26. Naming/File Structure Standard
Modules must follow the established repository naming convention:
* Models: `src/models/<module>/<entity>.model.js`
* Repositories: `src/repositories/<module>/<entity>.repository.js`
* Services: `src/services/<module>/<entity>.service.js`
* Controllers: `src/controllers/<module>/<entity>.controller.js`
* Validation: `src/validation/<module>/<entity>.validation.js`
* Routers: `src/routers/<module>/<entity>.routes.js`
* Tests: `src/tests/<module>/<entity>.test.js`

---

## 27. Frontend ↔ Backend Shared Contract
The systems share agreements on contract details without forcing identical folder layouts:
* **Identifier Names:** Backend documents expose `_id`, which the frontend normalizes to `id`.
* **Permission Keys:** RBAC checks must match exact strings (e.g. `customers.create`).
* **Lifecycle Statuses:** Values like `active` or `inactive` must match.
* **Pagination structure:** Filters and paginated metadata formats must align.

---

## 28. Architectural Decision Frameworks

### Organization Ownership
Determine the scope of document access control:
* **Organization-Owned:** Document access is limited to users authenticated under the corresponding `organizationId` (e.g., Customers, Services).
* **Shared/Global:** Document is readable across organizations (e.g., System Settings).

### Branch Ownership
Determine how documents scope to physical locations:
* **Organization-Wide:** Document has no location association and is visible globally within the tenant.
* **Single-Branch:** Document is strictly associated with one `branchId` (e.g., local stock/inventory items).
* **Multi-Branch:** Document is associated with multiple branches (e.g., Customer visits across locations).
* **Relationship-Based:** Scoping is managed via an intermediate relationship entity (e.g., Staff assigned to multiple branch schedules).

### Lifecycle & Soft Deletion
Define lifecycle state policies based on audit and operational needs:
* **Hard Delete:** Permanently remove documents. Appropriate only for temporary data with no historical or financial relevance.
* **Soft Delete:** Mark documents with `isDeleted: true` to hide them from standard queries while preserving database relationships. Required for primary domain records.
* **Deactivate:** Transition status to `inactive` while keeping the record visible in lists or profile menus. Suitable for toggling active states of operational objects.
* **Archive:** Move older transactional items to cold storage or separate read-only schemas for compliance.

### Transactions
* **Required:** Multi-document updates, cascading status adjustments, or simultaneous insertions of domain records and audit trails.
* **Unnecessary:** Single-document creations, reads, or isolated updates where optimistic locking handles race conditions.

### Audit
* **Required:** Actions altering permissions, transaction states, operational statuses, or modifications to sensitive customer/employee profiles.
* **Unnecessary:** Read operations, search inputs, or routine non-state edits.

### Repository
* **Required:** Standard database collections to encapsulate queries and index logic.
* **Specialized Repository:** Justified when reading aggregate views, performing analytics, or querying remote system caches.

### Relation Entities
* **Required:** When the relationship between two entities holds metadata (e.g., a Staff-Service assignment mapping commission rates or specific durations) or when the relationship has its own lifecycle.
* **Inline Arrays:** Appropriate when relations are simple lists of IDs with no unique metadata attributes (e.g. preferredStaff).

---

## 29. Architecture vs Domain Responsibilities

| Backend Architecture Standard Defines | Individual Module Defines |
| ------------------------------------- | ------------------------- |
| Layer Architecture & Sequencing       | Entity fields & data types |
| Repository & Base Repository Pattern   | Domain-specific queries & indexes |
| Controller & HTTP Layer Mapping       | Validation rules (Zod schemas) |
| API Standard Envelopes & Response Format | API endpoint names & paths |
| Server-Side Pagination Mechanics      | Sorting defaults & filters |
| Tenant Scoping & Organization Isolation | Branch Scoping Selection |
| Error Handling & Normalization        | Custom Domain Exceptions |
| Audit Trail Pipeline & Plugin fields  | Action-specific logging |
| Transaction Orchestration Standard    | Transaction requirements  |
| Caching & RBAC Middleware             | Permission key naming |

---

## 30. Backend-Specific Rules
* **Mongoose Middleware:** Query middleware in `auditPlugin` automatically filters out `{ isDeleted: false }` for all standard query operations.
* **No UI dependencies:** Backend code must not include layout, styling, axios client, or frontend hooks.

---

## 31. Anti-Patterns
* **Direct Model Imports:** Controllers importing mongoose models directly (bypassing repositories and services).
* **Body Scoping:** Trusting `req.body.organizationId` or `req.body.branchId` on creations.
* **Role Checking:** Handcrafting role logic (e.g., `if (req.user.role === 'Admin')`) instead of checking permission keys.
* **Missing Audits:** Modifying critical records without creating audit logs.

---

## 32. Legacy/Migration Policy
The existing Customer and Services backends contain legacy patterns that must be phased out in future modules:
* **Service soft deletion:** Manually sets `isDeleted` and `status` in the repository instead of using the global Mongoose instance methods `softDelete(userId)` provided by `auditPlugin`.
* **RBAC permission naming mismatch:** In `service.routes.js`, the code checks for `services.edit`, but the defined permission name in `permissions.js` is `services.update`. Future router implementations must match the actual permission naming constants defined in `src/config/permissions.js`.

---

## 33. Customer vs Services Compliance Matrix

| Area | Customer | Services | Target Standard | Compliance | Classification |
|---|---|---|---|---|---|
| **Organization Scope** | Filtered via token `organizationId` | Filtered via token `organizationId` | Filtered strictly via token `organizationId` | PASS | STANDARD |
| **Branch Scope** | Derived home/visited branch context | Strictly bound to `branchId` | Scoped strictly via `requireBranchScope` / `getActiveBranchContext` | PASS | STANDARD |
| **Model Structure** | Mongoose schema with embedded arrays/subdocs | Mongoose schema | Standardized fields (`organizationId`, `isDeleted`, `status`) | PASS | STANDARD |
| **Validation** | Zod validation via `validate` | Zod validation via `validate` | Strict body/query validation before executing controller | PASS | STANDARD |
| **Repository** | Inherits `BaseRepository` | Inherits `BaseRepository` | Extends `BaseRepository` to isolate db queries | PASS | STANDARD |
| **Service** | Handles business logic/audits | Handles business logic/audits | Orchestrates logic and audits, keeps controller thin | PASS | STANDARD |
| **Controller** | Thin controller using standard response | Thin controller using standard response | Extract params, call service, respond via `sendResponse` | PASS | STANDARD |
| **Routes** | Route sequence with middlewares | Route sequence with middlewares | standard sequence: auth -> scope -> authorize -> validate | PASS | STANDARD |
| **RBAC** | Permission checks on routers | Inconsistent permission key names | Routers must match defined names in `permissions.js` | PARTIAL | LEGACY |
| **Lifecycle** | `status` enum + `isDeleted` | `status` enum + `isDeleted` | Explicit status field + soft-deletion flags | PASS | STANDARD |
| **Deletion** | softDelete instance method | Manual updates in repository | Use `doc.softDelete(userId)` provided by global plugin | PARTIAL | LEGACY |
| **Pagination** | Server-side pagination | Server-side pagination | Mandatory pagination via `BaseRepository` | PASS | STANDARD |
| **Search** | Regexp search options | Regexp search options | Safe search fields parsed in repository | PASS | STANDARD |
| **Filtering** | Allowed filters in query schema | Allowed filters in query schema | Whitelisted filter properties on query schema | PASS | STANDARD |
| **API Responses** | Wrapped using `sendResponse` | Wrapped using `sendResponse` | Return structured JSON with `success`, `data`, `meta` | PASS | STANDARD |
| **Errors** | Handled by `globalErrorHandler` | Handled by `globalErrorHandler` | Bubble to middleware and catch globally | PASS | STANDARD |
| **Audit** | Audit trails for all mutations | Audit trails for all mutations | Global fields via plugin + service audit logs | PASS | STANDARD |
| **Testing** | Unit, integration & security tests | Only route integration test | Unit, Integration, and Security test coverage required | PARTIAL | LEGACY |

---

## 34. Staff Readiness Assessment
The backend architecture standard now provides sufficient architectural guidance to design the Staff module without requiring foundational architectural assumptions.

---

## 35. Open Decisions
Framework-level architecture is complete. Future modules remain responsible for defining their specific:
* Lifecycle values
* Entity fields
* Relationship modeling
* Permission definitions
* Endpoint design
* Validation rules
* Indexes
* Transactions
* Business rules

---

## 36. Version / Change Log
* **1.0 (2026-08-05):** Initial backend module architecture standard drafted, aligned with Customer and Services modules, and corrected for soft-deletion and RBAC conventions.
* **1.0 (Refined, 2026-08-05):** Refined after architectural review to separate architecture from implementation details and generalize all module-specific rules.
* **1.0 (Final Refinement, 2026-08-05):** Final architectural corrections applied for approval.

---

**FINAL VERDICT:**
**BACKEND MODULE ARCHITECTURE STANDARD v1.0 APPROVED**
**READY FOR STAFF MODULE ARCHITECTURE**
