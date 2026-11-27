# Notifications & Automation — Project Progress

## Approved Stages Summary

- **Stage 1 & 1.1**: Architecture & validation audit complete.
- **Stage 2A**: `OutboxEvent` model, `notificationEventContract.js`, and session-aware `outbox.service.js` (12/12 unit tests passed).
- **Stage 2B**: `outboxRelay.service.js` with atomic `findOneAndUpdate` claiming, `claimedBy` ownership checks, stale-claim recovery, and bounded backoff (5/5 unit tests passed).
- **Stage 2C**: `Notification` model, `recipientResolver.service.js`, and `notificationOrchestrator.service.js` (5/5 unit tests passed).
- **Stage 2D**: `channelAdapters.service.js` (Email/SMS) and `appointmentReminderOutbox.service.js` (4/4 unit tests passed).
- **Stage 2E (Appointments)**: Feature-flagged (`USE_OUTBOX_APPOINTMENT_REMINDERS`) outbox activation in `appointment.service.js` (3/3 unit tests passed).

---

## Stage 2E — Billing Integration (Handover)

### Implemented Billing Events

- `invoice.created` (wired in `createInvoiceFromAppointment()`, `createInvoiceForSubscriptionSale()`, `createRetailInvoice()`, `createUnifiedInvoice()`)
- `invoice.payment_recorded` (wired in `recordPayment()`)
- `invoice.partial_payment` (wired in `recordPayment()`, only when `paymentStatus === "partial"`)
- `invoice.settled` (wired in `recordPayment()`, only when `paymentStatus === "paid"`)
- `invoice.payment_reversed` (wired in `voidPayment()`)
- `invoice.voided` (wired in invoice cancellation flow where `invoice.status = "cancelled"`)
- `invoice.refunded` (wired in `refundUnusedMembershipLine()`, after `refundPayment[0]` & `handlePurchaseRefundProcessed`)

### Provisional Event

- `invoice.payment_failed` — remains provisional; no verified asynchronous gateway failure event source exists in `billing.service.js`.

### Architectural Safeguards

- All transactional outbox writes are `await`ed and receive the active MongoDB `session`.
- `payerCustomerId` and `beneficiaryCustomerId` remain distinct.
- Payment status is never used to infer subscription or membership entitlement activation.
- Refund events require a persisted monetary refund operation (`refundPayment[0]._id`).

### Verification Status

- `billingNotifications.test.js`: **2/2 passed** (Jest mocks for `OutboxEvent`).
- `checkoutQueue.test.js`: **6/6 passed** (live MongoDB).
- **Total**: **2 suites, 8/8 tests passed**.
- **Pending**: Live MongoDB replica-set transaction rollback verification for `billing.service.js` outbox writes remains pending; billing integration is **not** yet fully production-verified.

---

## Stage 2G.1 — Leave Status Notifications

- **Implemented Events**: `leave.approved` (`approveLeave`), `leave.rejected` (`rejectLeave`), `leave.cancelled` (`cancelLeave` / `leaveNotificationOutbox.service.js`).
- **Recipient Behaviour**: Employee-only (`employeeUserId`, `purpose: "operational"`, `isActive: true`, same `organizationId`).
- **Payload & Idempotency**: `{ leaveId, employeeUserId, status, branchId }` (no medical/leave reasons); key `${eventType}:${leave._id}`.
- **Verification**: `leaveStatusNotifications.test.js` (2/2) & `leave.service.test.js` (21/21) passed. Live MongoDB replica-set transaction rollback verification remains pending.

---

## Stage 2G.2 — Payroll Payslip Published Notifications

- **Implemented Event**: `payroll.payslip_published` (`payrollNotificationOutbox.service.js`, `approvePayrollRecord` flow).
- **Payload & Idempotency**: `{ payslipId, employeeUserId, branchId, portalLinkOnly: true }` (zero salary/bank/PDF URLs); key `payroll.payslip_published:${payrollRecord._id}`.
- **Recipient & Security**: Employee-only (`isActive: true`, `purpose: "payroll"`, same `organizationId`); `/records/:id/payslip-pdf` requires authentication.
- **Verification**: `payrollPayslipNotifications.test.js` & `payroll.test.js` executed. Live MongoDB replica-set verification remains pending.
