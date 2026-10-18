# data/audio

Everything the game can play that is not synthesised. All of it is optional: with this folder empty
the game runs with procedural ambience (sea, gulls, traffic, crowd, birds) and player motion
sounds from `src/engine/audio.js`, and no music or voices.

Only original material goes here. No commercial recordings, no samples or loops without a licence
that allows redistribution in the game (decision in `docs/ROUND3.md`).

| Path | What | Who writes it |
|---|---|---|
| `voice/` | One file per quest dialogue line, named `<questId>.<dialogue>.<NN>.ogg`, e.g. `q1_speaker.offer.01.ogg`. | Founder (recordings) |
| `voice/barks/` | Short passer-by lines, `<archetype>_<NN>.ogg`, e.g. `savta_03.ogg`. Any count per archetype. | Founder (recordings) |
| `music/` | Original music tracks plus `index.json`, the playlist. `[]` means no music. | Founder (tracks), anyone (index) |
| `manifest.json` | The list of files present in the three folders above. The game plays only listed files, because a browser cannot list a folder. Generated: never edit by hand. | `tools/make_voice_script.mjs` |
| `barks.he.json` | The Hebrew bark lines per archetype, the script for `voice/barks/`. | Audio |
| `voice_directions.json` | Recording direction per speaker and per bark archetype (English). | Audio |

## Adding recordings

1. Name the files exactly as in `docs/VOICE_SCRIPT.md` and drop them into `voice/`, `voice/barks/` or `music/`.
2. Run `node tools/make_voice_script.mjs`. It refreshes `manifest.json` and the script, reports how many lines are recorded and warns about files that match no line.
3. Reload the game.

Formats: `.ogg` (Vorbis) first, then `.mp3`, then `.wav`. The recording spec (mono WAV 48 kHz 24-bit masters, -1 dBTP peak, room tone per session) and the music spec (`index.json` fields, loop points, about -16 LUFS integrated) are in `docs/VOICE_SCRIPT.md`.

Keep the WAV masters outside the repo; only the exported game files belong here.

## Testing without the manifest

`?voiceprobe=1` in the game URL ignores `manifest.json` and asks the server for each file
directly. Missing files then show as 404s in the browser console, which is expected in that mode.
