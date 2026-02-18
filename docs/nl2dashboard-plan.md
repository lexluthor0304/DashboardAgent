# NL2Dashboard Plan (React/Vite + Vega-Lite + Salesforce/jsforce)

## Summary
Frontend uses React + Vite + TypeScript to build a "chat-driven generation + live canvas" dashboard editor and shareable read-only viewer. Layout uses react-grid-layout; charts render via vega-embed with Vega-Lite specs. Backend uses Node to unify: LLM orchestration, dashboard/spec storage, and data connectors (Salesforce via jsforce), executing a guarded Query DSL and returning only rows for the frontend to render.

## Frontend Stack (Locked)
- Framework/build: React + Vite + TypeScript
- Routing: react-router-dom
- Layout/grid: react-grid-layout (Responsive, draggable/resizable)
- Charts: vega + vega-lite + vega-embed
- Server state: @tanstack/react-query
- Client state: zustand (spec/history/runtime)
- Patch: JSON Patch (RFC6902) via fast-json-patch
- Forms/validation: react-hook-form + zod
- UI primitives: @radix-ui/react-*
- Styling: CSS Variables theme tokens + CSS Modules
- Testing: vitest + @testing-library/react

## Core Contracts
### Persisted
- DashboardSpec
  - title, themeId
  - layout: [{ cardId, x, y, w, h }]
  - cards: ChartCard | TextCard | FilterCard(optional)
  - dataRequests: { [requestId]: DataRequest }

### Runtime (non-persisted by default)
- RuntimeState
  - globalTimeRange
  - filters

### Agent -> UI
- API returns `{ patch: JSONPatch[], dirtyAreas }`
- UI applies patch, refreshes only affected requests/charts

### Data Fetch
- UI calls `GET /api/dashboards/:id/data?requestId=...` with runtime overlay
- Backend executes connector (e.g., Salesforce/jsforce) using guarded Query DSL
- Response `{ rows }` only; no credentials in browser

## Pages
- /edit/:dashboardId
  - Chat panel (natural language)
  - Canvas grid (drag/resize writes back layout)
  - Cards render via Vega-Embed
- /d/:dashboardId
  - Share read-only view
  - Loads spec + fetches rows and renders

## Architecture
Mermaid source: `docs/architecture.mmd`

```mermaid
flowchart TB
  %% GitHub Mermaid parser is strict about unquoted punctuation in labels.
  %% Use quoted labels and \n for line breaks (avoid <br/>).

  %% ============ Client ============
  subgraph Client["Browser"]
    subgraph Web["Web App: React + Vite + TS"]
      Routes["Routes\n/edit/:id\n/d/:id"]
      Chat["ChatPanel\nmessage stream"]
      Canvas["CanvasGrid\nreact-grid-layout"]
      Cards["CardRenderer\nCardFrame"]
      Vega["VegaChart\nvega-embed"]
      RQ["React Query\nserver cache"]
      Store["zustand\nspec + history + runtime"]
      Theme["Theme system\nCSS vars + Vega config"]
    end
  end

  %% ============ API ============
  subgraph Server["API Service: Node"]
    Router["HTTP router"]
    Auth["Auth + share token\nhash verify"]
    Rate["Rate limit\nip + dashboardId"]
    Obs["Observability\nlogs + metrics + traces"]

    subgraph Agent["Agent orchestrator"]
      Prompt["Prompt builder\nintent + currentSpec + schema digest"]
      Tools["Skills/Tools registry\nzod IO contracts"]
      Validate["Validate + repair loop\nzod + invariants"]
      Patch["JSON Patch output\nRFC6902"]
    end

    subgraph Connectors["Connectors"]
      SFConn["Salesforce connector\njsforce"]
      OASConn["REST/GraphQL connector\nOpenAPI/Schema"]
    end

    subgraph Query["Query layer"]
      Model["Data model cache\ndescribe/schema projection"]
      DSL["Query DSL\ntyped + guarded"]
      Guard["Guardrails\nallowlists + limits"]
      Compile["Compiler\nDSL -> SOQL/HTTP"]
    end

    StoreSvc["Dashboard service\nspec CRUD"]
    DataSvc["Data service\nexecute DataRequest"]
  end

  %% ============ Storage ============
  subgraph Storage["Storage"]
    DB["DB\ndashboards + connectors\nSQLite or Postgres"]
    KV["Cache\nschema/rows optional"]
    Secrets["Secrets\nOAuth client + encryption key"]
  end

  %% ============ External ============
  subgraph External["External systems"]
    LLM["LLM provider\ntool calling"]
    Salesforce["Salesforce cloud"]
    APIs["Other APIs\nREST/GraphQL"]
  end

  %% ============ Client flows ============
  Routes --> Chat
  Routes --> Canvas
  Chat --> Store
  Canvas --> Store
  Store --> Cards
  Cards --> Vega
  Theme --> Vega
  RQ --> Cards

  %% ============ Client <-> Server ============
  Chat -->|POST /api/agent: message + currentSpec| Router
  Routes -->|GET /api/dashboards/:id token| Router
  Cards -->|GET /api/dashboards/:id/data: requestId + runtime| Router

  %% ============ Server request routing ============
  Router --> Rate --> Auth
  Router --> Obs
  Auth --> StoreSvc
  Auth --> DataSvc
  Auth --> Agent

  %% ============ Agent orchestration ============
  Agent --> Prompt --> Tools --> Validate --> Patch
  Patch -->|response| Router
  Agent -->|call| LLM
  LLM -->|JSON patch + dirtyAreas| Agent

  %% ============ Data execution ============
  DataSvc --> Model --> DB
  DataSvc --> DSL --> Guard --> Compile
  Compile --> SFConn --> Salesforce --> SFConn
  Compile --> OASConn --> APIs --> OASConn
  DataSvc -->|rows| Router

  %% ============ Persistence ============
  StoreSvc --> DB
  Agent --> DB
  SFConn --> DB
  Model --> KV
  DataSvc --> KV
  Secrets --> SFConn
  Secrets --> Agent
```
