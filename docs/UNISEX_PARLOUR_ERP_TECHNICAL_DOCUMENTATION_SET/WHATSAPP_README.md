# WhatsApp Business API Module — Specification & Status

```text
Module: WhatsApp Business API Integration & Client Messaging
Status: ⏳ PENDING / PLANNED
Layer: Client Communication & Automated Notifications
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **WhatsApp Business API** module automates client communication over WhatsApp via the official Meta Cloud API. It sends instant booking confirmations, 24-hour and 2-hour appointment reminders, PDF invoice delivery, and customer feedback requests.

### Key Capabilities Required
- Official Meta Cloud API integration (WABA ID, Phone Number ID, Access Tokens).
- Automated transactional triggers:
  - Appointment Booking Confirmation with interactive buttons ("Confirm", "Reschedule").
  - 24-hour and 2-hour pre-appointment reminders.
  - POS Invoice receipt delivery with downloadable PDF link.
  - Birthday & Anniversary greeting with discount code.
- Asynchronous dispatching via BullMQ `whatsapp` queue to avoid blocking API requests.
- Webhook receiver for delivery status tracking (`sent`, `delivered`, `read`, `failed`).

---

## 2. Multi-Tenancy & Scoping Rules

- **Organization Bound**: Meta WABA credentials and webhook subscriptions are configured per `organizationId`.

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| Configure WhatsApp | `whatsapp.config.update` | Set up Meta Cloud API keys, WABA ID, and phone numbers |

---

## 4. Proposed Database Model Specification

**File Target**: `src/models/whatsapp/whatsappConfig.model.js`

```ts
{
  organizationId: ObjectId,         // ref: Organization, required, unique
  wabaId: String,                   // WhatsApp Business Account ID
  phoneNumberId: String,            // Phone Number ID
  accessToken: String,              // Encrypted System User Access Token
  webhookVerifyToken: String,
  isActive: Boolean,
  templateMappings: {
    appointmentBooked: String,      // Approved Meta template name
    appointmentReminder: String,
    invoiceReceipt: String,
    feedbackRequest: String
  }
}
```

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/whatsapp/config` | `whatsapp.config.update` | Get WhatsApp configuration details |
| `PUT` | `/api/v1/whatsapp/config` | `whatsapp.config.update` | Update API tokens and template mappings |
| `POST` | `/api/v1/whatsapp/webhook` | Public | Meta webhook verification & delivery status receiver |
| `POST` | `/api/v1/whatsapp/test-message` | `whatsapp.config.update` | Send test template to verified number |

---

## 6. Implementation Checklist

- [ ] Create `WhatsAppConfig` model with token encryption in `src/models/whatsapp/`.
- [ ] Implement BullMQ worker in `src/workers/notification.worker.js` processing `whatsapp` jobs.
- [ ] Connect `Appointment` status transitions and `Billing` finalization to queue WhatsApp jobs.
- [ ] Build Meta webhook verification endpoint supporting `GET` challenge and `POST` delivery events.
- [ ] Mount `whatsappRouter` in `app.mjs`.

