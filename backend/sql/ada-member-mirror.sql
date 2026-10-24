CREATE SCHEMA IF NOT EXISTS ada_history;
CREATE TABLE IF NOT EXISTS ada_history.meta(marker text PRIMARY KEY,scope text NOT NULL);
CREATE TABLE IF NOT EXISTS ada_history.customers(source_id text NOT NULL,ada_code varchar(20) NOT NULL,name text,phone text,email text,branch_code text,active text,source_payload jsonb NOT NULL,payload_hash char(64) NOT NULL,source_snapshot uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_id,ada_code),CHECK(source_payload->>'FTCstCode'=ada_code));
ALTER TABLE ada_history.customers ADD COLUMN IF NOT EXISTS directory_id uuid GENERATED ALWAYS AS(md5(source_id||chr(31)||ada_code)::uuid) STORED;
CREATE UNIQUE INDEX IF NOT EXISTS history_customer_directory_id ON ada_history.customers(directory_id);
CREATE INDEX IF NOT EXISTS history_customer_phone ON ada_history.customers(phone);
CREATE TABLE IF NOT EXISTS ada_history.receipts(source_id text NOT NULL,receipt_key char(64) NOT NULL,branch_code text NOT NULL,pos_code text NOT NULL,doc_no text NOT NULL,doc_type text NOT NULL CHECK(doc_type IN('1','9')),customer_code varchar(20) NOT NULL CHECK(customer_code NOT IN('','0')),sale_date date,sale_time time without time zone,raw_sale_date text,grand_total numeric,total_before_discount numeric,paid_status text,doc_status text,refund_status text,original_doc_no text,source_payload jsonb NOT NULL,payload_hash char(64) NOT NULL,source_snapshot uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_id,receipt_key),UNIQUE(source_id,branch_code,pos_code,doc_type,doc_no),UNIQUE(source_id,doc_no));
CREATE INDEX IF NOT EXISTS history_receipt_customer ON ada_history.receipts(source_id,customer_code,sale_date DESC,sale_time DESC);
CREATE TABLE IF NOT EXISTS ada_history.lines(source_id text NOT NULL,line_key char(64) NOT NULL,receipt_key char(64) NOT NULL,seq bigint NOT NULL,sku text,product_name text,barcode text,unit_code text,unit_name text,quantity numeric,quantity_base numeric,unit_price numeric,line_total numeric,item_status text,refund_status text,source_payload jsonb NOT NULL,payload_hash char(64) NOT NULL,source_snapshot uuid NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_id,line_key),UNIQUE(source_id,receipt_key,seq),FOREIGN KEY(source_id,receipt_key) REFERENCES ada_history.receipts(source_id,receipt_key));
CREATE TABLE IF NOT EXISTS ada_history.member_links(member_id uuid NOT NULL,source_id text NOT NULL,ada_code varchar(20) NOT NULL,approval_reference text NOT NULL,PRIMARY KEY(source_id,ada_code),FOREIGN KEY(source_id,ada_code) REFERENCES ada_history.customers(source_id,ada_code));
CREATE INDEX IF NOT EXISTS history_links_member ON ada_history.member_links(member_id);
CREATE TABLE IF NOT EXISTS ada_history.checkpoints(snapshot_id uuid NOT NULL,kind text NOT NULL,last_key text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(snapshot_id,kind));
CREATE TABLE IF NOT EXISTS ada_history.change_journal(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,entity text NOT NULL,source_key text NOT NULL,old_hash char(64) NOT NULL,new_hash char(64) NOT NULL,changed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ada_history.outbound_state(member_id uuid PRIMARY KEY,profile_hash char(64) NOT NULL,state text NOT NULL CHECK(state IN('created','review')),ada_code text,last_code text,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ada_history.worker_status(worker text PRIMARY KEY,state text NOT NULL,details jsonb NOT NULL DEFAULT '{}',updated_at timestamptz NOT NULL DEFAULT now());

CREATE OR REPLACE FUNCTION ada_history.apply_batch(p_marker text,p_scope text,p_kind text,p_rows jsonb,p_snapshot uuid,p_cursor text)
RETURNS integer LANGUAGE plpgsql SET search_path=pg_catalog,ada_history AS $$
DECLARE r jsonb;p jsonb;existing ada_history.receipts%ROWTYPE;parent ada_history.receipts%ROWTYPE;line_existing ada_history.lines%ROWTYPE;n integer;changed integer=0;d text;source constant text='hq000/AdaAcc';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM ada_history.meta WHERE marker=p_marker AND scope=p_scope) OR (SELECT count(*) FROM ada_history.meta)<>1 THEN RAISE EXCEPTION 'MIRROR_TARGET_REFUSED';END IF;
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)>100 OR p_kind NOT IN('customers','receipts','lines') THEN RAISE EXCEPTION 'BATCH_SCOPE_REFUSED';END IF;
 PERFORM pg_advisory_xact_lock(731024,1438);
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  p=r->'payload';
  IF jsonb_typeof(p)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) k WHERE lower(k)~'(pin|password|secret|token)') OR (r->>'payload_hash')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'PAYLOAD_REFUSED';END IF;
  IF p_kind='customers' THEN
   IF (r->>'source_key') IS DISTINCT FROM(p->>'FTCstCode') OR (r->>'owner_code') IS DISTINCT FROM(p->>'FTCstCode') THEN RAISE EXCEPTION 'CUSTOMER_IDENTITY_MISMATCH';END IF;
   INSERT INTO ada_history.change_journal(entity,source_key,old_hash,new_hash) SELECT 'customers',r->>'source_key',payload_hash,r->>'payload_hash' FROM ada_history.customers WHERE source_id=source AND ada_code=p->>'FTCstCode' AND payload_hash<>r->>'payload_hash';
   INSERT INTO ada_history.customers(source_id,ada_code,name,phone,email,branch_code,active,source_payload,payload_hash,source_snapshot) VALUES(source,p->>'FTCstCode',p->>'FTCstName',p->>'FTCstTel',p->>'FTCstEmail',p->>'FTBchCode',p->>'FTCstStaActive',p,r->>'payload_hash',p_snapshot)
   ON CONFLICT(source_id,ada_code) DO UPDATE SET name=EXCLUDED.name,phone=EXCLUDED.phone,email=EXCLUDED.email,branch_code=EXCLUDED.branch_code,active=EXCLUDED.active,source_payload=EXCLUDED.source_payload,payload_hash=EXCLUDED.payload_hash,source_snapshot=EXCLUDED.source_snapshot,updated_at=now() WHERE customers.payload_hash<>EXCLUDED.payload_hash;
  ELSIF p_kind='receipts' THEN
   IF p->>'FTCstCode' IN('','0') OR (r->>'owner_code') IS DISTINCT FROM(p->>'FTCstCode') OR p->>'FTShdStaPaid'<>'3' OR p->>'FTShdDocType' NOT IN('1','9') OR (r->>'source_key')!~'^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'RECEIPT_IDENTITY_MISMATCH';END IF;
   SELECT * INTO existing FROM ada_history.receipts WHERE source_id=source AND doc_no=p->>'FTShdDocNo' FOR UPDATE;
   IF FOUND AND(existing.customer_code IS DISTINCT FROM(p->>'FTCstCode') OR existing.receipt_key IS DISTINCT FROM(r->>'source_key') OR existing.branch_code IS DISTINCT FROM(p->>'FTBchCode') OR existing.pos_code IS DISTINCT FROM(p->>'FTPosCode') OR existing.doc_type IS DISTINCT FROM(p->>'FTShdDocType')) THEN RAISE EXCEPTION 'RECEIPT_OWNER_OR_IDENTITY_CHANGE_REFUSED';END IF;
   IF existing.receipt_key IS NOT NULL AND existing.payload_hash<>r->>'payload_hash' THEN INSERT INTO ada_history.change_journal(entity,source_key,old_hash,new_hash) VALUES('receipts',r->>'source_key',existing.payload_hash,r->>'payload_hash');END IF;
   d=left(p->>'FDShdDocDate',10);IF left(d,4)::int BETWEEN 2400 AND 2699 THEN d=((left(d,4)::int)-543)::text||substring(d FROM 5);END IF;
   INSERT INTO ada_history.receipts(source_id,receipt_key,branch_code,pos_code,doc_no,doc_type,customer_code,sale_date,sale_time,raw_sale_date,grand_total,total_before_discount,paid_status,doc_status,refund_status,original_doc_no,source_payload,payload_hash,source_snapshot) VALUES(source,r->>'source_key',p->>'FTBchCode',p->>'FTPosCode',p->>'FTShdDocNo',p->>'FTShdDocType',p->>'FTCstCode',d::date,(p->>'FTShdDocTime')::time,p->>'FDShdDocDate',(p->>'FCShdGrand')::numeric,(p->>'FCShdTotal')::numeric,p->>'FTShdStaPaid',p->>'FTShdStaDoc',p->>'FTShdStaRefund',p->>'FTShdPosCN',p,r->>'payload_hash',p_snapshot)
   ON CONFLICT(source_id,receipt_key) DO UPDATE SET sale_date=EXCLUDED.sale_date,sale_time=EXCLUDED.sale_time,raw_sale_date=EXCLUDED.raw_sale_date,grand_total=EXCLUDED.grand_total,total_before_discount=EXCLUDED.total_before_discount,paid_status=EXCLUDED.paid_status,doc_status=EXCLUDED.doc_status,refund_status=EXCLUDED.refund_status,original_doc_no=EXCLUDED.original_doc_no,source_payload=EXCLUDED.source_payload,payload_hash=EXCLUDED.payload_hash,source_snapshot=EXCLUDED.source_snapshot,updated_at=now() WHERE receipts.payload_hash<>EXCLUDED.payload_hash;
  ELSE
   SELECT * INTO parent FROM ada_history.receipts WHERE source_id=source AND doc_no=p->>'FTShdDocNo';
   IF NOT FOUND OR parent.receipt_key IS DISTINCT FROM(r->>'parent_key') OR parent.customer_code IS DISTINCT FROM(r->>'owner_code') OR(COALESCE(p->>'FTBchCode','')<>'' AND p->>'FTBchCode'<>parent.branch_code) OR(COALESCE(p->>'FTShdDocType','')<>'' AND p->>'FTShdDocType'<>parent.doc_type) THEN RAISE EXCEPTION 'LINE_OWNER_OR_IDENTITY_MISMATCH';END IF;
   SELECT * INTO line_existing FROM ada_history.lines WHERE source_id=source AND line_key=(r->>'source_key')::char(64);
   IF FOUND AND(line_existing.receipt_key<>parent.receipt_key OR line_existing.seq<>(p->>'FNSdtSeqNo')::bigint) THEN RAISE EXCEPTION 'LINE_OWNER_OR_IDENTITY_MISMATCH';END IF;
   INSERT INTO ada_history.change_journal(entity,source_key,old_hash,new_hash) SELECT 'lines',r->>'source_key',payload_hash,r->>'payload_hash' FROM ada_history.lines WHERE source_id=source AND line_key=(r->>'source_key')::char(64) AND payload_hash<>r->>'payload_hash';
   INSERT INTO ada_history.lines(source_id,line_key,receipt_key,seq,sku,product_name,barcode,unit_code,unit_name,quantity,quantity_base,unit_price,line_total,item_status,refund_status,source_payload,payload_hash,source_snapshot) VALUES(source,r->>'source_key',parent.receipt_key,(p->>'FNSdtSeqNo')::bigint,p->>'FTPdtCode',p->>'FTPdtName',p->>'FTSdtBarCode',p->>'FTPunCode',p->>'FTSdtUnitName',(p->>'FCSdtQty')::numeric,(p->>'FCSdtQtyAll')::numeric,(p->>'FCSdtSalePrice')::numeric,(p->>'FCSdtNet')::numeric,p->>'FTSdtStaPdt',p->>'FTSdtStaRfd',p,r->>'payload_hash',p_snapshot)
   ON CONFLICT(source_id,line_key) DO UPDATE SET sku=EXCLUDED.sku,product_name=EXCLUDED.product_name,barcode=EXCLUDED.barcode,unit_code=EXCLUDED.unit_code,unit_name=EXCLUDED.unit_name,quantity=EXCLUDED.quantity,quantity_base=EXCLUDED.quantity_base,unit_price=EXCLUDED.unit_price,line_total=EXCLUDED.line_total,item_status=EXCLUDED.item_status,refund_status=EXCLUDED.refund_status,source_payload=EXCLUDED.source_payload,payload_hash=EXCLUDED.payload_hash,source_snapshot=EXCLUDED.source_snapshot,updated_at=now() WHERE lines.payload_hash<>EXCLUDED.payload_hash;
  END IF;
  GET DIAGNOSTICS n=ROW_COUNT;changed=changed+n;
 END LOOP;
 INSERT INTO ada_history.checkpoints(snapshot_id,kind,last_key) VALUES(p_snapshot,p_kind,p_cursor) ON CONFLICT(snapshot_id,kind) DO UPDATE SET last_key=EXCLUDED.last_key,updated_at=now();
 RETURN changed;
END $$;
REVOKE ALL ON FUNCTION ada_history.apply_batch(text,text,text,jsonb,uuid,text) FROM PUBLIC;

CREATE OR REPLACE VIEW ada_history.directory AS
 SELECT u.id,u.full_name,COALESCE(u.phone_number,a.phone) phone_number,m.member_code,m.is_active,m.created_at,'sccrm'::text source FROM public.users u JOIN public.member_profiles m ON m.user_id=u.id LEFT JOIN LATERAL(SELECT c.phone FROM ada_history.member_links l JOIN ada_history.customers c ON c.source_id=l.source_id AND c.ada_code=l.ada_code WHERE l.member_id=u.id ORDER BY c.ada_code LIMIT 1) a ON true
 UNION ALL
 SELECT c.directory_id,c.name,c.phone,'ADA-'||c.ada_code,c.active='1',c.updated_at,'ada'::text FROM ada_history.customers c WHERE NOT EXISTS(SELECT 1 FROM ada_history.member_links l WHERE l.source_id=c.source_id AND l.ada_code=c.ada_code);

CREATE OR REPLACE VIEW ada_history.purchase_claims AS
 SELECT 'ada:'||r.receipt_key AS id,COALESCE(ml.member_id,c.directory_id)::text user_id,r.doc_no receipt_no,r.branch_code,
 ((r.sale_date+COALESCE(r.sale_time,'00:00:00'::time)) AT TIME ZONE 'Asia/Bangkok') sold_at,0::numeric total_amount,0::integer awarded_points,
 ((r.sale_date+COALESCE(r.sale_time,'00:00:00'::time)) AT TIME ZONE 'Asia/Bangkok') created_at,
 r.source_payload->>'FTUsrCode' cashier_staff_code,r.grand_total*(CASE WHEN r.doc_type='9' THEN -1 ELSE 1 END) receipt_total_amount,
 jsonb_build_object('version',1,'documentType',CASE WHEN r.doc_type='9' THEN 'return' ELSE 'sale' END,'totalAmountSource','ada_header','posCode',r.pos_code,'receiptCashierCode',r.source_payload->>'FTUsrCode','totalAmount',r.grand_total*(CASE WHEN r.doc_type='9' THEN -1 ELSE 1 END),'items',
 COALESCE((SELECT jsonb_agg(jsonb_build_object('seq',i.seq,'productCode',i.sku,'productName',i.product_name,'barcode',i.barcode,'unitCode',i.unit_code,'unitName',i.unit_name,'qty',i.quantity,'unitPrice',i.unit_price,'lineTotal',i.line_total) ORDER BY i.seq) FROM ada_history.lines i WHERE i.source_id=r.source_id AND i.receipt_key=r.receipt_key),'[]'::jsonb)) receipt_snapshot
 FROM ada_history.receipts r JOIN ada_history.customers c ON c.source_id=r.source_id AND c.ada_code=r.customer_code LEFT JOIN ada_history.member_links ml ON ml.source_id=c.source_id AND ml.ada_code=c.ada_code
 WHERE NOT EXISTS(SELECT 1 FROM public.loyalty_claims lc WHERE UPPER(BTRIM(lc.branch_code))=UPPER(BTRIM(r.branch_code)) AND UPPER(BTRIM(lc.receipt_no))=UPPER(BTRIM(r.doc_no)));

REVOKE ALL ON SCHEMA ada_history FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ada_history FROM PUBLIC;
