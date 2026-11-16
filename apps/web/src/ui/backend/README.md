# Existing-service connection panel

`BackendPanel` connects the existing `/v1` FastAPI service; it does not introduce another API or replace the molecular editor.

```tsx
import { BackendPanel } from './ui/backend';

<BackendPanel
  initialBaseUrl="http://127.0.0.1:8787"
  onClientChange={(client) => { /* optional: share this in-memory client with Laboratory */ }}
  onChooseCompound={(compound) => { /* optional: open compound.canonical_smiles in the existing editor */ }}
/>
```

The component imports its own scoped CSS and reuses `ui/kit`. Mount it in a dialog or settings page; it needs neither a router nor a state provider.

- Connection verifies `/health` (including PostgreSQL) and `/v1/engines`. Failed checks never report a successful remote save.
- The bearer input stays in component memory. Neither URL nor credentials are automatically persisted. Editing the connection clears prior catalogue/preview state.
- Catalogue uses `/v1/compounds` and `/v1/elements`, preserving source records and the service's evidence labels. Matching formula/name is not proof of chemical identity or novelty.
- Excel uses `/v1/excel/format`, `/export`, and `/import`. Preview always sends `dry_run=true&atomic=true`; commit requires the same file, SHA-256, service instance and a valid preview. Files are limited to 10 MiB in this UI.
- The legacy workbook covers the shared local **v1** database. Owner-scoped Laboratory data uses the separate scene export API, not the legacy workbook.
- Non-loopback services require HTTPS. CORS must explicitly allow the UI origin. Existing `/v1` endpoints remain a local-development contract; deploy an authenticated gateway before exposing them publicly.

The typed `ScienceClient` is exported from `services/science-client.ts`. Reusing it with `new LabApiClient(client)` shares only the in-memory connection, not application ownership or mutable scene state.
