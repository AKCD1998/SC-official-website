// Repeated forward prefixes ("Fwd: Fwd: FW: ...") must all be stripped, case-insensitively,
// leaving the original subject as PharmCare sent it.
const FORWARD_PREFIX_PATTERN = /^\s*(fwd|fw)\s*:\s*/i;

function normalizeSubject(rawSubject) {
  let subject = String(rawSubject || "").trim();
  let strippedAny = true;

  while (strippedAny) {
    const stripped = subject.replace(FORWARD_PREFIX_PATTERN, "").trim();
    strippedAny = stripped !== subject;
    subject = stripped;
  }

  return subject;
}

function isForwardedSubject(rawSubject) {
  return FORWARD_PREFIX_PATTERN.test(String(rawSubject || ""));
}

function extractEmailAddress(value) {
  const angleMatch = /<([^<>]+)>/.exec(String(value || ""));
  const raw = angleMatch ? angleMatch[1] : String(value || "");
  return raw.trim().toLowerCase();
}

// Gmail's manual-forward body wraps the original message in a block like:
//   ---------- Forwarded message ---------
//   From: PharmCare <info@pharmcare.co>
//   Date: Mon, Jan 5, 2026 at 9:00 AM
//   Subject: PharmCare e-credit invoice CIV2601000123
//   To: <auukunn.bkk@gmail.com>
//
//   <original body...>
// Headers appear one per line, in that order, up to the first blank line.
const FORWARDED_BLOCK_PATTERN = /-{2,}\s*forwarded message\s*-{2,}/i;

function parseForwardedBlock(bodyText) {
  const text = String(bodyText || "");
  const blockMatch = FORWARDED_BLOCK_PATTERN.exec(text);

  if (!blockMatch) {
    return { found: false, originalDate: "", originalFrom: "", originalSubject: "" };
  }

  const afterBlock = text.slice(blockMatch.index + blockMatch[0].length);
  const headerSection = afterBlock.split(/\r?\n\s*\r?\n/)[0] || "";

  function extractHeader(label) {
    const headerPattern = new RegExp(`^${label}\\s*:\\s*(.+)$`, "im");
    const headerMatch = headerPattern.exec(headerSection);
    return headerMatch ? headerMatch[1].trim() : "";
  }

  return {
    found: true,
    originalDate: extractHeader("Date"),
    originalFrom: extractHeader("From"),
    originalSubject: extractHeader("Subject"),
  };
}

// Only two routes are actually observed today (see docs/13-pharmcare-finance-email-automation.md
// section 3): a Gmail-filter forward, where the visible From/Subject are already PharmCare's
// original ones, and a manual/API forward, where the visible From is the mailbox owner and the
// subject is prefixed with Fwd:. A hint can be passed once a real "direct to admin@" delivery
// path exists (none does yet), so this never has to guess.
function determineRoute({ rawSubject, routeHint }) {
  if (routeHint) {
    return routeHint;
  }

  return isForwardedSubject(rawSubject) ? "manual_forward" : "gmail_filter_forward";
}

function resolveOriginalIdentity({ bodyText, rawSubject, routeHint, visibleFrom }) {
  const route = determineRoute({ rawSubject, routeHint });
  const normalizedSubject = normalizeSubject(rawSubject);

  if (route === "manual_forward") {
    const forwarded = parseForwardedBlock(bodyText);

    return {
      forwardedBlockFound: forwarded.found,
      normalizedSubject,
      originalDate: forwarded.originalDate,
      originalFrom: extractEmailAddress(forwarded.originalFrom),
      originalSubject: forwarded.originalSubject
        ? normalizeSubject(forwarded.originalSubject)
        : normalizedSubject,
      route,
    };
  }

  return {
    forwardedBlockFound: false,
    normalizedSubject,
    originalDate: "",
    originalFrom: extractEmailAddress(visibleFrom),
    originalSubject: normalizedSubject,
    route,
  };
}

module.exports = {
  determineRoute,
  extractEmailAddress,
  isForwardedSubject,
  normalizeSubject,
  parseForwardedBlock,
  resolveOriginalIdentity,
};
