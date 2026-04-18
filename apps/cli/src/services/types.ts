/**
 * Services wiring contract.
 *
 * Every command handler receives a `Services` object. In Phase 1.D the real
 * implementations don't exist yet (persistence is mid-flight in 1.B;
 * supervisor lands in Phase 3). Commands that need un-implemented services
 * print a friendly "not available yet" notice and exit with INTERNAL.
 *
 * Phase 6 follow-up: `Logger` now re-exports `@shamu/shared/logger.Logger`
 * directly so the CLI's stub and the integration-layer consumers (Linear
 * runtime, etc.) share ONE concrete type. Previously the stub was a
 * duck-typed interface and downstream packages that wanted the real class
 * had to construct a second `createLogger(...)` instance; now every caller
 * gets the same object.
 */

import type { Logger as SharedLogger } from "@shamu/shared/logger";
import type { ShamuConfig } from "../config.ts";

/**
 * Alias for the shared `Logger` class. Kept as a type-only re-export from
 * this module so existing imports (`import type { Logger } from
 * "../services/types.ts"`) continue to compile without churn.
 */
export type Logger = SharedLogger;

/**
 * Persistence handle. In Phase 1 this is an opaque type — the shape comes from
 * `@shamu/persistence` in 1.B. Commands that read from persistence should
 * check for `null` (not yet wired) and exit with a clear message.
 */
export type PersistenceHandle = {
  readonly __brand: "PersistenceHandle";
};

/**
 * Supervisor handle. Lands in Phase 3. Commands like `kill`, `attach` need it;
 * they should check for `null` and exit with a clear "lands in Phase N" notice.
 */
export type SupervisorHandle = {
  readonly __brand: "SupervisorHandle";
};

/** Services bundle threaded to every command. */
export interface Services {
  readonly config: ShamuConfig;
  readonly logger: Logger;
  readonly persistence: PersistenceHandle | null;
  readonly supervisor: SupervisorHandle | null;
}
