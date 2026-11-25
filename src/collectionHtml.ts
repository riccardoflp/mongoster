// The page of a collection's tab: the query bar, the table with its status bar, the panels and the dialogs
// the webview (src/webview/main.ts) fills and wires. Only markup: nothing here depends on the collection but
// the title.
import * as vscode from 'vscode';
import { ThemeColors } from './themeColors';
import { queryBarHtml } from './queryBarHtml';
import { newNonce } from './nonce';
import { PROJECT_VISIBLE_TITLE } from './shared/columns';

export function collectionHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string): string {
  const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...p));
  const nonce = newNonce();
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'webview.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>${escapeHtml(title)}</title>
</head>
<body data-chart-src="${asset('dist', 'chartjs.js')}"${ThemeColors.bodyAttribute()}>
  <div id="progress" class="progress"></div>
${queryBarHtml()}
  <div id="historyPanel" class="history hidden" role="dialog" aria-label="Query history">
    <div class="history-head">
      <input id="historySearch" spellcheck="false" placeholder="Search queries">
      <button id="saveCurrent" class="secondary" title="Save the current query with a name, for you or in the project">☆ Save current</button>
    </div>
    <div class="history-body" id="historyBody"></div>
    <div id="historyMenu" class="context-menu hidden" role="menu"></div>
  </div>
  <div class="results-pane">
  <div class="error hidden" id="error"></div>
  <section class="schema-only schema-view" id="schemaView">
    <div class="row schema-head">
      <span id="schemaInfo" class="schema-info"></span>
      <span class="spacer"></span>
      <label for="schemaSize">Sample</label>
      <select id="schemaSize" title="Documents analyzed: a random sample when more match the filter">
        <option>100</option><option selected>1000</option><option>10000</option>
      </select>
      <button id="editValidation" class="secondary not-view" title="Validation rules ($jsonSchema) of the collection; without rules, a schema generated from the documents is proposed">Validation rules…</button>
      <button id="schemaGenerate" class="secondary" title="Generate fake documents that look like the ones analyzed, into this collection or another one">Generate…</button>
      <button id="schemaExpand" class="icon" title="Expand all">⊞</button>
      <button id="schemaCollapse" class="icon" title="Collapse all">⊟</button>
    </div>
    <div id="schemaBody" class="schema-body"></div>
  </section>
  <section class="chart-only chart-view" id="chartView">
    <div class="row chart-head">
      <div id="chartTypes" class="mode" role="tablist" aria-label="Chart type"></div>
      <label for="chartSource">Data</label>
      <select id="chartSource" title="Documents charted: those matching the filter, or the output of the pipeline of the Aggregate tab (up to the previewed stage)">
        <option value="find">Filter</option><option value="aggregate">Pipeline</option>
      </select>
      <span id="chartPipelineInfo" class="chart-muted"></span>
      <span class="spacer"></span>
      <button id="chartCode" class="secondary" title="The chart's aggregation as code for mongosh, Node.js, Python, Java, C# or Go">Code</button>
      <button id="chartPng" class="secondary" title="Save the chart as a PNG image">Export PNG</button>
    </div>
    <div class="row chart-fields">
      <label for="chartX" id="chartXLabel">Category</label>
      <input id="chartX" list="chartFieldList" spellcheck="false" placeholder="field">
      <select id="chartUnit" title="Group the dates of the category by" aria-label="Group dates by">
        <option value="">exact values</option><option value="hour">by hour</option><option value="day">by day</option><option value="week">by week</option><option value="month">by month</option><option value="year">by year</option>
      </select>
      <label for="chartAgg" id="chartAggLabel">Value</label>
      <select id="chartAgg">
        <option value="count">count</option><option value="sum">sum of</option><option value="avg">average of</option><option value="min">minimum of</option><option value="max">maximum of</option>
      </select>
      <label for="chartY" id="chartYLabel" class="hidden">Y</label>
      <input id="chartY" list="chartFieldList" spellcheck="false" placeholder="field">
      <label for="chartSeries" id="chartSeriesLabel">Series</label>
      <input id="chartSeries" list="chartFieldList" spellcheck="false" placeholder="none" title="A field splitting the data into series (up to 12)">
      <label for="chartLimit" id="chartLimitLabel">Top</label>
      <input id="chartLimit" type="number" min="1">
      <button id="chartDraw" class="primary" title="Draw the chart (Enter)">Draw</button>
      <datalist id="chartFieldList"></datalist>
    </div>
    <div id="chartInfo" class="chart-info chart-muted"></div>
    <div class="chart-wrap" id="chartWrap">
      <canvas id="chartCanvas" role="img" aria-label="Chart"></canvas>
      <div id="chartEmpty" class="empty hidden"></div>
    </div>
  </section>
  <section class="indexes-only indexes-view" id="indexesView">
    <div class="row index-head">
      <button id="newIndex" class="primary editable" title="Create an index on the collection">Create index…</button>
      <button id="refreshIndexes" class="secondary" title="Read the indexes, their sizes and their usage again">Refresh</button>
      <span id="indexSummary" class="index-summary"></span>
    </div>
    <div id="indexMessage" class="hidden"></div>
    <table id="indexTable" class="grid index-table"></table>
    <!-- Atlas Search and Vector Search indexes -->
    <div id="searchIndexes" class="search-indexes">
      <div class="row index-head">
        <span class="search-indexes-title" title="Atlas Search and Atlas Vector Search indexes, queried with $search, $searchMeta and $vectorSearch">Search indexes</span>
        <button id="newSearchIndex" class="primary editable" title="Create an Atlas Search or Vector Search index">Create search index…</button>
        <button id="refreshSearchIndexes" class="secondary" title="Read the search indexes and their status again">Refresh</button>
        <span id="searchIndexSummary" class="index-summary"></span>
      </div>
      <div id="searchIndexMessage" class="hidden"></div>
      <table id="searchIndexTable" class="grid index-table search-index-table"></table>
    </div>
  </section>
  <div class="statusbar">
    <span id="status"></span>
    <span class="spacer"></span>
    <span id="selectionInfo" class="status-group selection-info hidden" aria-live="polite">
      <span id="selectionCount"></span><span aria-hidden="true">·</span><button id="selectionClear" class="link" title="Clear the selection (Esc)">Clear</button>
    </span>
    <button id="formattingBtn" class="secondary columns-btn" title="Color rows and cells of the table by conditions or by a field's values: opens and closes the Formatting pane" aria-expanded="false">Formatting</button>
    <button id="columnsBtn" class="secondary columns-btn" title="Show, hide, pin and reorder the columns" aria-haspopup="true" aria-expanded="false">Columns</button>
    <span class="status-group">
    <label for="limit">Page size</label>
    <select id="limit">
      <option>10</option><option>20</option><option selected>50</option><option>100</option><option>200</option><option>500</option>
    </select>
    </span>
    <span class="status-group">
    <button id="prev" class="icon" title="Previous page">‹</button>
    <span id="range"></span>
    <button id="next" class="icon" title="Next page">›</button>
    </span>
  </div>
  <div id="columnsPanel" class="columns-panel hidden" role="dialog" aria-label="Columns">
    <div class="columns-head">
      <input id="columnsSearch" spellcheck="false" placeholder="Search columns">
      <button id="columnsShowAll" class="secondary" title="Show the hidden columns">Show all</button>
      <button id="columnsReset" class="secondary" title="Natural order, no hidden or pinned columns, automatic widths">Reset</button>
      <button id="columnsProject" class="secondary" title="${PROJECT_VISIBLE_TITLE}">Project Visible</button>
    </div>
    <div id="columnsList" class="columns-list"></div>
  </div>
  <div id="columnMenu" class="context-menu hidden" role="menu"></div>
  <div id="docMenu" class="context-menu hidden" role="menu"></div>
  <div id="formattingMenu" class="context-menu hidden" role="menu"></div>
  <div class="table-area">
  <main class="grid-wrap" id="gridWrap">
    <table id="grid" class="grid"></table>
    <div id="empty" class="empty hidden">No documents match this query.</div>
  </main>
  <div class="fmt-splitter" id="formattingSplitter" role="separator" aria-orientation="vertical" aria-label="Width of the Formatting pane" tabindex="0" title="Drag to resize the Formatting pane (double-click: default width)"></div>
  <aside id="formattingPane" class="fmt-pane" aria-label="Formatting">
    <div class="fmt-pane-head">
      <span class="fmt-pane-title">Formatting</span>
      <span class="spacer"></span>
      <button id="formattingEye" class="secondary" aria-pressed="false">Hide Formatting</button>
      <button id="formattingAdd" class="secondary" aria-haspopup="menu" title="Add a formatting rule: a condition, or by a field's values">+ Add Rule…</button>
      <button id="formattingMore" class="icon" aria-haspopup="menu" title="Export the formatting rules to a file, or import them from one">⋯</button>
      <button id="formattingClose" class="icon" title="Close the pane">✕</button>
    </div>
    <div id="formattingNote" class="error hidden"></div>
    <div id="formattingList" class="fmt-pane-list"></div>
    <div class="formatting-hint">The first rule that gives a color wins; a cell over a row.</div>
  </aside>
  </div>
  </div>
  </div>
  <div id="modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box">
      <div class="modal-head">
        <button id="docPrev" class="icon" title="Previous document (↑)">‹</button>
        <span id="docTitle" class="doc-title"></span>
        <button id="docNext" class="icon" title="Next document (↓)">›</button>
        <span class="spacer"></span>
        <button id="docExpand" class="icon" title="Expand all">⊞</button>
        <button id="docCollapse" class="icon" title="Collapse all">⊟</button>
        <button id="docCopy" class="secondary" title="Copy as mongosh, Extended JSON, JSON, YAML or an insertOne command" aria-haspopup="menu">Copy ▾</button>
        <button id="docHistory" class="secondary not-view doc-write" title="The versions of the document from the oplog: what each write changed, and restoring one">History…</button>
        <button id="docDuplicate" class="secondary editable doc-write" title="Insert a copy without _id">Duplicate</button>
        <button id="docDelete" class="secondary editable danger doc-write">Delete</button>
        <button id="docEdit" class="primary doc-write" title="Open in an editor tab (Ctrl+S saves to the database)">Edit</button>
        <button id="docClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="modal-body" id="docBody"></div>
    </div>
  </div>
  <div id="codeModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box code-box">
      <div class="modal-head">
        <span id="codeTitle" class="doc-title">Code</span>
        <span class="spacer"></span>
        <button id="codeClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="code-options">
        <div id="codeLangs" class="mode" role="tablist" aria-label="Language"></div>
        <label title="Imports, connection (MONGODB_URI) and printing the results"><input id="codeProgram" type="checkbox"> Full program</label>
      </div>
      <div id="codeError" class="error hidden"></div>
      <pre id="codeText" class="code-text"></pre>
      <div class="bulk-actions">
        <button id="codeOpen" class="secondary" title="Open the code in a new editor tab">Open in Editor</button>
        <button id="codeCopy" class="primary">Copy</button>
      </div>
    </div>
  </div>
  <div id="insertModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box insert-box">
      <div class="modal-head">
        <span id="insertTitle" class="doc-title">Insert</span>
        <span class="spacer"></span>
        <button id="insertTemplate" class="secondary" title="Start from the fields most documents of the collection have">Template</button>
        <button id="insertClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="insert-body">
        <textarea id="insertText" rows="16" spellcheck="false" aria-label="Documents to insert" aria-describedby="insertHint"></textarea>
        <div id="insertHint" class="insert-hint">One document <code>{ … }</code> or several <code>[ { … }, { … } ]</code>, in mongosh syntax or Extended JSON: paste what Copy gives. <code>ObjectId(…)</code>, <code>ISODate(…)</code> and <code>NumberLong(…)</code> keep their types; without <code>_id</code> one is generated.</div>
        <div id="insertStatus" class="insert-status" aria-live="polite"></div>
        <div id="insertError" class="error hidden"></div>
      </div>
      <div class="bulk-actions">
        <button id="insertEditor" class="secondary">Open in Editor</button>
        <span class="spacer"></span>
        <label title="Stay open after inserting, to insert more"><input id="insertKeep" type="checkbox"> Keep open</label>
        <button id="insertCancel" class="secondary">Cancel</button>
        <button id="insertApply" class="primary" title="Ctrl+Enter">Insert</button>
      </div>
    </div>
  </div>
  <div id="bulkModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box bulk-box">
      <div class="modal-head">
        <span id="bulkTitle" class="doc-title">Update many</span>
        <span class="spacer"></span>
        <button id="bulkClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="bulk-body">
        <span class="bulk-label">Filter</span>
        <code id="bulkFilter" class="bulk-filter"></code>
        <label for="bulkUpdate" class="bulk-label bulk-update">Update</label>
        <textarea id="bulkUpdate" class="bulk-update" rows="4" spellcheck="false" placeholder="{ $set: { status: &quot;archived&quot; }, $inc: { version: 1 } }  —  or a pipeline [ { $set: … } ]"></textarea>
        <div id="bulkCount" class="bulk-count"></div>
        <div id="bulkError" class="bulk-error error hidden"></div>
      </div>
      <div class="bulk-actions">
        <button id="bulkCancel" class="secondary">Cancel</button>
        <button id="bulkApply" class="primary" title="Ctrl+Enter">Update</button>
      </div>
    </div>
  </div>
  <div id="indexModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box index-box">
      <div class="modal-head">
        <span id="indexTitle" class="doc-title">Create index</span>
        <span class="spacer"></span>
        <div class="mode" role="tablist" aria-label="Edit the index as">
          <button id="indexModeForm" role="tab" aria-selected="true" title="Fields, types and the common options">Form</button>
          <button id="indexModeText" role="tab" aria-selected="false" title="The keys and options as createIndex takes them">Text</button>
        </div>
        <button id="indexClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="index-body">
        <div id="indexForm" class="index-form">
          <div class="index-section">Fields</div>
          <div id="indexFields" class="index-fields"></div>
          <div><button id="indexAddField" class="secondary" title="Add a field: a compound index follows the order of its fields">+ Field</button></div>
          <datalist id="indexFieldList"></datalist>
          <div class="index-section">Options</div>
          <div class="index-options">
            <label for="indexName">Name</label>
            <input id="indexName" spellcheck="false">
            <label class="index-check"><input id="indexUnique" type="checkbox"> Unique</label>
            <span class="index-hint">No two documents can have the same value in the indexed fields.</span>
            <label class="index-check"><input id="indexSparse" type="checkbox"> Sparse</label>
            <span class="index-hint">Only documents that have the indexed fields are in the index.</span>
            <label class="index-check"><input id="indexHidden" type="checkbox"> Hidden</label>
            <span class="index-hint">Kept up to date, but not used by queries.</span>
            <label class="index-check" title="On a single date field: the server deletes the documents when they expire"><input id="indexTtl" type="checkbox"> TTL</label>
            <span class="index-inline">
              <span class="index-hint">Documents are deleted</span>
              <input id="indexTtlValue" type="number" min="0" aria-label="Time before the documents expire">
              <select id="indexTtlUnit" aria-label="Unit"></select>
              <span class="index-hint">after the date in the field.</span>
            </span>
            <label class="index-check" title="partialFilterExpression"><input id="indexPartial" type="checkbox"> Partial</label>
            <textarea id="indexPartialFilter" rows="1" spellcheck="false" placeholder="{ status: &quot;active&quot; }  —  only the documents matching this filter are in the index" aria-label="Partial filter"></textarea>
            <label class="index-check" title="Language rules for comparing strings: queries must ask for the same collation to use the index"><input id="indexCollation" type="checkbox"> Collation</label>
            <input id="indexCollationValue" spellcheck="false" placeholder="{ locale: &quot;en&quot;, strength: 2 }" aria-label="Collation">
            <label for="indexLanguage" class="text-only" title="default_language of a text index">Language</label>
            <input id="indexLanguage" class="text-only" spellcheck="false" placeholder="english">
            <label for="indexMore" title="Any other option of createIndex">More options</label>
            <textarea id="indexMore" rows="1" spellcheck="false" placeholder="{ wildcardProjection: { … }, language_override: &quot;…&quot;, bits: 26, … }"></textarea>
          </div>
        </div>
        <div id="indexText" class="index-options hidden">
          <label for="indexKeys">Keys</label>
          <textarea id="indexKeys" rows="3" spellcheck="false" placeholder="{ status: 1, createdAt: -1 }"></textarea>
          <label for="indexOptions">Options</label>
          <textarea id="indexOptions" rows="6" spellcheck="false" placeholder="{ unique: true, name: &quot;…&quot;, expireAfterSeconds: 3600, partialFilterExpression: { … } }"></textarea>
        </div>
        <div class="index-section">Command</div>
        <pre id="indexPreview" class="index-preview"></pre>
        <div id="indexWarnings" class="index-plan warn hidden"></div>
        <div id="indexPlan" class="index-plan hidden"></div>
        <div id="indexError" class="error hidden"></div>
      </div>
      <div class="bulk-actions">
        <button id="indexCopy" class="secondary" title="Copy the mongosh command that creates the index">Copy command</button>
        <span class="spacer"></span>
        <button id="indexCancel" class="secondary">Cancel</button>
        <button id="indexSave" class="primary" title="Ctrl+Enter">Create index</button>
      </div>
    </div>
  </div>
  <div id="searchIndexModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box index-box">
      <div class="modal-head">
        <span id="searchIndexTitle" class="doc-title">Create search index</span>
        <span class="spacer"></span>
        <button id="searchIndexClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="index-body">
        <div class="index-options">
          <label for="searchIndexName">Name</label>
          <input id="searchIndexName" spellcheck="false">
          <label>Type</label>
          <div class="mode search-type" role="tablist" aria-label="Type of the search index">
            <button id="searchTypeSearch" role="tab" aria-selected="true" title="Full-text search with $search and $searchMeta">Search</button>
            <button id="searchTypeVector" role="tab" aria-selected="false" title="Nearest neighbors of a vector (embeddings) with $vectorSearch">Vector Search</button>
          </div>
          <label class="search-only">Template</label>
          <span class="index-inline search-only">
            <button id="searchTplDynamic" class="secondary" title="Index every field of a supported type">Dynamic mapping</button>
            <button id="searchTplStatic" class="secondary" title="Index the fields of the documents one by one, with the types seen in them">Static mappings</button>
          </span>
          <label for="searchVectorPath" class="vector-only">Path</label>
          <input id="searchVectorPath" class="vector-only" spellcheck="false" list="searchVectorPaths" placeholder="field with the vectors, e.g. embedding">
          <datalist id="searchVectorPaths"></datalist>
          <label for="searchVectorDims" class="vector-only">Dimensions</label>
          <span class="index-inline vector-only">
            <input id="searchVectorDims" type="number" min="1" max="8192" title="numDimensions: how many numbers each vector has">
            <label for="searchVectorSimilarity" class="index-hint">Similarity</label>
            <select id="searchVectorSimilarity"></select>
            <label for="searchVectorQuantization" class="index-hint">Quantization</label>
            <select id="searchVectorQuantization" title="scalar or binary: smaller index, faster, a little less precise"></select>
          </span>
          <label id="searchFieldsLabel" title="">Fields</label>
          <div id="searchFieldList" class="search-field-list"></div>
        </div>
        <div class="index-section">Definition</div>
        <textarea id="searchIndexDefinition" class="search-definition" rows="12" spellcheck="false"></textarea>
        <div class="index-section">Command</div>
        <pre id="searchIndexPreview" class="index-preview"></pre>
        <div id="searchIndexPlan" class="index-plan hidden"></div>
        <div id="searchIndexError" class="error hidden"></div>
      </div>
      <div class="bulk-actions">
        <button id="searchIndexCopy" class="secondary" title="Copy the mongosh command">Copy command</button>
        <span class="spacer"></span>
        <button id="searchIndexCancel" class="secondary">Cancel</button>
        <button id="searchIndexSave" class="primary" title="Ctrl+Enter">Create search index</button>
      </div>
    </div>
  </div>
  <div id="explainModal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-box explain-box">
      <div class="modal-head">
        <span id="explainTitle" class="doc-title">Explain</span>
        <span class="spacer"></span>
        <button id="explainRaw" class="secondary" title="Toggle the full explain output">Raw</button>
        <button id="explainClose" class="icon" title="Close (Esc)">✕</button>
      </div>
      <div class="modal-body" id="explainBody"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
