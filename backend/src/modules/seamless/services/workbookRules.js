const { getShopeeShopProfile } = require('./shopeeShops');

const BRANCH_CODE_MAP = {
  D1180: '001',
  D6239: '003',
  D5811: '004',
};

const TARGET_HEADERS_TO_DELETE = ['วันที่ลงทะเบียน', 'หมายเหตุอื่นๆ (STMID)'];
const HIGHLIGHT_HEADERS = [
  'ราคาต่อหน่วย',
  'ราคาเพดาน',
  'รวมเงินที่ขอเบิก',
  'ชดเชย',
  'ไม่ชดเชย',
  'จ่ายเพิ่ม',
  'เรียกคืน',
];

const THAI_MONTH_TO_NUMBER = {
  มกราคม: '01',
  มค: '01',
  กุมภาพันธ์: '02',
  กพ: '02',
  มีนาคม: '03',
  มีค: '03',
  เมษายน: '04',
  เมย: '04',
  พฤษภาคม: '05',
  พค: '05',
  มิถุนายน: '06',
  มิย: '06',
  กรกฎาคม: '07',
  กค: '07',
  สิงหาคม: '08',
  สค: '08',
  กันยายน: '09',
  กย: '09',
  ตุลาคม: '10',
  ตค: '10',
  พฤศจิกายน: '11',
  พย: '11',
  ธันวาคม: '12',
  ธค: '12',
};

function normalizeDisplayText(value) {
  if (value === null || typeof value === 'undefined') {
    return '';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object' && value.text) {
    return String(value.text).trim();
  }

  if (typeof value === 'object' && value.richText) {
    return value.richText.map((part) => part.text || '').join('').trim();
  }

  return String(value)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .trim();
}

function normalizeHeaderText(value) {
  return normalizeDisplayText(value)
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactHeaderText(value) {
  return normalizeHeaderText(value).replace(/\s+/g, '');
}

// ExcelJS's `cell.text` getter throws (rather than returning something falsy) for a merged
// cell whose merge-master reference is broken/dangling — real branch workbooks that have been
// hand-edited over the years hit this. `cell.text || cell.value` can't guard against that since
// the getter itself throws before the `||` ever runs, so the access has to be wrapped.
function safeCellText(cell) {
  try {
    if (cell.text) {
      return cell.text;
    }
  } catch (error) {
    // fall through to cell.value below
  }
  return cell.value;
}

function getCellText(worksheet, rowNumber, columnNumber) {
  const cell = worksheet.getRow(rowNumber).getCell(columnNumber);
  return normalizeDisplayText(safeCellText(cell));
}

function getA1Text(worksheet, address) {
  const cell = worksheet.getCell(address);
  return normalizeDisplayText(safeCellText(cell));
}

function findColumnByHeaderText(worksheet, headerText, options = {}) {
  const rowStart = options.rowStart || 1;
  const rowEnd = options.rowEnd || worksheet.rowCount || 1;
  const left = options.left || 1;
  const right = options.right || worksheet.columnCount || 1;
  const targetExact = normalizeHeaderText(headerText);
  const targetCompact = compactHeaderText(targetExact);
  let compactFallback = null;

  for (let rowNumber = rowStart; rowNumber <= rowEnd; rowNumber += 1) {
    for (let columnNumber = left; columnNumber <= right; columnNumber += 1) {
      const matchedText = getCellText(worksheet, rowNumber, columnNumber);

      if (!matchedText) {
        continue;
      }

      const normalizedText = normalizeHeaderText(matchedText);

      if (normalizedText === targetExact) {
        return {
          start: columnNumber,
          count: 1,
          rowNumber,
          columnNumber,
          matchedText,
          normalizedText,
          strategy: 'exact',
        };
      }

      if (!compactFallback && compactHeaderText(normalizedText) === targetCompact) {
        compactFallback = {
          start: columnNumber,
          count: 1,
          rowNumber,
          columnNumber,
          matchedText,
          normalizedText,
          strategy: 'trimmed',
        };
      }
    }
  }

  return compactFallback;
}

function sanitizeBaseName(originalFilename) {
  const nameWithoutExtension = String(originalFilename || 'workbook.xlsx').replace(/\.[^.]+$/, '');
  return (
    nameWithoutExtension
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workbook'
  );
}

function convertToGregorianYear(year) {
  if (Math.floor(year) !== year) {
    return null;
  }

  if (year >= 2400 && year <= 3000) {
    return year - 543;
  }

  if (year >= 1900 && year <= 2200) {
    return year;
  }

  return null;
}

function pad2(value) {
  return `0${String(value)}`.slice(-2);
}

function isValidDateParts(year, monthNumber, day) {
  const candidate = new Date(Date.UTC(year, Number(monthNumber) - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === Number(monthNumber) - 1 &&
    candidate.getUTCDate() === day
  );
}

function parseThaiBuddhistDate(rawValue) {
  const normalizedValue = normalizeDisplayText(rawValue);
  const match = normalizedValue.match(/(\d{4})\s*[/\-]?\s*([^\d]+?)\s*(\d{1,2})\s*$/u);

  if (!match) {
    return null;
  }

  const year = convertToGregorianYear(Number(match[1]));
  const monthNumber = THAI_MONTH_TO_NUMBER[normalizeDisplayText(match[2]).replace(/[./\s]/g, '')];
  const day = Number(match[3]);

  if (!monthNumber || !year || !isValidDateParts(year, monthNumber, day)) {
    return null;
  }

  return `${year}-${monthNumber}-${pad2(day)}`;
}

function parseSummaryRepDate(rawValue) {
  const normalizedValue = normalizeDisplayText(rawValue);
  const match = normalizedValue.match(
    /^(\d{1,2})\s*[/\-]\s*(\d{1,2})\s*[/\-]\s*(\d{4})(?:\s+เวลา\s+\d{1,2}:\d{2})?$/u,
  );

  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = convertToGregorianYear(Number(match[3]));

  if (!year || !isValidDateParts(year, pad2(month), day)) {
    return null;
  }

  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function mapBranchSourceToBranchCode(rawValue) {
  const normalized = normalizeDisplayText(rawValue)
    .toUpperCase()
    .replace(/\s+/g, '');
  const matchedCode = normalized.match(/D?\d{4}/);
  const base = matchedCode ? matchedCode[0] : normalized;
  const candidates = base.charAt(0) === 'D' ? [base] : [`D${base}`, base];

  for (const candidate of candidates) {
    if (BRANCH_CODE_MAP[candidate]) {
      return BRANCH_CODE_MAP[candidate];
    }
  }

  return null;
}

function getBranchResultFromHcodeColumn(worksheet) {
  const match = findColumnByHeaderText(worksheet, 'HCODE', {
    rowStart: 1,
    rowEnd: Math.min(Math.max(worksheet.rowCount || 1, 1), 20),
  });

  if (!match) {
    return { rawBranchSource: '', branchCode: null };
  }

  let firstNonEmptyValue = '';
  for (let rowNumber = match.rowNumber + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const rawValue = getCellText(worksheet, rowNumber, match.columnNumber);
    if (!rawValue || normalizeHeaderText(rawValue).toUpperCase() === 'HCODE') {
      continue;
    }

    if (!firstNonEmptyValue) {
      firstNonEmptyValue = rawValue;
    }

    const branchCode = mapBranchSourceToBranchCode(rawValue);
    if (branchCode) {
      return { rawBranchSource: rawValue, branchCode };
    }
  }

  return { rawBranchSource: firstNonEmptyValue, branchCode: null };
}

function scanIndividualDateFallback(worksheet) {
  const bottom = Math.min(worksheet.rowCount || 0, 10);
  const right = Math.min(worksheet.columnCount || 0, 6);

  for (let rowNumber = 1; rowNumber <= bottom; rowNumber += 1) {
    for (let columnNumber = 1; columnNumber <= right; columnNumber += 1) {
      const rawValue = getCellText(worksheet, rowNumber, columnNumber);
      const formattedDate = parseThaiBuddhistDate(rawValue);

      if (formattedDate) {
        return {
          rawDateSource: rawValue,
          formattedDate,
          sourceLabel: 'top metadata scan',
        };
      }
    }
  }

  return null;
}

function getSummaryFilenameMetadata(worksheet) {
  const fixedDateSource = getA1Text(worksheet, 'C3');
  const fixedBranchSource = getA1Text(worksheet, 'C11');
  const fixedFormattedDate = parseSummaryRepDate(fixedDateSource);
  const fixedBranchCode = mapBranchSourceToBranchCode(fixedBranchSource);

  if (fixedFormattedDate && fixedBranchCode) {
    return {
      rawDateSource: fixedDateSource,
      formattedDate: fixedFormattedDate,
      rawBranchSource: fixedBranchSource,
      branchCode: fixedBranchCode,
      dateSourceLabel: 'C3 report date',
      branchSourceLabel: 'C11 unit branch source',
    };
  }

  const branchMatch = findColumnByHeaderText(worksheet, 'รหัสหน่วยบริการ', {
    rowStart: 5,
    rowEnd: 10,
  });
  const dateMatch = findColumnByHeaderText(worksheet, 'REP Date', {
    rowStart: 5,
    rowEnd: 10,
  });
  let firstBranchSource = '';
  let firstDateSource = '';

  for (let rowNumber = 11; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const rawBranchSource = branchMatch ? getCellText(worksheet, rowNumber, branchMatch.columnNumber) : '';
    const rawDateSource = dateMatch ? getCellText(worksheet, rowNumber, dateMatch.columnNumber) : '';

    if (!firstBranchSource && rawBranchSource && rawBranchSource !== 'รวม') {
      firstBranchSource = rawBranchSource;
    }

    if (!firstDateSource && rawDateSource && rawDateSource !== 'รวม') {
      firstDateSource = rawDateSource;
    }

    const branchCode = mapBranchSourceToBranchCode(rawBranchSource);
    const formattedDate = parseSummaryRepDate(rawDateSource);

    if (branchCode && formattedDate) {
      return {
        rawDateSource,
        formattedDate,
        rawBranchSource,
        branchCode,
        dateSourceLabel: 'summary fallback REP Date scan',
        branchSourceLabel: 'summary fallback branch scan',
      };
    }
  }

  return {
    rawDateSource: fixedDateSource || firstDateSource,
    formattedDate: fixedFormattedDate || parseSummaryRepDate(firstDateSource),
    rawBranchSource: fixedBranchSource || firstBranchSource,
    branchCode: fixedBranchCode || mapBranchSourceToBranchCode(firstBranchSource),
    dateSourceLabel: fixedDateSource ? 'C3 report date' : 'summary fallback REP Date scan',
    branchSourceLabel: fixedBranchSource ? 'C11 unit branch source' : 'summary fallback branch scan',
  };
}

function parseCompactGregorianDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(String(value || ''));
  if (!match) {
    return '';
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidDateParts(year, match[2], day)) {
    return '';
  }

  return `${year}-${match[2]}-${match[3]}`;
}

function getShopeeFilenameMetadata(originalFilename, options = {}) {
  const dataPeriodStart = String(options.periodStart || '').trim();
  const dataPeriodEnd = String(options.periodEnd || '').trim();
  let periodStart = dataPeriodStart;
  let periodEnd = dataPeriodEnd;
  let sourceLabel = 'Shopee order rows';
  let filenamePeriodStart = '';
  let filenamePeriodEnd = '';
  const filenameMatch = String(originalFilename || '').match(/(\d{8})[_-](\d{8})/);

  if (filenameMatch) {
    filenamePeriodStart = parseCompactGregorianDate(filenameMatch[1]);
    filenamePeriodEnd = parseCompactGregorianDate(filenameMatch[2]);
    if (filenamePeriodStart && filenamePeriodEnd) {
      periodStart = filenamePeriodStart;
      periodEnd = filenamePeriodEnd;
      sourceLabel = 'Shopee export filename';
    }
  }

  return {
    periodStart,
    periodEnd,
    dataPeriodStart,
    dataPeriodEnd,
    filenamePeriodStart,
    filenamePeriodEnd,
    sourceLabel,
  };
}

function buildOutputFilename(worksheet, originalFilename, variant, options = {}) {
  if (variant === 'shopee') {
    const metadata = getShopeeFilenameMetadata(originalFilename, options);
    const warnings = [];
    const shopProfile = getShopeeShopProfile(options.shopCode);

    // For Shopee accounting outputs, the resolved accounting-cycle period carried in
    // metadata (periodStart/periodEnd) is authoritative — it reflects the actual weekly cycle
    // window (e.g. 2026-06-01..2026-06-28), not the raw export filename's calendar-month span
    // (which can include carryover days like June 29-30 that belong to the next cycle). The
    // filename-derived period that getShopeeFilenameMetadata prefers is only a fallback when
    // the cycle metadata is absent.
    const cyclePeriodStart = String(options.periodStart || '').trim();
    const cyclePeriodEnd = String(options.periodEnd || '').trim();
    if (cyclePeriodStart && cyclePeriodEnd) {
      metadata.periodStart = cyclePeriodStart;
      metadata.periodEnd = cyclePeriodEnd;
      metadata.sourceLabel = 'Shopee accounting cycle';
    }

    if (
      metadata.filenamePeriodStart &&
      metadata.filenamePeriodEnd &&
      metadata.dataPeriodStart &&
      metadata.dataPeriodEnd &&
      (metadata.filenamePeriodStart !== metadata.dataPeriodStart ||
        metadata.filenamePeriodEnd !== metadata.dataPeriodEnd)
    ) {
      warnings.push(
        `Shopee filename period ${metadata.filenamePeriodStart}..${metadata.filenamePeriodEnd} did not match ` +
          `the first/last order rows ${metadata.dataPeriodStart}..${metadata.dataPeriodEnd}. Kept the export filename ` +
          'period because a valid report range can include days with no orders.',
      );
    }

    if (metadata.periodStart && metadata.periodEnd) {
      if (!shopProfile) {
        warnings.push('Shopee shop was not specified. Used a generic output filename.');
      }
      return {
        variant,
        filename: `${metadata.periodStart}_to_${metadata.periodEnd}-${shopProfile?.outputSlug || 'shopee'}-accounting.xlsx`,
        warnings,
        parsedDate: metadata.periodEnd,
        periodStart: metadata.periodStart,
        periodEnd: metadata.periodEnd,
        branchCode: null,
        rawDateSource: `${metadata.periodStart}..${metadata.periodEnd}`,
        rawBranchSource: '',
        dateSourceLabel: metadata.sourceLabel,
        branchSourceLabel: '',
        shopCode: shopProfile?.code || '',
        shopName: shopProfile?.displayName || '',
      };
    }

    warnings.push('Could not determine the Shopee report period. Used a fallback output filename.');
    return {
      variant,
      filename: `${sanitizeBaseName(originalFilename)}-shopee-processed.xlsx`,
      warnings,
      parsedDate: metadata.periodEnd || metadata.periodStart || '',
      periodStart: metadata.periodStart,
      periodEnd: metadata.periodEnd,
      branchCode: null,
      rawDateSource: [metadata.periodStart, metadata.periodEnd].filter(Boolean).join('..'),
      rawBranchSource: '',
      dateSourceLabel: metadata.sourceLabel,
      branchSourceLabel: '',
    };
  }

  if (variant === 'summary') {
    const metadata = getSummaryFilenameMetadata(worksheet);
    const warnings = [];

    if (metadata.formattedDate && metadata.branchCode) {
      return {
        variant,
        filename: `${metadata.formattedDate}-${metadata.branchCode}-02 sum exp.xlsx`,
        warnings,
        parsedDate: metadata.formattedDate,
        branchCode: metadata.branchCode,
        rawDateSource: metadata.rawDateSource,
        rawBranchSource: metadata.rawBranchSource,
        dateSourceLabel: metadata.dateSourceLabel,
        branchSourceLabel: metadata.branchSourceLabel,
      };
    }

    if (!metadata.formattedDate) {
      warnings.push('Could not parse the summary report date for the output filename. Used a fallback filename.');
    }

    if (!metadata.branchCode) {
      warnings.push('Could not parse the summary branch code for the output filename. Used a fallback filename.');
    }

    return {
      variant,
      filename: `${sanitizeBaseName(originalFilename)}-processed.xlsx`,
      warnings,
      parsedDate: metadata.formattedDate,
      branchCode: metadata.branchCode,
      rawDateSource: metadata.rawDateSource,
      rawBranchSource: metadata.rawBranchSource,
      dateSourceLabel: metadata.dateSourceLabel,
      branchSourceLabel: metadata.branchSourceLabel,
    };
  }

  const warnings = [];
  let rawDateSource = getA1Text(worksheet, 'C5');
  let parsedDate = parseThaiBuddhistDate(rawDateSource);
  let dateSourceLabel = 'C5 date';

  if (!parsedDate) {
    const scannedDate = scanIndividualDateFallback(worksheet);
    if (scannedDate) {
      rawDateSource = scannedDate.rawDateSource;
      parsedDate = scannedDate.formattedDate;
      dateSourceLabel = scannedDate.sourceLabel;
    }
  }

  const branchResult = getBranchResultFromHcodeColumn(worksheet);

  if (parsedDate && branchResult.branchCode) {
    return {
      variant,
      filename: `${parsedDate}-${branchResult.branchCode}-02 indiv exp.xlsx`,
      warnings,
      parsedDate,
      branchCode: branchResult.branchCode,
      rawDateSource,
      rawBranchSource: branchResult.rawBranchSource,
      dateSourceLabel,
      branchSourceLabel: 'HCODE branch source',
    };
  }

  if (!parsedDate) {
    warnings.push('Could not parse the indiv report date for the output filename. Used a fallback filename.');
  }

  if (!branchResult.branchCode) {
    warnings.push('Could not parse the HCODE branch code for the output filename. Used a fallback filename.');
  }

  return {
    variant,
    filename: `${sanitizeBaseName(originalFilename)}-processed.xlsx`,
    warnings,
    parsedDate,
    branchCode: branchResult.branchCode,
    rawDateSource,
    rawBranchSource: branchResult.rawBranchSource,
    dateSourceLabel,
    branchSourceLabel: 'HCODE branch source',
  };
}

module.exports = {
  HIGHLIGHT_HEADERS,
  TARGET_HEADERS_TO_DELETE,
  buildOutputFilename,
  findColumnByHeaderText,
  getCellText,
  normalizeHeaderText,
};
