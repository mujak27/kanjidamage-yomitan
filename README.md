# KanjiDamage Yomitan middleware

A small local Node.js proxy that enriches Yomitan's new KanjiDamage `addNote` requests with live KanjiAPI.dev dictionary data, then sends them to AnkiConnect. It binds only to loopback and never stores dictionary responses or request data.

## Status: Working MVP

- The end-to-end macOS Yomitan → middleware → AnkiConnect workflow is confirmed working: new KanjiDamage notes are created with dictionary enrichment, while duplicates are rejected and existing notes are left unchanged.
- Non-KanjiDamage vocabulary requests pass through unchanged to the configured vocabulary deck (for example, Core2k6k).
- Start the middleware manually in Terminal. Mnemonics are not yet provided; see [Behavior and limits](#behavior-and-limits).

## Requirements and setup (macOS)

1. Install Node.js 26 or newer and Anki with AnkiConnect installed and running (default `http://127.0.0.1:8765`). Keep AnkiConnect's origin checks enabled and allow Yomitan's exact browser-extension origin in its settings. In Chrome, find the extension ID on the extensions page; in Firefox, open `about:debugging#/runtime/this-firefox`, find Yomitan, and use its **Internal UUID** as `moz-extension://<UUID>`. The middleware checks that origin and forwards it to AnkiConnect; it does not alter AnkiConnect's CORS configuration.
2. In Terminal, from this folder:
   ```sh
   ALLOWED_ORIGINS='chrome-extension://YOUR_YOMITAN_EXTENSION_ID' node server.js
   ```
   For Firefox, replace the Chrome example with `ALLOWED_ORIGINS='moz-extension://<UUID>' node server.js` (using the Internal UUID above). Add a comma-separated second origin if needed. Restart the middleware whenever you change `ALLOWED_ORIGINS`; it reads the setting only at startup. `ALLOWED_ORIGINS` is required for browser-originated requests. Requests with no Origin header (for local command-line use) are accepted; requests from other web origins are rejected. Defaults: proxy `127.0.0.1:8766`, AnkiConnect `127.0.0.1:8765`, deck and model `KanjiDamage`. Optional `PORT`, `ANKI_URL`, `ANKI_DECK`, and `ANKI_MODEL` environment variables override these.
3. In Yomitan's Anki settings, use the proxy URL `http://127.0.0.1:8766` and select model/deck `KanjiDamage` for **kanji cards** (or set `ANKI_DECK` to your chosen KanjiDamage deck). Map `Kanji` to `{character}` and leave `Number` blank. Confirm the preview has one kanji in `Kanji`. Configure **term cards** separately to use the vocabulary note type and deck you want, such as `Core 2k/6k Optimized Japanese Vocabulary`; these requests pass through unchanged, including words with okurigana (for example `践む`) and jukugo. Keep AnkiConnect available only on loopback.

## Behavior and limits

The proxy accepts Yomitan's API version 2 requests and returns legacy raw success values (errors remain `{error, result}`); upstream requests always use AnkiConnect API version 6. A single new note for the configured KanjiDamage model is enriched and checked for duplicates before creation. The model schema and field order are read directly from Anki; existing notes are never edited or deleted, and duplicates in that model are rejected regardless of deck. Requests for other note models, including vocabulary term cards, are forwarded to AnkiConnect without changing note fields, options, tags, deck/model, or custom parameters. `canAddNotes` and `canAddNotesWithErrorDetail` follow the same model-specific routing. Read-only `multi` requests are handled one child at a time with a 50-action limit; nested multi and any write action inside multi are rejected. Other supported AnkiConnect compatibility actions are forwarded; unsupported actions are denied. Incoming API keys are passed only to AnkiConnect. A failed dictionary lookup, missing required example, schema mismatch, or duplicate check means no KanjiDamage note is created. A timeout after Anki has accepted a create may be ambiguous: the middleware does not retry; check Anki before trying again.

Meanings/readings/examples are retrieved afresh from KanjiAPI.dev for each add. Kun examples require a leading target kanji and evidence from the dictionary reading: dotted readings (such as `た.べる`) must match the stem plus the exact kana okurigana, while undotted readings must match the full pronunciation with any written kana tail. Hyphen-marked readings are treated conservatively as written/pronounced suffixes or prefixes. On examples require a leading target kanji, at least one more Han character, and a pronunciation beginning with a listed on reading. This intentionally misses irregular readings, rendaku and less direct cases rather than guessing. If a kanji has an active reading class but no matching example can be verified, the add fails. A class with no readings may be blank. The First and Full example fields are populated when verified. Mnemonic and Full mnemonic are always blank; usefulness, frequency, and other unavailable content are not invented. HTML dictionary strings are escaped before being placed in fields.

KanjiAPI.dev publishes data sourced from KANJIDIC and JMdict; see [KanjiAPI.dev](https://kanjiapi.dev/) and its [license/attribution](https://github.com/stephenmk/kanjiapi.dev). API keys and browser Origin headers are never sent to dictionary hosts; credentials are not logged. Use this as a local personal workflow; test with a kanji you are comfortable adding. No real Anki notes are changed by the automated tests.

Run tests with `npm test` (no dependencies to install).

## Troubleshooting

An HTTP 403 from the proxy usually means the request's `Origin` does not exactly match an entry in `ALLOWED_ORIGINS`. Check the browser's extension origin (including the Firefox `moz-extension://` UUID), update the startup value, and restart the middleware.

If Yomitan reports that the KanjiDamage note has an invalid Kanji field, check the **kanji-card** field mappings (not the term-card mappings): map `Kanji` to `{character}` only, so the generated value is one Han ideograph. Do not configure vocabulary term cards to use the KanjiDamage model; their requests are intended for their own vocabulary note type and deck. After changing middleware code, restart the already-running middleware process for the change to take effect.
