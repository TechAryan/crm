import { Router } from 'express';
import { parse } from 'csv-parse/sync';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { requireScope } from '../auth.js';
import { captureLead } from '../services.js';

export const importsRouter = Router();

// Body: { csv: "raw csv text", fieldMap: {"Name":"firstName","Email":"email","City":"fields.mx_city"}, dedupeMode: "update"|"skip"|"create" }
importsRouter.post('/leads', requireScope('leads:write'), async (req, res) => {
  try {
    if (!req.auth!.perms.lead.import) throw err(403, 'FORBIDDEN', 'No permission to import leads');
    const { csv, fieldMap, dedupeMode = 'update' } = req.body || {};
    if (!csv || !fieldMap) throw err(400, 'MISSING_FIELDS', 'csv, fieldMap required');
    let records: any[];
    try { records = parse(csv, { columns: true, skip_empty_lines: true, trim: true }); }
    catch { throw err(400, 'INVALID_CSV', 'Could not parse CSV'); }

    const job = await withTenant(req.auth!.tenantId, async c => {
      const jobR = await c.query(
        `INSERT INTO import_jobs (tenant_id, filename, total_rows, dedupe_mode, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.auth!.tenantId, 'upload.csv', records.length, dedupeMode, req.auth!.userId]);
      let job = jobR.rows[0];
      let created = 0, updated = 0, errorCount = 0;
      const errors: any[] = [];
      for (let i = 0; i < records.length; i++) {
        const row = records[i];
        const payload: any = { fields: {} };
        for (const [col, dest] of Object.entries(fieldMap) as [string, string][]) {
          const val = row[col];
          if (val === undefined || val === '') continue;
          if (dest.startsWith('fields.')) payload.fields[dest.slice(7)] = val;
          else payload[dest] = val;
        }
        payload.updateBehavior = dedupeMode === 'skip' ? 'doNotUpdate' : dedupeMode === 'update' ? 'update' : undefined;
        payload.source = payload.source || 'Bulk Import';
        try {
          const out = await captureLead(c, req.auth!.tenantId, payload, { id: req.auth!.userId, type: 'user' });
          if (out.isCreated) created++; else updated++;
        } catch (e: any) {
          errorCount++;
          errors.push({ row: i + 2, error: e?.message || 'Unknown error' });
        }
      }
      const done = await c.query(
        `UPDATE import_jobs SET status='done', created_count=$2, updated_count=$3, error_count=$4, errors=$5 WHERE id=$1 RETURNING *`,
        [job.id, created, updated, errorCount, JSON.stringify(errors)]);
      return done.rows[0];
    });
    res.status(201).json(job);
  } catch (e) { sendError(res, e); }
});

importsRouter.get('/:id', requireScope('leads:read'), async (req, res) => {
  try {
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT * FROM import_jobs WHERE id=$1`, [req.params.id])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'Import job not found');
    res.json(row);
  } catch (e) { sendError(res, e); }
});
