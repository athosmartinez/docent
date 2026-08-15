import {
  decodeVector,
  embeddingKey,
  encodeVector,
  normaliseQuestion,
} from './cache.keys';

describe('normaliseQuestion', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normaliseQuestion('  how do I use it?  ')).toBe('how do I use it?');
  });

  it('collapses internal runs of whitespace to a single space', () => {
    expect(normaliseQuestion('how   do\tI\nuse  it?')).toBe('how do I use it?');
  });

  it('preserves case', () => {
    expect(normaliseQuestion('How Do I Use ValidationPipe?')).toBe(
      'How Do I Use ValidationPipe?',
    );
  });
});

describe('embeddingKey', () => {
  it('is deterministic for identical inputs', () => {
    expect(embeddingKey('text-embedding-3-large', 3072, 'a question')).toBe(
      embeddingKey('text-embedding-3-large', 3072, 'a question'),
    );
  });

  it('differs when the model differs', () => {
    const a = embeddingKey('text-embedding-3-large', 3072, 'a question');
    const b = embeddingKey('text-embedding-3-small', 3072, 'a question');

    expect(a).not.toBe(b);
  });

  it('differs when the dimensionality differs', () => {
    const a = embeddingKey('text-embedding-3-large', 3072, 'a question');
    const b = embeddingKey('text-embedding-3-large', 1536, 'a question');

    expect(a).not.toBe(b);
  });

  it('differs when the question differs', () => {
    const a = embeddingKey('text-embedding-3-large', 3072, 'a question');
    const b = embeddingKey('text-embedding-3-large', 3072, 'another question');

    expect(a).not.toBe(b);
  });

  it('is the same for a question with surrounding or collapsed whitespace', () => {
    const a = embeddingKey('text-embedding-3-large', 3072, 'a  question');
    const b = embeddingKey('text-embedding-3-large', 3072, '  a question  ');

    expect(a).toBe(b);
  });

  it('preserves case: two questions differing only in case get different keys', () => {
    const a = embeddingKey(
      'text-embedding-3-large',
      3072,
      'how do I use ValidationPipe?',
    );
    const b = embeddingKey(
      'text-embedding-3-large',
      3072,
      'how do i use validationpipe?',
    );

    expect(a).not.toBe(b);
  });

  it('is namespaced under an emb: prefix', () => {
    expect(embeddingKey('model', 3072, 'question')).toMatch(
      /^emb:[0-9a-f]{64}$/,
    );
  });
});

describe('encodeVector / decodeVector', () => {
  it('round-trips a vector through its compact encoding, at float32 precision', () => {
    const vector = Array.from({ length: 3072 }, (_v, i) => i / 10000);

    expect(decodeVector(encodeVector(vector))).toEqual(
      // pgvector stores a `vector` as 4-byte floats, so float32 is exactly
      // what the database would have kept — encoding to it loses nothing the
      // corpus itself preserves.
      Array.from(Float32Array.from(vector)),
    );
  });

  it('encodes shorter than the equivalent JSON array', () => {
    // An evenly-stepped fixture (i / 10000) prints as short, clean decimals
    // and understates JSON's cost — real embeddings are full-precision
    // doubles, so this uses irrational values to produce the same long
    // decimal expansions JSON.stringify actually produces on real vectors.
    const vector = Array.from({ length: 3072 }, (_v, i) => Math.sin(i) / 3);

    expect(encodeVector(vector).length).toBeLessThan(
      JSON.stringify(vector).length / 2,
    );
  });

  // Pinned against an independently-computed expected value rather than
  // only checking that decode(encode(x)) === x: a codec that reordered the
  // vector the same way on both sides would still round-trip cleanly while
  // returning the wrong value to anyone who read the encoded string
  // directly (or persisted it and decoded it with a correct decoder later).
  it('encodes as the base64 of the float32 bytes, in order', () => {
    const vector = [0, 1, -1, 0.5, 123.456];
    const expected = Buffer.from(Float32Array.from(vector).buffer).toString(
      'base64',
    );

    expect(encodeVector(vector)).toBe(expected);
  });

  it('decodes the base64 of float32 bytes back to the same values, in order', () => {
    const vector = [0, 1, -1, 0.5, 123.456];
    const encoded = Buffer.from(Float32Array.from(vector).buffer).toString(
      'base64',
    );

    expect(decodeVector(encoded)).toEqual(
      Array.from(Float32Array.from(vector)),
    );
  });
});
