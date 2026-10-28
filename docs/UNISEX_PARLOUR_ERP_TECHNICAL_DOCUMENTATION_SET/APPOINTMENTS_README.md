# Appointments & Scheduling Module — Specification & Status

```text
Module: Appointments & Booking Engine
Status: ✅ COMPLETED & TESTED (100% Passing)
Layer: Core Operational Engine
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Related Specs: APPOINTMENTS_ARCHITECTURE_DECISION.md
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Responsibilities

The **Appointments** module is the central scheduling and workflow engine of the parlour. It coordinates clients, services, staff assignments, chair availability, and status transitions leading directly into the billing checkout queue.

### Key Responsibilities
- Sequential booking reference code (`APT-YYYYMMDD-XXXX`) via `Sequence` model.
- Complete operational lifecycle machine: `booked` ➔ `confirmed` ➔ `in-progress` ➔ `completed` / `cancelled` / `no-show`.
- Staff assignment, reassignment, and conflict detection against approved leaves and overlapping bookings.
- Dynamic service adjustments (preview duration/pricing impact, commit changes).
- Support for ad-hoc / unlisted custom services with manual pricing.
- Automated customer visited-branch registration side-effect on completion.
- Mid-appointment subscription upsell & entitlement redemption OTP workflows.

---

## 2. Multi-Tenancy & Scoping Rules

- **Branch-Scoped Mutations**: Every appointment mutation requires a valid target branch (`X-Branch-Id` or `body.branchId`).
- The caller must possess access to the target branch.
- Rejection of `"all"` sentinel string.

---

## 3. RBAC & Canonical Permissions

| Action / Capability | Permission Key | Description |
|:---|:---|:---|
| View Appointments | `appointments.view` | View booking calendar and details |
| Book Appointment | `appointments.create` | Create new appointment |
| Reschedule | `appointments.reschedule` | Change appointment time, date, or branch |
| Assign Staff | `appointments.assign_staff` | Allocate or change stylist |
| Update Status | `appointments.update_status` | Advance status (confirmed, in-progress, completed) |
| Cancel Appointment | `appointments.cancel` | Cancel booking |
| Early Start Override | `appointments.force_early_start` | Start appointment before scheduled time window |
| Trigger Reminders | `appointments.reminders.send` | Queue BullMQ appointment reminder notifications |

---

## 4. Database Models & Schema Specifications

### Appointment Model (`src/models/appointments/appointment.model.js`)
- `organizationId`: Ref `Organization` (Required, Indexed).
- `branchId`: Ref `Branch` (Required, Indexed).
- `appointmentCode`: String (Unique, e.g. `APT-20261028-0001`).
- `customerId`: Ref `Customer` (Required, Indexed).
- `staffId`: Ref `Staff` (Optional/Assigned).
- `services`: Array of items:
  - `serviceId`: Ref `Service` (Optional if custom service).
  - `name`: String (Required).
  - `duration`: Number (Minutes).
  - `price`: Number.
  - `isCustom`: Boolean (Default: `false`).
- `scheduledStartTime`: Date (Required).
- `scheduledEndTime`: Date (Required).
- `totalDuration`: Number (Minutes).
- `totalEstimatedPrice`: Number.
- `status`: Enum (`booked`, `confirmed`, `in-progress`, `completed`, `cancelled`, `no-show`).
- `notes`: String.

---

## 5. API Endpoints & Request Contracts

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/appointments` | `appointments.create` | Book new appointment |
| `GET` | `/api/v1/appointments` | `appointments.view` | List appointments with date, branch, staff, customer filters |
| `GET` | `/api/v1/appointments/:id` | `appointments.view` | Get appointment detail |
| `PUT` | `/api/v1/appointments/:id` | `appointments.create` | Update appointment details |
| `PATCH` | `/api/v1/appointments/:id/reschedule` | `appointments.reschedule` | Reschedule booking time/date |
| `PATCH` | `/api/v1/appointments/:id/assign-staff` | `appointments.assign_staff` | Assign or change stylist |
| `PATCH` | `/api/v1/appointments/:id/status` | `appointments.update_status` / `cancel` | Status progression |
| `DELETE` | `/api/v1/appointments/:id` | `appointments.delete` | Soft-delete / cancel appointment |
| `POST` | `/api/v1/appointments/:id/services/preview` | `appointments.edit` | Preview pricing/time impact of service changes |
| `POST` | `/api/v1/appointments/:id/services/commit` | `appointments.edit` | Commit service changes to appointment |
| `POST` | `/api/v1/appointments/:id/request-consumption-otp` | `subscriptions.redeem` | Request SMS OTP for subscription redemption |
| `POST` | `/api/v1/appointments/:id/complete-with-subscription` | `appointments.update_status` + `subscriptions.redeem` | Complete appointment using plan entitlement |
| `POST` | `/api/v1/appointments/:id/upsell-subscription` | `subscriptions.sell` | Sell plan and redeem immediately |

---

## 6. Testing & Verification

- **Test Files**:
  - `src/tests/appointments/appointment.router.test.js`
  - `src/tests/appointments/appointment.service.test.js`
  - `src/tests/appointments/appointment.customServices.test.js`
  - `src/tests/appointments/appointment.subscription.integration.test.js`
- **Result**: ✅ 100% Passed.

