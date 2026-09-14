# Issue a payable

Issue a payable takes an approved ADATA invoice from draft to a token in the supplier's wallet. The ADATA preparer creates it from the ERP register or by hand, a different ADATA person approves it, StraitsX grades and certifies it, and StraitsX issues the full face to the supplier. The programme limit is enforced at issuance, not displayed.

## Sub-features

- `issue-erp` creates a draft from a seeded ERP invoice.
- `issue-manual` creates a draft by hand for an invoice the ERP does not have, and refuses a duplicate.
- `issue-submit` moves the draft to pending approval.
- `issue-approve` lets the checker, not the preparer, approve.
- `issue-grade` assigns a sample grade with a rationale.
- `issue-certify` certifies the payable under the programme.
- `issue-limit` refuses issuance over the programme limit and allows it once raised.
- `issue-mint` issues the full face to the supplier wallet, with a chain receipt.

## How to get to it (user POV)

- As the ADATA preparer, choose `Create payable` in the ADATA navigation, or open `/adata/create`.
- Choose `Manual entry` on that screen, or open `/adata/create?mode=manual`.
- Every later step lives on `Approval queue`, `/adata/approvals`, as the preparer, the checker and then the admin.
- Grading is on the admin's `Grading` screen, `/admin/grading`. The programme limit is on `Issuer certification`, `/admin/certification`.

## Driving it with drive.mjs

Preconditions:

- Fresh seed at T0. The approval queue reads `Nothing awaiting approval` and grading reads `Everything is graded`.
- ERP document `5100084412` is in the register: 250,000 XUSD on 90-day terms to Chien Yu Precision, the active supplier.
- ADATA's programme limit is 25,000,000 XUSD.

- **Pick the ERP invoice.** As the preparer, open the register and select the document. Run `node scripts/drive.mjs --run issue-erp --as "Wei-Ling Chen" --go /adata/create --radio 5100084412 --expect "250,000.0000 XUSD" --shot erp-picked`. The preview shows `Face value` 250,000.0000 XUSD, `Payment terms` 90 days, and a `New reference`.
- **Create the draft.** Continue with `--click "Create payable" --go /adata/approvals --grab REF=TP-2026-\d{4} --expect Draft --shot draft`. The queue lists the new reference as a draft with a `Submit for approval` button.
- **Submit.** Continue with `--click "Submit for approval" --go /adata/approvals --in "{REF}" --expect "Pending approval" --disabled Approve --shot preparer-cannot-approve`. The badge reads pending approval, and the `Approve` button is shown to the preparer who submitted but disabled. That refusal is the maker-checker rule.
- **Approve as a different person.** Continue with `--as "Hsu Po-Chun" --go /adata/approvals --in "{REF}" --shot approval-queue --click Approve --in "" --go /adata/approvals --in "{REF}" --expect Approved`. The badge reads approved and the actor history gains an `approved` line by the checker.
- **Grade.** Continue with `--as "Nadia Rahman" --go /admin/grading --in "{REF}" --click "Assign grade" --in "" --expect "Everything is graded"`. The rationale textbox is labelled `Grade rationale for {REF}`; fill it with `--fill "Grade rationale for {REF}=Sample rationale"` before the click to prove the text lands on the lender's detail screen later.
- **Certify.** Continue with `--go /adata/approvals --in "{REF}" --click Certify --expect Certified`.
- **Refuse over the limit.** Continue with `--go /admin/certification --fill "Programme limit=1000000" --expect "below the" --shot limit-warning --click "Set limit" --go /adata/approvals --in "{REF}" --click "Issue to supplier" --expect "over its programme limit" --shot issue-refused`. The refusal is a notice on the button, and the payable stays certified.
- **Raise it back and issue.** Continue with `--go /admin/certification --fill "Programme limit=25000000" --click "Set limit" --go /adata/approvals --in "{REF}" --click "Issue to supplier" --in "" --go /adata/approvals --absent "Issue to supplier"`. The payable leaves the queue.
- **Manual entry.** As the preparer, run `node scripts/drive.mjs --run issue-manual --as "Wei-Ling Chen" --go "/adata/create?mode=manual" --fill "Invoice reference=INV-TW-BYHAND-01" --fill "Invoice face=412500" --fill "Payment terms=45" --expect "412,500.0000 XUSD" --shot manual-preview --click "Create payable" --expect "Done." --go /adata/approvals --grab REF=TP-2026-\d{4} --in "{REF}" --expect INV-TW-BYHAND-01 --expect Draft --expect "not yet graded"`. It lands in the same queue as an imported one, as a draft with no grade. Creation is an audit event and shows no chain receipt.
- **Refuse a duplicate.** Continue with `--go "/adata/create?mode=manual" --fill "Invoice reference=INV-TW-BYHAND-01" --fill "Invoice face=412500" --fill "Payment terms=45" --click "Create payable" --expect "already been financed for this supplier"`.
- **Proof.** Run `node scripts/drive.mjs --run issue-proof --as "Tang Mei-Hua" --go /supplier --in "{REF}" --expect "Awaiting your acceptance" --shot supplier-inbox --go /explorer --in "Transaction log" --expect issuance --in "" --expect Balanced --shot explorer`, writing the captured reference in place of `{REF}`. The supplier's inbox holds the payable, the explorer shows an `issuance` row for it by Nadia Rahman with a simulated chain reference, and Books reads `Balanced`.

## Gotchas

- Several ERP invoices share an amount. Select by document number, never by position or by `250,000`.
- The reference is assigned by the system. Grab it from the approval queue right after creation; the marketplace later sorts by yield, so "the newest" is not a position.
- `--grab` values only carry within one `drive.mjs` invocation. Across invocations, paste the reference in.
- The programme-limit warning `below the` appears as you type, before `Set limit`. Lowering the limit under outstanding face is allowed; only the next issuance is refused.
- After `Issue to supplier` the queue re-renders and the row disappears. Prove issuance from the supplier's inbox and the explorer, not from a notice.
- The approval and grading screens list the payable by reference inside a section. Scope with `--in "{REF}"` before clicking, or the first button on the page is the one pressed.
- Scope by the payable reference, never by the invoice reference. `--in INV-TW-BYHAND-01` matches the one-line `Invoice` fact row, which holds no badge and no button.
- The `Approve` button is present but disabled for the preparer. `--absent Approve` fails because the word is on the page; `--disabled Approve` is the right assertion.
- Manual entry leaves a draft behind. Reset the world before a run that expects an empty queue.
