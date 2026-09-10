const pool = require("../../../../db");
const repository = require("../db/shopeeOfficialDocumentRepository");
const { SHOPEE_SHOP_PROFILES } = require("./shopeeShops");

const SHOP_CODES = Object.keys(SHOPEE_SHOP_PROFILES);

function dateOnly(value) {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function asMoney(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Invalid official Shopee monetary fact.");
  return Number(number.toFixed(2));
}

function moneyKey(value) {
  const amount = asMoney(value);
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 1e-7) {
    throw new Error("Invalid official Shopee monetary precision.");
  }
  return cents;
}

function multiset(rows, valueField) {
  const byOrder = new Map();
  for (const row of rows) {
    const orderNumber = String(row.order_number || "");
    byOrder.set(orderNumber, (byOrder.get(orderNumber) || 0) + moneyKey(row[valueField]));
  }
  return [...byOrder.entries()]
    .filter(([, value]) => value !== 0)
    .map(([orderNumber, value]) => `${orderNumber}:${value}`)
    .sort();
}

function sameMultiset(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function mapSource(row) {
  return {
    shopCode: row.shop_code,
    reportType: row.report_type,
    sha256: row.source_sha256,
    sourceFilename: row.source_filename,
    observedAt: new Date(row.observed_at).toISOString(),
    startDate: dateOnly(row.start_date),
    endDate: dateOnly(row.end_date),
    sourceRowCount: Number(row.source_row_count),
    control: row.control || {},
  };
}

async function summarizeFinance(client, filters) {
  const sources = (await repository.listFinanceSources({ client, ...filters })).map(mapSource);
  const periods = new Map();
  for (const source of sources) {
    const key = `${source.shopCode}:${source.startDate}:${source.endDate}`;
    const period = periods.get(key) || {
      shopCode: source.shopCode,
      startDate: source.startDate,
      endDate: source.endDate,
      sources: {},
    };
    period.sources[source.reportType] = source;
    periods.set(key, period);
  }

  const result = [];
  for (const period of periods.values()) {
    const statement = period.sources["financial-statement"];
    const income = period.sources["income-transferred"];
    const balance = period.sources["seller-balance"];
    const pending = period.sources["income-pending"];
    const missingReportTypes = [
      ["financial-statement", statement],
      ["income-transferred", income],
      ["seller-balance", balance],
    ].filter(([, source]) => !source).map(([reportType]) => reportType);
    let orderEvidenceMatches = null;
    let zeroPayoutOrderCount = null;
    let sellerBalanceOrderCount = balance ? Number(balance.control.orderCount || 0) : null;
    if (income && balance) {
      const [incomeFacts, balanceFacts] = await Promise.all([
        repository.listReconciliationFacts({
          client,
          sourceSha256: income.sha256,
          reportType: "income-transferred",
          shopCode: period.shopCode,
        }),
        repository.listReconciliationFacts({
          client,
          sourceSha256: balance.sha256,
          reportType: "seller-balance",
          shopCode: period.shopCode,
        }),
      ]);
      const incomeSet = multiset(incomeFacts, "payout_amount");
      const balanceSet = multiset(balanceFacts, "amount");
      zeroPayoutOrderCount = incomeFacts.filter((fact) => moneyKey(fact.payout_amount) === 0).length;
      sellerBalanceOrderCount = balanceSet.length;
      orderEvidenceMatches = sameMultiset(incomeSet, balanceSet);
    }
    const statementTotal = statement ? asMoney(statement.control.transferredTotal) : null;
    const incomeTotal = income ? asMoney(income.control.transferredTotal) : null;
    const sellerBalanceOrderTotal = balance ? asMoney(balance.control.orderTotal) : null;
    const totalsMatch = statement && income && balance
      ? moneyKey(statementTotal) === moneyKey(incomeTotal)
        && moneyKey(incomeTotal) === moneyKey(sellerBalanceOrderTotal)
      : null;
    const status = missingReportTypes.length
      ? "incomplete"
      : totalsMatch && orderEvidenceMatches ? "source_backed" : "mismatch";
    result.push({
      shopCode: period.shopCode,
      startDate: period.startDate,
      endDate: period.endDate,
      status,
      missingReportTypes,
      statementTotal,
      incomeTransferredTotal: incomeTotal,
      incomeTransferredOrderCount: income ? Number(income.control.orderCount || 0) : null,
      zeroPayoutOrderCount,
      sellerBalanceOrderTotal,
      sellerBalanceOrderCount,
      sellerBalanceAdjustmentTotal: balance ? asMoney(balance.control.adjustmentTotal || 0) : null,
      sellerBalanceAdjustmentCount: balance ? Number(balance.control.adjustmentCount || 0) : null,
      pendingIncomeAvailable: Boolean(pending),
      totalsMatch,
      orderEvidenceMatches,
      evidence: Object.fromEntries(Object.entries(period.sources).map(([type, source]) => [type, {
        filename: source.sourceFilename,
        observedAt: source.observedAt,
        sha256: source.sha256,
      }])),
    });
  }
  return result.sort((left, right) => (
    right.startDate.localeCompare(left.startDate) || left.shopCode.localeCompare(right.shopCode)
  ));
}

function enumerateDates(startDate, endDate) {
  const values = [];
  for (let cursor = Date.parse(`${startDate}T00:00:00Z`), end = Date.parse(`${endDate}T00:00:00Z`);
    cursor <= end; cursor += 86400000) {
    values.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return values;
}

function summarizeReturns(raw, filters) {
  const requestedShops = filters.shopCode === "all" ? SHOP_CODES : [filters.shopCode];
  return requestedShops.map((shopCode) => {
    const sources = raw.sources.filter((source) => source.shop_code === shopCode);
    const facts = raw.facts.filter((fact) => fact.shop_code === shopCode);
    const covered = new Set();
    for (const source of sources) {
      const from = [dateOnly(source.start_date), filters.startDate].sort().at(-1);
      const to = [dateOnly(source.end_date), filters.endDate].sort()[0];
      if (from <= to) enumerateDates(from, to).forEach((date) => covered.add(date));
    }
    const requestedDates = enumerateDates(filters.startDate, filters.endDate);
    const missingDates = requestedDates.filter((date) => !covered.has(date));
    const count = (eventType) => facts.filter((fact) => fact.event_type === eventType).length;
    const amount = (eventType) => facts.filter((fact) => fact.event_type === eventType)
      .reduce((sum, fact) => sum + moneyKey(fact.amount || 0), 0) / 100;
    return {
      shopCode,
      startDate: filters.startDate,
      endDate: filters.endDate,
      status: missingDates.length ? "incomplete" : "source_backed",
      coveredDayCount: requestedDates.length - missingDates.length,
      expectedDayCount: requestedDates.length,
      missingDates,
      cancelledOrderCount: count("cancelled"),
      cancelledNetSales: amount("cancelled"),
      failedDeliveryOrderCount: count("failed_delivery"),
      failedDeliveryNetSales: amount("failed_delivery"),
      returnRefundRequestCount: count("return_refund"),
      totalRefundAmount: amount("return_refund"),
      latestObservedAt: sources.length
        ? new Date(Math.max(...sources.map((source) => Date.parse(source.observed_at)))).toISOString()
        : null,
      sourceFilenames: [...new Set(sources.map((source) => source.source_filename))].sort(),
    };
  });
}

async function getOfficialDocumentSummary(filters) {
  const client = await pool.connect();
  try {
    const [finance, returnsRaw] = await Promise.all([
      summarizeFinance(client, filters),
      repository.listReturnSourcesAndFacts({ client, ...filters }),
    ]);
    return {
      finance,
      returns: summarizeReturns(returnsRaw, filters),
    };
  } finally {
    client.release();
  }
}

module.exports = {
  getOfficialDocumentSummary,
  moneyKey,
  sameMultiset,
  summarizeFinance,
  summarizeReturns,
};
