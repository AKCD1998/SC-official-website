const express = require("express");
const request = require("supertest");

const state = {};

function resetState() {
  state.sales = [
    {
      id: "sale-1",
      branch_code: "005",
      doc_no: "SALE-1",
      paid_total: 120,
    },
  ];
  state.awards = [
    {
      id: "award-1",
      sale_event_id: "sale-1",
      customer_account_id: "user-1",
      points_awarded: 12,
    },
  ];
  state.refunds = [];
  state.refundLines = [];
  state.reversals = [];
  state.ledger = [];
}

resetState();

function findSaleById(id) {
  return state.sales.find((item) => item.id === id) || null;
}

function findSaleByBranchAndDoc(branchCode, docNo) {
  return state.sales.find((item) => item.branch_code === branchCode && item.doc_no === docNo) || null;
}

async function executeQuery(store, sql, params = []) {
  const text = String(sql).replace(/\s+/g, " ").trim();

  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
    return { rows: [], rowCount: 0 };
  }

  if (text.startsWith("SELECT r.id, r.refund_total, r.branch_code, r.original_doc_no")) {
    const refund = store.refunds.find((item) => item.id === params[0]);
    if (!refund) return { rows: [], rowCount: 0 };
    const sale = findSaleByBranchAndDoc(refund.branch_code, refund.original_doc_no);
    if (!sale) return { rows: [], rowCount: 0 };
    const award = state.awards.find((item) => item.sale_event_id === sale.id);
    if (!award) return { rows: [], rowCount: 0 };
    return {
      rows: [{
        id: refund.id,
        refund_total: refund.refund_total,
        branch_code: refund.branch_code,
        original_doc_no: refund.original_doc_no,
        sale_event_id: sale.id,
        award_id: award.id,
        customer_account_id: award.customer_account_id,
        points_awarded: award.points_awarded,
      }],
      rowCount: 1,
    };
  }

  if (text.startsWith("SELECT id FROM crm_loyalty_reversals WHERE refund_event_id =")) {
    const found = store.reversals.find((item) => item.refund_event_id === params[0]);
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("SELECT paid_total FROM crm_pos_sale_events WHERE id =")) {
    const sale = findSaleById(params[0]);
    return { rows: sale ? [{ paid_total: sale.paid_total }] : [], rowCount: sale ? 1 : 0 };
  }

  if (text.startsWith("SELECT id FROM crm_pos_refund_events WHERE source_event_key =")) {
    const found = state.refunds.find((item) => item.source_event_key === params[0]);
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("INSERT INTO crm_pos_refund_events")) {
    state.refunds.push({
      id: params[0],
      branch_code: params[1],
      pos_code: params[2],
      refund_doc_no: params[3],
      original_doc_no: params[4],
      refund_at: params[5],
      cashier_code: params[6],
      refund_total: Number(params[7]),
      source_system: params[8],
      source_event_key: params[9],
    });
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("DELETE FROM crm_pos_refund_line_events WHERE refund_event_id =")) {
    state.refundLines = state.refundLines.filter((item) => item.refund_event_id !== params[0]);
    return { rows: [], rowCount: 0 };
  }

  if (text.startsWith("INSERT INTO crm_pos_refund_line_events")) {
    state.refundLines.push({
      id: params[0],
      refund_event_id: params[1],
      line_no: params[2],
      product_code: params[3],
      qty: Number(params[4]),
      net_amount: Number(params[5]),
    });
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("INSERT INTO point_ledger")) {
    state.ledger.push({
      id: params[0],
      user_id: params[1],
      amount: Number(params[2]),
      type: text.includes("'adjustment'") ? "adjustment" : params[3],
      reference_id: text.includes("'adjustment'") ? params[3] : params[4],
      note: text.includes("'adjustment'") ? params[4] : params[5],
    });
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("INSERT INTO crm_loyalty_reversals")) {
    state.reversals.push({
      id: params[0],
      refund_event_id: params[1],
      customer_account_id: params[2],
      points_reversed: Number(params[3]),
      original_award_id: params[4],
      ledger_entry_id: params[5],
    });
    return { rows: [], rowCount: 1 };
  }

  return { rows: [], rowCount: 0 };
}

jest.mock("../db", () => ({
  query: jest.fn((sql, params) => executeQuery({ refunds: [], reversals: [] }, sql, params)),
  connect: jest.fn(async () => ({
    query: jest.fn((sql, params) => executeQuery(state, sql, params)),
    release: jest.fn(),
  })),
}));

const router = require("../routes/sccrmInternal");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/internal", router);
  return app;
}

beforeEach(() => {
  resetState();
  process.env.SCCRM_INTERNAL_API_TOKEN = "internal-test-token";
  process.env.SCCRM_REFRESH_TOKEN_SECRET = "refresh-secret";
});

afterAll(() => {
  delete process.env.SCCRM_INTERNAL_API_TOKEN;
  delete process.env.SCCRM_REFRESH_TOKEN_SECRET;
});

describe("SCCRM internal routes", () => {
  test("POST /crm/pos/refunds creates a loyalty reversal inside the same transaction", async () => {
    const response = await request(createApp())
      .post("/internal/crm/pos/refunds")
      .set("x-internal-token", "internal-test-token")
      .send({
        branch_code: "005",
        refund_doc_no: "RF-1",
        original_doc_no: "SALE-1",
        refund_total: 120,
        line_rows: [
          {
            line_no: 1,
            product_code: "SKU-1",
            qty: 2,
            net_amount: 120,
          },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, accepted: 1 });
    expect(state.reversals).toHaveLength(1);
    expect(state.reversals[0]).toMatchObject({
      refund_event_id: state.refunds[0].id,
      customer_account_id: "user-1",
      points_reversed: 12,
      original_award_id: "award-1",
    });
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      user_id: "user-1",
      amount: -12,
      reference_id: state.refunds[0].id,
    });
  });
});
