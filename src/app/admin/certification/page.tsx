import { Address, Field, Notice, Panel, Stat } from '@/components/primitives';
import { formatUnits } from '@/core/money';
import { query } from '@/db/client';
import { readProgrammeTotals, readWorld } from '@/db/read';

/**
 * PRD §8 screen 14. Issuer certification.
 *
 * "ADATA programme details, certification status, and configurable programme
 * limits." The limit is shown against actual issuance so the headroom is a
 * figure rather than a claim.
 */
export default async function CertificationPage() {
  const world = await readWorld();
  const totals = await readProgrammeTotals(world);

  const issuers = await query<{
    id: string;
    name: string;
    certification_status: string;
    programme_limit_base: bigint | null;
    wallet: string;
  }>(`SELECT e.id, e.name, e.certification_status::text, e.programme_limit_base, w.address AS wallet
        FROM app.entity e JOIN app.wallet w ON w.entity_id = e.id
       WHERE e.entity_type = 'anchor'`);

  return (
    <div className="space-y-3">
      <div>
        <h1 className="text-[15px] font-semibold">Issuer certification</h1>
        <p className="text-[11.5px] text-ink-muted">
          StraitsX certifies an anchor buyer before any payable it approves can be issued or listed.
        </p>
      </div>

      {issuers.map((i) => {
        const limit = i.programme_limit_base ?? 0n;
        const used = totals.issuedFaceBase;
        const headroom = limit > used ? limit - used : 0n;
        const pct = limit > 0n ? Number((used * 100n) / limit) : 0;

        return (
          <Panel key={i.id} title={i.name}>
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
              <dl>
                <Field label="Entity type">Anchor buyer / issuer</Field>
                <Field label="Certification status">
                  <span className="rounded-[3px] border border-positive/25 bg-positive-soft px-1.5 py-0.5 text-[11px] font-medium text-positive">
                    {i.certification_status}
                  </span>
                </Field>
                <Field label="Custodial wallet">
                  <Address value={i.wallet} full />
                </Field>
                <Field label="Programme limit">
                  {limit === 0n ? 'none set' : `${formatUnits(limit as never, 2)} XUSD of face`}
                </Field>
                <Field label="Currently outstanding">{formatUnits(used, 2)} XUSD</Field>
                <Field label="Headroom">{formatUnits(headroom as never, 2)} XUSD</Field>
                <Field label="Payment terms">30 to 180 days</Field>
                <Field label="Denomination">XUSD, fixed</Field>
              </dl>

              <div className="space-y-2">
                <Stat label="Limit used" value={`${pct}%`} hint="of the programme limit" />
                <div className="h-2 overflow-hidden rounded-[2px] bg-surface-raised">
                  <div
                    className="h-full bg-accent"
                    style={{ width: `${Math.min(100, pct)}%` }}
                    aria-label={`${pct} percent of the programme limit used`}
                  />
                </div>
                <Notice tone="info">
                  Certification and limits are demo values set by the platform. They are not a
                  credit assessment and carry no guarantee.
                </Notice>
              </div>
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
