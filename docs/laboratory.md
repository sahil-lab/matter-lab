# Instrument laboratory

Use **Laboratory** in the molecular editor's top bar. The instrument room is a separate
meter-scale scene; returning to Molecular preserves the open molecular document.

## First titration

1. Open the assembled titration. It contains empty apparatus, not precomputed measurements.
2. Select **Prepare reference solutions** to record virtual preparation of 25 mL 0.1 mol/L HCl
   and 50 mL 0.1 mol/L NaOH at 298.15 K.
3. Immerse the pH probe using the preparation controls. A probe does not measure merely because
   its mesh is near a flask; the runtime validates its connection and immersed tip.
4. Run the station, then open the valve. The graph transfers liquid from burette to flask;
   pH, concentration, delivered volume and indicator fraction come from that accepted inventory.
5. Close the valve before capturing an endpoint. Pause stops all transfers; it is not evidence
   that the valve was actually closed. A metered virtual dose is also supported while running.
6. The ideal reference equivalence is 25 mL and pH approximately 7. A color endpoint is not
   automatically equivalence: its threshold and indicator assumptions are recorded separately.

This is a numerical teaching model, not instructions for handling real reagents.

## Build and edit

Choose **New empty laboratory** for empty benches. Drag equipment from the palette, or select a
palette item and use the inspector's accessible numeric placement controls. Translation is in
meters; the placement grid and angle controls are explicit.

Mechanical mounts connect compatible sockets: stand to clamp, clamp to burette, and stirrer
platform to flask. Fluid and sensor connections are separate. A connection does not teleport
liquid or repair a misaligned apparatus. Use the inspector's precise transform and socket controls
when a pointer placement is ambiguous.

Select, move, rotate, group, lock, duplicate and preparation undo are available. Reset is a
separate runtime operation with a new epoch; it is not an undo of consumed liquid. Duplicating
an empty station creates a new experiment scene; the previous experiment is preserved as a local
draft instead of rewriting its history.

21 original apparatus definitions include glassware, supports, probes and accessories. Geometry
does not imply a supported scientific model: heating, conductivity and arbitrary reactions are
explicitly unsupported. Use the science panel to inspect support reasons.

## Guidance and display

Guided, free, challenge and precision modes read the same accepted actions and observations.
Advancing tutorial text does not complete an experimental goal. Precision trials retain actual
endpoint observations and compute their statistics from recorded trials.

Room/studio, orbit/top-down/inspection views, quality and reduced motion are presentation choices.
Low quality removes expensive glass transmission and decorative movement without changing
inventory, elapsed simulation time or results. WebGPU is experimental; WebGL 2 is the fallback.

## Save, reopen and replay

- **Local draft / JSON:** a validated scene, initial conditions, event history, observations,
  editor state and learning notebook. Automatic drafts are device-local and not confirmed remote
  saves. Reopening validates replay and pauses the restored station.
- **PostgreSQL:** start the stack with `.\tools\start-science.ps1`, retrieve the local token
  deliberately with `-ShowToken`, then use **Connect science**. Credentials stay in memory.
  The notebook saves an owner-scoped revision; conflicting edits are reported instead of
  overwritten. Offline drafts remain explicitly local.
- **Server replay:** the backend runs the exact same versioned TypeScript solver/runtime against
  recorded initial conditions and actions. Its own result and observations are stored immutably.
- **Excel:** exports contain the saved scene, apparatus, connections, conditions, observations,
  titration data, sources and metadata. Spreadsheet output is an interchange/report, not an
  alternative authoritative runtime.

See [the API/authentication details](../services/science/LABORATORY.md) and
[scientific limitations](scientific-limitations.md). This is a finite supported laboratory:
scene/resource limits are validated, and unsupported chemistry is never replaced with decorative
results.
