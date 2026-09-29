// uni.js — the ウニ語 codec, plus pure sound-sequence/WAV logic. No DOM, no
// globals beyond `Uni`. Works as a classic script in the browser
// (window.Uni) and as a CommonJS module in Node (module.exports), exactly
// like v1's uninse.js did.
(function (root) {
  "use strict";

  // §3.1 — the digit table (owner, 2026-09-29, second change). One character
  // per hex digit, full and half width mixed. 3 = う and 0 = に, so every
  // kana (U+30xx) starts with うに.
  var DIGITS = ["に", "ニ", "ﾆ", "う", "ウ", "ｳ", "ｩ", "二",
                "ッ", "っ", "ｯ", "ィ", "ぃ", "ｨ", "ー", "ｰ"]; // 0-f
  var SEP = "ﾝ"; // between characters (half width)
  var END = "ン"; // once, at the very end
  var BOUNDARY_RE = /[んンﾝ]/; // decode accepts any of the three as a boundary

  // digit (0-15) -> 1-character ウニ語 token
  function digitToDigitToken(d) {
    return DIGITS[d];
  }

  // reverse lookup: one character -> 0-15, or -1 if not in the table
  function reverseLookup(ch) {
    return DIGITS.indexOf(ch);
  }

  var HEX_CHARS = "0123456789abcdef";

  // §3.2 — encode(text)
  function encode(text) {
    var chars = Array.from(text); // codePointAt-aware iteration
    if (chars.length === 0) return "";
    var tokens = [];
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var cp = ch.codePointAt(0);
      var hex = cp.toString(16); // lowercase, no leading zeros
      var tok = "";
      for (var j = 0; j < hex.length; j++) {
        var d = parseInt(hex[j], 16);
        tok += digitToDigitToken(d);
      }
      tokens.push(tok);
    }
    return tokens.join(SEP) + END;
  }

  // whitespace stripped in decode's step 1 (global strip, not a trim)
  var WHITESPACE_RE = /[ \t\n\r　]/g;

  function stripWhitespace(s) {
    return s.replace(WHITESPACE_RE, "");
  }

  // §3.3 — decode(text)
  function decode(text) {
    // Step 0 — the secret trick, before anything else.
    var trimmed = text.trim();
    if (trimmed === "くり") {
      return { text: "たる", invalid: [], secretTrick: true };
    }

    // Step 1 — normalize (global whitespace strip).
    var normalized = stripWhitespace(text);
    if (normalized === "") {
      return { text: "", invalid: [], secretTrick: false };
    }

    // Step 2 — split into character spans on ん/ン/ﾝ (all are boundaries).
    // Encode always ends the whole message with one terminating marker
    // (§3.2: "ん between characters, ン once, at the very end"), so a
    // naive split leaves one trailing empty element that represents
    // "nothing after the terminator" rather than a real empty span — drop
    // exactly that one trailing artifact. A doubled separator elsewhere in
    // the string still produces a genuine empty span (invalid), and a
    // missing final marker (EXP §6's leniency) already leaves no trailing
    // empty element to drop, so both cases are unaffected by this.
    var spans = normalized.split(BOUNDARY_RE);
    if (spans.length > 1 && spans[spans.length - 1] === "") {
      spans.pop();
    }

    // Step 3 — validate and resolve each span.
    var results = []; // per-span: { ok: bool, text: resolved-or-"〔?〕", raw }
    var invalid = [];
    for (var s = 0; s < spans.length; s++) {
      var span = spans[s];
      var ok = true;
      var resolved = "";

      if (span === "") {
        ok = false;
      } else {
        var hexDigits = "";
        for (var g = 0; g < span.length && ok; g++) {
          var digit = reverseLookup(span.charAt(g));
          if (digit === -1) {
            ok = false;
            break;
          }
          hexDigits += HEX_CHARS[digit];
        }
        if (ok) {
          if (hexDigits.length > 1 && hexDigits[0] === "0") {
            ok = false; // leading zero, never emitted by encode
          } else {
            var cp = parseInt(hexDigits, 16);
            if (cp > 0x10ffff) {
              ok = false;
            } else if (cp >= 0xd800 && cp <= 0xdfff) {
              ok = false; // lone surrogate, not a scalar value
            } else {
              resolved = String.fromCodePoint(cp);
            }
          }
        }
      }

      if (ok) {
        results.push({ ok: true, text: resolved });
      } else {
        results.push({ ok: false, text: "〔?〕", raw: span });
        invalid.push({ index: s + 1, raw: span }); // 1-based
      }
    }

    // Step 4 — assemble. `spanCount` lets the caller derive the partial-vs-
    // total distinction as `invalid.length === spanCount` (§9's own test
    // wording), rather than the codec inventing a separate flag for it.
    var restored = results.map(function (r) { return r.text; }).join("");
    return { text: restored, invalid: invalid, secretTrick: false, spanCount: spans.length };
  }

  // §3.4 — matching is exact: ウ and ｳ, ー and ｰ, ッ and ｯ are different
  // digits, and the ASCII hyphen is not ｰ. No width folding.

  // §3.5 — sound-sequence functions (pure). A "key" is one of the 18
  // strings "0".."9","a".."f","n","N" — the same keys voice.js's clip map
  // is indexed by.
  function soundKeysForEncode(text) {
    var chars = Array.from(text);
    if (chars.length === 0) return [];
    var keys = [];
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      var cp = ch.codePointAt(0);
      var hex = cp.toString(16);
      for (var j = 0; j < hex.length; j++) keys.push(hex[j]);
      keys.push(i === chars.length - 1 ? "N" : "n");
    }
    return keys;
  }

  function splitIntoSpansWithSeparators(normalized) {
    // Same split as decode()'s Step 2, but each span keeps its own trailing
    // separator character ("n" for ﾝ or ん, "N" for ン, or null if none follows
    // — either because the string simply ended, or because this is the
    // artifact trailing element after the final terminator, which carries
    // no body and is dropped exactly like decode() drops it).
    var out = [];
    var body = "";
    for (var i = 0; i < normalized.length; i++) {
      var ch = normalized[i];
      if (BOUNDARY_RE.test(ch)) {
        out.push({ body: body, sep: ch === END ? "N" : "n" });
        body = "";
      } else {
        body += ch;
      }
    }
    if (body !== "") out.push({ body: body, sep: null });
    return out;
  }

  function spanIsPlayable(span) {
    // §3.5: "playable" ignores the final code-point-range checks — a span
    // whose characters are all in the table is playable even if it later
    // turns out to encode a lone surrogate or an out-of-range code point,
    // since the sound only cares about which of the 16 digit clips to play.
    if (span === "") return null;
    var hexDigits = "";
    for (var g = 0; g < span.length; g++) {
      var digit = reverseLookup(span.charAt(g));
      if (digit === -1) return null;
      hexDigits += HEX_CHARS[digit];
    }
    return hexDigits;
  }

  function soundKeysForDecode(text) {
    var normalized = stripWhitespace(text);
    if (normalized === "") return [];
    var spans = splitIntoSpansWithSeparators(normalized);
    var keys = [];
    for (var i = 0; i < spans.length; i++) {
      var body = spans[i].body;
      var sep = spans[i].sep;
      var hexDigits = spanIsPlayable(body);
      if (hexDigits !== null) {
        for (var j = 0; j < hexDigits.length; j++) keys.push(hexDigits[j]);
        if (sep !== null) keys.push(sep);
      }
      // else: invalid span — push nothing (skipped in the sound exactly as
      // it is shown as 〔?〕 in the text)
    }
    return keys;
  }

  // buildWav(keyBuffers, opts) — pure, audio-shaped. keyBuffers is an
  // ordered array of Int16Array (one per key already resolved by the
  // caller). opts = { sampleRate, leadingSilenceMs, gapMs, capSeconds,
  // fadeSeconds }.
  function buildWav(keyBuffers, opts) {
    var sampleRate = opts.sampleRate;
    var leadingSilenceMs = opts.leadingSilenceMs || 0;
    var gapMs = opts.gapMs || 0;
    var capSeconds = opts.capSeconds;
    var fadeSeconds = opts.fadeSeconds || 0;

    var leadingSamples = Math.round((leadingSilenceMs / 1000) * sampleRate);
    var gapSamples = Math.round((gapMs / 1000) * sampleRate);

    var totalLen = leadingSamples;
    for (var i = 0; i < keyBuffers.length; i++) {
      totalLen += keyBuffers[i].length;
      if (i < keyBuffers.length - 1) totalLen += gapSamples;
    }

    var samples = new Int16Array(totalLen);
    var pos = leadingSamples; // leading silence is already zero-filled
    for (var k = 0; k < keyBuffers.length; k++) {
      var buf = keyBuffers[k];
      samples.set(buf, pos);
      pos += buf.length;
      if (k < keyBuffers.length - 1) pos += gapSamples; // gap stays zero
    }

    if (typeof capSeconds === "number") {
      var capLen = Math.round(capSeconds * sampleRate);
      if (samples.length > capLen) {
        samples = samples.slice(0, capLen);
        var fadeLen = Math.round(fadeSeconds * sampleRate);
        if (fadeLen > 0) {
          var fadeStart = Math.max(0, samples.length - fadeLen);
          var actualFadeLen = samples.length - fadeStart;
          for (var f = 0; f < actualFadeLen; f++) {
            var ramp = actualFadeLen <= 1 ? 0 : 1 - f / (actualFadeLen - 1);
            samples[fadeStart + f] = Math.round(samples[fadeStart + f] * ramp);
          }
        }
      }
    }

    return pcmToWavBytes(samples, sampleRate);
  }

  function pcmToWavBytes(samples, sampleRate) {
    var numChannels = 1;
    var bitsPerSample = 16;
    var byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    var blockAlign = numChannels * (bitsPerSample / 8);
    var dataSize = samples.length * (bitsPerSample / 8);
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);

    function writeString(offset, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true); // Subchunk1Size (PCM)
    view.setUint16(20, 1, true); // AudioFormat (PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    var offset = 44;
    for (var i = 0; i < samples.length; i++) {
      view.setInt16(offset, samples[i], true);
      offset += 2;
    }

    return new Uint8Array(buffer);
  }

  // --- Share link query (SPEC §6) ----------------------------------------
  // Base 32 (owner, 2026-09-29). Each digit is shifted by 7 (mod 32). The
  // last digit of each character comes from a second alphabet, so no
  // separator is needed between characters.
  var MID = "0123456789abcdefghijklmnopqrstuv"; // digits before the last
  var LAST = "wxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_"; // the last digit
  var SHIFT = 7;

  // §6.1 — packQuery(text)
  function packQuery(text) {
    var chars = Array.from(text); // code-point-aware, same iteration as encode()
    var out = "";
    for (var i = 0; i < chars.length; i++) {
      var b32 = chars[i].codePointAt(0).toString(32); // no leading zeros
      for (var j = 0; j < b32.length; j++) {
        var d = (parseInt(b32[j], 32) + SHIFT) % 32;
        out += j === b32.length - 1 ? LAST[d] : MID[d];
      }
    }
    return out;
  }

  var QUERY_SHAPE_RE = /^([0-9a-v]*[w-zA-Z_-])+$/;

  function codePointOrNull(cp) {
    if (cp > 0x10ffff) return null; // out of Unicode range
    if (cp >= 0xd800 && cp <= 0xdfff) return null; // lone surrogate
    return String.fromCodePoint(cp);
  }

  // §6.2 — unpackQuery(raw). raw = the query content, "?" already stripped,
  // and everything from the first "&" onward already cut off by the caller.
  function unpackQuery(raw) {
    if (typeof raw !== "string") return null;
    if (LEGACY_QUERY_SHAPE_RE.test(raw)) return unpackLegacyQuery(raw);
    if (!QUERY_SHAPE_RE.test(raw)) return null;
    var chars = [];
    var cp = 0;
    var digits = 0;
    for (var i = 0; i < raw.length; i++) {
      var c = raw[i];
      var last = LAST.indexOf(c) !== -1;
      var d = ((last ? LAST : MID).indexOf(c) - SHIFT + 32) % 32;
      if (digits === 0 && d === 0 && !last) return null; // leading zero
      cp = cp * 32 + d;
      digits++;
      if (digits > 5) return null; // longer than any code point
      if (last) {
        var ch = codePointOrNull(cp);
        if (ch === null) return null;
        chars.push(ch);
        cp = 0;
        digits = 0;
      }
    }
    return chars.join("");
  }

  // §6.2 — links made before 2026-09-29: hex digits as a-p shifted by 7,
  // characters joined by "z". A legacy query always ends in a-p and a new
  // one never does, so the two shapes cannot be confused.
  var LEGACY_LETTERS = "abcdefghijklmnop";
  var LEGACY_QUERY_SHAPE_RE = /^[a-p]+(z[a-p]+)*$/;

  function unpackLegacyQuery(raw) {
    var groups = raw.split("z");
    var chars = [];
    for (var i = 0; i < groups.length; i++) {
      var hex = "";
      for (var j = 0; j < groups[i].length; j++) {
        hex += HEX_CHARS[(LEGACY_LETTERS.indexOf(groups[i][j]) - 7 + 16) % 16];
      }
      var ch = codePointOrNull(parseInt(hex, 16));
      if (ch === null) return null;
      chars.push(ch);
    }
    return chars.join("");
  }

  var Uni = {
    encode: encode,
    decode: decode,
    digitToDigitToken: digitToDigitToken,
    reverseLookup: reverseLookup,
    DIGITS: DIGITS,

    soundKeysForEncode: soundKeysForEncode,
    soundKeysForDecode: soundKeysForDecode,
    buildWav: buildWav,

    packQuery: packQuery,
    unpackQuery: unpackQuery,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = Uni;
  }
  if (root) {
    root.Uni = Uni;
  }
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
