# Inventory & Product Stock Module — Specification & Status

```text
Module: Product Retail & In-Service Consumables Inventory
Status: ⏳ PENDING / PLANNED
Layer: Supply Chain / Retail & Salon Consumables
Parent Architecture: docs/UNISEX_PARLOUR_ERP_TECHNICAL_DOCUMENTATION_SET/ARCHITECTURE.md
Governing Standard: BACKEND_MODULE_ARCHITECTURE_STANDARD.md v1.0
Last Updated: 2026-10-28
```

---

## 1. Domain Overview & Business Purpose

The **Inventory** module governs retail products sold over the counter (shampoos, serums, styling gels, beard oils) and internal consumables utilized during services (hair colors, bleaching powders, wax, developer lotions, massage oils).

### Key Capabilities Required
- Master product catalog with SKU, barcode, brand, category, HSN code, and tax rate.
- Branch-level stock balances with low-stock alerts.
- Automated stock decrement upon retail sale during POS billing.
- In-service chemical / consumable usage logging (e.g. 60g color tube logged during hair coloring appointment).
- Stock audit count adjustments and damaged/expired stock write-offs.
- Inter-branch stock transfers.

---

## 2. Multi-Tenancy & Scoping Rules

- **Products**: Defined organization-wide (`organizationId`).
- **Stock Balances & Movements**: Strictly Branch-scoped (`branchId`).

---

## 3. RBAC & Canonical Permissions

| Capability | Permission Key | Description |
|:---|:---|:---|
| View Inventory | `inventory.view` | View product catalog and branch stock levels |
| Create Product | `inventory.create` | Register products and assign initial stock |
| Consume Consumables | `inventory.consume` | Record internal consumable usage during service |
| Adjust Stock | `inventory.adjust` | Perform stock audit counts and write-offs |

---

## 4. Proposed Database Model Specifications

### Product Model (`src/models/inventory/product.model.js`)
```ts
{
  organizationId: ObjectId,         // ref: Organization, required
  name: String,                     // e.g. "L'Oréal Professionnel Serie Expert Shampoo"
  sku: String,                      // Unique SKU per org
  barcode: String,                  // EAN / UPC barcode
  brand: String,
  category: String,                 // "haircare", "skincare", "color", "styling"
  usageType: String,                // "retail_sale", "salon_consumption", "both"
  unit: String,                     // "piece", "ml", "grams", "bottle"
  mrp: Number,                      // Maximum Retail Price
  sellingPrice: Number,
  costPrice: Number,
  taxRate: Number,
  hsnCode: String,
  isActive: Boolean
}
```

### BranchStock Model (`src/models/inventory/branchStock.model.js`)
```ts
{
  organizationId: ObjectId,
  branchId: ObjectId,               // ref: Branch
  productId: ObjectId,              // ref: Product
  currentQuantity: Number,
  reorderLevel: Number,             // Threshold triggering low-stock notification
  batchNumber: String,
  expiryDate: Date
}
```

### StockMovement Model (`src/models/inventory/stockMovement.model.js`)
```ts
{
  organizationId: ObjectId,
  branchId: ObjectId,
  productId: ObjectId,
  movementType: String,             // "purchase_in", "pos_sale", "service_consumption", "adjustment", "transfer_out", "transfer_in"
  quantityDelta: Number,            // +/- quantity
  referenceId: ObjectId,            // InvoiceId or AppointmentId
  performedBy: ObjectId,
  notes: String,
  createdAt: Date
}
```

---

## 5. Planned API Endpoints

| Method | Endpoint | Authorization | Description |
|:---|:---|:---|:---|
| `GET` | `/api/v1/inventory/products` | `inventory.view` | List master products |
| `POST` | `/api/v1/inventory/products` | `inventory.create` | Add new product to catalog |
| `GET` | `/api/v1/inventory/stock` | `inventory.view` | Get branch stock balances with low-stock flags |
| `POST` | `/api/v1/inventory/consume` | `inventory.consume` | Log consumable grams/ml used in appointment |
| `POST` | `/api/v1/inventory/adjust` | `inventory.adjust` | Audit stock count correction |
| `POST` | `/api/v1/inventory/transfer` | `inventory.create` | Transfer stock between branches |

---

## 6. Implementation Checklist

- [ ] Create `Product`, `BranchStock`, and `StockMovement` schemas in `src/models/inventory/`.
- [ ] Connect POS invoice finalization to decrement retail stock in MongoDB transaction.
- [ ] Implement barcode scanner lookup endpoint (`GET /api/v1/inventory/barcode/:code`).
- [ ] Mount `inventoryRouter` in `app.mjs`.
- [ ] Write tests verifying stock decrements and transaction rollbacks on invoice cancellation.

