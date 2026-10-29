import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { parse } from 'csv-parse/sync';

const KEY = 'ada-pos-20260401-20261028-fefo-draft-v1';
const SOURCE_SHA = 'e2514d3e8199237447e15e3e70bfd036439263122d1362cd7ea3e8fb793e2c1c';
const PDFS = [
  { key:'all-31', branch:null, jobs:31, pages:68, filename:'KY11_20260401-20261028_31_Jobs_Recorded_Transfers_DRAFT.pdf', sha:'7b4e42022696d16e5bcabe9e7f40bfc7044ab2a8df9f29f9339833a47ab20cc6' },
  { key:'branch-001', branch:'001', jobs:9, pages:34, filename:'KY11_20260401-20261028_Branch001_Recorded_Transfers_DRAFT.pdf', sha:'60d6fba0ccf6161986177e8ddd1205e2a35869e2c6121d3f818474d7833eb5d8' },
  { key:'branch-003', branch:'003', jobs:8, pages:15, filename:'KY11_20260401-20261028_Branch003_Recorded_Transfers_DRAFT.pdf', sha:'0439d203141bf2cb668aadaba2c1b21451e28d214dc14a3a702f64dae2a70eba' },
  { key:'branch-004', branch:'004', jobs:7, pages:11, filename:'KY11_20260401-20261028_Branch004_Recorded_Transfers_DRAFT.pdf', sha:'8669ab2f3a97d37e5b0b5c251d63954696ee4f1b61282f4cdd65992f85096ed3' },
  { key:'branch-005', branch:'005', jobs:7, pages:8, filename:'KY11_20260401-20261028_Branch005_Recorded_Transfers_DRAFT.pdf', sha:'9dccd69c650ec387f260790bded953f17d7e52153e58c307ca281c9fb067448b' },
];
const args = process.argv.slice(2);
const arg = name => { const i=args.indexOf(name); return i<0?'':String(args[i+1]||'').trim(); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePath=arg('--source'), pdfDir=arg('--pdf-dir');
if (!sourcePath || !pdfDir) throw new Error('Pass --source and --pdf-dir');
const bytes=await fs.readFile(sourcePath);
if (hash(bytes)!==SOURCE_SHA) throw new Error('KY11 CSV differs from reviewed Oct 28 source');
const csv=bytes.toString('utf8');
const rows=parse(csv,{columns:true,bom:true,skip_empty_lines:true});
const counts={SALE:0,LOT:0,TRANSFER_OUT:0,PAPER:0,SIMULATED:0};
const codes=new Set(), branches=new Set();
for(const row of rows){
  if(!(row.recordType in counts)) throw new Error(`Unexpected recordType: ${row.recordType}`);
  counts[row.recordType]++;
  codes.add(row.productCode);branches.add(row.branchCode);
  if(row.recordType==='SALE' && (row.saleDate<'2026-04-01'||row.saleDate>'2026-10-28')) throw new Error('Sale outside period');
  if(row.recordType==='LOT' && row.receiptBasis?.startsWith('PAPER_CONFIRMED')) counts.PAPER++;
  if(row.recordType==='LOT' && row.receiptBasis?.includes('SIMULATED')) counts.SIMULATED++;
}
if(rows.length!==5855||counts.SALE!==5561||counts.LOT!==255||counts.TRANSFER_OUT!==39||counts.PAPER!==19||counts.SIMULATED!==0||codes.size!==27||[...branches].sort().join(',')!=='001,003,004,005') throw new Error('KY11 row counts, lots, branches or provenance changed');
const pdfs=[];
for(const pdf of PDFS){
  const content=await fs.readFile(path.join(pdfDir,pdf.filename));
  if(!content.subarray(0,5).equals(Buffer.from('%PDF-'))||hash(content)!==pdf.sha) throw new Error(`PDF changed: ${pdf.filename}`);
  pdfs.push({...pdf,content});
}
const provenance={
  reportGroup:'KY11', period:'2026-04-01/2026-10-28', targetProducts:27, branches:['001','003','004','005'],
  basis:'Ada POS sales and SKU quantity, Rx1011 documented lot movements, 19 paper-confirmed branch lots; sale lots allocated by FEFO inference',
  jobStatus:{pdfDraft:31,inferredLotCandidateAwaitingPdf:55,lotOrTransferConflict:9,adaNegativeBalance:7},
  transferRule:'Use recorded transfer lot, even when different from reconstructed FEFO',
  missingEntryRule:'Staff report that the first keyed branch+SKU lot labels earlier unkeyed stock, and the latest keyed lot continues until a new lot appears. This is an inference only; it does not establish a receipt date or the lot actually sold. This rule was audited for 55 candidate jobs but was not applied to the 31 archived v1 PDFs.',
  knownException:'TS00426-000761 was dispatched from 004 on 2026-10-27 but not received in 005 stock card through 2026-10-28; 40 units in transit',
  warning:'Neither POS nor Ada stock card records the lot actually sold. First web-keyed lot date may label existing stock, not a physical receipt. The 31 PDFs are drafts for pharmacist review, not regulatory attestations.'
};
const result={snapshotKey:KEY,sourceSha256:SOURCE_SHA,counts,artifacts:pdfs.map(({key,branch,jobs,pages,sha})=>({key,branch,jobs,pages,sha}))};
const migration=await fs.readFile(new URL('../src/modules/rx1011/migrations/0029_ky11_oct28_frozen_drafts.sql',import.meta.url),'utf8');
const emitPsql=arg('--emit-psql');
if(emitPsql){
  const quote=value=>`'${String(value).replaceAll("'","''")}'`;
  const psqlPath=value=>quote(path.resolve(value).replaceAll('\\','/'));
  const lines=['\\set ON_ERROR_STOP on','BEGIN;',migration];
  lines.push(`\\lo_import ${psqlPath(sourcePath)}`);
  lines.push('\\set source_oid :LASTOID');
  lines.push(`SELECT 1/(CASE WHEN encode(sha256(lo_get(:source_oid)),'hex')=${quote(SOURCE_SHA)} THEN 1 ELSE 0 END) AS source_hash_ok;`);
  lines.push(`INSERT INTO ky11_bulk_source_snapshots (snapshot_key,period_start,period_end,source_filename,source_sha256,source_csv,sales_row_count,lot_row_count,confirmed_paper_lot_count,simulated_lot_count,source_status,transfer_row_count,source_provenance)
    VALUES (${quote(KEY)},'2026-04-01','2026-10-28',${quote(path.basename(sourcePath))},${quote(SOURCE_SHA)},convert_from(lo_get(:source_oid),'UTF8'),5561,255,19,0,'DRAFT_FEFO_PARTIAL_LOT',39,${quote(JSON.stringify(provenance))}::jsonb)
    ON CONFLICT (snapshot_key) DO NOTHING;`);
  lines.push(`SELECT 1/(CASE WHEN EXISTS (SELECT 1 FROM ky11_bulk_source_snapshots WHERE snapshot_key=${quote(KEY)} AND source_sha256=${quote(SOURCE_SHA)} AND encode(sha256(convert_to(source_csv,'UTF8')),'hex')=${quote(SOURCE_SHA)}) THEN 1 ELSE 0 END) AS stored_source_ok;`);
  lines.push('SELECT lo_unlink(:source_oid);');
  for(const pdf of pdfs){
    lines.push(`\\lo_import ${psqlPath(path.join(pdfDir,pdf.filename))}`);
    lines.push('\\set pdf_oid :LASTOID');
    lines.push(`SELECT 1/(CASE WHEN encode(sha256(lo_get(:pdf_oid)),'hex')=${quote(pdf.sha)} THEN 1 ELSE 0 END) AS pdf_hash_ok;`);
    lines.push(`INSERT INTO ky11_bulk_draft_artifacts (artifact_key,snapshot_key,branch_code,source_filename,pdf_sha256,pdf_bytes,page_count,job_count,document_status)
      VALUES (${quote(pdf.key)},${quote(KEY)},${pdf.branch?quote(pdf.branch):'NULL'},${quote(pdf.filename)},${quote(pdf.sha)},lo_get(:pdf_oid),${pdf.pages},${pdf.jobs},'DRAFT_FEFO_REVIEW')
      ON CONFLICT (snapshot_key,artifact_key) DO NOTHING;`);
    lines.push(`SELECT 1/(CASE WHEN EXISTS (SELECT 1 FROM ky11_bulk_draft_artifacts WHERE snapshot_key=${quote(KEY)} AND artifact_key=${quote(pdf.key)} AND pdf_sha256=${quote(pdf.sha)} AND encode(sha256(pdf_bytes),'hex')=${quote(pdf.sha)}) THEN 1 ELSE 0 END) AS stored_pdf_ok;`);
    lines.push('SELECT lo_unlink(:pdf_oid);');
  }
  lines.push(`SELECT snapshot_key,sales_row_count,lot_row_count,transfer_row_count,source_status FROM ky11_bulk_source_snapshots WHERE snapshot_key=${quote(KEY)};`);
  lines.push(`SELECT artifact_key,branch_code,page_count,job_count,document_status FROM ky11_bulk_draft_artifacts WHERE snapshot_key=${quote(KEY)} ORDER BY branch_code NULLS FIRST;`);
  lines.push(args.includes('--apply')?'COMMIT;':'ROLLBACK;');
  await fs.writeFile(emitPsql,lines.join('\n')+'\n','utf8');
  console.log(JSON.stringify({...result,action:args.includes('--apply')?'psql-apply-script-written':'psql-rehearsal-script-written',scriptPath:emitPsql}));
  process.exit(0);
}
const rehearse=args.includes('--rehearse'), apply=args.includes('--apply');
if(rehearse===apply){console.log(JSON.stringify({...result,action:'validated-only'}));process.exit(0);}
const envFile=arg('--env-file'), expectedHost=arg('--expect-host');
if(!envFile||!expectedHost) throw new Error('Database run requires --env-file and --expect-host');
dotenv.config({path:envFile,quiet:true});
const connectionString=process.env.RX1011_DATABASE_URL;
if(!connectionString) throw new Error('RX1011_DATABASE_URL is missing');
const host=new URL(connectionString).hostname;
if(host!==expectedHost) throw new Error('RX1011 database host does not match expected host');
const client=new pg.Client({connectionString,ssl:/localhost|127\.0\.0\.1/i.test(host)?false:{rejectUnauthorized:false}});
await client.connect();
try{
  await client.query('BEGIN');
  const identity=await client.query('SELECT current_database() AS name');
  if(identity.rows[0].name!=='rx1011_db') throw new Error('Unexpected database identity');
  await client.query(migration);
  const existing=await client.query('SELECT source_sha256 FROM ky11_bulk_source_snapshots WHERE snapshot_key=$1',[KEY]);
  if(existing.rows.length && existing.rows[0].source_sha256.trim()!==SOURCE_SHA) throw new Error('Snapshot key exists with different source');
  if(!existing.rows.length) await client.query(
    `INSERT INTO ky11_bulk_source_snapshots
     (snapshot_key,period_start,period_end,source_filename,source_sha256,source_csv,sales_row_count,lot_row_count,confirmed_paper_lot_count,simulated_lot_count,source_status,transfer_row_count,source_provenance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [KEY,'2026-04-01','2026-10-28',path.basename(sourcePath),SOURCE_SHA,csv,counts.SALE,counts.LOT,counts.PAPER,counts.SIMULATED,'DRAFT_FEFO_PARTIAL_LOT',counts.TRANSFER_OUT,JSON.stringify(provenance)]
  );
  for(const pdf of pdfs){
    const current=await client.query('SELECT pdf_sha256 FROM ky11_bulk_draft_artifacts WHERE snapshot_key=$1 AND artifact_key=$2',[KEY,pdf.key]);
    if(current.rows.length && current.rows[0].pdf_sha256.trim()!==pdf.sha) throw new Error(`Artifact key exists with different PDF: ${pdf.key}`);
    if(!current.rows.length) await client.query(
      `INSERT INTO ky11_bulk_draft_artifacts
       (artifact_key,snapshot_key,branch_code,source_filename,pdf_sha256,pdf_bytes,page_count,job_count,document_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT_FEFO_REVIEW')`,
      [pdf.key,KEY,pdf.branch,pdf.filename,pdf.sha,pdf.content,pdf.pages,pdf.jobs]
    );
  }
  const stored=await client.query('SELECT source_csv,source_sha256,source_status FROM ky11_bulk_source_snapshots WHERE snapshot_key=$1',[KEY]);
  if(hash(Buffer.from(stored.rows[0].source_csv,'utf8'))!==SOURCE_SHA||stored.rows[0].source_sha256.trim()!==SOURCE_SHA||stored.rows[0].source_status!=='DRAFT_FEFO_PARTIAL_LOT') throw new Error('Stored source verification failed');
  const artifactRows=await client.query('SELECT artifact_key,pdf_sha256,pdf_bytes FROM ky11_bulk_draft_artifacts WHERE snapshot_key=$1',[KEY]);
  if(artifactRows.rows.length!==5||artifactRows.rows.some(row=>hash(row.pdf_bytes)!==row.pdf_sha256.trim())) throw new Error('Stored PDF verification failed');
  await client.query(rehearse?'ROLLBACK':'COMMIT');
  console.log(JSON.stringify({...result,action:rehearse?'rehearsed-and-rolled-back':'saved-and-verified',database:identity.rows[0].name,host}));
}catch(error){await client.query('ROLLBACK');throw error;}finally{await client.end();}
