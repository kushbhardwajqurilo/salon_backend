# Unisex Parlour ERP — Architecture & Engineering Guide

**Status:** Living Architecture Document  
**Audience:** Frontend Developers, Backend Developers, QA Engineers, AI Coding Agents, Technical Leads

## 1. Purpose of This Document

This document explains how the Unisex Parlour ERP is designed and how developers must build new features.

A developer should be able to understand:
• How the frontend and backend communicate.
• How organizations and branches work.
• How authentication and permissions work.
• How branch scoping works.
• How frontend authorization works.
• How API requests are scoped.
• How React Query caching must work.
• How domains are separated.
• How to create a new ERP module.
• How Customer data is modeled.
• What architectural patterns must never be violated.

This document is the source of truth for architectural behavior. If a future implementation plan conflicts with this document, the conflict must be resolved before implementation.

## 2. High-Level System Architecture

The ERP consists of two separate applications.

User / Browser
    ↓
Next.js Frontend
    • UI
    • RBAC UI Guards
    • Branch Context
    • React Query
    • Redux
    • Axios
    ↓ HTTP / HTTPS
Express Backend
    • Authentication
    • Authorization
    • Branch Scoping
    • Business Logic
    • Validation
    • Domain Services
    ↓
MongoDB

The frontend improves user experience and controls what the user sees. The backend is the final authority for authentication, authorization, organization isolation, and branch data access.

## 3. Multi-Tenant Organization Model

The ERP is organization-based. An organization represents one business/company using the ERP.

Example:
ABC Unisex Parlour
├── Indiranagar
├── Koramangala
└── Whitefield

The organization is the primary tenant boundary. Every organization-owned domain record must be associated with organizationId.

## 4. Organization Isolation

Every organization-owned query must be scoped to the authenticated user's organization.

Conceptually:
{ organizationId: authenticatedUser.organizationId }

A user belonging to Organization A must never access data belonging to Organization B.

This applies to GET, POST, PUT/PATCH, DELETE, direct record access, search, filtering, and reports.

Organization isolation is a security boundary and must be enforced by the backend.

## 5. Branch Architecture

A user can have access to one or multiple branches.

Two concepts must never be confused:
• branchAccess: branches the user is allowed to access.
• Active branch / X-Branch-Id: the branch scope of the current request.

A user may have access to several branches but operate against one active branch at a time.

## 6. branchAccess vs X-Branch-Id

branchAccess answers: Which branches is this user allowed to access?

X-Branch-Id answers: Which branch is the current request operating against?

Example:
X-Branch-Id: branch-a

The backend must validate that the requested branch belongs to the user's organization and is permitted by the user's access context.

## 7. Active Branch Context

The frontend maintains an active branch context.

User
├── branchAccess
│   ├── Branch A
│   └── Branch B
└── activeBranch
    └── Branch A

When the active branch changes, future API requests use the newly selected branch through centralized Axios scoping.

## 8. Organization-Wide Access

hasOrgWideAccess is a user capability, not a role-name bypass.

It means the user may operate organization-wide.

Two valid modes exist:

1. All Branches selected:
   hasOrgWideAccess = true
   No X-Branch-Id header
   → Organization-wide scope

2. Specific branch selected:
   hasOrgWideAccess = true
   X-Branch-Id = Branch A
   → Branch A scope

An organization-wide user may still intentionally operate in a specific branch.

## 9. The 'all' Sentinel

The frontend may internally use the string "all" to represent All Branches.

"all" is a frontend-only UI/storage sentinel. It is never a real branch ID.

Correct:
activeBranchId = "all"
→ No X-Branch-Id header

Incorrect:
X-Branch-Id: all

The backend explicitly rejects X-Branch-Id: all with a validation error.

## 10. Branch-Limited Users

A user with hasOrgWideAccess = false must operate within a valid active branch.

The frontend must prevent All Branches selection for such users.
The backend must also enforce this rule.

Never rely only on the frontend for security.

## 11. Backend Request Scope

A protected request conceptually follows this flow:

1. Authenticate user
2. Identify organization
3. Validate permission
4. Validate branch scope
5. Apply organization filter
6. Apply branch filter if applicable
7. Execute business logic

These are separate concerns:
Authentication = Who are you?
Authorization = What are you allowed to do?
Organization isolation = Which tenant's data?
Branch scope = Which branch's data?
Business logic = How should the operation work?

## 12. RBAC Architecture

The ERP uses permission-based authorization.

User
  ↓
Role
  ↓
Permissions

The authorization decision is based on whether the authenticated user has the required permission, not on the role name.

Role names must not be used as hidden authorization bypasses.

## 13. Permission Keys

Permissions are canonical strings.

Examples:
customers.view
customers.create
customers.update
customers.delete

appointments.view
appointments.book
appointments.reschedule
appointments.assign_staff
appointments.update_status
appointments.cancel

The backend permission registry is the source of truth. The frontend must use the same permission keys and must never invent frontend-only permission names.

## 14. Owner Role

The Owner role does not receive a special frontend bypass.

The Owner gets access because the backend assigns the appropriate canonical permissions.

Correct:
hasPermission("customers.view")

Forbidden:
if (user.role === "Owner") {
    allowEverything();
}

This keeps authorization role-agnostic.

## 15. Frontend Permission Checking

Frontend helpers such as:
• hasPermission()
• hasAnyPermission()
• hasAllPermissions()

must evaluate the permissions array only.

Frontend checks are for:
• Hiding UI
• Disabling actions
• Protecting navigation
• Improving UX

They are not security boundaries. The backend must always enforce authorization.

## 16. /auth/me

The authenticated session contract includes information such as:
• id
• name
• email
• phone
• role
• permissions
• organizationId
• branchAccess
• hasOrgWideAccess

The frontend uses this information to establish the authenticated session.

The permissions array is the source for frontend capability checks.

## 17. Axios Architecture

Branch scoping is handled centrally by the Axios client.

Component
    ↓
API function
    ↓
Axios client
    ↓
Branch-scope interceptor
    ↓
HTTP request

Feature components should not manually add X-Branch-Id to every request.

## 18. Branch Scope Request Modes

Specific active branch:
activeBranchId = Branch A
→ X-Branch-Id: Branch A

All Branches:
activeBranchId = "all"
hasOrgWideAccess = true
→ No X-Branch-Id

Invalid branch-limited state:
activeBranchId = "all"
hasOrgWideAccess = false
→ Invalid; must not be allowed.

## 19. React Query Cache Architecture

React Query is responsible for server-state caching.

Branch-specific data must never leak between branches.

If a server response can change because of branch scope, branch scope must be represented in the query identity or the cache must be invalidated correctly.

Unsafe example:
["customers"]

Use the project's established branch-aware query-key convention or equivalent cache isolation strategy.

## 20. Branch Switching

When switching from Branch A to Branch B:

Select Branch B
    ↓
Update active branch
    ↓
Invalidate or isolate affected queries
    ↓
React Query refetches
    ↓
Branch B data is displayed

This applies to Customers, Appointments, Billing, Inventory, and other branch-sensitive domains.

## 21. Domain Architecture

The ERP is modular.

Each business domain should have its own:
• Model
• Validation
• Service
• Controller
• Routes
• Tests

Example:
Customer Domain
├── Model
├── Validation
├── Service
├── Controller
├── Routes
└── Tests

A domain must not become a dumping ground for unrelated business logic.

## 22. Customer Domain

Customer is the first completed vertical domain.

A Customer belongs to exactly one organization:
Customer.organizationId

This is the tenant ownership boundary.

## 23. Customer homeBranchId

homeBranchId means the branch where the Customer was registered/home branch.

It is not:
• Current branch
• Preferred branch
• Current appointment branch

After creation, homeBranchId is immutable through normal Customer profile updates.

## 24. Customer visitedBranchIds

visitedBranchIds is a derived, read-optimized field representing branches where a Customer has interacted.

Example:
Customer
├── homeBranchId: Branch A
└── visitedBranchIds:
    ├── Branch A
    └── Branch B

It is not authoritative transaction history.

Future transactional domains should provide authoritative business activity.

Updates should be idempotent and avoid duplicate branch IDs.

## 25. Customer Visibility

For a branch-scoped request:

organizationId matches
AND
(
  homeBranchId == activeBranchId
  OR
  visitedBranchIds contains activeBranchId
)

The user's branchAccess list does not determine the current Customer data scope. Active branch context does.

## 26. Organization-Wide Customer Visibility

For hasOrgWideAccess = true and no X-Branch-Id, the user can see applicable Customers across their organization.

If the same user selects Branch A, the request becomes Branch A scoped.

Therefore organization-wide capability and active branch scope are independent concepts.

## 27. Customer Creation

Every Customer must have a specific homeBranchId.

Therefore Customer creation requires a specific active branch.

Org-wide user + All Branches selected
→ Cannot create Customer

The backend derives homeBranchId from the active branch context.

The frontend must not arbitrarily supply or modify homeBranchId.

## 28. Customer Update

Normal Customer profile updates may change profile fields such as:
• name
• phone
• email
• gender
• dateOfBirth
• address
• notes

The following are immutable through normal updates:
• organizationId
• homeBranchId
• visitedBranchIds

## 29. Customer Soft Delete

Customer deletion is a soft-delete/deactivation operation.

Normal Customer lists exclude deleted/deactivated Customers.

Deleting a Customer must not automatically:
• Cancel appointments
• Delete invoices
• Clear loyalty points
• Delete historical records

Those are separate domain responsibilities.

## 30. Cross-Domain Data Ownership

A Customer profile does not own every piece of business data associated with that Customer.

Customer Domain → Customer profile
Appointment Domain → Appointment
Billing Domain → Invoice
Membership Domain → Membership
Loyalty Domain → Loyalty transactions

Do not store unlimited transaction history directly inside the Customer document.

## 31. Domain Dependency Direction

Domains own their own business entities.

Relationships may be represented by IDs and controlled domain workflows.

The Customer domain should not become the owner of appointments, invoices, memberships, or loyalty transactions simply because those records reference a Customer.

## 32. Recommended Development Order

1. Multi-Branch Foundation
2. Authentication + RBAC
3. Permission Registry
4. Customer Backend
5. Customer Frontend
6. Customer End-to-End Verification
7. Services Backend
8. Services Frontend
9. Employees + Attendance
10. Appointments
11. Billing / POS
12. Payments
13. Memberships
14. Loyalty
15. Inventory + Procurement
16. Expenses + Finance
17. Reports
18. Notifications / WhatsApp / Campaigns
19. Settings + Audit Logs

This sequence minimizes dependency problems.

Appointments, for example, eventually depend on:
Customer + Service + Employee + Branch + Availability

## 33. First Complete Vertical Slice

The Customer module should become the project's reference implementation.

Authentication
    ↓
User Session
    ↓
Permissions
    ↓
Branch Context
    ↓
Axios Scoping
    ↓
Backend Authorization
    ↓
Organization Isolation
    ↓
Branch Scoping
    ↓
Customer API
    ↓
React Query
    ↓
Customer UI

Once this is working end-to-end, future domains should follow the same architectural pattern.

## 34. How to Build a New Domain

Step 1 — Define the business boundary
Ask: What does this domain own?

Step 2 — Define permissions
Use canonical permission keys. Do not use role names.

Step 3 — Define organization ownership
Determine whether the entity belongs to an organization, a branch, or both.

Step 4 — Define branch semantics
Determine:
• Is the data organization-wide?
• Is it branch-specific?
• Can org-wide users filter by branch?
• Does the request require X-Branch-Id?

Step 5 — Define API contract
Specify methods, routes, payloads, responses, and validation rules.

Step 6 — Implement backend
Route
→ Authentication
→ Authorization
→ Branch Scope
→ Controller
→ Validation
→ Service
→ Database

Step 7 — Implement frontend
Page
→ Feature Component
→ API Hook
→ React Query
→ Axios
→ Central Branch Scoping

Step 8 — Add tests
Test authentication, permissions, organization isolation, branch isolation, org-wide behavior, invalid branch, invalid sentinel, CRUD behavior, and validation.

## 35. What Developers Must Never Do

Never:
• Use role names as authorization logic.
• Trust frontend checks for security.
• Treat branchAccess as active scope.
• Send X-Branch-Id: all.
• Allow client-controlled tenant ownership.
• Allow normal Customer updates to change homeBranchId.
• Store unlimited transaction history in Customer documents.
• Duplicate branch-scoping logic in every feature.
• Create cache keys that can mix branch-sensitive data.

## 36. Security Model Summary

Authentication
    = Who is the user?

Permission
    = What can they do?

Organization Scope
    = Which tenant's data?

Branch Scope
    = Which branch's data?

Business Logic
    = How should the operation work?

Every protected request must respect all applicable layers.

## 37. Testing Philosophy

Every new domain must test both functional correctness and security correctness.

Functional tests:
• Create
• Read
• Update
• Delete
• Validation

Security tests:
• Organization isolation
• Branch isolation
• Permission denial
• Cross-organization ID manipulation
• Branch-scope bypass attempts
• Invalid branch sentinel behavior

A feature is not complete until both functional and isolation behavior are verified.

## 38. Current Project Status

Multi-Branch Foundation        ✅
Authentication                ✅
RBAC / Permissions             ✅
Frontend RBAC / Branch Scope   ✅
Customer Backend               ✅
Customer Backend Hardening     ✅
Customer Backend Tests         ✅
Customer Frontend              ⏳ Next
Customer E2E Verification      ⏳
Services Backend               ⏳

## 39. Final Mental Model for New Engineers

USER
 │
 ├── ORGANIZATION
 ├── PERMISSIONS
 ├── BRANCH ACCESS
 └── ACTIVE BRANCH CONTEXT
          │
          ▼
       REQUEST
          │
          ├── Authentication
          ├── Permission
          ├── Organization Scope
          └── Branch Scope
                  │
                  ▼
              DOMAIN DATA

Core rule:
Permissions answer "what can I do?"
Organization scope answers "whose data can I access?"
Branch scope answers "which branch's data is this request operating on?"

The frontend provides the user experience for these concepts, but the backend is always the final authority.

## Appendix A — Canonical Permission Registry

The project uses a canonical permission registry covering core system administration, customers, appointments, employee HR and attendance, operations/POS, finance, inventory/procurement, loyalty, reports, communications, and settings.

The exact registry must be maintained in the backend permission registry/seed and mirrored by the frontend only when needed for UI capability checks.

The backend remains the source of truth.

## Appendix B — Reference Implementation Principle

Customer is the first reference vertical slice.

Future modules should reuse the same architectural principles:
• Authenticated user context
• Canonical permissions
• Organization isolation
• Explicit branch semantics
• Centralized Axios scoping
• Branch-aware React Query caching
• Domain separation
• Security-focused tests

