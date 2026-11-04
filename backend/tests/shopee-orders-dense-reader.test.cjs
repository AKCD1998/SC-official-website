const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ExcelJS = require('exceljs');
const XLSX = require('xlsx');
const { HEADERS, readSalesSourceBuffer, parseSalesSourceRows } = require('../src/modules/seamless/services/shopeeSalesSourceService');

const options = { shopCode:'sc-drug-store', observedAt:'2026-11-04T03:00:00.000Z',
  sourceFilename:'Order.all.20261103_20261103.xlsx' };
const values = id => [id,'สำเร็จแล้ว','2026-11-03 10:00','2026-11-03 10:01',
  'Synthetic product','1 ชิ้น',1,50,49,1,0,'-','-'];
async function fixture(change = () => {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('unrelated').addRow(['Do not select the first worksheet']);
  const sheet = workbook.addWorksheet('orders');
  sheet.addRow(Object.values(HEADERS));
  sheet.getRow(4).values = values('TESTDENSE001');
  sheet.getRow(6).values = values('TESTDENSE002');
  change(sheet, workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
async function legacyRead(bytes) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  const sheet = workbook.getWorksheet('orders');
  const rows = [];
  sheet.eachRow({includeEmpty:true},row => rows.push(Array.from({length:sheet.columnCount},(_,i)=>row.getCell(i+1).value)));
  return parseSalesSourceRows(rows,{...options,sourceSha256:crypto.createHash('sha256').update(bytes).digest('hex')});
}

test('dense orders reader retains sparse source rows, actual sheet identity, date cells and merged values',async()=>{
  const bytes=await fixture((sheet,workbook)=>{
    workbook.properties.date1904=true;
    sheet.getCell('C4').value=new Date('2026-11-03T10:00:00.000Z');
    sheet.mergeCells('E4:F4');
    // A genuinely empty gap remains empty; data row six retains source row six.
  });
  const actual=await readSalesSourceBuffer(bytes,options);
  expect(actual).toEqual(await legacyRead(bytes));
  expect(actual.facts.map(f=>f.sourceRows)).toEqual([[4],[6]]);
  expect(actual.facts[0].lineFinancials).toEqual([{netSale:49,shopeeProductDiscount:1}]);
});

test.each([
  ['formula',sheet=>{sheet.getCell('H4').value={formula:'25+25',result:50};}],
  ['rich text',sheet=>{sheet.getCell('E4').value={richText:[{text:'Synthetic ',font:{bold:true}},{text:'product'}]};}],
  ['hyperlink',sheet=>{sheet.getCell('E4').value={text:'Synthetic product',hyperlink:'https://example.invalid/'};}],
  ['error cell',sheet=>{sheet.getCell('H4').value={error:'#VALUE!'};}],
  ['duplicate required header',sheet=>{sheet.getCell('N1').value=HEADERS.quantity;}],
])('dense orders reader retains strict rejection of %s',async(_name,change)=>{
  const bytes=await fixture(change);
  await expect(legacyRead(bytes)).rejects.toThrow();
  await expect(readSalesSourceBuffer(bytes,options)).rejects.toThrow();
});

test('orders filename cannot make CSV or ODS into an original XLSX source',async()=>{
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([Object.values(HEADERS),values('TESTDENSE003')]),'orders');
  const ods=XLSX.write(workbook,{type:'buffer',bookType:'ods'});
  const csv=Buffer.from(XLSX.utils.sheet_to_csv(workbook.Sheets.orders));
  for(const bytes of [ods,csv])await expect(readSalesSourceBuffer(bytes,options)).rejects.toThrow();
});

test('month-sized wide workbook parses within a constrained heap without dropping financial or source rows',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shopee-orders-memory-'));
  try {
    const rows=[Object.values(HEADERS).concat(Array.from({length:77},(_,i)=>'Unused source field '+i))];
    for(let i=0;i<7000;i++)rows.push(values('TESTMEM'+String(i).padStart(7,'0')).concat(Array.from({length:77},(_,c)=>'Synthetic metadata '+c)));
    const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet(rows,{dense:true}),'orders');
    const file=path.join(dir,'orders.xlsx');XLSX.writeFile(workbook,file,{compression:true});
    const reader=require.resolve('../src/modules/seamless/services/shopeeSalesSourceService');
    const script=`const fs=require('fs');const {readSalesSourceBuffer}=require(${JSON.stringify(reader)});readSalesSourceBuffer(fs.readFileSync(process.argv[1]),${JSON.stringify(options)}).then(s=>console.log(JSON.stringify({orders:s.facts.length,rows:s.facts.reduce((n,f)=>n+f.items.length,0),net:s.facts.reduce((n,f)=>n+Math.round(f.itemSubtotal*100),0),support:s.facts.reduce((n,f)=>n+Math.round(f.shopeeProductDiscount*100),0),first:s.facts[0].sourceRows,last:s.facts.at(-1).sourceRows}))).catch(()=>process.exitCode=1);`;
    const child=spawnSync(process.execPath,['--max-old-space-size=192','--max-semi-space-size=8','-e',script,file],{encoding:'utf8',windowsHide:true,timeout:45000,maxBuffer:2*1024*1024});
    expect({status:child.status,error:child.error?.code,stderr:child.stderr.slice(-500)}).toEqual({status:0,error:undefined,stderr:''});
    expect(JSON.parse(child.stdout)).toEqual({orders:7000,rows:7000,net:34300000,support:700000,first:[2],last:[7001]});
  } finally {
    // This directory was created above; never delete a computed broader target.
    if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('shopee-orders-memory-'))throw Error('Unsafe test cleanup path');
    fs.rmSync(dir,{recursive:true,force:true});
  }
},60000);
