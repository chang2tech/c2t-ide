# ide-agent — built-in AI agent extension (scaffold)

Built-in extension for the ide-code VS Code fork. Mirrors Cursor 3.25.6's
agent command surface under the `ide.*` namespace, with the chat UI
architecture recovered by REA static analysis (`docs/rea/deep-composer-ui.md`).

## Architecture (3 tiers, mirrors Cursor's composer stack)

```
src/
  extension.ts            — activation: wires services, registers commands,
                            chat participant (@ide), webview + tree providers
  services/
    composerDataService.ts — central hub (like composerDataService): owns the
                             store, applies engine TurnEvents, emits deltas
    modeService.ts         — unifiedMode enum
    humanReviewService.ts  — tool-call approval cards (options/reasons)
    checkpointService.ts   — per-message snapshots, checkout_to_message
    messageQueueService.ts — queue-while-running + multitask fan-out
    agentService.ts        — EngineAdapter seam + StubEngineAdapter
  stores/
    bubbleStore.ts         — ComposerBubbleSetStore: Map keyed by bubbleId,
                             dual client/server identity, toolCallId→bubbleId
                             index. No single immutable transcript array.
  components/
    composer.ts            — createComposer factory (webview HTML/JS)
    bubble.ts              — bubble / tool-call-card view-model helpers
```

The renderer (webview script) keeps its own `Map<bubbleId, {data, el}>` and
patches the DOM per bubble on each delta — the same fine-grained pattern that
makes Cursor's streaming cheap. Extension → webview messages: `state`
(full reset), `bubbles` (changed bubbles), `approval`, `queue`, `mode`.

**Engine seam:** `EngineAdapter.runTurn()` in `services/agentService.ts`.
`StubEngineAdapter` scripts one full turn (thinking → tool-call card with a
real approval round-trip → chunked text → server-id reconciliation). Replace
it with the ide-code core adapter; the UI contract is `TurnEvent`.

## Naming — 3.25.6-era vocabulary (from deep-changelog-timeline.md)

"Composer" meant three different things across Cursor eras, so it is NOT used
as a user-facing label. Era-correct mapping:

| Era | Old name | 3.25.6 name | Our `ide.*` |
|---|---|---|---|
| 0.37–0.45 multi-file UI | Composer | Agent | `ide.newAgentChat`, `ide.agent.*` config |
| 0.46 mode unification | Chat → Ask | (Ask) | mode `chat` internally, label "Chat" |
| 0.46 mode unification | Composer → Edit | (Edit) | mode `edit` |
| 0.48 | Edit → Manual | Manual | (kept as `edit` = manual-style edits) |
| 0.39 | Copilot++ | Tab | `ide.tab.*` config (not `cpp`) |
| 0.45 | .muserules / .cursorrules | .cursor/rules/*.mdc | rules live in `.cursor/rules/` |
| 2.0+ | Composer (recycled) | proprietary model family | never referenced |

Internal mode enum (from the 3.25.6 binary): `agent, chat, edit, debug,
background, multitask`.

## Removed features — deliberately NOT implemented

| Feature | Removed in Cursor | Instead |
|---|---|---|
| Notepads | 2.0 | rules / commands / memories |
| Worktree dropdown UI | 3.0 | `/worktree` + `/best-of-n` slash commands (`ide.worktreeCommand`) |
| @Codebase in Ask | 0.48 | Ask auto-searches the codebase |
| Cloud agents inside the Editor | 3.0 | Agents Window (later phase) |

## Build order (bedrock first)

Cmd+K → Tab → Agent → checkpoints → rules → MCP → browser → Agents Window → plugins.
Server-side items (model catalog/routing, cloud agents, billing) are replaced
by our own ide-code backend, never cloned.

## Scaffold status

Every command/keybinding/view is real and registered. Behaviors needing the
engine show a visibly labeled "engine wiring pending" notice — no silent
no-ops. The chat webview is fully interactive (modes, mentions, slash palette,
approvals, checkpoints, queue, context tray) against the stub engine.

## Typecheck

```sh
npm i --no-audit --no-fund   # @types/vscode + typescript only
npm run check                # tsc --noEmit
```
