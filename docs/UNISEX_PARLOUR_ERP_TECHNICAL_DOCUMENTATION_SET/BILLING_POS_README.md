# Billing & Point of Sale (POS) Module — Specification & Status

```text
Module: Billing, Checkout Queue & Payments (POS)
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Financial Operations / Cashier Terminal
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: API_CONTRACT.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Billing & Point of Sale (POS)** module manages cashier checkouts, invoice generation, multi-tender payments, tax accounting, and thermal/PDF receipts. It receives completed appointments directly from the appointment status engine and turns them into settled invoices.

### Key Responsibilities
- Real-time POS checkout queue (`/checkout-queue`) for front-desk cashiers.
- Draft invoice creation, updating, and finalization.
- Multi-item line items: Salon services, custom services, retail products, and membership sales.
- Comprehensive financial calculations: Subtotal, itemized taxes (CGST/SGST), discounts, rounding adjustments, and total payable.
- Multi-tender split payments (Cash, Card, UPI, NetBanking, Loyalty Points, Subscriptions).
- Payment voiding with automated balance restoration and ACID transaction safety.
- Printable PDF invoice receipt generation.

---

## 2. Multi-Tenancy & Scoping Rules

- **Branch-Scoped Terminal**: Invoicing and payment recording strictly require an active branch context (`X-Branch-Id`).
- Multi-branch users can inspect invoices across branches, but cashier checkouts occur in the active branch.

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View Invoices / Queue | `billing.view` | View POS checkout queue and invoice records |
| Create & Finalize Invoice | `billing.checkout` | Create, edit draft, and finalize invoices |
| Cancel Invoice | `billing.void` | Cancel draft or unfinalized invoices |
| View Payments | `payments.view` | View payment transaction details |
| Receive Payments | `payments.receive` | Record incoming payments against an invoice |
| Void Payment / Refund | `payments.refund` | Void payment and reverse invoice settlement |

---

## 4. Database Models & Schema Specifications

### Invoice Model (`src/models/billing/invoice.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `branchId`: Ref `Branch` (Required, Indexed).
- `invoiceNumber`: String (Unique sequential format, e.g. `INV-20261028-0001`).
- `appointmentId`: Ref `Appointment` (Optional/Linked).
- `customerId`: Ref `Customer` (Required, Indexed).
- `items`: Array of:
  - `itemType`: Enum (`service`, `custom_service`, `product`, `subscription`).
  - `itemId`: ObjectId.
  - `name`: String.
  - `quantity`: Number.
  - `unitPrice`: Number.
  - `discountAmount`: Number.
  - `taxRate`: Number.
  - `taxAmount`: Number.
  - `totalPrice`: Number.
- `subtotal`: Number.
- `discountTotal`: Number.
- `taxTotal`: Number.
- `roundingAdjustment`: Number.
- `grandTotal`: Number.
- `paidAmount`: Number (Default: 0).
- `balanceDue`: Number.
- `status`: Enum (`draft`, `finalized`, `cancelled`).

### Payment Model (`src/models/billing/payment.model.js`)
- `organizationId`: Ref `Organization` (Required).
- `branchId`: Ref `Branch` (Required).
- `invoiceId`: Ref `Invoice` (Required, Indexed).
- `paymentMethod`: Enum (`cash`, `card`, `upi`, `netbanking`, `loyalty_points`, `subscription`).
- `amount`: Number (Required).
- `transactionReference`: String.
- `status`: Enum (`completed`, `voided`).
- `voidReason`: String.

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/billing/checkout-queue` | `billing.view` / `billing.checkout` | Get queue of appointments ready for cashier checkout |
| `POST` | `/api/v1/billing/invoices` | `billing.checkout` | Create new draft invoice |
| `GET` | `/api/v1/billing/invoices` | `billing.view` | List invoices by branch, date range, customer, or status |
| `GET` | `/api/v1/billing/invoices/:id` | `billing.view` | Get invoice details |
| `GET` | `/api/v1/billing/invoices/:id/pdf` | `billing.view` | Render printable PDF receipt |
| `PATCH` | `/api/v1/billing/invoices/:id` | `billing.checkout` | Update draft invoice items |
| `POST` | `/api/v1/billing/invoices/:id/finalize` | `billing.checkout` | Finalize and lock invoice |
| `POST` | `/api/v1/billing/invoices/:id/cancel` | `billing.void` | Cancel invoice |
| `POST` | `/api/v1/billing/invoices/:id/payments` | `payments.receive` | Record payment transaction |
| `GET` | `/api/v1/billing/invoices/:id/payments` | `payments.view` | List payments for invoice |
| `POST` | `/api/v1/billing/payments/:paymentId/void` | `payments.refund` | Void payment and restore balance |

---

## 6. Testing & Verification

- **Test Files**:
  - `src/tests/billing/billing.test.js`
  - `src/tests/billing/checkoutQueue.test.js`
  - `src/tests/billing/transaction.safety.test.js`
- **Result**: ✅ 100% Passed.

