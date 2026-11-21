import puppeteer from "puppeteer";

/**
 * Format currency in Indian Rupees format (₹30,000.00)
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
 * Generate formatted HTML template for Payslip
 */
export function generatePayslipHtml(record) {
  const staff = record.staffId || {};
  const branch = record.branchId || {};
  const org = record.organizationId || {};
  const calc = record.calculations || {};
  const att = record.attendanceSummarySnapshot || {};
  const structure = record.salaryStructureSnapshot || {};

  const allowancesRows = (structure.allowances || [])
    .map(
      (a) => `
        <tr>
          <td>${escapeHtml(a.name)}</td>
          <td class="text-right font-mono">${formatCurrency(a.amount)}</td>
        </tr>
      `
    )
    .join("");

  const deductionsRows = (structure.deductions || [])
    .map(
      (d) => `
        <tr>
          <td>${escapeHtml(d.name)}</td>
          <td class="text-right font-mono">${formatCurrency(d.amount)}</td>
        </tr>
      `
    )
    .join("");

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Payslip - ${escapeHtml(record.monthYear)} - ${escapeHtml(staff.name || "")}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      color: #1f2937;
      background: #ffffff;
      padding: 30px;
      font-size: 13px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #e5e7eb;
      padding-bottom: 20px;
      margin-bottom: 20px;
    }
    .brand-title {
      font-size: 22px;
      font-weight: 700;
      color: #111827;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .brand-sub {
      color: #6b7280;
      font-size: 12px;
      margin-top: 4px;
    }
    .doc-meta {
      text-align: right;
    }
    .doc-title {
      font-size: 18px;
      font-weight: bold;
      color: #2563eb;
    }
    .status-badge {
      display: inline-block;
      margin-top: 5px;
      padding: 3px 10px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      background: ${record.status === "paid" ? "#dcfce7" : "#fef3c7"};
      color: ${record.status === "paid" ? "#15803d" : "#b45309"};
    }
    .info-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 25px;
      background: #f9fafb;
      padding: 16px;
      border-radius: 8px;
      border: 1px solid #f3f4f6;
    }
    .info-block h4 {
      font-size: 11px;
      text-transform: uppercase;
      color: #9ca3af;
      margin-bottom: 6px;
      letter-spacing: 0.5px;
    }
    .info-item {
      margin-bottom: 4px;
    }
    .info-label {
      color: #6b7280;
      display: inline-block;
      width: 120px;
    }
    .info-val {
      font-weight: 600;
      color: #1f2937;
    }
    .tables-container {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      margin-bottom: 25px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 8px 10px;
      border-bottom: 1px solid #e5e7eb;
    }
    th {
      background: #f3f4f6;
      font-size: 11px;
      text-transform: uppercase;
      color: #4b5563;
      text-align: left;
    }
    .text-right { text-align: right; }
    .font-mono { font-family: monospace; }
    .summary-card {
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      padding: 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
    }
    .net-label {
      font-size: 14px;
      font-weight: bold;
      color: #1e40af;
    }
    .net-amount {
      font-size: 24px;
      font-weight: 800;
      color: #1d4ed8;
      font-family: monospace;
    }
    .footer {
      border-top: 1px solid #e5e7eb;
      padding-top: 15px;
      font-size: 11px;
      color: #9ca3af;
      text-align: center;
    }
  </style>
</head>
<body>

  <div class="header">
    <div>
      <div class="brand-title">${escapeHtml(org.name || "Unisex Parlour")}</div>
      <div class="brand-sub">${escapeHtml(branch.name || "Branch")} ${branch.code ? `(${escapeHtml(branch.code)})` : ""}</div>
    </div>
    <div class="doc-meta">
      <div class="doc-title">PAYSLIP</div>
      <div style="font-size: 12px; color: #4b5563; margin-top: 2px;">Period: <strong>${escapeHtml(record.monthYear)}</strong></div>
      <div class="status-badge">${escapeHtml(record.status)}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-block">
      <h4>Employee Details</h4>
      <div class="info-item"><span class="info-label">Name:</span> <span class="info-val">${escapeHtml(staff.name || "N/A")}</span></div>
      <div class="info-item"><span class="info-label">Staff Code:</span> <span class="info-val">${escapeHtml(staff.staffCode || "N/A")}</span></div>
      <div class="info-item"><span class="info-label">Designation:</span> <span class="info-val">${escapeHtml(staff.designation || "N/A")}</span></div>
      <div class="info-item"><span class="info-label">Email:</span> <span class="info-val">${escapeHtml(staff.email || "N/A")}</span></div>
    </div>

    <div class="info-block">
      <h4>Attendance & Leave Summary</h4>
      <div class="info-item"><span class="info-label">Total Days:</span> <span class="info-val">${att.totalDaysInMonth || 0}</span></div>
      <div class="info-item"><span class="info-label">Payable Days:</span> <span class="info-val" style="font-weight: bold; color: #16a34a;">${att.payableDays != null ? att.payableDays : (att.presentDays || 0)}</span></div>
      <div class="info-item"><span class="info-label">Present Days:</span> <span class="info-val" style="color: #16a34a;">${att.presentDays || 0}</span></div>
      <div class="info-item"><span class="info-label">Paid Leaves:</span> <span class="info-val" style="color: #2563eb;">${att.paidLeaveDays || 0}</span></div>
      <div class="info-item"><span class="info-label">Unpaid Leaves:</span> <span class="info-val" style="color: #dc2626;">${att.unpaidLeaveDays || 0}</span></div>
    </div>
  </div>

  <div class="tables-container">
    <div>
      <table>
        <thead>
          <tr>
            <th>Earnings</th>
            <th class="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Gross Base Salary</td>
            <td class="text-right font-mono">${formatCurrency(calc.grossBaseSalary)}</td>
          </tr>
          ${allowancesRows}
          <tr style="font-weight: bold; background: #fafafa;">
            <td>Total Gross Earnings</td>
            <td class="text-right font-mono">${formatCurrency(calc.totalGrossPay)}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div>
      <table>
        <thead>
          <tr>
            <th>Deductions</th>
            <th class="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Unpaid Leave (LOP)</td>
            <td class="text-right font-mono">${formatCurrency(calc.unpaidLeaveDeduction)}</td>
          </tr>
          ${deductionsRows}
          <tr style="font-weight: bold; background: #fafafa;">
            <td>Total Deductions</td>
            <td class="text-right font-mono">${formatCurrency(calc.totalDeductions)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <div class="summary-card">
    <div>
      <div class="net-label">NET PAYABLE AMOUNT</div>
      <div style="font-size: 11px; color: #4b5563; margin-top: 3px;">
        ${record.paymentReference ? `Payment Ref: ${escapeHtml(record.paymentReference)} (${escapeHtml(record.paymentMethod || "")})` : "Pending Disbursement"}
      </div>
    </div>
    <div class="net-amount">${formatCurrency(calc.netPayable)}</div>
  </div>

  <div class="footer">
    <p>This is a system-generated payslip from Unisex Parlour ERP. No physical signature is required.</p>
  </div>

</body>
</html>
  `;
}

/**
 * Generate PDF buffer using Puppeteer
 */
export async function generatePayslipPdf(record) {
  const htmlContent = generatePayslipHtml(record);

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
