import { parseVectorLiteral, toVectorLiteral } from './vector';

describe('toVectorLiteral', () => {
  it('formats numbers the way pgvector expects', () => {
    expect(toVectorLiteral([0.1, -0.2, 3])).toBe('[0.1,-0.2,3]');
  });

  it('rejects an empty vector, which pgvector cannot store', () => {
    expect(() => toVectorLiteral([])).toThrow(/empty/i);
  });

  it('rejects a non-finite value rather than emitting NaN into SQL', () => {
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow(/finite/i);
  });
});

describe('parseVectorLiteral', () => {
  it('reads back what toVectorLiteral wrote', () => {
    const values = [0.1, -0.2, 3];

    expect(parseVectorLiteral(toVectorLiteral(values))).toEqual(values);
  });

  it('rejects a malformed literal instead of returning garbage', () => {
    expect(() => parseVectorLiteral('0.1,0.2')).toThrow(/malformed/i);
  });

  it('keeps parsing when whitespace surrounds a real number', () => {
    expect(parseVectorLiteral('[0.1, -0.2]')).toEqual([0.1, -0.2]);
  });

  it('rejects a trailing empty segment instead of silently inserting a 0', () => {
    expect(() => parseVectorLiteral('[1,2,]')).toThrow(/malformed/i);
  });

  it('rejects a leading empty segment instead of silently inserting a 0', () => {
    expect(() => parseVectorLiteral('[,1]')).toThrow(/malformed/i);
  });

  it('rejects an empty segment in the middle instead of silently inserting a 0', () => {
    expect(() => parseVectorLiteral('[1,,2]')).toThrow(/malformed/i);
  });

  it('rejects a whitespace-only segment instead of silently inserting a 0', () => {
    expect(() => parseVectorLiteral('[1, ,2]')).toThrow(/malformed/i);
  });
});
