# Incentives module status

**Overall: Verified for MVP — Incentives only.** This is not a claim that the full ERP is complete or that deferred accessibility checks passed.
The current-release manual-settlement authority below supersedes older dated sections that required a bank/provider confirmation source.
The explicit MVP decision defers live keyboard acceptance and the broader screen-reader audit to post-MVP. Neither was verified, and neither blocks this MVP closure. Dated checkpoint statements below retain their historical status; this decision is the current module status.

| Workstream | Status | Evidence and remaining dependency |
| --- | --- | --- |
| Service and sale commission accrual | Implemented; focused appointment, subscription, membership, and retail paths verified | Service commission requires settlement plus confirmed service fulfilment; paid-but-unfulfilled services remain visible in pending-gate reporting and do not earn. Subscription and membership sale commissions use their line seller; retail uses `soldBy` independently of cashier and requires full payment plus matching POS stock-issue evidence. Retail revenue uses the invoice line's net customer-payable amount after allocated discounts; unallocated invoice loyalty redemption fails closed. Membership refunds now have an unused-only, idempotent refund-record and clawback path; provider execution remains external. |
| Subscription cancellation, membership refund, and retail return reversals | Implemented; focused refund regressions verified | Unused paid subscription cancellation and unused membership cancellation record idempotent manual refunds and proportional commission clawbacks; membership refunds fail closed when any non-cancelled invoice, including a draft, references its benefits. Retail returns require an idempotency key, record immutable refund allocations and audit data, restock only when accepted, and proportionally claw back only actual refunded value. Processor/bank execution remains external; the app records the refund transaction and does not call a payment gateway. |
| Source attribution capture | Implemented; focused source paths verified | Billing validates selected staff against the authenticated organization and branch and snapshots performer, seller, and renewal-handler attribution. POS seller remains separate from the cashier recorded on the payment. Subscription create/renew/upsell, standalone redemption, membership checkout, product checkout, and walk-in completion use their specific attribution or fulfilment controls; no cashier fallback is used for seller commission. |
| Biometric attendance status and payroll gating | Implemented; focused persistence and incentive regressions verified; unrecorded-workday detection pending | A mapped chronological in-punch followed by an out-punch records `present`; one-sided, repeated same-direction, or out-before-in evidence remains `incomplete`. Stable event retries are idempotent and do not overwrite audited corrections. Pending/disputed cross-branch conflicts block payroll approval. The system has no staff roster/workday model, so it cannot safely treat a date with no attendance row as a missed shift. |
| Attendance/Leave incentive bonus | Implemented; biometric-to-ledger and payroll lifecycle journeys verified | The branch-local evaluation uses verified attendance, approved leave and audited exceptions, blocks incomplete/disputed evidence, snapshots source records, and finalizes an idempotent integer-paise ledger accrual. Attendance scheme configuration is available in the UI. The finalized amount is included in payroll calculation, approval, recorded payment, and explicit manual settlement confirmation. |
| Payroll incentive consumption | Verified for all supported commission source workflows through payroll allocation and authorized manual settlement | Source-workflow integration tests now prove appointment service completion, unified subscription sale, and POS retail sale each produce the eligible ledger entry, allocate it once to the proper staff/branch/payroll period, and mark it paid only after manual confirmation. The membership journey additionally covers refund, clawback, partial recovery, reversal, and full recovery. The category-wide seeded-ledger regression remains supplemental. Attendance bonuses continue through the finalized-evaluation path. |
| Payroll settlement and recovery | Manual settlement and recovery implemented; focused lifecycle verified | Payroll is not paid until an authorized user confirms actual off-system payment. Manual recovery supports partial attempts, reservations, failure/retry, duplicate idempotency, confirmation, and reversal; only confirmed receipt reduces recovered balances. Payroll and recovery transitions are auditable and branch/permission scoped. The manual-confirmation policy is the approved current-release authority; no payment-provider dependency is required. |
| Scheme administration UI/API | Implemented for supported rules; focused UI/API verified | The builder configures service, subscription-sale, membership-sale, and retail-product net-revenue commission with per-line fixed base and graduated tiers, plus biometric attendance bonus. Retail copy explains paid-invoice and stock-issue gates. Amounts are converted to integer paise; a blank tier maximum is submitted as `null`, and invalid ranges are rejected client- and server-side. Unsupported target/attendance fields on commission schemes are rejected rather than silently persisted; unsupported legacy categories remain non-assignable. |
| Tenant/branch authorization and audit | Focused payroll branch and permission regression verified | Payroll record/payment routes resolve organization from the authenticated user, require canonical payroll permissions, and enforce active authorized branch scope. Payment attempts retain actor, branch, status-transition history, and immutable request/amount snapshots. This does not verify broader production authorization or settle recovery balances. |

## Selected safe defaults and remaining dependencies

1. Keep verified attendance bonus enabled only through the audited evaluation and payroll-calculation path; keep hybrid schemes disabled.
2. Keep commission disabled for invoices with invoice-level loyalty redemption until an exact per-line allocation policy is defined.
3. Treat authorized manual confirmation, after off-system verification, as authoritative for current-release payroll settlement. Recording a reference alone, payroll generation, or approval must not set paid status. Provider integration is a future extension.
4. Do not treat recovery obligations or recorded attempts as recovered. A recovery is collectible only against a related commission confirmed paid in payroll and not already reduced before payroll; a recorded attempt only reserves capacity, while explicit authorized receipt confirmation updates recovered balances. Reversals restore the outstanding balance.
5. Enable only the implemented service, subscription-sale, membership-sale, and retail-sale categories; keep renewal/redemption, invoice-wide loyalty allocation, target, and service-count categories disabled or fail-closed until their full source and payout paths are supported.
6. Draft invoice source attribution can be corrected only through the dedicated permission-gated, reason-required endpoint; finalized invoice attribution remains immutable.
7. Subscription and membership cancellation refunds are manual accounting entries only; staff must issue the refund outside the app before confirming it. Gateway/provider processing is out of scope.

## Status definitions

- **Implemented** means the code path exists; it does not by itself establish correctness or release readiness.
- **Verified** means the named focused test/build evidence passed in the current implementation work.
- **Pending** means required implementation or verification is incomplete.
- **Blocked** means a dependency or policy decision prevents safe completion.

The verified scope above is limited to named focused regression paths. Biometric attendance evaluation → ledger accrual → payroll snapshot/payment confirmation has focused backend evidence. Actual service, subscription-sale, membership-sale, and retail-sale source workflows now have source-to-payroll settlement evidence, including the joined membership refund/recovery lifecycle. Previously recorded protected Incentives/Payroll browser checks cover branch data, ledger/recovery, payroll manual settlement, read-only permissions, and mobile/desktop overflow. Keyboard activation, dialog focus, and broader screen-reader behavior remain unverified and are explicitly deferred post-MVP. Workday completeness remains pending because staff schedules/workdays are not modeled; no absence is inferred from a missing attendance row, and only absence-dependent conclusions are affected. Dated sections below record earlier checkpoints; this decision supersedes their historical Pending status.

No protected application database or production records were queried or modified. Database-backed follow-up verification used the approved disposable test runner; it verified the application-database guard and confirmed cleanup of each generated disposable database.

## Manual subscription refund verification (2026-11-16)

- Backend upsell/refund regression: `node src/tests/runDisposableTests.js --runTestsByPath src/tests/subscriptions/subscription.billing.upsell.integration.test.js --testNamePattern="records an idempotent manual refund for an unused paid upsell without purchase commission"` — 1 passed, 20 skipped; exit 0. Covers paid upsell seller attribution, preview amount, missing-key rejection, manual refund payment creation, same-key replay, changed-method conflict, cancelled balances, and absence of unsupported accruals/clawbacks.
- Related upsell/refund, payment-void, consumed-entitlement, and payment-activation regressions: `node src/tests/runDisposableTests.js --runTestsByPath src/tests/subscriptions/subscription.billing.upsell.integration.test.js --testNamePattern="records an idempotent manual refund for an unused paid upsell without purchase commission|persists upsell seller attribution and keeps payment reversal commission-idempotent|blocks cancellation/refund if any entitlements have already been consumed|voiding a payment when invoice is no longer fully paid reverts subscription to pending_payment"` — 4 passed, 17 skipped; exit 0.
- Cancellation/payment race regressions: `node src/tests/runDisposableTests.js --runTestsByPath src/tests/subscriptions/subscription.cancellationRebilling.ruleB.test.js --testNamePattern="deterministic race: payment commits first, concurrent cancellation is rejected|deterministic race: cancellation commits first, concurrent payment is rejected"` — 2 passed, 22 skipped; exit 0.
- Frontend focused suites: `npx vitest run src/features/subscriptions/__tests__/subscription.cancel-dialog.test.tsx src/features/subscriptions/__tests__/subscription.schema.test.ts src/features/subscriptions/__tests__/subscriptions.api.test.ts` — 3 files, 42 tests passed; exit 0.
- Focused ESLint: `npx eslint src/features/subscriptions/components/CancelSubscriptionDialog.tsx src/features/subscriptions/components/SubscriptionDetailsPage.tsx src/features/subscriptions/components/SubscriptionList.tsx src/features/subscriptions/api/subscriptions.api.ts src/features/subscriptions/schemas/subscription.schema.ts` — exit 0, no reported warnings.
- Frontend production build: `npm run build` — exit 0.
- Backend `node --check` on the changed service, controller, validation, and integration test — exit 0. CRLF-aware `git diff --check` passed in both repositories.
- Disposable databases created for these runs: `incentives_test_mwj4xpt7_fa14cc5bac9c`, `incentives_test_mwj4zlq8_30d311f870eb`, `incentives_test_mwj53h0u_910231026e1c`, and `incentives_test_mwj54k6k_5a2a5960cbb2`. The runner verified each unique database, enforced the application-database guard, dropped each exact database, and verified its absence.

## Attendance, payroll, and purchase-category blocker audit (2026-11-16; initial status before follow-up)

No application code was changed during this initial audit. The subsequent attendance implementation and updated verification evidence are recorded in the follow-up section below.

### Attendance and biometric policy

- **Implemented and verified:** Provider ingestion remains authenticated and active-branch scoped; stable provider event IDs are idempotent; mapped punches create/recover the branch-local daily claim. A mapped chronological `in` followed by a later `out` derives `present`; otherwise the record remains `incomplete`. Replays repair status after partial writes, repeated same-direction events do not establish presence, and a reconciled/manual status is not overwritten. Manual changes require `attendance.adjust`, an active staff/branch link, and a reason, and retain actor/time/status history. Payroll counts `present`, `late`, and `early_departure` as one present day and blocks incomplete records plus pending/disputed cross-branch conflicts.
- **Policy boundaries:** A missing record is shown as `missing_punch` and is not counted as present. Approved leave and half-day leave exceptions are reported separately and do not create an attended day. Employee shifts/grace periods are not configured, so punch ingestion does not infer lateness; a reasoned correction may set `late` or `early_departure`, which current payroll counts as an attended day. Events without stable IDs remain separate because timestamp/payload identity is not assumed, but repeated same-direction punches cannot complete the in/out requirement. Branch conflicts must be resolved by an authorized actor while preserving the original claim.
- **Still unavailable:** Attendance/Leave bonus and hybrid Incentive schemes remain rejected by creation, activation, assignment, and calculation. There is no attendance bonus ledger or payout until the payout consumer and confirmed settlement are integrated. The eTimeOffice adapter remains blocked pending official provider documentation and authorized provider credentials.
- **Decision status:** No new lateness threshold, half-day fraction, or leave credit is invented. The currently implemented attendance-day basis follows Payroll's existing `presentDays` semantics; a future attendance-bonus policy that diverges from those semantics requires explicit business approval.

### Payroll settlement and recovery

- **Implemented and verified:** Payroll calculates salary/leave snapshots, blocks approval for incomplete attendance/conflicts, requires a payment method and reference to manually record payment, rejects a second payment after the atomic `approved` → `paid` transition, and supports an audited reversal. Incentive recovery allocations support reserve/confirm/release/reverse under a MongoDB session, with idempotent confirmed allocations.
- **Pending:** Payroll calculation does not read incentive ledger entries or payout batches. `IncentivePayoutBatch` has no producer/consumer workflow; `PayrollSettlementOutbox` is referenced only by its model/export/tests and has no producer or consumer. Payroll's `paid` state and user-entered reference are not independent bank/provider confirmation. Payroll reversal does not emit a settlement reversal event, and no production path confirms recovery allocations after settlement.
- **Exact external dependency and integration solution:** No bank/payroll settlement provider, signed callback contract, or authoritative settlement-file source is selected/configured in this repository. Before `paid` can mean externally settled, connect one such source through a provider adapter that emits an immutable event containing organization, branch, staff, payroll record, payout batch, month, currency, integer-paise amount, provider transaction/event ID, settlement timestamp, and reversal linkage. Verify webhook signatures or settlement-file provenance; enforce unique provider event/transaction IDs; reconcile exact expected and settled amounts; lease/retry the existing outbox idempotently; append settlement/reversal audit records; and confirm recovery allocations only for actually settled deductions. The project must also choose combined salary-plus-incentive payment versus a separate incentive transfer, and define partial/short-pay and reversal behavior. Until this contract exists, do not treat payroll generation, approval, or a manually typed reference as independent settlement evidence.

### Purchase commission categories

- **Implemented and verified:** The only assignable commission scheme is `COMMISSION` on `SERVICE_NET_REVENUE`. The engine supports configured fixed paise and tier percentage/fixed components with integer-paise half-up rounding; multi-staff allocation uses deterministic largest remainder. Product, subscription-purchase, and membership-purchase invoice lines do not create service commission. The frontend offers only the service commission capability, and the backend rejects unsupported schemes at activation/assignment.
- **Pending/disabled:** `PRODUCT_NET_REVENUE`, `TOTAL_INVOICE_NET_REVENUE`, and `SERVICE_COUNT` remain unsupported commission bases. `TARGET_BONUS` has a calculation helper but is not assignable/activatable through the supported commission path or connected to a payout consumer. Attendance and hybrid schemes fail closed. Seller attribution on a purchase flow does not itself authorize a purchase commission.
- **Exact approval required before enabling any purchase category:** category-by-category earning base and discount/loyalty treatment; eligible seller/attribution field distinct from cashier; earning/settlement timing; refund, return, cancellation, clawback and idempotency rules. No purchase category was enabled.

### Verification run for this audit

All backend database-backed commands used `src/tests/runDisposableTests.js`; each run verified a unique disposable database, rejected the application DB through the test guard, and logged exact-database drop plus absence verification.

```text
From backend:
node src/tests/runDisposableTests.js --runTestsByPath src/tests/attendance/attendanceIngestion.test.js src/tests/attendance/attendancePersistence.integration.test.js
  2 suites, 21 passed; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/attendance/attendanceAuthorization.test.js
  1 suite, 6 passed; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/payroll/payroll.test.js
  1 suite, 16 passed; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage2.test.js --testNamePattern='reserve|confirm|release|reversal'
  1 suite, 5 passed, 10 skipped; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage3.test.js --testNamePattern='does not accrue service commission from a product invoice line|fails closed when invoice-level loyalty redemption is not allocated to service lines|does not accrue commission from an attendance bonus scheme|does not accrue service commission from a (subscription|membership) purchase line'
  1 suite, 5 passed, 12 skipped; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage4.test.js --testNamePattern='rejects unsupported bonus categories and calculation bases as commissions|fails closed for attendance bonuses instead of trusting a precomputed day count|fails closed for hybrid schemes rather than awarding an unverified attendance component'
  1 suite, 3 passed, 11 skipped; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage5.test.js --testNamePattern='rejects activation of an unsupported attendance bonus scheme|rejects assignment of an unsupported attendance bonus scheme'
  1 suite, 2 passed, 11 skipped; exit 0.

From frontend:
npx vitest run src/features/incentives/__tests__/incentives.capabilities.test.tsx src/features/attendance/__tests__/attendance.api.test.ts
  2 files, 7 passed; exit 0.
```

An earlier combined stage4/stage5 invocation during parallel database-backed runs exited 1 because the stage5 `beforeAll` Mongo connection hook exceeded its 30-second timeout; stage4's three selected tests passed. The same two stage5 tests passed when rerun alone. The failed run's disposable database was also dropped and absence verified. No frontend build or lint was run because this audit made no frontend code changes.

```text
Failed combined command:
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage4.test.js src/tests/incentives/incentives.stage5.test.js --testNamePattern='rejects unsupported bonus categories and calculation bases as commissions|fails closed for attendance bonuses instead of trusting a precomputed day count|fails closed for hybrid schemes rather than awarding an unverified attendance component|rejects activation of an unsupported attendance bonus scheme|rejects assignment of an unsupported attendance bonus scheme'
Result: stage4 3 passed; stage5 failed its 30-second beforeAll Mongo connection hook; overall exit 1. Disposable database cleanup verified.
```

Disposable database names created for this audit, each dropped after verifying its run marker and then checked absent: `incentives_test_mwj5dlw0_333a56a72ca1`, `incentives_test_mwj5dltb_b008efa2b252`, `incentives_test_mwj5dlup_78c25b6c45a8`, `incentives_test_mwj5dlt7_a919bfaeef0f`, `incentives_test_mwj5f1xb_0c115e9c103f`, `incentives_test_mwj5gqjo_8f60ab2cbe80`, `incentives_test_mwj5gqjo_d4f95b18d1fa`, and `incentives_test_mwj5hx4t_c25334ccc50d`.

**Result:** Incentives remains **Pending**. The protected attendance and payroll/purchase paths remain safely disabled; the decisions and external settlement contract above are required before implementation can be completed.

## Incentive scheme creation and tier-bound correction (2026-11-16)

- The scheme dialog now restricts new rules to `COMMISSION` / `SERVICE_NET_REVENUE`; its notice clarifies that a scheme name such as “Subscription sale” is descriptive and does not enable subscription purchase commission. Attendance, target, product, and service-count categories remain unavailable until their integrations are verified.
- The form exposes the supported base fixed commission and graduated tier fields. Rupee inputs convert to integer paise. A blank tier maximum now normalizes to `null` (unbounded), not `0`; the demonstrated `minPaise: 1000000, maxPaise: 0` request is rejected before persistence as an invalid range.
- The backend create validation rejects unsupported scheme types/bases; update does not permit changing scheme type and accepts only the supported basis. Creation/update validate that finite tier maxima are at least their minima. Existing legacy unsupported schemes can still be read; they cannot be activated or assigned.
- The `rules` object is configured in the frontend `SchemeBuilderDialog`, converted and submitted by `incentivesApi.createScheme`, validated by `createSchemeSchema`, persisted in `IncentiveScheme.rules`, and consumed by `IncentiveCalculationEngine`. Current supported inputs are `fixedAmountPaise` (base fixed commission per eligible service line) and `tiers[]` (`minPaise`, nullable `maxPaise`, `percentage`, `fixedPaise`); tier thresholds use each staff member's attributed service-line net revenue. `targetThresholdPaise` and `minimumAttendanceDays` remain zero for supported new schemes because target/attendance schemes are unavailable.

Verification:

```text
From backend:
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage5.test.js --testNamePattern='creates a new incentive scheme in draft status|rejects unsupported .* schemes at creation|rejects a finite tier maximum below its minimum before persistence'
  1 suite, 4 passed, 12 skipped; exit 0.

From frontend:
npx vitest run src/features/incentives/__tests__/incentives.capabilities.test.tsx
  1 file, 4 passed; exit 0.
npx eslint src/features/incentives/components/SchemeBuilderDialog.tsx src/features/incentives/schemas/incentives.schema.ts src/features/incentives/types/incentives.types.ts src/features/incentives/__tests__/incentives.capabilities.test.tsx
  exit 0.
npm run build
  production build and TypeScript check passed; exit 0.
```

The focused lint command passes. A broader lint run over all touched frontend files exits 1 with 17 `no-explicit-any` errors in unrelated pre-existing dashboard/API mapping, update, and other mutation handlers, plus two unused-import warnings; the focused scheme-creation files have no lint errors. Backend ESLint was not available: `npx eslint src/validation/incentives/incentives.validation.js src/tests/incentives/incentives.stage5.test.js` exited 2 after `npx` selected ESLint 10.15.0, which found no `eslint.config.*`; no backend lint pass is claimed. Disposable databases `incentives_test_mwj5vyct_1c8a73f933c4` and `incentives_test_mwj61mpp_db8b6faa4c5d` were each verified by run marker, dropped, and checked absent. The protected application database was rejected by the disposable runner guard.

The created scheme uses `SERVICE_NET_REVENUE` regardless of its display name. A rule named “Subscription sale” is still a service commission configuration, not a subscription purchase commission. Incentives remains **Pending** for attendance bonus payout and payroll settlement dependencies above.

## Attendance and payroll integration follow-up (2026-11-16)

### Implemented

- Provider ingestion now derives a daily `present` status only from mapped, chronological in/out evidence in the branch's local business date. One-sided, repeated same-direction, unmapped, and out-before-in evidence does not create a present day.
- Stable provider-event retries re-evaluate attendance after a partial status write without duplicating punches. Status updates are monotonic (`incomplete` may become `present`, not the reverse), and never overwrite a reconciled/manual status or a conflicted claim.
- Existing payroll semantics remain authoritative: `present`, `late`, and `early_departure` count as one present day; `incomplete` blocks approval; no record is not a present day. No per-staff shifts or grace rules exist, so lateness is not inferred from branch opening hours.
- Pending and disputed `AttendanceBranchConflict` records within a payroll period now block payroll approval. Manual attendance changes still use the permission-gated, reason-required correction path and retain their audit history.
- Attendance/Leave bonus and hybrid schemes remain unavailable; the current Incentive engine still fails closed rather than trusting caller-supplied attendance counts. No attendance bonus ledger entries are created.

### Remaining payroll integration blocker

The application still has no producer/consumer for `PayrollSettlementOutbox`, no Incentive payout-batch generation/consumption path, and no configured bank/payroll provider or authoritative settlement-file source. The existing Payroll `recordPayment` endpoint is an internal manual record with a method/reference; it is not independent proof of a settled transfer. Therefore no technical implementation in this repository can truthfully confirm that salary or incentives were paid.

Concrete integration required: select a bank/payroll settlement source, define whether incentives are included in salary or paid separately, and provide its authenticated settlement event/file contract. Implement the adapter and reconciliation worker against the immutable integer-paise event schema specified in the Payroll section above, then test duplicate/replayed confirmations, reversals, amount mismatches, retries, and recovery confirmation before enabling attendance or other payout schemes.

### Verification run

All backend database-backed commands used `src/tests/runDisposableTests.js`. The runner rejected the application database, verified each generated database by its unique name/run marker, dropped only that database, then queried the database list and verified the exact name was absent.

```text
From backend:
node src/tests/runDisposableTests.js --runTestsByPath src/tests/attendance/attendancePersistence.integration.test.js src/tests/attendance/attendanceIngestion.test.js
  2 suites, 24 passed; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/attendance/attendanceAuthorization.test.js
  1 suite, 6 passed; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/payroll/payroll.test.js
  1 suite, 17 passed; exit 0. The calculation regression asserts that `present`, `late`, and `early_departure` each count as attendance days while `incomplete` blocks approval.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage3.test.js
  1 suite, 17 passed; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage4.test.js
  1 suite, 14 passed; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage5.test.js
  1 suite, 16 passed; exit 0.

From frontend:
npx vitest run src/features/attendance/__tests__/attendance.api.test.ts src/features/attendance/__tests__/attendance.eligibility.test.tsx src/features/incentives/__tests__/incentives.capabilities.test.tsx
  3 files, 9 passed; exit 0.
npx eslint src/features/attendance/components/AttendanceWorkspace.tsx src/features/attendance/__tests__/attendance.eligibility.test.tsx
  exit 0.
npm run build
  optimized production build and TypeScript check passed; exit 0.

Backend syntax:
node --check on the attendance service, payroll service, attendance persistence test, and payroll test
  exit 0.
```

Disposable database names for the final successful runs: `incentives_test_mwj6ss72_9e4005dff2bf`, `incentives_test_mwj6oheo_f5806249c256`, `incentives_test_mwj6lac1_51af0de1bfa4`, `incentives_test_mwj6p8j4_8176eefe0890`, `incentives_test_mwj6pzsw_054809838a47`, `incentives_test_mwj6qbig_96bef7d965d7`, and the payroll rerun after asserting late/early attendance day counts, `incentives_test_mwj6we0r_a7c3e1a6a1be`. Each was dropped and its absence verified. The first payroll run, on `incentives_test_mwj6k67v_534bca430ddf`, failed 3 downstream assertions because the new conflict fixture remained in the shared test organization; the test was corrected to remove only its own fixture, then the full payroll suite passed 17/17 on the rerun. That failed-run database was also dropped and absence verified. The first frontend UI run had one ambiguous text selector; the selector was narrowed and the focused 9-test run passed.

**Earlier checkpoint outcome (superseded below):** attendance punch-to-daily-status and payroll conflict gates were implemented and verified, while attendance bonus accrual and payroll consumption were still pending. Incentives remains **Pending** because authoritative settlement integration is still missing.

## Attendance incentives, payroll calculation, and configuration UI (2026-11-16)

This section supersedes earlier dated statements above that attendance bonus evaluation or payroll calculation consumption had not been implemented.

### Implemented and verified

- Biometric attendance evaluation requires a closed month, active organization/branch/staff membership, an active assigned attendance scheme, and verified source records. Incomplete/disputed punches and unresolved cross-branch conflicts block finalization; approved leave is handled separately, half-day exceptions contribute 0.5 verified day, and manager corrections require the existing reasoned/audited correction path.
- Finalization records the evaluation snapshot and appends an idempotent attendance-bonus ledger accrual. Repeated finalization returns the existing result rather than creating another earning.
- Payroll calculation now includes finalized attendance evaluations for that organization, staff, and month. It snapshots source evaluation IDs and total integer paise, includes the amount in gross/net pay, and recalculates the same draft record on retry. Approval rejects a record if its incentive evaluation IDs or amount changed since calculation.
- The payroll calculation breakdown displays the finalized attendance incentive as a separate earnings line. The payroll UI no longer offers manual disbursement; it identifies the missing settlement-provider dependency. Incentive rules in the UI now clearly distinguish service commissions from attendance bonuses, explain their bases/gates, show only supported rule fields, convert rupees to integer paise, submit a blank tier maximum as `null`, and reject invalid tier ranges and unsupported scope/category options. Assignment scopes exposed in the UI match the resolver: staff, branch, and organization. Role assignments are not offered because the resolver has no role-scope precedence.
- Assignment dialog close and cancel actions clear stale overlap-conflict feedback.
- No routes were added for payroll. The PayrollRecord contract now includes `incentiveEvaluationIds`, `incentiveAmountInPaise`, and `calculations.totalIncentivesInPaise`. Approval validation uses the recorded source set and total.

### Verification run on 2026-11-16

```text
From backend:
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage5.test.js
  1 suite, 19 tests passed; exit 0. Covers biometric attendance evaluation/finalization, idempotency, pending fulfillment reporting, API authorization/configuration, and rejects unresolved ROLE assignment.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/payroll/payroll.test.js
  1 suite, 17 tests passed; exit 0. The payroll integration creates a finalized attendance evaluation, verifies stale payroll approval is rejected, recalculates, asserts the exact 1,234 paise incentive is included in gross/net payroll, approves, and verifies an unverified manual payment reference cannot mark it paid. A seeded settlement fixture exercises duplicate-payment rejection and reversal behavior.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/payroll/payroll.test.js --testNamePattern='does not mark payroll paid from an unverified manual reference|prevents duplicate payments on already paid record'
  1 suite failed: 2 failed, 15 skipped; exit 1. This isolated selection skips earlier tests that create the payroll period/record used by these ordered payment cases, so both attempted to read a missing fixture. The full payroll suite below initializes the prerequisites and passes.

From frontend:
npx vitest run src/features/incentives/__tests__/incentives.capabilities.test.tsx
  1 file, 7 tests passed; exit 0. Covers supported configuration, blank maximum as unbounded/null, integer-paise payloads, invalid tier bounds, and assignment scope/date payloads.
npx eslint src/features/incentives/components/SchemeBuilderDialog.tsx src/features/incentives/components/AssignmentDialog.tsx src/features/incentives/components/AttendanceBonusPanel.tsx src/features/incentives/components/SchemeDetailModal.tsx src/features/incentives/schemas/incentives.schema.ts src/features/incentives/types/incentives.types.ts src/features/incentives/__tests__/incentives.capabilities.test.tsx src/features/payroll/api/payroll.api.ts src/features/payroll/components/CalculationBreakdownDialog.tsx src/features/payroll/components/PayrollDashboardView.tsx src/features/incentives/api/incentives.api.ts src/features/incentives/components/IncentivesDashboardView.tsx
  exit 0.
npm run build
  production build and TypeScript check passed; exit 0.
```

After the final dialog updates, the focused Incentives UI suite passed (7/7; exit 0), focused ESLint passed on the updated dialog/schema files (exit 0), and `npm run build` passed with TypeScript checking (exit 0). The calculation basis is displayed but derived from the selected scheme type, so the UI does not offer a misleading independent basis choice.

The final successful database-backed runs used disposable databases `incentives_test_mwj826bv_17ebdaed0ed3` (19-test attendance suite) and `incentives_test_mwj8q07o_6d7541193c15` (17-test payroll suite); each was dropped and its absence verified. The targeted payroll attempt used `incentives_test_mwj8pjyx_e8d5b7a0454b`; its runner dropped it and verified absence. A prior full payroll attempt on `incentives_test_mwj87dnu_b44fe35b905e` stalled before Jest emitted results; the process was stopped, its unique run marker was verified, only that exact database was dropped, and absence was confirmed. Earlier attendance databases `incentives_test_mwj7gsu0_da0ec40607ba` and `incentives_test_mwj7i92r_cfaa5ee1f825` were also cleaned and verified absent. No protected application database was modified.

`git diff --check` could not run because the workspace is not a Git repository (exit 129). A targeted scan of every touched source/test/documentation file found no trailing whitespace or conflict markers.

### Remaining blocker: payment settlement evidence

This is not a completed payroll-to-settlement lifecycle. The existing `/pay` endpoint now returns HTTP 503 for approved records and makes no status/payment-field changes; only a record already marked paid returns a duplicate-payment conflict. No authenticated bank/provider callback, settlement-file source, or reconciliation consumer exists. Payroll generation, approval, or a manually entered reference is not independent proof of transfer. `PayrollSettlementOutbox` remains unused, and no production consumer confirms recovery allocations or settlement reversals. To close this blocker, select the authoritative settlement provider/file source and specify its authentication, immutable event ID, amount/currency, partial-payment, reversal, and retry contract; then implement and test the adapter/reconciliation worker. Incentives therefore remains **Pending**, not Ready or Complete.

## Incentive schema alignment (2026-11-16)

The read-only attached `incentives.schema.ts` snapshot is older than the workspace implementation: the current frontend form schema does not expose `targetThresholdRupees` or `ROLE` assignments. It validates paise precision, maps a blank tier maximum to `null`, and limits configuration to implemented commission/attendance rules. The backend now strictly rejects unsupported target/attendance keys in commission creation, unsupported keys in attendance scheme creation, and `targetThresholdPaise` on scheme updates; no purchase or target commission was enabled.

Verification:

```text
From backend:
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage5.test.js
  1 suite, 21 tests passed; exit 0. Includes API rejection of unsupported commission rule fields at create and update.
node --check src/validation/incentives/incentives.validation.js
node --check src/tests/incentives/incentives.stage5.test.js
  both passed; exit 0.
From frontend:
npx vitest run src/features/incentives/__tests__/incentives.capabilities.test.tsx
  1 file, 7 tests passed; exit 0.
npx eslint src/features/incentives/components/SchemeBuilderDialog.tsx src/features/incentives/schemas/incentives.schema.ts
  exit 0.
npm run build
  production build and TypeScript check passed; exit 0.
```

The first run's assertion expected an unset model default; API rejection itself passed. The assertion was corrected to verify the existing default remained unchanged, and the full suite then passed. The first run database `incentives_test_mwj8x5jg_3989d5a2f535` and passing rerun database `incentives_test_mwj8y8t4_8690e27344b2` were each cleaned by exact name and verified absent. No protected database was used.

## Retail product sale commission implementation and verification

Retail product sales are now an enabled, category-specific commission basis. The scheme builder exposes **Retail product sale** and its detail view explains that commission is calculated from sold net product revenue after allocated discounts and requires confirmed stock issue. The cashier remains the payment actor; only the selected product-line seller is attributed.

The backend snapshots seller attribution and product identity at settlement, requires the full payment and matching immutable `pos_sale` movement, and records one retail accrual per invoice line and seller. Returns require an `Idempotency-Key`; the request hash, actor, reason, refund allocation and any restock movement are recorded with the return settlement event. Refunds use the line's net customer-payable value, are capped at amounts actually paid, and split integer paise deterministically. Commission clawbacks are proportional to cumulative actual refunds, linked to the accrual, capped at the original commission, and create pending recovery obligations rather than marking recovery paid. An identical return retry returns the saved result; reusing the key with a different payload is rejected.

Verification from the current workspace:

```text
From backend:
node src/tests/runDisposableTests.js --runTestsByPath src/tests/billing/unifiedCheckoutConvergence.test.js --testNamePattern="accrues retail commission to the seller and reverses it once for an idempotent refund"
  1 passed, 15 skipped; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/billing/unifiedCheckoutConvergence.test.js
  1 suite, 16 tests passed; exit 0.
node src/tests/runDisposableTests.js --runTestsByPath src/tests/incentives/incentives.stage3.test.js --testNamePattern="product return creates incremental clawback and recovery obligation using returnOperationId|claws back retail commission proportionally across separate partial refunds"
  1 suite, 2 passed, 16 skipped; exit 0.
From frontend:
npx vitest run src/features/incentives/__tests__/incentives.capabilities.test.tsx src/features/billing/__tests__/billing.api.test.ts
  2 files, 32 tests passed; exit 0. Covers retail rule configuration/detail labels and the return API's idempotency header and request/response contract.
npx eslint src/features/incentives/components/SchemeBuilderDialog.tsx src/features/incentives/components/SchemeDetailModal.tsx src/features/incentives/schemas/incentives.schema.ts src/features/incentives/types/incentives.types.ts src/features/incentives/__tests__/incentives.capabilities.test.tsx src/features/billing/api/billing.api.ts src/features/billing/types/billing.types.ts src/features/billing/__tests__/billing.api.test.ts
  exit 0.
npm run build
  production build and TypeScript check passed; exit 0.
```

The disposable runner verified and removed databases `incentives_test_mwjbbw3i_860b47dc2b68`, `incentives_test_mwjbdc4b_918cb05aedfb`, `incentives_test_mwjbe125_7876a6213fc2`, `incentives_test_mwjbf97k_bc84ea2a431b`, and `incentives_test_mwjbgln9_ecb80d3c567a`; each exact database was dropped and its absence verified. The runner rejected the application database for every run. No protected database was used.

The broader POS return suite and a focused selection of its four return cases both stalled without Jest results and were stopped; neither is **verified**. Their exact disposable databases, `incentives_test_mwjbj7rr_16f4f84c2ca8` and `incentives_test_mwjbz1mn_944285b89401`, were created and marker-verified by the runner. Node's SRV resolver initially returned `ECONNREFUSED`; cleanup used the system DNS resolver, verified each unique run marker, dropped only those exact databases, and verified their absence. The application database was never targeted.

Remaining gaps: external processor settlement, payroll consumption/paid-settlement confirmation, and paid recovery confirmation remain unavailable. Unsupported renewal/redemption, target, service-count, and invoice-wide loyalty-allocation commission categories remain disabled or fail-closed. **Overall module status remains Pending.**

## Incentives dashboard labels and ledger contract (2026-11-17)

The scheme list and ledger now show human-readable calculation-basis names instead of raw enum identifiers, including retail product, subscription sale, and membership sale. The ledger guidance distinguishes service-completion gates from sale payment and issuance gates rather than describing every entry as requiring service fulfilment. Frontend ledger types now include the implemented sale commission sources and reversal metadata.

Verification:

```text
From frontend:
npx vitest run src/features/incentives/__tests__/incentives.capabilities.test.tsx
  1 file, 10 tests passed; exit 0.
npx eslint src/features/incentives/components/IncentivesDashboardView.tsx src/features/incentives/components/LedgerTab.tsx src/features/incentives/types/incentives.types.ts src/features/incentives/__tests__/incentives.capabilities.test.tsx
  exit 0.
npm run build
  production build and TypeScript check passed; exit 0.
```

## Unused membership refund and commission clawback (2026-11-17)

The invoice detail screen now exposes a refund-record action to users with `payments.refund`. The API accepts only a fully paid/finalized single-membership invoice line, rejects unallocated loyalty discounts, and checks for benefit use or reservation on any non-cancelled invoice (drafts included). The transaction records the negative manual refund payment, cancels and audits the issued membership, updates the invoice balance and returned quantity, emits an idempotent refund settlement event, and invokes the existing membership commission clawback/recovery-obligation path. Replay uses the same invoice/line idempotency key; clawbacks remain linked to the original accrual and recovery remains pending until separately confirmed.

The UI explicitly says this operation **does not send money or contact a processor** and may be used only after an approved external refund has actually been issued. This closes the membership refund-record/clawback implementation and regression gap; it does not prove processor settlement.

API contract: `POST /api/v1/billing/invoices/:id/membership-refunds` is authenticated and organization-scoped, uses the selected branch middleware and `payments.refund`, requires `Idempotency-Key` (or `X-Idempotency-Key`), and validates `{ branchId?, lineId, refundPaymentMethod, reason }` (`cash|card|upi|other`, reason length 3–500). Success returns the invoice, refund payment, refund event, replay flag, and `manualRefundRecord: true`; eligibility, benefit reservation, and tenant/branch checks are enforced in the service transaction.

Verification:

```text
From backend:
npm run test:disposable -- --runTestsByPath src/tests/billing/unifiedCheckoutConvergence.test.js --testNamePattern="accrues membership-sale commission to the selected seller after the unified checkout is paid|records an unused membership refund once and claws back its seller commission|accrues retail commission to the seller and reverses it once for an idempotent refund"
  1 suite, 3 passed, 14 skipped; exit 0.
  Covers independent seller/cashier fields, seller commission, unused-only guard against a draft benefit reservation,
  membership cancellation/audit/refund settlement, replay without duplicate refund/clawback, and pending recovery.
npm run test:disposable -- --runTestsByPath src/tests/billing/unifiedCheckoutConvergence.test.js
  1 suite, 17 passed; exit 0.
  The first full run exposed fixture leakage from the new membership-refund regression: its issued membership
  changed later tests' payable amounts and made one payment request invalid. The test now deletes its
  organization-scoped CustomerMembership fixtures, and the complete suite passes on rerun.

From frontend:
npx vitest run src/features/billing/__tests__/billing.ui.test.tsx src/features/billing/__tests__/billing.api.test.ts
  2 files, 51 tests passed; exit 0. Existing JSDOM navigation/network warnings were emitted by unrelated tests.
npx eslint src/features/billing/components/InvoiceDetailsPage.tsx src/features/billing/api/billing.api.ts src/features/billing/hooks/useBillingMutations.ts src/features/billing/types/billing.types.ts src/features/billing/__tests__/billing.ui.test.tsx src/features/billing/__tests__/billing.api.test.ts
  exit 0.
npm run build
  production build and TypeScript check passed; exit 0.
```

Backend `node --check` passed for all changed backend model, service, controller, router, validation, and test files. The disposable runner verified and then dropped each exact database, verifying absence: `incentives_test_mwk8sl84_f06d7dc14c4d`, `incentives_test_mwk8tlw6_77e617a49193`, `incentives_test_mwk8wms1_c5b9ac4413a0`, `incentives_test_mwk8xuff_f255b66b85de`, `incentives_test_mwk8zl5i_193aff7f3d98`, `incentives_test_mwk92dcz_195e863692b9`, and `incentives_test_mwk9g0et_09f7a6337df6`. The failed full-suite attempt used `incentives_test_mwk9ae6b_6568a9c2f6e9`; it was marker-verified, dropped, and absence verified. Earlier failed iterations exposed and corrected a handler-return mismatch and test fixture isolation; their databases were also marker-verified and dropped. Every runner invocation rejected the application database, and no protected database was used.

An earlier, separate focused `unifiedBillingPhase2.test.js` attempt did not produce Jest output after more than 20 minutes and was stopped. Its disposable database `incentives_test_mwk9ae69_2adebd71dd78` was subsequently marker-verified, dropped, and absence-verified on 2026-11-17. That attempt has no reported pass/fail result.

## Payroll manual settlement and attendance payout verification (2026-11-17)

### Implemented

- Added `PayrollPayment` as a separate payment-attempt and transition-history record. Payment identity, branch, payroll record, staff, integer-paise amount, method, reference, date, idempotency key, request hash, recorder, and incentive snapshot are immutable after creation.
- Payroll is no longer marked paid when a payment reference is merely recorded. The attempt remains `recorded`; an authorized user must separately attest that actual off-system payment completed. That confirmation records actor/time and atomically changes the payroll record to `paid`.
- Added explicit failed-attempt recording and retry, idempotent request/confirmation/failure/reversal handling, exact whole-payable paise validation, one active attempt at a time, and transactional writes. Concurrent attempts with distinct idempotency keys result in one accepted attempt and one conflict.
- Payroll reversal keeps the existing record response shape and adds the linked attempt transition to `reversed`. A repeated reversal with the same reason is idempotent.
- `payroll.disburse` protects record/confirm/fail; `payroll.reverse` protects reversal. Payroll routes resolve organization from the authenticated user and require validated active-branch scope where applicable. Frontend calls now pass `branchScope: "current"` through the central API client.
- Fixed the Payroll controller's actor lookup: authenticated request context supplies `req.user.id`, not `req.user._id`; the previous reference left required payment-history actors unset.
- Existing Payroll calculation consumes only finalized `ATTENDANCE_BONUS` evaluations. The payment attempt snapshots those evaluation IDs and paise amount; no purchase/service commission category was added to Payroll.

### Current payroll API contract

- `POST /api/v1/payroll/records/:id/pay` — permission `payroll.disburse`; body `{ paymentMethod: "bank_transfer"|"cash"|"cheque"|"upi", paymentReference: string, amountInPaise: positive safe integer, paymentDate: ISO datetime with offset, idempotencyKey: 8–128 characters }`. A new attempt returns HTTP 201 and `{ success, data: { record, payment, isIdempotentReplay }, message }`; an identical replay returns HTTP 200. It does not mark the record paid.
- `POST /api/v1/payroll/records/:id/payments/:paymentId/confirm` — permission `payroll.disburse`; requires `{ confirmActualPayment: true }`. Returns the record/payment pair; only this explicit confirmation changes status to paid.
- `POST /api/v1/payroll/records/:id/payments/:paymentId/fail` — permission `payroll.disburse`; requires `{ failureReason: 3–500 characters }`. Keeps payroll approved and permits a new attempt with a new idempotency key.
- `POST /api/v1/payroll/records/:id/reverse` — unchanged request `{ reversalReason: 3+ characters }`, permission `payroll.reverse`; `data` remains the reversed PayrollRecord, with linked `payment` and `isIdempotentReplay` added to the response.
- Payroll record list/detail responses now expose `paymentHistory` and `latestPaymentAttempt`. A scoped request uses authenticated organization context and the validated `X-Branch-Id` header for branch-limited users; organization-wide users may omit it.

### Verification

Run from `backend` on 2026-11-17:

```text
npm run test:disposable -- --runTestsByPath src/tests/payroll/payroll.test.js
  1 suite passed; 18 tests passed, 0 failed; exit 0.
  Includes finalized attendance evaluation -> payroll calculation -> approval -> payment recording ->
  explicit paid confirmation; wrong-paise rejection; concurrent duplicate protection; retry after failure;
  replayed confirmation/reversal; audit history; and organization/branch/permission isolation.
npm run test:disposable -- --runTestsByPath src/tests/incentives/incentives.stage5.test.js --testNamePattern="blocks incomplete punches, then accrues once"
  1 suite passed; 1 test passed, 21 skipped; exit 0.
  Covers biometric event ingestion, incomplete-punch blocking, replayed punch repair, approved and half-day
  leave, reasoned manager correction, finalization, and idempotent attendance-bonus ledger accrual.
node --check backend\src\models\payroll\payrollPayment.model.js
node --check backend\src\models\payroll\payrollRecord.model.js
node --check backend\src\services\payroll\payroll.service.js
node --check backend\src\controllers\payroll\payroll.controller.js
node --check backend\src\routers\payroll\payroll.routes.js
node --check backend\src\validation\payroll\payroll.validation.js
node --check backend\src\tests\payroll\payroll.test.js
  Combined command exit 0.
```

Run from `frontend`:

```text
npm test -- src/features/payroll
  2 files passed; 3 tests passed, 0 failed; exit 0.
  Covers exact payable entry, separate confirmation, amount mismatch blocking, and branch-scoped API requests.
npx eslint src/features/payroll/api/payroll.api.ts src/features/payroll/components/PayrollDashboardView.tsx src/features/payroll/components/PayrollPaymentDialog.tsx src/features/payroll/__tests__/PayrollPaymentDialog.test.tsx src/features/payroll/__tests__/payroll.api.test.ts
  exit 0; no warnings or errors.
npm run build
  production build and TypeScript check passed; exit 0.
```

Intermediate disposable payroll runs exposed a missing authenticated actor ID, test fixtures conflicting with Payroll's unique organization/staff/month index, and a test retry using a different timestamp with the same key. The actor lookup and fixtures were corrected and the retry test now sends a stable request. The final suites above pass. Every database created by these test runs was marker-verified, dropped, and absence-verified: `incentives_test_mwkb69yb_5aed677ca726`, `incentives_test_mwkb7q4c_08bdd2ef4732`, `incentives_test_mwk8qbf_32dbc4e36bd8`, `incentives_test_mwk9sgv_0ebddd37ea20`, `incentives_test_mwkbadxu_f60fd243e95c`, `incentives_test_mwkbbhyx_d86c14e37b47`, `incentives_test_mwkcehf_55b3e33fdd76`, `incentives_test_mwkbfipf_51a03ec9988c`, and `incentives_test_mwkbgkgr_f239ea89c71b`. The earlier stale `incentives_test_mwk9ae69_2adebd71dd78` was also marked, dropped, and absence-verified. No protected application database was queried or modified.

### Still pending

- No staff roster/work schedule or authoritative expected-workday calendar exists. An attendance date with no row cannot be called a missed punch without that source; the application must not assume every branch-open day is a staff workday. Add and approve a staff-specific schedule/workday source before enabling absent-no-record attendance eligibility rules.
- Payroll consumes finalized attendance bonuses, but no consumer moves service, subscription-sale, membership-sale, or retail commission ledger entries into payroll. `IncentivePayoutBatch` has no producer/consumer workflow and `PayrollSettlementOutbox` remains contract-only.
- Recovery reservations are not confirmed as paid and recovery deductions remain disabled. Manual salary-payment confirmation does not prove a separate recovery deduction or recovery payment.
- Current-release payroll settlement authority is the authorized user's explicit manual confirmation after off-system verification. It is not a bank callback and does not establish provider reconciliation; provider integration remains a future extension, not a blocker to this manual policy.

**Overall remains Pending.** The supported biometric attendance-bonus and payroll-manual-settlement journeys are verified, but workday completeness, commission-ledger payroll consumption, recovery settlement, and broader acceptance remain incomplete.

`git diff --check` was not run because this workspace is not a Git repository.

## Supplemental commission/refund regression verification (2026-11-17)

Run during the final focused regression pass:

```text
From backend:
npm run test:disposable -- --runTestsByPath src/tests/incentives/incentives.stage5.test.js
  First parallel attempt: exit 1; 1 suite failed and 22 tests were reported failed after
  the shared beforeAll exceeded 30 seconds. Dependent setup then reported a missing
  organizationId because the outer setup had not completed. No protected database was used.
  Serial retry: 1 suite passed; 22 tests passed, 0 failed; exit 0.
npm run test:disposable -- --runTestsByPath src/tests/billing/unifiedCheckoutConvergence.test.js
  1 suite passed; 17 tests passed, 0 failed; exit 0.

From frontend:
npm test -- src/features/incentives src/features/billing/__tests__/billing.ui.test.tsx src/features/billing/__tests__/billing.api.test.ts
  5 files passed; 69 tests passed, 0 failed; exit 0.
  Vitest emitted jsdom navigation-not-implemented diagnostics and the known Vite CJS API
  deprecation notice; these did not fail tests.
```

The disposable runner verified application-database rejection and exact disposable database acceptance on every backend invocation. It dropped and absence-verified `incentives_test_mwkbo42b_f868036940a6` (failed parallel Stage 5 attempt), `incentives_test_mwkbo42s_e41e255da907` (checkout regressions), and `incentives_test_mwkbqlfq_35e27c725c62` (successful serial Stage 5 retry). No protected application database was queried or modified.

These regressions add verification evidence only; no application code was changed in this supplemental pass. Incentives remains **Pending** as stated above.

## Payroll commission allocation and manual recovery follow-up (2026-11-17; latest)

### Implemented and verified

- Payroll calculation snapshots eligible confirmed commission ledger entries for the payroll period, including service, subscription-sale, membership-sale, and retail-sale source types. Linked clawbacks reduce the payable snapshot. Approval creates one unique allocation per source accrual; payment attempts carry the commission amount and ledger references; only explicit manual settlement confirmation marks the allocation paid.
- Manual recovery attempts are branch-scoped and permission-gated. Recording reserves both the obligation and paid commission capacity but does not reduce recovered balances. Failure releases the reservation; retry uses a distinct idempotency key; actual-receipt confirmation updates recovered totals; actual-reversal confirmation restores them. Atomic balance guards prevent over-recovery and an obligation already deducted before payroll cannot also be recovered.
- Payroll payment and recovery screens display employee, period, amount, commission/reversal breakdown, reference, and current lifecycle state. Payment confirmation and recovery confirmation require explicit user attestation; recovery reversal requires `payroll.reverse`, a reason, and confirmation. Recovery dialog form state is reset by remounting on obligation change, and the open-dialog balances update after record/fail/confirm/reversal actions.
- Staff earnings aggregates all ledger and recovery pages in the selected branch context, keeps query caches branch-specific, displays paise accurately, and labels accrued less outstanding clawback as a commission position rather than implying payroll was paid. Recovery query errors no longer silently display zero recovery.
- A focused backend regression covers service commission accrual → payroll snapshot/allocation → manual payment attempt → confirmed paid status → recovery obligation → failed/retried partial recovery → confirmation/replay → reversal/replay → final full recovery. It also checks duplicate allocation prevention, pre-pay clawback exclusion from separate recovery, over-recovery rejection, and denial without `payroll.disburse`.

### Recovery API contract

- `GET /api/v1/incentives/recovery-obligations` — authenticated, `requireBranchScope`, `incentives.view` or `incentives.view.all`; accepts optional query `staffId` (ObjectId), `status` (`pending|partially_recovered|recovered|written_off`), `page` (digit string), and `limit` (digit string). It returns obligation balances plus recorded payment history and collectible balance.
- `POST /api/v1/incentives/recovery-obligations/:id/payments` — authenticated, active `X-Branch-Id`, `payroll.disburse`; body `{ amountInPaise: positive safe integer, paymentMethod: "bank_transfer"|"cash"|"cheque"|"upi", paymentReference: string, paymentDate: ISO datetime with offset, reason: 3–500 characters, idempotencyKey: 8–128 characters }`. A new attempt returns 201; an identical replay returns 200. Neither response marks the obligation recovered.
- `POST /api/v1/incentives/recovery-obligations/:id/payments/:paymentId/confirm` — authenticated, active branch, `payroll.disburse`; body `{ confirmActualPayment: true }`. Confirmation means an authorized user has verified actual receipt and is the only transition that adds to recovered balances.
- `POST /api/v1/incentives/recovery-obligations/:id/payments/:paymentId/fail` — authenticated, active branch, `payroll.disburse`; body `{ failureReason: 3–500 characters }`. Releases the reservation so a new attempt can be recorded.
- `POST /api/v1/incentives/recovery-obligations/:id/payments/:paymentId/reverse` — authenticated, active branch, `payroll.reverse`; body `{ confirmActualReversal: true, reversalReason: 3–500 characters }`. An identical reversal replay is idempotent.
- `POST /api/v1/payroll/records/:id/pay`, `/payments/:paymentId/confirm`, `/payments/:paymentId/fail`, and `/reverse` retain the contracts described above. Commission allocation is included in the payroll snapshot and payment record; approval or payment-attempt recording alone does not establish settlement.

### Verification run on 2026-11-17

```text
From backend:
npm run test:disposable -- --runTestsByPath src/tests/payroll/payroll.test.js src/tests/incentives/incentives.stage5.test.js
  2 suites passed; 41 tests passed, 0 failed; exit 0.
  Includes the payroll commission/recovery lifecycle regression and Stage 5 attendance,
  fulfillment, authorization, idempotency, and recovery reporting regressions.
npm run test:disposable -- --runTestsByPath src/tests/billing/unifiedCheckoutConvergence.test.js
  1 suite passed; 17 tests passed, 0 failed; exit 0.
  Includes unified membership checkout/refund and retail checkout/commission regressions.

From frontend:
npm test -- src/features/incentives src/features/payroll
  7 files passed; 27 tests passed, 0 failed; exit 0.
  Covers recovery payment/reversal UI permissions and confirmations, paise amount bounds,
  payroll payment confirmation and commission detail, branch-aware staff earnings aggregation across pages,
  recovery-load error visibility, capabilities, navigation, and API behavior.
  Vitest emitted the existing jsdom navigation diagnostic and Vite CJS API deprecation notice.
npx eslint src/features/incentives/components/StaffEarningsTab.tsx src/features/incentives/components/IncentivesDashboardView.tsx src/features/incentives/__tests__/StaffEarningsTab.test.tsx src/features/incentives/components/ManualRecoveryPaymentDialog.tsx src/features/incentives/components/RecoveryObligationsTab.tsx src/features/incentives/__tests__/ManualRecoveryPaymentDialog.test.tsx src/features/payroll/components/PayrollPaymentDialog.tsx src/features/payroll/components/CalculationBreakdownDialog.tsx src/features/payroll/components/PayrollDashboardView.tsx src/features/payroll/__tests__/PayrollPaymentDialog.test.tsx
  exit 0; no warnings or errors.
npm run build
  production build and TypeScript check passed; exit 0.

Whitespace:
  Scoped changed-file whitespace check passed for all 25 implementation, test, and documentation files.
  Scoped tracked-file git diff --check passed.
  Repository-wide git diff --check exited 1 because other already-dirty attendance,
  subscription, and permission files contain trailing whitespace; those files were not edited
  in this follow-up and were left unchanged.
```

Disposable database evidence for the backend command above:

- Final run `incentives_test_mwkcsnku_d050383c1264`: unique disposable name and run marker verified; application database rejected by the guard; exact disposable database dropped and absence verified after the 41-test pass.
- Earlier run `incentives_test_mwkcn47j_7a9caffc5c72`: test run failed on three payroll fixtures using nonexistent payroll periods; exact disposable database was dropped and absence verified.
- Earlier run `incentives_test_mwkcm2gz_c4ec04006283`: both suites failed to load due to the missing `requireBranchScope` import; exact disposable database was dropped and absence verified.
- Unified checkout run `incentives_test_mwkd6gwq_d9a7493fddbb`: database guard and run marker verified; the 17-test suite passed; exact database was dropped and absence verified.
- No protected application database was queried or modified.

### Pending at this checkpoint; superseded by the follow-up below

- The backend has no staff-specific roster/work schedule or authoritative expected-workday calendar. Do not infer an absence or missed punch from a date with no record; add that schedule capability before enabling no-record absence eligibility.
- The focused component tests and successful production build do not constitute full browser-level responsive, keyboard, and permission acceptance across every Incentives and Payroll screen. That acceptance remains to be demonstrated before release closure.
- Attendance commission policy and unsupported purchase categories remain disabled; renewal/redemption commission payout is unsupported. External bank/provider settlement is outside the current authorized manual-confirmation policy and is not required for this release. No unsupported formulas or settlement facts were introduced.

## Focused acceptance follow-up (2026-11-17)

### Changes and verified behavior

- Added the category-wide payroll integration regression for exactly the supported ledger categories (`service_commission`, `subscription_sale_commission`, `membership_sale_commission`, `retail_sale_commission`). It verifies period and branch references, one allocation per source entry, payment-attempt versus confirmation state, confirmed paid allocation status, and rejection of the unsupported subscription-renewal category.
- Expanded the unified membership regression to prove membership seller attribution and accrual → payroll snapshot/allocation → manual payment attempt → explicit paid confirmation → unused membership refund/clawback → recovery obligation → partial confirmed recovery → reversal → full confirmed recovery. It verifies idempotent refund/recovery replays and that attempts alone do not change recovered balances.
- Fixed the unified test's model import to reference the recovery-payment model directly. Its payroll snapshot assertion now checks inclusion of the membership source ledger entry, rather than assuming it is the only earning in the shared test period.
- Attendance evaluation UI state now resets by branch-keyed remount rather than a synchronous state-setting effect. The “all branches” selector is explicitly treated as unsuitable for branch-local attendance evaluation.
- Branch-aware summary data, visible/retryable query errors, stale attendance evaluation invalidation, and dialog keyboard focus behavior are covered by focused frontend tests. The dialog test explicitly focuses its opener before checking restoration.

### Files changed in this follow-up

- Backend: `src/validation/incentives/incentives.validation.js`, `src/routers/incentives/incentives.routes.js`, `src/controllers/incentives/incentives.controller.js`, `src/tests/incentives/incentives.security.integration.test.js`, `src/tests/payroll/payroll.test.js`, `src/tests/billing/unifiedCheckoutConvergence.test.js`, and this status document.
- Frontend: `src/features/incentives/api/incentives.api.ts`, `src/features/incentives/components/IncentivesDashboardView.tsx`, `src/features/incentives/components/AttendanceBonusPanel.tsx`, `src/features/incentives/__tests__/incentives.api.test.ts`, `src/features/incentives/__tests__/IncentivesDashboardView.test.tsx`, `src/features/payroll/components/PayrollDashboardView.tsx`, `src/components/ui/dialog.tsx`, and `src/components/ui/__tests__/dialog.test.tsx`.

### Verification run on 2026-11-17 (Windows, local workspace)

```text
From backend:
npm run test:disposable -- --runTestsByPath src/tests/payroll/payroll.test.js src/tests/incentives/incentives.security.integration.test.js src/tests/billing/unifiedCheckoutConvergence.test.js
  Exit 0; 3 suites passed; 44 tests passed, 0 failed.
  Includes supported-source allocation/settlement, branch/permission regressions,
  membership checkout-to-payroll-to-refund/recovery, and existing checkout regressions.

From frontend:
npm test -- src/features/incentives src/features/payroll src/components/ui/__tests__/dialog.test.tsx
  Exit 0; 10 test files passed; 33 tests passed, 0 failed.
  Vite emitted its existing CJS API deprecation notice; jsdom emitted its known
  unsupported full-navigation diagnostic in the sidebar test.
npx eslint src/features/incentives/api/incentives.api.ts src/features/incentives/components/IncentivesDashboardView.tsx src/features/incentives/components/AttendanceBonusPanel.tsx src/features/payroll/components/PayrollDashboardView.tsx src/components/ui/dialog.tsx src/features/incentives/__tests__/incentives.api.test.ts src/features/incentives/__tests__/IncentivesDashboardView.test.tsx src/components/ui/__tests__/dialog.test.tsx
  Exit 0; no warnings or errors.
npm run build
  Exit 0; Next.js production build and TypeScript check passed.
```

Disposable database evidence from the successful combined backend run:

- The runner verified unique disposable database `incentives_test_mwkdyhpq_a0f369ec0ba7`, confirmed its run marker, and verified the application-database guard rejected the application database before running tests.
- After all 44 tests passed, the runner dropped only `incentives_test_mwkdyhpq_a0f369ec0ba7`, queried MongoDB's database listing, confirmed the exact database no longer existed, and printed `Cleanup verified: dropped only incentives_test_mwkdyhpq_a0f369ec0ba7`.
- No protected application database or production records were queried or modified.

### Release decision

**Status at this checkpoint: Pending.** The subsequent “Source-to-payroll and acceptance follow-up” below supersedes the source-to-payroll verification gaps stated in this dated checkpoint.

## Source-to-payroll and acceptance follow-up (2026-11-17)

### Implemented and verified

- Extended actual workflow integration coverage. Appointment service payment alone produces no service commission until the appointment is completed; repeated payment is idempotent, replaying the fulfillment handler returns the same accrual without duplicating it, and the resulting service ledger entry reaches payroll allocation and paid status only after manual confirmation.
- Extended unified subscription checkout through partial payment (no commission), final payment/issuance (seller-attributed commission), payment retry, payroll allocation, and manual confirmation. The test verifies the seller is distinct from the cashier.
- Extended POS retail checkout through discount allocation, partial payment (no commission), final payment plus stock issue, retry, payroll allocation/manual confirmation, and idempotent return/clawback. The net customer-payable product amount is the tested commission basis, and the POS seller is distinct from the cashier.
- Strengthened the joined membership refund/recovery journey with recorded/confirmed/reversed recovery actor, date, reason, and history assertions, alongside the existing partial/full recovery and replay checks.
- Removed the frontend `"all"` branch sentinel from staff-list and staff-earnings ledger query parameters. Branch switching now has regression evidence for summary/staff refetch and branch-specific caching. The shared Axios interceptor also sanitizes the sentinel before setting `X-Branch-Id`.
- No backend route or API request/response contract changed in this follow-up. Existing canonical permission, organization, and branch scope checks are covered by the security integration suite.

### Files changed

- Backend: `src/tests/billing/unifiedCheckoutConvergence.test.js`.
- Frontend: `src/features/incentives/components/IncentivesDashboardView.tsx`, `src/features/incentives/components/StaffEarningsTab.tsx`, `src/features/incentives/__tests__/IncentivesDashboardView.test.tsx`, and `src/features/incentives/__tests__/StaffEarningsTab.test.tsx`.
- Documentation: this status file.

### Verification run on 2026-11-17 (Windows, local workspace)

```text
From backend:
npm run test:disposable -- --runTestsByPath src/tests/billing/unifiedCheckoutConvergence.test.js src/tests/payroll/payroll.test.js src/tests/incentives/incentives.security.integration.test.js src/tests/incentives/incentives.stage5.test.js src/tests/attendance/attendancePersistence.integration.test.js src/tests/attendance/attendanceAuthorization.test.js
  Exit 0; 6 suites passed; 80 tests passed, 0 failed.
  Covers the three actual commission-source-to-payroll/manual-confirmation workflows,
  membership refund/clawback/recovery, attendance evaluation and payroll inclusion,
  reconciliation, retry/idempotency, permissions, organization isolation, and branch isolation.

From frontend:
npm test -- src/features/incentives src/features/payroll src/features/attendance/__tests__/attendance.eligibility.test.tsx src/components/ui/__tests__/dialog.test.tsx
  Exit 0; 11 files passed; 37 tests passed, 0 failed.
  Includes branch switching/all-sentinel omission, recovery and payroll confirmation UI,
  permission-sensitive actions, form states, errors/retries, attendance explanation, and dialog keyboard focus.
  Vitest emitted the existing Vite CJS deprecation notice and jsdom unsupported-navigation diagnostic.
npx eslint src/features/incentives/api/incentives.api.ts src/features/incentives/components/IncentivesDashboardView.tsx src/features/incentives/components/AttendanceBonusPanel.tsx src/features/incentives/components/StaffEarningsTab.tsx src/features/incentives/__tests__/incentives.api.test.ts src/features/incentives/__tests__/IncentivesDashboardView.test.tsx src/features/incentives/__tests__/StaffEarningsTab.test.tsx src/features/payroll/components/PayrollDashboardView.tsx src/components/ui/dialog.tsx src/components/ui/__tests__/dialog.test.tsx
  Exit 0; no warnings or errors.
npm run build
  Exit 0; Next.js production build and TypeScript check passed.
```

Disposable database evidence:

- The combined backend run verified unique disposable database `incentives_test_mwkev8s2_503070829cc0`, its run marker, and rejection of the application database by the test guard.
- Following the 80-test pass, the runner dropped only that disposable database, verified it was absent in the database listing, and printed `Cleanup verified: dropped only incentives_test_mwkev8s2_503070829cc0`.
- No protected application database was intentionally queried or modified.

### Protected-screen browser acceptance attempt (2026-11-17)

- **Environment:** Windows local workspace; isolated Next.js 16.2.11 frontend on `127.0.0.1:3167` and backend test app on `127.0.0.1:5143`. The temporary frontend copy excluded all `.env*` files and used `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:5143/api/v1`; the backend ran with `NODE_ENV=test` against a newly derived disposable MongoDB database. No production credentials, application records, or payment provider were used.
- **Synthetic permission profiles:** an org-wide test administrator with explicit Incentives and Payroll view/manage/approve/disburse permissions, and a view-only user with `branches.view`, `employees.view`, `incentives.view`, and `payroll.view`. Both profiles and synthetic branch/staff/ledger/payroll/recovery fixtures existed only in the disposable database. Neither account was authenticated in the browser; no login password was submitted.
- **Checked:** the local backend health endpoint returned HTTP 200; `GET /login` returned HTTP 200 and the server-rendered response contained the “Welcome back” heading and sign-in description. Backend logs show the fresh frontend's unauthenticated silent `/api/v1/auth/refresh` request. The browser address bar was on the local test URL, not a production host.
- **Failed / not verified:** the browser-automation page context timed out navigating to the already-running local frontend at port 3000 while API requests were redirected to the disposable backend. In the local Edge window, the isolated `/login` page on port 3167 rendered as a blank gray page; its accessibility tree exposed only an empty `RootWebArea`, despite the successful server response containing the login markup. No sign-in was attempted. Consequently the dashboard, branch switching/stale-data behavior, all-branches headers/parameters, earnings/ledger/recovery screens, permission-denied actions, payroll allocation/payment confirmation, recovery history, responsive layouts, keyboard operation, and dialog focus were **not** browser-verified. No product-code defect was attributed or changed based solely on this browser-rendering failure.
- **Exact blocker:** a supported browser session that visibly renders the local frontend and exposes its controls is required to continue protected-screen acceptance. The disposable backend and synthetic permission profiles were available; the missing dependency was browser rendering/accessibility for the local frontend, not a production credential or external payment integration.
- **Disposable database cleanup:** each created browser-test database had a unique generated name and a run marker; cleanup dropped only that named database and verified absence. Exact successful cleanup results:
  - `incentives_test_mwkhcy6r_acf881039c01` — cleanup endpoint HTTP 200; `{"cleaned":true,"databaseName":"incentives_test_mwkhcy6r_acf881039c01","absent":true}`.
  - `incentives_test_mwkhfnc2_7b2ae5898681` — cleanup endpoint HTTP 200; `{"cleaned":true,"databaseName":"incentives_test_mwkhfnc2_7b2ae5898681","absent":true}`.
  - `incentives_test_mwkhghvw_c35262f65abb` — cleanup endpoint HTTP 200; `{"cleaned":true,"databaseName":"incentives_test_mwkhghvw_c35262f65abb","absent":true}`; backend also logged `Cleanup verified: dropped only incentives_test_mwkhghvw_c35262f65abb; database absence confirmed.`
  - An earlier connection attempt failed during Atlas SRV DNS resolution before database creation or marker insertion.
- The temporary backend harness and isolated frontend copy were removed; the original frontend dependencies remained intact, and ports 5143 and 3167 had no listeners after cleanup.
- The application has no authoritative staff roster/workday calendar. Only absence-dependent conclusions from a missing attendance row remain unavailable; verified biometric attendance, approved manager reconciliation, evaluation, accrual, and payroll handling remain covered by backend tests.

**Status at this checkpoint: Pending.** Actual supported source-to-payroll and settlement workflows, membership recovery, backend scope/security, focused frontend regressions, lint, and build pass. At this checkpoint, protected-screen browser acceptance was still outstanding; see the later rendering and acceptance follow-up below. Keep no-record absence behavior disabled until an authoritative schedule source exists.

## Protected-screen rendering and acceptance follow-up (2026-11-17)

- **Environment:** Windows local workspace; isolated Next.js 16.2.11 frontend started with `next dev --webpack --hostname 127.0.0.1 --port 3167` and reported `Ready in 1092ms`; isolated backend bound to loopback port 5198 and used the uniquely marked disposable database named below. The protected browser origin/API hostname was `localhost`; no production credentials, data, or payment provider were used.
- **Rendering diagnosis:** The clean frontend rendered the login heading, email/password fields, and Sign in button, then rendered Dashboard, Incentives, and Payroll after synthetic authentication. No frontend runtime exception explained the old blank Edge page. The November 13 panic log available for inspection reports that Turbopack rejected an external `node_modules` symlink; the exact November 17 panic log from the earlier attempt had already been deleted. Therefore that older Turbopack failure is a known temporary-copy incompatibility, but the original blank Edge display's exact cause remains **unconfirmed**. In the current attempt, keyboard/pointer automation did not submit the form; calling the rendered form's `requestSubmit()` did. Switching the isolated frontend and API to matching `localhost` hostnames allowed the HttpOnly Secure/SameSite=None refresh-cookie session to survive reload. A first viewer login correctly failed because the synthetic user lacked the required active staff linkage; the viewer was linked only to the synthetic staff profile in the marked disposable database and then authenticated successfully.
- **Configuration and identities:** The frontend environment file contained `NEXT_PUBLIC_API_BASE_URL`, `E2E_ADMIN_EMAIL`, and `E2E_ADMIN_PASSWORD`; values were not printed, copied, or used for sign-in. Test accounts were synthetic accounts created by the temporary harness with a random disposable-run suffix; their password was not added to frontend configuration or reported. The synthetic administrator had explicit canonical Incentives/Payroll permissions and organization-wide access. The synthetic viewer had branch-A access with `branches.view`, `employees.view`, `incentives.view`, and `payroll.view`, but no management/disbursement permissions.
- **Branch data and query behavior:** Dashboard and Incentives screens loaded. All-branches scope showed both synthetic staff entries and ₹125 total accrual; switching to Branch A showed only its synthetic stylist and ₹100, and Branch B showed only its synthetic stylist and ₹25. Switching back to All Branches restored both entries without stale branch-only rows. Captured all-branches URLs omitted `branchId`; branch-specific URLs carried the selected real branch ID. Axios interceptor inspection confirms the frontend sanitizes `"all"` to no branch and omits `X-Branch-Id`; it never serializes `branchId=all` or `X-Branch-Id: all`. Branch-specific recovery reads carried the selected branch header.
- **Earnings, ledger, and recovery:** Employee earnings, immutable ledger history, and recovery views loaded from the disposable backend. The ledger showed the two synthetic source entries with their branch, revenue basis, amount, and fulfilled state. The recovery view showed its empty state before a fixture obligation was added, then showed the open obligation, payment history, partial state, and final recovered state.
- **Payroll allocation and settlement UI:** A synthetic November 2026 payroll period and ₹30,000 salary structure were configured through the UI for Branch A's synthetic staff member. Payroll calculation showed 30/30 synthetic reconciled attendance days and ₹30,100 total, including the existing ₹100 service-commission ledger allocation. Breakdown displayed the branch, attendance, commission source, and amount. Approval changed Draft to Approved; recording a payment attempt displayed “confirmation pending” and did not settle payroll; only after the explicit confirmation checkbox was selected did the row become Paid / Commission Settled. The reference and confirmation were synthetic acceptance data in the disposable database, not evidence that real funds moved.
- **Recovery settlement UI:** The synthetic ₹20 clawback created an open obligation. A ₹5 attempt reserved capacity without reducing recovered balance; separate manual confirmation changed the obligation to Partially Recovered with ₹5 recovered and ₹15 outstanding. A second ₹15 attempt reserved the remainder; manual confirmation changed the row to Recovered with ₹20 recovered and ₹0 outstanding. Both confirmations were test-only synthetic events, not real receipts. Confirmation controls remained disabled until their respective explicit attestation checkbox was selected.
- **Permissions and branch-scoped action defect:** The view-only synthetic user saw only Branch A, had no Create Scheme or Assign Scheme controls, and had no payroll run, approval, or payment controls. Recovery actions were replaced with the `payroll.disburse` explanation. During the administrator check, the recovery action was initially shown in All Branches mode and its write failed with `X-Branch-Id header is required to perform this action.` The backend route correctly requires an active authorized branch; the UI now disables the action in All Branches mode and tells the user to select a branch. After selecting Branch A, the synthetic recovery flow succeeded. This is the only product defect found and fixed in this browser follow-up.
- **Responsive and keyboard/focus:** At 375×812 and 1280×900, both Incentives and Payroll had document/body widths equal to the viewport (no page-level horizontal overflow); the incentive/payroll tables remained within their scrollable containers. Controls could be focused in the browser accessibility snapshot, but the integrated browser's Enter, Space, and Tab actions did not activate/traverse the focused controls. Its pointer click action also timed out; UI handlers were exercised using DOM `click()` and form `requestSubmit()`. Consequently actual keyboard operation, dialog focus trapping, and physical pointer interaction are **not verified** and remain an acceptance limitation.
- **Focused regression for the demonstrated defect:** Added a component regression asserting that an authorized recovery action is disabled with an explanation when the branch scope is `"all"` and enabled for a concrete branch.
  - From `frontend`: `npm test -- src/features/incentives/__tests__/RecoveryObligationsTab.test.tsx` — 1 file / 1 test passed; exit 0.
  - From `frontend`: `npx eslint src/features/incentives/components/RecoveryObligationsTab.tsx src/features/incentives/__tests__/RecoveryObligationsTab.test.tsx` — exit 0, no lint output.
  - No production build or broader frontend suite was rerun for this narrow fix.
- **Files changed in this follow-up:** `frontend/src/features/incentives/components/RecoveryObligationsTab.tsx`; new `frontend/src/features/incentives/__tests__/RecoveryObligationsTab.test.tsx`; this status document. No backend API contract or business rule changed.
- **Disposable cleanup:** `POST http://127.0.0.1:5198/__incentives-browser/cleanup` returned `{"success":true,"databaseName":"incentives_test_mwkitpzx_e1d62fb9b84f","absent":true}`. The harness independently verified the generated database was absent after dropping it. Ports 3167 and 5198 were confirmed clear; the temporary harness and isolated frontend copy were removed, and the original frontend `node_modules` remained present.

**Status remains Pending.** Protected screens and the synthetic payroll/recovery lifecycle were exercised, but keyboard/dialog-focus acceptance was not possible with the available browser automation, and the missing authoritative staff roster/workday source still blocks only absence-dependent conclusions. The original November 17 blank Edge rendering remains unexplained; the current local webpack frontend rendered successfully.

## Final focused acceptance verification (2026-11-17)

- **Browser availability:** The prior authenticated synthetic browser page and its isolated services were no longer available for reuse. `readPage` returned `Page ... not found`; opening `http://localhost:3167/payroll` returned `ERR_CONNECTION_REFUSED`; ports 3167 and 5198 had no listeners. I did not use production credentials/data or the existing application. Thus no new protected-screen browser keyboard session was established.
- **Keyboard/dialog automated regressions:** The shared dialog test verifies dialog initial focus, `aria-modal`, Tab from the dialog container into the dialog, Shift+Tab wrapping to the final action, and focus restoration after close. A new test verifies Escape dismissal and focus restoration. Recovery action regression verifies the All Branches action is disabled and has a branch-selection explanation; selecting a concrete branch enables it. The prior authenticated browser run exercised manual recovery after selecting Branch A; the separate browser re-check of All Branches after the guard change was not available.
- **Keyboard acceptance boundary:** Enter/Space activation of the protected-page controls, actual browser Tab/Shift+Tab traversal, dialog focus trapping/restoration/Escape, and screen-reader announcements were not verified in a live authenticated browser. Component-level dialog tests do not substitute for that browser acceptance. Form labels, accessible button names, and disabled state/title are asserted by focused component tests; actual assistive-technology announcement remains unverified.
- **Focused frontend regression suites:** From `frontend`, `npm test -- src/features/incentives/__tests__ src/features/payroll/__tests__ src/features/attendance/__tests__ src/components/ui/__tests__/dialog.test.tsx` — 13 files / 42 tests passed; exit 0. This run occurred before adding the Escape regression. After that test change, `npm test -- src/features/incentives/__tests__/RecoveryObligationsTab.test.tsx src/components/ui/__tests__/dialog.test.tsx` — 2 files / 3 tests passed; exit 0. Together these establish all 13 selected files pass, with the updated dialog suite's Escape test included.
- **Lint:** Focused ESLint on the changed recovery component/test, shared Dialog/component test, Payroll payment dialog/tests, and Attendance workspace/eligibility test passed with exit 0. The broader command `npx eslint src/features/incentives src/features/payroll src/features/attendance src/components/ui/dialog.tsx src/components/ui/__tests__/dialog.test.tsx` exited 1 due to existing findings outside the final narrow changes: `incentives.navigation.test.ts` has an unused `CANONICAL_PERMISSIONS` import warning and two `no-explicit-any` errors; `CalculationPreviewDialog.tsx` has two `no-explicit-any` errors and a `react-hooks/set-state-in-effect` error. These unrelated-to-this-fix files were not changed.
- **Production build:** From `frontend`, `npm run build` — exit 0; Next.js 16.2.11 compiled, type-checked, and generated production routes. The build was run after the recovery branch guard was added; subsequent changes were limited to tests and documentation.
- **Files reviewed/changed in the final acceptance follow-up:** `frontend/src/features/incentives/components/RecoveryObligationsTab.tsx`, `frontend/src/features/incentives/__tests__/RecoveryObligationsTab.test.tsx`, `frontend/src/components/ui/__tests__/dialog.test.tsx`, and this status document. No API contract, backend authorization, payment model, or absence policy changed. Other existing dirty/untracked project work was left untouched.

**Final status: Pending.** Functional synthetic finance workflows and the focused regression suites/build pass, but authenticated browser keyboard acceptance is not verified because the isolated services/session were cleaned up and no active session is available. The broader Incentives ESLint command also remains non-clean for the specific findings above. Keep absence-dependent attendance outcomes blocked until an authoritative staff roster/workday source exists; never infer absence from a missing attendance record.

## Final MVP closure check (2026-11-17)

| Acceptance check | Result | Evidence |
| --- | --- | --- |
| Incentives recovery keyboard traversal, visible focus, Enter/Space activation | **Pending** | The shared browser tab was at `chrome-error://chromewebdata/`; ports 3167 and 5198 had no listeners. No authenticated isolated session was available. |
| All Branches recovery action disabled with explanation | **Verified in component regression** | `RecoveryObligationsTab.test.tsx` verifies disabled state and the branch-selection title/message for `"all"`; the branch-specific action is enabled. Earlier synthetic browser interaction recorded and confirmed recovery after selecting Branch A. No live All Branches browser re-check was possible in this pass. |
| Payroll payment action keyboard activation and duplicate confirmation | **Pending in browser; duplicate in-flight guard covered by test** | Added a regression proving the confirmation button stays disabled while `isConfirming` and does not call `onConfirm` from a duplicate click. Prior synthetic browser session demonstrated separate attempt/confirmation/settled states. Live Tab/Enter/Space activation and backend duplicate confirmation were not exercised in this pass. |
| Recovery/payroll dialog Escape and focus restoration | **Partially verified** | Shared Dialog component tests verify initial focus, `aria-modal`, Tab/Shift+Tab trapping, Escape dismissal, and focus restoration. These are component tests, not browser acceptance of each payment dialog. |
| Keyboard cannot tab outside modal | **Partially verified** | Component regression exercises Tab from the dialog container and Shift+Tab wrapping to the last action. No authenticated browser traversal was available. |
| Accessible names/disabled state | **Component-tested; screen-reader audit deferred** | Focused tests query named controls and assert disabled state/title. Announcement behavior with assistive technology was not tested; broader screen-reader audit is deferred. |
| Focused regressions | **Pass** | Command below: 4 files, 10 tests; exit 0. |
| Focused ESLint | **Pass** | Command below; exit 0. Broader-module lint findings remain as stated in the previous section. |
| Production build | **Pass** | `npm run build`; exit 0, Next.js 16.2.11 compiled, type-checked, and generated routes. |

Commands from `frontend`:

```text
npm test -- src/components/ui/__tests__/dialog.test.tsx src/features/incentives/__tests__/ManualRecoveryPaymentDialog.test.tsx src/features/incentives/__tests__/RecoveryObligationsTab.test.tsx src/features/payroll/__tests__/PayrollPaymentDialog.test.tsx
  4 files passed; 10 tests passed; exit 0.

npx eslint src/components/ui/dialog.tsx src/components/ui/__tests__/dialog.test.tsx src/features/incentives/components/RecoveryObligationsTab.tsx src/features/incentives/__tests__/RecoveryObligationsTab.test.tsx src/features/incentives/components/ManualRecoveryPaymentDialog.tsx src/features/incentives/__tests__/ManualRecoveryPaymentDialog.test.tsx src/features/payroll/components/PayrollPaymentDialog.tsx src/features/payroll/__tests__/PayrollPaymentDialog.test.tsx
  exit 0; no findings.

npm run build
  exit 0.
```

Files changed in this focused pass: `frontend/src/features/payroll/__tests__/PayrollPaymentDialog.test.tsx` (duplicate in-flight confirmation regression) and this status document. No production component, API, backend authorization, payment-provider integration, or attendance behavior changed. The previously added recovery branch guard and regression were reviewed and covered by the focused suite.

**Recommended module status: Pending.** The exact remaining acceptance dependency is a freshly provisioned, marked disposable backend/database plus synthetic authenticated session for live keyboard testing; the supplied browser page is an error page and the old isolated services/database were cleaned up. Until that safe environment is available, protected-screen Tab/Enter/Space and modal focus behavior cannot be claimed as browser-verified. Keep screen-reader auditing deferred and do not infer absence from missing attendance records.

## Resumed isolated keyboard acceptance attempt (2026-11-17)

- **Setup inspected:** `backend/scripts/incentivesBrowserAcceptanceHarness.mjs` was absent from the workspace because it had been removed during prior cleanup. Reused the setup documented above and the marker/database-path guard pattern in `backend/src/tests/runDisposableTests.js`; temporarily restored that one-off harness (not a new framework), and removed it again after cleanup. The frontend was copied to session state with all `.env*`, `.next`, and `.git` files excluded; dependencies were linked via a junction to the existing frontend `node_modules`. Next.js used webpack. No production credentials or source-database contents were used.
- **Isolated services:** Backend health returned success with `mode=disposable-test` and database `incentives_test_mwkobf05_1b29e8aaa488`. The database name was unique, generated from a random run ID, ownership marker inserted and read back, and the URI was verified to differ from the configured source URI only by the database path. Backend bound to loopback port 5198; frontend started at `http://localhost:3167` with runtime `NEXT_PUBLIC_API_BASE_URL=http://localhost:5198/api/v1`. The clean login page rendered the expected email/password controls. Backend logs showed its unauthenticated refresh request with Origin `http://localhost:3167`, confirming the test page targeted the isolated backend.
- **Synthetic identities:** The temporary database contained a synthetic administrator with explicit canonical Incentives/Payroll permissions and a read-only synthetic viewer scoped to Branch A. No credentials were used for sign-in during this attempt; no real user identity was used.
- **Browser keyboard result:** **Blocked before protected-page access.** The shared browser tab supplied at the start was `chrome-error://chromewebdata/`. The integrated browser opened the isolated frontend's login page, but the available native CUA Chrome window was a separate `localhost:3000` network-error page with an empty read-only web area and no screenshot surface. Changing that window's address field to the isolated login URL did not load the app. In the integrated automation page, `Tab` and locator `press('Tab')` left focus on the email input; no authenticated browser session was established. Therefore recovery action focus/Enter/Space, All Branches disabled state in browser, payroll confirmation keyboard behavior/duplicate handling, and Escape/focus restoration on both real dialogs were **not tested in this attempt**. Component regressions from the previous pass remain the only keyboard/focus evidence.
- **Tests and code changes:** No production component/API/test code changed in this attempt, so the focused recovery/payroll/dialog tests, ESLint, and production build were not rerun. The earlier focused run remains 4 files / 10 tests passing, focused ESLint exit 0, and production build exit 0. `node --check backend/scripts/incentivesBrowserAcceptanceHarness.mjs` succeeded as part of harness startup. Only this status document is retained from the attempt.
- **Cleanup:** The loopback cleanup endpoint returned `{"success":true,"databaseName":"incentives_test_mwkobf05_1b29e8aaa488","absent":true}` after dropping the marker-identified test database and confirming its absence in the database listing. This also removed the temporary synthetic users and fixtures. Backend exited after cleanup; frontend was stopped. Verification showed ports 3167 and 5198 clear, the run metadata file absent, the temporary harness absent, the isolated frontend copy removed, and the original frontend dependencies still present. No disposable test database remains from this attempt.

**Status at this checkpoint: Pending.** The concrete remaining dependency for live keyboard acceptance was a browser-control surface that could send real keyboard input to the authenticated isolated frontend; the supplied browser page was an error page, while the CUA window resolved to an unrelated localhost:3000 error surface. Do not interpret that attempt as browser verification. The subsequent MVP decision below explicitly defers keyboard acceptance and the broader screen-reader audit; manual payment confirmation and the no-absence-inference rule are unchanged.

## MVP closure decision (2026-11-17)

**Final status: Verified for MVP — Incentives only.** This status reflects the approved MVP scope and the implementation, focused automated regression, lint/build, source-to-payroll, recovery, authorization/branch-isolation, and prior protected-screen evidence recorded above. It does not mean every item in the dated audit history passed, nor does it mean the full ERP is complete.

- **Automated verification:** The documented focused backend run passed 6 suites / 80 tests; the focused frontend run passed 11 files / 37 tests; focused ESLint and the frontend production build passed. The later focused dialog/recovery/payroll run passed 4 files / 10 tests, with focused ESLint and production build also passing. See the dated verification sections for exact commands and scope.
- **Protected browser verification:** Previously recorded synthetic browser checks exercised branch-scoped data, ledger/recovery, payroll manual settlement, permissions, and responsive overflow. The latest resumed attempt rendered the isolated login page but could not establish authenticated access or operate keyboard controls; it is recorded as blocked, not passed.
- **Explicitly deferred post-MVP:** Live keyboard acceptance (Tab/Shift+Tab, Enter/Space, and dialog keyboard/focus behavior) and the broader screen-reader audit. These checks were not verified and are not blockers to this MVP decision.
- **Separate capability limitation:** There is no authoritative staff roster/workday source, so no-record absence conclusions remain unavailable. Missing attendance rows must never be treated as absence; this limitation does not block unrelated supported commission and payroll workflows.
- The current-release manual payment confirmation model remains unchanged. No external payment provider, new commission category, attendance absence rule, API, permission, or business logic is introduced by this status decision.
