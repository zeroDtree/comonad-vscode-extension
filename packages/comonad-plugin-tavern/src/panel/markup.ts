/** The **ST** tab's markup, exactly as the panel writes it into the settings document. */
export const markup = `
  <div id="st-pane" data-view="content">
    <nav id="st-tabs" role="tablist" aria-label="SillyTavern content">
      <button class="subtab" type="button" role="tab" data-st="characters" title="Characters — cards in Comonad's library">Characters</button>
      <button class="subtab" type="button" role="tab" data-st="lorebooks" title="World books — keyword-scanned lore">World books</button>
      <button class="subtab" type="button" role="tab" data-st="personas" title="Personas — who the user is">Personas</button>
      <button class="subtab" type="button" role="tab" data-st="presets" title="Presets — prompts, order and samplers">Presets</button>
      <button class="subtab" type="button" role="tab" data-st="settings" title="Settings — defaults and the keyword scan">Settings</button>
    </nav>

    <div id="st-actions">
      <button class="secondary" id="st-new" type="button" title="Start a new item">New</button>
      <button class="secondary" id="st-duplicate" type="button" title="Copy this item into a new one">Duplicate</button>
      <button class="secondary danger" id="st-delete" type="button" title="Delete the file from Comonad's library">Delete</button>
      <span class="grow"></span>
      <button class="link" id="st-reveal" type="button" title="Open this folder in the file manager">Folder</button>
      <button class="link" id="st-save" type="button" title="Write this item to the library">Save</button>
    </div>

    <div id="st-split">
      <aside id="st-list">
        <div id="st-items"></div>
        <p class="hint" id="st-library"></p>
      </aside>
      <section id="st-form"></section>
    </div>

    <!-- The world-book page: SillyTavern's Worlds/Lorebooks panel, in the order it has it — the
         active worlds and the global activation knobs on top, then the book toolbar, then the
         entry list, where every row unfolds into its own editor. The list itself is drawn by
         resources/worldinfo.js from the template below. -->
    <div id="wi-panel">
      <div id="wi-top">
        <div class="wi-block">
          <small class="wi-label">Active World(s) for all chats</small>
          <div id="wi-worlds" role="group" aria-label="Active worlds" title="Books every chat scans; tick any number, or none"></div>
        </div>
        <div class="wi-block">
          <small class="wi-label">Global World Info/Lorebook activation settings</small>
          <div class="wi-drawer">
            <button class="wi-drawer-head" id="wi-global-toggle" type="button" aria-expanded="false"><b>Click to expand</b><span class="wi-chev">▾</span></button>
            <div class="wi-drawer-body" id="wi-global" hidden>
              <div class="wi-sliders">
                <label class="wi-slider"><small>Scan Depth</small><input type="range" id="wi-g-scan-range" min="0" max="1000" step="1" /><input type="number" id="wi-g-scan" min="0" max="1000" step="1" /></label>
                <label class="wi-slider"><small>Context %</small><input type="range" id="wi-g-budget-range" min="1" max="100" step="1" /><input type="number" id="wi-g-budget" min="1" max="100" step="1" /></label>
                <label class="wi-slider" title="0 disables the cap"><small>Budget Cap</small><input type="range" id="wi-g-cap-range" min="0" max="65536" step="1" /><input type="number" id="wi-g-cap" min="0" max="65536" step="1" /></label>
                <label class="wi-slider" title="Scan further back until this many entries are active"><small>Min Activations</small><input type="range" id="wi-g-min-range" min="0" max="100" step="1" /><input type="number" id="wi-g-min" min="0" max="100" step="1" /></label>
                <label class="wi-slider" title="0 = unlimited, use the budget"><small>Max Depth</small><input type="range" id="wi-g-depth-range" min="0" max="100" step="1" /><input type="number" id="wi-g-depth" min="0" max="100" step="1" /></label>
                <label class="wi-slider" title="0 = unlimited, 1 = scan once without recursing"><small>Max Recursion Steps</small><input type="range" id="wi-g-steps-range" min="0" max="10" step="1" /><input type="number" id="wi-g-steps" min="0" max="10" step="1" /></label>
                <label class="wi-slider"><small>Insertion Strategy</small><select id="wi-g-strategy"></select></label>
                <label class="wi-slider" title="The lowest cosine similarity an entry needs to be injected"><small>Score Threshold</small><input type="range" id="wi-g-vector-threshold-range" min="0" max="1" step="0.05" /><input type="number" id="wi-g-vector-threshold" min="0" max="1" step="0.05" /></label>
                <label class="wi-slider" title="How many vectorized entries one book may contribute to a turn"><small>Max Entries</small><input type="number" id="wi-g-vector-entries" min="0" max="50" step="1" /></label>
                <label class="wi-slider" title="How many of the newest messages form the search query"><small>Query Messages</small><input type="number" id="wi-g-vector-query" min="1" max="20" step="1" /></label>
                <label class="wi-slider" title="The embedding model to ask for"><small>Embedding Model</small><input type="text" id="wi-g-vector-model" spellcheck="false" /></label>
              </div>
              <div class="wi-global-checks">
                <label class="wi-inline"><input type="checkbox" id="wi-g-names" /> Include Names</label>
                <label class="wi-inline"><input type="checkbox" id="wi-g-recursive" /> Recursive Scan</label>
                <label class="wi-inline"><input type="checkbox" id="wi-g-case" /> Case-sensitive</label>
                <label class="wi-inline"><input type="checkbox" id="wi-g-words" /> Match Whole Words</label>
                <label class="wi-inline"><input type="checkbox" id="wi-g-scoring" /> Use Group Scoring</label>
                <label class="wi-inline" title="Warn when the budget stops the scan"><input type="checkbox" id="wi-g-overflow" /> Alert On Overflow</label>
                <label class="wi-inline" title="Run the automation an entry names when that entry activates"><input type="checkbox" id="wi-g-automation" /> Automation</label>
                <label class="wi-inline" title="Find entries marked vectorized by meaning instead of by keys"><input type="checkbox" id="wi-g-vector" /> Vectorized</label>
              </div>
            </div>
          </div>
        </div>
      </div>

      <hr />

      <div id="wi-toolbar">
        <button class="secondary" id="wi-create" type="button">Create</button>
        <small class="wi-or">or</small>
        <select id="wi-pick" title="Pick a book to edit"></select>
        <span class="grow"></span>
        <div class="wi-tools">
          <button class="secondary" id="wi-import" type="button" title="Copy world info files into Comonad's library">Import</button>
          <button class="secondary" id="wi-export" type="button" title="Write this book to a file">Export</button>
          <button class="secondary" id="wi-rename" type="button" title="Rename this book">Rename</button>
          <button class="secondary" id="wi-duplicate" type="button" title="Copy this book into a new file">Duplicate</button>
          <button class="secondary danger" id="wi-delete" type="button" title="Delete this book's file">Delete</button>
        </div>
      </div>

      <div id="wi-toolbar2">
        <div class="wi-tools">
          <button class="secondary" id="wi-add" type="button" title="New entry">＋</button>
          <button class="secondary" id="wi-open-all" type="button" title="Open every entry">Open all</button>
          <button class="secondary" id="wi-close-all" type="button" title="Fold every entry">Close all</button>
          <button class="secondary" id="wi-backfill" type="button" title="Fill empty titles with the entry's keys">Fill titles</button>
          <button class="secondary" id="wi-apply-order" type="button" title="Write the current order into every entry's Order">Apply as Order</button>
        </div>
        <div class="wi-tools push">
          <input id="wi-search" class="control" type="search" placeholder="Search..." />
          <select id="wi-sort" title="Sort the list"></select>
          <button class="secondary" id="wi-refresh" type="button" title="Re-read the library from disk">Refresh</button>
          <select id="wi-page-size" title="Entries per page"></select>
          <span id="wi-pager"></span>
        </div>
      </div>

      <div id="wi-table">
        <div id="wi-headers">
          <small class="wi-h-title">Title/Memo</small>
          <small class="wi-h-state">Strategy</small>
          <small class="wi-h-pos">Position</small>
          <small class="wi-h-num">Depth</small>
          <small class="wi-h-num">Order</small>
          <small class="wi-h-num">Trigger %</small>
        </div>
        <div id="wi-list"></div>
      </div>
      <p class="hint" id="wi-status"></p>
      <datalist id="wi-automation-options"></datalist>
      <datalist id="wi-key-options"></datalist>
      <div id="wi-modal" hidden>
        <div class="wi-modal-body">
          <p class="wi-modal-text" id="wi-modal-text"></p>
          <select id="wi-modal-select"></select>
          <div class="wi-modal-buttons">
            <button class="secondary" type="button" data-answer="">Cancel</button>
            <button class="secondary" type="button" data-answer="move">Move</button>
            <button class="secondary" type="button" data-answer="copy">Copy</button>
          </div>
        </div>
      </div>
    </div>

    <template id="wi-entry-tpl">
      <div class="wi-entry">
        <div class="wi-row">
          <span class="wi-grip" title="Drag to reorder">☰</span>
          <button class="wi-fold" type="button" title="Open this entry"></button>
          <button class="wi-kill" type="button" title="Toggle the entry's active state"></button>
          <textarea class="wi-title" rows="1" placeholder="Entry Title/Memo" spellcheck="false"></textarea>
          <select class="wi-state" title="Entry status"></select>
          <select class="wi-row-position" title="Where the entry is injected"></select>
          <input class="wi-num wi-row-depth" type="number" min="0" title="Depth" />
          <input class="wi-num wi-row-order" type="number" min="0" title="Order" />
          <input class="wi-num wi-row-prob" type="number" min="0" max="100" title="Trigger %" />
          <span class="wi-buttons">
            <button class="wi-move" type="button" title="Move or copy this entry to another book">⇄</button>
            <button class="wi-copy" type="button" title="Duplicate this entry">⧉</button>
            <button class="wi-drop" type="button" title="Delete this entry">✕</button>
          </span>
        </div>
        <div class="wi-edit" hidden>
          <div class="wi-line">
            <div class="wi-field wi-keys">
              <small>Primary Keywords</small>
              <div class="wi-chips" data-for="key"></div>
              <input class="wi-chip-input" data-for="key" type="text" placeholder="Keywords or Regexes" spellcheck="false" />
              <button class="wi-plain" data-for="key" type="button" title="Switch to plaintext mode">✨</button>
              <textarea class="wi-chip-text" data-for="key" rows="2" placeholder="Comma separated list" spellcheck="false" hidden></textarea>
            </div>
            <div class="wi-field wi-thin"><small>Logic</small><select class="wi-logic"></select></div>
            <div class="wi-field wi-keys">
              <small>Optional Filter</small>
              <div class="wi-chips" data-for="keysecondary"></div>
              <input class="wi-chip-input" data-for="keysecondary" type="text" placeholder="Keywords or Regexes (ignored if empty)" spellcheck="false" />
              <button class="wi-plain" data-for="keysecondary" type="button" title="Switch to plaintext mode">✨</button>
              <textarea class="wi-chip-text" data-for="keysecondary" rows="2" placeholder="Comma separated list (ignored if empty)" spellcheck="false" hidden></textarea>
            </div>
          </div>
          <div class="wi-line">
            <div class="wi-field"><small>Outlet Name</small><input class="wi-outlet" type="text" placeholder="Outlet Name" spellcheck="false" /></div>
            <div class="wi-field"><small>Scan Depth</small><input class="wi-scan" type="number" placeholder="Use global setting" /></div>
            <div class="wi-field"><small>Case-Sensitive</small><select class="wi-case"></select></div>
            <div class="wi-field"><small>Whole Words</small><select class="wi-words"></select></div>
            <div class="wi-field"><small>Group Scoring</small><select class="wi-scoring"></select></div>
            <div class="wi-field"><small>Recursion Level</small><input class="wi-level" type="text" placeholder="1" /></div>
          </div>
          <div class="wi-content">
            <div class="wi-content-head">
              <small>Content <span class="wi-tokens"></span> <span class="wi-uid"></span></small>
              <div class="wi-flags">
                <label class="wi-inline" title="This entry is never activated by another entry"><input type="checkbox" class="wi-exclude-recursion" /> Non-recursable</label>
                <label class="wi-inline" title="This entry does not activate other entries"><input type="checkbox" class="wi-prevent-recursion" /> Prevent further recursion</label>
                <label class="wi-inline" title="Only reachable by a recursive scan"><input type="checkbox" class="wi-delay-until" /> Delay until recursion</label>
                <label class="wi-inline" title="Included even when the budget is spent"><input type="checkbox" class="wi-ignore-budget" /> Ignore budget</label>
              </div>
            </div>
            <textarea class="wi-body" rows="8" placeholder="What this keyword should mean to the AI, sent verbatim" spellcheck="false"></textarea>
          </div>
          <div class="wi-line">
            <div class="wi-field wi-group">
              <small>Inclusion Group <label class="wi-inline" title="This entry wins over the other members"><input type="checkbox" class="wi-override" /> Prioritize</label></small>
              <input class="wi-group-name" type="text" placeholder="Only one entry with the same label will be activated" spellcheck="false" />
            </div>
            <div class="wi-field"><small>Group Weight</small><input class="wi-weight" type="number" min="1" placeholder="100" /></div>
            <div class="wi-field"><small>Sticky</small><input class="wi-sticky" type="number" min="0" placeholder="Non-sticky" /></div>
            <div class="wi-field"><small>Cooldown</small><input class="wi-cooldown" type="number" min="0" placeholder="No cooldown" /></div>
            <div class="wi-field"><small>Delay</small><input class="wi-delay-turns" type="number" min="0" placeholder="No delay" /></div>
          </div>
          <div class="wi-line">
            <div class="wi-field"><small>Automation ID</small><input class="wi-automation" type="text" list="wi-automation-options" placeholder="Automation ID" spellcheck="false" /></div>
            <div class="wi-field wi-wide">
              <small>Filter to Generation Triggers</small>
              <div class="wi-triggers wi-checks" role="group" aria-label="Generation triggers"></div>
            </div>
          </div>
          <div class="wi-line">
            <div class="wi-field wi-wide">
              <small>Filter to Characters or Tags <label class="wi-inline" title="Turn the filter around: these characters and tags are excluded"><input type="checkbox" class="wi-filter-exclude" /> Exclude</label></small>
              <div class="wi-filter wi-checks" role="group" aria-label="Characters or tags"></div>
            </div>
          </div>
          <div class="wi-foot">
            <label class="wi-inline"><input type="checkbox" class="wi-selective" /> Selective</label>
            <label class="wi-inline"><input type="checkbox" class="wi-use-probability" /> Use Probability</label>
            <label class="wi-inline"><input type="checkbox" class="wi-memo" /> Add Memo</label>
          </div>
          <div class="wi-sources">
            <button class="wi-sources-head" type="button" aria-expanded="false">Additional Matching Sources <span class="wi-chev">▾</span></button>
            <div class="wi-sources-body" hidden>
              <label class="wi-inline"><input type="checkbox" class="wi-m-desc" /> Character Description</label>
              <label class="wi-inline"><input type="checkbox" class="wi-m-pers" /> Character Personality</label>
              <label class="wi-inline"><input type="checkbox" class="wi-m-scenario" /> Scenario</label>
              <label class="wi-inline"><input type="checkbox" class="wi-m-persona" /> Persona Description</label>
              <label class="wi-inline"><input type="checkbox" class="wi-m-depth" /> Character's Note</label>
              <label class="wi-inline"><input type="checkbox" class="wi-m-creator" /> Creator's Notes</label>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- The persona page: SillyTavern's Persona Management, in its own order — the avatar tiles on
         the left with search, sort, pagination, the grid toggle and the upload tile, and the open
         persona on the right with its picture, description, position, connections, lorebook and the
         persona-wide settings. Drawn by resources/persona.js from the template below. -->
    <div id="pf-panel">
      <div id="pf-head">
        <small class="pf-label">Persona Management</small>
        <span class="grow"></span>
        <button class="link" id="pf-backup" type="button" title="Write every persona to one file SillyTavern can restore">Backup</button>
        <button class="link" id="pf-restore" type="button" title="Read personas back from a backup file">Restore</button>
      </div>
      <div id="pf-split">
        <div id="pf-left">
          <div id="pf-tools">
            <button class="secondary" id="pf-create" type="button" title="Create a persona">Create</button>
            <input id="pf-search" class="control" type="search" placeholder="Search…" autocomplete="off" />
            <select id="pf-sort" class="control" title="How the list is ordered">
              <option value="asc">A-Z</option>
              <option value="desc">Z-A</option>
              <option value="search" hidden>Search</option>
            </select>
            <button class="icon" id="pf-grid" type="button" title="Toggle grid view">▦</button>
            <span id="pf-pager"></span>
          </div>
          <div id="pf-tiles"></div>
        </div>
        <div id="pf-right">
          <p class="hint" id="pf-empty">Pick a persona on the left, or create one.</p>
          <div id="pf-editor" hidden>
            <div id="pf-title-row">
              <button id="pf-picture" type="button" title="Click to set another picture"></button>
              <div id="pf-titles">
                <input id="pf-name" type="text" spellcheck="false" placeholder="Name" title="What {{user}} expands to" />
                <input id="pf-title" type="text" spellcheck="false" placeholder="Title (optional)" title="How the picker shows it" />
              </div>
            </div>
            <div class="pf-buttons">
              <button class="secondary" id="pf-image" type="button" title="Copy a picture in beside this persona">Change picture…</button>
              <button class="secondary" id="pf-image-clear" type="button" title="Take the picture away">Clear</button>
              <button class="secondary" id="pf-duplicate" type="button" title="Copy this persona and its picture">Duplicate</button>
              <button class="secondary" id="pf-convert" type="button" title="Make a persona out of one of your characters">Convert a character…</button>
              <button class="secondary danger" id="pf-delete" type="button" title="Delete the persona and its picture">Delete</button>
            </div>
            <div class="pf-field">
              <label for="pf-description">Persona Description <span class="pf-tokens">Tokens: <span id="pf-tokens">0</span></span></label>
              <textarea id="pf-description" rows="8" spellcheck="false" placeholder="Example: [{{user}} is a 28-year-old Romanian cat girl.]"></textarea>
            </div>
            <div class="pf-grid3">
              <div class="pf-field">
                <label for="pf-position">Position</label>
                <select id="pf-position"></select>
              </div>
              <div class="pf-field">
                <label for="pf-depth">Depth</label>
                <input id="pf-depth" type="number" min="0" max="9999" step="1" title="Messages from the end, for “in chat”" />
              </div>
              <div class="pf-field">
                <label for="pf-role">Role</label>
                <select id="pf-role"></select>
              </div>
            </div>
            <div class="pf-field">
              <small class="pf-label">Connections</small>
              <div class="pf-locks">
                <button class="secondary" id="pf-lock-default" type="button" title="Use this persona for new chats; click again to stop">Default</button>
                <button class="secondary" id="pf-lock-character" type="button" title="Connect this persona to the character this chat is with">Character</button>
                <button class="secondary" id="pf-lock-chat" type="button" title="Use this persona for this chat only">Chat</button>
              </div>
              <div id="pf-connections"></div>
              <div id="pf-connect-row">
                <select id="pf-connect-character"></select>
                <button class="secondary" id="pf-connect" type="button">Connect</button>
              </div>
            </div>
            <div class="pf-field">
              <label for="pf-lorebook">Persona Lorebook</label>
              <select id="pf-lorebook"></select>
              <p class="hint">Scanned alongside this persona, wherever it is used.</p>
            </div>
            <div class="pf-globals">
              <small class="pf-label">Global Settings</small>
              <label class="check"><input type="checkbox" id="pf-auto-lock" /> Auto-lock a chosen persona to the chat</label>
              <label class="check"><input type="checkbox" id="pf-allow-multi" /> Allow multiple persona connections per character</label>
              <label class="check"><input type="checkbox" id="pf-notify" /> Show notifications on switching personas</label>
            </div>
          </div>
        </div>
      </div>
    </div>

    <p class="hint" id="st-status"></p>
    <div id="st-pane-settings">
      <div class="grid">
        <div class="field wide">
          <label for="tavern-enabled">ST prompt takeover</label>
          <label class="check"><input type="checkbox" id="tavern-enabled" data-key="tavernEnabled" /> Compose every turn with the ST prompt collection</label>
          <p class="hint">With this on, every turn is assembled here — with no preset selected, the built-in <strong>Default</strong> is used. With it off, the agent prompt is sent on its own.</p>
        </div>
        <div class="field">
          <label for="tavern-character">Default character</label>
          <select id="tavern-character" class="control" data-key="tavernCharacter"></select>
          <p class="hint">New chats speak as this card. <strong>Comonad: Pick Character</strong> (or <code>/char</code>) binds one to a single chat and inserts its opening line.</p>
        </div>
        <div class="field">
          <label for="tavern-persona">Default persona</label>
          <select id="tavern-persona" class="control" data-key="tavernPersona"></select>
          <p class="hint">Who the user is: the <code>{{user}}</code> name and description.</p>
        </div>
        <div class="field">
          <label for="tavern-preset">Default preset</label>
          <select id="tavern-preset" class="control" data-key="tavernPreset"></select>
          <p class="hint">Prompts, order and samplers for new chats. Empty uses the built-in <strong>Default</strong>; <em>Start from Default</em> in the Presets sub-tab makes an editable copy.</p>
        </div>
        <div class="field">
          <label for="tavern-user">User name</label>
          <input id="tavern-user" class="control" type="text" data-key="tavernUserName" spellcheck="false" />
          <p class="hint">What <code>{{user}}</code> expands to when no persona is selected.</p>
        </div>
        <div class="field">
          <label for="tavern-note-depth">Author's note depth</label>
          <input id="tavern-note-depth" class="control" type="number" min="0" data-key="tavernNoteDepth" />
        </div>
        <div class="field wide">
          <label for="tavern-note">Author's note</label>
          <textarea id="tavern-note" class="control" data-key="tavernAuthorNote" spellcheck="false" rows="3" placeholder="Standing instruction, injected {{depth}} messages from the end"></textarea>
          <p class="hint">Also settable per chat with <code>/note</code>.</p>
        </div>
        <div class="field wide">
          <label>World books</label>
          <p class="hint" id="books-known"></p>
          <p class="hint">The active books and every keyword-scan knob live with the books themselves, on the <strong>ST → World books</strong> sub-tab, the way SillyTavern keeps them.</p>
        </div>
        <div class="field wide">
          <label for="wi-format">Entry format</label>
          <input id="wi-format" class="control" type="text" data-key="tavernWiFormat" spellcheck="false" placeholder="{0}" />
          <p class="hint">Wrapper around activated entries: <code>{0}</code> is the entry text, e.g. <code>[Details: {0}]</code>.</p>
        </div>
        <div class="field">
          <label for="fmt-scenario">Scenario format</label>
          <input id="fmt-scenario" class="control" type="text" data-key="tavernScenarioFormat" spellcheck="false" />
        </div>
        <div class="field">
          <label for="fmt-personality">Personality format</label>
          <input id="fmt-personality" class="control" type="text" data-key="tavernPersonalityFormat" spellcheck="false" />
        </div>
        <div class="field wide">
          <label>Catalog</label>
          <p class="hint" id="catalog-summary"></p>
        </div>
      </div>
    </div>
  </div>
`;
