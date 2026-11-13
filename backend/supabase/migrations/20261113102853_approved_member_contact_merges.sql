-- Private audit only. No authenticated/anon grants or callable merge RPC.
CREATE TABLE ada_history.member_merges (
 source_member_id uuid PRIMARY KEY REFERENCES public.users(id),
 target_member_id uuid NOT NULL REFERENCES public.users(id),
 source_code text NOT NULL, target_code text NOT NULL,
 source_phone text NOT NULL, primary_phone text NOT NULL,
 approval_reference text NOT NULL CHECK(length(approval_reference) BETWEEN 1 AND 500),
 before_state jsonb NOT NULL, merged_at timestamptz NOT NULL DEFAULT now(),
 CHECK(source_member_id<>target_member_id)
);
ALTER TABLE ada_history.member_merges ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ada_history.member_merges FROM PUBLIC,anon,authenticated;
-- Preserve existing directory access; hide only explicitly retired duplicates.
CREATE OR REPLACE VIEW ada_history.directory AS
 SELECT u.id,
    u.full_name,
    COALESCE(u.phone_number, m.contact_phone, a.phone::character varying) AS phone_number,
    m.member_code,
    m.is_active,
    m.created_at,
    'sccrm'::text AS source
   FROM users u
     JOIN member_profiles m ON m.user_id = u.id
     LEFT JOIN LATERAL ( SELECT c.phone
           FROM ada_history.member_links l
             JOIN ada_history.customer_profiles c ON c.source_id = l.source_id AND c.ada_code::text = l.ada_code::text
          WHERE l.member_id = u.id
          ORDER BY (NULLIF(btrim(c.phone), ''::text) IS NULL), (
                CASE
                    WHEN c.ada_code::text = m.member_code::text THEN 0
                    ELSE 1
                END), c.ada_code
         LIMIT 1) a ON true
 WHERE NOT EXISTS(SELECT 1 FROM ada_history.member_merges mm WHERE mm.source_member_id=u.id)
UNION ALL
 SELECT c.directory_id AS id,
    c.name AS full_name,
    c.phone AS phone_number,
    'ADA-'::text || c.ada_code::text AS member_code,
    c.active = '1'::text AS is_active,
    c.updated_at AS created_at,
    'ada'::text AS source
   FROM ada_history.customer_profiles c
  WHERE NOT (EXISTS ( SELECT 1
           FROM ada_history.member_links l
          WHERE l.source_id = c.source_id AND l.ada_code::text = c.ada_code::text));
