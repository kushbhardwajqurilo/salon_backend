/**
 * E-TimeOffice Biometric Attendance Sync Service
 *
 * Uses cursor-based incremental sync (GET /DownloadLastPunchData) with
 * LastRecord -> MaxRecord persistence in ProviderSyncState so punches
 * are never duplicated or lost.
 */

import { ProviderConfiguration } from "../../models/attendance/ProviderConfiguration.model.js";
import { ProviderSyncState } from "../../models/attendance/ProviderSyncState.model.js";
import { decryptCredentials } from "../../utils/encryption.js";
import { logger } from "../../utils/logger.js";
import { ingestProviderEvents } from "./attendance.service.js";

const DEFAULT_ETIMEOFFICE_BASE_URL = "https://api.etimeoffice.com/api";

function normalizeBaseUrl(url) {
  return (url || process.env.ETIMEOFFICE_BASE_URL || DEFAULT_ETIMEOFFICE_BASE_URL).replace(/\/+$/, "");
}

/**
 * Resolve E-TimeOffice credentials using a production-grade DB-first strategy:
 * 1. Look up active ProviderConfiguration in MongoDB for (organizationId, branchId).
 * 2. Fail closed if the branch explicitly deactivated the provider.
 * 3. Decrypt stored credentials via AES-256-GCM.
 * 4. Fall back to .env ONLY in non-production environments when no DB record exists.
 */
export async function resolveETimeOfficeConfig({ organizationId, branchId }) {
  if (!organizationId || !branchId) {
    throw new Error("organizationId and branchId are required to resolve E-TimeOffice config.");
  }

  const config = await ProviderConfiguration.findOne({
    organizationId,
    branchId,
    providerName: "eTimeOffice",
  }).lean();

  if (config) {
    if (!config.isActive) {
      throw new Error("E-TimeOffice provider is deactivated for this branch.");
    }
    let creds = null;
    try {
      creds = decryptCredentials(config.credentials) || {};
    } catch (decryptErr) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          "Unable to decrypt E-TimeOffice credentials. Please re-save the provider configuration.",
        );
      }
      logger.warn(
        `[AttendanceSync] Failed to decrypt DB credentials for branch ${branchId} (${decryptErr.message}); falling back to .env in non-production.`,
      );
      creds = null;
    }

    if (creds?.corporateId && creds?.username && creds?.password) {
      return {
        source: "database",
        baseUrl: normalizeBaseUrl(config.endpointUrl),
        corporateId: creds.corporateId,
        username: creds.username,
        password: creds.password,
      };
    }

    if (process.env.NODE_ENV === "production") {
      throw new Error("E-TimeOffice DB configuration is missing required credentials.");
    }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("No active E-TimeOffice configuration found in database for this branch.");
  }

  const corporateId = process.env.ETIMEOFFICE_CORPORATE_ID;
  const username = process.env.ETIMEOFFICE_USERNAME;
  const password = process.env.ETIMEOFFICE_PASSWORD;
  if (!corporateId || !username || !password) {
    throw new Error("No E-TimeOffice DB configuration found and .env fallback credentials are incomplete.");
  }

  return {
    source: "env",
    baseUrl: normalizeBaseUrl(),
    corporateId,
    username,
    password,
  };
}

/**
 * Build Basic Auth header per E-TimeOffice specification:
 * Base64(Corporateid:Username:Password:True)
 */
export function buildETimeOfficeAuthHeader({
  corporateId = process.env.ETIMEOFFICE_CORPORATE_ID,
  username = process.env.ETIMEOFFICE_USERNAME,
  password = process.env.ETIMEOFFICE_PASSWORD,
} = {}) {
  if (!corporateId || !username || !password) {
    throw new Error(
      "Missing E-TimeOffice credentials (ETIMEOFFICE_CORPORATE_ID, ETIMEOFFICE_USERNAME, ETIMEOFFICE_PASSWORD)",
    );
  }
  const raw = `${corporateId}:${username}:${password}:True`;
  const encoded = Buffer.from(raw, "utf8").toString("base64");
  return `Basic ${encoded}`;
}

/**
 * Parse E-TimeOffice PunchDate ("dd/MM/yyyy HH:mm:ss") into a JS Date.
 */
export function parseETimeOfficeDate(punchDateStr) {
  if (!punchDateStr || typeof punchDateStr !== "string") return null;
  const [datePart, timePart = "00:00:00"] = punchDateStr.trim().split(" ");
  const [day, month, year] = datePart.split("/").map(Number);
  const [hour, minute, second = 0] = timePart.split(":").map(Number);
  if (!day || !month || !year) return null;
  return new Date(year, month - 1, day, hour || 0, minute || 0, second || 0);
}

/**
 * Fetch incremental punches from E-TimeOffice DownloadLastPunchData.
 */
export async function fetchLastPunchData({
  baseUrl,
  corporateId,
  username,
  password,
  lastRecord,
  empcode = "ALL",
}) {
  const url = new URL(`${normalizeBaseUrl(baseUrl)}/DownloadLastPunchData`);
  url.searchParams.set("Empcode", empcode);
  url.searchParams.set("LastRecord", lastRecord);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: buildETimeOfficeAuthHeader({
        corporateId,
        username,
        password,
      }),
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `E-TimeOffice API error: ${response.status} ${response.statusText}`,
    );
  }

  const payload = await response.json();
  if (payload?.Error) {
    throw new Error(`E-TimeOffice API returned error: ${payload.Msg}`);
  }

  return {
    punches: Array.isArray(payload?.PunchData) ? payload.PunchData : [],
    maxRecord: payload?.MaxRecord || lastRecord,
  };
}

const inFlightBranches = new Set();

/**
 * Sync incremental punches for a single branch from E-TimeOffice.
 * Uses an in-memory per-branch lock to prevent overlapping manual/cron runs.
 */
export async function syncETimeOfficeForBranch({
  organizationId,
  branchId,
  request = null,
}) {
  const lockKey = `${organizationId}:${branchId}`;
  if (inFlightBranches.has(lockKey)) {
    return { skipped: true, reason: "Sync already in progress for this branch." };
  }

  inFlightBranches.add(lockKey);
  try {
    const config = await resolveETimeOfficeConfig({ organizationId, branchId });
    const syncState = await ProviderSyncState.findOne({
      organizationId,
      branchId,
      provider: "eTimeOffice",
    }).lean();

    const pad = (n) => String(n).padStart(2, "0");
    const now = new Date();
    const defaultLastRecord = `${pad(now.getMonth() + 1)}${now.getFullYear()}$0`;
    const lastRecord =
      syncState?.lastRecord && /^\d{6}\$\d+$/.test(syncState.lastRecord)
        ? syncState.lastRecord
        : defaultLastRecord;
    const { punches, maxRecord } = await fetchLastPunchData({
      baseUrl: config.baseUrl,
      corporateId: config.corporateId,
      username: config.username,
      password: config.password,
      lastRecord,
    });

    let ingestedCount = 0;
    if (punches.length > 0) {
      const events = punches.map((p, idx) => ({
        eventId: `etimeoffice-${p.Empcode || "unknown"}-${p.PunchDate || idx}`,
        externalEmployeeCode: String(p.Empcode || "").trim(),
        deviceId: String(p.mcid || p.SerialNumber || p.DeviceSerialNo || "default").trim(),
        punchTime: parseETimeOfficeDate(p.PunchDate)?.toISOString() || new Date().toISOString(),
        raw: p,
      }));
      const ingestResult = await ingestProviderEvents({
        organizationId,
        branchId,
        providerName: "eTimeOffice",
        streamIdentifier: "realtime",
        checkpoint: maxRecord || lastRecord,
        events,
        request: request || {
          headers: { "x-sync-source": "attendance-sync-worker" },
          ip: null,
        },
      });
      ingestedCount = ingestResult?.processedCount ?? events.length;
    }

    await ProviderSyncState.findOneAndUpdate(
      { organizationId, branchId, provider: "eTimeOffice" },
      {
        $set: {
          lastRecord: maxRecord,
          lastSyncedAt: new Date(),
          lastError: null,
        },
      },
      { upsert: true, new: true },
    );

    await ProviderConfiguration.findOneAndUpdate(
      { organizationId, branchId, providerName: "eTimeOffice" },
      { $set: { syncStatus: "healthy", lastSyncAt: new Date() } },
    );

    return {
      skipped: false,
      source: config.source,
      fetchedCount: punches.length,
      ingestedCount,
      lastRecord,
      maxRecord,
      punches,
    };
  } catch (error) {
    await ProviderConfiguration.findOneAndUpdate(
      { organizationId, branchId, providerName: "eTimeOffice" },
      { $set: { syncStatus: "error" } },
    ).catch(() => {});
    throw error;
  } finally {
    inFlightBranches.delete(lockKey);
  }
}

/**
 * Poll all active E-TimeOffice branch configurations.
 */
export async function syncAllActiveETimeOfficeBranches() {
  const activeConfigs = await ProviderConfiguration.find({
    providerName: "etimeoffice",
    isActive: true,
  })
    .select("organizationId branchId")
    .lean();

  const results = [];
  for (const cfg of activeConfigs) {
    try {
      const res = await syncETimeOfficeForBranch({
        organizationId: cfg.organizationId,
        branchId: cfg.branchId,
      });
      results.push({ branchId: cfg.branchId, ok: true, ...res });
    } catch (err) {
      logger.error(
        `[AttendanceSync] E-TimeOffice sync failed for branch ${cfg.branchId}: ${err.message}`,
      );
      results.push({ branchId: cfg.branchId, ok: false, error: err.message });
    }
  }
  return results;
}
