# Unisex Parlour ERP — Development Workflow

**Status:** Living technical specification  
**Parent document:** `ARCHITECTURE.md`

## 1. Purpose

This document defines the standard workflow for implementing a new ERP domain.

It applies to both human engineers and AI coding agents.

## 2. Phase 1 — Understand the Domain

Before coding, answer:

- What business problem does this domain solve?
- What records does it own?
- Which existing domains does it reference?
- What data is organization-owned?
- What data is branch-specific?
- What actions require separate permissions?

Do not begin implementation until these questions are clear.

## 3. Phase 2 — Define Permissions

Create canonical permission keys.

Example:

```text
services.view
services.create
services.update
services.delete
```

Avoid role-specific permission names.

Update the backend permission registry.

## 4. Phase 3 — Define Scope

Document:

- Organization ownership.
- Branch ownership.
- Active branch requirements.
- Organization-wide behavior.
- Cross-branch visibility.
- Creation requirements.

Do not copy Customer rules blindly. Each domain has its own semantics.

## 5. Phase 4 — Define Data Model

Specify:

- Required fields.
- References.
- Immutable fields.
- Indexes.
- Soft deletion.
- Derived fields.
- Uniqueness rules.

## 6. Phase 5 — Define API Contract

Specify:

- Routes.
- Methods.
- Permissions.
- Request body.
- Query parameters.
- Response shape.
- Error behavior.
- Branch requirements.

## 7. Phase 6 — Backend Implementation

Implement in this order:

```text
Model
    ↓
Validation
    ↓
Service
    ↓
Controller
    ↓
Routes
    ↓
Tests
```

Use centralized authentication, authorization, and scope mechanisms.

## 8. Phase 7 — Backend Verification

Verify:

- Organization isolation.
- Branch isolation.
- Permission denial.
- Org-wide behavior.
- Invalid branch behavior.
- Immutable fields.
- Validation.
- CRUD.

Run the full backend test suite.

## 9. Phase 8 — Frontend Implementation

Implement:

```text
Page
    ↓
Feature Components
    ↓
Hooks
    ↓
API Functions
    ↓
React Query
    ↓
Axios
```

Use existing branch context and permission helpers.

Do not introduce feature-specific authorization architecture.

## 10. Phase 9 — Cache and Scope Verification

Verify:

- Branch-specific query behavior.
- Branch switching.
- Cache invalidation.
- All Branches behavior.
- No stale branch data.

## 11. Phase 10 — Frontend Verification

Test:

- Permission-based UI.
- Loading.
- Errors.
- Empty states.
- CRUD flows.
- Branch switching.

Run build/type checks.

## 12. Phase 11 — End-to-End Verification

Verify the complete path:

```text
Login
 ↓
/auth/me
 ↓
Permissions + Branch Context
 ↓
Select Branch
 ↓
Frontend API Call
 ↓
Axios Scoping
 ↓
Backend Authorization
 ↓
Organization Scope
 ↓
Branch Scope
 ↓
Business Operation
 ↓
Response
 ↓
React Query Cache
 ↓
UI
```

## 13. Phase 12 — Documentation

Update:

- `ARCHITECTURE.md` if architectural rules changed.
- `PERMISSIONS.md` if permissions changed.
- `API_CONTRACT.md` if contracts changed.
- Domain-specific documentation.
- Tests.

## 14. AI Agent Workflow

When giving an implementation task to an AI coding agent, provide:

1. Relevant architecture documents.
2. Exact feature scope.
3. Explicit files to inspect.
4. Permission requirements.
5. Organization rules.
6. Branch rules.
7. API contract.
8. Test requirements.
9. Explicit non-goals.

Ask the agent to audit existing code before changing it.

## 15. AI Agent Guardrails

AI agents must not:

- Invent role bypasses.
- Change tenant ownership semantics without approval.
- Change branch semantics silently.
- Create duplicate permission systems.
- Modify unrelated domains.
- Remove security tests to make tests pass.
- Replace established architecture with a new pattern without approval.

## 16. Implementation Plan Review

Before implementation, review the plan for:

- Security gaps.
- Scope gaps.
- Permission gaps.
- API contract mismatches.
- Cache implications.
- Existing domain dependencies.

## 17. Definition of Done

A vertical slice is complete when:

```text
Requirements
   ↓
Architecture
   ↓
Permissions
   ↓
Backend
   ↓
Backend Tests
   ↓
Frontend
   ↓
Frontend Tests
   ↓
Build
   ↓
E2E Verification
   ↓
Documentation
```

All relevant stages must be complete before calling the domain production-ready.

## 18. Recommended Module Order

The current recommended progression is:

1. Multi-Branch Foundation.
2. Authentication and RBAC.
3. Permission Registry.
4. Customer Backend.
5. Customer Frontend.
6. Customer End-to-End Verification.
7. Services.
8. Employees and Attendance.
9. Appointments.
10. Billing/POS.
11. Payments.
12. Memberships.
13. Loyalty.
14. Inventory and Procurement.
15. Expenses and Finance.
16. Reports.
17. Notifications / WhatsApp / Campaigns.
18. Settings and Audit Logs.

The exact order may change when dependency analysis shows a better sequence, but changes must be documented.

## 19. Final Rule

Build each domain as a complete vertical slice.

Do not build isolated UI screens that have no finalized backend contract, and do not build backend endpoints without considering the frontend session, permission, branch scope, and cache behavior.

The Customer domain is the reference implementation for this workflow.
