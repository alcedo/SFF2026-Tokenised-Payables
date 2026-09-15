import { describe, it, beforeAll, afterAll } from 'vitest';
import { freshDatabase, post, ledgerHealth, type Database } from '../support/database';

const out = (s: string) => process.stdout.write(s + '\n');

let d: Database;
beforeAll(async () => { d = await freshDatabase('eb_probe', 'fixtures'); });
afterAll(async () => { await d.close(); });

const p = async (label: string, intent: Record<string, unknown>) => {
  const r = await post(d.pool, intent);
  out(label + ' => ' + (r.ok ? 'OK ' + JSON.stringify(r.receipt).slice(0, 220) : `ERR ${r.code} | ${r.message}`));
  return r;
};

describe('db probe', () => {
  it('world', async () => {
    const w = await d.pool.query('SELECT address, e.name, e.entity_type, e.id::text AS eid FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id ORDER BY e.entity_type, e.name');
    out('WALLETS ' + JSON.stringify(w.rows));
    const u = await d.pool.query('SELECT id::text, name, role FROM app.app_user ORDER BY role');
    out('USERS ' + JSON.stringify(u.rows));
    const erp = await d.pool.query('SELECT id::text, doc_no, invoice_ref, amount_base::text, terms_days FROM app.erp_invoice ORDER BY doc_no LIMIT 3');
    out('ERP ' + JSON.stringify(erp.rows));
  });

  it('top_up and simple guards', async () => {
    const w = await d.pool.query<{ address: string }>("SELECT w.address FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id WHERE e.entity_type = 'anchor'");
    const anchor = w.rows[0]!.address;
    await p('top_up -1', { kind: 'top_up', wallet: anchor, cashCode: 'USDC', amountBase: -1 });
    await p('top_up 0', { kind: 'top_up', wallet: anchor, cashCode: 'USDC', amountBase: 0 });
    await p('top_up 1', { kind: 'top_up', wallet: anchor, cashCode: 'USDC', amountBase: 1 });
    await p('top_up missing amount', { kind: 'top_up', wallet: anchor, cashCode: 'USDC' });
    await p('top_up bad cashCode', { kind: 'top_up', wallet: anchor, cashCode: 'EURC', amountBase: 5 });
    await p('unknown kind', { kind: 'teleport' });
    await p('set_cert bad status', { kind: 'set_certification', entityId: 'e0000000-0000-0000-0000-00000000ada7', status: 'pending' });
    await p('set_cert certified', { kind: 'set_certification', entityId: 'e0000000-0000-0000-0000-00000000ada7', status: 'certified' });
    await p('set_cert empty', { kind: 'set_certification', entityId: 'e0000000-0000-0000-0000-00000000ada7', status: '' });
    await p('set_cert missing', { kind: 'set_certification', entityId: 'e0000000-0000-0000-0000-00000000ada7' });
    await p('limit -1', { kind: 'set_programme_limit', entityId: 'e0000000-0000-0000-0000-00000000ada7', limitBase: -1 });
    await p('limit 0', { kind: 'set_programme_limit', entityId: 'e0000000-0000-0000-0000-00000000ada7', limitBase: 0 });
    await p('limit null', { kind: 'set_programme_limit', entityId: 'e0000000-0000-0000-0000-00000000ada7', limitBase: null });
    await p('limit restore', { kind: 'set_programme_limit', entityId: 'e0000000-0000-0000-0000-00000000ada7', limitBase: 250000000000 });
    await p('limit no entity', { kind: 'set_programme_limit', entityId: 'e0000000-0000-0000-0000-000000000099', limitBase: 5 });
    await p('advance -1', { kind: 'advance_clock', days: -1 });

    const raw = await d.pool.query<{ post: unknown }>('SELECT ledger.post($1::jsonb) AS post', [
      JSON.stringify({ actorUserId: (await d.pool.query<{ id: string }>('SELECT id::text FROM app.app_user LIMIT 1')).rows[0]!.id, intent: { kind: 'top_up', wallet: anchor, cashCode: 'USDC', amountBase: 5 } }),
    ]).catch((e) => ({ err: e as { code?: string; message?: string } }));
    out('no key => ' + JSON.stringify(raw));
    out('HEALTH ' + JSON.stringify(await ledgerHealth(d.pool)));
  });

  it('create_payable field guards', async () => {
    const sup = await d.pool.query<{ id: string; name: string }>("SELECT id::text, name FROM app.entity WHERE entity_type = 'supplier' ORDER BY name");
    out('SUPPLIERS ' + JSON.stringify(sup.rows));
    const s = sup.rows[0]!.id;
    const base = { kind: 'create_payable', supplierId: s };
    let n = 0;
    const mk = (over: Record<string, unknown>) => ({ ...base, ref: `TP-PROBE-${++n}`, invoiceRef: `IR-PROBE-${n}`, faceBase: 1000000, termsDays: 30, ...over });
    await p('terms 0', mk({ termsDays: 0 }));
    await p('terms 1', mk({ termsDays: 1 }));
    await p('terms 365', mk({ termsDays: 365 }));
    await p('terms 366', mk({ termsDays: 366 }));
    await p('terms -1', mk({ termsDays: -1 }));
    await p('terms missing', mk({ termsDays: undefined }));
    await p('terms 30.7', mk({ termsDays: 30.7 }));
    await p('face -1', mk({ faceBase: -1 }));
    await p('face 0', mk({ faceBase: 0 }));
    await p('face 1', mk({ faceBase: 1 }));
    await p('face missing', mk({ faceBase: undefined }));
    await p('ref empty invoice', mk({ invoiceRef: '' }));
    await p('ref blank invoice', mk({ invoiceRef: '   ' }));
    await p('ref tab invoice', mk({ invoiceRef: '\t\n ' }));
    await p('invoice padded', mk({ invoiceRef: '  IR-PAD  ' }));
    await p('no such supplier', mk({ supplierId: 'e0000000-0000-0000-0000-000000000099' }));
    await p('dup invoice', mk({ invoiceRef: 'IR-PAD' }));
    await p('missing ref', mk({ ref: undefined }));
    out('HEALTH ' + JSON.stringify(await ledgerHealth(d.pool)));
  });

  it('issued payable for transfer boundary', async () => {
    const sup = await d.pool.query<{ id: string }>("SELECT id::text FROM app.entity WHERE entity_type = 'supplier' ORDER BY name LIMIT 1");
    const wal = await d.pool.query<{ address: string; entity_type: string }>('SELECT w.address, e.entity_type FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id');
    const supWallet = (await d.pool.query<{ address: string }>('SELECT w.address FROM app.wallet w WHERE w.entity_id = $1', [sup.rows[0]!.id])).rows[0]!.address;
    const lenderWallet = (await d.pool.query<{ address: string }>("SELECT w.address FROM app.wallet w JOIN app.entity e ON e.id = w.entity_id WHERE e.entity_type = 'lender' ORDER BY e.name LIMIT 1")).rows[0]!.address;
    out('WAL ' + JSON.stringify(wal.rows) + ' sup=' + supWallet + ' lend=' + lenderWallet);
    const c = await p('create', { kind: 'create_payable', supplierId: sup.rows[0]!.id, ref: 'TP-XFER-1', invoiceRef: 'IR-XFER-1', faceBase: 1000000, termsDays: 60 });
    const pid = (await d.pool.query<{ id: string }>("SELECT id::text FROM app.payable WHERE ref = 'TP-XFER-1'")).rows[0]!.id;
    out('pid ' + pid + ' created ' + c.ok);
    await p('submit', { kind: 'submit', payableId: pid });
    await p('approve', { kind: 'approve', payableId: pid });
    await p('grade', { kind: 'grade', payableId: pid, grade: 'AA', gradeRationale: 'probe' });
    await p('certify', { kind: 'certify', payableId: pid });
    await p('issue', { kind: 'issue_payable', payableId: pid, toWallet: supWallet, tokenId: 90001 });
    await p('accept', { kind: 'accept_receipt', payableId: pid, holderWallet: supWallet });
    await p('transfer -1', { kind: 'transfer', payableId: pid, fromWallet: supWallet, toWallet: lenderWallet, quantityBase: -1 });
    await p('transfer 0', { kind: 'transfer', payableId: pid, fromWallet: supWallet, toWallet: lenderWallet, quantityBase: 0 });
    await p('transfer 1', { kind: 'transfer', payableId: pid, fromWallet: supWallet, toWallet: lenderWallet, quantityBase: 1 });
    await p('transfer face', { kind: 'transfer', payableId: pid, fromWallet: supWallet, toWallet: lenderWallet, quantityBase: 999999 });
    await p('transfer 1 more', { kind: 'transfer', payableId: pid, fromWallet: supWallet, toWallet: lenderWallet, quantityBase: 1 });
    out('HEALTH ' + JSON.stringify(await ledgerHealth(d.pool)));
  });
});
