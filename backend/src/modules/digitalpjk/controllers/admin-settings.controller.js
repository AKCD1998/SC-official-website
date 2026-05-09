import { pool } from "../db/pool.js";
import {
  buildDocumentDateFromSettings,
  getGlobalSettingsRow,
  mapGlobalSettings,
  normalizeForcedDateInput,
} from "../services/document-date.service.js";

function parseSettingsPayload(body) {
  const useSystemDate = body?.useSystemDate;
  const forcedDateRaw = body?.forcedDate;

  if (typeof useSystemDate !== "boolean") {
    return {
      error: "useSystemDate must be a boolean.",
    };
  }

  const normalizedForcedDate = normalizeForcedDateInput(forcedDateRaw);

  if (!useSystemDate && !normalizedForcedDate) {
    return {
      error:
        "forcedDate must be a valid YYYY-MM-DD value when useSystemDate is false.",
    };
  }

  return {
    useSystemDate,
    forcedDate: useSystemDate ? null : normalizedForcedDate,
  };
}

export async function getAdminSettings(_req, res, next) {
  try {
    const settingsRow = await getGlobalSettingsRow();

    return res.status(200).json({
      settings: mapGlobalSettings(settingsRow),
      documentDate: buildDocumentDateFromSettings(settingsRow),
    });
  } catch (error) {
    return next(error);
  }
}

export async function updateAdminSettings(req, res, next) {
  const parsed = parseSettingsPayload(req.body);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `
      INSERT INTO global_settings (
        id,
        use_system_date,
        forced_date,
        updated_by
      )
      VALUES (1, $1, $2, $3)
      ON CONFLICT (id) DO UPDATE
      SET
        use_system_date = EXCLUDED.use_system_date,
        forced_date = EXCLUDED.forced_date,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
      RETURNING
        id,
        use_system_date,
        forced_date,
        updated_by,
        updated_at;
      `,
      [parsed.useSystemDate, parsed.forcedDate, req.auth.userId]
    );

    await client.query("COMMIT");

    const settingsRow = result.rows[0];
    return res.status(200).json({
      settings: mapGlobalSettings(settingsRow),
      documentDate: buildDocumentDateFromSettings(settingsRow),
    });
  } catch (error) {
    await client.query("ROLLBACK");
    return next(error);
  } finally {
    client.release();
  }
}
