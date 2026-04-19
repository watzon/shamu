/**
 * Echo adapter — no vendor CLI.
 *
 * Echo runs entirely in-process (scripted event stream). It declares an
 * empty descriptor so `shamu doctor --resolve-clis` reports it as
 * "no binary required" and the resolver short-circuits without touching
 * the filesystem.
 */

import type { VendorCliDescriptor } from "@shamu/adapters-base";

export const echoVendorCliDescriptor: VendorCliDescriptor = {
  adapter: "echo",
  binaryNames: [],
  candidates: [],
};
