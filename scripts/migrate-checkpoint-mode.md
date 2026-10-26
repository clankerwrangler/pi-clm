# Migrate an ordinary-order CLM checkpoint to native order

`migrate-checkpoint-mode.mjs` is an offline operational helper. It creates no actor,
provider connection, kernel, user input, or tool execution. The caller supplies the
exact SDK, harness, and CLM source roots. The helper compares both explicit replay
modes; it does not certify the live model's routing configuration.

The helper requires the selected H key format and no system contributions. It
accepts only the existing ordinary replay transformation that relocates asynchronous
results immediately after their issuing calls. Every contribution must retain its
immutable source identity and full canonical SHA-256 value. No contribution may
cross the checkpoint frontier. The suffix must retain its exact order. An exact
old-mode prefix digest authorizes reuse of the accepted projection; retry-error
removal and arbitrary reordering are not supported.

## Validate

```sh
node --max-old-space-size=768 scripts/migrate-checkpoint-mode.mjs \
  --session /absolute/session.jsonl \
  --harness-root /absolute/persistent-harness \
  --sdk-root /absolute/pi-coding-agent \
  --clm-root /absolute/pi-clm \
  --receipt /absolute/new-validation.json
```

Default validation writes only the new, private receipt. It reads the original
archive and verified checkpoint bodies without copying history. The receipt binds
the source's identity, bytes, leaf, revision, selected source-module hashes, relation
proof, and proposed effective-view digest. It is not a complete loaded-module
attestation. Inspect actual model, environment, and routing flags separately.

## Append under exclusive writer control

Stop every writer before validating for mutation. Revalidate after stopping:
shutdown may append ordinary session metadata and invalidate an earlier receipt.
Keep the archive and all referenced checkpoint artifacts in place. No service
control is included in this helper.

Repeat the validation command with these additional arguments and a **new** receipt
path:

```sh
--append --confirm-exclusive-writer-stop --approved-receipt /absolute/new-validation.json
```

Append mode verifies the approved receipt again. It publishes verified checkpoint
bodies through existing CLM storage, seals and syncs `<receipt>.intent.json`, and
appends one standard `live-context-state` entry using the public SDK. The new
checkpoint covers the complete native source and retains the exact old accepted
projection plus ordered suffix. Enablement and any enable/disable event are
preserved; estimates remain advisory and unchanged. The outcome becomes a migration
outcome, as in the standard CLM rebase path. No raw entry is rewritten.

Afterward, run the default validation command in a fresh process, with another new
receipt and `--approved-receipt` pointing to the pre-append validation receipt. It
must report `already-valid`, the expected revision, unchanged effective-view digest,
and preserved original byte prefix. Repeating append after successful migration is
a no-op.

An error after append attempt reports `append.performed` as `true` or `null` and
`reconcileBeforeRetry: true`; do not retry mutation blindly. Keep the durable intent
and run validate-only reconciliation first. An error before append leaves the
canonical archive untouched, although optional new checkpoint body files can exist.
Unexpected error details are suppressed rather than exposing transcript fragments.

## Focused verification

```sh
node --test scripts/migrate-checkpoint-mode.test.mjs
node scripts/migrate-checkpoint-mode.integration.mjs \
  --sdk-root /absolute/pi-coding-agent \
  --harness-root /absolute/persistent-harness \
  --clm-root /absolute/pi-clm \
  --scratch-dir /absolute/designated-scratch
```

The integration fixture uses only public synthetic values. It checks actual
SDK/H/CLM append, a fresh-process physical read, idempotence, authorization bypass
rejection, and reconciliation after a committed append whose final receipt fails.
`spec/ModeMigration.tla` covers the finite acceptance, suffix, archive, freshness,
intent-before-append, and one-revision relations. Its bad-proof configuration must
violate `ProvenOnly`.
