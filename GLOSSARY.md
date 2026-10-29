# KanjiDamage Yomitan Middleware

This context names the dictionary-enrichment boundary between Yomitan and the existing KanjiDamage Anki note type.

## Language

**Target note**: A new note submitted for the configured KanjiDamage model and deck.
_Avoid_: Card (Anki creates cards from notes; duplicate detection is note-based)

**Vocabulary note**: A term-card note submitted for a non-KanjiDamage model and deck. It passes through the middleware unchanged; Yomitan's term-card settings select its note type and deck.

**Kun example**: A word whose written form starts with the target kanji and whose okurigana and pronunciation match a listed kun reading.
_Avoid_: Kun compound

**On example**: A word whose written form starts with the target kanji and whose pronunciation begins with a listed on reading.
_Avoid_: Jukugo (unless specifically referring to the KanjiDamage field label)
