const express = require("express");
const request = require("supertest");

const state = {};
let mockNextId = 1;

function resetState() {
  mockNextId = 1;
  state.members = [
    {
      id: "11111111-1111-1111-1111-111111111111",
      full_name: "Alice Pharmacist",
      phone: "0812345678",
      email: "alice@example.com",
      sex: "female",
      dob: "1990-04-12",
      remark: "existing member",
      member_code: "SCM-ALICE01",
      tier: "bronze",
      is_active: true,
      current_points: 15,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    },
  ];
  state.medRecords = {
    "11111111-1111-1111-1111-111111111111": {
      member_id: "11111111-1111-1111-1111-111111111111",
      pid_document_type: "THAI_ID",
      pid_document_number_raw: "1101700203450",
      pid_document_number_normalized: "1101700203450",
      weight_kg: 55.5,
      height_cm: 163,
      bp_systolic: 120,
      bp_diastolic: 80,
      blood_type: "A",
      blood_rh: "+",
      has_diabetes: false,
      has_hypertension: true,
      has_hyperlipidemia: false,
      has_heart_disease: false,
      has_kidney_disease: false,
      has_liver_disease: false,
      has_thyroid_disease: false,
      other_conditions: "seasonal migraine",
      drug_allergies: "penicillin",
      food_allergies: "shrimp",
      current_medications: "vitamin c",
      medical_history: "none",
      is_smoker: false,
      drinks_alcohol: true,
      is_pregnant: false,
      is_breastfeeding: false,
    },
  };
  state.staffDevices = [
    {
      id: "staff-device-1",
      device_id: "device-1",
      device_name: "Counter Tablet",
      branch_id: null,
      branch_name: null,
      branch_code: null,
      revoked_at: null,
      token_hash: "hash:test-staff-token",
    },
  ];
}

resetState();

function currentTimestamp() {
  return "2026-06-12T10:00:00.000Z";
}

async function mockQuery(sql, params = []) {
  const text = String(sql).replace(/\s+/g, " ").trim();

  if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
    return { rows: [], rowCount: 0 };
  }

  if (text.includes("SELECT sd.id, sd.device_id, sd.device_name, sd.branch_id")) {
    const found = state.staffDevices.find((item) => item.token_hash === params[0] && !item.revoked_at);
    return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("UPDATE staff_devices SET last_seen_at = NOW()")) {
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("SELECT id FROM users WHERE phone_number =")) {
    const found = state.members.find((item) => item.phone === params[0]);
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("INSERT INTO users (id, phone_number, full_name, email, sex, dob, remark")) {
    state.members.push({
      id: params[0],
      phone: params[1],
      full_name: params[2],
      email: params[3],
      sex: params[4],
      dob: params[5],
      remark: params[6],
      member_code: null,
      tier: "general",
      is_active: true,
      current_points: 0,
      created_at: currentTimestamp(),
      updated_at: currentTimestamp(),
    });
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("INSERT INTO member_profiles")) {
    const found = state.members.find((item) => item.id === params[1]);
    if (found) {
      found.member_code = params[2];
      found.tier = "general";
      found.is_active = true;
      found.updated_at = currentTimestamp();
    }
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("INSERT INTO member_pharmacy_med_records")) {
    state.medRecords[String(params[0])] = {
      member_id: String(params[0]),
      pid_document_type: params[1],
      pid_document_number_raw: params[2],
      pid_document_number_normalized: params[3],
      weight_kg: params[4],
      height_cm: params[5],
      bp_systolic: params[6],
      bp_diastolic: params[7],
      blood_type: params[8],
      blood_rh: params[9],
      has_diabetes: params[10],
      has_hypertension: params[11],
      has_hyperlipidemia: params[12],
      has_heart_disease: params[13],
      has_kidney_disease: params[14],
      has_liver_disease: params[15],
      has_thyroid_disease: params[16],
      other_conditions: params[17],
      drug_allergies: params[18],
      food_allergies: params[19],
      current_medications: params[20],
      medical_history: params[21],
      is_smoker: params[22],
      drinks_alcohol: params[23],
      is_pregnant: params[24],
      is_breastfeeding: params[25],
    };
    return { rows: [], rowCount: 1 };
  }

  if (text.startsWith("SELECT u.id FROM users u JOIN member_profiles m ON m.user_id = u.id WHERE u.id = $1::uuid")) {
    const found = state.members.find((item) => item.id === params[0] && item.member_code);
    return { rows: found ? [{ id: found.id }] : [], rowCount: found ? 1 : 0 };
  }

  if (text.startsWith("UPDATE users SET")) {
    const memberId = params[params.length - 1];
    const found = state.members.find((item) => item.id === memberId);
    if (!found) return { rows: [], rowCount: 0 };

    const assignments = text
      .slice("UPDATE users SET ".length, text.indexOf(" WHERE id ="))
      .split(", ")
      .map((part) => part.split(" = ")[0]);

    assignments.forEach((column, index) => {
      const value = params[index];
      if (column === "full_name") found.full_name = value;
      if (column === "phone_number") found.phone = value;
      if (column === "email") found.email = value;
      if (column === "sex") found.sex = value;
      if (column === "dob") found.dob = value;
      if (column === "remark") found.remark = value;
    });
    found.updated_at = currentTimestamp();
    return { rows: [], rowCount: 1 };
  }

  if (text.includes("FROM users u JOIN member_profiles m ON m.user_id = u.id WHERE u.id = $1::uuid")) {
    const found = state.members.find((item) => item.id === params[0] && item.member_code);
    return {
      rows: found
        ? [{
            id: found.id,
            full_name: found.full_name,
            phone: found.phone,
            email: found.email,
            sex: found.sex,
            dob: found.dob,
            remark: found.remark,
            created_at: found.created_at,
            updated_at: found.updated_at,
            tier: found.tier,
            is_active: found.is_active,
            member_code: found.member_code,
            current_points: found.current_points,
          }]
        : [],
      rowCount: found ? 1 : 0,
    };
  }

  if (text.startsWith("SELECT member_id, pid_document_type, pid_document_number_raw")) {
    const found = state.medRecords[String(params[0])];
    return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
  }

  return { rows: [], rowCount: 0 };
}

jest.mock("../db", () => ({
  query: jest.fn((sql, params) => mockQuery(sql, params)),
  connect: jest.fn(async () => ({
    query: jest.fn((sql, params) => mockQuery(sql, params)),
    release: jest.fn(),
  })),
}));

jest.mock("../lib/sccrm", () => ({
  createId: jest.fn(() => `generated-id-${mockNextId++}`),
  generateMemberCode: jest.fn(() => "SCM-NEW0001"),
  hashOpaqueToken: jest.fn((token) => `hash:${token}`),
  normalizePhone: jest.fn((value) => String(value || "").trim()),
  parseBearerToken: jest.fn((header) => {
    if (!header || !header.startsWith("Bearer ")) return null;
    return header.slice("Bearer ".length);
  }),
}));

const loyaltyRouter = require("../routes/loyalty");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/members", loyaltyRouter);
  return app;
}

beforeEach(() => {
  resetState();
  process.env.POS_API_KEY = "pos-key";
  process.env.BRANCH_STOCK_SYNC_TOKEN = "legacy-key";
});

afterAll(() => {
  delete process.env.POS_API_KEY;
  delete process.env.BRANCH_STOCK_SYNC_TOKEN;
});

describe("loyalty member demographics", () => {
  test("GET /api/members/:id returns stored sex, dob, and remark", async () => {
    const response = await request(createApp())
      .get("/api/members/11111111-1111-1111-1111-111111111111")
      .set("x-pos-api-key", "pos-key");

    expect(response.status).toBe(200);
    expect(response.body.displayName).toBe("Alice Pharmacist");
    expect(response.body.sex).toBe("female");
    expect(response.body.dob).toBe("1990-04-12");
    expect(response.body.remark).toBe("existing member");
    expect(response.body.pharmacy_med_record).toEqual(expect.objectContaining({
      pidDocumentType: "THAI_ID",
      weightKg: 55.5,
      hasHypertension: true,
      drinksAlcohol: true,
    }));
  });

  test("PUT /api/members/:id persists normalized sex and dob", async () => {
    const response = await request(createApp())
      .put("/api/members/11111111-1111-1111-1111-111111111111")
      .set("x-pos-api-key", "pos-key")
      .send({
        name: "Alice Updated",
        sex: "2",
        dob: "1991-05-20",
        remark: "updated from POS",
        pharmacy_med_record: {
          pidDocumentType: "PASSPORT",
          pidDocumentNumberRaw: " ab 12345 ",
          weightKg: 62.25,
          hasDiabetes: true,
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.displayName).toBe("Alice Updated");
    expect(response.body.sex).toBe("female");
    expect(response.body.dob).toBe("1991-05-20");
    expect(response.body.remark).toBe("updated from POS");
    expect(response.body.pharmacy_med_record).toEqual(expect.objectContaining({
      pidDocumentType: "PASSPORT",
      pidDocumentNumberRaw: "ab 12345",
      pidDocumentNumberNormalized: "AB12345",
      hasDiabetes: true,
      weightKg: 62.25,
    }));
  });

  test("POST /api/members stores demographics from WinForms payload", async () => {
    const response = await request(createApp())
      .post("/api/members")
      .set("Authorization", "Bearer test-staff-token")
      .send({
        name: "New Member",
        phone: "0999999999",
        email: "new@example.com",
        sex: "male",
        dob: "1988-09-15",
        remark: "created in POS",
        pharmacy_med_record: {
          pidDocumentType: "THAI_ID",
          pidDocumentNumberRaw: "1101700203450",
          weightKg: 70,
          heightCm: 175,
          hasDiabetes: false,
          hasHypertension: false,
          isSmoker: false,
        },
      });

    expect(response.status).toBe(201);
    expect(response.body.displayName).toBe("New Member");
    expect(response.body.sex).toBe("male");
    expect(response.body.dob).toBe("1988-09-15");
    expect(response.body.remark).toBe("created in POS");
    expect(response.body.pharmacy_med_record).toEqual(expect.objectContaining({
      pidDocumentType: "THAI_ID",
      pidDocumentNumberNormalized: "1101700203450",
      weightKg: 70,
      heightCm: 175,
    }));
  });

  test("PUT /api/members/:id keeps existing medical record when pharmacy_med_record is omitted", async () => {
    const response = await request(createApp())
      .put("/api/members/11111111-1111-1111-1111-111111111111")
      .set("x-pos-api-key", "pos-key")
      .send({
        remark: "no medical overwrite",
      });

    expect(response.status).toBe(200);
    expect(response.body.pharmacy_med_record).toEqual(expect.objectContaining({
      pidDocumentType: "THAI_ID",
      pidDocumentNumberNormalized: "1101700203450",
      otherConditions: "seasonal migraine",
    }));
  });
});
