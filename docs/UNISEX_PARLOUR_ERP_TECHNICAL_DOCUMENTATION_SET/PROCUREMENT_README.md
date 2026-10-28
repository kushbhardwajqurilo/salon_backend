# Procurement & Supplier Management Module — Specification & Status

```text
Module: Procurement, Suppliers & Purchase Orders
Status: ⏳ PENDING / PLANNED
Layer: Supply Chain / Vendor Management
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Procurement** module streamlines beauty product purchasing from distributors, managing vendor contracts, issuing Purchase Orders (PO), logging physical stock arrivals (Goods Receipt Notes / GRN), and handling vendor bill settlements.

### Key Capabilities Required
- Vendor directory: Company name, GSTIN, contact person, payment terms, bank details.
- Purchase Order (PO) workflow: `draft` ➔ `submitted` ➔ `approved` ➔ `partially_received` ➔ `fully_received` ➔ `cancelled`.
- Goods Receipt Note (GRN): Auto-increments branch inventory upon physical arrival of goods.
- Vendor Bill & Outgoing Payments tracking.

---

## 2. Multi-Tenancy & Scoping Rules

- Suppliers are managed organization-wide (`organizationId`).
- Purchase Orders and physical deliveries are Branch-scoped (`branchId`).

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Suppliers | `procurement.suppliers.view` | View vendor list and bank details |
| Manage Suppliers | `procurement.suppliers.manage` | Add or edit vendor profiles |
| View Orders | `procurement.orders.view` | View Purchase Orders |
| Create Order | `procurement.orders.create` | Issue new Purchase Order |
| Update / Receive Order | `procurement.orders.update` | Log Goods Receipt Note (GRN) |
| Manage Invoices & Bills | `procurement.invoices.manage` | Record incoming supplier bills |
| Record Vendor Payments | `procurement.payments.manage` | Record disbursements to suppliers |

---

## 4. Proposed Database Model Specifications

### Supplier Model (`src/models/procurement/supplier.model.js`)
```ts
{
  organizationId: ObjectId,
  name: String,                     // Distributor name
  gstin: String,                    // 15-character GSTIN
  contactPerson: String,
  phone: String,
  email: String,
  address: String,
  paymentTermsDays: Number,         // e.g. 15, 30 days
  bankDetails: { accountNo: String, ifscCode: String, bankName: String }
}
```

### PurchaseOrder Model (`src/models/procurement/purchaseOrder.model.js`)
```ts
{
  organizationId: ObjectId,
  branchId: ObjectId,               // Destination branch
  poNumber: String,                 // "PO-YYYYMMDD-XXXX"
  supplierId: ObjectId,             // ref: Supplier
  items: [
    {
      productId: ObjectId,
      orderedQuantity: Number,
      receivedQuantity: Number,
      unitCostPrice: Number,
      taxPercent: Number,
      lineTotal: Number
    }
  ],
  subtotal: Number,
  taxTotal: Number,
  grandTotal: Number,
  status: String,                   // "draft", "submitted", "approved", "received", "cancelled"
  expectedDeliveryDate: Date
}
```

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/procurement/suppliers` | `procurement.suppliers.view` | List suppliers |
| `POST` | `/api/v1/procurement/suppliers` | `procurement.suppliers.manage` | Add new supplier |
| `POST` | `/api/v1/procurement/orders` | `procurement.orders.create` | Create Purchase Order |
| `GET` | `/api/v1/procurement/orders` | `procurement.orders.view` | Query Purchase Orders |
| `POST` | `/api/v1/procurement/orders/:id/receive` | `procurement.orders.update` | Receive goods (GRN) & increment stock |
| `POST` | `/api/v1/procurement/bills/:id/pay` | `procurement.payments.manage` | Record vendor payment |

---

## 6. Implementation Checklist

- [ ] Create `Supplier`, `PurchaseOrder`, and `VendorBill` schemas in `src/models/procurement/`.
- [ ] Implement atomic inventory increment on GRN receipt inside MongoDB session.
- [ ] Mount `procurementRouter` in `app.mjs`.
- [ ] Write tests verifying stock increment on PO delivery.

