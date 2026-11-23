# Expenses & Petty Cash Management Module — Specification & Status

```text
Module: Branch Expenses & Petty Cash Drawer
Status: ✅ IMPLEMENTED & VERIFIED
Layer: Financial Operations / Branch Accounting
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-11-21
```

---

## 1. Domain Overview & Business Purpose

The **Expenses** module tracks daily salon expenditures and maintains an append-only petty cash ledger. Salon managers handle out-of-pocket operational costs (refreshments for clients, laundry, cleaning supplies, minor salon repairs, local delivery fees, utility bills).

### Key Architectural Capabilities
- Daily expense logging with vendor/payee name, category, amount, and receipt photo upload.
- **Append-Only Petty Cash Ledger**: Zero in-place edits or deletions (`isDeleted` removed). Only forward-moving transactions: `opening_balance`, `replenishment`, `expense_payout`, and `payout_reversal`.
- **Derived Ledger Balance**: Balance is dynamically computed from ledger sum in real-time or snapshot aggregation.
- **Atomic Threshold Approval Workflow**:
  - Configurable threshold stored on `organization.expenseApprovalThreshold` (default: ₹5,000).
  - Snapshot stored on `expense.approvalThresholdAtCreation`.
  - Under threshold: `approvalStatus: "approved"`, `paymentStatus: "settled"`, immediate atomic ledger payout record created in same ACID transaction.
  - Over threshold: `approvalStatus: "pending"`, `paymentStatus: "pending"`, zero payout until explicit manager sign-off via `/approve`.
- **Atomic Sequence Generation**: Sequences `EXP-YYYYMMDD-XXXX` and `PC-YYYYMMDD-XXXX` incremented atomically without race conditions.
- **Serialized Cumulative Recovery**: Reversals (`payout_reversal`) can only be generated via the explicit recovery endpoint `/recover-payout` with idempotency protection. Cumulative recoveries cannot exceed the original payout amount under concurrency.
- **Branch Isolation**: Strict scoping to physical salon branches via `X-Branch-Id`.

---

## 2. Multi-Tenancy & Scoping Rules

- **Branch Scoped**: Operational expenses and petty cash drawers are tied to the physical salon location where cash was disbursed (`X-Branch-Id`).
- **Organization Scoped**: Organization-wide category rules and threshold configurations (`expenseApprovalThreshold`).

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Expenses | `expenses.view` | View branch expense records and petty cash ledger |
| Create Expense | `expenses.create` | Record new daily operational expense |
| Edit Expense | `expenses.update` | Edit expense category or details |
| Delete Expense | `expenses.delete` | Soft-delete expense record (does NOT touch ledger) |
| Approve Expense | `expenses.approve` | Approve high-value expense and disburse cash |
| Reject Expense | `expenses.reject` | Reject pending or settled high-value expense |
| Replenish Drawer | `expenses.replenish` | Add cash to branch petty cash ledger |
| Recover Payout | `expenses.recover` | Record physical cash recovery from vendor |

---

## 4. Production Database Model Specification

### Expense (`src/models/expenses/expense.model.js`)
```ts
{
  organizationId: ObjectId,                 // ref: Organization, required, indexed
  branchId: ObjectId,                       // ref: Branch, required, indexed
  expenseCode: String,                      // "EXP-YYYYMMDD-XXXX" via atomic Sequence
  category: String,                         // Configurable or standard operational category
  amount: Number,                           // Gross amount paid
  paymentMethod: String,                    // "petty_cash" | "upi" | "card" | "bank_transfer"
  payeeName: String,                        // Vendor or person receiving cash
  invoiceNumber: String,                    // Vendor bill number
  receiptImageUrl: String,                  // Uploaded receipt URL
  description: String,
  expenseDate: Date,
  approvalStatus: "pending" | "approved" | "rejected",
  paymentStatus: "pending" | "settled",
  approvalThresholdAtCreation: Number,
  recordedBy: ObjectId,                     // ref: User (Cashier / Manager)
  approvedBy: ObjectId,                     // ref: User (Manager / Owner)
  approvedAt: Date,
  rejectionReason: String,
  isDeleted: Boolean                        // Soft delete (audit-preserved)
}
```

### Petty Cash Ledger (`src/models/expenses/pettyCash.model.js`)
```ts
{
  organizationId: ObjectId,                 // ref: Organization, required, indexed
  branchId: ObjectId,                       // ref: Branch, required, indexed
  transactionCode: String,                  // "PC-YYYYMMDD-XXXX" via atomic Sequence
  type: "opening_balance" | "replenishment" | "expense_payout" | "payout_reversal",
  amount: Number,                           // Positive value
  balanceAfter: Number,                     // Running snapshot
  expenseId: ObjectId,                     // ref: Expense (for payouts)
  originalTransactionId: ObjectId,         // ref: PettyCashTransaction (for reversals)
  recoveredAmount: Number,                  // Atomic cumulative recovery tracking
  idempotencyKey: String,                   // Partial unique index scoped to organization
  notes: String,
  performedBy: ObjectId                     // ref: User
}
```

---

## 5. Production API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/expenses` | `expenses.create` | Record new operational expense |
| `GET` | `/api/v1/expenses` | `expenses.view` | Paginated branch expenses with filters |
| `GET` | `/api/v1/expenses/:id` | `expenses.view` | Get expense details and receipt image |
| `PATCH` | `/api/v1/expenses/:id` | `expenses.update` | Update expense record |
| `DELETE` | `/api/v1/expenses/:id` | `expenses.delete` | Soft-delete expense |
| `PATCH` | `/api/v1/expenses/:id/approve` | `expenses.approve` | Approve high-value expense (disburses payout) |
| `PATCH` | `/api/v1/expenses/:id/reject` | `expenses.reject` | Reject high-value expense |
| `GET` | `/api/v1/expenses/summary` | `expenses.view` | Category-wise expense distribution summary |
| `GET` | `/api/v1/expenses/petty-cash/balance` | `expenses.view` | Real-time petty cash balance |
| `GET` | `/api/v1/expenses/petty-cash/ledger` | `expenses.view` | Append-only ledger transactions |
| `POST` | `/api/v1/expenses/petty-cash/replenish` | `expenses.replenish` | Replenish petty cash drawer |
| `POST` | `/api/v1/expenses/petty-cash/recover-payout` | `expenses.recover` | Recover cash from vendor |

---

## 6. Verification Status

- **Automated Integration Tests**: `backend/src/tests/expenses/expenses.integration.test.js`
- **Result**: 9/9 integration suites passing (ACID multi-document transactions, atomic sequences, approval payouts, serialized cumulative recoveries, idempotency, and soft-delete protections).
