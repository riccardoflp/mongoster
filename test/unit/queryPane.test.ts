import { describe, expect, it } from 'vitest';
import { QUERY_PANE_WIDTH, clampPaneWidth, readQueryPane } from '../../src/shared/queryPane';

describe('query.pane: the stored choice', () => {
  it('defaults to the query above the results', () => {
    expect(readQueryPane(undefined)).toEqual({ side: false, width: QUERY_PANE_WIDTH.default });
    expect(readQueryPane('side')).toEqual({ side: false, width: QUERY_PANE_WIDTH.default });
  });

  it('keeps a stored choice', () => {
    expect(readQueryPane({ side: true, width: 500 })).toEqual({ side: true, width: 500 });
  });

  it('takes only true as beside', () => {
    expect(readQueryPane({ side: 'yes', width: 500 }).side).toBe(false);
  });
});

describe('query.pane: the width', () => {
  it('keeps the width within the limits, rounded', () => {
    expect(clampPaneWidth(10)).toBe(QUERY_PANE_WIDTH.min);
    expect(clampPaneWidth(5000)).toBe(QUERY_PANE_WIDTH.max);
    expect(clampPaneWidth(400.6)).toBe(401);
  });

  it('gives the default for what is not a number', () => {
    expect(clampPaneWidth('400')).toBe(QUERY_PANE_WIDTH.default);
    expect(clampPaneWidth(Number.NaN)).toBe(QUERY_PANE_WIDTH.default);
  });
});
