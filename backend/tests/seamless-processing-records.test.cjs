const express = require("express");
const request = require("supertest");

process.env.SEAMLESS_DB_SCHEMA = "clasp_scx_seamless";
process.env.INTERNAL_API_TOKEN = "seamless-token";

const state = {};

function resetState() {
  state.records = [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      legacy_registry_id: "legacy-1",
      report_date_key: "20260703",
      report_type: "individual",
      filename: "20260703_001.xlsx",
      legacy_drive_file_id: null,
      legacy_drive_file_url: null,
      uploaded_at: "2026-07-03T10:00:00.000Z",
      uploaded_by: "tester",
      printed: false,
      printed_at: null,
      printed_by: null,
      source_upload_name: "source.xlsx",
      notes: "seed",
      last_action: "created",
      legacy_branch_codes: "001",
      metadata: { source: "test" },
      created_at: "2026-07-03T10:00:00.000Z",
      updated_at: "2026-07-03T10:00:00.000Z",
    },
  ];
  state.branchCodes = {
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": ["001"],
  };
}

resetState();

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, " ").trim();
}

function mapRowById(id) {
  return state.records.find((row) => row.id === id) || null;
}

async function mockQuery(sql, params = []) {
  const text = normalizeSql(sql);

  if (text.startsWith("SELECT * FROM \"clasp_scx_seamless\".\"processing_records\"")) {
    let rows = state.records.slice();

    if (text.includes("legacy_registry_id = $1")) {
      rows = rows.filter((row) => row.legacy_registry_id === params[0]);
    }
    if (text.includes("id = $1")) {
      rows = rows.filter((row) => row.id === params[0]);
    }
    if (text.includes("filename = $1")) {
      rows = rows.filter((row) => row.filename === params[0]);
    }

    const limit = Number(params[params.length - 1] || rows.length);
    return { rows: rows.slice(0, limit), rowCount: Math.min(rows.length, limit) };
  }

  if (text.startsWith("INSERT INTO \"clasp_scx_seamless\".\"processing_records\"")) {
    const offset = params.length === 18 ? 1 : 0;
    const row = {
      id: offset ? params[0] : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      legacy_registry_id: params[0 + offset],
      report_date_key: params[1 + offset],
      report_date: params[2 + offset],
      report_type: params[3 + offset],
      filename: params[4 + offset],
      legacy_drive_file_id: params[5 + offset],
      legacy_drive_file_url: params[6 + offset],
      uploaded_at: params[7 + offset],
      uploaded_by: params[8 + offset],
      printed: params[9 + offset],
      printed_at: params[10 + offset],
      printed_by: params[11 + offset],
      source_upload_name: params[12 + offset],
      notes: params[13 + offset],
      last_action: params[14 + offset],
      legacy_branch_codes: params[15 + offset],
      metadata: JSON.parse(params[16 + offset]),
      created_at: params[7 + offset],
      updated_at: params[7 + offset],
    };
    state.records.unshift(row);
    return { rows: [row], rowCount: 1 };
  }

  if (text.startsWith("DELETE FROM \"clasp_scx_seamless\".\"processing_record_branch_codes\"")) {
    state.branchCodes[params[0]] = [];
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("INSERT INTO \"clasp_scx_seamless\".\"processing_record_branch_codes\"")) {
    const recordId = params[0];
    state.branchCodes[recordId] = state.branchCodes[recordId] || [];
    if (!state.branchCodes[recordId].includes(params[1])) {
      state.branchCodes[recordId].push(params[1]);
    }
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("UPDATE \"clasp_scx_seamless\".\"processing_records\" SET")) {
    const id = params[params.length - 1];
    const row = mapRowById(id);
    if (!row) {
      return { rows: [], rowCount: 0 };
    }

    const assignments = text
      .slice(
        "UPDATE \"clasp_scx_seamless\".\"processing_records\" SET ".length,
        text.indexOf(" WHERE id = "),
      )
      .split(", ")
      .map((part) => part.split(" = ")[0]);

    assignments.forEach((column, index) => {
      const value = params[index];
      if (column === "report_type") row.report_type = value;
      if (column === "filename") row.filename = value;
      if (column === "legacy_drive_file_id") row.legacy_drive_file_id = value;
      if (column === "legacy_drive_file_url") row.legacy_drive_file_url = value;
      if (column === "uploaded_at") row.uploaded_at = value;
      if (column === "uploaded_by") row.uploaded_by = value;
      if (column === "printed") row.printed = value;
      if (column === "printed_at") row.printed_at = value;
      if (column === "printed_by") row.printed_by = value;
      if (column === "source_upload_name") row.source_upload_name = value;
      if (column === "report_date_key") row.report_date_key = value;
      if (column === "report_date") row.report_date = value;
      if (column === "notes") row.notes = value;
      if (column === "legacy_branch_codes") row.legacy_branch_codes = value;
      if (column === "last_action") row.last_action = value;
      if (column === "metadata") row.metadata = JSON.parse(value);
    });
    row.updated_at = "2026-07-03T11:00:00.000Z";

    return { rows: [row], rowCount: 1 };
  }

  throw new Error(`Unhandled SQL in test: ${text}`);
}

jest.mock("../db", () => ({
  query: jest.fn((sql, params) => mockQuery(sql, params)),
}));

const router = require("../routes/seamlessProcessingRecords");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/processing-records", router);
  return app;
}

beforeEach(() => {
  resetState();
});

afterAll(() => {
  delete process.env.SEAMLESS_DB_SCHEMA;
  delete process.env.INTERNAL_API_TOKEN;
});

describe("seamless processing records routes", () => {
  test("rejects requests without the internal token when configured", async () => {
    const response = await request(createApp()).get("/api/processing-records");

    expect(response.status).toBe(401);
    expect(response.body.error).toMatch(/invalid internal api token/i);
  });

  test("lists processing records through the shared backend route", async () => {
    const response = await request(createApp())
      .get("/api/processing-records?limit=1")
      .set("Authorization", "Bearer seamless-token");

    expect(response.status).toBe(200);
    expect(response.body.records).toHaveLength(1);
    expect(response.body.records[0]).toEqual(
      expect.objectContaining({
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        filename: "20260703_001.xlsx",
        branchCodes: "001",
      }),
    );
  });

  test("creates or updates preview-backed processing history", async () => {
    const response = await request(createApp())
      .post("/api/processing-records/upsert-preview")
      .set("Authorization", "Bearer seamless-token")
      .send({
        reportType: "summary",
        filename: "20260704_003_summary.xlsx",
        branchCodes: ["003", "004"],
        uploadedBy: "gas-user",
        sourceUploadName: "legacy-source.csv",
        metadata: { imported: true },
      });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.action).toBe("created");
    expect(response.body.record).toEqual(
      expect.objectContaining({
        filename: "20260704_003_summary.xlsx",
        reportType: "summary",
        branchCodes: "003, 004",
        uploadedBy: "gas-user",
      }),
    );
  });
});
