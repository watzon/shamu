<!--
  GENERATED FILE — DO NOT EDIT.

  Source of truth: each adapter's `src/capabilities.json` manifest.
  Regenerate with:

    bun scripts/generate-capability-matrix.ts

  The generator consumes each adapter's `capabilities.json` from
  `packages/adapters/<name>/src/capabilities.json` and runs
  `buildCapabilityMatrix` + `renderCapabilityMatrixMarkdown` from
  `@shamu/adapters-base/capability-matrix`.
-->

# Adapter capability matrix

Every Shamu vendor adapter ships a frozen `capabilities.json` manifest
(PLAN.md § 1 / G8 — capabilities are declared at build time and
immutable at runtime). The shared contract suite keys scenario skip /
run decisions off these fields, and the matrix below is the canonical
"which adapter supports what" view.

## Schema

The schema lives in `packages/shared/src/capabilities.ts`. The columns
used below come in two flavors:

- **Feature parity** — boolean columns derived from the
  `CapabilityFeature` predicates in
  `packages/adapters/base/src/capabilities.ts`. These are the
  features the contract suite's `scenario.requires` list keys off;
  a `no` here means the adapter opts that scenario out of its
  contract run.
- **Enum / detail fields** — the underlying union types. They show
  _how_ the adapter satisfies a capability (e.g., `interrupt: "cooperative"`
  vs `"hard"` vs `"none"`), which matters when picking a vendor for
  a specific workflow but isn't reducible to a single bool.

## Matrix

### Feature parity

| Adapter | resume | fork | interrupt | customTools | patchEvents | streamingEvents | usageReporting | costReporting |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| echo | yes | no | yes | no | yes | yes | yes | yes |
| claude | yes | no | yes | yes | yes | yes | yes | yes |
| codex | yes | no | yes | no | yes | yes | yes | yes |
| opencode | yes | yes | yes | yes | yes | yes | yes | yes |
| cursor | yes | no | yes | no | yes | yes | yes | yes |
| gemini | yes | no | yes | no | yes | yes | yes | yes |
| amp | yes | no | yes | no | yes | yes | yes | yes |
| pi | yes | yes | yes | no | yes | yes | yes | yes |

### Enum / detail fields

| Adapter | interrupt | mcp | permissionModes | patchVisibility | usageReporting | costReporting | sandboxing | streaming |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| echo | cooperative | none | default, acceptEdits | events | per-turn | computed | process | events |
| claude | cooperative | in-process | default, acceptEdits, plan, bypassPermissions | events | per-turn | native | process | events |
| codex | cooperative | stdio | default, acceptEdits | events | per-turn | subscription | process | events |
| opencode | cooperative | stdio | default, acceptEdits | events | per-turn | subscription | process | events |
| cursor | cooperative | none | default, acceptEdits | events | per-turn | subscription | process | events |
| gemini | cooperative | none | default, acceptEdits | events | per-turn | subscription | process | events |
| amp | cooperative | none | default | events | per-turn | subscription | process | events |
| pi | cooperative | none | default, acceptEdits | events | per-turn | subscription | process | events |
