import puppeteer from "puppeteer";

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Generates an official A4 PDF buffer for a Supplier Invoice using Puppeteer.
 */
export async function generateSupplierInvoicePdf({
  invoice,
  purchaseOrder,
  organization,
  branch: resolvedBranch,
}) {
  const supplier =
    invoice.supplierId && typeof invoice.supplierId === "object"
      ? invoice.supplierId
      : {};
  const branch =
    resolvedBranch ||
    (invoice.branchId && typeof invoice.branchId === "object"
      ? invoice.branchId
      : {});
  const orgName =
    organization?.displayName ||
    organization?.name ||
    "Unisex Parlour ERP";
  const orgDetails = [
    organization?.address,
    organization?.phone ? `Tel: ${organization.phone}` : null,
    organization?.gstNumber ? `GST: ${organization.gstNumber}` : null,
  ]
    .filter(Boolean)
    .join(" • ");
  const poNumber =
    (invoice.purchaseOrderId && typeof invoice.purchaseOrderId === "object"
      ? invoice.purchaseOrderId.poNumber
      : undefined) ||
    purchaseOrder?.poNumber ||
    "Standalone";

  const totalAmount = Number(invoice.totalAmount || 0);
  const amountPaid = Number(invoice.amountPaid || 0);
  const balanceDue = Math.max(0, totalAmount - amountPaid);

  const items = purchaseOrder?.items || [];
  const poRows = items
    .map((line) => {
      const prodName =
        (line.productId && typeof line.productId === "object"
          ? line.productId.name
          : undefined) || "Product";
      return `<tr>
        <td>${escapeHtml(prodName)}</td>
        <td style="text-align:right;">${Number(line.orderedQuantity || 0)}</td>
        <td style="text-align:right;">₹${Number(line.unitCostPrice || 0).toLocaleString()}</td>
        <td style="text-align:right;font-weight:600;">₹${Number(line.lineTotal || 0).toLocaleString()}</td>
      </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Official Invoice - ${escapeHtml(invoice.invoiceNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 28px; color: #0f172a; font-size: 13px; max-width: 820px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #0f172a; padding-bottom: 16px; margin-bottom: 20px; }
    .brand { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; }
    .doc-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #475569; margin-top: 2px; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; }
    .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
    .box { padding: 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }
    .box-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; margin-bottom: 8px; }
    .row { display: flex; justify-content: space-between; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th { text-align: left; padding: 9px 10px; background: #f1f5f9; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #475569; border-bottom: 1px solid #cbd5e1; }
    td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
    .summary { margin-left: auto; width: 280px; margin-top: 16px; padding: 14px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }
    .summary-row { display: flex; justify-content: space-between; margin-bottom: 6px; }
    .summary-total { display: flex; justify-content: space-between; padding-top: 8px; margin-top: 8px; border-top: 2px solid #0f172a; font-size: 15px; font-weight: 800; }
    .footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #64748b; text-align: center; }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand">${escapeHtml(orgName)}</div>
      <div class="doc-title">Official Supplier Invoice</div>
      ${orgDetails ? `<div style="font-size:11px;color:#64748b;margin-top:4px;">${escapeHtml(orgDetails)}</div>` : ""}
    </div>
    <div style="text-align:right;">
      <div style="font-size:16px;font-weight:700;">${escapeHtml(invoice.invoiceNumber || `INV-${invoice._id}`)}</div>
      <div style="margin-top:4px;"><span class="badge">${escapeHtml(String(invoice.status || "unpaid").replace("_", " "))}</span></div>
    </div>
  </div>
  <div class="meta-grid">
    <div class="box">
      <div class="box-title">Vendor / Supplier</div>
      <div style="font-weight:700;font-size:14px;margin-bottom:4px;">${escapeHtml(supplier.name || "—")}</div>
      <div style="color:#475569;">Supplier Ref #: ${escapeHtml(invoice.supplierInvoiceRef || "—")}</div>
      ${supplier.contactPerson ? `<div style="color:#475569;">Contact: ${escapeHtml(supplier.contactPerson)}</div>` : ""}
    </div>
    <div class="box">
      <div class="box-title">Invoice Details</div>
      <div class="row"><span>Related PO:</span><strong>${escapeHtml(poNumber)}</strong></div>
      <div class="row"><span>Invoice Date:</span><strong>${new Date(invoice.invoiceDate).toLocaleDateString()}</strong></div>
      <div class="row"><span>Due Date:</span><strong>${new Date(invoice.dueDate).toLocaleDateString()}</strong></div>
      ${branch.name ? `<div class="row"><span>Branch:</span><strong>${escapeHtml(branch.name)}</strong></div>` : ""}
    </div>
  </div>
  ${
    poRows
      ? `<table>
           <thead><tr><th>Product</th><th style="text-align:right;">Qty</th><th style="text-align:right;">Unit Cost</th><th style="text-align:right;">Total</th></tr></thead>
           <tbody>${poRows}</tbody>
         </table>`
      : ""
  }
  <div class="summary">
    <div class="summary-row"><span>Total Amount</span><strong>₹${totalAmount.toLocaleString()}</strong></div>
    <div class="summary-row"><span>Amount Paid</span><strong style="color:#059669;">₹${amountPaid.toLocaleString()}</strong></div>
    <div class="summary-total"><span>Balance Due</span><span>₹${balanceDue.toLocaleString()}</span></div>
  </div>
  ${invoice.notes ? `<div class="box" style="margin-top:16px;"><div class="box-title">Notes</div><div>${escapeHtml(invoice.notes)}</div></div>` : ""}
  <div class="footer">Generated by Unisex Parlour ERP • Official Supplier Settlement Record</div>
</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfUint8 = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "16px", right: "16px", bottom: "16px", left: "16px" },
    });
    return Buffer.from(pdfUint8);
  } finally {
    await browser.close();
  }
}
