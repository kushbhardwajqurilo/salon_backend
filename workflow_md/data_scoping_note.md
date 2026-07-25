# Data Scoping Classification Note

This document specifies the conceptual data scopes and client-side assumptions for the ERP features. Since the backend contract is not fully finalized, the frontend architecture relies on these scope boundaries to drive layout, authorization, and caching structures.

## Scope Definitions
1. **Organization Scope (Consolidated / All Branches)**: Data belonging to the entire company or group, not restricted to individual physical locations.
2. **Branch Scope (Branch-Specific)**: Transactions, operations, and resources isolated strictly to a single physical location.
3. **Hybrid Scope**: Global definitions with branch-specific overrides or configurations (e.g. pricing, status).

---

## Entity Scoping Table

| Entity | Expected Data Scope | Description / Frontend Assumptions |
| :--- | :--- | :--- |
| **Organization** | Organization-level | Details of the primary company (e.g., logo, corporate settings). |
| **Branch** | Branch-level | Specific details of a location (address, phone, business hours). |
| **User** | Organization-level | Authentication profile. Access to specific branches is controlled by user branch access mappings. |
| **Employee** | Hybrid | Profile is organization-level, but employee schedules, rosters, and branch assignments are branch-specific. |
| **Customer** | Hybrid | Global customer profiles to support visits across different locations, but visit histories and branch preferences are branch-specific. |
| **Service** | Hybrid | Global service catalog definitions, but availability, pricing, duration, and tax options can be configured on a branch-by-branch basis. |
| **Appointment** | Branch-level | Scoped strictly to the branch where the slot is booked. |
| **Membership** | Hybrid | Membership packages are defined organization-wide, but usage tracking and redemption histories are branch-specific. |
| **Coupon** | Hybrid | Setup and configuration are organization-wide, but eligibility and redemption details can be restricted to specific branches. |
| **Loyalty** | Organization-level | Point totals and loyalty tier rules are organization-wide to let customers redeem points at any branch. |
| **Billing** | Branch-level | POS transactions and invoices are strictly isolated to the branch where checkout occurs. |
| **Inventory** | Branch-level | Physical stock counts, orders, and adjustments are isolated per branch. |
| **Supplier** | Organization-level | Supplier directory is shared organization-wide, though purchase orders are scoped to target branches. |
| **Finance** | Branch & Organization | Branch-level registers and ledgers, with organization-level rollup reports. |
| **Reports** | Hybrid | Support branch-specific operational metrics and consolidated organization-wide rollups. |
| **Activity Logs**| Hybrid | Audit trails are logged centrally but include metadata tags for the branch context. |
| **Settings** | Hybrid | Core setup is organization-wide (e.g. currency, loyalty rules), but business configuration is branch-specific. |

---

## Core Frontend Architecture Assumptions
- **Customer Flexibility**: The customer database does *not* assume a customer is locked to a single branch. The data model allows a single customer profile to hold appointments, invoices, and visits spanning multiple branches.
- **Service Flexibility**: Service definitions are shared to avoid duplicating setup work. A stylist in Branch A can perform the same "Haircut" service as Branch B, but Branch A's price or tax rules may differ.
