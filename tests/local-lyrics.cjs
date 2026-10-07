const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const { parseVorbis, parseID3, readEmbedded } = require('../src/local-lyrics.js');

const lrc = '[00:01.250]本地歌词第一行\n[00:02.500]本地歌词第二行';
const little = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const comment = Buffer.from('LYRICS=' + lrc);
const vorbis = Buffer.concat([little(0), little(1), little(comment.length), comment]);
function frame(id, body, version = 3) {
  const header = Buffer.alloc(10);
  header.write(id);
  if (version === 4) {
    let size = body.length;
    for (let i = 7; i >= 4; i--) { header[i] = size & 127; size >>>= 7; }
  } else header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

test('FLAC Vorbis comments preserve timed UTF-8 lyrics', () => {
  assert.equal(parseVorbis(vorbis), lrc);
});
test('truncated FLAC comments do not read beyond the metadata block', () => {
  assert.equal(parseVorbis(vorbis.subarray(0, 15)), '');
});
test('MP3 ID3v2.3 USLT supports UTF-8 lyrics', () => {
  assert.equal(parseID3(frame('USLT', Buffer.concat([Buffer.from([3, 101, 110, 103, 0]), Buffer.from(lrc)])), 3), lrc);
});
test('MP3 ID3v2.4 USLT supports UTF-16 lyrics', () => {
  const body = Buffer.concat([Buffer.from([1, 122, 104, 111, 255, 254, 0, 0, 255, 254]), Buffer.from(lrc, 'utf16le')]);
  assert.equal(parseID3(frame('USLT', body, 4), 4), lrc);
});
test('MP3 TXXX supports the LYRICS field', () => {
  assert.equal(parseID3(frame('TXXX', Buffer.concat([Buffer.from([3]), Buffer.from('LYRICS\0' + lrc)])), 3), lrc);
});
test('incomplete ID3 frames return no lyrics', () => {
  assert.equal(parseID3(Buffer.from('incomplete'), 3), '');
});
test('FLAC reader skips artwork and audio while locating lyrics', async () => {
  function block(type, body, last = false) {
    const header = Buffer.alloc(4);
    header[0] = type | (last ? 128 : 0);
    header.writeUIntBE(body.length, 1, 3);
    return Buffer.concat([header, body]);
  }
  const fixture = Buffer.concat([Buffer.from('fLaC'), block(6, Buffer.alloc(100000)), block(4, vorbis, true)]);
  let bytesRead = 0;
  assert.equal(await readEmbedded(async (at, size) => { bytesRead += size; return fixture.subarray(at, at + size); }), lrc);
  assert.ok(bytesRead < 1000);
});

function runtime(initialPlaying, readFile = async () => new Blob([lrc])) {
  let state = { playing: initialPlaying };
  const callbacks = [], updates = [];
  const store = { getState: () => state, subscribe: cb => callbacks.push(cb) };
  const window = { onProcessLyrics: (value, id) => updates.push({ value, id }) };
  const document = { getElementById: () => ({ _reactRootContainer: { _internalRoot: { current: { memoizedProps: { store } } } } }) };
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/local-lyrics.js'), 'utf8'), {
    window, document, TextDecoder, Uint8Array, DataView, Blob, console, setInterval, clearInterval,
    betterncm: { fs: { exists: async () => true, readFile } }
  });
  return { window, updates, setPlaying: playing => { state = { playing }; callbacks.forEach(cb => cb()); } };
}
const localPlaying = (filename = 'fixture.flac') => ({ trackFileType: 'local', resourceTrackId: filename, onlineResourceId: '', curPlaying: { localTrack: { filename, encryptFile: false } } });

test('online playback retains the existing lyric fetcher and options', async () => {
  const { window } = runtime({ trackFileType: 'online' });
  const options = { signal: new AbortController().signal };
  const raw = { lrc: { lyric: 'online fixture' } };
  const result = await window.rnpLocalLyricsBridge.fetchLyrics('123', options, (id, receivedOptions) => {
    assert.equal(id, '123'); assert.equal(receivedOptions, options); return raw;
  });
  assert.equal(result, raw);
});
test('local playback reads a sidecar without sending a local ID to the online API', async () => {
  const { window } = runtime(localPlaying());
  const result = await window.rnpLocalLyricsBridge.fetchLyrics('local-hash', {}, () => { throw Error('Unexpected online fetch'); });
  assert.equal(result.lrc.lyric, lrc);
  assert.equal(result.source.name, 'Local');
});
test('late local reads do not overwrite lyrics after switching tracks', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const instance = runtime(localPlaying(), () => pending);
  const result = instance.window.rnpLocalLyricsBridge.fetchLyrics('fixture.flac', {}, () => { throw Error('Unexpected online fetch'); });
  instance.setPlaying({ trackFileType: 'online', resourceTrackId: '123' });
  finish(new Blob([lrc]));
  assert.equal(await result, null);
  await Promise.resolve();
  assert.ok(!instance.updates.some(update => update.value.lrc.lyric === lrc));
});
test('aborted local fetches do not emit a response', async () => {
  const { window } = runtime(localPlaying());
  const controller = new AbortController(); controller.abort();
  assert.equal(await window.rnpLocalLyricsBridge.fetchLyrics('fixture.flac', { signal: controller.signal }, () => null), null);
});
