const { Pool } = require('pg');

const {
  listShopeeAccountingCycleSummaries,
} = require('../src/modules/seamless/processingRecords');

const connectionString = process.env.SC_OFFICIAL_SUPABASE_DATABASE_URL || '';
const runPostgresSmoke = process.env.SEAMLESS_MIGRATION_SMOKE === '1';
const describePostgres = runPostgresSmoke ? describe : describe.skip;

function assertEphemeralDatabase() {
  const schemaName = String(process.env.SEAMLESS_DB_SCHEMA || '').trim();
  if (!/_ci$/u.test(schemaName)) {
    throw new Error(`PostgreSQL integration schema must end in _ci: ${schemaName || '(missing)'}`);
  }

  if (!connectionString) {
    throw new Error('SC_OFFICIAL_SUPABASE_DATABASE_URL is required for PostgreSQL integration.');
  }

  const hostname = new URL(connectionString).hostname;
  if (!new Set(['127.0.0.1', 'localhost', '::1']).has(hostname)) {
    throw new Error(`PostgreSQL integration database must be local, received host: ${hostname}`);
  }

  return schemaName;
}

describePostgres('Shopee accounting-cycle PostgreSQL integration', () => {
  let pool;
  let client;
  let processingRecordsTable;

  beforeAll(async () => {
    const schemaName = assertEphemeralDatabase();
    processingRecordsTable = `"${schemaName}"."processing_records"`;
    pool = new Pool({ connectionString, ssl: false });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`TRUNCATE TABLE ${processingRecordsTable} CASCADE`);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      client.release();
    }
    if (pool) await pool.end();
  });

  async function insertRecord({ filename, reportType = 'shopee', metadata }) {
    await client.query(
      `
        INSERT INTO ${processingRecordsTable} (
          report_date_key, report_type, filename, metadata
        ) VALUES ('20260726', $1, $2, $3::jsonb)
      `,
      [reportType, filename, JSON.stringify(metadata)],
    );
  }

  test('executes the distinct summary query against migrated PostgreSQL tables', async () => {
    const completedSummary = {
      periodStart: '2026-06-29',
      periodEnd: '2026-07-26',
      finalRows: 46,
      rowCount: 58,
      checkpointEligible: true,
      cycleClosureStatus: 'ready_with_rows',
    };
    const emptySummary = {
      periodStart: '2026-07-27',
      periodEnd: '2026-08-23',
      finalRows: 0,
      rowCount: 12,
      checkpointEligible: false,
      cycleClosureStatus: 'review_required_empty',
    };

    await insertRecord({
      filename: 'cycle-july-a.xlsx',
      metadata: { source: 'upload', transformSummary: completedSummary },
    });
    await insertRecord({
      filename: 'cycle-july-duplicate.xlsx',
      metadata: { source: 'upload', transformSummary: completedSummary },
    });
    await insertRecord({
      filename: 'cycle-august-empty.xlsx',
      metadata: { source: 'upload', transformSummary: emptySummary },
    });
    await insertRecord({
      filename: 'pharmcare-shaped-record.xlsx',
      metadata: { source: 'pharmcare', transformSummary: completedSummary },
    });
    await insertRecord({
      filename: 'individual-shaped-record.xlsx',
      reportType: 'individual',
      metadata: { source: 'upload', transformSummary: completedSummary },
    });
    await insertRecord({
      filename: 'missing-cycle-boundaries.xlsx',
      metadata: { source: 'upload', transformSummary: { finalRows: 99 } },
    });

    const summaries = await listShopeeAccountingCycleSummaries(client);

    expect(summaries.sort((left, right) => left.periodStart.localeCompare(right.periodStart))).toEqual([
      {
        periodStart: '2026-06-29',
        periodEnd: '2026-07-26',
        finalRows: '46',
        rowCount: '58',
        checkpointEligible: 'true',
        cycleClosureStatus: 'ready_with_rows',
      },
      {
        periodStart: '2026-07-27',
        periodEnd: '2026-08-23',
        finalRows: '0',
        rowCount: '12',
        checkpointEligible: 'false',
        cycleClosureStatus: 'review_required_empty',
      },
    ]);
  });
});
