# Marketing Campaigns & Lifecycle Engine — Specification & Status

```text
Module: Client Marketing Campaigns & Lifecycle Automation
Status: ⏳ PENDING / PLANNED
Layer: CRM / Client Retention & Engagement
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Marketing Campaigns** module drives parlour revenue through automated lifecycle retention programs and targeted bulk promotional broadcasts across SMS and WhatsApp channels.

### Key Capabilities Required
- Customer audience segmentation:
  - Lapsed Clients: No visit in >45 or >90 days ("We miss you — 20% off your next visit").
  - High-Value VIPs: Spend > ₹15,000 in past 6 months.
  - Birthday & Anniversary celebrants this month.
  - Service-specific cohorts: Clients who had hair color 6 weeks ago (color touch-up reminder).
- Campaign template builder for SMS and WhatsApp.
- Scheduled and trigger-based automated broadcast execution.
- Campaign conversion and revenue attribution metrics.

---

## 2. Multi-Tenancy & Scoping Rules

- Managed organization-wide (`organizationId`).
- Audience segmentation filters can target all branches or specific salon branches.

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Campaigns | `campaigns.view` | View campaigns, audience counts, and conversion metrics |
| Create & Send Campaigns | `campaigns.send` | Build audience filters, trigger bulk broadcast dispatches |
| Manage Templates | `notifications.templates.update` | Edit SMS and notification templates |

---

## 4. Proposed Database Model Specification

**File Target**: `src/models/campaigns/campaign.model.js`

```ts
{
  organizationId: ObjectId,         // ref: Organization, required
  name: String,                     // e.g. "Diwali Glow Win-back Blast"
  channel: String,                  // "sms", "whatsapp", "email"
  targetFilter: {
    lapsedDaysGreaterThan: Number,  // e.g. 60
    visitedBranchIds: [ObjectId],
    tags: [String],
    gender: String
  },
  templateContent: String,
  couponId: ObjectId,               // ref: Coupon (Optional promo link)
  scheduledAt: Date,
  status: String,                   // "draft", "scheduled", "processing", "completed", "cancelled"
  audienceCount: Number,
  sentCount: Number,
  deliveredCount: Number,
  conversionCount: Number,          // Number of clients who booked within 7 days
  revenueGenerated: Number
}
```

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/campaigns` | `campaigns.view` | List marketing campaigns |
| `POST` | `/api/v1/campaigns` | `campaigns.send` | Create marketing campaign |
| `POST` | `/api/v1/campaigns/audience-preview` | `campaigns.view` | Count matching clients for segmentation filter |
| `POST` | `/api/v1/campaigns/:id/execute` | `campaigns.send` | Queue bulk broadcast jobs in BullMQ |

---

## 6. Implementation Checklist

- [ ] Create `Campaign` and `NotificationTemplate` models in `src/models/campaigns/`.
- [ ] Implement audience query builder querying `Customer` and `Invoice` collections.
- [ ] Connect BullMQ `campaign` batch queue with rate-limited SMS/WhatsApp worker dispatch.
- [ ] Mount `campaignRouter` in `app.mjs`.
- [ ] Write tests verifying audience segmentation queries and queue scheduling.

