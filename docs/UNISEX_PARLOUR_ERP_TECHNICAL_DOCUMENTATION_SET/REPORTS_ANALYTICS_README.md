# Executive Analytics & Reporting Module — Specification & Status

```text
Module: Executive Analytics, BI & Operational Reporting
Status: ⏳ PENDING / PLANNED
Layer: Business Intelligence / Executive Telemetry
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Analytics & Reports** module aggregates operational telemetry across Appointments, Billing, Customers, Staff, and Inventory to provide owners and store managers with actionable business intelligence.

### Key Capabilities Required
- Executive Real-Time Dashboard KPI Cards: Today's gross revenue, active/completed appointments, current salon occupancy, staff on duty, average ticket value.
- Revenue Breakdown Reports: Daily, weekly, and monthly revenue trends; comparison across branches; payment tender breakdown.
- Staff Performance & Productivity: Revenue generated per stylist, service counts, average service duration, customer retention per stylist, commission summaries.
- Service Popularity & Margin Analysis: Most requested services, highest-margin services, peak booking hours.
- Customer Retention & Cohort Analysis: Repeat visit rates, average interval between visits, new customer acquisition trends.

---

## 2. Multi-Tenancy & Scoping Rules

- Can be queried Organization-Wide (Owner view across all branches) or Branch-Scoped (`X-Branch-Id` required for branch managers).
- Aggregation pipelines enforce `{ organizationId: req.user.organizationId }`.

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Executive Dashboard | `dashboard.view` | Access real-time KPI overview widgets |
| View Revenue Reports | `reports.revenue.view` | Detailed sales and revenue reports |
| View Staff Performance | `reports.performance.view` | Stylist revenue, service counts, and productivity |
| View Customer Retention | `reports.retention.view` | Cohort retention and churn analysis |
| View Inventory Reports | `reports.inventory.view` | Product sales velocity and stock turnover |
| View Service Analytics | `reports.services.view` | Service demand rankings and peak booking hours |

---

## 4. Architectural Strategy & Aggregation Pipelines

- **High-Performance MongoDB Aggregations**: Uses `$facet` stages to compute multiple dashboard metrics in single database roundtrips.
- **Redis Caching**: Frequent dashboard card telemetry cached in Redis with a 15-minute TTL (`dashboard:org:<orgId>:branch:<branchId>`).
- Daily rollups pre-aggregated via background nightly cron job for instant historical charts.

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/dashboard/metrics` | `dashboard.view` | Real-time overview KPIs (revenue, appointments, occupancy) |
| `GET` | `/api/v1/reports/revenue` | `reports.revenue.view` | Sales trends over time with branch comparison |
| `GET` | `/api/v1/reports/staff-performance` | `reports.performance.view` | Stylist productivity, sales, and service count rankings |
| `GET` | `/api/v1/reports/customer-retention` | `reports.retention.view` | Client repeat visit rate and churn cohort analysis |
| `GET` | `/api/v1/reports/service-analytics` | `reports.services.view` | Top services by volume, revenue, and peak booking times |

---

## 6. Implementation Checklist

- [ ] Build MongoDB aggregation pipelines querying `Invoice`, `Appointment`, and `Staff` collections.
- [ ] Implement Redis caching layer with cache invalidation on invoice finalization.
- [ ] Mount `reportRouter` in `app.mjs`.
- [ ] Write tests verifying aggregation accuracy and cross-tenant isolation.

