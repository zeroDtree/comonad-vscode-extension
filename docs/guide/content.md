# Content layer

The agent can wear a character. The content layer is **not built in**: it ships as an optional plugin
package and does nothing until installed. It reads and writes SillyTavern's file formats, so cards,
books, personas and presets move between the two tools.

**Install:** **Settings → Plugins → Install… → SillyTavern content (ST)**. With the row loaded,
open the **ST** tab (`Comonad: Manage Content`).

Content lives in `.comonad/` in the project plus `~/.comonad/` for the user:

```text
.comonad/
  characters/    cards (PNG or JSON)
  lorebooks/     world books
  personas/      personas and their pictures
  presets/       chat-completion presets
  tags.json      tag registry
  prompt-library.json
```

## Characters

Cards are read as PNG (`chara` / `ccv3` chunks) or JSON, all three card versions, and written back in
the same shape. The editor covers description, personality, scenario, first message and alternates,
example messages, system prompt, post-history instructions, creator notes, tags, depth prompt and
`extensions.world`.

- **Choose picture…** writes the card as a PNG, because that is how upstream stores a card.
- The list has search, order (A-Z/Z-A, newest, oldest), favourites, grid view and paging.
- **More…** includes *Import Card Lore*, *Convert to Persona*, *Rename*, *Link to Source*,
  *Import cards…*, *Export JSON…* and *Export PNG…*.
- A card's opening line (or an alternate) is inserted as the first turn when it is bound to a chat.

## World books

The **World books** page follows SillyTavern's panel: active books for all chats, global activation
knobs, book create/import/export/rename/duplicate/delete, and an entry list with search, sorting,
paging and drag-to-reorder under *custom* sort.

Each entry unfolds into the full editor: keys and secondary keys, logic, optional filter, outlet name,
scan depth, case/whole-word overrides, recursion level, content with token count and uid, inclusion
group, priority, sticky/cooldown/delay, state (**🟢 Normal / 🔵 Constant / 🔗 Vectorized**),
automation ID, generation triggers, character/tag filter and additional matching sources.

Edits write back as you type; there is no Save button. Files keep SillyTavern's camelCase keys with
`extensions` mirrors.

### Activation

- Entries are scanned every turn using their keys, scan depth and filters.
- **Vectorized** entries are found by meaning through an OpenAI-compatible `/embeddings` endpoint;
  vectors are cached per book and model.
- An entry's **Automation ID** runs the `WorldInfoActivated` hook and a slash command of that name
  when the entry activates, once per turn, when `comonad.wiAutomation` is on.
- When the budget stops the scan, *Alert On Overflow* says so once per chat.

`lore_lookup` lets the model search the books on demand. It is read-only and never changes what the
next turn injects.

## Personas

The **Personas** page follows SillyTavern's *Persona Management*: avatar tiles on the left, the open
persona on the right. Name, title, picture, description with a live token count, position, depth and
role, the three locks (*Default*, *Character*, *Chat*), connections and the persona lorebook.

- Descriptions save as you type.
- Connections use upstream's `{type, id}` shape, so a Backup made in either tool restores in the
  other.
- **Duplicate** copies the persona and its picture; **Convert a character…** makes one from a card;
  deleting a persona takes its picture with it.

## Presets

A preset is the whole of SillyTavern's OpenAI settings. The **Presets** tab edits the prompt list,
the samplers, formats and nudges.

- **Prompt library:** one box with a picker; switch between **Built-in** (shared) and **Custom**
  (this preset). *Insert* puts the selected entry at the top of the list, after Comonad's leading
  blocks; *+ New* saves a new entry and opens its editor in place.
- Comonad's nine blocks — **Identity, Tools, Instructions, Memory, Todos, Skills, Sub-agents, Lore
  index, Context** — are rows in the same list. Their text is generated and read-only; their switch
  and position are ordinary preset state. The single **Tools** row controls whether the request
  offers tools at all.
- The prompt list itself supports switch, move, duplicate, delete and per-entry editing: name, role,
  generation triggers, relative/in-chat position, depth, order, text and *Forbid Overrides*.
- Samplers, formats, nudges, `seed`, `logit_bias`, `stream_openai`, `max_context_unlocked` and
  `use_sysprompt` are sent only when the preset sets them.
- **Import…** / **Export…** read and write SillyTavern presets. Five templates ship: *Default*,
  *Balanced*, *Creative*, *Precise* and *Long-form*.

## Tags

The tag registry lives in `.comonad/tags.json` (project over user), in SillyTavern's shape:
`{tags: [...], tag_map: {<character id>: [tag id]}}`. Tags are referred to by **id**, so renaming a
tag never breaks a filter. Manage tags from the Characters tab: create, rename, colour, folder type,
hide-on-card, delete or delete-merge, prune unused, and import card tags.

## Generation

The ▾ beside **Send** offers SillyTavern's six generation types: **Normal**, **Continue**,
**Impersonate**, **Swipe**, **Regenerate**, **Quiet**. They are also commands: `/continue`,
`/impersonate`, `/swipe`, `/regenerate`, `/quiet [text]`.

An entry limited to certain generation triggers only fires for those. Replies keep their versions:
`‹ n/m ›` walks them; a regenerate overwrites the first version and appends later ones.

## Macros and regex

These macros are substituted in every block:

```text
{{char}}  {{charIfNotGroup}}  {{user}}  {{persona}}  {{scenario}}
{{lastChatMessage}}  {{time}}  {{random}}  {{pick}}  {{roll}}  {{outlet::Name}}
```

Regex scripts from `comonad.tavern.regex` or a card run on the prompt and replies with SillyTavern's
placement and depth rules.

## Licensing

The content layer re-implements SillyTavern's file formats and prompt assembly. A few small utility
routines are adapted from SillyTavern (AGPL-3.0); see
[NOTICE](https://github.com/zeroDtree/comonad-vscode-extension/blob/main/NOTICE). SillyTavern itself is
not bundled, and its default content is never copied.

## Next

- [Presets and settings](/reference/settings) — `comonad.tavern*` keys
- [Chat](/guide/chat) — generation types and swipes
