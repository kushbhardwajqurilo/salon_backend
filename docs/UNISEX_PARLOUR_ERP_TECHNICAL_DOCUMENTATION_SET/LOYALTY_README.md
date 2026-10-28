# Loyalty Program Module — Specification & Status

```text
Module: Customer Loyalty & Rewards Program
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Customer Retention / Points Ledger
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: API_CONTRACT.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Loyalty Program** module incentives repeat client visits by awarding reward points on purchases and allowing redemption as a discount tender during checkout.

### Key Responsibilities
- Organization-wide loyalty program configuration (earn rate, burn value, expiry).
- Double-entry customer points ledger (`LoyaltyTransaction`).
- Real-time side-effect-free redemption preview (`/preview-redemption`).
- Manual points adjustment by authorized managers with mandatory audit notes.
- Synchronized customer balance tracking.

---

## 2. Multi-Tenancy & Scoping Rules

- Program configuration is organization-wide (`organizationId`).
- Customer ledger queries and manual adjustments require active organization and branch validation.

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View Loyalty Program & Ledger | `loyalty.view` | View program rules, customer ledger, and preview redemptions |
| Configure Program Rules | `loyalty.configure` | Update earn ratios, redemption values, minimum balances |
| Manual Points Adjustment | `loyalty.adjust` | Add or deduct points manually with audit explanation |

---

## 4. Database Models & Schema Specifications

### LoyaltyProgramConfig Model (`src/models/loyalty/loyaltyProgramConfig.model.js`)
- `organizationId`: Ref `Organization` (Required, Unique per org).
- `earnRate`: Number (Points awarded per ₹100 spent, e.g. 5 points).
- `redemptionValue`: Number (Monetary value in ₹ per 1 point redeemed, e.g. ₹0.50).
- `minPointsToRedeem`: Number (e.g. 100 points).
- `maxRedemptionPercent`: Number (Max % of invoice subtotal payable via loyalty).
- `pointsExpiryDays`: Number (Default: 365 days).
- `isActive`: Boolean (Default: `true`).

### LoyaltyTransaction Model (`src/models/loyalty/loyaltyTransaction.model.js`)
- `organizationId`: Ref `Organization` (Required).
- `branchId`: Ref `Branch` (Required).
- `customerId`: Ref `Customer` (Required, Indexed).
- `type`: Enum (`earn`, `redeem`, `manual_credit`, `manual_debit`, `expired`).
- `points`: Number (Positive or negative delta).
- `balanceAfter`: Number.
- `invoiceId`: Ref `Invoice` (Optional/Linked).
- `reason`: String.
- `performedBy`: Ref `User`.

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/loyalty/program` | `loyalty.view` | Get organization loyalty rules and ratios |
| `PUT` | `/api/v1/loyalty/program` | `loyalty.configure` | Update earn and redemption configuration |
| `GET` | `/api/v1/loyalty/preview-redemption` | `loyalty.view` | Calculate points value against a subtotal |
| `GET` | `/api/v1/loyalty/customers/:customerId/ledger` | `loyalty.view` | Paginated transaction history for a customer |
| `POST` | `/api/v1/loyalty/customers/:customerId/adjust` | `loyalty.adjust` | Manually credit or debit customer points |

---

## 6. Testing & Verification

- **Test Files**: `src/tests/loyalty/loyalty.test.js`.
- **Result**: ✅ 100% Passed.

