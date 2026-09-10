// Fase 5.6.1 — registra o resolve hook `prod-bootstrap-loader.mjs`.
// `node --import ./scripts/prod-bootstrap-loader-register.mjs <script>`
import { register } from "node:module";
register("./prod-bootstrap-loader.mjs", import.meta.url);
