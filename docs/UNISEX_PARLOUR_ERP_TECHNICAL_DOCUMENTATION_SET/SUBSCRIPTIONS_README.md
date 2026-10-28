# Subscriptions & Membership Plans Module — Specification & Status

```text
Module: Subscriptions & Membership Packages
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Revenue / Customer Loyalty & Retainers
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: API_CONTRACT.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Subscriptions** module provides membership tiers, prepaid service packages, recurring value plans, and entitlement tracking for customers. It handles subscription plan configuration, customer purchases, secure OTP-verified entitlement redemptions, and mid-appointment upsells.

### Key Responsibilities
- Tiered subscription plan management (`SubscriptionPlan` model).
- Customer subscription instance tracking (`Subscription` model).
- Quota and entitlement decrement engine.
- 6-digit challenge OTP verification for entitlement redemptions.
- Mid-appointment subscription selling and instant benefit redemption.
- Complete redemption history audit ledger (`SubscriptionUsage`).

---

## 2. Multi-Tenancy & Scoping Rules

- **Plans**: Configured organization-wide (`organizationId`), with optional branch restrictions.
- **Sales & Redemptions**: Must be performed in an active branch context (`X-Branch-Id`).
- Multi-customer safeguards ensure entitlements are only consumed for the subscribed customer.

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View Subscriptions & Plans | `subscriptions.view` | View plans, customer subscriptions, and usage history |
| Configure Plans | `subscriptions.configure` | Create, update, or deactivate subscription plans |
| Sell Subscriptions | `subscriptions.sell` | Sell or renew plans to customers |
| Redeem Entitlements | `subscriptions.redeem` | Send OTP and redeem service entitlements |

---

## 4. Database Models & Schema Specifications

### SubscriptionPlan Model (`src/models/subscriptions/subscriptionPlan.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `name`: String (Required, trimmed, e.g. "Gold Annual Hair Care").
- `price`: Number (Required).
- `validityDays`: Number (e.g. 30, 90, 365).
- `services`: Array of:
  - `serviceId`: Ref `Service`.
  - `quota`: Number (Total allowable sessions, or -1 for unlimited).
  - `discountPercent`: Number.
- `status`: Enum (`active`, `inactive`).

### Subscription Model (`src/models/subscriptions/subscription.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `customerId`: Ref `Customer` (Required, Indexed).
- `planId`: Ref `SubscriptionPlan` (Required).
- `branchId`: Ref `Branch` (Purchase branch).
- `startDate`: Date.
- `expiryDate`: Date.
- `entitlements`: Array of `{ serviceId: ObjectId, totalQuota: Number, remainingQuota: Number }`.
- `status`: Enum (`active`, `expired`, `exhausted`, `cancelled`).

### SubscriptionUsage Model (`src/models/subscriptions/subscriptionUsage.model.js`)
- `subscriptionId`: Ref `Subscription` (Required).
- `appointmentId`: Ref `Appointment`.
- `serviceId`: Ref `Service`.
- `consumedAt`: Date.
- `verifiedByOtp`: Boolean.

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/subscription-plans` | `subscriptions.view` | List available subscription plans |
| `POST` | `/api/v1/subscription-plans` | `subscriptions.configure` | Create new plan |
| `GET` | `/api/v1/subscription-plans/:id` | `subscriptions.view` | Get plan details |
| `PUT` | `/api/v1/subscription-plans/:id` | `subscriptions.configure` | Update plan details |
| `DELETE` | `/api/v1/subscription-plans/:id` | `subscriptions.configure` | Soft-delete plan |
| `POST` | `/api/v1/subscriptions` | `subscriptions.sell` | Sell subscription to customer |
| `GET` | `/api/v1/subscriptions` | `subscriptions.view` | List customer subscriptions |
| `GET` | `/api/v1/subscriptions/:id` | `subscriptions.view` | Get subscription details and remaining quotas |
| `POST` | `/api/v1/subscriptions/:id/send-otp` | `subscriptions.redeem` | Send 6-digit challenge OTP for redemption |
| `POST` | `/api/v1/subscriptions/:id/redeem` | `subscriptions.redeem` | Verify OTP & decrement entitlement quota |
| `POST` | `/api/v1/subscriptions/:id/renew` | `subscriptions.sell` | Renew subscription |
| `GET` | `/api/v1/subscriptions/:id/usage` | `subscriptions.view` | View redemption audit ledger |

---

## 6. Testing & Verification

- **Test Files**:
  - `src/tests/subscriptions/subscriptionPlan.router.test.js`
  - `src/tests/subscriptions/subscription.router.test.js`
  - `src/tests/subscriptions/subscription.service.test.js`
  - `src/tests/subscriptions/subscription.redemption.test.js`
  - `src/tests/subscriptions/subscription.billing.upsell.integration.test.js`
  - `src/tests/subscriptions/subscription.multiCustomer.integration.test.js`
  - `src/tests/subscriptions/subscription.branchResolution.regression.test.js`
- **Result**: ✅ 100% Passed.

