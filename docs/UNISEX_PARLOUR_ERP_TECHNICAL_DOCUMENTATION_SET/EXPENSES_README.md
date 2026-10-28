# Expenses & Petty Cash Management Module — Specification & Status

```text
Module: Branch Expenses & Petty Cash Drawer
Status: ⏳ PENDING / PLANNED
Layer: Financial Operations / Branch Accounting
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Expenses** module tracks daily salon expenditures and petty cash drawer balances. Salon managers handle frequent out-of-pocket operational costs (refreshments for clients, laundry of towels/robes, cleaning supplies, minor salon repairs, local delivery fees, utility bills).

### Key Capabilities Required
- Daily expense logging with vendor/payee name, category, amount, and receipt photo upload.
- Petty cash register tracking (opening cash balance, cash inflows from drawer, cash payouts, closing balance).
- Expense category taxonomy (Utilities, Maintenance, Salon Consumables, Client Refreshments, Marketing).
- Manager approval workflow for high-value expenses.
- Branch-level expense reporting vs organization-wide P&L integration.

---

## 2. Multi-Tenancy & Scoping Rules

- **Branch Scoped**: Expenses are tied to the physical salon location where cash was disbursed (`X-Branch-Id`).
- Category taxonomies can be defined organization-wide with branch overrides.

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Expenses | `expenses.view` | View branch expense records and petty cash ledger |
| Create Expense | `expenses.create` | Record new daily expense payout |
| Edit Expense | `expenses.update` | Edit expense category or details |
| Delete Expense | `expenses.delete` | Soft-delete / void expense entry |

---

## 4. Proposed Database Model Specification

**File Target**: `src/models/expenses/expense.model.js`

```ts
{
  organizationId: ObjectId,         // ref: Organization, required, indexed
  branchId: ObjectId,               // ref: Branch, required, indexed
  expenseCode: String,              // "EXP-YYYYMMDD-XXXX" via atomic Sequence
  category: String,                 // "utilities", "maintenance", "refreshments", "laundry", "cleaning", "supplies"
  amount: Number,                   // Gross amount paid
  paymentMethod: String,            // "petty_cash", "upi", "card", "bank_transfer"
  payeeName: String,                // Vendor or person receiving cash
  invoiceNumber: String,            // Vendor bill number
  receiptImageUrl: String,          // Cloudinary URL
  description: String,
  expenseDate: Date,
  recordedBy: ObjectId,             // ref: User (Cashier / Manager)
  approvedBy: ObjectId,             // ref: User (Manager / Owner)
  isDeleted: Boolean
}
```

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/expenses` | `expenses.create` | Record new branch expense |
| `GET` | `/api/v1/expenses` | `expenses.view` | Paginated branch expenses with date/category filters |
| `GET` | `/api/v1/expenses/:id` | `expenses.view` | Get expense details and receipt image |
| `PUT` | `/api/v1/expenses/:id` | `expenses.update` | Update expense record |
| `DELETE` | `/api/v1/expenses/:id` | `expenses.delete` | Soft-delete expense |
| `GET` | `/api/v1/expenses/summary` | `expenses.view` | Category-wise expense distribution summary |

---

## 6. Implementation Checklist

- [ ] Create `Expense` model with `auditPlugin` in `src/models/expenses/expense.model.js`.
- [ ] Connect `uploadRouter` for direct Cloudinary receipt uploads.
- [ ] Create Zod validation schema for expense inputs.
- [ ] Implement `ExpenseRepository` and `ExpenseService`.
- [ ] Mount `expenseRouter` in `app.mjs`.
- [ ] Write unit & integration tests covering branch scoping, permission denials, and soft deletes.

