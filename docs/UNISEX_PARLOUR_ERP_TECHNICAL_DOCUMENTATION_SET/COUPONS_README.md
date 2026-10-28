# Coupons & Promotional Discounts Module — Specification & Status

```text
Module: Discount Coupons & Promotional Campaigns
Status: ⏳ PENDING / PLANNED
Layer: Marketing / POS Discount Engine
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Coupons & Discounts** module enables parlour managers to run targeted marketing campaigns (e.g. "DIWALI20", "NEWCLIENT500", "MONSOONSPA") to drive customer acquisition and salon occupancy.

### Key Capabilities Required
- Promo code generation with percentage discount (e.g. 20% off) or flat monetary discount (e.g. ₹500 off).
- Maximum discount caps on percentage promos (e.g. 20% up to ₹1,000 max).
- Eligibility constraints: Minimum cart value, date range, total usage caps, per-customer redemption limits.
- Scope constraints: Branch whitelists, service category eligibility (e.g. valid only on Hair Care).
- Validation and redemption directly inside the POS checkout engine.

---

## 2. Multi-Tenancy & Scoping Rules

- Configured organization-wide (`organizationId`) with optional branch restrictions (`applicableBranches: [branchId]`).
- Redemptions are validated in the active branch context during POS checkout.

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Coupons | `coupons.view` | View active and expired discount coupon codes |
| Configure Coupons | `coupons.configure` | Create, edit, or deactivate promo codes |
| Apply Coupon | `coupons.apply` | Validate and apply promo code at POS checkout |

---

## 4. Proposed Database Model Specification

**File Target**: `src/models/coupons/coupon.model.js`

```ts
{
  organizationId: ObjectId,         // ref: Organization, required, indexed
  code: String,                     // Uppercase alphanumeric (e.g. "DIWALI25"), unique per org
  title: String,                    // Human-readable title
  discountType: String,             // "percentage", "fixed_amount"
  discountValue: Number,            // 20 (% ) or 500 (₹)
  maxDiscountAmount: Number,        // Cap on percentage discounts
  minOrderValue: Number,            // Minimum invoice subtotal required
  startDate: Date,
  endDate: Date,
  totalUsageLimit: Number,          // Global redemption cap
  perCustomerLimit: Number,         // Max uses per client (default: 1)
  timesRedeemed: Number,            // Counter
  applicableBranches: [ObjectId],   // Empty = valid in all branches
  applicableCategories: [ObjectId], // Empty = valid on all services
  isActive: Boolean,
  isDeleted: Boolean
}
```

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/coupons` | `coupons.configure` | Create new promotional discount code |
| `GET` | `/api/v1/coupons` | `coupons.view` | List promotional coupons |
| `POST` | `/api/v1/coupons/validate` | `coupons.apply` | Validate coupon code against draft invoice |
| `DELETE` | `/api/v1/coupons/:id` | `coupons.configure` | Soft-deactivate coupon code |

---

## 6. Implementation Checklist

- [ ] Create `Coupon` model and compound index `{ organizationId: 1, code: 1 }`.
- [ ] Implement cart validation service checking date, min spend, branch, and category match.
- [ ] Connect POS checkout to atomically increment `timesRedeemed` inside MongoDB session.
- [ ] Mount `couponRouter` in `app.mjs`.
- [ ] Write tests verifying usage limit enforcement and discount cap mathematics.

