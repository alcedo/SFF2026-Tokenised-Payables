import Link from 'next/link';

import { IssuerControls } from './IssuerControls';
import { Address, Field, Notice, Panel, Stat } from '@/components/primitives';
import { currentPersona } from '@/app/session';
import { formatUnits } from '@/core/money';
import { query } from '@/db/client';
import { readProgrammeTotals, readWorld } from '@/db/read';

/**
 * PRD §8 screen 14. Issuer certification.
 *
 * "ADATA programme details, certification status, and configurable programme
 * limits." The limit is shown against actual issuance so the headroom is a
 * figure rather than a claim — and both the limit and the certification status
 * are enforced when a payable is issued, so configuring them changes what the
 * programme can do rather than what this page reports.
 *
 * The controls are the StraitsX admin's alone (PRD §5). Everyone else sees the
 * same figures, read-only, because the programme's standing is worth showing to
 * a supplier or a lender even though it is not theirs to change.
 */
export default async function CertificationPage() {
  const [world, persona] = await Promise.all([readWorld(), currentPersona()]);
  const totals = await readProgrammeTotals(world);
  const isAdmin = persona.role === 'straitsx_admin';

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
          {isAdmin ? (
            <>
              {' '}
              To grade and certify a payable, open{' '}
              <Link href="/admin/grading" className="text-accent hover:underline">
                Grading
              </Link>
              .
            </>
          ) : null}
        </p>
      </div>

      {issuers.map((i) => {
        // A cleared limit is uncapped, which is not the same as a limit of
        // zero. Treating null as 0n would report no headroom on a programme
        // that has no cap at all.
        const limit = i.programme_limit_base;
        const used = totals.issuedFaceBase;
        const headroom = limit === null ? null : limit > used ? limit - used : 0n;
        const pct = limit !== null && limit > 0n ? Number((used * 100n) / limit) : 0;

        return (
          <Panel key={i.id} title={i.name}>
            <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_320px]">
              <dl>
                <Field label="Entity type">Anchor buyer / issuer</Field>
                <Field label="Certification status">
                  {/* The status is now changeable, so the chip has to be able
                      to say something other than good news. */}
                  <span
                    className={`rounded-[3px] border px-1.5 py-0.5 text-[11px] font-medium ${
                      i.certification_status === 'certified'
                        ? 'border-positive/25 bg-positive-soft text-positive'
                        : i.certification_status === 'suspended'
                          ? 'border-critical/30 bg-critical-soft text-critical'
                          : 'border-rule-strong bg-surface-raised text-ink-muted'
                    }`}
                  >
                    {i.certification_status}
                  </span>
                </Field>
                <Field label="Custodial wallet">
                  <Address value={i.wallet} full />
                </Field>
                <Field label="Programme limit">
                  {limit === null ? 'none set, issuance uncapped' : `${formatUnits(limit as never, 2)} XUSD of face`}
                </Field>
                <Field label="Currently outstanding">{formatUnits(used, 2)} XUSD</Field>
                <Field label="Headroom">
                  {headroom === null ? '—' : `${formatUnits(headroom as never, 2)} XUSD`}
                </Field>
                <Field label="Payment terms">30 to 180 days</Field>
                <Field label="Denomination">XUSD, fixed</Field>
              </dl>

              <div className="space-y-2">
                <Stat
                  label="Limit used"
                  value={limit === null ? '—' : `${pct}%`}
                  hint={limit === null ? 'no limit set' : 'of the programme limit'}
                />
                {/* Decorative: the Stat above already announces the figure,
                    and labelling the bar as well made it a second element
                    answering to "programme limit". */}
                <div className="h-2 overflow-hidden rounded-[2px] bg-surface-raised" aria-hidden>
                  <div className="h-full bg-accent" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <Notice tone="info">
                  Certification and limits are demo values set by the platform. They are not a
                  credit assessment and carry no guarantee.
                </Notice>
              </div>
            </div>

            {isAdmin ? (
              <IssuerControls
                entityId={i.id}
                name={i.name}
                status={i.certification_status}
                limitBase={i.programme_limit_base === null ? null : i.programme_limit_base.toString()}
                outstandingBase={used.toString()}
              />
            ) : null}
          </Panel>
        );
      })}
    </div>
  );
}
