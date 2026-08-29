const queryCalls = [];
let jobInsertCount = 0;

const client = {
  query: jest.fn(async (sql, params = []) => {
    queryCalls.push({ params, sql });
    if (/INSERT INTO .*adasmart_shopee_jobs/u.test(sql)) {
      jobInsertCount += 1;
      return jobInsertCount === 1
        ? { rows: [{
          current_status: "queued_dry_run",
          id: "44444444-4444-4444-8444-444444444444",
          order_number: "26082871YK8C01",
        }] }
        : { rows: [] };
    }
    return { rows: [] };
  }),
  release: jest.fn(),
};

jest.mock("../db", () => ({
  connect: jest.fn(async () => client),
  query: jest.fn(),
}));

const {
  queueDryRunPlan,
} = require("../src/modules/seamless/db/adaSmartShopeeJobRepository");

beforeEach(() => {
  queryCalls.length = 0;
  jobInsertCount = 0;
  client.query.mockClear();
  client.release.mockClear();
});

test("queues one immutable effect and treats a concurrent uniqueness conflict as a duplicate", async () => {
  const plan = {
    catalog: {
      catalogDigest: "c".repeat(64),
      catalogVersion: "catalog-v1",
      erpSourceChecksum: "e".repeat(64),
    },
    cycle: {
      cycleContractRevision: "cycle-v1",
      cycleKey: "2026-08-24_to_2026-09-13",
      periodEnd: "2026-09-13",
      periodStart: "2026-08-24",
    },
    orders: [
      {
        orderNumber: "26082871YK8C01",
        safeLines: [{ barcode: "8850000000001", companySku: "IC-005998", quantity: 1 }],
        status: "ready",
      },
      {
        orderNumber: "26082871YK8C02",
        safeLines: [{ barcode: "8850000000002", companySku: "IC-003478", quantity: 2 }],
        status: "ready",
      },
    ],
    planDigest: "a".repeat(64),
    policies: {
      customerCode: "CUS-SHOPEE-004",
      customerPolicyKey: "branch-004:shopee-credit-customer",
      customerPolicyRevision: "customer-policy-v1",
    },
    processing: {
      processingRecordId: "11111111-1111-4111-8111-111111111111",
      sourceChecksumSha256: "b".repeat(64),
      sourceUploadId: "33333333-3333-4333-8333-333333333333",
      uploadId: "22222222-2222-4222-8222-222222222222",
    },
    shop: { code: "dr-morepen" },
  };

  const confirmation = { actor: "root-admin", authSource: "admin_basic" };
  const result = await queueDryRunPlan(plan, confirmation);
  assertResult(result);
  expect(client.release).toHaveBeenCalledTimes(1);
  expect(queryCalls[0].sql).toBe("BEGIN");
  expect(queryCalls.at(-1).sql).toBe("COMMIT");

  const jobInserts = queryCalls.filter((call) => /INSERT INTO .*adasmart_shopee_jobs/u.test(call.sql));
  const eventInserts = queryCalls.filter((call) => /INSERT INTO .*adasmart_shopee_job_events/u.test(call.sql));
  expect(jobInserts).toHaveLength(2);
  expect(eventInserts).toHaveLength(1);
  expect(jobInserts[0].sql).toMatch(
    /ON CONFLICT \(branch_code, shop_code, order_number, document_type\) DO NOTHING/u,
  );
  expect(jobInserts[0].params.slice(16, 21)).toEqual([
    plan.policies.customerPolicyKey,
    plan.policies.customerCode,
    plan.policies.customerPolicyRevision,
    confirmation.actor,
    confirmation.authSource,
  ]);
  expect(JSON.parse(jobInserts[0].params[21])).toEqual({ lines: plan.orders[0].safeLines });
  expect(eventInserts[0].params.slice(1, 3)).toEqual([
    confirmation.actor,
    confirmation.authSource,
  ]);
  expect(JSON.stringify(jobInserts[0].params)).not.toMatch(/buyer|recipient|phone|address|tracking/iu);
});

function assertResult(result) {
  expect(result.createdCount).toBe(1);
  expect(result.duplicateCount).toBe(1);
  expect(result.jobs).toEqual([{
    id: "44444444-4444-4444-8444-444444444444",
    orderNumber: "26082871YK8C01",
    status: "queued_dry_run",
  }]);
}
