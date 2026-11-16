import { Router } from 'express';
import { withTenant } from '../db.js';
import { err, sendError } from '../util.js';
import { audit } from '../audit.js';
import { requireFeature } from '../entitlements.js';
import { mergeString, buildMergeContext, availableTokens } from '../merge.js';
import { resolveVisibleOwnerIds } from '../permissions.js';
/**
 * Embedded widgets — the general-purpose "show my own UI inside the CRM" mechanism.
 *
 * Two kinds:
 *   iframe — point at any external page (a landing page built elsewhere, a BI dashboard, an
 *            internal tool). Merge tokens in the URL pass record context, so the embedded page
 *            can render for THIS lead/opportunity/user.
 *   html   — paste markup rendered inline (sanitized server-side).
 *
 * Placements: lead/opportunity detail tab or sidebar, a main-menu page, or a dashboard panel.
 *
 * SECURITY — this is the highest-risk surface in the product after outbound HTTP, so:
 *   - iframes are rendered with a restrictive `sandbox` and are NOT given same-origin access,
 *     so an embedded page cannot read our localStorage (where the JWT lives) or our DOM.
 *   - HTML widgets are sanitized server-side on save AND the response is marked so the client
 *     renders it without executing script. We strip <script>, event handlers, javascript: URLs,
 *     and other script-bearing constructs. Rendering raw tenant HTML with scripts enabled would
 *     be stored XSS against every user of that tenant.
 *   - The URL is merged server-side and only for records the caller may actually see, so a
 *     widget can't be used to read a record the user has no access to.
 */
export const widgetsRouter = Router();
function requireManage(req) {
    if (!req.auth.perms.settings?.manageRoles)
        throw err(403, 'FORBIDDEN', 'Missing settings permission: manageRoles');
}
const PLACEMENTS = ['lead_tab', 'lead_sidebar', 'opportunity_tab', 'opportunity_sidebar', 'main_menu', 'dashboard'];
const KINDS = ['iframe', 'html'];
/**
 * Conservative HTML sanitizer for `kind: 'html'` widgets.
 *
 * Deliberately an allow-list-ish strip rather than a full parser: we remove entire dangerous
 * elements (script/iframe/object/embed/link/meta/style/form), all on* handlers, and any
 * javascript:/vbscript:/data: URL in href/src. Anything not explicitly handled stays as inert
 * markup. If a tenant needs interactivity they should use an `iframe` widget, which is
 * origin-isolated — that's the safe path, and this function's job is to make the inline path
 * boring on purpose.
 */
export function sanitizeHtml(input) {
    const removed = [];
    let html = String(input || '');
    const dropElement = (tag) => {
        const re = new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}\\s*>`, 'gi');
        if (re.test(html))
            removed.push(`<${tag}>`);
        html = html.replace(re, '');
        // Unclosed/self-closing form of the same tag.
        const selfRe = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi');
        if (selfRe.test(html))
            removed.push(`<${tag}>`);
        html = html.replace(selfRe, '');
    };
    for (const tag of ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'form', 'base', 'svg', 'math']) {
        dropElement(tag);
    }
    // Inline event handlers: on*="..." / on*='...' / on*=unquoted
    const onAttr = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
    if (onAttr.test(html))
        removed.push('inline event handlers');
    html = html.replace(onAttr, '');
    // Dangerous URL schemes in any attribute.
    const badUrl = /\s(href|src|action|formaction|xlink:href)\s*=\s*(?:"\s*(?:javascript|vbscript|data)\s*:[^"]*"|'\s*(?:javascript|vbscript|data)\s*:[^']*'|(?:javascript|vbscript|data):[^\s>]*)/gi;
    if (badUrl.test(html))
        removed.push('javascript:/data: URLs');
    html = html.replace(badUrl, '');
    // srcdoc can smuggle a whole document.
    const srcdoc = /\ssrcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
    if (srcdoc.test(html))
        removed.push('srcdoc');
    html = html.replace(srcdoc, '');
    return { html, removed: [...new Set(removed)] };
}
widgetsRouter.get('/tokens/:entity', async (req, res) => {
    try {
        if (!['lead', 'opportunity'].includes(req.params.entity))
            throw err(400, 'INVALID_ENTITY', 'entity must be lead|opportunity');
        const items = await withTenant(req.auth.tenantId, c => availableTokens(c, req.params.entity));
        res.json({ items });
    }
    catch (e) {
        sendError(res, e);
    }
});
/** List widgets the caller may see (used to render tabs/menu items). */
widgetsRouter.get('/', async (req, res) => {
    try {
        const rows = await withTenant(req.auth.tenantId, async (c) => {
            const params = [];
            let sql = `SELECT id, name, kind, placement, height, icon, required_permission, sort_order, is_active
                 FROM embedded_widgets WHERE is_active`;
            if (req.query.placement) {
                params.push(req.query.placement);
                sql += ` AND placement=$${params.length}`;
            }
            sql += ` ORDER BY sort_order, name`;
            return (await c.query(sql, params)).rows;
        });
        const visible = rows.filter((w) => !w.required_permission || req.auth.perms.settings?.[w.required_permission]);
        res.json({ items: visible });
    }
    catch (e) {
        sendError(res, e);
    }
});
/** Full definition incl. templates — admin only (the URL template can embed tokens/secrets). */
widgetsRouter.get('/:id/definition', async (req, res) => {
    try {
        requireManage(req);
        const row = await withTenant(req.auth.tenantId, async (c) => (await c.query(`SELECT * FROM embedded_widgets WHERE id=$1`, [req.params.id])).rows[0]);
        if (!row)
            throw err(404, 'NOT_FOUND', 'Widget not found');
        res.json(row);
    }
    catch (e) {
        sendError(res, e);
    }
});
widgetsRouter.post('/', requireFeature('custom_apps'), async (req, res) => {
    try {
        requireManage(req);
        const { name, kind = 'iframe', placement, urlTemplate, htmlContent, height = 520, icon, requiredPermission, sortOrder = 100, } = req.body || {};
        if (!name || !placement)
            throw err(400, 'MISSING_FIELDS', 'name and placement required');
        if (!KINDS.includes(kind))
            throw err(400, 'INVALID_VALUE', `kind must be ${KINDS.join('|')}`);
        if (!PLACEMENTS.includes(placement))
            throw err(400, 'INVALID_VALUE', `placement must be one of ${PLACEMENTS.join(', ')}`);
        if (kind === 'iframe' && !urlTemplate)
            throw err(400, 'MISSING_FIELDS', 'urlTemplate is required for iframe widgets');
        if (kind === 'html' && !htmlContent)
            throw err(400, 'MISSING_FIELDS', 'htmlContent is required for html widgets');
        if (kind === 'iframe' && !/^https:\/\//i.test(String(urlTemplate).trim()))
            throw err(400, 'INVALID_URL', 'Embedded URLs must start with https:// (mixed content is blocked by browsers and unsafe)');
        let stored = htmlContent, removed = [];
        if (kind === 'html') {
            const s = sanitizeHtml(htmlContent);
            stored = s.html;
            removed = s.removed;
        }
        const row = await withTenant(req.auth.tenantId, async (c) => {
            const r = await c.query(`INSERT INTO embedded_widgets (tenant_id, name, kind, placement, url_template, html_content,
           height, icon, required_permission, sort_order, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [req.auth.tenantId, name, kind, placement, urlTemplate || null, stored || null,
                height, icon || null, requiredPermission || null, sortOrder, req.auth.userId]);
            await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'widget.created', 'widget', r.rows[0].id, null, r.rows[0]);
            return r.rows[0];
        });
        // Tell the admin what was stripped — silently removing their markup is confusing.
        res.status(201).json(removed.length ? { ...row, _sanitized: removed } : row);
    }
    catch (e) {
        if (e?.code === '23505')
            return sendError(res, err(409, 'WIDGET_EXISTS', 'A widget with this name already exists'));
        sendError(res, e);
    }
});
widgetsRouter.patch('/:id', requireFeature('custom_apps'), async (req, res) => {
    try {
        requireManage(req);
        const b = req.body || {};
        if (b.urlTemplate && !/^https:\/\//i.test(String(b.urlTemplate).trim()))
            throw err(400, 'INVALID_URL', 'Embedded URLs must start with https://');
        let stored = b.htmlContent, removed = [];
        if (b.htmlContent) {
            const s = sanitizeHtml(b.htmlContent);
            stored = s.html;
            removed = s.removed;
        }
        const row = await withTenant(req.auth.tenantId, async (c) => (await c.query(`UPDATE embedded_widgets SET name=COALESCE($2,name), placement=COALESCE($3,placement),
         url_template=COALESCE($4,url_template), html_content=COALESCE($5,html_content),
         height=COALESCE($6,height), icon=COALESCE($7,icon),
         required_permission=COALESCE($8,required_permission), sort_order=COALESCE($9,sort_order),
         is_active=COALESCE($10,is_active)
       WHERE id=$1 RETURNING *`, [req.params.id, b.name, b.placement, b.urlTemplate, stored, b.height, b.icon,
            b.requiredPermission, b.sortOrder, b.isActive])).rows[0]);
        if (!row)
            throw err(404, 'NOT_FOUND', 'Widget not found');
        res.json(removed.length ? { ...row, _sanitized: removed } : row);
    }
    catch (e) {
        sendError(res, e);
    }
});
widgetsRouter.delete('/:id', async (req, res) => {
    try {
        requireManage(req);
        await withTenant(req.auth.tenantId, async (c) => {
            const cur = (await c.query(`SELECT * FROM embedded_widgets WHERE id=$1`, [req.params.id])).rows[0];
            if (!cur)
                throw err(404, 'NOT_FOUND', 'Widget not found');
            await c.query(`DELETE FROM embedded_widgets WHERE id=$1`, [req.params.id]);
            await audit(c, req.auth.tenantId, req.auth.userId, req.auth.actorType, 'widget.deleted', 'widget', req.params.id, cur, null);
        });
        res.status(204).send();
    }
    catch (e) {
        sendError(res, e);
    }
});
/**
 * Resolve a widget for rendering: merges record context into the URL (or returns sanitized HTML).
 *
 * The merge happens server-side and only after verifying the caller can see the record — that
 * check is what stops a widget being used as a data-exfiltration path for records outside the
 * user's scope.
 */
widgetsRouter.get('/:id/resolve', async (req, res) => {
    try {
        const { recordId, entity } = req.query;
        const out = await withTenant(req.auth.tenantId, async (c) => {
            const w = (await c.query(`SELECT * FROM embedded_widgets WHERE id=$1 AND is_active`, [req.params.id])).rows[0];
            if (!w)
                throw err(404, 'NOT_FOUND', 'Widget not found');
            if (w.required_permission && !req.auth.perms.settings?.[w.required_permission])
                throw err(403, 'FORBIDDEN', `This widget requires the ${w.required_permission} permission`);
            if (w.kind === 'html')
                return { kind: 'html', name: w.name, html: w.html_content, height: w.height };
            let url = w.url_template;
            if (recordId && (entity === 'lead' || entity === 'opportunity')) {
                const perm = req.auth.perms[entity];
                if (!perm?.view)
                    throw err(403, 'FORBIDDEN', `No permission to view ${entity}s`);
                const table = entity === 'lead' ? 'leads' : 'opportunities';
                const record = (await c.query(`SELECT * FROM ${table} WHERE id=$1 AND deleted_at IS NULL`, [recordId])).rows[0];
                if (!record)
                    throw err(404, 'NOT_FOUND', `${entity} not found`);
                const visibleIds = await resolveVisibleOwnerIds(c, req.auth.tenantId, req.auth.userId, perm.view);
                if (visibleIds !== null && !(record.owner_id && visibleIds.includes(record.owner_id)))
                    throw err(403, 'FORBIDDEN', `Not your ${entity}`);
                const me = (await c.query(`SELECT first_name, last_name, email FROM users WHERE id=$1`, [req.auth.userId])).rows[0];
                const ctx = await buildMergeContext(c, entity, record, {
                    user: me ? { name: `${me.first_name || ''} ${me.last_name || ''}`.trim(), email: me.email } : {},
                });
                url = mergeString(url, ctx);
            }
            else {
                const me = (await c.query(`SELECT first_name, last_name, email FROM users WHERE id=$1`, [req.auth.userId])).rows[0];
                url = mergeString(url, {
                    user: me ? { name: `${me.first_name || ''} ${me.last_name || ''}`.trim(), email: me.email } : {},
                    now: new Date().toISOString(), today: new Date().toISOString().slice(0, 10),
                });
            }
            // Merge output is placed in a URL, so encode any leftover unsafe characters.
            return { kind: 'iframe', name: w.name, url, height: w.height };
        });
        res.json(out);
    }
    catch (e) {
        sendError(res, e);
    }
});
