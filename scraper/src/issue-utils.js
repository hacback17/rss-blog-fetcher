// Shared helpers for the issue-ops automations (add-site, add-article,
// remove-site): parsing a rendered GitHub Issue Form body, and small text
// utilities used by more than one of them.

// GitHub renders each Issue Form field as "### <label>\n\n<value>\n\n",
// with "_No response_" standing in for an empty optional field.
export function parseIssueFields(body) {
  const fields = {};
  const parts = body.split(/^### /m).slice(1);
  for (const part of parts) {
    const newlineIdx = part.indexOf("\n");
    const label = part.slice(0, newlineIdx).trim();
    let value = part.slice(newlineIdx + 1).trim();
    if (value === "_No response_") value = "";
    fields[label] = value;
  }
  return fields;
}

export function splitList(value) {
  return (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function splitLines(value) {
  return (value || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}
