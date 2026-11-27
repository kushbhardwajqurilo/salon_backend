import puppeteer from "puppeteer";
import dns from "node:dns";
import net from "node:net";
import https from "node:https";

const MAX_DATA_URL_LENGTH = 512 * 1024; // 512 KB
const LOGO_FETCH_TIMEOUT_MS = 4000;
const PDF_RENDER_TIMEOUT_MS = 15000;
const ALLOWED_DATA_IMAGE_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
  "data:image/webp;base64,",
];

export function getTrustedLogoOrigins() {
  const origins = new Set(["https://res.cloudinary.com"]);
  const extra = process.env.TRUSTED_ASSET_ORIGINS || "";
  for (const item of extra.split(",")) {
    const trimmed = item.trim();
    if (trimmed) {
      try {
        origins.add(new URL(trimmed).origin);
      } catch {
        // Ignore malformed env origin
      }
    }
  }
  return origins;
}

export function isPrivateOrReservedIp(ip) {
  if (!ip || typeof ip !== "string") return true;
  let normalized = ip.trim().toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    normalized = normalized.slice(7);
  }

  if (net.isIPv4(normalized)) {
    const parts = normalized.split(".").map(Number);
    const [a, b] = parts;
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    return false;
  }

  if (net.isIPv6(normalized)) {
    if (normalized === "::1" || normalized === "::") return true;
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
    if (normalized.startsWith("fe80")) return true; // fe80::/10
    return false;
  }

  return true;
}

export function isSafeDataImageUrl(rawUrl) {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_DATA_URL_LENGTH) return false;
  const lower = trimmed.toLowerCase();
  return ALLOWED_DATA_IMAGE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function isTrustedLogoUrl(rawUrl, trustedOrigins = getTrustedLogoOrigins()) {
  if (typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;

  if (trimmed.toLowerCase().startsWith("data:")) {
    return isSafeDataImageUrl(trimmed);
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.port && parsed.port !== "443") return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || net.isIP(host)) return false;

  return trustedOrigins.has(parsed.origin);
}

export function hasValidImageSignature(buffer, contentType = "") {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  const mime = contentType.split(";")[0].trim().toLowerCase();

  if (mime === "image/png") {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === "image/webp") {
    return (
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

export async function fetchAndValidateLogoDataUri(
  rawUrl,
  {
    dnsLookup = dns.promises.lookup,
    httpsRequest = https.request,
    trustedOrigins = getTrustedLogoOrigins(),
    timeoutMs = LOGO_FETCH_TIMEOUT_MS,
    maxBytes = MAX_DATA_URL_LENGTH,
  } = {},
) {
  if (typeof rawUrl !== "string") return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  if (trimmed.toLowerCase().startsWith("data:")) {
    return isSafeDataImageUrl(trimmed) ? trimmed : null;
  }

  if (!isTrustedLogoUrl(trimmed, trustedOrigins)) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  let pinnedAddress;
  let pinnedFamily;
  try {
    const records = await dnsLookup(parsed.hostname, { all: true });
    if (!Array.isArray(records) || records.length === 0) return null;
    if (!records.every((rec) => !isPrivateOrReservedIp(rec.address))) {
      return null;
    }
    pinnedAddress = records[0].address;
    pinnedFamily = records[0].family || (net.isIPv6(pinnedAddress) ? 6 : 4);
  } catch {
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    const req = httpsRequest(
      {
        protocol: "https:",
        hostname: parsed.hostname,
        port: 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        rejectUnauthorized: true,
        servername: parsed.hostname,
        lookup: (_host, _opts, cb) => cb(null, pinnedAddress, pinnedFamily),
        headers: {
          Accept: "image/png,image/jpeg,image/webp",
        },
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          return finish(null);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return finish(null);
        }

        const contentType = String(res.headers["content-type"] || "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(contentType)) {
          res.resume();
          return finish(null);
        }

        const chunks = [];
        let totalBytes = 0;

        res.on("data", (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes > maxBytes) {
            res.destroy();
            return finish(null);
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          const buffer = Buffer.concat(chunks, totalBytes);
          if (!hasValidImageSignature(buffer, contentType)) {
            return finish(null);
          }
          const normalizedMime = contentType === "image/jpg" ? "image/jpeg" : contentType;
          return finish(`data:${normalizedMime};base64,${buffer.toString("base64")}`);
        });

        res.on("error", () => finish(null));
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
    req.end();
  });
}

export async function validateLogoRequestUrl(
  requestUrl,
  dnsLookup = dns.promises.lookup,
  trustedOrigins = getTrustedLogoOrigins(),
) {
  if (requestUrl === "about:blank") return true;
  if (typeof requestUrl !== "string") return false;

  if (requestUrl.toLowerCase().startsWith("data:")) {
    return isSafeDataImageUrl(requestUrl);
  }

  if (!isTrustedLogoUrl(requestUrl, trustedOrigins)) {
    return false;
  }

  try {
    const parsed = new URL(requestUrl);
    const records = await dnsLookup(parsed.hostname, { all: true });
    if (!Array.isArray(records) || records.length === 0) return false;
    return records.every((rec) => !isPrivateOrReservedIp(rec.address));
  } catch {
    return false;
  }
}

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
export function generateInvoiceHtml({
  invoice,
  payments = [],
  branch = {},
  appointment = {},
  organization = {},
}) {
  const timezone = branch?.timezone || "Asia/Kolkata";
  const isDraft = invoice.status === "draft";
  const isFinalized = invoice.status === "finalized";
  const isCancelled = invoice.status === "cancelled";

  // Document Title
  const documentTitle = isFinalized
    ? "INVOICE"
    : isDraft
      ? "DRAFT INVOICE / ESTIMATE"
      : "CANCELLED INVOICE";

  // Status Badges
  const statusColor = isFinalized
    ? "#15803d"
    : isCancelled
      ? "#b91c1c"
      : "#b45309";
  const statusBg = isFinalized
    ? "#dcfce7"
    : isCancelled
      ? "#fee2e2"
      : "#fef3c7";

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

  const customerName =
    invoice.customerSnapshot?.name ||
    invoice.customerId?.name ||
    "Valued Customer";
  const customerPhone =
    invoice.customerSnapshot?.phone || invoice.customerId?.phone || "N/A";
  const customerEmail =
    invoice.customerSnapshot?.email || invoice.customerId?.email || "N/A";

  const stylistName =
    appointment?.staffId?.name ||
    (appointment?.staffId && typeof appointment.staffId === "object"
      ? appointment.staffId.name
      : null) ||
    "Unassigned";

  // Services / Items rows
  const serviceRows = (invoice.lines || [])
    .map((line, index) => {
      const lineType = line.lineType || "service";
      const isSubscriptionItem = lineType === "subscription";
      const isProductItem = lineType === "product";
      const isMembershipItem = lineType === "membership";
      const isCovered = Boolean(line.isCoveredBySubscription);
      const qty = line.quantity ?? 1;
      const staffName =
        line.staffId && typeof line.staffId === "object" && line.staffId.name
          ? line.staffId.name
          : null;

      let benefitHtml = `<span class="text-muted">—</span>`;
      if (isSubscriptionItem) {
        benefitHtml = `<div class="sub-benefit">Membership / Subscription Package</div>`;
      } else if (isCovered) {
        const planLabel = line.appliedSubscriptionId?.subscriptionCode
          ? `: ${escapeHtml(line.appliedSubscriptionId.subscriptionCode)}`
          : line.appliedSubscriptionId?.planId?.name
            ? `: ${escapeHtml(line.appliedSubscriptionId.planId.name)}`
            : "";
        benefitHtml = `<div class="sub-benefit">100% Covered via Plan${planLabel}</div>`;
      } else {
        const badges = [];
        if (line.membershipDiscountAmount > 0) {
          badges.push(`<div class="sub-benefit">Membership Disc: -${formatCurrency(line.membershipDiscountAmount)}</div>`);
        }
        if (line.lineDiscountTotal > 0) {
          badges.push(`<div class="text-sm text-muted">Line Disc: -${formatCurrency(line.lineDiscountTotal)}</div>`);
        }
        if (badges.length > 0) {
          benefitHtml = badges.join("");
        }
      }

      const metaParts = [];
      if (isProductItem) {
        if (line.sku) metaParts.push(`SKU: ${escapeHtml(line.sku)}`);
        metaParts.push(`Qty: ${qty}${line.stockUnit ? ` ${escapeHtml(line.stockUnit)}` : ""}`);
      } else if (isMembershipItem) {
        if (line.membershipTierSnapshot) metaParts.push(`Tier: ${escapeHtml(line.membershipTierSnapshot)}`);
        metaParts.push(`Qty: ${qty}`);
      } else if (isSubscriptionItem) {
        metaParts.push(`Qty: ${qty}`);
      } else {
        metaParts.push(`Qty: ${qty}`);
        if (line.duration > 0) metaParts.push(`${line.duration} mins`);
      }
      if (staffName) {
        metaParts.push(`Staff: ${escapeHtml(staffName)}`);
      }

      const detailText =
        metaParts.length > 0
          ? `<div class="text-sm text-muted">${metaParts.join(" • ")}</div>`
          : "";

      return `
        <tr>
          <td class="text-center font-mono">${index + 1}</td>
          <td>
            <div class="font-bold text-dark">${escapeHtml(line.name)}</div>
            ${detailText}
          </td>
          <td class="text-right font-mono">${formatCurrency(line.unitPrice)}</td>
          <td>${benefitHtml}</td>
          <td class="text-right font-mono font-bold">${formatCurrency(line.customerPayable)}</td>
        </tr>
      `;
    })
    .join("");

  // Payments & Refunds rows
  const paymentRows =
    payments && payments.length > 0
      ? payments
          .map((pay) => {
            const isVoided = pay.status === "voided";
            const isRefund = pay.type === "refund";
            const typeLabel = isRefund ? "REFUND" : "PAYMENT";
            const payStatusBadge = isVoided
              ? `<span class="badge badge-voided">VOIDED</span>`
              : isRefund
                ? `<span class="badge badge-voided">REFUNDED</span>`
                : `<span class="badge badge-success">COMPLETED</span>`;

            return `
              <tr>
                <td class="font-mono text-sm">${escapeHtml(pay.paymentNumber || "—")}</td>
                <td class="font-mono text-sm">${formatDateTime(pay.paymentDate || pay.createdAt, timezone)}</td>
                <td class="font-bold uppercase text-sm">${escapeHtml(pay.method)}</td>
                <td class="font-bold text-sm">${typeLabel}</td>
                <td class="text-sm text-muted">${escapeHtml(pay.referenceNote || "—")}</td>
                <td class="text-right font-mono font-bold ${isVoided ? "line-through text-muted" : ""}">${formatCurrency(pay.amount)}</td>
                <td class="text-center">${payStatusBadge}</td>
              </tr>
            `;
          })
          .join("")
      : `<tr><td colspan="7" class="text-center text-muted py-3">No payments recorded yet.</td></tr>`;

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
      table-layout: fixed;
      word-wrap: break-word;
      overflow-wrap: anywhere;
    }
    table.data-table thead {
      display: table-header-group;
    }
    table.data-table tr,
    .meta-card,
    .summary-box,
    .ledger-container,
    .footer-section {
      break-inside: avoid;
      page-break-inside: avoid;
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
        ${(() => {
          const orgDisplayName = organization?.displayName || organization?.name || "";
          const orgLegalName =
            organization?.name &&
            organization?.displayName &&
            organization.name !== organization.displayName
              ? organization.name
              : null;
          const rawLogo = typeof organization?.logo === "string" ? organization.logo.trim() : "";
          const isValidLogo = isTrustedLogoUrl(rawLogo);
          const logoHtml = isValidLogo
            ? `<img src="${escapeHtml(rawLogo)}" alt="" onerror="this.style.display='none'" style="max-height: 48px; max-width: 180px; object-fit: contain; margin-bottom: 8px; display: block;" />`
            : "";

          const subtitleParts = [];
          if (orgLegalName) subtitleParts.push(`<span>${escapeHtml(orgLegalName)}</span>`);
          if (branch?.name) subtitleParts.push(`<strong>${escapeHtml(branch.name)}</strong>`);
          if (branch?.address) subtitleParts.push(escapeHtml(branch.address));
          if (branch?.phone) subtitleParts.push(`Contact: ${escapeHtml(branch.phone)}`);
          if (organization?.email) subtitleParts.push(`Email: ${escapeHtml(organization.email)}`);
          if (organization?.website) subtitleParts.push(`Web: ${escapeHtml(organization.website)}`);

          return `
            ${logoHtml}
            ${orgDisplayName ? `<div class="company-title">${escapeHtml(orgDisplayName)}</div>` : ""}
            ${subtitleParts.length > 0 ? `<div class="company-subtitle">${subtitleParts.join("<br/>")}</div>` : ""}
          `;
        })()}
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
          ${
            invoice.appointmentCode
              ? `<div class="meta-row">
                  <span class="meta-key">Appointment Code:</span>
                  <span class="meta-val font-mono">${escapeHtml(invoice.appointmentCode)}</span>
                </div>`
              : invoice.subscriptionCode
                ? `<div class="meta-row">
                  <span class="meta-key">Subscription Code:</span>
                  <span class="meta-val font-mono">${escapeHtml(invoice.subscriptionCode)}</span>
                </div>`
                : ""
          }
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
                  <span>Total Discounts:</span>
                  <span class="font-mono">- ${formatCurrency(invoice.discountTotal)}</span>
                </div>`
              : ""
          }
          ${(() => {
            const membershipDiscountTotal = (invoice.items || invoice.lines || []).reduce(
              (sum, item) => sum + (item.membershipDiscountAmount || 0),
              0
            );
            return membershipDiscountTotal > 0
              ? `<div class="summary-row sub-benefit" style="font-size: 11px; padding-left: 22px;">
                  <span>↳ Membership Benefit:</span>
                  <span class="font-mono">- ${formatCurrency(membershipDiscountTotal)}</span>
                </div>`
              : "";
          })()}
          ${
            invoice.coupon?.code && invoice.coupon?.calculatedDiscountAmount > 0
              ? `<div class="summary-row text-muted" style="font-size: 11px; padding-left: 22px;">
                  <span>↳ Coupon (${escapeHtml(invoice.coupon.code)}):</span>
                  <span class="font-mono">- ${formatCurrency(invoice.coupon.calculatedDiscountAmount)}</span>
                </div>`
              : ""
          }
          ${
            invoice.lineDiscountsTotal > 0
              ? `<div class="summary-row text-muted" style="font-size: 11px; padding-left: 22px;">
                  <span>↳ Manual Line Discounts:</span>
                  <span class="font-mono">- ${formatCurrency(invoice.lineDiscountsTotal)}</span>
                </div>`
              : ""
          }
          ${
            invoice.invoiceDiscountsTotal > 0
              ? `<div class="summary-row text-muted" style="font-size: 11px; padding-left: 22px;">
                  <span>↳ Manual Invoice Discounts:</span>
                  <span class="font-mono">- ${formatCurrency(invoice.invoiceDiscountsTotal)}</span>
                </div>`
              : ""
          }
          ${
            invoice.loyaltyDiscountAmount > 0
              ? `<div class="summary-row text-muted" style="font-size: 11px; padding-left: 22px;">
                  <span>↳ Loyalty (${invoice.loyaltyRedeemedPoints || 0} pts):</span>
                  <span class="font-mono">- ${formatCurrency(invoice.loyaltyDiscountAmount)}</span>
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
              <th style="width: 16%;">Payment #</th>
              <th style="width: 20%;">Date & Time</th>
              <th style="width: 11%;">Method</th>
              <th style="width: 11%;">Type</th>
              <th style="width: 20%;">Reference / Note</th>
              <th style="width: 12%;" class="text-right">Amount</th>
              <th style="width: 10%;" class="text-center">Status</th>
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
  let safeData = data;
  if (data?.organization?.logo) {
    const resolvedLogoDataUri = await fetchAndValidateLogoDataUri(data.organization.logo);
    safeData = {
      ...data,
      organization: {
        ...data.organization,
        logo: resolvedLogoDataUri,
      },
    };
  }

  const htmlContent = generateInvoiceHtml(safeData);

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
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      if (url === "about:blank" && req.resourceType() === "document") {
        return req.continue();
      }
      if (req.resourceType() === "image" && isSafeDataImageUrl(url)) {
        return req.continue();
      }
      return req.abort();
    });

    await page.setContent(htmlContent, {
      waitUntil: "networkidle0",
      timeout: PDF_RENDER_TIMEOUT_MS,
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
