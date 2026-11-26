/**
 * E-TimeOffice Biometric Attendance Sync Service
 *
 * Uses cursor-based incremental sync (GET /DownloadLastPunchData) with
 * LastRecord -> MaxRecord persistence in ProviderSyncState so punches
 * are never duplicated or lost.
 */

const ETIMEOFFICE_BASE_URL = (
  process.env.ETIMEOFFICE_BASE_URL || "https://api.etimeoffice.com/api"
).replace(/\/+$/, "");

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
  corporateId = process.env.ETIMEOFFICE_CORPORATE_ID,
  username = process.env.ETIMEOFFICE_USERNAME,
  password = process.env.ETIMEOFFICE_PASSWORD,
  lastRecord,
  empcode = "ALL",
}) {
  const url = new URL(`${ETIMEOFFICE_BASE_URL}/DownloadLastPunchData`);
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
