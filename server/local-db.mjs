// "Developer mode" DB client — identical to admin-dashboard-andrejkatin's own local-db.mjs (see
// its header comment for the full rationale) — duplicated per this project's established
// cross-repo convention (no shared package between these two repos anywhere else either).
// A drop-in stand-in for @neondatabase/serverless's neon() when DB_MODE=local. This repo's own
// server.mjs uses the tagged-template shape everywhere except server/tokens/issueSurveyLinks.mjs,
// which uses sql.query(text, params) once — both are supported here.
import pg from 'pg';

export function createLocalSql(connectionString) {
  const pool = new pg.Pool({ connectionString });

  async function sql(strings, ...values) {
    let text = strings[0];
    for (let i = 0; i < values.length; i++) text += `$${i + 1}` + strings[i + 1];
    const result = await pool.query(text, values);
    return result.rows;
  }
  sql.query = async (text, params = []) => (await pool.query(text, params)).rows;
  return sql;
}
