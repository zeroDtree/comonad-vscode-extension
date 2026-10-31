# Graphs

The inner loop of a turn is a compiled Mermaid graph: the model call, the policy gate, the approval
suspension, the tool step and the routes between them. The source lives in the `comonad.graph`
setting; an empty value uses the shipped `agent` loop. A source may hold several named graphs:

```mermaid
%% default: agent

%% graph: agent
flowchart LR
  %% start: llm
  llm["llm.complete"] -->|route: agent.after-llm| calls["agent.calls"]
  llm -->|route: agent.after-llm| End
  calls --> gate["agent.gate"]
  gate -->|route: agent.gate| tools["agent.tools"]
  gate -->|route: agent.gate| approval["agent.approval"]
  gate -->|route: agent.gate| reject["agent.reject"]
  approval --> gate
  tools --> llm
  reject --> llm
```

`%% graph: id` names a graph, `%% default: id` picks the turn's own loop, and
`%% soft node: instruct` lets the model choose a target. Only the default graph runs a turn; the other
named graphs remain available to plugins through `ctx.graphs.get(id)`.

## Graph, policy and executor

- The **graph** drives the turn. `agent.calls` starts one tool batch, `agent.gate` maps the policy
  outcome onto a route, and `End` is reachable only from the model node, so a turn always ends on a
  model round.
- The **policy** is a pure decision: it returns `allow`, `confirm` or `reject` for a batch and a trace
  for every call, and knows nothing about nodes or routes.
- The **executor** (`agent.tools` and `ctx.tools.invoke`) verifies the gate's single-use
  `ToolAuthorization` before any tool body runs. `agent.tools` has exactly one predecessor,
  `agent.gate`; a custom graph that wires around the gate reaches the executor without a grant and
  the call is refused.
- `agent.approval` suspends the run and returns to `agent.gate`, which re-evaluates the batch: a
  policy rejection or a user denial wins, while an approval turns `confirm` into `allow`.

## Configuring

Set `comonad.graph` in `settings.json` to a Mermaid source. An empty value uses the shipped loop; a
source that fails to parse or compile is logged and the shipped loop runs instead. `comonad.maxSteps`
caps the whole turn (`0` means no limit). Plugins register node implementations and routes on
`ctx.graphs`, so a custom graph can use any implementation the loaded plugins provide.

## Plugins

Graph is a row in the shipped `cordis.yml`. Turning **graph** off leaves the agent with no engine,
which the Plugins tab shows as a dependency.
