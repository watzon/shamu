/**
 * App shell — header + active-route outlet. Kept deliberately minimal; any
 * per-page chrome lives in the route components.
 */

import { A } from "@solidjs/router";
import type { ParentComponent } from "solid-js";

export const App: ParentComponent = (props) => {
  return (
    <div class="shell">
      <header class="shell__header">
        <div class="shell__brand">
          <A href="/" class="shell__title">
            shamu
          </A>
          <span class="shell__subtitle">web dashboard</span>
        </div>
        <nav class="shell__nav">
          <A href="/" end>
            runs
          </A>
          <A href="/new-run">new run</A>
        </nav>
      </header>
      <main class="shell__main">{props.children}</main>
      <footer class="shell__footer">127.0.0.1 only — local control surface</footer>
    </div>
  );
};
