/**
 * SolidJS SPA entry.
 *
 * Renders into `#app` in `index.html`. Router lives under `/` (swarm list)
 * and `/run/:id` (run detail).
 */

import { Route, Router } from "@solidjs/router";
import { render } from "solid-js/web";
import { App } from "./app.tsx";
import { RunDetail } from "./routes/run-detail.tsx";
import { SwarmOverview } from "./routes/swarm-overview.tsx";

const root = document.getElementById("app");
if (!root) {
  throw new Error("shamu web: missing #app root");
}

render(
  () => (
    <Router root={App}>
      <Route path="/" component={SwarmOverview} />
      <Route path="/run/:id" component={RunDetail} />
    </Router>
  ),
  root,
);
