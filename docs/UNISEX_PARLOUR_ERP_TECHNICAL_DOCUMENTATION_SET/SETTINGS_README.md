# Settings, Salon Hours & Backups Module — Specification & Status

```text
Module: Salon Settings, Operating Hours & Automated Backups
Status: ⏳ PENDING / PLANNED
Layer: Platform Governance & DevOps
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Settings & Salon Configuration** module manages salon operating schedules, annual holiday calendars, tax defaults, numbering sequence rules, invoice policies, and automated database backups.

### Key Capabilities Required
- Branch Operating Schedule: Store opening and closing hours per day of the week, lunch break windows, and scheduled weekly off days.
- Annual Holiday Calendar: Gazetted holidays and salon maintenance closure dates.
- Tax & Billing Defaults: Organization GSTIN, default CGST/SGST rates, invoice footer terms & conditions, refund policy text.
- Sequential Code Numbering Configuration: Customizable prefixes for invoices (`INV-`), appointments (`APT-`), staff (`STF-`), and expenses (`EXP-`).
- Automated Database Backups: Nightly scheduled MongoDB database dumps archive snapshots with S3/local retention policies and on-demand trigger.

---

## 2. Multi-Tenancy & Scoping Rules

- Corporate settings and tax defaults are Organization-wide (`organizationId`).
- Operating hours and holiday schedules can be configured per Branch (`branchId`).

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Settings | `settings.view` | View salon operating configuration, hours, and backup status |
| Update Settings | `settings.update` | Update store hours, holidays, tax rules, invoice terms |
| Manage Backups | `settings.backups` | Trigger on-demand backup snapshot or download archive |

---

## 4. Proposed Database Model Specification

**File Target**: `src/models/settings/organizationSettings.model.js`

```ts
{
  organizationId: ObjectId,         // ref: Organization, required, unique
  branchHours: [
    {
      branchId: ObjectId,           // ref: Branch
      dayOfWeek: Number,            // 0 = Sunday, 1 = Monday, ... 6 = Saturday
      isOpen: Boolean,
      openingTime: String,          // "09:00"
      closingTime: String,          // "21:00"
      breakStart: String,
      breakEnd: String
    }
  ],
  holidays: [
    {
      name: String,
      date: String,                 // "YYYY-MM-DD"
      branchId: ObjectId            // Nullable (applies to all branches if null)
    }
  ],
  billingPolicy: {
    gstin: String,
    invoicePrefix: String,          // default: "INV"
    invoiceFooterNote: String,
    allowPartialPayments: Boolean,
    defaultTaxRate: Number          // default: 18 (%)
  },
  backupSchedule: {
    enabled: Boolean,
    cronExpression: String,         // default: "0 2 * * *" (2 AM daily)
    retentionDays: Number           // default: 30
  }
}
```

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/settings` | `settings.view` | Get organization and billing configuration |
| `PUT` | `/api/v1/settings` | `settings.update` | Update organization billing settings and tax defaults |
| `GET` | `/api/v1/settings/hours` | `settings.view` | Get branch operating hours |
| `PUT` | `/api/v1/settings/hours` | `settings.update` | Update branch store hours and weekly off days |
| `POST` | `/api/v1/settings/backups/trigger` | `settings.backups` | Trigger on-demand MongoDB backup snapshot |
| `GET` | `/api/v1/settings/backups` | `settings.backups` | List historical backup snapshots |

---

## 6. Implementation Checklist

- [ ] Create `OrganizationSettings` schema in `src/models/settings/`.
- [ ] Connect appointment booking engine to validate requested time slot against `branchHours` and `holidays`.
- [ ] Build automated backup cron runner using `mongodump`.
- [ ] Mount `settingsRouter` in `app.mjs`.
- [ ] Write tests verifying store hours validation and backup endpoint security.

