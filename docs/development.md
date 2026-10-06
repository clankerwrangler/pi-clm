# Development

Use Node 22+ and pnpm through corepack. Development dependencies pin Pi 0.99.1;
the loading Pi installation supplies the public SDK at runtime.

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm check   # strict TypeScript check and all tests
```

The tests cover projection validation, broad mixed-history editing and in-flight call admission, late file submissions,
direct-tool completion and I/O races, final settlement/reopen and source-space deferral,
conflicts and snapshot expiry, disabled-mode compaction, artifact lifetime and failures,
public prompt options, helper exposure, settings, and the viewer. Tests do not require
provider credentials. Local mock lifecycle tests are not evidence of a live provider run.

## Safety models

[spec/README.md](../spec/README.md) documents the finite TLA+ models, checked before the
corresponding implementation, and their limitations. Set `TLA_TOOLS_JAR` to a local TLA+ tools jar. Current receipts use TLC
2026.09.04.170753; the headerless-replacement update also passes with TLC 2.19
(2024-08-08). No model checker is downloaded by tests.

## Try a checkout

```sh
pi -e /path/to/pi-clm/index.ts
```

Do not load multiple versions of pi-clm, or another extension using the same
`live-context-*` session entry types, in one session. Prefer one context-management
policy: independently transforming extensions may invalidate a source prefix, and
provider-stage transformations are outside this extension's budget view.

This fork is source-only and `private: true`; no npm publication is configured for it.
Keep upstream attribution and history when contributing. Tests use the public Pi SDK,
not APIs of another host or context manager.
