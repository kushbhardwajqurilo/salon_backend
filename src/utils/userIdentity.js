export const normalizeUsername = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+|\.+$/g, "");
};

export const buildUsernameCandidate = (name, email) => {
  const fromName = normalizeUsername(name);
  if (fromName) return fromName;

  const fromEmail = normalizeUsername(email?.split("@")[0]);
  if (fromEmail) return fromEmail;

  return "user";
};

export const isValidUsername = (value) => {
  const normalized = normalizeUsername(value);
  return (
    Boolean(normalized) && normalized.length >= 3 && normalized.length <= 30
  );
};
