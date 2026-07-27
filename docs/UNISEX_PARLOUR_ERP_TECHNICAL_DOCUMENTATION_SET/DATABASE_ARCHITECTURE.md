# Unisex Parlour ERP — Database Architecture Specification

**Status:** Living technical specification  
**Parent document:** `ARCHITECTURE.md`

## 1. Purpose

This document defines the database rules that protect tenant isolation, branch semantics, domain ownership, and data integrity.

## 2. Organization as Tenant Boundary

Organization is the primary tenant boundary.

Organization-owned documents should contain:

```text
organizationId
```

The authenticated user's organization is the trusted source for tenant scope.

## 3. Organization Isolation

Every organization-owned query must be scoped to the authenticated organization.

Conceptually:

```js
{
  organizationId: authenticatedUser.organizationId
}
```

This must apply to:

- Find.
- Create.
- Update.
- Delete.
- Search.
- Reports.
- Aggregations.

## 4. Branch Data Semantics

Each domain must explicitly define its branch behavior.

Possible models include:

1. Organization-wide data.
2. Branch-owned data.
3. Organization-owned data with branch visibility.
4. Organization-wide data filtered by active branch.

Do not assume every collection has identical branch semantics.

## 5. Customer Data Model

Customer uses:

- `organizationId` — tenant ownership.
- `homeBranchId` — profile/home branch.
- `visitedBranchIds` — derived read-optimized branch interactions.

`homeBranchId` is not the current active branch.

## 6. Customer Visibility

For branch-scoped Customer access:

```text
homeBranchId == activeBranchId
OR
visitedBranchIds contains activeBranchId
```

The user must also belong to the same organization.

## 7. Customer Creation

Customer creation requires a specific branch context.

The backend derives `homeBranchId` from active branch context.

The client cannot override organization or home branch ownership.

## 8. Immutable Scoping Fields

Normal update operations must not allow clients to change:

- `organizationId`
- `homeBranchId`
- `visitedBranchIds`

If a legitimate business workflow needs to change one of these, implement a dedicated domain operation with explicit authorization and audit requirements.

## 9. Derived Fields

Derived fields such as `visitedBranchIds` should not be treated as authoritative transaction history.

They exist to improve read performance and visibility queries.

Authoritative business events belong to their owning domains.

## 10. Cross-Domain Ownership

Examples:

```text
Customer Domain
    Customer profile

Appointment Domain
    Appointment

Billing Domain
    Invoice / checkout

Membership Domain
    Membership

Loyalty Domain
    Loyalty transactions
```

A reference to a Customer does not transfer ownership of the Customer's profile to that domain.

## 11. Soft Deletion

Where soft deletion is used:

- Normal reads exclude deleted records.
- Historical references remain intact.
- Deletion must not cascade blindly across unrelated domains.

Each domain must define its deletion semantics explicitly.

## 12. Indexing

Indexes should support:

- `organizationId`
- Common branch lookup fields.
- Frequently queried business identifiers.
- Search fields where appropriate.

Index decisions should follow actual query patterns.

Do not add uniqueness constraints without a confirmed business rule.

## 13. Phone Number Uniqueness

Customer phone uniqueness is currently a deferred business decision.

Do not assume phone numbers are globally unique unless the business explicitly approves the rule.

Normalization may still be applied consistently.

## 14. Validation and Integrity

Schema validation is not enough.

Data integrity is enforced through:

- Request validation.
- Service-level business rules.
- Organization scoping.
- Branch visibility checks.
- Immutable field protection.
- Database indexes where appropriate.

## 15. Database Change Process

For a new field or collection:

1. Define ownership.
2. Define organization scope.
3. Define branch semantics.
4. Define required indexes.
5. Define validation.
6. Define immutability.
7. Define deletion behavior.
8. Add tests.
9. Update documentation.

