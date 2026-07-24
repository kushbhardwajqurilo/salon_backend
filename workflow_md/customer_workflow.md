# Customer Profile & History Workflow

This document details the lifecycle, security, and operations on Customer records inside the Unisex Parlour ERP System.

---

## 1. Customer Creation (Registration)
1. **Endpoint**: `POST /api/v1/customers`
2. **Payload Check**: Zod validates schema bounds (`name`, `phone`, `email`, and `branchId`).
3. **Branch Isolation Check**:
   - The user's role permissions must include `customer:create`.
   - The user must belong to the branch specified in the payload (`branchId`) unless they are an administrator.
4. **Logic**:
   - Checks the phone number uniqueness in the system.
   - Saves the customer profile.
   - Appends a `CREATED` activity timeline record: `"Customer profile created successfully"`.

---

## 2. Reading Customer Profiles
- **Single Profile (`GET /api/v1/customers/:id`)**:
  - Requires `customer:view` permission.
  - Checks if the user is authorized to access the customer's branch (`verifyBranchAccess`). If unauthorized, blocks with `403 Forbidden`.
- **Filtered List (`GET /api/v1/customers`)**:
  - Queries customer list.
  - Automatically appends a MongoDB filter query: `branchId: { $in: req.user.branches }` if the user is not an administrator.
  - Supports searching (`name`, `phone`, `email` regex), pagination, filtering by branch, and custom sorting.

---

## 3. History logs & Incremental Updates
- **Visit History (`POST /:id/visits`)**:
  - Appends appointment logs (`appointmentId`, `date`, `totalAmount`, `status`) to the customer's `visits` array.
  - Appends activity log: `VISIT_RECORDED`.
- **Service History (`POST /:id/services`)**:
  - Records completed service descriptors.
  - Appends activity log: `SERVICE_COMPLETED`.
- **Membership history (`POST /:id/memberships`)**:
  - Registers membership subscriptions, start/end dates, and states.
  - Appends activity log: `MEMBERSHIP_ADDED`.
- **Loyalty Adjustments (`POST /:id/loyalty`)**:
  - Increments or decrements `loyaltyPoints`.
  - Appends activity log: `LOYALTY_ADJUSTED` documenting current values.
- **Notes addition (`POST /:id/notes`)**:
  - Appends text notes tracked by user ID and timestamp.
  - Appends activity log: `ADD_NOTE`.
- **Preferences (`PUT /:id/preferences`)**:
  - Modifies service preferences, preferred employees, and custom notes.
  - Appends activity log: `UPDATE_PREFERENCES`.

---

## 4. Deletion
- **Endpoint**: `DELETE /api/v1/customers/:id`
- **Logic**:
  - Asserts `customer:delete` and confirms branch permission.
  - Writes a `DELETED` activity timeline record.
  - Triggers soft-delete (sets `isDeleted: true` and `deletedAt = new Date()`), making the profile invisible to all standard queries.
