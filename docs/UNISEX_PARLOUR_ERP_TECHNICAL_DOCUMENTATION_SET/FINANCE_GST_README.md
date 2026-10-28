# Finance, Day-End & GST Tax Module — Specification & Status

```text
Module: Financial Accounting, Register Closures & GST Tax Reports
Status: ⏳ PENDING / PLANNED
Layer: Financial Governance / Tax Compliance
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Finance & GST** module manages end-of-day cashier drawer reconciliations, store closure sign-offs, profit & loss analysis, and statutory GST (Goods & Services Tax) reporting for Indian salon operations.

### Key Capabilities Required
- Day-End (EOD) Register Closure: Front-desk cashier counts physical cash in the drawer, compares it with system billing totals, and logs discrepancy reasons.
- Multi-tender reconciliation: Verifies Cash, Credit Card EDC slips, UPI payment settlement screenshots.
- GSTR-1 Monthly Report: Aggregates outward taxable supplies, HSN/SAC code breakdowns, CGST (Central Tax), SGST (State Tax), and IGST (Integrated Tax).
- Net Profit & Loss (P&L) statement: Aggregates revenue from `Invoice` items against branch operational `Expense` items.

---

## 2. Multi-Tenancy & Scoping Rules

- **Branch Scoped**: Day-End register closures are executed per physical branch location (`X-Branch-Id`).
- **Organization Scoped**: GST reports and Profit & Loss statements aggregate across all branches for corporate filing.

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Finance Summaries | `finance.view` | View day-end register closures, P&L reports |
| Submit Day Closure | `finance.create` | Execute daily register drawer count submission |
| Reconcile Discrepancies | `finance.edit` | Manager adjustment of cash drawer discrepancies |
| Generate GST Tax Reports | `finance.gst_report` | Export statutory GSTR-1 / GSTR-3B monthly tax summaries |

---

## 4. Proposed Database Model Specification

**File Target**: `src/models/finance/dayClosure.model.js`

```ts
{
  organizationId: ObjectId,         // ref: Organization, required
  branchId: ObjectId,               // ref: Branch, required
  closureDate: String,              // "YYYY-MM-DD" UTC
  cashierId: ObjectId,              // ref: User
  systemTotals: {
    cashExpected: Number,
    cardExpected: Number,
    upiExpected: Number,
    totalBilled: Number
  },
  physicalCount: {
    cashActual: Number,
    cardSlipsActual: Number,
    upiVerifiedActual: Number
  },
  discrepancy: {
    cashDelta: Number,              // actual - expected
    reason: String
  },
  status: String,                   // "balanced", "discrepant", "manager_approved"
  managerId: ObjectId,              // ref: User
  managerNotes: String,
  closedAt: Date
}
```

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/finance/day-closure` | `finance.create` | Submit cashier EOD cash drawer count |
| `GET` | `/api/v1/finance/day-closure` | `finance.view` | List past register closures |
| `PATCH` | `/api/v1/finance/day-closure/:id/approve` | `finance.edit` | Manager sign-off on cash discrepancy |
| `GET` | `/api/v1/finance/gst-report` | `finance.gst_report` | Monthly GSTR-1 report (HSN/SAC split, CGST/SGST/IGST) |
| `GET` | `/api/v1/finance/pnl` | `finance.view` | Net Profit & Loss report (Revenue vs Expenses) |

---

## 6. Implementation Checklist

- [ ] Create `DayClosure` model in `src/models/finance/`.
- [ ] Implement aggregation service summing daily finalized `Payment` records grouped by tender.
- [ ] Build tax aggregation pipeline querying finalized `Invoice` items grouped by HSN/SAC code.
- [ ] Mount `financeRouter` in `app.mjs`.
- [ ] Write integration tests for cash discrepancy math and GST export.

