# Attendance & Biometric Punch Module — Specification & Status

```text
Module: Staff Attendance, Punches & Biometrics
Status: ⏳ PENDING / PLANNED
Layer: Human Resources / Daily Operations
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Attendance** module captures daily working hours, punctuality, shift adherence, break durations, and overtime for salon staff. Accurate attendance is the primary prerequisite for monthly payroll and commission processing.

### Key Capabilities Required
- Daily clock-in / clock-out punches from multiple sources: Salon kiosk tablet, biometric fingerprint device, or geofenced mobile check-in.
- Break time recording (tea break, lunch break).
- Monthly muster roll generation (present, absent, late, half-day, on-leave).
- Manager attendance regularization for missed punches or biometric device failures.
- Integration with approved leaves from the `Leaves` module.

---

## 2. Multi-Tenancy & Scoping Rules

- **Branch Scoped**: Punches are tied to the physical salon location (`X-Branch-Id`).
- Staff members can only record attendance at branches they are actively assigned to via `StaffBranch`.

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Attendance | `attendance.view` | View attendance logs, daily registers, and muster roll |
| Record Punch | `attendance.punch` | Clock-in, clock-out, or break punch |
| Regularize Attendance | `attendance.adjust` | Manager manual adjustment or punch correction |

---

## 4. Proposed Database Model Specification

**File Target**: `src/models/attendance/attendance.model.js`

```ts
{
  organizationId: ObjectId,         // ref: Organization, required, indexed
  branchId: ObjectId,               // ref: Branch, required, indexed
  staffId: ObjectId,                // ref: Staff, required, indexed
  date: String,                     // "YYYY-MM-DD" UTC string, indexed
  shiftType: String,                // "general", "morning", "evening", "full_day"
  checkInTime: Date,
  checkOutTime: Date,
  totalWorkMinutes: Number,         // Calculated duration
  totalBreakMinutes: Number,        // Calculated break time
  punches: [
    {
      punchType: String,            // "CHECK_IN", "CHECK_OUT", "BREAK_START", "BREAK_END"
      timestamp: Date,
      source: String,               // "kiosk", "biometric", "mobile", "manual"
      deviceIp: String,
      coordinates: { latitude: Number, longitude: Number }
    }
  ],
  status: String,                   // "present", "absent", "half_day", "leave", "holiday"
  isRegularized: Boolean,           // default: false
  regularizedBy: ObjectId,          // ref: User
  regularizationReason: String,
  notes: String
}
```

### Compound Unique Index
`{ organizationId: 1, staffId: 1, date: 1 }` (Ensures exactly one daily attendance container per staff member).

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `POST` | `/api/v1/attendance/punch` | `attendance.punch` | Record clock-in or clock-out punch |
| `GET` | `/api/v1/attendance` | `attendance.view` | Query daily attendance register by branch and date |
| `GET` | `/api/v1/attendance/muster-roll` | `attendance.view` | Monthly attendance grid matrix for payroll |
| `PATCH` | `/api/v1/attendance/:id/regularize` | `attendance.adjust` | Manager regularization for missed punches |

---

## 6. Implementation Checklist

- [ ] Create `Attendance` model in `src/models/attendance/attendance.model.js`.
- [ ] Implement `AttendanceRepository` extending `BaseRepository`.
- [ ] Implement `AttendanceService` with auto-calculation of work/break minutes.
- [ ] Create Zod validation schemas in `src/validation/attendance/attendance.validation.js`.
- [ ] Mount `attendanceRouter` under `/api/v1/attendance` in `app.mjs`.
- [ ] Write Jest test suites for punch recording, geofence checks, and regularization.

