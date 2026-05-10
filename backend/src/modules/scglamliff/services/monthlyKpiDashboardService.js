const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR_PATTERN = /^\d{4}$/;
const DASHBOARD_SCOPE_VALUES = new Set(['month', 'year', 'all']);
const REPORT_ERROR_CODE_MAP = {
  '42P01': 'missing_relation',
  '42703': 'missing_column',
  '42883': 'schema_mismatch',
};
const THAI_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];
const THAI_MONTHS_SHORT = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];
const TEST_RECORD_REGEX_SQL = '^(e2e_|e2e_workflow_|verify-)';
const FREE_SCAN_SIGNAL_REGEX_SQL =
  '(free[^a-z0-9ก-๙]*scan|scan[^a-z0-9ก-๙]*free|skin[^a-z0-9ก-๙]*scan|scan[^a-z0-9ก-๙]*skin|facial[^a-z0-9ก-๙]*scan|scan[^a-z0-9ก-๙]*facial|สแกนผิว)';
const REPORTING_CAPABILITY_TABLES = ['appointments', 'appointment_drafts', 'appointment_receipts', 'toppings'];
const EXPLICIT_PRODUCT_CATEGORY_TOKENS = new Set([
  'product',
  'products',
  'product_addon',
  'product_addons',
  'retail',
  'retail_product',
  'retail_products',
  'skincare',
  'skin_care',
  'สินค้า',
  'สกินแคร์',
]);
const EXPLICIT_SERVICE_CATEGORY_TOKENS = new Set([
  'service',
  'services',
  'service_addon',
  'service_addons',
  'treatment',
  'treatments',
  'session',
  'บริการ',
  'ทรีตเมนต์',
]);

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function badRequest(message, details = null) {
  const error = new Error(message);
  error.status = 400;
  if (details) {
    error.details = details;
  }
  return error;
}

function toInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.trunc(parsed);
}

function toMoney(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(parsed * 100) / 100;
}

function toRate(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }
  return Math.round((numerator / denominator) * 1000) / 10;
}

function toThaiMonthLabel(month) {
  const [year, monthNumber] = String(month).split('-').map((part) => Number.parseInt(part, 10));
  const monthIndex = monthNumber - 1;
  return `${THAI_MONTHS[monthIndex] || month} ${year + 543}`;
}

function toThaiYearLabel(year) {
  const parsed = Number.parseInt(String(year), 10);
  if (!Number.isFinite(parsed)) return String(year || '');
  return `ปี ${parsed + 543}`;
}

function toThaiShortMonthLabel(month) {
  const [yearText, monthText] = String(month).split('-');
  const monthNumber = Number.parseInt(monthText, 10);
  const year = Number.parseInt(yearText, 10);
  const monthIndex = monthNumber - 1;
  if (!Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex >= THAI_MONTHS_SHORT.length) {
    return String(month || '');
  }
  if (!Number.isFinite(year)) {
    return THAI_MONTHS_SHORT[monthIndex];
  }
  return `${THAI_MONTHS_SHORT[monthIndex]} ${String(year + 543).slice(-2)}`;
}

function toBangkokDateKey(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function toDateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return toBangkokDateKey(value);
  }

  const text = normalizeText(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return toBangkokDateKey(parsed);
  }

  return text;
}

function uniqueTextList(values = []) {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))];
}

function normalizeCategoryToken(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9ก-๙]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function classifyToppingCategory(category) {
  const token = normalizeCategoryToken(category);
  if (
    EXPLICIT_PRODUCT_CATEGORY_TOKENS.has(token) ||
    token.startsWith('product_') ||
    token.endsWith('_product') ||
    token.startsWith('skincare_') ||
    token.endsWith('_skincare')
  ) {
    return 'product';
  }
  if (
    EXPLICIT_SERVICE_CATEGORY_TOKENS.has(token) ||
    token.startsWith('service_') ||
    token.endsWith('_service') ||
    token.startsWith('treatment_') ||
    token.endsWith('_treatment')
  ) {
    return 'service';
  }
  return 'unknown';
}

function mapTopicStatusToCardAvailability(status) {
  return status === 'available' ? 'available' : 'unavailable';
}

function buildTopicSection({
  status = 'unavailable',
  title,
  value = null,
  summary = '',
  explanation = '',
  assumptions = [],
  dataSource = [],
  missingRequirements = [],
  fallback = null,
  extra = {},
} = {}) {
  const normalizedStatus =
    status === 'available' || status === 'fallback' || status === 'unavailable'
      ? status
      : 'unavailable';

  return {
    availability: normalizedStatus,
    status: normalizedStatus,
    title,
    value,
    summary: normalizeText(summary) || null,
    explanation: normalizeText(explanation) || null,
    assumptions: uniqueTextList(assumptions),
    dataSource: uniqueTextList(dataSource),
    missingRequirements: uniqueTextList(missingRequirements),
    fallback,
    reason:
      normalizedStatus === 'unavailable' ? normalizeText(explanation) || normalizeText(summary) || null : null,
    note: normalizedStatus === 'fallback' ? normalizeText(explanation) || null : null,
    ...extra,
  };
}

async function fetchReportingSchemaCapabilities(queryFn) {
  const result = await queryFn(
    `
      SELECT
        table_name,
        column_name,
        data_type,
        udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [REPORTING_CAPABILITY_TABLES]
  );

  const tables = new Map(REPORTING_CAPABILITY_TABLES.map((tableName) => [tableName, new Map()]));
  for (const row of result.rows || []) {
    const tableName = normalizeText(row.table_name).toLowerCase();
    const columnName = normalizeText(row.column_name).toLowerCase();
    if (!tableName || !columnName) continue;
    if (!tables.has(tableName)) {
      tables.set(tableName, new Map());
    }
    tables.get(tableName).set(columnName, {
      data_type: normalizeText(row.data_type).toLowerCase(),
      udt_name: normalizeText(row.udt_name).toLowerCase(),
    });
  }

  return { tables };
}

function hasColumn(capabilities, tableName, columnName) {
  return Boolean(
    capabilities?.tables instanceof Map &&
      capabilities.tables.get(tableName)?.has(String(columnName || '').toLowerCase())
  );
}

function hasJsonbColumn(capabilities, tableName, columnName) {
  const metadata =
    capabilities?.tables instanceof Map
      ? capabilities.tables.get(tableName)?.get(String(columnName || '').toLowerCase())
      : null;
  return Boolean(metadata && (metadata.udt_name === 'jsonb' || metadata.data_type === 'jsonb'));
}

export function resolveDashboardMonthRange(rawMonth, now = new Date()) {
  const fallbackMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const month = normalizeText(rawMonth) || fallbackMonth;

  if (!MONTH_PATTERN.test(month)) {
    throw badRequest('month must use YYYY-MM format', {
      param: 'month',
      provided: month,
      expected: 'YYYY-MM',
    });
  }

  const [yearText, monthText] = month.split('-');
  const year = Number.parseInt(yearText, 10);
  const monthIndex = Number.parseInt(monthText, 10) - 1;
  const end = new Date(Date.UTC(year, monthIndex + 1, 0));
  const startDate = `${yearText}-${monthText}-01`;
  const endDate = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(
    end.getUTCDate()
  ).padStart(2, '0')}`;

  return {
    month,
    month_label_th: toThaiMonthLabel(month),
    label_th: toThaiMonthLabel(month),
    note_th: 'ข้อมูลอิงเดือนจากเวลา Asia/Bangkok',
    scope: 'month',
    timeline_granularity: 'day',
    start_date: startDate,
    end_date: endDate,
  };
}

export function resolveDashboardYearRange(rawYear, now = new Date()) {
  const fallbackYear = String(now.getFullYear());
  const year = normalizeText(rawYear) || fallbackYear;

  if (!YEAR_PATTERN.test(year)) {
    throw badRequest('year must use YYYY format', {
      param: 'year',
      provided: year,
      expected: 'YYYY',
    });
  }

  return {
    year,
    year_label_th: toThaiYearLabel(year),
    label_th: toThaiYearLabel(year),
    note_th: 'ข้อมูลรวมทั้งปีจากเวลา Asia/Bangkok',
    scope: 'year',
    timeline_granularity: 'month',
    start_date: `${year}-01-01`,
    end_date: `${year}-12-31`,
  };
}

async function resolveDashboardAllTimeRange(queryFn, now = new Date()) {
  if (typeof queryFn !== 'function') {
    throw new Error('queryFn is required to resolve all-time KPI scope');
  }

  const result = await queryFn(
    `
      SELECT MIN(source_date)::date AS start_date
      FROM (
        SELECT MIN(DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok')) AS source_date
        FROM appointments a
        LEFT JOIN customers c ON c.id = a.customer_id
        WHERE NOT (
          COALESCE(c.full_name, '') ~* $1
          OR COALESCE(a.line_user_id, '') ~* $1
        )

        UNION ALL

        SELECT MIN(DATE(cp.purchased_at AT TIME ZONE 'Asia/Bangkok')) AS source_date
        FROM customer_packages cp
        LEFT JOIN customers c ON c.id = cp.customer_id
        WHERE NOT (COALESCE(c.full_name, '') ~* $1)

        UNION ALL

        SELECT MIN(DATE(pu.used_at AT TIME ZONE 'Asia/Bangkok')) AS source_date
        FROM package_usages pu
        JOIN customer_packages cp ON cp.id = pu.customer_package_id
        LEFT JOIN customers c ON c.id = cp.customer_id
        WHERE NOT (COALESCE(c.full_name, '') ~* $1)
      ) source_dates
      WHERE source_date IS NOT NULL
    `,
    [TEST_RECORD_REGEX_SQL]
  );

  const todayBangkok = toBangkokDateKey(now);
  const startDate = toDateKey(result.rows?.[0]?.start_date) || todayBangkok;

  return {
    label_th: 'ภาพรวมทั้งหมด',
    note_th: `ข้อมูลสะสมตั้งแต่ ${startDate} ถึง ${todayBangkok} ตามเวลา Asia/Bangkok`,
    scope: 'all',
    timeline_granularity: 'month',
    start_date: startDate,
    end_date: todayBangkok,
  };
}

export async function resolveDashboardPeriod({ scope, month, year, now = new Date(), queryFn } = {}) {
  const normalizedScope = normalizeText(scope).toLowerCase() || 'month';

  if (!DASHBOARD_SCOPE_VALUES.has(normalizedScope)) {
    throw badRequest('scope must be one of month, year, all', {
      param: 'scope',
      provided: scope,
      expected: 'month | year | all',
    });
  }

  if (normalizedScope === 'year') {
    return resolveDashboardYearRange(year, now);
  }

  if (normalizedScope === 'all') {
    return resolveDashboardAllTimeRange(queryFn, now);
  }

  return resolveDashboardMonthRange(month, now);
}

function resolvePeriodBounds(period = {}) {
  const startDate = normalizeText(period?.start_date || period?.startDate);
  const endDate = normalizeText(period?.end_date || period?.endDate);

  if (!startDate || !endDate) {
    throw new Error('report period is missing start_date/end_date');
  }

  return { startDate, endDate };
}

function buildCard({
  id,
  label,
  value = null,
  unit = '',
  availability = 'available',
  reason = '',
  note = '',
}) {
  return {
    id,
    label,
    value,
    unit,
    availability,
    reason: reason || null,
    note: note || null,
  };
}

function buildUnavailableSection({
  title,
  reason,
  note = '',
  fallback = null,
  rows = [],
  top_packages = [],
  daily_rows = [],
  total_appointments = null,
  completed_count = null,
  cancelled_count = null,
  no_show_count = null,
  completion_rate_pct = null,
  cancellation_rate_pct = null,
  no_show_rate_pct = null,
  total_sales_count = null,
  total_buyer_count = null,
  total_revenue_thb = null,
  total_redemptions = null,
  packages_used_count = null,
  mask_redemptions_count = null,
  packages_completed_count = null,
  unique_buyers_count = null,
  repeat_buyers_count = null,
  first_time_buyers_count = null,
  repurchase_rate_pct = null,
} = {}) {
  return {
    availability: 'unavailable',
    title,
    reason,
    note: note || null,
    fallback,
    rows,
    top_packages,
    daily_rows,
    total_appointments,
    completed_count,
    cancelled_count,
    no_show_count,
    completion_rate_pct,
    cancellation_rate_pct,
    no_show_rate_pct,
    total_sales_count,
    total_buyer_count,
    total_revenue_thb,
    total_redemptions,
    packages_used_count,
    mask_redemptions_count,
    packages_completed_count,
    unique_buyers_count,
    repeat_buyers_count,
    first_time_buyers_count,
    repurchase_rate_pct,
  };
}

function getReportErrorCategory(error) {
  const normalizedCode = normalizeText(error?.code).toUpperCase();
  return REPORT_ERROR_CODE_MAP[normalizedCode] || 'query_failed';
}

function buildRecoverableSectionReason(error) {
  const category = getReportErrorCategory(error);

  if (category === 'missing_relation') {
    return {
      reason: 'ยังอ่านข้อมูลส่วนนี้ไม่ได้ เพราะฐานข้อมูล production ยังไม่มีตารางต้นทางบางตัวที่ KPI นี้ต้องใช้',
      note: 'ระบบยังคงแสดง KPI ส่วนอื่นต่อได้ และควรตรวจสอบ migration/schema ของข้อมูลรายงานส่วนนี้ใน server logs',
    };
  }

  if (category === 'missing_column') {
    return {
      reason: 'ยังอ่านข้อมูลส่วนนี้ไม่ได้ เพราะ schema production ยังขาดคอลัมน์ที่ KPI นี้ต้องใช้',
      note: 'ระบบยังคงแสดง KPI ส่วนอื่นต่อได้ และควรตรวจสอบความตรงกันของ schema ระหว่างเครื่องพัฒนาและ production',
    };
  }

  if (category === 'schema_mismatch') {
    return {
      reason: 'ยังอ่านข้อมูลส่วนนี้ไม่ได้ เพราะโครงสร้างข้อมูลใน production ยังไม่ตรงกับ query ของ KPI ชุดนี้',
      note: 'ระบบยังคงแสดง KPI ส่วนอื่นต่อได้ และควรตรวจสอบ type/operator หรือ query compatibility ของฐานข้อมูลส่วนนี้',
    };
  }

  return {
    reason: 'ยังอ่านข้อมูลส่วนนี้ไม่ได้ในขณะนี้ ระบบข้าม KPI ส่วนนี้ชั่วคราวเพื่อไม่ให้ทั้ง dashboard ล้ม',
    note: 'ส่วนนี้เป็นข้อมูลอ่านอย่างเดียว และไม่มีผลต่อข้อมูลธุรกรรมเดิม',
  };
}

function logSectionFailure(sectionKey, error, { month } = {}) {
  console.error('[monthlyKpiDashboard] section failed', {
    section: sectionKey,
    month: normalizeText(month) || null,
    message: normalizeText(error?.message) || 'unknown error',
    code: normalizeText(error?.code) || null,
    detail: normalizeText(error?.detail) || null,
    hint: normalizeText(error?.hint) || null,
    table: normalizeText(error?.table) || null,
    column: normalizeText(error?.column) || null,
    constraint: normalizeText(error?.constraint) || null,
    where: normalizeText(error?.where) || null,
    stack: error?.stack || null,
  });
}

function buildSectionWarning(sectionKey, error, title) {
  const detail = buildRecoverableSectionReason(error);
  return {
    section: sectionKey,
    title,
    availability: 'unavailable',
    reason: detail.reason,
    note: detail.note || null,
    category: getReportErrorCategory(error),
  };
}

async function readSectionSafely({ sectionKey, title, month, run }) {
  try {
    const data = await run();
    return {
      ok: true,
      sectionKey,
      title,
      data,
      warning: null,
    };
  } catch (error) {
    logSectionFailure(sectionKey, error, { month });
    return {
      ok: false,
      sectionKey,
      title,
      data: null,
      error,
      warning: buildSectionWarning(sectionKey, error, title),
    };
  }
}

const STAFF_NAME_LATERAL_SQL = `
  LEFT JOIN LATERAL (
    SELECT
      COALESCE(
        NULLIF(ae.meta->'after'->>'staff_name', ''),
        NULLIF(ae.meta->>'staff_name', ''),
        NULLIF(ae.meta->'after'->>'staff_display_name', ''),
        NULLIF(ae.meta->>'staff_display_name', '')
      ) AS staff_name
    FROM appointment_events ae
    WHERE ae.appointment_id = a.id
      AND (
        COALESCE(ae.meta->'after', '{}'::jsonb) ? 'staff_name'
        OR ae.meta ? 'staff_name'
        OR COALESCE(ae.meta->'after', '{}'::jsonb) ? 'staff_display_name'
        OR ae.meta ? 'staff_display_name'
      )
      AND COALESCE(
        NULLIF(ae.meta->'after'->>'staff_name', ''),
        NULLIF(ae.meta->>'staff_name', ''),
        NULLIF(ae.meta->'after'->>'staff_display_name', ''),
        NULLIF(ae.meta->>'staff_display_name', '')
      ) IS NOT NULL
    ORDER BY ae.event_at DESC NULLS LAST, ae.id DESC
    LIMIT 1
  ) staff_evt ON true
`;

async function fetchAppointmentOverview(queryFn, period) {
  const { startDate, endDate } = resolvePeriodBounds(period);
  const result = await queryFn(
    `
      SELECT
        COUNT(*)::int AS total_appointments,
        SUM(CASE WHEN LOWER(COALESCE(a.status, '')) = 'completed' THEN 1 ELSE 0 END)::int AS completed_count,
        SUM(
          CASE
            WHEN LOWER(COALESCE(a.status, '')) IN ('cancelled', 'canceled') THEN 1
            ELSE 0
          END
        )::int AS cancelled_count,
        SUM(
          CASE
            WHEN LOWER(COALESCE(a.status, '')) IN ('no_show', 'no-show', 'noshow') THEN 1
            ELSE 0
          END
        )::int AS no_show_count
      FROM appointments a
      LEFT JOIN customers c ON c.id = a.customer_id
      WHERE DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND NOT (
          COALESCE(c.full_name, '') ~* $3
          OR COALESCE(a.line_user_id, '') ~* $3
        )
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  const row = result.rows?.[0] || {};
  const totalAppointments = toInt(row.total_appointments);
  const completedCount = toInt(row.completed_count);
  const cancelledCount = toInt(row.cancelled_count);
  const noShowCount = toInt(row.no_show_count);

  return {
    total_appointments: totalAppointments,
    completed_count: completedCount,
    cancelled_count: cancelledCount,
    no_show_count: noShowCount,
    completion_rate_pct: toRate(completedCount, totalAppointments),
    cancellation_rate_pct: toRate(cancelledCount, totalAppointments),
    no_show_rate_pct: toRate(noShowCount, totalAppointments),
  };
}

function buildTimelineBucketLabel(bucketKey, { granularity = 'day', scope = 'month' } = {}) {
  if (granularity === 'month') {
    return scope === 'all' ? toThaiShortMonthLabel(bucketKey) : toThaiShortMonthLabel(bucketKey).replace(/ \d+$/, '');
  }

  return normalizeText(bucketKey).slice(-2) || bucketKey;
}

async function fetchDailyOutcomeRows(queryFn, period) {
  const { startDate, endDate } = resolvePeriodBounds(period);
  const granularity = normalizeText(period?.timeline_granularity).toLowerCase() === 'month' ? 'month' : 'day';
  const bucketExpression =
    granularity === 'month'
      ? "DATE_TRUNC('month', a.scheduled_at AT TIME ZONE 'Asia/Bangkok')::date"
      : "DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok')";
  const bucketFormat = granularity === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD';
  const result = await queryFn(
    `
      SELECT
        TO_CHAR(${bucketExpression}, '${bucketFormat}') AS report_date,
        COUNT(*)::int AS total_appointments,
        SUM(CASE WHEN LOWER(COALESCE(a.status, '')) = 'completed' THEN 1 ELSE 0 END)::int AS completed_count,
        SUM(
          CASE
            WHEN LOWER(COALESCE(a.status, '')) IN ('cancelled', 'canceled') THEN 1
            ELSE 0
          END
        )::int AS cancelled_count,
        SUM(
          CASE
            WHEN LOWER(COALESCE(a.status, '')) IN ('no_show', 'no-show', 'noshow') THEN 1
            ELSE 0
          END
        )::int AS no_show_count
      FROM appointments a
      LEFT JOIN customers c ON c.id = a.customer_id
      WHERE DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND NOT (
          COALESCE(c.full_name, '') ~* $3
          OR COALESCE(a.line_user_id, '') ~* $3
        )
      GROUP BY ${bucketExpression}
      ORDER BY ${bucketExpression} ASC
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  return (result.rows || []).map((row) => ({
    date: normalizeText(row.report_date),
    label: buildTimelineBucketLabel(normalizeText(row.report_date), {
      granularity,
      scope: normalizeText(period?.scope).toLowerCase() || 'month',
    }),
    total_appointments: toInt(row.total_appointments),
    completed_count: toInt(row.completed_count),
    cancelled_count: toInt(row.cancelled_count),
    no_show_count: toInt(row.no_show_count),
  }));
}

async function fetchCourseSalesRows(queryFn, period) {
  const { startDate, endDate } = resolvePeriodBounds(period);
  const result = await queryFn(
    `
      SELECT
        COALESCE(p.price_thb, 0)::int AS price_thb,
        COUNT(*)::int AS sales_count,
        COUNT(DISTINCT cp.customer_id)::int AS buyer_count,
        COALESCE(SUM(COALESCE(p.price_thb, 0)), 0)::int AS revenue_thb
      FROM customer_packages cp
      JOIN packages p ON p.id = cp.package_id
      LEFT JOIN customers c ON c.id = cp.customer_id
      WHERE DATE(cp.purchased_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND NOT (COALESCE(c.full_name, '') ~* $3)
      GROUP BY COALESCE(p.price_thb, 0)
      ORDER BY COALESCE(p.price_thb, 0) ASC
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  const knownBuckets = new Map(
    [399, 999, 2999].map((price) => [
      price,
      {
        bucket: String(price),
        label: `${price.toLocaleString('th-TH')} บาท`,
        price_thb: price,
        sales_count: 0,
        buyer_count: 0,
        revenue_thb: 0,
      },
    ])
  );
  const otherBucket = {
    bucket: 'other',
    label: 'ราคาอื่น',
    price_thb: null,
    sales_count: 0,
    buyer_count: 0,
    revenue_thb: 0,
  };

  for (const row of result.rows || []) {
    const price = toInt(row.price_thb);
    const target = knownBuckets.get(price) || otherBucket;
    target.sales_count += toInt(row.sales_count);
    target.buyer_count += toInt(row.buyer_count);
    target.revenue_thb += toInt(row.revenue_thb);
  }

  const rows = [...knownBuckets.values()];
  if (otherBucket.sales_count > 0 || otherBucket.revenue_thb > 0) {
    rows.push(otherBucket);
  }

  const totals = rows.reduce(
    (acc, row) => {
      acc.sales_count += row.sales_count;
      acc.buyer_count += row.buyer_count;
      acc.revenue_thb += row.revenue_thb;
      return acc;
    },
    { sales_count: 0, buyer_count: 0, revenue_thb: 0 }
  );

  return {
    rows,
    total_sales_count: totals.sales_count,
    total_buyer_count: totals.buyer_count,
    total_revenue_thb: totals.revenue_thb,
  };
}

async function fetchStaffPerformanceRows(queryFn, period) {
  const { startDate, endDate } = resolvePeriodBounds(period);
  const result = await queryFn(
    `
      SELECT
        COALESCE(NULLIF(staff_evt.staff_name, ''), 'ไม่ระบุพนักงาน') AS staff_name,
        COUNT(*)::int AS total_appointments,
        SUM(CASE WHEN LOWER(COALESCE(a.status, '')) = 'completed' THEN 1 ELSE 0 END)::int AS completed_count,
        SUM(
          CASE
            WHEN LOWER(COALESCE(a.status, '')) IN ('cancelled', 'canceled') THEN 1
            ELSE 0
          END
        )::int AS cancelled_count,
        SUM(
          CASE
            WHEN LOWER(COALESCE(a.status, '')) IN ('no_show', 'no-show', 'noshow') THEN 1
            ELSE 0
          END
        )::int AS no_show_count
      FROM appointments a
      LEFT JOIN customers c ON c.id = a.customer_id
      ${STAFF_NAME_LATERAL_SQL}
      WHERE DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND NOT (
          COALESCE(c.full_name, '') ~* $3
          OR COALESCE(a.line_user_id, '') ~* $3
        )
      GROUP BY COALESCE(NULLIF(staff_evt.staff_name, ''), 'ไม่ระบุพนักงาน')
      ORDER BY completed_count DESC, total_appointments DESC, staff_name ASC
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  const totalCompleted = (result.rows || []).reduce((sum, row) => sum + toInt(row.completed_count), 0);

  return (result.rows || []).map((row) => {
    const totalAppointments = toInt(row.total_appointments);
    const completedCount = toInt(row.completed_count);
    const cancelledCount = toInt(row.cancelled_count);
    const noShowCount = toInt(row.no_show_count);
    return {
      staff_name: normalizeText(row.staff_name) || 'ไม่ระบุพนักงาน',
      total_appointments: totalAppointments,
      completed_count: completedCount,
      cancelled_count: cancelledCount,
      no_show_count: noShowCount,
      completion_rate_pct: toRate(completedCount, totalAppointments),
      share_of_completed_pct: toRate(completedCount, totalCompleted),
    };
  });
}

async function fetchCourseRedemptionSummary(queryFn, period) {
  const { startDate, endDate } = resolvePeriodBounds(period);
  const summaryResult = await queryFn(
    `
      SELECT
        COUNT(*)::int AS total_redemptions,
        COUNT(DISTINCT pu.customer_package_id)::int AS packages_used_count,
        SUM(CASE WHEN pu.used_mask IS TRUE THEN 1 ELSE 0 END)::int AS mask_redemptions_count
      FROM package_usages pu
      JOIN customer_packages cp ON cp.id = pu.customer_package_id
      LEFT JOIN customers c ON c.id = cp.customer_id
      WHERE DATE(pu.used_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND NOT (COALESCE(c.full_name, '') ~* $3)
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  const completionResult = await queryFn(
    `
      WITH usage_rollup AS (
        SELECT
          cp.id AS customer_package_id,
          COALESCE(p.sessions_total, 0)::int AS sessions_total,
          COUNT(pu.id)::int AS sessions_used,
          MAX(pu.used_at) AS last_used_at
        FROM customer_packages cp
        JOIN packages p ON p.id = cp.package_id
        LEFT JOIN package_usages pu ON pu.customer_package_id = cp.id
        LEFT JOIN customers c ON c.id = cp.customer_id
        WHERE NOT (COALESCE(c.full_name, '') ~* $3)
        GROUP BY cp.id, COALESCE(p.sessions_total, 0)
      )
      SELECT
        COUNT(*)::int AS packages_completed_count
      FROM usage_rollup ur
      WHERE ur.sessions_total > 0
        AND ur.sessions_used >= ur.sessions_total
        AND ur.last_used_at IS NOT NULL
        AND DATE(ur.last_used_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  const topPackagesResult = await queryFn(
    `
      SELECT
        COALESCE(NULLIF(p.title, ''), NULLIF(p.code, ''), 'ไม่ระบุคอร์ส') AS package_label,
        COUNT(*)::int AS redemptions_count,
        COUNT(DISTINCT pu.customer_package_id)::int AS packages_used_count
      FROM package_usages pu
      JOIN customer_packages cp ON cp.id = pu.customer_package_id
      JOIN packages p ON p.id = cp.package_id
      LEFT JOIN customers c ON c.id = cp.customer_id
      WHERE DATE(pu.used_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND NOT (COALESCE(c.full_name, '') ~* $3)
      GROUP BY COALESCE(NULLIF(p.title, ''), NULLIF(p.code, ''), 'ไม่ระบุคอร์ส')
      ORDER BY redemptions_count DESC, package_label ASC
      LIMIT 5
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  const summaryRow = summaryResult.rows?.[0] || {};
  const completionRow = completionResult.rows?.[0] || {};

  return {
    total_redemptions: toInt(summaryRow.total_redemptions),
    packages_used_count: toInt(summaryRow.packages_used_count),
    mask_redemptions_count: toInt(summaryRow.mask_redemptions_count),
    packages_completed_count: toInt(completionRow.packages_completed_count),
    top_packages: (topPackagesResult.rows || []).map((row) => ({
      package_label: normalizeText(row.package_label) || 'ไม่ระบุคอร์ส',
      redemptions_count: toInt(row.redemptions_count),
      packages_used_count: toInt(row.packages_used_count),
    })),
  };
}

async function fetchRepurchaseSummary(queryFn, period) {
  const { startDate, endDate } = resolvePeriodBounds(period);
  const result = await queryFn(
    `
      WITH monthly_buyers AS (
        SELECT DISTINCT cp.customer_id
        FROM customer_packages cp
        LEFT JOIN customers c ON c.id = cp.customer_id
        WHERE DATE(cp.purchased_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
          AND NOT (COALESCE(c.full_name, '') ~* $3)
      ),
      repeat_buyers AS (
        SELECT mb.customer_id
        FROM monthly_buyers mb
        WHERE EXISTS (
          SELECT 1
          FROM customer_packages cp_prev
          WHERE cp_prev.customer_id = mb.customer_id
            AND DATE(cp_prev.purchased_at AT TIME ZONE 'Asia/Bangkok') < $1
        )
      )
      SELECT
        (SELECT COUNT(*)::int FROM monthly_buyers) AS unique_buyers_count,
        (SELECT COUNT(*)::int FROM repeat_buyers) AS repeat_buyers_count
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  const row = result.rows?.[0] || {};
  const uniqueBuyersCount = toInt(row.unique_buyers_count);
  const repeatBuyersCount = toInt(row.repeat_buyers_count);

  return {
    unique_buyers_count: uniqueBuyersCount,
    repeat_buyers_count: repeatBuyersCount,
    first_time_buyers_count: Math.max(uniqueBuyersCount - repeatBuyersCount, 0),
    repurchase_rate_pct: toRate(repeatBuyersCount, uniqueBuyersCount),
  };
}

async function fetchReceiptFallbackSummary(queryFn, period) {
  const { startDate, endDate } = resolvePeriodBounds(period);
  const result = await queryFn(
    `
      SELECT
        COUNT(*)::int AS receipt_count,
        COALESCE(SUM(COALESCE(ar.total_amount_thb, 0)), 0)::numeric(12, 2) AS receipt_total_amount_thb
      FROM appointment_receipts ar
      JOIN appointments a ON a.id = ar.appointment_id
      LEFT JOIN customers c ON c.id = a.customer_id
      WHERE DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND NOT (
          COALESCE(c.full_name, '') ~* $3
          OR COALESCE(a.line_user_id, '') ~* $3
        )
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  const row = result.rows?.[0] || {};
  return {
    receipt_count: toInt(row.receipt_count),
    receipt_total_amount_thb: toMoney(row.receipt_total_amount_thb),
  };
}

async function fetchAppointmentAddonRows(
  queryFn,
  period,
  { requireReceipts = false, completedOnly = false } = {}
) {
  const { startDate, endDate } = resolvePeriodBounds(period);
  const receiptSelect = requireReceipts
    ? ', ar.total_amount_thb AS receipt_total_amount_thb'
    : ', NULL::numeric(12, 2) AS receipt_total_amount_thb';
  const receiptJoin = requireReceipts ? 'JOIN appointment_receipts ar ON ar.appointment_id = a.id' : '';
  const completedClause = completedOnly ? "AND LOWER(COALESCE(a.status, '')) = 'completed'" : '';

  const result = await queryFn(
    `
      SELECT
        a.id AS appointment_id,
        a.customer_id,
        COALESCE(a.addons_total_thb, 0)::int AS addons_total_thb,
        topping_codes.code AS topping_code,
        t.category AS topping_category
        ${receiptSelect}
      FROM appointments a
      LEFT JOIN customers c ON c.id = a.customer_id
      ${receiptJoin}
      LEFT JOIN LATERAL jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(COALESCE(a.selected_toppings, '[]'::jsonb)) = 'array'
            THEN COALESCE(a.selected_toppings, '[]'::jsonb)
          ELSE '[]'::jsonb
        END
      ) topping_codes(code) ON true
      LEFT JOIN toppings t ON t.code = topping_codes.code
      WHERE DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
        AND NOT (
          COALESCE(c.full_name, '') ~* $3
          OR COALESCE(a.line_user_id, '') ~* $3
        )
        ${completedClause}
      ORDER BY a.id ASC
    `,
    [startDate, endDate, TEST_RECORD_REGEX_SQL]
  );

  return (result.rows || []).map((row) => ({
    appointment_id: normalizeText(row.appointment_id),
    customer_id: normalizeText(row.customer_id),
    addons_total_thb: toMoney(row.addons_total_thb),
    topping_code: normalizeText(row.topping_code),
    topping_category: normalizeText(row.topping_category),
    receipt_total_amount_thb:
      row.receipt_total_amount_thb === null || row.receipt_total_amount_thb === undefined
        ? null
        : toMoney(row.receipt_total_amount_thb),
  }));
}

function analyzeUpsellRows(rows = []) {
  const appointments = new Map();
  const matchedProductCategories = new Set();

  for (const row of rows) {
    const appointmentId = normalizeText(row.appointment_id);
    if (!appointmentId) continue;
    if (!appointments.has(appointmentId)) {
      appointments.set(appointmentId, {
        customer_id: normalizeText(row.customer_id),
        addons_total_thb: toMoney(row.addons_total_thb),
        has_product: false,
        has_service: false,
        has_unknown: false,
        has_topping_rows: false,
      });
    }

    const target = appointments.get(appointmentId);
    target.addons_total_thb = toMoney(row.addons_total_thb);

    if (!normalizeText(row.topping_code)) continue;
    target.has_topping_rows = true;
    const categoryKind = classifyToppingCategory(row.topping_category);
    if (categoryKind === 'product') {
      target.has_product = true;
      matchedProductCategories.add(normalizeCategoryToken(row.topping_category) || row.topping_category);
      continue;
    }
    if (categoryKind === 'service') {
      target.has_service = true;
      continue;
    }
    target.has_unknown = true;
  }

  const eligibleCustomerIds = new Set();
  const upsellCustomerIds = new Set();
  let upsellAppointmentsCount = 0;
  let ambiguousAppointmentsCount = 0;

  for (const appointment of appointments.values()) {
    if (appointment.customer_id) {
      eligibleCustomerIds.add(appointment.customer_id);
    }
    if (appointment.has_product && appointment.customer_id) {
      upsellCustomerIds.add(appointment.customer_id);
    }
    if (appointment.has_product) {
      upsellAppointmentsCount += 1;
      continue;
    }

    const isAmbiguous =
      appointment.has_unknown || (appointment.addons_total_thb > 0 && !appointment.has_topping_rows);
    if (isAmbiguous) {
      ambiguousAppointmentsCount += 1;
    }
  }

  const eligibleAppointmentsCount = appointments.size;
  const classifiedAppointmentsCount = Math.max(eligibleAppointmentsCount - ambiguousAppointmentsCount, 0);
  const rateDenominator =
    ambiguousAppointmentsCount > 0 ? classifiedAppointmentsCount : eligibleAppointmentsCount;

  return {
    eligible_appointments_count: eligibleAppointmentsCount,
    classified_appointments_count: classifiedAppointmentsCount,
    ambiguous_appointments_count: ambiguousAppointmentsCount,
    upsell_appointments_count: upsellAppointmentsCount,
    eligible_customers_count: eligibleCustomerIds.size,
    upsell_customers_count: upsellCustomerIds.size,
    upsell_rate_pct: toRate(upsellAppointmentsCount, rateDenominator),
    matched_product_categories: [...matchedProductCategories].sort(),
  };
}

function analyzeRevenueMixRows(rows = []) {
  const appointments = new Map();
  const matchedProductCategories = new Set();

  for (const row of rows) {
    const appointmentId = normalizeText(row.appointment_id);
    if (!appointmentId) continue;
    if (!appointments.has(appointmentId)) {
      appointments.set(appointmentId, {
        addons_total_thb: toMoney(row.addons_total_thb),
        receipt_total_amount_thb:
          row.receipt_total_amount_thb === null || row.receipt_total_amount_thb === undefined
            ? null
            : toMoney(row.receipt_total_amount_thb),
        has_product: false,
        has_service: false,
        has_unknown: false,
        has_topping_rows: false,
      });
    }

    const target = appointments.get(appointmentId);
    target.addons_total_thb = toMoney(row.addons_total_thb);
    target.receipt_total_amount_thb =
      row.receipt_total_amount_thb === null || row.receipt_total_amount_thb === undefined
        ? null
        : toMoney(row.receipt_total_amount_thb);

    if (!normalizeText(row.topping_code)) continue;
    target.has_topping_rows = true;
    const categoryKind = classifyToppingCategory(row.topping_category);
    if (categoryKind === 'product') {
      target.has_product = true;
      matchedProductCategories.add(normalizeCategoryToken(row.topping_category) || row.topping_category);
      continue;
    }
    if (categoryKind === 'service') {
      target.has_service = true;
      continue;
    }
    target.has_unknown = true;
  }

  let classifiableReceiptCount = 0;
  let ambiguousReceiptCount = 0;
  let serviceRevenueThb = 0;
  let productRevenueThb = 0;
  let totalReceiptRevenueThb = 0;
  let ambiguousReceiptRevenueThb = 0;

  for (const appointment of appointments.values()) {
    const receiptTotal = toMoney(appointment.receipt_total_amount_thb);
    totalReceiptRevenueThb += receiptTotal;

    const candidateProductRevenue = appointment.has_product ? toMoney(appointment.addons_total_thb) : 0;
    const isAmbiguous =
      appointment.receipt_total_amount_thb === null ||
      (appointment.addons_total_thb > 0 && !appointment.has_topping_rows) ||
      (appointment.addons_total_thb > 0 && appointment.has_unknown) ||
      (appointment.addons_total_thb > 0 && appointment.has_product && appointment.has_service) ||
      candidateProductRevenue > receiptTotal;

    if (isAmbiguous) {
      ambiguousReceiptCount += 1;
      ambiguousReceiptRevenueThb += receiptTotal;
      continue;
    }

    classifiableReceiptCount += 1;
    productRevenueThb += candidateProductRevenue;
    serviceRevenueThb += Math.max(receiptTotal - candidateProductRevenue, 0);
  }

  const classifiedRevenueThb = serviceRevenueThb + productRevenueThb;
  return {
    receipt_count: appointments.size,
    classifiable_receipt_count: classifiableReceiptCount,
    ambiguous_receipt_count: ambiguousReceiptCount,
    service_revenue_thb: toMoney(serviceRevenueThb),
    product_revenue_thb: toMoney(productRevenueThb),
    classified_revenue_thb: toMoney(classifiedRevenueThb),
    total_receipt_revenue_thb: toMoney(totalReceiptRevenueThb),
    ambiguous_receipt_revenue_thb: toMoney(ambiguousReceiptRevenueThb),
    service_revenue_pct: toRate(serviceRevenueThb, classifiedRevenueThb),
    product_revenue_pct: toRate(productRevenueThb, classifiedRevenueThb),
    matched_product_categories: [...matchedProductCategories].sort(),
  };
}

async function buildFreeScanConversionSection(queryFn, period, capabilities) {
  const title = 'Free facial scan conversion';
  const dataSource = [];
  const joins = [];
  const sourceExpressions = [];
  const assumptions = [
    'นับเฉพาะลูกค้าที่มี source/channel metadata ซึ่งมีคำเกี่ยวกับ free/skin/facial/scan อย่างชัดเจน',
    'กลุ่มที่ถือว่า convert คือ customer ที่มี customer_packages.purchased_at อยู่ในเดือนเดียวกันตามเวลา Asia/Bangkok',
  ];

  if (hasColumn(capabilities, 'appointments', 'source')) {
    dataSource.push('appointments.source');
    sourceExpressions.push("NULLIF(a.source, '')");
  }

  const canJoinDrafts = hasColumn(capabilities, 'appointment_drafts', 'submitted_appointment_id');
  if (canJoinDrafts) {
    joins.push('LEFT JOIN appointment_drafts ad ON ad.submitted_appointment_id = a.id');
    if (hasColumn(capabilities, 'appointment_drafts', 'source')) {
      dataSource.push('appointment_drafts.source');
      sourceExpressions.push("NULLIF(ad.source, '')");
    }
    if (hasJsonbColumn(capabilities, 'appointment_drafts', 'flow_metadata')) {
      dataSource.push('appointment_drafts.flow_metadata.booking_channel');
      dataSource.push('appointment_drafts.flow_metadata.campaign_code');
      dataSource.push('appointment_drafts.flow_metadata.source');
      sourceExpressions.push("NULLIF(ad.flow_metadata->>'booking_channel', '')");
      sourceExpressions.push("NULLIF(ad.flow_metadata->>'campaign_code', '')");
      sourceExpressions.push("NULLIF(ad.flow_metadata->>'source', '')");
    }
  }

  const canJoinReceipts = hasColumn(capabilities, 'appointment_receipts', 'appointment_id');
  if (canJoinReceipts && hasJsonbColumn(capabilities, 'appointment_receipts', 'verification_metadata')) {
    joins.push('LEFT JOIN appointment_receipts ar ON ar.appointment_id = a.id');
    dataSource.push('appointment_receipts.verification_metadata.booking_channel');
    dataSource.push('appointment_receipts.verification_metadata.campaign_code');
    dataSource.push('appointment_receipts.verification_metadata.source');
    sourceExpressions.push("NULLIF(ar.verification_metadata->>'booking_channel', '')");
    sourceExpressions.push("NULLIF(ar.verification_metadata->>'campaign_code', '')");
    sourceExpressions.push("NULLIF(ar.verification_metadata->>'source', '')");
  }

  if (!sourceExpressions.length) {
    return buildTopicSection({
      status: 'unavailable',
      title,
      summary: 'ยังคำนวณไม่ได้อย่างโปร่งใส',
      explanation:
        'schema ปัจจุบันยังไม่มี field source/channel/metadata ที่ใช้ระบุ free facial scan ได้โดยตรง',
      assumptions,
      dataSource,
      missingRequirements: [
        'appointments.source หรือ appointment_drafts.source/flow_metadata หรือ appointment_receipts.verification_metadata ที่ระบุ free scan โดยตรง',
      ],
    });
  }

  const result = await queryFn(
    `
      WITH free_scan_appointments AS (
        SELECT DISTINCT
          a.id AS appointment_id,
          a.customer_id,
          LOWER(TRIM(signal.raw_signal)) AS normalized_signal
        FROM appointments a
        LEFT JOIN customers c ON c.id = a.customer_id
        ${joins.join('\n')}
        LEFT JOIN LATERAL UNNEST(ARRAY_REMOVE(ARRAY[${sourceExpressions.join(', ')}], NULL))
          AS signal(raw_signal) ON true
        WHERE DATE(a.scheduled_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
          AND NOT (
            COALESCE(c.full_name, '') ~* $3
            OR COALESCE(a.line_user_id, '') ~* $3
          )
          AND COALESCE(TRIM(signal.raw_signal), '') <> ''
          AND LOWER(TRIM(signal.raw_signal)) ~* $4
      ),
      monthly_buyers AS (
        SELECT DISTINCT cp.customer_id
        FROM customer_packages cp
        LEFT JOIN customers c ON c.id = cp.customer_id
        WHERE DATE(cp.purchased_at AT TIME ZONE 'Asia/Bangkok') BETWEEN $1 AND $2
          AND NOT (COALESCE(c.full_name, '') ~* $3)
      )
      SELECT
        COUNT(DISTINCT fsa.appointment_id)::int AS free_scan_appointments_count,
        COUNT(DISTINCT fsa.customer_id)::int AS source_customer_count,
        COUNT(DISTINCT CASE WHEN mb.customer_id IS NOT NULL THEN fsa.customer_id END)::int AS converted_customer_count,
        COALESCE(
          ARRAY_AGG(DISTINCT fsa.normalized_signal)
            FILTER (WHERE fsa.normalized_signal IS NOT NULL),
          ARRAY[]::text[]
        ) AS matched_signals
      FROM free_scan_appointments fsa
      LEFT JOIN monthly_buyers mb ON mb.customer_id = fsa.customer_id
    `,
    [period.start_date, period.end_date, TEST_RECORD_REGEX_SQL, FREE_SCAN_SIGNAL_REGEX_SQL]
  );

  const row = result.rows?.[0] || {};
  const sourceCustomerCount = toInt(row.source_customer_count);
  const convertedCustomerCount = toInt(row.converted_customer_count);
  const freeScanAppointmentsCount = toInt(row.free_scan_appointments_count);
  const conversionRatePct = toRate(convertedCustomerCount, sourceCustomerCount);
  const matchedSignals = Array.isArray(row.matched_signals) ? uniqueTextList(row.matched_signals) : [];
  const summary =
    sourceCustomerCount > 0
      ? `${conversionRatePct}% ของลูกค้ากลุ่ม free scan ซื้อคอร์สในเดือนนี้ (${convertedCustomerCount}/${sourceCustomerCount} คน)`
      : 'ยังไม่พบลูกค้าที่มี source free facial scan ชัดเจนในเดือนที่เลือก';

  return buildTopicSection({
    status: 'available',
    title,
    value: conversionRatePct,
    summary,
    explanation:
      'วัดจาก customer ที่มี source/channel metadata ระบุ free scan อย่างชัดเจน และตรวจว่ามีการซื้อคอร์สในเดือนเดียวกันหรือไม่',
    assumptions,
    dataSource,
    extra: {
      free_scan_appointments_count: freeScanAppointmentsCount,
      source_customer_count: sourceCustomerCount,
      converted_customer_count: convertedCustomerCount,
      conversion_rate_pct: conversionRatePct,
      matched_signals: matchedSignals,
    },
  });
}

async function buildUpsellConversionSection(queryFn, period, capabilities) {
  const title = 'Upsell conversion to skincare / products';
  const assumptions = [
    'นับเฉพาะ appointment สถานะ completed ในเดือนที่เลือกตามเวลา Asia/Bangkok',
    'ถือว่า topping.category ที่ระบุ product/skincare/retail อย่างชัดเจนคือ product upsell',
  ];
  const dataSource = ['appointments.selected_toppings', 'toppings.code', 'toppings.category'];
  const missingRequirements = [];

  if (!hasJsonbColumn(capabilities, 'appointments', 'selected_toppings')) {
    missingRequirements.push('appointments.selected_toppings (jsonb)');
  }
  if (!hasColumn(capabilities, 'toppings', 'code')) {
    missingRequirements.push('toppings.code');
  }
  if (!hasColumn(capabilities, 'toppings', 'category')) {
    missingRequirements.push('toppings.category ที่ระบุ product/skincare/service อย่างชัดเจน');
  }

  if (missingRequirements.length > 0) {
    return buildTopicSection({
      status: 'unavailable',
      title,
      summary: 'ยังคำนวณไม่ได้อย่างโปร่งใส',
      explanation:
        'schema ปัจจุบันยังไม่มี line item / category ที่พอจะแยกได้ว่า appointment ใดมี product upsell อย่างชัดเจน',
      assumptions,
      dataSource,
      missingRequirements,
    });
  }

  const rows = await fetchAppointmentAddonRows(queryFn, period, {
    requireReceipts: false,
    completedOnly: true,
  });
  const analysis = analyzeUpsellRows(rows);
  const hasAmbiguity = analysis.ambiguous_appointments_count > 0;
  const rateDenominator = hasAmbiguity
    ? analysis.classified_appointments_count
    : analysis.eligible_appointments_count;
  const status = hasAmbiguity ? 'fallback' : 'available';
  const summary =
    rateDenominator > 0
      ? hasAmbiguity
        ? `${analysis.upsell_rate_pct}% ของนัดหมายที่จัดหมวดหมู่ topping ได้มี product upsell (${analysis.upsell_appointments_count}/${rateDenominator} นัด)`
        : `${analysis.upsell_rate_pct}% ของนัดหมายที่สำเร็จมี product upsell (${analysis.upsell_appointments_count}/${rateDenominator} นัด)`
      : 'ยังไม่พบนัดหมาย completed ในเดือนที่เลือก';
  const explanation = hasAmbiguity
    ? `ยังมี ${analysis.ambiguous_appointments_count} นัดที่มี topping/add-on แต่ category ไม่ชัดพอ จึงคำนวณได้เฉพาะนัดที่จัดหมวดหมู่ได้`
    : 'ใช้ selected_toppings ของ appointment และ map กับ toppings.category เพื่อวัดว่า visit ไหนมี product/skincare add-on';

  return buildTopicSection({
    status,
    title,
    value: analysis.upsell_rate_pct,
    summary,
    explanation,
    assumptions,
    dataSource,
    extra: {
      eligible_appointments_count: analysis.eligible_appointments_count,
      classified_appointments_count: analysis.classified_appointments_count,
      ambiguous_appointments_count: analysis.ambiguous_appointments_count,
      upsell_appointments_count: analysis.upsell_appointments_count,
      eligible_customers_count: analysis.eligible_customers_count,
      upsell_customers_count: analysis.upsell_customers_count,
      upsell_rate_pct: analysis.upsell_rate_pct,
      matched_product_categories: analysis.matched_product_categories,
    },
  });
}

async function buildRevenueMixSection(queryFn, period, capabilities, receiptFallbackResult) {
  const title = 'Revenue mix (service vs product)';
  const fallback = receiptFallbackResult?.ok ? receiptFallbackResult.data : null;
  const assumptions = [
    'นับเฉพาะ appointment_receipts ที่ผูกกับ appointment ในเดือนที่เลือกตามเวลา Asia/Bangkok',
    'ถือว่า appointments.addons_total_thb คือมูลค่า add-on ที่บันทึกไว้ใน canonical appointment flow ปัจจุบัน',
    'นับเป็น product revenue เฉพาะ add-on ที่ toppings.category ระบุ product/skincare/retail อย่างชัดเจน',
  ];
  const dataSource = [
    'appointment_receipts.total_amount_thb',
    'appointments.addons_total_thb',
    'appointments.selected_toppings',
    'toppings.code',
    'toppings.category',
  ];
  const missingRequirements = [];

  if (!hasColumn(capabilities, 'appointment_receipts', 'appointment_id')) {
    missingRequirements.push('appointment_receipts.appointment_id');
  }
  if (!hasColumn(capabilities, 'appointment_receipts', 'total_amount_thb')) {
    missingRequirements.push('appointment_receipts.total_amount_thb');
  }
  if (!hasJsonbColumn(capabilities, 'appointments', 'selected_toppings')) {
    missingRequirements.push('appointments.selected_toppings (jsonb)');
  }
  if (!hasColumn(capabilities, 'appointments', 'addons_total_thb')) {
    missingRequirements.push('appointments.addons_total_thb');
  }
  if (!hasColumn(capabilities, 'toppings', 'code')) {
    missingRequirements.push('toppings.code');
  }
  if (!hasColumn(capabilities, 'toppings', 'category')) {
    missingRequirements.push('toppings.category ที่ระบุ product/skincare/service อย่างชัดเจน');
  }

  if (missingRequirements.length > 0) {
    return buildTopicSection({
      status: fallback ? 'fallback' : 'unavailable',
      title,
      value: null,
      summary: fallback
        ? `ยังแยก service/product ไม่ได้ แต่มีใบเสร็จรวม ${formatMoneyForSummary(fallback.receipt_total_amount_thb)} จาก ${fallback.receipt_count} ใบ`
        : 'ยังคำนวณไม่ได้อย่างโปร่งใส',
      explanation: fallback
        ? 'schema ยังไม่มี field พอจะแยก service revenue กับ product revenue อย่างสม่ำเสมอ จึงคงแสดงเฉพาะยอดรวมใบเสร็จ'
        : 'schema ปัจจุบันยังไม่มีทั้งยอดใบเสร็จและ split field ที่พอใช้คำนวณ revenue mix แบบโปร่งใส',
      assumptions,
      dataSource,
      missingRequirements,
      fallback,
    });
  }

  const rows = await fetchAppointmentAddonRows(queryFn, period, {
    requireReceipts: true,
    completedOnly: false,
  });
  const analysis = analyzeRevenueMixRows(rows);
  const hasAmbiguity = analysis.ambiguous_receipt_count > 0;

  if (analysis.receipt_count === 0) {
    return buildTopicSection({
      status: 'available',
      title,
      value: {
        service_revenue_thb: 0,
        product_revenue_thb: 0,
        service_revenue_pct: 0,
        product_revenue_pct: 0,
      },
      summary: 'ยังไม่พบใบเสร็จในเดือนที่เลือก',
      explanation: 'เมื่อไม่มี appointment_receipts ในเดือนนี้ dashboard จะแสดง revenue mix เป็นศูนย์',
      assumptions,
      dataSource,
      fallback,
      extra: analysis,
    });
  }

  const status = hasAmbiguity ? 'fallback' : 'available';
  const classifiableSummary =
    analysis.classifiable_receipt_count > 0
      ? `บริการ ${analysis.service_revenue_pct}% / สินค้า ${analysis.product_revenue_pct}% จากใบเสร็จที่แยกได้ ${analysis.classifiable_receipt_count} ใบ`
      : 'ยังไม่มีใบเสร็จที่แยก service/product ได้ครบ';

  return buildTopicSection({
    status,
    title,
    value: {
      service_revenue_thb: analysis.service_revenue_thb,
      product_revenue_thb: analysis.product_revenue_thb,
      service_revenue_pct: analysis.service_revenue_pct,
      product_revenue_pct: analysis.product_revenue_pct,
    },
    summary: classifiableSummary,
    explanation: hasAmbiguity
      ? `ยังมี ${analysis.ambiguous_receipt_count} ใบเสร็จที่ split add-on ไม่ชัดเจน จึงคำนวณ revenue mix ได้เฉพาะส่วนที่จัดหมวดหมู่ได้`
      : 'ใช้ยอดรวมใบเสร็จของ appointment หักมูลค่า product add-on ที่จัดหมวดหมู่ได้ เพื่อแยก service revenue กับ product revenue',
    assumptions: [
      ...assumptions,
      'ยอดที่เหลือจาก appointment_receipts.total_amount_thb หลังหัก product add-on ถูกนับเป็น service revenue เฉพาะเมื่อ add-on ของใบนั้นจัดหมวดหมู่ได้ครบ',
    ],
    dataSource,
    missingRequirements: hasAmbiguity
      ? [
          'itemized receipt lines หรือ field แยกมูลค่า service/product ต่อใบเสร็จ เพื่อครอบคลุมใบที่ add-on ยังจัดหมวดหมู่ไม่ได้',
        ]
      : [],
    fallback,
    extra: analysis,
  });
}

function formatMoneyForSummary(value) {
  return new Intl.NumberFormat('th-TH', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

export async function getMonthlyKpiDashboardReport({
  scope,
  month,
  year,
  now = new Date(),
  queryFn,
} = {}) {
  if (typeof queryFn !== 'function') {
    throw new Error('queryFn is required');
  }

  const period = await resolveDashboardPeriod({ scope, month, year, now, queryFn });
  const reportingCapabilitiesPromise = fetchReportingSchemaCapabilities(queryFn);
  const appointmentOutcomePromise = readSectionSafely({
    sectionKey: 'appointment_outcomes',
    title: 'ภาพรวมสถานะนัดหมาย',
    month: period.month,
    run: async () => {
      const [overview, dailyRows] = await Promise.all([
        fetchAppointmentOverview(queryFn, period),
        fetchDailyOutcomeRows(queryFn, period),
      ]);
      return {
        overview,
        daily_rows: dailyRows,
      };
    },
  });
  const courseSalesPromise = readSectionSafely({
    sectionKey: 'course_sales_mix',
    title: 'สัดส่วนยอดขายคอร์ส 399 / 999 / 2999',
    month: period.month,
    run: async () => fetchCourseSalesRows(queryFn, period),
  });
  const staffRowsPromise = readSectionSafely({
    sectionKey: 'staff_utilization',
    title: 'การใช้กำลังคนพนักงาน',
    month: period.month,
    run: async () => fetchStaffPerformanceRows(queryFn, period),
  });
  const courseRedemptionPromise = readSectionSafely({
    sectionKey: 'course_redemption',
    title: 'การตัดคอร์ส / การปิดคอร์ส',
    month: period.month,
    run: async () => fetchCourseRedemptionSummary(queryFn, period),
  });
  const repurchasePromise = readSectionSafely({
    sectionKey: 'repurchase',
    title: 'การต่อคอร์ส / ซื้อซ้ำ',
    month: period.month,
    run: async () => fetchRepurchaseSummary(queryFn, period),
  });
  const receiptFallbackPromise = readSectionSafely({
    sectionKey: 'revenue_mix_receipt_fallback',
    title: 'ข้อมูลทดแทนจากใบเสร็จ',
    month: period.month,
    run: async () => fetchReceiptFallbackSummary(queryFn, period),
  });
  const freeScanPromise = readSectionSafely({
    sectionKey: 'free_scan_conversion',
    title: 'Free facial scan conversion',
    month: period.month,
    run: async () => buildFreeScanConversionSection(queryFn, period, await reportingCapabilitiesPromise),
  });
  const upsellPromise = readSectionSafely({
    sectionKey: 'upsell_conversion',
    title: 'Upsell conversion to skincare / products',
    month: period.month,
    run: async () => buildUpsellConversionSection(queryFn, period, await reportingCapabilitiesPromise),
  });
  const revenueMixPromise = readSectionSafely({
    sectionKey: 'revenue_mix',
    title: 'Revenue mix (service vs product)',
    month: period.month,
    run: async () =>
      buildRevenueMixSection(queryFn, period, await reportingCapabilitiesPromise, await receiptFallbackPromise),
  });
  const [
    appointmentOutcomeResult,
    courseSalesMixResult,
    staffRowsResult,
    courseRedemptionResult,
    repurchaseResult,
    receiptFallbackResult,
    freeScanResult,
    upsellResult,
    revenueMixResult,
  ] = await Promise.all([
    appointmentOutcomePromise,
    courseSalesPromise,
    staffRowsPromise,
    courseRedemptionPromise,
    repurchasePromise,
    receiptFallbackPromise,
    freeScanPromise,
    upsellPromise,
    revenueMixPromise,
  ]);

  const warnings = [
    appointmentOutcomeResult.warning,
    courseSalesMixResult.warning,
    staffRowsResult.warning,
    courseRedemptionResult.warning,
    repurchaseResult.warning,
    receiptFallbackResult.warning,
    freeScanResult.warning,
    upsellResult.warning,
    revenueMixResult.warning,
  ].filter(Boolean);

  const appointmentOverview = appointmentOutcomeResult.data?.overview || null;
  const dailyOutcomeRows = appointmentOutcomeResult.data?.daily_rows || [];
  const staffRows = staffRowsResult.data || [];

  const appointmentSection = appointmentOutcomeResult.ok
    ? {
        availability: 'available',
        title: appointmentOutcomeResult.title,
        ...appointmentOverview,
        daily_rows: dailyOutcomeRows,
      }
    : buildUnavailableSection({
        title: appointmentOutcomeResult.title,
        ...buildRecoverableSectionReason(appointmentOutcomeResult.error),
      });

  const noShowCancellationSection = appointmentOutcomeResult.ok
    ? {
        availability: 'available',
        title: 'No-show / Cancellation',
        no_show_count: appointmentOverview.no_show_count,
        cancelled_count: appointmentOverview.cancelled_count,
        no_show_rate_pct: appointmentOverview.no_show_rate_pct,
        cancellation_rate_pct: appointmentOverview.cancellation_rate_pct,
      }
    : buildUnavailableSection({
        title: 'No-show / Cancellation',
        ...buildRecoverableSectionReason(appointmentOutcomeResult.error),
      });

  const courseSalesSection = courseSalesMixResult.ok
    ? {
        availability: 'available',
        title: courseSalesMixResult.title,
        ...courseSalesMixResult.data,
      }
    : buildUnavailableSection({
        title: courseSalesMixResult.title,
        ...buildRecoverableSectionReason(courseSalesMixResult.error),
      });

  const staffUtilizationSection = staffRowsResult.ok
    ? {
        availability: 'proxy',
        title: staffRowsResult.title,
        note: 'คำนวณแบบ proxy จากจำนวนเคสที่พนักงานถูกระบุใน appointment_events เพราะระบบยังไม่มีตารางกะงานหรือชั่วโมงทำงานจริง',
        rows: staffRows,
      }
    : buildUnavailableSection({
        title: staffRowsResult.title,
        ...buildRecoverableSectionReason(staffRowsResult.error),
      });

  const courseRedemptionSection = courseRedemptionResult.ok
    ? {
        availability: 'available',
        title: courseRedemptionResult.title,
        ...courseRedemptionResult.data,
      }
    : buildUnavailableSection({
        title: courseRedemptionResult.title,
        ...buildRecoverableSectionReason(courseRedemptionResult.error),
      });

  const repurchaseSection = repurchaseResult.ok
    ? {
        availability: 'available',
        title: repurchaseResult.title,
        ...repurchaseResult.data,
      }
    : buildUnavailableSection({
        title: repurchaseResult.title,
        ...buildRecoverableSectionReason(repurchaseResult.error),
      });

  const freeScanSection = freeScanResult.ok
    ? freeScanResult.data
    : buildTopicSection({
        status: 'unavailable',
        title: freeScanResult.title,
        summary: 'ยังคำนวณไม่ได้อย่างโปร่งใส',
        explanation: buildRecoverableSectionReason(freeScanResult.error).reason,
        extra: {
          note: buildRecoverableSectionReason(freeScanResult.error).note,
        },
      });

  const upsellSection = upsellResult.ok
    ? upsellResult.data
    : buildTopicSection({
        status: 'unavailable',
        title: upsellResult.title,
        summary: 'ยังคำนวณไม่ได้อย่างโปร่งใส',
        explanation: buildRecoverableSectionReason(upsellResult.error).reason,
        extra: {
          note: buildRecoverableSectionReason(upsellResult.error).note,
        },
      });

  const revenueMixSection = revenueMixResult.ok
    ? revenueMixResult.data
    : buildTopicSection({
        status: 'unavailable',
        title: revenueMixResult.title,
        summary: 'ยังคำนวณไม่ได้อย่างโปร่งใส',
        explanation: buildRecoverableSectionReason(revenueMixResult.error).reason,
        fallback: receiptFallbackResult.ok ? receiptFallbackResult.data : null,
        extra: {
          note: buildRecoverableSectionReason(revenueMixResult.error).note,
        },
      });

  const summaryCards = [
    appointmentOutcomeResult.ok
      ? buildCard({
          id: 'appointments_total',
          label: 'นัดหมายทั้งหมด',
          value: appointmentOverview.total_appointments,
          unit: 'นัด',
        })
      : buildCard({
          id: 'appointments_total',
          label: 'นัดหมายทั้งหมด',
          availability: 'unavailable',
          reason: buildRecoverableSectionReason(appointmentOutcomeResult.error).reason,
          note: buildRecoverableSectionReason(appointmentOutcomeResult.error).note,
        }),
    appointmentOutcomeResult.ok
      ? buildCard({
          id: 'completion_rate',
          label: 'อัตราเข้ารับบริการสำเร็จ',
          value: appointmentOverview.completion_rate_pct,
          unit: '%',
        })
      : buildCard({
          id: 'completion_rate',
          label: 'อัตราเข้ารับบริการสำเร็จ',
          availability: 'unavailable',
          reason: buildRecoverableSectionReason(appointmentOutcomeResult.error).reason,
          note: buildRecoverableSectionReason(appointmentOutcomeResult.error).note,
        }),
    courseSalesMixResult.ok
      ? buildCard({
          id: 'course_sales_total',
          label: 'ยอดขายคอร์ส',
          value: courseSalesMixResult.data.total_sales_count,
          unit: 'รายการ',
        })
      : buildCard({
          id: 'course_sales_total',
          label: 'ยอดขายคอร์ส',
          availability: 'unavailable',
          reason: buildRecoverableSectionReason(courseSalesMixResult.error).reason,
          note: buildRecoverableSectionReason(courseSalesMixResult.error).note,
        }),
    repurchaseResult.ok
      ? buildCard({
          id: 'repurchase_rate',
          label: 'อัตราซื้อซ้ำ',
          value: repurchaseResult.data.repurchase_rate_pct,
          unit: '%',
        })
      : buildCard({
          id: 'repurchase_rate',
          label: 'อัตราซื้อซ้ำ',
          availability: 'unavailable',
          reason: buildRecoverableSectionReason(repurchaseResult.error).reason,
          note: buildRecoverableSectionReason(repurchaseResult.error).note,
        }),
    courseRedemptionResult.ok
      ? buildCard({
          id: 'redemptions_total',
          label: 'การตัดคอร์ส',
          value: courseRedemptionResult.data.total_redemptions,
          unit: 'ครั้ง',
        })
      : buildCard({
          id: 'redemptions_total',
          label: 'การตัดคอร์ส',
          availability: 'unavailable',
          reason: buildRecoverableSectionReason(courseRedemptionResult.error).reason,
          note: buildRecoverableSectionReason(courseRedemptionResult.error).note,
        }),
    buildCard({
      id: 'free_scan_conversion',
      label: 'แปลงจากสแกนผิวฟรี',
      value:
        freeScanSection.status === 'available' ? freeScanSection.conversion_rate_pct ?? freeScanSection.value : null,
      unit: freeScanSection.status === 'available' ? '%' : '',
      availability: mapTopicStatusToCardAvailability(freeScanSection.status),
      reason: freeScanSection.explanation || freeScanSection.reason || '',
      note: freeScanSection.summary || freeScanSection.note || '',
    }),
  ];

  return {
    generated_at: now instanceof Date ? now.toISOString() : new Date().toISOString(),
    period,
    summary_cards: summaryCards,
    sections: {
      appointment_outcomes: appointmentSection,
      course_sales_mix: courseSalesSection,
      staff_utilization: staffUtilizationSection,
      no_show_cancellation: noShowCancellationSection,
      free_scan_conversion: freeScanSection,
      upsell_conversion: upsellSection,
      revenue_mix: revenueMixSection,
      course_redemption: courseRedemptionSection,
      repurchase: repurchaseSection,
    },
    meta: {
      partial: warnings.length > 0,
      warning_count: warnings.length,
      unavailable_sections: warnings.map((warning) => warning.section),
      warnings,
      partial_note:
        warnings.length > 0
          ? 'บาง KPI ยังไม่พร้อมใน production แต่ระบบยังส่งข้อมูลส่วนที่อ่านได้กลับมาเพื่อไม่ให้ dashboard ล้มทั้งหน้า'
          : null,
    },
    assumptions: [
      'แดชบอร์ดนี้อ่านจากตาราง PostgreSQL ปัจจุบันแบบ SELECT-only และไม่เขียนกลับข้อมูลธุรกิจ',
      'การนับนัดหมายอิงเดือนจาก appointments.scheduled_at ตามเวลา Asia/Bangkok',
      'การขายคอร์สอิง customer_packages.purchased_at',
      'การตัดคอร์สอิง package_usages.used_at',
      'อัตราพนักงานเป็น proxy จากจำนวนเคสต่อพนักงาน ไม่ใช่ utilization ตามชั่วโมงทำงานจริง',
      'ตัวเลข test/e2e ถูกตัดออกด้วย pattern เดียวกับ queue/calendar ที่มีอยู่แล้วใน backend',
    ],
  };
}
