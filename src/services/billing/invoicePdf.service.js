import puppeteer from "puppeteer";

/**
 * Format currency in Indian Rupees style (₹10,000.00)
 */
function formatCurrency(amount) {
  const val = Number(amount || 0);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
}

/**
 * Format datetime in branch timezone (e.g., 08 Oct 2026, 04:30 PM)
 */
function formatDateTime(date, timezone = "Asia/Kolkata") {
  if (!date) return "N/A";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      timeZone: timezone,
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(date));
  } catch (_) {
    return new Intl.DateTimeFormat("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(date));
  }
}

/**
 * Escape HTML to prevent XSS in generated PDF templates
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Generate HTML string for the Invoice document
 */
export function generateInvoiceHtml({ invoice, payments = [], branch = {}, appointment = {}, organization = {} }) {
  const timezone = branch?.timezone || "Asia/Kolkata";
  const isDraft = invoice.status === "draft";
  const isFinalized = invoice.status === "finalized";
  const isCancelled = invoice.status === "cancelled";

  // Document Title
  const documentTitle = isFinalized ? "TAX INVOICE" : isDraft ? "DRAFT INVOICE / ESTIMATE" : "CANCELLED INVOICE";

  // Status Badges
  const statusColor = isFinalized ? "#15803d" : isCancelled ? "#b91c1c" : "#b45309";
  const statusBg = isFinalized ? "#dcfce7" : isCancelled ? "#fee2e2" : "#fef3c7";

  let paymentStatusColor = "#b45309";
  let paymentStatusBg = "#fef3c7";
  if (invoice.paymentStatus === "paid") {
    paymentStatusColor = "#15803d";
    paymentStatusBg = "#dcfce7";
  } else if (invoice.paymentStatus === "unpaid") {
    paymentStatusColor = "#b91c1c";
    paymentStatusBg = "#fee2e2";
  }

  const paymentStatusText =
    invoice.paymentStatus === "paid"
      ? "PAID"
      : invoice.paymentStatus === "partially_paid"
      ? "PARTIALLY PAID"
      : "UNPAID";

  const customerName = invoice.customerSnapshot?.name || invoice.customerId?.name || "Valued Customer";
  const customerPhone = invoice.customerSnapshot?.phone || invoice.customerId?.phone || "N/A";
  const customerEmail = invoice.customerSnapshot?.email || invoice.customerId?.email || "N/A";

  const stylistName =
    appointment?.staffId?.name ||
    (appointment?.staffId && typeof appointment.staffId === "object" ? appointment.staffId.name : null) ||
    "Unassigned";

  // Services rows
  const serviceRows = (invoice.lines || [])
    .map((line, index) => {
      const isCovered = line.isCoveredBySubscription;
      const subInfo = isCovered
        ? `<div class="sub-benefit">100% Covered via Plan${
            line.appliedSubscriptionId?.subscriptionCode
              ? `: ${escapeHtml(line.appliedSubscriptionId.subscriptionCode)}`
              : line.appliedSubscriptionId?.planId?.name
              ? `: ${escapeHtml(line.appliedSubscriptionId.planId.name)}`
              : ""
          }</div>`
        : `<span class="text-muted">—</span>`;

      return `
        <tr>
          <td class="text-center font-mono">${index + 1}</td>
          <td>
            <div class="font-bold text-dark">${escapeHtml(line.name)}</div>
            <div class="text-sm text-muted">${line.duration} mins</div>
          </td>
          <td class="text-right font-mono">${formatCurrency(line.unitPrice)}</td>
          <td>${subInfo}</td>
          <td class="text-right font-mono font-bold">${formatCurrency(line.customerPayable)}</td>
        </tr>
      `;
    })
    .join("");

  // Payments rows (for finalized / partial invoices)
  const paymentRows =
    payments && payments.length > 0
      ? payments
          .map((pay) => {
            const isVoided = pay.status === "voided";
            const payStatusBadge = isVoided
              ? `<span class="badge badge-voided">VOIDED</span>`
              : `<span class="badge badge-success">SUCCESS</span>`;

            return `
              <tr>
                <td class="font-mono text-sm">${formatDateTime(pay.paymentDate || pay.createdAt, timezone)}</td>
                <td class="font-bold uppercase text-sm">${escapeHtml(pay.method)}</td>
                <td class="text-sm text-muted">${escapeHtml(pay.referenceNote || "—")}</td>
                <td class="text-right font-mono font-bold ${isVoided ? "line-through text-muted" : ""}">${formatCurrency(pay.amount)}</td>
                <td class="text-center">${payStatusBadge}</td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="5" class="text-center text-muted py-3">No payments recorded yet.</td></tr>`;

  // Paid in full stamp (when amountDue === 0 and status is not cancelled)
  const isPaidInFull = invoice.amountDue === 0 && !isCancelled;
  const paidStampHtml = isPaidInFull
    ? `<div class="paid-stamp">PAID IN FULL</div>`
    : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escapeHtml(invoice.invoiceNumber)}</title>
  <style>
    @page {
      size: A4;
      margin: 15mm;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      color: #1e293b;
      background: #ffffff;
      font-size: 13px;
      line-height: 1.5;
    }
    .header-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    .company-title {
      font-size: 24px;
      font-weight: 800;
      letter-spacing: -0.5px;
      color: #0f172a;
      text-transform: uppercase;
    }
    .company-subtitle {
      font-size: 13px;
      color: #475569;
      margin-top: 4px;
    }
    .doc-type {
      text-align: right;
      vertical-align: top;
    }
    .doc-title {
      font-size: 22px;
      font-weight: 800;
      color: #0f172a;
      letter-spacing: 0.5px;
    }
    .doc-badge-group {
      margin-top: 6px;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-status {
      background: ${statusBg};
      color: ${statusColor};
      border: 1px solid ${statusColor}33;
    }
    .badge-payment {
      background: ${paymentStatusBg};
      color: ${paymentStatusColor};
      border: 1px solid ${paymentStatusColor}33;
      margin-left: 4px;
    }
    .badge-success {
      background: #dcfce7;
      color: #15803d;
    }
    .badge-voided {
      background: #fee2e2;
      color: #b91c1c;
    }
    .divider {
      height: 2px;
      background: #e2e8f0;
      margin: 16px 0;
    }
    .meta-grid {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    .meta-grid td {
      width: 50%;
      vertical-align: top;
      padding: 0;
    }
    .section-label {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.75px;
      color: #64748b;
      margin-bottom: 6px;
    }
    .meta-card {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 12px 14px;
    }
    .meta-card-right {
      margin-left: 8px;
    }
    .meta-card-left {
      margin-right: 8px;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .meta-row:last-child {
      margin-bottom: 0;
    }
    .meta-key {
      color: #64748b;
      font-size: 12px;
    }
    .meta-val {
      font-weight: 600;
      color: #0f172a;
      font-size: 12px;
    }
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    table.data-table th {
      background: #0f172a;
      color: #ffffff;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 8px 10px;
      border: 1px solid #0f172a;
    }
    table.data-table td {
      padding: 9px 10px;
      border-bottom: 1px solid #e2e8f0;
      border-left: 1px solid #f1f5f9;
      border-right: 1px solid #f1f5f9;
    }
    table.data-table tbody tr:nth-child(even) {
      background: #f8fafc;
    }
    .text-center { text-align: center; }
    .text-right { text-align: right; }
    .font-bold { font-weight: 600; }
    .font-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .text-muted { color: #64748b; }
    .text-dark { color: #0f172a; }
    .text-sm { font-size: 11px; }
    .sub-benefit {
      color: #15803d;
      font-weight: 600;
      font-size: 11px;
    }
    .line-through { text-decoration: line-through; }
    .py-3 { padding-top: 12px; padding-bottom: 12px; }

    /* Summary & Ledger Layout */
    .ledger-container {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 24px;
    }
    .ledger-container td {
      vertical-align: top;
      padding: 0;
    }
    .stamp-cell {
      width: 50%;
      position: relative;
    }
    .paid-stamp {
      display: inline-block;
      border: 3px solid #16a34a;
      color: #16a34a;
      padding: 10px 24px;
      font-size: 20px;
      font-weight: 900;
      letter-spacing: 2px;
      text-transform: uppercase;
      border-radius: 8px;
      transform: rotate(-8deg);
      opacity: 0.9;
      margin-top: 20px;
      margin-left: 20px;
    }
    .summary-box {
      width: 100%;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      overflow: hidden;
    }
    .summary-row {
      display: flex;
      justify-content: space-between;
      padding: 7px 14px;
      border-bottom: 1px solid #e2e8f0;
      font-size: 12px;
    }
    .summary-row:last-child {
      border-bottom: none;
    }
    .summary-row.highlight {
      background: #0f172a;
      color: #ffffff;
      font-size: 14px;
      font-weight: 700;
      padding: 10px 14px;
    }
    .summary-row.due {
      background: ${invoice.amountDue > 0 ? "#fee2e2" : "#f0fdf4"};
      color: ${invoice.amountDue > 0 ? "#991b1b" : "#166534"};
      font-weight: 700;
    }

    /* Section Subheading */
    .section-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #0f172a;
      margin-bottom: 8px;
    }

    /* Footer */
    .footer-section {
      margin-top: 32px;
      border-top: 1px dashed #cbd5e1;
      padding-top: 14px;
      font-size: 11px;
      color: #64748b;
      text-align: center;
      line-height: 1.6;
    }
  </style>
</head>
<body>

  <!-- Header -->
  <table class="header-table">
    <tr>
      <td>
        <div class="company-title">Unisex Parlour</div>
        <div class="company-subtitle">
          <strong>${escapeHtml(branch.name || "Main Branch")}</strong><br/>
          ${escapeHtml(branch.address || "Salon & Spa Center")}<br/>
          Contact: ${escapeHtml(branch.phone || "+91 99999 99999")}
        </div>
      </td>
      <td class="doc-type">
        <div class="doc-title">${documentTitle}</div>
        <div class="doc-badge-group">
          <span class="badge badge-status">${escapeHtml(invoice.status)}</span>
          <span class="badge badge-payment">${paymentStatusText}</span>
        </div>
      </td>
    </tr>
  </table>

  <!-- Metadata Cards -->
  <table class="meta-grid">
    <tr>
      <td>
        <div class="meta-card meta-card-left">
          <div class="section-label">Billed To (Customer)</div>
          <div class="meta-row">
            <span class="meta-key">Customer Name:</span>
            <span class="meta-val">${escapeHtml(customerName)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Phone:</span>
            <span class="meta-val font-mono">${escapeHtml(customerPhone)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Email:</span>
            <span class="meta-val">${escapeHtml(customerEmail)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Assigned Stylist:</span>
            <span class="meta-val">${escapeHtml(stylistName)}</span>
          </div>
        </div>
      </td>
      <td>
        <div class="meta-card meta-card-right">
          <div class="section-label">Invoice Information</div>
          <div class="meta-row">
            <span class="meta-key">Invoice Number:</span>
            <span class="meta-val font-mono">${escapeHtml(invoice.invoiceNumber)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Invoice Date:</span>
            <span class="meta-val font-mono">${formatDateTime(invoice.createdAt, timezone)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-key">Appointment Code:</span>
            <span class="meta-val font-mono">${escapeHtml(invoice.appointmentCode || "—")}</span>
          </div>
          ${
            invoice.finalizedAt
              ? `<div class="meta-row">
                  <span class="meta-key">Finalized At:</span>
                  <span class="meta-val font-mono">${formatDateTime(invoice.finalizedAt, timezone)}</span>
                </div>`
              : ""
          }
        </div>
      </td>
    </tr>
  </table>

  <!-- Items Table -->
  <div class="section-title">Itemized Services</div>
  <table class="data-table">
    <thead>
      <tr>
        <th style="width: 5%;">#</th>
        <th style="width: 40%;">Service Description</th>
        <th style="width: 18%;" class="text-right">Unit Price</th>
        <th style="width: 22%;">Subscription Benefit</th>
        <th style="width: 15%;" class="text-right">Payable</th>
      </tr>
    </thead>
    <tbody>
      ${serviceRows}
    </tbody>
  </table>

  <!-- Financial Ledger Breakdown -->
  <table class="ledger-container">
    <tr>
      <td class="stamp-cell">
        ${paidStampHtml}
        ${
          invoice.notes
            ? `<div style="margin-top: 14px; font-size: 11px; color: #475569; max-width: 90%;">
                <strong>Notes / Instructions:</strong><br/>
                ${escapeHtml(invoice.notes)}
              </div>`
            : ""
        }
      </td>
      <td style="width: 50%;">
        <div class="summary-box">
          <div class="summary-row">
            <span>Gross Subtotal:</span>
            <span class="font-mono">${formatCurrency(invoice.subtotal)}</span>
          </div>
          ${
            invoice.discountTotal > 0
              ? `<div class="summary-row text-muted">
                  <span>Discount Applied:</span>
                  <span class="font-mono">- ${formatCurrency(invoice.discountTotal)}</span>
                </div>`
              : ""
          }
          ${
            invoice.subscriptionCoveredAmount > 0
              ? `<div class="summary-row sub-benefit">
                  <span>Subscription Waived:</span>
                  <span class="font-mono">- ${formatCurrency(invoice.subscriptionCoveredAmount)}</span>
                </div>`
              : ""
          }
          <div class="summary-row highlight">
            <span>Net Payable Amount:</span>
            <span class="font-mono">${formatCurrency(invoice.payableAmount)}</span>
          </div>
          <div class="summary-row">
            <span>Total Amount Paid:</span>
            <span class="font-mono font-bold">${formatCurrency(invoice.amountPaid)}</span>
          </div>
          <div class="summary-row due">
            <span>Balance Due / Outstanding:</span>
            <span class="font-mono font-bold">${formatCurrency(invoice.amountDue)}</span>
          </div>
        </div>
      </td>
    </tr>
  </table>

  <!-- Payment History Breakdown (For Finalized/Payment Transactions) -->
  ${
    isFinalized || payments.length > 0
      ? `
        <div class="section-title" style="margin-top: 10px;">Payment History</div>
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 25%;">Date & Time</th>
              <th style="width: 15%;">Method</th>
              <th style="width: 30%;">Reference / Note</th>
              <th style="width: 18%;" class="text-right">Amount</th>
              <th style="width: 12%;" class="text-center">Status</th>
            </tr>
          </thead>
          <tbody>
            ${paymentRows}
          </tbody>
        </table>
      `
      : ""
  }

  <!-- Footer Terms & Conditions -->
  <div class="footer-section">
    <p><strong>Thank you for your visit!</strong></p>
    <p>Services once availed are non-refundable. • Please retain this invoice for your records.</p>
    <p>This is a computer-generated invoice. No physical signature is required.</p>
  </div>

</body>
</html>
  `;
}

/**
 * Generate a PDF Buffer from Invoice data using Puppeteer
 */
export async function generateInvoicePdf(data) {
  const htmlContent = generateInvoiceHtml(data);

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    await page.setContent(htmlContent, {
      waitUntil: "networkidle0",
    });

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: {
        top: "15mm",
        right: "15mm",
        bottom: "15mm",
        left: "15mm",
      },
    });

    return pdfBuffer;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
