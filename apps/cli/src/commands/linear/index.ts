/**
 * `shamu linear` — parent group for Linear integration subcommands.
 *
 * Phase 6.C.3 landed the full work-intake loop:
 *   - `tunnel`     — cloudflared wrapper for local webhook delivery.
 *   - `serve`      — daemon: picks up `shamu:ready`, runs the canonical
 *                    flow, manages labels + rolling comments.
 *   - `attach-pr`  — manual attach of a PR URL to a Linear issue.
 */

import { defineCommand } from "citty";
import { linearAttachPrCommand } from "./attach-pr.ts";
import { linearServeCommand } from "./serve.ts";
import { linearTunnelCommand } from "./tunnel.ts";

export const linearCommand = defineCommand({
  meta: {
    name: "linear",
    description: "Linear integration (tunnel, serve, attach-pr).",
  },
  subCommands: {
    tunnel: linearTunnelCommand,
    serve: linearServeCommand,
    "attach-pr": linearAttachPrCommand,
  },
});
