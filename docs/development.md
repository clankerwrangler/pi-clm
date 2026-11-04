# Development

Use Node 22.19.0+ and pnpm 10.2.1, as pinned by `package.json`. With Corepack installed:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm check   # strict TypeScript check and all tests
```

The tests cover projection validation, broad mixed-history editing and in-flight call admission, late file submissions,
direct-tool completion and I/O races, final settlement/reopen and source-space deferral,
conflicts and snapshot expiry, disabled-mode compaction, artifact lifetime and failures,
public prompt options, helper exposure, settings, and the viewer. Source-mode
fixtures also check 16 captured drafts, exact full values after source expiration
and overwrite, canonical/projected prefix reuse, historical checkpoint ownership,
failed capture, exclusive-create collisions, and final-owner cleanup. Real SDK integration
checks persisted source sessions, all three archive-restore paths, accepted-context
compaction with canonical suffix anchors, pending-edit preservation, and shared Pi
package identities. Ordinary array dispatch and source dispatch run against the same
matched graph. Tests do not require provider credentials or model network access.
They are not evidence of a live provider run.

To run only the SDK boundary checks:

```sh
corepack pnpm exec tsx --test src/__tests__/sdk-integration.test.ts
```

## SDK compatibility

The extension is loaded from TypeScript source; there is no compile or bundle step.
`package.json` selects the root `index.ts`, which enables CLM editing policy. Loading
`src/index.ts` directly uses the conservative policy instead.

The host supplies the public Pi SDK at runtime. Development uses content-addressed tarballs
from the [sdk-v1.5.0-9172355e snapshot](https://github.com/clankerwrangler/pi/releases/tag/sdk-v1.5.0-9172355e).
Its [artifact manifest](https://github.com/clankerwrangler/pi/releases/download/sdk-v1.5.0-9172355e/manifest.json)
records source commit `9172355e560cda5d738cc49c1660764268bc2fb7` and package integrities;
locked integrity values enforce byte identity. The snapshot retains the source APIs
implemented at `1723ab716f3856d3e07a8fa1e8a9aae36f6f6c58`.
All direct and transitive Pi packages are pinned through `package.json` and its
`pnpm.overrides` map. Keep these overrides together when updating the snapshot.
Retain the reviewed release URLs and manifest SHA-512 integrities in the lock; pnpm
10.2.1 can resolve new tarball URLs to expiring CDN redirects. Verify a fresh-store
frozen install and an ordinary install without lock changes before accepting an update.
Stock npm packages with the same `1.5.0` version do not provide this fork's source APIs.
The pinned pnpm 10.2.1 reads overrides from `package.json`, not `pnpm-workspace.yaml`.

Use the [SDK fork build guide](https://github.com/clankerwrangler/pi/blob/sdk-1.5.0/FORK.md)
on `clankerwrangler/pi` branch `sdk-1.5.0` when building an alternative coherent package set.
The package's wildcard peer declarations do not guarantee every Pi release is compatible.

The host must opt into source-backed sessions and call source-aware context/end
dispatch to use that path. The keyed archive reader (`buildSessionEntryReader`) is
feature-detected; older SDKs use `buildSessionEntrySource` or full-branch restoration.
Read-only accepted compaction also requires source dispatch with `purpose: "compaction"`
and the matching SDK's `prepareCompactionFromSource` integration. A Pi version number
alone does not enable these features. Ordinary installations keep their array hooks.

To run the public ownership probe against a source-aware SDK:

```sh
node --expose-gc --import tsx spec/reader-recovery-probe.ts \
  /path/to/pi-coding-agent/dist/programmatic.js /path/to/pi-clm 65536
```

Run it in a fresh process. It creates and removes its own synthetic JSONL and mirror;
it does not open existing sessions. Retained-heap deltas exclude initial SDK archive
indexing. Header counts include temporary branch-selection work; candidate counts do
not count capture-internal detached copies or the active projection.

## Safety models

[spec/README.md](../spec/README.md) documents the finite TLA+ models, checked before the
corresponding implementation, and their limitations. Set `TLA_TOOLS_JAR` to a local
TLA+ tools jar. No model checker is downloaded by tests.

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
