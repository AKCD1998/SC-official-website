const { createHash } = require("node:crypto");

const query = jest.fn();
jest.unstable_mockModule("../src/modules/rx1011/db/pool.js", () => ({ query }));

let getKy11BulkSourceSnapshot, listKy11BulkDraftArtifacts, getKy11BulkDraftArtifact;
beforeAll(async () => {
  ({ getKy11BulkSourceSnapshot, listKy11BulkDraftArtifacts, getKy11BulkDraftArtifact } = await import("../src/modules/rx1011/controllers/ky11BulkSnapshotsController.js"));
});
beforeEach(() => query.mockReset());

const response = () => ({ set: jest.fn(), type: jest.fn(), send: jest.fn() });
const request = { params: { snapshotKey: "stockday-20260618-20260927-dev-v1" } };

test("serves the exact saved CSV with private cache headers", async () => {
  const csv = "\uFEFFrecordType,branchCode\nSALE,001";
  const source_sha256 = createHash("sha256").update(csv, "utf8").digest("hex");
  query.mockResolvedValue({ rows: [{ source_csv: csv, source_sha256 }] });
  const res = response();
  await getKy11BulkSourceSnapshot(request, res);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("WHERE snapshot_key = $1"), [request.params.snapshotKey]);
  expect(res.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  expect(res.type).toHaveBeenCalledWith("text/csv; charset=utf-8");
  expect(res.send).toHaveBeenCalledWith(csv);
});

test("rejects missing or altered snapshots", async () => {
  query.mockResolvedValueOnce({ rows: [] });
  await expect(getKy11BulkSourceSnapshot(request, response())).rejects.toMatchObject({ status: 404 });
  query.mockResolvedValueOnce({ rows: [{ source_csv: "changed", source_sha256: "0".repeat(64) }] });
  await expect(getKy11BulkSourceSnapshot(request, response())).rejects.toMatchObject({ status: 500 });
});

test("lists only draft PDF metadata for a saved source version", async () => {
  query.mockResolvedValue({ rows: [{ artifact_key:'all-31', branch_code:null, source_filename:'KY11.pdf',
    pdf_sha256:'a'.repeat(64), page_count:68, job_count:31, document_status:'DRAFT_FEFO_REVIEW', created_at:new Date('2026-10-29') }] });
  const res={set:jest.fn(),json:jest.fn()};
  await listKy11BulkDraftArtifacts(request,res);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE snapshot_key = $1'),[request.params.snapshotKey]);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({artifacts:[expect.objectContaining({key:'all-31',jobCount:31,status:'DRAFT_FEFO_REVIEW'})]}));
});

test("serves exact frozen PDF bytes and rejects corruption", async () => {
  const pdf=Buffer.from('%PDF-1.7\nprivate draft');
  const sha=createHash('sha256').update(pdf).digest('hex');
  const req={params:{snapshotKey:'s1',artifactKey:'all-31'}};
  const res={set:jest.fn(),type:jest.fn(),send:jest.fn()};
  query.mockResolvedValueOnce({rows:[{source_filename:'KY11.pdf',pdf_sha256:sha,pdf_bytes:pdf}]});
  await getKy11BulkDraftArtifact(req,res);
  expect(query).toHaveBeenCalledWith(expect.stringContaining('snapshot_key = $1 AND artifact_key = $2'),['s1','all-31']);
  expect(res.type).toHaveBeenCalledWith('application/pdf');
  expect(res.send).toHaveBeenCalledWith(pdf);
  query.mockResolvedValueOnce({rows:[{source_filename:'KY11.pdf',pdf_sha256:'0'.repeat(64),pdf_bytes:pdf}]});
  await expect(getKy11BulkDraftArtifact(req,res)).rejects.toMatchObject({status:500});
});
