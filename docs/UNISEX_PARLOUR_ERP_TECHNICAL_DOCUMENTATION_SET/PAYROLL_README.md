# Salary & Payroll Processing Module — Specification & Status

```text
Module: Staff Salary, Commission Engine & Payroll Processing
Status: ⏳ PENDING / PLANNED
Layer: Financial Operations / Human Resources
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Salary & Payroll** module automates compensation calculations for salon staff. Salon compensation heavily combines fixed base wages, tiered service sales commissions, retail product commissions, tips, overtime, and leave/loan deductions.

### Key Capabilities Required
- Salary structure configuration per staff member (base pay, hourly rate, tiered commission curves).
- Automated monthly payroll calculation based on completed appointments (Billing line items tagged with `staffId`) and Attendance muster roll records.
- Deductions: Unpaid leaves, salary advances, late penalties, statutory deductions.
- Payslip generation in printable PDF format.
- Disbursal status tracking (`draft`, `approved`, `disbursed`).

---

## 2. Multi-Tenancy & Scoping Rules

- **Organization Bound**: Compensation structures and payroll batches belong to `organizationId`.
- Branch cost-center attribution tracks expenses against physical branch locations.

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Payroll & Compensation | `payroll.view` | View salary structures, payslips, and monthly payroll summaries |
| Run Payroll Calculation | `payroll.calculate` | Configure compensation rules, run batch calculations, approve disbursements |

---

## 4. Proposed Database Model Specifications

### SalaryStructure Model (`src/models/payroll/salaryStructure.model.js`)
```ts
{
  organizationId: ObjectId,         // ref: Organization, required
  staffId: ObjectId,                // ref: Staff, required, unique
  payType: String,                  // "fixed_monthly", "hourly", "commission_only", "base_plus_commission"
  baseSalary: Number,               // Monthly base
  hourlyRate: Number,
  serviceCommissionTiers: [
    { minMonthlySales: Number, commissionPercent: Number }
  ],
  productCommissionPercent: Number, // Commission on retail product sales
  allowances: [{ name: String, amount: Number }],
  deductions: [{ name: String, amount: Number }]
}
```

### PayrollEntry Model (`src/models/payroll/payrollEntry.model.js`)
```ts
{
  organizationId: ObjectId,
  branchId: ObjectId,               // Cost center
  staffId: ObjectId,                // ref: Staff
  monthYear: String,                // "YYYY-MM"
  basePayEarned: Number,
  serviceCommissionEarned: Number,
  productCommissionEarned: Number,
  overtimePay: Number,
  leaveDeductions: Number,
  advanceRecoveryDeduction: Number,
  grossTotal: Number,
  netPayable: Number,
  status: String,                   // "draft", "approved", "disbursed"
  disbursedAt: Date,
  paymentReference: String
}
```

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/payroll/structures/:staffId` | `payroll.view` | Get staff compensation structure |
| `PUT` | `/api/v1/payroll/structures/:staffId` | `payroll.calculate` | Configure staff salary structure |
| `POST` | `/api/v1/payroll/calculate` | `payroll.calculate` | Batch compute monthly payroll for month |
| `GET` | `/api/v1/payroll/reports` | `payroll.view` | View monthly payroll report |
| `POST` | `/api/v1/payroll/:id/disburse` | `payroll.calculate` | Mark payslip disbursed with transaction ref |
| `GET` | `/api/v1/payroll/:id/payslip-pdf` | `payroll.view` | Download employee payslip PDF |

---

## 6. Implementation Checklist

- [ ] Create `SalaryStructure` and `PayrollEntry` models in `src/models/payroll/`.
- [ ] Implement commission calculator service aggregating completed appointments from `Invoice` items.
- [ ] Connect attendance attendance records to calculate unpaid leave penalties.
- [ ] Integrate PDFKit/Puppeteer for branded payslip PDF rendering.
- [ ] Mount `payrollRouter` in `app.mjs`.
- [ ] Write Jest tests for tier commission math, deduction formulas, and role access.

