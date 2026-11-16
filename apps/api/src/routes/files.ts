import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB per file (JSON body limit is 10MB)

/**
 * File storage for file/audio custom fields and attachments.
 * Upload: JSON { name, mime, dataBase64 } -> { id, name, mime, size }.
 * Download: GET /:id streams with correct content-type (auth + RLS enforced).
 * Stored in Postgres for zero-config production; swap to S3 later without API changes.
 */
export const filesRouter = Router();

filesRouter.post('/', async (req, res) => {
  try {
    const { name, mime, dataBase64 } = req.body || {};
    if (!name || !mime || !dataBase64) throw err(400, 'MISSING_FIELDS', 'name, mime, dataBase64 required');
    let buf: Buffer;
    try { buf = Buffer.from(dataBase64, 'base64'); } catch { throw err(400, 'INVALID_FILE', 'dataBase64 is not valid base64'); }
    if (!buf.length) throw err(400, 'INVALID_FILE', 'Empty file');
    if (buf.length > MAX_FILE_BYTES) throw err(413, 'FILE_TOO_LARGE', `Max file size is ${MAX_FILE_BYTES / 1024 / 1024}MB`);
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(
        `INSERT INTO files (tenant_id, name, mime, size_bytes, data, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, mime, size_bytes, created_at`,
        [req.auth!.tenantId, String(name).slice(0, 255), String(mime).slice(0, 100), buf.length, buf, req.auth!.userId])).rows[0]);
    res.status(201).json(row);
  } catch (e) { sendError(res, e); }
});

filesRouter.get('/:id', async (req, res) => {
  try {
    const row = await withTenant(req.auth!.tenantId, async c =>
      (await c.query(`SELECT name, mime, data FROM files WHERE id=$1`, [req.params.id])).rows[0]);
    if (!row) throw err(404, 'NOT_FOUND', 'File not found');
    res.setHeader('content-type', row.mime);
    res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(row.name)}"`);
    res.send(row.data);
  } catch (e) { sendError(res, e); }
});

filesRouter.delete('/:id', async (req, res) => {
  try {
    await withTenant(req.auth!.tenantId, async c => {
      const r = await c.query(`DELETE FROM files WHERE id=$1 RETURNING id`, [req.params.id]);
      if (!r.rowCount) throw err(404, 'NOT_FOUND', 'File not found');
    });
    res.status(204).send();
  } catch (e) { sendError(res, e); }
});
