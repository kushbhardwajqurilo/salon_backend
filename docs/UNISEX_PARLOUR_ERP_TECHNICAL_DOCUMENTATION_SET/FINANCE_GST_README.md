# Finance, Register Closures & Operating Profit Module — Specification & Status

```text
Module: Financial Accounting, Register Closures & Operating Profit (P&L)
Status: ✅ IMPLEMENTED & VERIFIED
Layer: Financial Governance / Branch Auditing
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-11-21
```

---

## 1. Domain Overview & Business Purpose

The **Finance** module manages end-of-day cashier drawer reconciliations, branch closure sign-offs, and store Operating Profit (P&L) analysis for salon operations.

### Key Architectural Capabilities
- **Day-End (EOD) Register Closure**:
  - Exactly 1 closure record per physical branch per business date (`unique: { organizationId, branchId, businessDate }`).
  - Cashier enters physical cash, card slips, UPI settlement totals, and other tenders.
  - Compares physical counts against live system billing totals aggregated across completed `Payment` records in the branch-configured timezone (`branch.timezone`).
  - **Reconciliation Result Separation**: Evaluated as `balanced` only if every tender delta (cash, card, UPI, other) is exactly zero. Any non-zero delta marks the result as `discrepant` and mandates a detailed `discrepancyReason`.
  - **Immutable History**: Counted values are immutable once submitted. Manager approval locks the closure record (`status: "approved"`), preserving all variance numbers and justification notes permanently.
- **Operating Profit (P&L)**:
  - Computed on an accrual basis:
    $$\text{Operating Profit} = \text{Net Revenue} - \text{Total Operating Expenses}$$
    where $\text{Net Revenue} = \text{Gross Revenue (Finalized Invoices)} - \text{Completed Payment Refunds}$.
  - Excludes soft-deleted and rejected expenses.
  - Zero double-counting between returned items and refunds.
- **Branch Scoping & Timezone Integrity**:
  - Boundaries calculated using the authoritative branch timezone (e.g. `Asia/Kolkata`).
  - Single-closure checks strictly enforce one register closure per physical branch.

---

## 2. Multi-Tenancy & Scoping Rules

- **Branch Scoped**: Day-End register closures are strictly per physical salon location (`X-Branch-Id`).
- **Organization Scoped**: Operating Profit reports can be viewed per-branch or consolidated across the organization (omitting `X-Branch-Id`).

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Finance Summaries | `finance.view` | View day-end register closures and Operating Profit statements |
| Submit Day Closure | `finance.create` | Execute daily register drawer count submission |
| Manager Sign-off | `finance.edit` | Manager sign-off and approval of register closures |

---

## 4. Production Database Model Specification

### DayClosure (`src/models/finance/dayClosure.model.js`)
```ts
{
  organizationId: ObjectId,                 // ref: Organization, required, indexed
  branchId: ObjectId,                       // ref: Branch, required, indexed
  businessDate: String,                     // "YYYY-MM-DD"
  branchTimezone: String,                   // "Asia/Kolkata"
  systemTotals: {
    cash: Number,
    card: Number,
    upi: Number,
    other: Number,
    totalCollected: Number,
    totalRefunded: Number,
    netExpected: Number
  },
  physicalCounts: {
    cash: Number,
    card: Number,
    upi: Number,
    other: Number,
    totalCounted: Number
  },
  discrepancy: {
    cashDelta: Number,                      // physical - expected
    cardDelta: Number,
    upiDelta: Number,
    otherDelta: Number,
    totalDelta: Number,
    reason: String                          // Mandatory if any delta != 0
  },
  reconciliationResult: "balanced" | "discrepant",
  status: "submitted" | "approved",
  submittedBy: ObjectId,                    // ref: User
  submittedAt: Date,
  approvedBy: ObjectId,                     // ref: User
  approvedAt: Date,
  managerNotes: String
}
```

---

## 5. Production API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/finance/day-closure/system-totals` | `finance.view` | Real-time expected totals for a business date |
| `POST` | `/api/v1/finance/day-closure` | `finance.create` | Submit register drawer closure |
| `PATCH` | `/api/v1/finance/day-closure/:id/approve` | `finance.edit` | Manager approval & sign-off |
| `GET` | `/api/v1/finance/day-closure` | `finance.view` | List historical day closures |
| `GET` | `/api/v1/finance/day-closure/:id` | `finance.view` | View single day closure audit details |
| `GET` | `/api/v1/finance/operating-profit` | `finance.view` | Operating Profit P&L report for period |

---

## 6. Verification Status

- **Automated Integration Tests**: `backend/src/tests/finance/finance.integration.test.js`
- **Result**: 6/6 integration suites passing (Branch timezone tender aggregation, mandatory discrepancy justification, offsetting tender discrepancy detection, 409 duplicate closure prevention, manager sign-off preserving discrepancies, and Operating Profit revenue/expense calculations).
