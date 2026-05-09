import { CEO_NAME_TH } from "../config/constants.js";
import { PDFDocument } from "pdf-lib";
import {
  getDocumentById,
  insertDocumentRecord,
  listRecentDocuments,
} from "../services/document-persistence.service.js";
import { getCurrentDocumentDate } from "../services/document-date.service.js";
import {
  DEFAULT_TEMPLATE_KEY,
  generateTemplateDebugGridPdf,
  stampTemplatePdf,
} from "../services/pdfStampService.js";
import { findBranchById } from "../services/branches.service.js";
import { findUserWithBranchById } from "../services/user-profile.service.js";

const KNOWN_FORM_KEYS = new Set([
  "pharmacyNameTh",
  "pharmacy_name_th",
  "branchNameTh",
  "branch_name_th",
  "soi",
  "addressNo",
  "address_no",
  "district",
  "province",
  "postcode",
  "phone",
  "licenseNo",
  "license_no",
  "locationText",
  "location_text",
  "operatorTitle",
  "operator_title",
  "operatorWorkHours",
  "operator_work_hours",
  "branchCode",
  "branch_code",
  "pharmacyDisplayName",
  "displayNameTh",
  "display_name_th",
  "licenseeNameTh",
  "licensee_name_th",
  "subPharmacistSlots",
  "sub_pharmacist_slots",
]);

function toNonEmptyString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const result = String(value).trim();
  return result.length > 0 ? result : null;
}

function pickValue(...candidates) {
  for (const candidate of candidates) {
    const text = toNonEmptyString(candidate);
    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeFormData(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  return input;
}

function normalizeSubPharmacistSlots(input) {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((slot) => slot && typeof slot === "object" && !Array.isArray(slot))
    .slice(0, 10);
}

function mapPayloadFromUserData(userRow, documentDate, formData, templateKey, subPharmacistSlots) {
  const data = normalizeFormData(formData);
  const pharmacyNameTh = pickValue(
    data.pharmacyNameTh,
    data.pharmacy_name_th,
    userRow.pharmacy_name_th
  );
  const branchNameTh = pickValue(data.branchNameTh, data.branch_name_th, userRow.branch_name_th);
  const pharmacyDisplayName = [pharmacyNameTh, branchNameTh].filter(Boolean).join(" ").trim();

  return {
    templateKey: toNonEmptyString(templateKey) || DEFAULT_TEMPLATE_KEY,
    ceoNameTh: CEO_NAME_TH,
    licenseeNameTh: pickValue(data.licenseeNameTh, data.licensee_name_th, CEO_NAME_TH),
    branchCode: pickValue(data.branchCode, data.branch_code, userRow.branch_code),
    pharmacyNameTh,
    branchNameTh,
    pharmacyDisplayName,
    soi: pickValue(data.soi, userRow.soi),
    addressNo: pickValue(data.addressNo, data.address_no, userRow.address_no),
    district: pickValue(data.district, userRow.district),
    province: pickValue(data.province, userRow.province),
    postcode: pickValue(data.postcode, userRow.postcode),
    phone: pickValue(data.phone, userRow.phone),
    licenseNo: pickValue(data.licenseNo, data.license_no, userRow.license_no),
    locationText: pickValue(data.locationText, data.location_text, userRow.location_text),
    operatorTitle: pickValue(
      data.operatorTitle,
      data.operator_title,
      userRow.operator_display_name_th,
      userRow.operator_title
    ),
    operatorWorkHours: pickValue(
      data.operatorWorkHours,
      data.operator_work_hours,
      userRow.operator_work_hours
    ),
    displayNameTh: pickValue(
      data.displayNameTh,
      data.display_name_th,
      userRow.operator_display_name_th,
      userRow.display_name_th
    ),
    subPharmacistSlots: normalizeSubPharmacistSlots(subPharmacistSlots),
    documentDate,
    currentDocumentDate: documentDate,
    extraFields: Object.fromEntries(
      Object.entries(data).filter(([key]) => !KNOWN_FORM_KEYS.has(key))
    ),
  };
}

function shouldSaveDocument(req) {
  return String(req.query?.save || "").toLowerCase() === "true";
}

function shouldRenderPdf(req) {
  return String(req.query?.format || "").toLowerCase() === "pdf";
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || "")
  );
}

function canAccessDocument(req, documentRow) {
  if (req.auth.role === "admin") {
    return true;
  }

  return req.auth.branchId === documentRow.branch_id;
}

function buildDownloadFileName(payload, dateISOFallback = "document") {
  const branchCode = payload?.branchCode || "branch";
  const dateISO = payload?.documentDate?.dateISO || dateISOFallback;
  return `document-${branchCode}-${dateISO}.pdf`;
}

function buildBranchAwareUserRow(userRow, branchRow) {
  return {
    ...userRow,
    user_branch_id: branchRow.id,
    branch_id: branchRow.id,
    branch_code: branchRow.branch_code,
    pharmacy_name_th: branchRow.pharmacy_name_th,
    branch_name_th: branchRow.branch_name_th,
    address_no: branchRow.address_no,
    soi: branchRow.soi,
    district: branchRow.district,
    province: branchRow.province,
    postcode: branchRow.postcode,
    phone: branchRow.phone,
    license_no: branchRow.license_no,
    location_text: branchRow.location_text,
    operator_display_name_th: branchRow.operator_display_name_th,
    operator_title: branchRow.operator_title,
    operator_work_hours: branchRow.operator_work_hours,
  };
}

async function resolveDocumentTarget(req, userRow, requestedBranchId) {
  let payloadUserRow = userRow;
  let documentBranchId = userRow.user_branch_id || null;

  if (req.auth.role === "admin") {
    const adminTargetBranchId = requestedBranchId || userRow.user_branch_id;
    if (!adminTargetBranchId) {
      return {
        error: {
          status: 400,
          body: { error: "branchId is required for admin users without an assigned branch." },
        },
      };
    }

    const targetBranchRow = await findBranchById(adminTargetBranchId);
    if (!targetBranchRow) {
      return {
        error: {
          status: 404,
          body: { error: "Branch not found." },
        },
      };
    }

    payloadUserRow = buildBranchAwareUserRow(userRow, targetBranchRow);
    documentBranchId = targetBranchRow.id;
  } else {
    if (!userRow.user_branch_id) {
      return {
        error: {
          status: 403,
          body: { error: "Forbidden." },
        },
      };
    }

    if (requestedBranchId && requestedBranchId !== userRow.user_branch_id) {
      return {
        error: {
          status: 403,
          body: { error: "Forbidden." },
        },
      };
    }
  }

  return {
    documentBranchId,
    payloadUserRow,
  };
}

function normalizeMergedDocumentRequests(req) {
  const documents = Array.isArray(req.body?.documents) ? req.body.documents : [];
  return documents
    .filter((document) => document && typeof document === "object" && !Array.isArray(document))
    .slice(0, 50);
}

function buildMergedDownloadFileName(payloads, dateISOFallback = "document") {
  const firstPayload = payloads[0] || {};
  const branchCode = firstPayload.branchCode || "branch";
  const dateISO = firstPayload?.documentDate?.dateISO || dateISOFallback;
  return `document-${branchCode}-${dateISO}-merged.pdf`;
}

async function mergePdfBytesList(pdfBytesList) {
  const mergedPdf = await PDFDocument.create();

  for (const pdfBytes of pdfBytesList) {
    const sourcePdf = await PDFDocument.load(pdfBytes);
    const copiedPages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  return mergedPdf.save();
}

function sendPdfResponse(
  res,
  pdfBytes,
  fileName,
  documentId = null,
  contentDispositionType = "attachment"
) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${contentDispositionType}; filename="${fileName}"`);
  res.setHeader("Cache-Control", "no-store");

  if (documentId) {
    res.setHeader("X-Document-Id", documentId);
  }

  return res.status(200).send(Buffer.from(pdfBytes));
}

function mapRecentDocumentRow(row) {
  return {
    id: row.id,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByUsername: row.created_by_username,
    branchId: row.branch_id,
    branchCode: row.branch_code,
    documentDateISO: row.document_date_iso || null,
  };
}

function handlePdfError(error, res, next) {
  if (error?.statusCode) {
    return res.status(error.statusCode).json({ error: error.message });
  }

  if (error?.message?.includes("Thai font")) {
    return res.status(500).json({ error: error.message });
  }

  return next(error);
}

export async function generateDocumentPdf(req, res, next) {
  try {
    const formData = req.body?.formData || {};
    const templateKey = toNonEmptyString(req.body?.templateKey) || DEFAULT_TEMPLATE_KEY;
    const requestedBranchId = toNonEmptyString(req.body?.branchId);
    const subPharmacistSlots = normalizeSubPharmacistSlots(
      req.body?.subPharmacistSlots || formData?.subPharmacistSlots
    );
    const userRow = await findUserWithBranchById(req.auth.userId);

    if (!userRow) {
      return res.status(404).json({ error: "User profile not found." });
    }

    const target = await resolveDocumentTarget(req, userRow, requestedBranchId);
    if (target.error) {
      return res.status(target.error.status).json(target.error.body);
    }

    const documentDate = await getCurrentDocumentDate();
    const pdfPayload = mapPayloadFromUserData(
      target.payloadUserRow,
      documentDate,
      formData,
      templateKey,
      subPharmacistSlots
    );
    const { pdfBytes, templateKey: resolvedTemplateKey } = await stampTemplatePdf({
      templateKey,
      payload: pdfPayload,
    });
    pdfPayload.templateKey = resolvedTemplateKey;

    let documentId = null;
    if (shouldSaveDocument(req)) {
      if (!target.documentBranchId) {
        return res.status(400).json({
          error: "Unable to save document because target branch is missing.",
        });
      }

      const saved = await insertDocumentRecord({
        createdBy: req.auth.userId,
        branchId: target.documentBranchId,
        payload: pdfPayload,
      });
      documentId = saved.id;
    }

    const fileName = buildDownloadFileName(pdfPayload, documentDate.dateISO);

    return sendPdfResponse(res, pdfBytes, fileName, documentId);
  } catch (error) {
    return handlePdfError(error, res, next);
  }
}

export async function generateMergedDocumentPdf(req, res, next) {
  try {
    const requestedBranchId = toNonEmptyString(req.body?.branchId);
    const documentRequests = normalizeMergedDocumentRequests(req);
    const userRow = await findUserWithBranchById(req.auth.userId);

    if (!userRow) {
      return res.status(404).json({ error: "User profile not found." });
    }

    if (documentRequests.length === 0) {
      return res.status(400).json({ error: "documents must contain at least one document payload." });
    }

    const target = await resolveDocumentTarget(req, userRow, requestedBranchId);
    if (target.error) {
      return res.status(target.error.status).json(target.error.body);
    }

    const documentDate = await getCurrentDocumentDate();
    const pdfBytesList = [];
    const pdfPayloads = [];

    for (const documentRequest of documentRequests) {
      const templateKey =
        toNonEmptyString(documentRequest.templateKey) ||
        toNonEmptyString(req.body?.templateKey) ||
        DEFAULT_TEMPLATE_KEY;
      const formData = documentRequest.formData || {};
      const subPharmacistSlots = normalizeSubPharmacistSlots(
        documentRequest.subPharmacistSlots || formData?.subPharmacistSlots
      );
      const pdfPayload = mapPayloadFromUserData(
        target.payloadUserRow,
        documentDate,
        formData,
        templateKey,
        subPharmacistSlots
      );
      const { pdfBytes, templateKey: resolvedTemplateKey } = await stampTemplatePdf({
        templateKey,
        payload: pdfPayload,
      });

      pdfPayload.templateKey = resolvedTemplateKey;
      pdfBytesList.push(pdfBytes);
      pdfPayloads.push(pdfPayload);
    }

    const mergedPdfBytes = await mergePdfBytesList(pdfBytesList);

    let documentId = null;
    if (shouldSaveDocument(req)) {
      if (!target.documentBranchId) {
        return res.status(400).json({
          error: "Unable to save document because target branch is missing.",
        });
      }

      const saved = await insertDocumentRecord({
        createdBy: req.auth.userId,
        branchId: target.documentBranchId,
        payload: {
          merged: true,
          documentCount: pdfPayloads.length,
          documents: pdfPayloads,
        },
      });
      documentId = saved.id;
    }

    const fileName = buildMergedDownloadFileName(pdfPayloads, documentDate.dateISO);

    return sendPdfResponse(res, mergedPdfBytes, fileName, documentId);
  } catch (error) {
    return handlePdfError(error, res, next);
  }
}

export async function getDocumentByIdHandler(req, res, next) {
  try {
    if (!isUuid(req.params.id)) {
      return res.status(400).json({ error: "Invalid document id." });
    }

    const documentRow = await getDocumentById(req.params.id);
    if (!documentRow) {
      return res.status(404).json({ error: "Document not found." });
    }

    if (!canAccessDocument(req, documentRow)) {
      return res.status(403).json({ error: "Forbidden." });
    }

    if (shouldRenderPdf(req)) {
      const payload = documentRow.payload || {};
      const { pdfBytes } = await stampTemplatePdf({
        templateKey: toNonEmptyString(payload.templateKey) || DEFAULT_TEMPLATE_KEY,
        payload,
      });
      const fileName = buildDownloadFileName(payload);
      return sendPdfResponse(res, pdfBytes, fileName, documentRow.id);
    }

    return res.status(200).json({
      id: documentRow.id,
      createdBy: documentRow.created_by,
      createdByUsername: documentRow.created_by_username,
      branchId: documentRow.branch_id,
      branchCode: documentRow.branch_code,
      createdAt: documentRow.created_at,
      payload: documentRow.payload,
    });
  } catch (error) {
    return handlePdfError(error, res, next);
  }
}

export async function getRecentDocumentsHandler(req, res, next) {
  try {
    const rows = await listRecentDocuments({
      limit: req.query.limit,
      branchId: req.auth.role === "admin" ? null : req.auth.branchId,
    });

    return res.status(200).json({
      documents: rows.map(mapRecentDocumentRow),
    });
  } catch (error) {
    return next(error);
  }
}

export async function getDocumentDebugGridHandler(req, res, next) {
  try {
    const templateKey = toNonEmptyString(req.query?.templateKey) || DEFAULT_TEMPLATE_KEY;
    const { pdfBytes, templateKey: resolvedTemplateKey } =
      await generateTemplateDebugGridPdf(templateKey);

    return sendPdfResponse(
      res,
      pdfBytes,
      `debug-grid-${resolvedTemplateKey}.pdf`,
      null,
      "inline"
    );
  } catch (error) {
    return handlePdfError(error, res, next);
  }
}
