// The markup of a collection tab's top row and query bar (above the results or in the query pane), with the
// icons of its buttons. Each button's text is in a `.label` span, which the webview rewrites without losing the
// icon. No vscode dependency, so it is tested as it is.
import { iconSvg as ic } from './shared/icons';

export function queryBarHtml(): string {
  return /* html */ `
  <header class="toolbar">
    <div class="row top">
      <div class="ns" id="ns"></div>
      <div class="top-actions">
      <div class="mode" role="tablist" aria-label="Query mode">
        <button id="modeFind" role="tab" aria-selected="true" title="Filter, sort and project documents">Find</button>
        <button id="modeAggregate" role="tab" aria-selected="false" title="Build an aggregation pipeline">Aggregate</button>
        <button id="modeSchema" role="tab" aria-selected="false" title="Fields, types and values of a sample of documents">Schema</button>
        <button id="modeChart" role="tab" aria-selected="false" title="Bar, line, pie, scatter and histogram charts of the documents">Chart</button>
        <button id="modeIndexes" role="tab" aria-selected="false" title="Indexes of the collection">Indexes</button>
      </div>
      <div class="btn-group collection-actions">
        <button id="historyBtn" class="secondary" title="Recent and saved queries" aria-haspopup="true" aria-expanded="false">${ic('history')}<span class="label">History</span><span class="caret" aria-hidden="true">▾</span></button>
        <button id="export" class="secondary not-indexes not-schema not-chart" title="Export the results to JSON, JSON Lines or CSV">${ic('export')}<span class="label">Export</span></button>
        <button id="watch" class="secondary not-view" title="Show the changes of the collection as they happen (change stream)">${ic('pulse')}<span class="label">Watch</span></button>
        <button id="insert" class="secondary editable" title="Insert documents: type them or paste a copied one">${ic('add')}<span class="label">Insert</span></button>
      </div>
      <button id="layoutToggle" class="secondary icon-only not-indexes" title="Query at the right of the results" aria-label="Query at the right of the results" aria-pressed="false">${ic('layout-sidebar-right')}</button>
      </div>
    </div>
  </header>
  <div class="workspace" id="workspace">
  <div class="query-pane" id="queryPane">
    <div class="find-only query-find">
      <div class="row q-filter">
        <label for="filter">Filter</label>
        <div class="filter-wrap" id="filterWrap">
          <textarea id="filter" rows="1" spellcheck="false" placeholder="{ field: &quot;value&quot; }  —  or drag a cell / column here"></textarea>
          <div class="dropzones" id="dropzones"></div>
        </div>
        <div class="btn-group q-run">
          <button id="run" class="primary" title="Run query (Ctrl+Enter)">${ic('play')}<span class="label">Find</span></button>
          <button id="reset" class="secondary" title="Clear filter, sort and projection">${ic('discard')}<span class="label">Reset</span></button>
        </div>
      </div>
      <div class="row q-tools">
        <div class="btn-group q-inspect">
          <button id="builderToggle" class="secondary" title="Build the filter from fields, operators and values" aria-expanded="false" aria-controls="builder">${ic('list-filter')}<span class="label">Builder</span></button>
          <button id="explainFind" class="secondary not-schema not-chart" title="Show how MongoDB runs this query: index used, documents examined">${ic('telescope')}<span class="label">Explain</span></button>
          <button id="codeFind" class="secondary not-schema not-chart" title="The query as code for mongosh, Node.js, Python, Java, C# or Go">${ic('code')}<span class="label">Code</span></button>
        </div>
        <div class="btn-group q-write editable not-schema not-chart">
          <button id="updateMany" class="secondary editable not-schema not-chart" title="Update every document matching the filter">${ic('edit')}<span class="label">Update many…</span></button>
          <button id="deleteMany" class="secondary editable danger not-schema not-chart" title="Delete every document matching the filter">${ic('trash')}<span class="label">Delete many…</span></button>
        </div>
      </div>
      <div id="builder" class="builder hidden" role="group" aria-label="Filter builder"></div>
      <div class="row options not-schema not-chart">
        <div class="q-option">
          <label for="sort">Sort</label>
          <div class="option-wrap" id="sortWrap">
            <input id="sort" spellcheck="false" placeholder="{ field: -1 }  —  or drag a column or a cell here">
            <div class="dropzones" id="sortDrop"></div>
          </div>
        </div>
        <div class="q-option">
          <label for="projection">Project</label>
          <div class="option-wrap" id="projectionWrap">
            <input id="projection" spellcheck="false" placeholder="{ field: 1 }  —  or drag a column or a cell here">
            <div class="dropzones" id="projectionDrop"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="aggregate-only pipeline">
      <div class="stages-wrap" id="stagesWrap">
        <div class="stages" id="stages"></div>
        <textarea id="pipelineText" class="pipeline-text hidden" spellcheck="false" placeholder="[ { $match: { field: &quot;value&quot; } }, { $group: { _id: &quot;$field&quot;, n: { $sum: 1 } } } ]"></textarea>
        <div class="dropzones pipeline-drop" id="pipelineDrop"></div>
      </div>
      <datalist id="stageOps"></datalist>
      <div class="row pipeline-actions">
        <div class="btn-group">
          <button id="runPipeline" class="primary" title="Run the whole pipeline (Ctrl+Enter in a stage)">${ic('play')}<span class="label">Run</span></button>
          <button id="addStage" class="secondary" title="Add a stage at the end">${ic('add')}<span class="label">Stage</span></button>
          <button id="pipelineTextToggle" class="secondary" title="Edit or paste the whole pipeline as text">${ic('json')}<span class="label">Edit as text</span></button>
          <button id="clearPipeline" class="secondary" title="Remove all stages">${ic('clear-all')}<span class="label">Clear</span></button>
        </div>
        <div class="btn-group">
          <button id="explainPipeline" class="secondary" title="Show how MongoDB runs the pipeline (up to the previewed stage)">${ic('telescope')}<span class="label">Explain</span></button>
          <button id="codePipeline" class="secondary" title="The pipeline as code for mongosh, Node.js, Python, Java, C# or Go">${ic('code')}<span class="label">Code</span></button>
          <button id="copyPipeline" class="secondary" title="Copy the pipeline (mongosh syntax)">${ic('copy')}<span class="label">Copy</span></button>
          <button id="saveView" class="secondary not-locked" title="Create a view with the pipeline up to the previewed stage">${ic('save-as')}<span class="label">Save as view…</span></button>
        </div>
        <span id="previewInfo" class="preview-info"></span>
      </div>
    </div>
  </div>
  <div class="pane-splitter" id="paneSplitter" role="separator" aria-orientation="vertical" aria-label="Width of the query" tabindex="0" title="Drag to resize the query (double-click: default width)"></div>`;
}
