# kanjidamage-yomitan

Planned local middleware for a Yomitan kanji popup **Add** action:

`Add` -> enrichment -> AnkiConnect -> existing KanjiDamage note type

The middleware sits locally between Yomitan and AnkiConnect. It enriches a
kanji popup before the card is added to an existing KanjiDamage deck.

## Requirements

- Add only kanji that are not already present; leave existing notes untouched.
- Provide meanings and readings for the kanji.
- Include kun'yomi examples, allowing okurigana in the example.
- Include on'yomi compound examples.
- Populate the First and Full fields, including the Full header.
- Source and classification remain unresolved: the Jisho word API does not
  expose complete kanji reading metadata.
- Implementation has not started.

## Issues

Tracking and specifications live in
[GitHub Issues](https://github.com/mujak27/kanjidamage-yomitan/issues).
