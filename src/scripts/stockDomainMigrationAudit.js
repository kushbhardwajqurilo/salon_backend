/**
 * Historical Stock Domain Allocation & Reconciliation Dry-Run Plan
 *
 * Objective:
 * Provide safe, non-destructive migration and reconciliation for products with usageType: "both"
 * to allocate legacy single-scalar onHand inventory into distinct domains:
 * - onHandConsumables (Salon Consumables: internal service consumption)
 * - onHandRetail (Retail Products: POS retail sales)
 *
 * In accordance with ERP safety rules, this script NEVER executes destructive mutations
 * without explicit authorized manager sign-off.
 */

import { Product } from "../models/inventory/product.model.js";
import { StockBalance } from "../models/inventory/stockBalance.model.js";
import { StockMovement } from "../models/inventory/stockMovement.model.js";

export async function generateStockDomainMigrationAudit({ organizationId, dryRun = true }) {
  if (!dryRun) {
    throw new Error("Stock domain migration audit is read-only; committed allocation requires an approved workflow.");
  }

  console.log(`\n======================================================`);
  console.log(`[STOCK DOMAIN MIGRATION AUDIT] Organization: ${organizationId}`);
  console.log("Mode: DRY-RUN (READ-ONLY REPORT)");
  console.log(`======================================================\n`);

  // 1. Locate all dual-usage products
  const dualProducts = await Product.find({
    organizationId,
    usageType: "both",
  }).select("_id name sku category stockUnit reorderLevel").lean();

  console.log(`Found ${dualProducts.length} dual-purpose products (usageType: 'both')`);

  const productIds = dualProducts.map((p) => p._id);
  const balances = await StockBalance.find({
    organizationId,
    productId: { $in: productIds },
  }).populate("branchId", "name branchCode").lean();

  const auditReport = [];

  for (const bal of balances) {
    const prod = dualProducts.find((p) => p._id.toString() === bal.productId.toString());
    const movements = await StockMovement.find({
      organizationId,
      branchId: bal.branchId._id,
      productId: bal.productId,
    }).sort({ createdAt: -1 }).limit(10).lean();

    const unallocatedQuantity =
      bal.onHandUnallocated !== undefined
        ? bal.onHandUnallocated
        : Math.max(0, bal.onHand - ((bal.onHandConsumables || 0) + (bal.onHandRetail || 0)));

    const isUnallocated = unallocatedQuantity > 0;

    auditReport.push({
      productId: prod._id,
      productName: prod.name,
      sku: prod.sku,
      unit: prod.stockUnit,
      branchId: bal.branchId._id,
      branchName: bal.branchId.name,
      totalOnHand: bal.onHand,
      allocated: bal.allocated,
      currentConsumables: bal.onHandConsumables || 0,
      currentRetail: bal.onHandRetail || 0,
      unallocatedQuantity,
      requiresManagerSignoff: isUnallocated,
      recentMovementsCount: movements.length,
      sampleHistory: movements.map((m) => ({
        type: m.movementType,
        domain: m.stockDomain || "legacy_unspecified",
        delta: m.quantityDelta,
        at: m.createdAt,
      })),
    });
  }

  return {
    organizationId,
    dryRun,
    totalRecords: auditReport.length,
    pendingActionCount: auditReport.filter((r) => r.requiresManagerSignoff).length,
    report: auditReport,
  };
}
