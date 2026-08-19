const { parseCivFilename, parseSettlementFilename } = require("./cycleUtils");

const RECEIPT_SUBJECT_PATTERN = /(ใบเสร็จรับเงิน|ใบกำกับภาษี)/;
const CONTRACT_SUBJECT_PATTERN = /(สัญญา|contract|telepharmacy)/i;
const SUMMARY_SUBJECT_PATTERN = /รายงานสรุปข้อมูลบริการ/;
const E_CREDIT_SUBJECT_PATTERN = /e-credit invoice/i;

// Filenames/document numbers are the primary signal — subject text is only used to add or drop
// reasonCodes for the audit trail, never to override what the filename already proved.
function classifyAttachment({ filename, normalizedSubject }) {
  const settlement = parseSettlementFilename(filename);
  if (settlement) {
    const documentType = settlement.reportPrefix === "MRR" ? "settlement_mrr" : "settlement_sfr";
    const reasonCodes = ["filename_pattern_match", `report_prefix_${settlement.reportPrefix.toLowerCase()}`];
    if (!SUMMARY_SUBJECT_PATTERN.test(normalizedSubject)) {
      reasonCodes.push("subject_pattern_mismatch");
    }

    return {
      documentNumber: null,
      documentType,
      half: settlement.half,
      partnerCode: settlement.partnerCode,
      periodEnd: settlement.periodEnd,
      periodStart: settlement.periodStart,
      reasonCodes,
      reviewStatus: "auto_classified",
    };
  }

  const civ = parseCivFilename(filename);
  if (civ) {
    const reasonCodes = ["filename_pattern_match", "civ_number_extracted"];
    if (!E_CREDIT_SUBJECT_PATTERN.test(normalizedSubject)) {
      reasonCodes.push("subject_pattern_mismatch");
    }

    return {
      documentNumber: civ.documentNumber,
      documentType: "e_credit_invoice",
      half: null,
      partnerCode: null,
      periodEnd: null,
      periodStart: null,
      reasonCodes,
      reviewStatus: "auto_classified",
    };
  }

  if (CONTRACT_SUBJECT_PATTERN.test(normalizedSubject)) {
    return {
      documentNumber: null,
      documentType: "contract",
      half: null,
      partnerCode: null,
      periodEnd: null,
      periodStart: null,
      reasonCodes: ["subject_pattern_match_contract"],
      reviewStatus: "auto_classified",
    };
  }

  return {
    documentNumber: null,
    documentType: "unknown",
    half: null,
    partnerCode: null,
    periodEnd: null,
    periodStart: null,
    reasonCodes: ["no_filename_pattern_match", "no_subject_pattern_match"],
    reviewStatus: "manual_review",
  };
}

// Receipt/tax emails from PharmCare carry no attachment at all — a link is sent instead — so an
// email with zero attachments is not automatically "nothing to ingest": it must still surface
// as a queued document pending link retrieval, not be silently dropped.
function classifyReceiptLinkPending({ hasAttachment, normalizedSubject }) {
  if (hasAttachment || !RECEIPT_SUBJECT_PATTERN.test(normalizedSubject)) {
    return null;
  }

  return {
    documentNumber: null,
    documentType: "receipt_link_pending",
    half: null,
    partnerCode: null,
    periodEnd: null,
    periodStart: null,
    reasonCodes: ["no_attachment", "subject_pattern_match_receipt"],
    reviewStatus: "manual_review",
  };
}

module.exports = { classifyAttachment, classifyReceiptLinkPending };
