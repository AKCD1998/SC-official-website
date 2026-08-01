const { lastDayOfMonth, parseCivFilename, parseSettlementFilename } = require("../src/modules/seamless/services/pharmcare/cycleUtils");
const {
  determineRoute,
  normalizeSubject,
  parseForwardedBlock,
} = require("../src/modules/seamless/services/pharmcare/emailNormalizer");
const { classifyPharmcareEmail } = require("../src/modules/seamless/services/pharmcare/classifier");

// All fixtures below are synthetic — no real mailbox content, per
// docs/14-pharmcare-sonnet-implementation-plan.md section 5 Step 1.

describe("normalizeSubject", () => {
  test("strips a single Fwd: prefix", () => {
    expect(normalizeSubject("Fwd: PharmCare e-credit invoice CIV2601000123")).toBe(
      "PharmCare e-credit invoice CIV2601000123",
    );
  });

  test("strips repeated, case-insensitive, mixed Fwd:/FW: prefixes", () => {
    expect(normalizeSubject("FW: fwd: Fwd: รายงานสรุปข้อมูลบริการ 01-15")).toBe(
      "รายงานสรุปข้อมูลบริการ 01-15",
    );
  });

  test("leaves an unprefixed subject untouched", () => {
    expect(normalizeSubject("PharmCare e-credit invoice CIV2601000123")).toBe(
      "PharmCare e-credit invoice CIV2601000123",
    );
  });
});

describe("determineRoute", () => {
  test("classifies a Fwd:-prefixed subject as manual_forward", () => {
    expect(determineRoute({ rawSubject: "Fwd: PharmCare e-credit invoice" })).toBe("manual_forward");
  });

  test("classifies an unprefixed subject as gmail_filter_forward", () => {
    expect(determineRoute({ rawSubject: "PharmCare e-credit invoice" })).toBe("gmail_filter_forward");
  });

  test("honors an explicit routeHint for a future direct-delivery path", () => {
    expect(determineRoute({ rawSubject: "PharmCare e-credit invoice", routeHint: "direct" })).toBe("direct");
  });
});

describe("parseForwardedBlock", () => {
  test("extracts original From/Subject/Date from a Gmail forwarded block", () => {
    const bodyText = [
      "Hi team, forwarding this one.",
      "",
      "---------- Forwarded message ---------",
      "From: PharmCare <info@pharmcare.co>",
      "Date: Mon, Jan 5, 2026 at 9:00 AM",
      "Subject: PharmCare e-credit invoice CIV2601000123",
      "To: <auukunn.bkk@gmail.com>",
      "",
      "Please find attached the invoice.",
    ].join("\n");

    const result = parseForwardedBlock(bodyText);

    expect(result.found).toBe(true);
    expect(result.originalFrom).toBe("PharmCare <info@pharmcare.co>");
    expect(result.originalSubject).toBe("PharmCare e-credit invoice CIV2601000123");
    expect(result.originalDate).toBe("Mon, Jan 5, 2026 at 9:00 AM");
  });

  test("reports not found when there is no forwarded block", () => {
    expect(parseForwardedBlock("just a plain email body").found).toBe(false);
  });
});

describe("cycleUtils", () => {
  test("lastDayOfMonth handles 28/29/30/31-day months including a leap year", () => {
    expect(lastDayOfMonth(2026, 2)).toBe(28); // 2026 is not a leap year
    expect(lastDayOfMonth(2024, 2)).toBe(29); // 2024 is a leap year
    expect(lastDayOfMonth(2026, 4)).toBe(30);
    expect(lastDayOfMonth(2026, 1)).toBe(31);
  });

  test("parseSettlementFilename computes H1 period and cycle key", () => {
    const parsed = parseSettlementFilename("MRR2602-1-HSPCP00533.pdf");
    expect(parsed).toEqual({
      cycleKey: "2026-02-H1",
      half: "H1",
      partnerCode: "HSPCP00533",
      periodEnd: "2026-02-15",
      periodStart: "2026-02-01",
      reportPrefix: "MRR",
    });
  });

  test("parseSettlementFilename computes H2 period starting on the 16th through the real last day of the month", () => {
    const parsed = parseSettlementFilename("SFR2602-2-HSPCP00533.pdf");
    expect(parsed.periodStart).toBe("2026-02-16");
    expect(parsed.periodEnd).toBe("2026-02-28");
    expect(parsed.half).toBe("H2");
    expect(parsed.reportPrefix).toBe("SFR");
  });

  test("H2 periodStart is always the 16th, in both a leap and a non-leap February", () => {
    expect(parseSettlementFilename("MRR2402-2-HSPCP00533.pdf")).toMatchObject({
      periodStart: "2024-02-16",
      periodEnd: "2024-02-29",
    }); // 2024 is a leap year
    expect(parseSettlementFilename("MRR2602-2-HSPCP00533.pdf")).toMatchObject({
      periodStart: "2026-02-16",
      periodEnd: "2026-02-28",
    }); // 2026 is not a leap year
    expect(parseSettlementFilename("MRR2604-2-HSPCP00533.pdf")).toMatchObject({
      periodStart: "2026-04-16",
      periodEnd: "2026-04-30",
    }); // 30-day month
    expect(parseSettlementFilename("MRR2601-2-HSPCP00533.pdf")).toMatchObject({
      periodStart: "2026-01-16",
      periodEnd: "2026-01-31",
    }); // 31-day month
  });

  test("parseSettlementFilename returns null for a non-matching filename", () => {
    expect(parseSettlementFilename("random-file.pdf")).toBeNull();
  });

  test("parseCivFilename extracts the CIV document number", () => {
    expect(parseCivFilename("CIV2601000123.pdf")).toEqual({ documentNumber: "CIV2601000123" });
  });
});

describe("classifyPharmcareEmail", () => {
  test("classifies a direct (gmail_filter_forward) e-credit invoice email", () => {
    const result = classifyPharmcareEmail({
      attachments: [{ attachmentId: "att-1", filename: "CIV2601000123.pdf" }],
      rawSubject: "PharmCare e-credit invoice CIV2601000123",
      visibleFrom: "PharmCare <info@pharmcare.co>",
    });

    expect(result.route).toBe("gmail_filter_forward");
    expect(result.isSenderAllowed).toBe(true);
    expect(result.status).toBe("classified");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({
      documentNumber: "CIV2601000123",
      documentType: "e_credit_invoice",
      reviewStatus: "auto_classified",
    });
  });

  test("classifies a manual Fwd: forward using the forwarded header block", () => {
    const bodyText = [
      "---------- Forwarded message ---------",
      "From: PharmCare <info@pharmcare.co>",
      "Date: Mon, Jan 5, 2026 at 9:00 AM",
      "Subject: PharmCare e-credit invoice CIV2601000999",
      "To: <auukunn.bkk@gmail.com>",
      "",
      "body",
    ].join("\n");

    const result = classifyPharmcareEmail({
      attachments: [{ attachmentId: "att-2", filename: "CIV2601000999.pdf" }],
      bodyText,
      rawSubject: "Fwd: PharmCare e-credit invoice CIV2601000999",
      visibleFrom: "auukunn.bkk@gmail.com",
    });

    expect(result.route).toBe("manual_forward");
    expect(result.originalFrom).toBe("info@pharmcare.co");
    expect(result.isSenderAllowed).toBe(true);
    expect(result.status).toBe("classified");
    expect(result.documents[0].documentNumber).toBe("CIV2601000999");
  });

  test("classifies settlement MRR and SFR attachments on one settlement email", () => {
    const result = classifyPharmcareEmail({
      attachments: [
        { attachmentId: "att-3", filename: "MRR2602-1-HSPCP00533.pdf" },
        { attachmentId: "att-4", filename: "SFR2602-1-HSPCP00533.pdf" },
      ],
      rawSubject: "รายงานสรุปข้อมูลบริการตามรอบ 01-15 ก.พ. 2569",
      visibleFrom: "info@pharmcare.co",
    });

    expect(result.status).toBe("classified");
    expect(result.documents.map((doc) => doc.documentType)).toEqual([
      "settlement_mrr",
      "settlement_sfr",
    ]);
    expect(result.documents[0]).toMatchObject({ half: "H1", partnerCode: "HSPCP00533" });
  });

  test("classifies a receipt/tax email with no attachment as receipt_link_pending", () => {
    const result = classifyPharmcareEmail({
      attachments: [],
      rawSubject: "แจ้งใบเสร็จรับเงิน/ใบกำกับภาษี",
      visibleFrom: "info@pharmcare.co",
    });

    expect(result.status).toBe("manual_review");
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].documentType).toBe("receipt_link_pending");
  });

  test("classifies a contract email as non-financial", () => {
    const result = classifyPharmcareEmail({
      attachments: [
        { attachmentId: "att-5", filename: "telepharmacy-contract-1.pdf" },
        { attachmentId: "att-6", filename: "telepharmacy-contract-2.pdf" },
      ],
      rawSubject: "สัญญา Telepharmacy",
      visibleFrom: "info@pharmcare.co",
    });

    expect(result.documents.every((doc) => doc.documentType === "contract")).toBe(true);
  });

  test("sends an unrecognized attachment to manual_review with evidence, not a bare boolean", () => {
    const result = classifyPharmcareEmail({
      attachments: [{ attachmentId: "att-7", filename: "mystery-file.pdf" }],
      rawSubject: "Some unrelated subject",
      visibleFrom: "info@pharmcare.co",
    });

    expect(result.status).toBe("manual_review");
    expect(result.documents[0].documentType).toBe("unknown");
    expect(result.documents[0].reviewStatus).toBe("manual_review");
    expect(Array.isArray(result.documents[0].reasonCodes)).toBe(true);
    expect(result.documents[0].reasonCodes.length).toBeGreaterThan(0);
  });

  test("flags a sender outside the allowlist as manual_review even with a matching filename", () => {
    const result = classifyPharmcareEmail({
      attachments: [{ attachmentId: "att-8", filename: "CIV2601000123.pdf" }],
      rawSubject: "PharmCare e-credit invoice CIV2601000123",
      visibleFrom: "someone-else@example.com",
    });

    expect(result.isSenderAllowed).toBe(false);
    expect(result.status).toBe("manual_review");
    expect(result.reasonCodes).toContain("sender_not_allowlisted");
    expect(result.documents[0].reasonCodes).toContain("sender_not_allowlisted");
  });

  test("a manual forward missing the forwarded header block still returns evidence for manual review", () => {
    const result = classifyPharmcareEmail({
      attachments: [],
      bodyText: "no forwarded block here",
      rawSubject: "Fwd: something",
      visibleFrom: "auukunn.bkk@gmail.com",
    });

    expect(result.forwardedBlockFound).toBe(false);
    expect(result.reasonCodes).toContain("forwarded_block_not_found");
    expect(result.status).toBe("manual_review");
  });
});
